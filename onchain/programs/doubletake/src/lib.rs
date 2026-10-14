use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked};
use raydium_clmm::states::{AmmConfig, ObservationState, PoolState, TickArrayState, TickArrayBitmapExtension};
use sha2::{Digest, Sha256};

// Development identity ONLY. Mainnet rollout requires an independently verified
// deployment and replacing this address in the reviewed/reproducible build.
declare_id!("Fg6PaFpoGXkYsidMpWxqSWYQMRqmBhJWv4eCxT9CLn1q");
pub const USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
pub const DEPOSIT_CAP: u64 = 100_000_000;
pub const CYCLE_CAP: u64 = 25_000_000;
pub const MIN_PROFIT: u64 = 50_000;
pub const MAX_PERMISSION: i64 = 86_400;
pub const COOLDOWN: i64 = 60;
pub const DAILY_CYCLES: u16 = 10;
pub const ACTIVATION_WINDOW: i64 = 900;
pub const MAX_DEADLINE_SLOTS: u64 = 40;
pub const UPGRADEABLE_LOADER: Pubkey = pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");

#[program]
pub mod doubletake {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, keeper: Pubkey) -> Result<()> {
        // Bootstrap is exclusively the deployed program's upgrade authority.
        // A front-runner cannot create the config with their own administrator.
        let program_data = ctx.accounts.program_data.try_borrow_data()?;
        require!(program_data.len() >= 45, GuardError::InvalidProgramData);
        require!(program_data[..4] == 3u32.to_le_bytes(), GuardError::InvalidProgramData);
        require!(program_data[12] == 1, GuardError::InvalidProgramData);
        require!(program_data[13..45] == ctx.accounts.admin.key().to_bytes(), GuardError::Unauthorized);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.keeper = keeper;
        config.paused = true; // launch gate starts closed
        config.invite_count = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_config(ctx: Context<AdminConfig>, keeper: Pubkey, paused: bool) -> Result<()> {
        require!(keeper != Pubkey::default(), GuardError::Unauthorized);
        ctx.accounts.config.keeper = keeper;
        ctx.accounts.config.paused = paused;
        emit!(ServiceConfigured { keeper, paused });
        Ok(())
    }

    pub fn create_invite(ctx: Context<CreateInvite>, owner: Pubkey) -> Result<()> {
        require!(ctx.accounts.config.invite_count < 5, GuardError::InviteCap);
        ctx.accounts.config.invite_count = ctx.accounts.config.invite_count.checked_add(1).ok_or(GuardError::Arithmetic)?;
        ctx.accounts.invite.owner = owner;
        ctx.accounts.invite.enabled = true;
        ctx.accounts.invite.bump = ctx.bumps.invite;
        ctx.accounts.invite.nonce_seed = 0;
        Ok(())
    }

    pub fn set_invite(ctx: Context<SetInvite>, enabled: bool) -> Result<()> {
        if enabled != ctx.accounts.invite.enabled {
            let config = &mut ctx.accounts.config;
            if enabled {
                require!(config.invite_count < 5, GuardError::InviteCap);
                config.invite_count = config.invite_count.checked_add(1).ok_or(GuardError::Arithmetic)?;
            } else {
                config.invite_count = config.invite_count.checked_sub(1).ok_or(GuardError::Arithmetic)?;
            }
            ctx.accounts.invite.enabled = enabled;
        }
        Ok(())
    }

    pub fn register_asset(ctx: Context<RegisterAsset>) -> Result<()> {
        let mint = ctx.accounts.asset_mint.key();
        approved_pair(mint, ctx.accounts.pool_a.key(), ctx.accounts.pool_b.key())?;
        validate_pool(&ctx.accounts.pool_a, USDC, mint)?;
        validate_pool(&ctx.accounts.pool_b, USDC, mint)?;
        let fingerprint = mint_fingerprint(&ctx.accounts.asset_mint.to_account_info(), Clock::get()?.unix_timestamp)?;
        let asset = &mut ctx.accounts.asset_config;
        asset.mint = mint;
        asset.pool_a = ctx.accounts.pool_a.key();
        asset.pool_b = ctx.accounts.pool_b.key();
        asset.token_program = *ctx.accounts.asset_mint.to_account_info().owner;
        asset.fingerprint = fingerprint;
        asset.decimals = ctx.accounts.asset_mint.decimals;
        asset.enabled = true;
        asset.revision = 1;
        asset.bump = ctx.bumps.asset_config;
        Ok(())
    }

    pub fn refresh_asset(ctx: Context<RefreshAsset>, enabled: bool) -> Result<()> {
        let asset = &mut ctx.accounts.asset_config;
        require_keys_eq!(asset.mint, ctx.accounts.asset_mint.key(), GuardError::InvalidMint);
        asset.fingerprint = mint_fingerprint(&ctx.accounts.asset_mint.to_account_info(), Clock::get()?.unix_timestamp)?;
        asset.revision = asset.revision.checked_add(1).ok_or(GuardError::Arithmetic)?;
        asset.enabled = enabled;
        // Every owner must sign configure_vault again after a security revision.
        Ok(())
    }

    pub fn initialize_vault(ctx: Context<InitializeVault>, cycle_usdc: u64, min_profit_usdc: u64) -> Result<()> {
        validate_policy(cycle_usdc, min_profit_usdc)?;
        require!(!ctx.accounts.config.paused, GuardError::ServicePaused);
        require!(ctx.accounts.invite.enabled, GuardError::NotInvited);
        require!(ctx.accounts.asset_config.enabled, GuardError::AssetDisabled);
        check_registered_mint(&ctx.accounts.asset_config, &ctx.accounts.asset_mint, Clock::get()?.unix_timestamp)?;
        assert_token_invariants(&ctx.accounts.vault_usdc, ctx.accounts.vault.key(), USDC)?;
        assert_token_invariants(&ctx.accounts.vault_asset, ctx.accounts.vault.key(), ctx.accounts.asset_mint.key())?;
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.keeper = ctx.accounts.config.keeper;
        vault.asset_mint = ctx.accounts.asset_mint.key();
        vault.pool_a = ctx.accounts.asset_config.pool_a;
        vault.pool_b = ctx.accounts.asset_config.pool_b;
        vault.asset_revision = ctx.accounts.asset_config.revision;
        vault.cycle_usdc = cycle_usdc;
        vault.min_profit_usdc = min_profit_usdc;
        vault.paused = true;
        vault.buy_pool_first = true;
        vault.bump = ctx.bumps.vault;
        vault.created_at = Clock::get()?.unix_timestamp;
        vault.nonce = ctx.accounts.invite.nonce_seed;
        emit!(VaultInitialized { owner: vault.owner, vault: vault.key(), asset_mint: vault.asset_mint });
        Ok(())
    }

