# DoubleTake

An invite-only Solana arbitrage workspace with owner-controlled USDC strategies and a separate prepaid SOL execution allowance. The beta supports five invited wallets, seven markets, and no ordinary buy/sell trading.

The application, persistent service, keeper and guarded Anchor program live in this repository. Funding and automation remain disabled until deployment verification, infrastructure, engineering review and founder canary gates pass. No profitable fills or external users are claimed.

## Product

- **Markets:** AAPLx, TSLAx, NVDAx, MSFTx, GOOGLx, SOL and JUP. Fixed Raydium CLMM pairs, actual RPC pool prices/fees, source liquidity, freshness, issuer multipliers and exact tick-array quotes. Observations alone do not authorize execution.
- **Strategies:** one owner vault and one fixed asset per owner; 100 USDC deposited-principal cap, 25 USDC cycle cap, minimum 0.05 USDC profit, 60-second cooldown, ten confirmed cycles per UTC day and authorization of at most 24 hours.
- **Execution:** two direct Raydium swaps inside one guarded transaction. The second swap uses the raw quantity actually received. Final USDC must meet the profit floor without additional intermediate inventory; otherwise token changes revert. Network fees remain payable.
- **Activity:** persistent intents and confirmed receipts. Accepted signatures stay pending until reconciled. Successful and failed fees, deposits, withdrawals, pauses and refunds are recorded without double charging.
- **Owner controls:** wallet-signed pause, revoke and USDC withdrawal. A direct-RPC recovery panel works without the service or keeper; signatures are imported into Activity when the service returns.
- **Fees and email:** per-owner service-controlled SOL wallets, encrypted keys, reservations and refunds; verified-email preferences and a deduplicated delivery outbox.

New authorizations default to 23 hours 59 minutes, leaving a small clock buffer below the program's 24-hour maximum. The program enforces its hard ten-cycle/60-second limits; stricter owner preferences and prepaid SOL spend limits are enforced by the service.

Prepaid SOL is service controlled; refunds depend on the service. USDC exits depend on the Solana program and owner signature. No fees are withdrawn automatically from the connected wallet. The beta charges no trading or performance fee and promises no profit.

## Local development

Use Node 22.22.2 or newer within the pinned supported range. `.npmrc` matches the lockfile peer-resolution settings.

```sh
npm ci
npm test
npm run build
npm run dev
```

Open `http://localhost:3000`. Without credentials, real public market data and configuration states remain accessible; account/funding/automation routes identify missing prerequisites. Public RPC can be rate limited. Configure a private RPC for the pilot.

Copy `.env.example` to a private environment file or configure service variables. For a local file use `node --env-file=.env --import tsx server/index.ts`. Production requires Postgres. Localnet integration can use `DATABASE_URL=pglite:.local/database`, a persistent embedded Postgres adapter. Run `npm run db:migrate` with the same environment before enabling accounts. Never use the embedded adapter in production.

Linux build/runtime instructions are in [onchain/README.md](onchain/README.md). Unit tests do not replace actual two-leg fork testing.

## Engineering

React/Vite and the TypeScript service share the mint registry, raw integer amounts, interfaces and canonical instruction builder. Fastify serves the application and API. Postgres stores owner-scoped accounts, observations, leases, strategies, intents, receipts, fee accounting and notification delivery. Wallet-signature authentication uses one-time challenges, secure cookies and CSRF protection.

The keeper uses a fair leased queue, one execution in flight per vault, fresh exact-pool reads and whole-transaction simulation. It persists signed bytes before submission, reconciles ambiguity and never blindly resubmits. The operator switch stops new execution while reconciliation, refunds and independent exits remain available. Market samples are retained for 30 days; financial records remain until explicitly archived. Encrypted daily snapshots go to persistent backup storage.

Token-2022 issuer metadata is checked before quoting/execution. Scaled-amount changes block execution for 15 minutes on either side; accounting stays in raw units. Active hooks/fees, frozen or paused transfers, incompatible issuer changes, substituted pools and missing ticks fail closed. xStock invitations additionally require verified issuer eligibility.

The browser reconstructs owner messages, checks instructions/accounts/amounts against the reviewed action, requires a build-pinned program ID and rejects changed wallet messages. Execution uses a reviewed address lookup table; owner exits use explicit accounts.

## Hosting and launch

The public workspace and Node service are deployed at [DoubleTake on Railway](https://doubletake-production-446f.up.railway.app/). Health, configuration, anonymous session status and all seven actual Raydium market observations passed signed-out checks. The service has a persistent `/data` volume for its RPC usage counter. Postgres, email, program identity, invitations and financial encryption keys are not configured; account services, funding and automation remain unavailable. A mounted volume does not establish a verified financial backup.

[Setup guide](docs/BETA-SETUP.md) covers the remaining accounts, domain, migrations and release sequence. [Release status](docs/RELEASE-STATUS.md) records the actual cloud identifiers, checks and open gates. Railway is the canonical public workspace. A redirect from the earlier [Vercel address](https://doubletake-app.vercel.app/) is being prepared and has not yet been verified in this revision. Historical Vercel deployments and the public-workspace adapter remain in the repository.

Hosting currently uses Railway's 30-day trial with its US$5 credit cap. No paid upgrade or new account terms were accepted. Configure the US$20 hard monthly usage limit before any founder-approved paid upgrade; that limit is not available in the current trial dashboard and has not been set.

Mainnet requires reproducible program verification, a published upgrade authority separate from keeper credentials, independent engineering review and a founder-approved canary. Engineering review is not a formal external audit. Funding remains disabled while a gate is open.

The available Git history starts September 25, 2026; the first commit does not establish when development began. The October 13 viewer and preparation are preserved in [archived documentation](docs/archive/2026-10-13-research-prototype.md). This beta expands that existing code; history and actual deployment identifiers remain intact.

SDK/program dependencies are pinned. Raydium CPI source is fixed at `ed1eb41519d5355755f7df52b43fa9610938b60b`. web3.js v1 interoperability is retained for wallet/Raydium compatibility. See [dependency notes](docs/DEPENDENCIES.md).