    pub fn configure_vault(ctx: Context<ConfigureVault>, keeper: Pubkey, cycle_usdc: u64, min_profit_usdc: u64, expires_at: i64, enabled: bool, buy_pool_first: bool) -> Result<()> {
        validate_policy(cycle_usdc, min_profit_usdc)?;
        let now = Clock::get()?.unix_timestamp;
        if enabled {
            require!(!ctx.accounts.config.paused, GuardError::ServicePaused);
            require!(ctx.accounts.invite.enabled, GuardError::NotInvited);
            require!(ctx.accounts.asset_config.enabled, GuardError::AssetDisabled);
            require!(keeper != Pubkey::default(), GuardError::Unauthorized);
            require!(expires_at > now && expires_at <= now.checked_add(MAX_PERMISSION).ok_or(GuardError::Arithmetic)?, GuardError::PermissionExpiry);
        }
        check_registered_mint(&ctx.accounts.asset_config, &ctx.accounts.asset_mint, now)?;
        let vault = &mut ctx.accounts.vault;
        require!(vault.asset_mint == ctx.accounts.asset_mint.key(), GuardError::PauseBeforeAssetChange);
        vault.keeper = keeper;
        vault.asset_mint = ctx.accounts.asset_mint.key();
        vault.pool_a = ctx.accounts.asset_config.pool_a;
        vault.pool_b = ctx.accounts.asset_config.pool_b;
        vault.asset_revision = ctx.accounts.asset_config.revision;
        vault.cycle_usdc = cycle_usdc;
        vault.min_profit_usdc = min_profit_usdc;
        vault.expires_at = if enabled { expires_at } else { 0 };
        vault.paused = !enabled;
        vault.buy_pool_first = buy_pool_first;
        vault.nonce = vault.nonce.checked_add(1).ok_or(GuardError::Arithmetic)?;
        emit!(StrategyConfigured { owner: vault.owner, vault: vault.key(), nonce: vault.nonce, expires_at: vault.expires_at, paused: vault.paused });
        Ok(())
    }

    pub fn pause_vault(ctx: Context<OwnerVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.paused = true;
        vault.expires_at = 0;
        vault.keeper = Pubkey::default();
        vault.nonce = vault.nonce.checked_add(1).ok_or(GuardError::Arithmetic)?;
        emit!(VaultPaused { owner: vault.owner, vault: vault.key(), nonce: vault.nonce });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(!ctx.accounts.config.paused, GuardError::ServicePaused);
        require!(ctx.accounts.invite.enabled, GuardError::NotInvited);
        require!(amount > 0, GuardError::InvalidAmount);
        let next = ctx.accounts.vault.principal_usdc.checked_add(amount).ok_or(GuardError::Arithmetic)?;
        require!(next <= DEPOSIT_CAP, GuardError::DepositCap);
        assert_token_invariants(&ctx.accounts.vault_usdc, ctx.accounts.vault.key(), USDC)?;
        let before = ctx.accounts.vault_usdc.amount;
        token_interface::transfer_checked(CpiContext::new(ctx.accounts.token_program.key(), TransferChecked {
            from: ctx.accounts.owner_usdc.to_account_info(), mint: ctx.accounts.usdc_mint.to_account_info(),
            to: ctx.accounts.vault_usdc.to_account_info(), authority: ctx.accounts.owner.to_account_info(),
        }), amount, 6)?;
        ctx.accounts.vault_usdc.reload()?;
        require!(ctx.accounts.vault_usdc.amount == before.checked_add(amount).ok_or(GuardError::Arithmetic)?, GuardError::UnexpectedBalance);
        assert_token_invariants(&ctx.accounts.vault_usdc, ctx.accounts.vault.key(), USDC)?;
        ctx.accounts.vault.principal_usdc = next;
        ctx.accounts.vault.nonce = ctx.accounts.vault.nonce.checked_add(1).ok_or(GuardError::Arithmetic)?;
        emit!(FundsMoved { owner: ctx.accounts.owner.key(), vault: ctx.accounts.vault.key(), mint: USDC, amount, deposit: true });
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0 && amount <= ctx.accounts.vault_usdc.amount, GuardError::InvalidAmount);
        let before = ctx.accounts.vault_usdc.amount;
        assert_token_invariants(&ctx.accounts.vault_usdc, ctx.accounts.vault.key(), USDC)?;
        let owner = ctx.accounts.vault.owner;
        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[b"vault", owner.as_ref(), &bump];
        token_interface::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(), TransferChecked {
            from: ctx.accounts.vault_usdc.to_account_info(), mint: ctx.accounts.usdc_mint.to_account_info(),
            to: ctx.accounts.owner_usdc.to_account_info(), authority: ctx.accounts.vault.to_account_info(),
        }, &[seeds]), amount, 6)?;
        ctx.accounts.vault_usdc.reload()?;
        require!(ctx.accounts.vault_usdc.amount == before.checked_sub(amount).ok_or(GuardError::Arithmetic)?, GuardError::UnexpectedBalance);
        assert_token_invariants(&ctx.accounts.vault_usdc, ctx.accounts.vault.key(), USDC)?;
        // Unsolicited gifts are owner-recoverable but do not authorize new cycle
        // capital. Withdraw gifts first, then tracked profit, then principal.
        let (principal, profit) = withdrawal_ledger(before, amount, ctx.accounts.vault.principal_usdc, ctx.accounts.vault.accounted_profit_usdc)?;
        ctx.accounts.vault.principal_usdc = principal;
        ctx.accounts.vault.accounted_profit_usdc = profit;
        ctx.accounts.vault.paused = true;
        ctx.accounts.vault.expires_at = 0;
        ctx.accounts.vault.keeper = Pubkey::default();
        ctx.accounts.vault.nonce = ctx.accounts.vault.nonce.checked_add(1).ok_or(GuardError::Arithmetic)?;
        emit!(FundsMoved { owner, vault: ctx.accounts.vault.key(), mint: USDC, amount, deposit: false });
        Ok(())
    }

    pub fn recover_asset(ctx: Context<RecoverAsset>, amount: u64) -> Result<()> {
        // No service/invite/asset approval gate: owner can recover non-USDC dust
        // after the worker is stopped or an issuer configuration changes.
        require_keys_neq!(ctx.accounts.asset_mint.key(), USDC, GuardError::InvalidMint);
        require!(amount > 0 && amount <= ctx.accounts.vault_asset.amount, GuardError::InvalidAmount);
        assert_token_invariants(&ctx.accounts.vault_asset, ctx.accounts.vault.key(), ctx.accounts.asset_mint.key())?;
        let owner = ctx.accounts.vault.owner;
        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[b"vault", owner.as_ref(), &bump];
        token_interface::transfer_checked(CpiContext::new_with_signer(ctx.accounts.asset_token_program.key(), TransferChecked {
            from: ctx.accounts.vault_asset.to_account_info(), mint: ctx.accounts.asset_mint.to_account_info(),
            to: ctx.accounts.owner_asset.to_account_info(), authority: ctx.accounts.vault.to_account_info(),
        }, &[seeds]), amount, ctx.accounts.asset_mint.decimals)?;
        ctx.accounts.vault.paused = true;
        ctx.accounts.vault.expires_at = 0;
        ctx.accounts.vault.keeper = Pubkey::default();
        ctx.accounts.vault.nonce = ctx.accounts.vault.nonce.checked_add(1).ok_or(GuardError::Arithmetic)?;
        emit!(FundsMoved { owner, vault: ctx.accounts.vault.key(), mint: ctx.accounts.asset_mint.key(), amount, deposit: false });
        Ok(())
    }

    pub fn close_vault(ctx: Context<CloseVault>) -> Result<()> {
        require!(ctx.accounts.vault_usdc.amount == 0 && ctx.accounts.vault_asset.amount == 0, GuardError::ResidualInventory);
        validate_close(&ctx.accounts.vault, Clock::get()?.unix_timestamp)?;
        // Admission stays durable when a vault is closed. A new vault at the same
        // PDA cannot reuse an old execution nonce, even across midnight.
        ctx.accounts.invite.nonce_seed = ctx.accounts.vault.nonce.checked_add(1).ok_or(GuardError::Arithmetic)?;
        assert_token_invariants(&ctx.accounts.vault_usdc, ctx.accounts.vault.key(), USDC)?;
        assert_token_invariants(&ctx.accounts.vault_asset, ctx.accounts.vault.key(), ctx.accounts.asset_mint.key())?;
        let owner = ctx.accounts.vault.owner;
        let bump = [ctx.accounts.vault.bump];
        let seeds: &[&[u8]] = &[b"vault", owner.as_ref(), &bump];
        for (token, program) in [(&ctx.accounts.vault_usdc, ctx.accounts.token_program.key()), (&ctx.accounts.vault_asset, ctx.accounts.asset_token_program.key())] {
            token_interface::close_account(CpiContext::new_with_signer(program, CloseAccount {
                account: token.to_account_info(), destination: ctx.accounts.owner.to_account_info(), authority: ctx.accounts.vault.to_account_info(),
            }, &[seeds]))?;
        }
        Ok(())
    }

    pub fn execute_cycle<'info>(ctx: Context<'info, ExecuteCycle<'info>>, nonce: u64, deadline_slot: u64, buy_min_out: u64, sell_min_out: u64, buy_tick_count: u8) -> Result<()> {
        let clock = Clock::get()?;
        let vault = &ctx.accounts.vault;
        validate_execution(vault, clock.unix_timestamp, clock.slot, nonce, deadline_slot)?;
        require!(!ctx.accounts.config.paused, GuardError::ServicePaused);
        require!(ctx.accounts.invite.enabled, GuardError::NotInvited);
        require_keys_eq!(ctx.accounts.keeper.key(), vault.keeper, GuardError::Unauthorized);
        require!(ctx.accounts.asset_config.enabled, GuardError::AssetDisabled);
        require!(vault.asset_revision == ctx.accounts.asset_config.revision, GuardError::MintChanged);
        check_registered_mint(&ctx.accounts.asset_config, &ctx.accounts.asset_mint, clock.unix_timestamp)?;
        require_keys_eq!(vault.asset_mint, ctx.accounts.asset_mint.key(), GuardError::InvalidMint);
        require_keys_eq!(vault.pool_a, ctx.accounts.pool_a.key(), GuardError::InvalidPool);
        require_keys_eq!(vault.pool_b, ctx.accounts.pool_b.key(), GuardError::InvalidPool);
        require_keys_eq!(vault.pool_a, ctx.accounts.asset_config.pool_a, GuardError::InvalidPool);
        require_keys_eq!(vault.pool_b, ctx.accounts.asset_config.pool_b, GuardError::InvalidPool);
        validate_pool_accounts(&ctx.accounts.pool_a, &ctx.accounts.pool_a_config, &ctx.accounts.pool_a_observation,
            &ctx.accounts.pool_a_usdc, &ctx.accounts.pool_a_asset, vault.asset_mint)?;
        validate_pool_accounts(&ctx.accounts.pool_b, &ctx.accounts.pool_b_config, &ctx.accounts.pool_b_observation,
            &ctx.accounts.pool_b_usdc, &ctx.accounts.pool_b_asset, vault.asset_mint)?;
        let count = usize::from(buy_tick_count);
        require!(count > 0 && count < ctx.remaining_accounts.len(), GuardError::InvalidTickArray);
        require!(ctx.remaining_accounts.len() <= 16, GuardError::InvalidTickArray);
        let (buy_ticks, sell_ticks) = ctx.remaining_accounts.split_at(count);
        let (buy_pool, sell_pool) = if vault.buy_pool_first { (&ctx.accounts.pool_a, &ctx.accounts.pool_b) } else { (&ctx.accounts.pool_b, &ctx.accounts.pool_a) };
        validate_ticks(buy_ticks, buy_pool)?;
        validate_ticks(sell_ticks, sell_pool)?;
        require!(buy_min_out > 0 && sell_min_out >= vault.cycle_usdc.checked_add(vault.min_profit_usdc).ok_or(GuardError::Arithmetic)?, GuardError::ProfitGuard);
        let usdc_start = ctx.accounts.vault_usdc.amount;
        let asset_start = ctx.accounts.vault_asset.amount;
        require!(usdc_start >= vault.cycle_usdc, GuardError::InsufficientCapital);
        assert_token_invariants(&ctx.accounts.vault_usdc, vault.key(), USDC)?;
        assert_token_invariants(&ctx.accounts.vault_asset, vault.key(), vault.asset_mint)?;
        let owner = vault.owner;
        let bump = [vault.bump];
        let seeds: &[&[u8]] = &[b"vault", owner.as_ref(), &bump];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        let amount = vault.cycle_usdc;
        require!(amount <= vault.principal_usdc.checked_add(vault.accounted_profit_usdc).ok_or(GuardError::Arithmetic)?, GuardError::InsufficientCapital);
        let first = vault.buy_pool_first;
        invoke_swap(&ctx.accounts, first, true, amount, buy_min_out, buy_ticks, signer_seeds)?;
        ctx.accounts.vault_usdc.reload()?;
        ctx.accounts.vault_asset.reload()?;
        let received = ctx.accounts.vault_asset.amount.checked_sub(asset_start).ok_or(GuardError::UnexpectedBalance)?;
        require!(received > 0 && ctx.accounts.vault_usdc.amount == usdc_start.checked_sub(amount).ok_or(GuardError::Arithmetic)?, GuardError::UnexpectedBalance);
        assert_token_invariants(&ctx.accounts.vault_usdc, ctx.accounts.vault.key(), USDC)?;
        assert_token_invariants(&ctx.accounts.vault_asset, ctx.accounts.vault.key(), ctx.accounts.vault.asset_mint)?;
        invoke_swap(&ctx.accounts, !first, false, received, sell_min_out, sell_ticks, signer_seeds)?;
        ctx.accounts.vault_usdc.reload()?;
        ctx.accounts.vault_asset.reload()?;
        let end = ctx.accounts.vault_usdc.amount;
        require!(end >= usdc_start.checked_add(ctx.accounts.vault.min_profit_usdc).ok_or(GuardError::Arithmetic)?, GuardError::ProfitGuard);
        require!(ctx.accounts.vault_asset.amount == asset_start, GuardError::ResidualInventory);
        assert_token_invariants(&ctx.accounts.vault_usdc, ctx.accounts.vault.key(), USDC)?;
        assert_token_invariants(&ctx.accounts.vault_asset, ctx.accounts.vault.key(), ctx.accounts.vault.asset_mint)?;
        check_registered_mint(&ctx.accounts.asset_config, &ctx.accounts.asset_mint, clock.unix_timestamp)?;
        let vault = &mut ctx.accounts.vault;
        let day = clock.unix_timestamp / MAX_PERMISSION;
        if vault.execution_day != day { vault.execution_day = day; vault.daily_cycles = 0; }
        vault.daily_cycles = vault.daily_cycles.checked_add(1).ok_or(GuardError::Arithmetic)?;
        vault.last_executed_at = clock.unix_timestamp;
        vault.accounted_profit_usdc = vault.accounted_profit_usdc.checked_add(end.checked_sub(usdc_start).ok_or(GuardError::Arithmetic)?).ok_or(GuardError::Arithmetic)?;
        vault.nonce = vault.nonce.checked_add(1).ok_or(GuardError::Arithmetic)?;
        emit!(CycleReceipt { owner, vault: vault.key(), nonce, asset_mint: vault.asset_mint, buy_pool: buy_pool.key(), sell_pool: sell_pool.key(),
            usdc_start, usdc_end: end, asset_received: received, profit_usdc: end.checked_sub(usdc_start).ok_or(GuardError::Arithmetic)?, slot: clock.slot, timestamp: clock.unix_timestamp, mint_fingerprint: ctx.accounts.asset_config.fingerprint });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + ServiceConfig::INIT_SPACE, seeds = [b"config"], bump)] pub config: Account<'info, ServiceConfig>,
    /// CHECK: canonical loader PDA, owner, discriminator and upgrade authority validated in handler.
    #[account(owner = UPGRADEABLE_LOADER, seeds = [crate::ID.as_ref()], bump, seeds::program = UPGRADEABLE_LOADER)] pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)] pub config: Account<'info, ServiceConfig>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct CreateInvite<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)] pub config: Account<'info, ServiceConfig>,
    #[account(init, payer = admin, space = 8 + Invite::INIT_SPACE, seeds = [b"invite", owner.as_ref()], bump)] pub invite: Account<'info, Invite>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetInvite<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)] pub config: Account<'info, ServiceConfig>,
    #[account(mut, seeds = [b"invite", invite.owner.as_ref()], bump = invite.bump)] pub invite: Account<'info, Invite>,
}

#[derive(Accounts)]
pub struct RegisterAsset<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)] pub config: Account<'info, ServiceConfig>,
    #[account(init, payer = admin, space = 8 + AssetConfig::INIT_SPACE, seeds = [b"asset", asset_mint.key().as_ref()], bump)] pub asset_config: Account<'info, AssetConfig>,
    pub asset_mint: InterfaceAccount<'info, Mint>,
    pub pool_a: AccountLoader<'info, PoolState>,
    pub pool_b: AccountLoader<'info, PoolState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefreshAsset<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)] pub config: Account<'info, ServiceConfig>,
    #[account(mut, seeds = [b"asset", asset_mint.key().as_ref()], bump = asset_config.bump)] pub asset_config: Account<'info, AssetConfig>,
    pub asset_mint: InterfaceAccount<'info, Mint>,
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)] pub config: Account<'info, ServiceConfig>,
    #[account(seeds = [b"invite", owner.key().as_ref()], bump = invite.bump, has_one = owner)] pub invite: Account<'info, Invite>,
    #[account(init, payer = owner, space = 8 + Vault::INIT_SPACE, seeds = [b"vault", owner.key().as_ref()], bump)] pub vault: Box<Account<'info, Vault>>,
    #[account(seeds = [b"asset", asset_mint.key().as_ref()], bump = asset_config.bump)] pub asset_config: Box<Account<'info, AssetConfig>>,
    #[account(address = USDC)] pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init_if_needed, payer = owner, associated_token::mint = usdc_mint, associated_token::authority = vault, associated_token::token_program = token_program)] pub vault_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = owner, associated_token::mint = asset_mint, associated_token::authority = vault, associated_token::token_program = asset_token_program)] pub vault_asset: Box<InterfaceAccount<'info, TokenAccount>>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    #[account(address = asset_config.token_program)] pub asset_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct ConfigureVault<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)] pub config: Account<'info, ServiceConfig>,
    #[account(seeds = [b"invite", owner.key().as_ref()], bump = invite.bump, has_one = owner)] pub invite: Account<'info, Invite>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)] pub vault: Account<'info, Vault>,
    #[account(seeds = [b"asset", asset_mint.key().as_ref()], bump = asset_config.bump)] pub asset_config: Account<'info, AssetConfig>,
    pub asset_mint: InterfaceAccount<'info, Mint>,
}

#[derive(Accounts)]
pub struct OwnerVault<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)] pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)] pub config: Account<'info, ServiceConfig>,
    #[account(seeds = [b"invite", owner.key().as_ref()], bump = invite.bump, has_one = owner)] pub invite: Account<'info, Invite>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)] pub vault: Account<'info, Vault>,
    #[account(address = USDC)] pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = vault, associated_token::token_program = token_program)] pub vault_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = owner, associated_token::token_program = token_program)] pub owner_usdc: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)] pub vault: Account<'info, Vault>,
    #[account(address = USDC)] pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = vault, associated_token::token_program = token_program)] pub vault_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = owner, associated_token::token_program = token_program)] pub owner_usdc: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RecoverAsset<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)] pub vault: Account<'info, Vault>,
    pub asset_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = asset_mint, associated_token::authority = vault, associated_token::token_program = asset_token_program)] pub vault_asset: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, associated_token::mint = asset_mint, associated_token::authority = owner, associated_token::token_program = asset_token_program)] pub owner_asset: InterfaceAccount<'info, TokenAccount>,
    pub asset_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CloseVault<'info> {
    #[account(mut)] pub owner: Signer<'info>,
    #[account(mut, close = owner, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)] pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [b"invite", owner.key().as_ref()], bump = invite.bump, has_one = owner)] pub invite: Account<'info, Invite>,
    #[account(address = USDC)] pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(address = vault.asset_mint)] pub asset_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = vault, associated_token::token_program = token_program)] pub vault_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, associated_token::mint = asset_mint, associated_token::authority = vault, associated_token::token_program = asset_token_program)] pub vault_asset: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub asset_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ExecuteCycle<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)] pub config: Box<Account<'info, ServiceConfig>>,
    #[account(seeds = [b"invite", vault.owner.as_ref()], bump = invite.bump, constraint = invite.owner == vault.owner)] pub invite: Box<Account<'info, Invite>>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump)] pub vault: Box<Account<'info, Vault>>,
    #[account(seeds = [b"asset", asset_mint.key().as_ref()], bump = asset_config.bump)] pub asset_config: Box<Account<'info, AssetConfig>>,
    #[account(address = USDC)] pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = vault, associated_token::token_program = token_program)] pub vault_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = asset_mint, associated_token::authority = vault, associated_token::token_program = asset_config.token_program)] pub vault_asset: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: only this exact executable CPI target is accepted.
    #[account(address = raydium_clmm::ID, executable)] pub raydium_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, anchor_spl::token_2022::Token2022>,
    pub memo_program: Program<'info, anchor_spl::memo::Memo>,
    pub pool_a_config: Box<Account<'info, AmmConfig>>,
    #[account(mut)] pub pool_a: AccountLoader<'info, PoolState>,
    #[account(mut)] pub pool_a_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub pool_a_asset: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub pool_a_observation: AccountLoader<'info, ObservationState>,
    pub pool_b_config: Box<Account<'info, AmmConfig>>,
    #[account(mut)] pub pool_b: AccountLoader<'info, PoolState>,
    #[account(mut)] pub pool_b_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub pool_b_asset: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)] pub pool_b_observation: AccountLoader<'info, ObservationState>,
}

#[account]
#[derive(InitSpace)]
pub struct ServiceConfig { pub admin: Pubkey, pub keeper: Pubkey, pub paused: bool, pub invite_count: u8, pub bump: u8 }
#[account]
#[derive(InitSpace)]
pub struct Invite { pub owner: Pubkey, pub enabled: bool, pub bump: u8, pub nonce_seed: u64 }
#[account]
#[derive(InitSpace)]
pub struct AssetConfig { pub mint: Pubkey, pub pool_a: Pubkey, pub pool_b: Pubkey, pub token_program: Pubkey, pub fingerprint: [u8; 32], pub revision: u64, pub decimals: u8, pub enabled: bool, pub bump: u8 }
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey, pub keeper: Pubkey, pub asset_mint: Pubkey, pub pool_a: Pubkey, pub pool_b: Pubkey,
    pub asset_revision: u64, pub principal_usdc: u64, pub accounted_profit_usdc: u64, pub cycle_usdc: u64, pub min_profit_usdc: u64,
    pub expires_at: i64, pub nonce: u64, pub last_executed_at: i64, pub execution_day: i64,
    pub daily_cycles: u16, pub paused: bool, pub buy_pool_first: bool, pub bump: u8, pub created_at: i64,
}

#[event] pub struct ServiceConfigured { pub keeper: Pubkey, pub paused: bool }
#[event] pub struct VaultInitialized { pub owner: Pubkey, pub vault: Pubkey, pub asset_mint: Pubkey }
#[event] pub struct StrategyConfigured { pub owner: Pubkey, pub vault: Pubkey, pub nonce: u64, pub expires_at: i64, pub paused: bool }
#[event] pub struct VaultPaused { pub owner: Pubkey, pub vault: Pubkey, pub nonce: u64 }
#[event] pub struct FundsMoved { pub owner: Pubkey, pub vault: Pubkey, pub mint: Pubkey, pub amount: u64, pub deposit: bool }
#[event] pub struct CycleReceipt { pub owner: Pubkey, pub vault: Pubkey, pub nonce: u64, pub asset_mint: Pubkey, pub buy_pool: Pubkey, pub sell_pool: Pubkey, pub usdc_start: u64, pub usdc_end: u64, pub asset_received: u64, pub profit_usdc: u64, pub slot: u64, pub timestamp: i64, pub mint_fingerprint: [u8; 32] }

fn validate_policy(cycle: u64, profit: u64) -> Result<()> {
    require!(cycle > 0 && cycle <= CYCLE_CAP, GuardError::CycleCap);
    require!(profit >= MIN_PROFIT, GuardError::ProfitGuard);
    Ok(())
}
fn withdrawal_ledger(balance: u64, amount: u64, principal: u64, profit: u64) -> Result<(u64, u64)> {
    require!(amount <= balance, GuardError::InvalidAmount);
    let tracked = principal.checked_add(profit).ok_or(GuardError::Arithmetic)?;
    let gift = balance.saturating_sub(tracked);
    let deduction = amount.saturating_sub(gift);
    let deducted_profit = profit.min(deduction);
    let next_profit = profit.checked_sub(deducted_profit).ok_or(GuardError::Arithmetic)?;
    let next_principal = principal.checked_sub(deduction.checked_sub(deducted_profit).ok_or(GuardError::Arithmetic)?).ok_or(GuardError::Arithmetic)?;
    let after = balance.checked_sub(amount).ok_or(GuardError::Arithmetic)?;
    let p = next_principal.min(after);
    Ok((p, next_profit.min(after.saturating_sub(p))))
}
fn validate_close(v: &Vault, now: i64) -> Result<()> {
    require!(v.execution_day != now / MAX_PERMISSION || v.daily_cycles == 0, GuardError::DailyCap);
    if v.last_executed_at > 0 {
        require!(now >= v.last_executed_at.checked_add(COOLDOWN).ok_or(GuardError::Arithmetic)?, GuardError::Cooldown);
    }
    Ok(())
}
fn validate_execution(v: &Vault, now: i64, slot: u64, nonce: u64, deadline: u64) -> Result<()> {
    validate_policy(v.cycle_usdc, v.min_profit_usdc)?;
    require!(!v.paused && v.expires_at > now, GuardError::PermissionExpiry);
    require!(v.nonce == nonce, GuardError::NonceMismatch);
    require!(deadline >= slot && deadline <= slot.checked_add(MAX_DEADLINE_SLOTS).ok_or(GuardError::Arithmetic)?, GuardError::QuoteExpired);
    require!(v.last_executed_at == 0 || now >= v.last_executed_at.checked_add(COOLDOWN).ok_or(GuardError::Arithmetic)?, GuardError::Cooldown);
    require!(v.execution_day != now / MAX_PERMISSION || v.daily_cycles < DAILY_CYCLES, GuardError::DailyCap);
    Ok(())
}

fn assert_token_invariants(token: &InterfaceAccount<TokenAccount>, authority: Pubkey, mint: Pubkey) -> Result<()> {
    require_keys_eq!(token.owner, authority, GuardError::InvalidAuthority);
    require_keys_eq!(token.mint, mint, GuardError::InvalidMint);
    require!(token.delegate == COption::None && token.delegated_amount == 0 && token.close_authority == COption::None, GuardError::InvalidAuthority);
    require!(token.state as u8 == 1, GuardError::FrozenAccount);
    // Only initialized public token accounts, no confidential balances or hooks.
    let account_info = token.to_account_info();
    let data = account_info.try_borrow_data()?;
    if data.len() > 165 {
        require!(data[165] == 2, GuardError::InvalidMint);
        for (kind, bytes) in extensions(&data)? {
            match kind {
                7 => require!(bytes.iter().all(|b| *b == 0), GuardError::UnsupportedExtension), // immutable owner is size zero
                15 => require!(bytes.len() == 1 && bytes[0] == 0, GuardError::UnsupportedExtension), // inactive TransferHookAccount
                27 => require!(bytes.is_empty(), GuardError::UnsupportedExtension), // PausableAccount marker
                _ => return err!(GuardError::UnsupportedExtension),
            }
        }
    }
    Ok(())
}

fn validate_pool(pool: &AccountLoader<PoolState>, usdc: Pubkey, asset: Pubkey) -> Result<()> {
    let p = pool.load()?;
    let mint_0 = p.token_mint_0; let mint_1 = p.token_mint_1;
    require!((mint_0 == usdc && mint_1 == asset) || (mint_1 == usdc && mint_0 == asset), GuardError::InvalidPool);
    require!(p.liquidity > 0 && (p.status & (1 << 4)) == 0, GuardError::PoolUnavailable);
    Ok(())
}
fn validate_pool_accounts(pool: &AccountLoader<PoolState>, config: &Account<AmmConfig>, observation: &AccountLoader<ObservationState>, usdc: &InterfaceAccount<TokenAccount>, asset: &InterfaceAccount<TokenAccount>, mint: Pubkey) -> Result<()> {
    validate_pool(pool, USDC, mint)?;
    let p = pool.load()?;
    let pool_key = pool.key();
    let amm_config = p.amm_config; let obs = p.observation_key;
    require_keys_eq!(amm_config, config.key(), GuardError::InvalidPool);
    require_keys_eq!(obs, observation.key(), GuardError::InvalidPool);
    let observation_pool = observation.load()?.pool_id;
    require_keys_eq!(observation_pool, pool_key, GuardError::InvalidPool);
    let (expected_usdc, expected_asset) = if p.token_mint_0 == USDC { (p.token_vault_0, p.token_vault_1) } else { (p.token_vault_1, p.token_vault_0) };
    require_keys_eq!(expected_usdc, usdc.key(), GuardError::InvalidPool);
    require_keys_eq!(expected_asset, asset.key(), GuardError::InvalidPool);
    require_keys_eq!(usdc.mint, USDC, GuardError::InvalidMint);
    require_keys_eq!(asset.mint, mint, GuardError::InvalidMint);
    require_keys_eq!(usdc.owner, pool_key, GuardError::InvalidAuthority);
    require_keys_eq!(asset.owner, pool_key, GuardError::InvalidAuthority);
    Ok(())
}
fn validate_ticks<'info>(accounts: &'info [AccountInfo<'info>], pool: &AccountLoader<'info, PoolState>) -> Result<()> {
    let mut ticks = 0usize;
    let mut seen = Vec::new();
    for info in accounts {
        require!(*info.owner == raydium_clmm::ID && info.is_writable && !info.is_signer, GuardError::InvalidTickArray);
        require!(!seen.contains(info.key), GuardError::InvalidTickArray);
        seen.push(*info.key);
        if info.data_len() == TickArrayState::LEN {
            let loader = AccountLoader::<TickArrayState>::try_from(info)?;
            let t = loader.load()?;
            let pool_id = t.pool_id; let start = t.start_tick_index;
            require_keys_eq!(pool_id, pool.key(), GuardError::InvalidTickArray);
            let expected = Pubkey::find_program_address(&[b"tick_array", pool_id.as_ref(), &start.to_be_bytes()], &raydium_clmm::ID).0;
            require_keys_eq!(expected, info.key(), GuardError::InvalidTickArray);
            let spacing = pool.load()?.tick_spacing;
            require!(TickArrayState::check_is_valid_start_index(start, spacing), GuardError::InvalidTickArray);
            ticks += 1;
        } else if info.data_len() == TickArrayBitmapExtension::LEN {
            require!(ticks == 0, GuardError::InvalidTickArray);
            let loader = AccountLoader::<TickArrayBitmapExtension>::try_from(info)?;
            let pool_id = loader.load()?.pool_id;
            require_keys_eq!(pool_id, pool.key(), GuardError::InvalidTickArray);
            require_keys_eq!(info.key(), TickArrayBitmapExtension::key(pool.key()), GuardError::InvalidTickArray);
        } else { return err!(GuardError::InvalidTickArray); }
    }
    require!(ticks > 0, GuardError::InvalidTickArray);
    Ok(())
}

fn invoke_swap<'info>(a: &ExecuteCycle<'info>, first: bool, buy: bool, amount: u64, minimum: u64, ticks: &'info [AccountInfo<'info>], seeds: &[&[&[u8]]]) -> Result<()> {
    let (config, pool, usdc, asset, observation) = if first {
        (&a.pool_a_config, &a.pool_a, &a.pool_a_usdc, &a.pool_a_asset, &a.pool_a_observation)
    } else { (&a.pool_b_config, &a.pool_b, &a.pool_b_usdc, &a.pool_b_asset, &a.pool_b_observation) };
    let (input, output, input_vault, output_vault, input_mint, output_mint) = if buy {
        (&a.vault_usdc, &a.vault_asset, usdc, asset, &a.usdc_mint, &a.asset_mint)
    } else { (&a.vault_asset, &a.vault_usdc, asset, usdc, &a.asset_mint, &a.usdc_mint) };
    let cpi = raydium_clmm::cpi::accounts::SwapSingleV2 {
        payer: a.vault.to_account_info(), amm_config: config.to_account_info(), pool_state: pool.to_account_info(),
        input_token_account: input.to_account_info(), output_token_account: output.to_account_info(),
        input_vault: input_vault.to_account_info(), output_vault: output_vault.to_account_info(), observation_state: observation.to_account_info(),
        token_program: a.token_program.to_account_info(), token_program_2022: a.token_2022_program.to_account_info(),
        memo_program: a.memo_program.to_account_info(), input_vault_mint: input_mint.to_account_info(), output_vault_mint: output_mint.to_account_info(),
    };
    raydium_clmm::cpi::swap_v2(CpiContext::new_with_signer(raydium_clmm::ID, cpi, seeds).with_remaining_accounts(ticks.to_vec()), amount, minimum, 0, true)
}

fn check_registered_mint(config: &AssetConfig, mint: &InterfaceAccount<Mint>, now: i64) -> Result<()> {
    require_keys_eq!(config.mint, mint.key(), GuardError::InvalidMint);
    require!(*mint.to_account_info().owner == config.token_program && mint.decimals == config.decimals, GuardError::MintChanged);
    require!(mint_fingerprint(&mint.to_account_info(), now)? == config.fingerprint, GuardError::MintChanged);
    Ok(())
}

// Token-2022 TLV wire layout is pinned to spl-token-2022-interface used by
// Anchor1.0.2. No token extension is trusted solely by its display metadata.
fn extensions(data: &[u8]) -> Result<Vec<(u16, &[u8])>> {
    if data.len() <= 165 { return Ok(Vec::new()); }
    require!(data.len() >= 166, GuardError::InvalidMint);
    let mut offset = 166usize;
    let mut entries = Vec::new();
    while offset < data.len() {
        if data[offset..].iter().all(|b| *b == 0) { break; }
        require!(data.len() - offset >= 4, GuardError::InvalidMint);
        let kind = u16::from_le_bytes([data[offset], data[offset + 1]]);
        let size = usize::from(u16::from_le_bytes([data[offset + 2], data[offset + 3]]));
        let end = offset.checked_add(4).and_then(|v| v.checked_add(size)).ok_or(GuardError::Arithmetic)?;
        require!(kind > 0 && end <= data.len() && !entries.iter().any(|(k, _)| *k == kind), GuardError::InvalidMint);
        entries.push((kind, &data[offset + 4..end]));
        offset = end;
    }
    entries.sort_by_key(|(kind, _)| *kind);
    Ok(entries)
}
pub fn mint_fingerprint(info: &AccountInfo, now: i64) -> Result<[u8; 32]> {
    require!(*info.owner == anchor_spl::token::ID || *info.owner == anchor_spl::token_2022::ID, GuardError::InvalidMint);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 82 && data[45] == 1, GuardError::InvalidMint);
    let mut hash = Sha256::new();
    hash.update(b"doubletake-mint-v1"); hash.update(info.owner.as_ref());
    hash.update(&data[..36]); hash.update([data[44]]); hash.update(&data[46..82]);
    if *info.owner == anchor_spl::token::ID { require!(data.len() == 82, GuardError::InvalidMint); }
    else if data.len() > 82 {
        require!(data.len() >= 166 && data[165] == 1, GuardError::InvalidMint);
        for (kind, bytes) in extensions(&data)? {
            hash.update(kind.to_le_bytes());
            match kind {
                3 | 4 | 12 | 18 | 19 | 20 | 21 | 22 | 23 => { hash.update((bytes.len() as u16).to_le_bytes()); hash.update(bytes); },
                6 => { require!(bytes.len() == 1 && bytes[0] == 1, GuardError::FrozenAccount); hash.update(1u16.to_le_bytes()); hash.update(bytes); },
                14 => { require!(bytes.len() == 64 && bytes[32..].iter().all(|b| *b == 0), GuardError::UnsupportedExtension); hash.update(64u16.to_le_bytes()); hash.update(bytes); },
                25 => {
                    require!(bytes.len() == 56, GuardError::InvalidMint);
                    let multiplier = f64::from_le_bytes(bytes[32..40].try_into().unwrap());
                    let activation = i64::from_le_bytes(bytes[40..48].try_into().unwrap());
                    let next = f64::from_le_bytes(bytes[48..56].try_into().unwrap());
                    require!(multiplier.is_finite() && multiplier > 0.0 && next.is_finite() && next > 0.0, GuardError::InvalidMint);
                    if activation > 0 { require!(now.abs_diff(activation) > ACTIVATION_WINDOW as u64, GuardError::MultiplierActivation); }
                    hash.update(32u16.to_le_bytes()); hash.update(&bytes[..32]);
                },
                26 => { require!(bytes.len() == 33 && bytes[32] == 0, GuardError::FrozenAccount); hash.update(33u16.to_le_bytes()); hash.update(bytes); },
                _ => return err!(GuardError::UnsupportedExtension),
            }
        }
    }
    Ok(hash.finalize().into())
}

fn approved_pair(mint: Pubkey, pool_a: Pubkey, pool_b: Pubkey) -> Result<()> {
    let pairs = [
        (pubkey!("XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"), pubkey!("CKwJZwm7oj3nu4653N1EpDrqXbXAYXoPFiPeEnLouF8y"), pubkey!("ApniVWuZbZoruTAJdyJcLBA4AVw4DKGdV5fHxo6qrAZT")),
        (pubkey!("XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"), pubkey!("8aDaBQkTrS6HVMjyc6EZebgdiaXhLYGriDWKWWp1NpFF"), pubkey!("HHQUnUbmWLrYzkscDY1C3deEFbGtiGBGoHjpANogmvum")),
        (pubkey!("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"), pubkey!("49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6"), pubkey!("4KqQN6u1pFKroFE2jVEhoepAMRKPcuAzWVDCgm9zRBYN")),
        (pubkey!("XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX"), pubkey!("CLu4kFM4nb67xrdN7vJnMxXXir8Z5hA4HJUzPFccXjsL"), pubkey!("D6bRhQUcR9B7bPbbqgxpE17MjyUjBtr8hHQCcJoHrrv1")),
        (pubkey!("XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN"), pubkey!("B8YAwjGYk6qidWzGBXMAxP7nYfG8g74EZ3Y4gFSsobRw"), pubkey!("9sw1NZjXFsy5GKkqMpQWV7wopGgMcdkanDqg3f15zQZv")),
        (pubkey!("So11111111111111111111111111111111111111112"), pubkey!("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv"), pubkey!("8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj")),
        (pubkey!("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"), pubkey!("Fu5uXjR17rGbUur294Ke3UxCH8JF5nWYYCe9wqNjDuFr"), pubkey!("5Z2YAbbCeagp8kMTAD61fvbT5bcw45Qjubz8t8YobtZR")),
    ];
    require!(pairs.iter().any(|p| *p == (mint, pool_a, pool_b)), GuardError::InvalidPool);
    Ok(())
}

#[error_code]
pub enum GuardError {
    #[msg("Signer is not authorized")] Unauthorized,
    #[msg("Program upgrade-authority proof is invalid")] InvalidProgramData,
    #[msg("The five-user beta invite cap is reached")] InviteCap,
    #[msg("Wallet does not have an active invite")] NotInvited,
    #[msg("Execution service is paused")] ServicePaused,
    #[msg("Asset execution is disabled")] AssetDisabled,
    #[msg("Token mint is invalid")] InvalidMint,
    #[msg("Issuer authority or token configuration changed")] MintChanged,
    #[msg("Mint extension is incompatible with public atomic swaps")] UnsupportedExtension,
    #[msg("Token account or issuer mint is frozen or paused")] FrozenAccount,
    #[msg("Scaled multiplier activation is within fifteen minutes")] MultiplierActivation,
    #[msg("Pool does not match the approved route")] InvalidPool,
    #[msg("Pool is paused or has no active liquidity")] PoolUnavailable,
    #[msg("Tick arrays are invalid or do not belong to the approved pool")] InvalidTickArray,
    #[msg("Token authority or delegate invariant failed")] InvalidAuthority,
    #[msg("Amount must be positive and available")] InvalidAmount,
    #[msg("Deposited principal exceeds 100 USDC")] DepositCap,
    #[msg("Cycle amount exceeds 25 USDC")] CycleCap,
    #[msg("Minimum profit requirement failed")] ProfitGuard,
    #[msg("Owner permission expired or strategy is paused")] PermissionExpiry,
    #[msg("Withdraw, recover and close the vault before choosing another asset")] PauseBeforeAssetChange,
    #[msg("Strategy nonce is stale")] NonceMismatch,
    #[msg("Execution quote slot deadline expired")] QuoteExpired,
    #[msg("The sixty-second execution cooldown is active")] Cooldown,
    #[msg("The ten-cycle daily execution cap is reached")] DailyCap,
    #[msg("Vault does not have the cycle capital")] InsufficientCapital,
    #[msg("Unexpected balance change")] UnexpectedBalance,
    #[msg("Cycle left new intermediate inventory")] ResidualInventory,
    #[msg("Checked arithmetic failed")] Arithmetic,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn vault() -> Vault { Vault { owner: Pubkey::new_unique(), keeper: Pubkey::new_unique(), asset_mint: Pubkey::new_unique(), pool_a: Pubkey::new_unique(), pool_b: Pubkey::new_unique(), asset_revision: 1, principal_usdc: 100_000_000, accounted_profit_usdc: 0, cycle_usdc: 25_000_000, min_profit_usdc: MIN_PROFIT, expires_at: 86_400, nonce: 3, last_executed_at: 0, execution_day: 0, daily_cycles: 0, paused: false, buy_pool_first: true, bump: 255, created_at: 1 } }
    #[test] fn gifts_do_not_increase_principal_or_spend_tracked_profit() { assert_eq!(withdrawal_ledger(130, 20, 100, 10).unwrap(), (100,10)); assert_eq!(withdrawal_ledger(130, 25, 100, 10).unwrap(), (100,5)); assert_eq!(withdrawal_ledger(130, 40, 100, 10).unwrap(), (90,0)); assert_eq!(withdrawal_ledger(130, 130, 100, 10).unwrap(), (0,0)); }
    #[test] fn limits_and_replays() { let mut v = vault(); assert!(validate_execution(&v, 100, 10, 3, 30).is_ok()); assert!(validate_execution(&v, 100, 10, 2, 30).is_err()); assert!(validate_execution(&v, 100, 10, 3, 9).is_err()); assert!(validate_execution(&v, 100, 10, 3, 51).is_err()); v.paused = true; assert!(validate_execution(&v, 100, 10, 3, 30).is_err()); }
    #[test] fn expiry_daily_cap_cooldown() { let mut v = vault(); assert!(validate_execution(&v, 86_400, 10, 3, 20).is_err()); v.daily_cycles = 10; assert!(validate_execution(&v, 100, 10, 3, 20).is_err()); v.execution_day = -1; assert!(validate_execution(&v, 100, 10, 3, 20).is_ok()); v.last_executed_at = 80; assert!(validate_execution(&v, 139, 10, 3, 20).is_err()); assert!(validate_execution(&v, 140, 10, 3, 20).is_ok()); }
    #[test] fn close_cannot_reset_cooldown_at_midnight() { let mut v = vault(); v.execution_day=0; v.daily_cycles=1; v.last_executed_at=86_399; assert!(validate_close(&v,86_399).is_err()); assert!(validate_close(&v,86_400).is_err()); assert!(validate_close(&v,86_458).is_err()); assert!(validate_close(&v,86_459).is_ok()); }
    #[test] fn policy_floor_caps() { assert!(validate_policy(25_000_000, 50_000).is_ok()); assert!(validate_policy(25_000_001, 50_000).is_err()); assert!(validate_policy(0, 50_000).is_err()); assert!(validate_policy(1, 49_999).is_err()); }
    #[test] fn tlv_rejects_duplicate_and_truncated() { let mut d = vec![0; 166]; d.extend_from_slice(&[12, 0, 1, 0, 1]); d.extend_from_slice(&[12, 0, 1, 0, 1]); assert!(extensions(&d).is_err()); d.truncate(168); assert!(extensions(&d).is_err()); }
    #[test] fn exact_pair_allowlist() { assert!(approved_pair(pubkey!("So11111111111111111111111111111111111111112"), pubkey!("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv"), pubkey!("8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj")).is_ok()); assert!(approved_pair(Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique()).is_err()); }
    fn fingerprint(mut data: Vec<u8>, now: i64) -> Result<[u8;32]> { let mint = Pubkey::new_unique(); let owner = anchor_spl::token_2022::ID; let mut lamports = 1; let info = AccountInfo::new(&mint,false,false,&mut lamports,&mut data,&owner,false); mint_fingerprint(&info, now) }
    fn extension_mint(kind:u16,bytes:&[u8]) -> Vec<u8> { let mut d=vec![0;166]; d[44]=8;d[45]=1;d[165]=1;d.extend_from_slice(&kind.to_le_bytes());d.extend_from_slice(&(bytes.len() as u16).to_le_bytes());d.extend_from_slice(bytes);d }
    #[test] fn null_hook_allowed_but_active_hook_rejected() { let hook=vec![0;64];assert!(fingerprint(extension_mint(14,&hook),1000).is_ok());let mut active=hook;active[32]=1;assert!(fingerprint(extension_mint(14,&active),1000).is_err());assert!(fingerprint(extension_mint(1,&[0;108]),1000).is_err()); }
    #[test] fn scaled_activation_and_authority_fingerprint() { let mut scale=vec![0;56];scale[32..40].copy_from_slice(&1f64.to_le_bytes());scale[40..48].copy_from_slice(&2000i64.to_le_bytes());scale[48..56].copy_from_slice(&2f64.to_le_bytes());let before=fingerprint(extension_mint(25,&scale),1000).unwrap();assert!(fingerprint(extension_mint(25,&scale),1100).is_err());assert!(fingerprint(extension_mint(25,&scale),2900).is_err());assert!(fingerprint(extension_mint(25,&scale),2901).is_ok());scale[48..56].copy_from_slice(&3f64.to_le_bytes());assert_eq!(before,fingerprint(extension_mint(25,&scale),1000).unwrap());scale[0]=1;assert_ne!(before,fingerprint(extension_mint(25,&scale),1000).unwrap()); }
    #[test] fn public_confidential_mint_allowed_issuer_pause_rejected() { assert!(fingerprint(extension_mint(4,&[0;65]),1000).is_ok());let mut paused=vec![0;33];paused[32]=1;assert!(fingerprint(extension_mint(26,&paused),1000).is_err());assert!(fingerprint(extension_mint(6,&[2]),1000).is_err()); }
    #[test] fn gift_withdrawal_ledger_conserves_accounted_value() { for principal in 0..20 { for profit in 0..10 {for gift in 0..5 { let balance=principal+profit+gift; for amount in 0..=balance {let (p,f)=withdrawal_ledger(balance,amount,principal,profit).unwrap(); assert!(p<=principal&&f<=profit); assert!(p+f<=balance-amount);}}}} }
}
