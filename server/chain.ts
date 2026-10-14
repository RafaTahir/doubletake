import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import bs58 from "bs58";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  type TransactionInstruction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import { unpackAccount } from "@solana/spl-token";
import {
  BETA_LIMITS,
  MARKETS,
  USDC,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  marketByMint,
} from "../shared/registry.ts";
import { rawInteger, scaledDisplay } from "../shared/amounts.ts";
import {
  DEVELOPMENT_PROGRAM_ID,
  deriveProgramAddresses,
  decodeVaultState,
  decodeServiceConfig,
  buildOwnerInstruction,
  buildExecuteInstruction,
  ownerAtaCreation,
  validateOwnerTransaction,
  type ChainVaultState,
} from "../shared/program.ts";
import type {
  Cluster,
  ExecutionPreview,
  Portfolio,
  Strategy,
  OwnerAction,
} from "../shared/types.ts";
import type {
  ChainGateway,
  PreparedTransaction,
  IntentRecord,
  Reconciliation,
  ActionKind,
} from "./ports.ts";
import { RaydiumMarkets, mintSafety, type CycleQuote } from "./markets.ts";

export interface ChainOptions {
  rpcUrl: string;
  cluster: Cluster;
  programId?: string;
  programVerified?: boolean;
  expectedProgramSha256?: string;
  expectedUpgradeAuthority?: string;
  mainnetCanaryVerified?: boolean;
  canaryApproved?: boolean;
  canaryOwner?: string;
  keeperEnabled?: boolean;
  lookupTable?: string;
}
const key = (value: string) => new PublicKey(value);
const bytesHash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const errorText = (value: unknown) =>
  value instanceof Error
    ? value.message.slice(0, 180)
    : "Chain operation unavailable";
function policyFrom(payload: Record<string, unknown>) {
  return payload.policy as Strategy["policy"] | undefined;
}
function safeLamports(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw Error("RPC returned an unsafe native-token amount");
  return BigInt(value);
}
export function networkFeeFromReceipt(
  meta: { fee: number; preBalances: number[]; postBalances: number[] },
  cluster: Cluster = "mainnet-beta",
) {
  if (
    !meta.preBalances.length ||
    meta.preBalances.length !== meta.postBalances.length
  )
    throw Error("Chain receipt balance proof is incomplete");
  const fee =
    meta.preBalances.reduce((sum, value) => sum + safeLamports(value), 0n) -
    meta.postBalances.reduce((sum, value) => sum + safeLamports(value), 0n);
  const reported = safeLamports(meta.fee);
  if (fee < reported || fee > 0xffffffffffffffffn)
    throw Error("Chain receipt has invalid fee conservation");
  // Surfpool omits priority from meta.fee while recording the full local balance debit.
  // Never substitute this simulator workaround for a production RPC's charged fee.
  if (cluster === "localnet") return fee.toString();
  if (fee !== reported)
    throw Error(
      "RPC fee metadata and balance proof disagree; reconciliation requires verification",
    );
  return reported.toString();
}
function simulationError(
  error: unknown,
  logs: readonly string[] | null | undefined,
) {
  const anchor = logs?.find(
    (log) => log.includes("AnchorError") && log.includes("Error Message:"),
  );
  if (anchor) return anchor.split("Error Message:").at(-1)!.trim();
  const token = logs?.find((log) =>
    /Program log: Error:.*(frozen|paused|insufficient|owner|mint)/i.test(log),
  );
  return token
    ? token.replace("Program log: Error:", "").trim()
    : JSON.stringify(error);
}
export function extractCycleMetadata(
  logs: readonly string[],
  programId: string,
  owner: string,
) {
  const stack: string[] = [];
  const discriminator = createHash("sha256")
    .update("event:CycleReceipt")
    .digest()
    .subarray(0, 8);
  for (const log of logs) {
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(log);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    const done = /^Program (\S+) (?:success|failed:)/.exec(log);
    if (done) {
      const index = stack.lastIndexOf(done[1]);
      if (index >= 0) stack.length = index;
      continue;
    }
    if (stack.at(-1) !== programId || !log.startsWith("Program data: "))
      continue;
    const data = Buffer.from(log.slice(14), "base64");
    if (data.length !== 256 || !data.subarray(0, 8).equals(discriminator))
      continue;
    if (
      new PublicKey(data.subarray(8, 40)).toBase58() !== owner ||
      new PublicKey(data.subarray(40, 72)).toBase58() !==
        deriveProgramAddresses(programId, owner).vault
    )
      throw Error("Guarded cycle event owner differs from the intent");
    return {
      nonce: data.readBigUInt64LE(72).toString(),
      assetMint: new PublicKey(data.subarray(80, 112)).toBase58(),
      poolBuy: new PublicKey(data.subarray(112, 144)).toBase58(),
      poolSell: new PublicKey(data.subarray(144, 176)).toBase58(),
      startingUsdcRaw: data.readBigUInt64LE(176).toString(),
      returnedUsdcRaw: data.readBigUInt64LE(184).toString(),
      assetReceivedRaw: data.readBigUInt64LE(192).toString(),
      profitRaw: data.readBigUInt64LE(200).toString(),
      mintFingerprint: data.subarray(224, 256).toString("hex"),
    };
  }
  return null;
}
function verifySignature(
  signature: Uint8Array,
  message: Uint8Array,
  signer: PublicKey,
) {
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      signer.toBuffer(),
    ]),
    format: "der",
    type: "spki",
  });
  return verify(null, Buffer.from(message), publicKey, Buffer.from(signature));
}
export class SolanaChainGateway implements ChainGateway {
  readonly connection: Connection;
  private verified = false;
  private verificationReasons: string[] = [];
  private verifiedAt = 0;
  private previews = new Map<
    string,
    {
      quote: CycleQuote;
      prepared: PreparedTransaction;
      nonce: string;
      expiresAt: number;
    }
  >();
  private keeperReviews = new Map<
    string,
    {
      owner: string;
      action: string;
      expiresAt: number;
      instructions: TransactionInstruction[];
    }
  >();
  constructor(
    private options: ChainOptions,
    private markets: RaydiumMarkets,
  ) {
    this.connection = markets.connection;
  }
  readiness(owner?: string) {
    const id = this.options.programId;
    const configured = Boolean(
      id &&
        (this.options.cluster !== "mainnet-beta" ||
          id !== DEVELOPMENT_PROGRAM_ID),
    );
    const reasons: string[] = [];
    if (!configured)
      reasons.push("The guarded Solana program is not deployed and configured");
    if (!this.options.programVerified || !this.verified)
      reasons.push(
        ...(this.verificationReasons.length
          ? this.verificationReasons
          : ["Program bytecode and authority verification is required"]),
      );
    const approvedCanary = Boolean(
      owner &&
        this.options.canaryApproved &&
        owner === this.options.canaryOwner,
    );
    if (
      this.options.cluster === "mainnet-beta" &&
      !this.options.mainnetCanaryVerified &&
      !approvedCanary
    )
      reasons.push("The founder-approved mainnet canary has not passed");
    const fundingEnabled =
      configured &&
      this.verified &&
      Boolean(this.options.programVerified) &&
      (this.options.cluster !== "mainnet-beta" ||
        Boolean(this.options.mainnetCanaryVerified) ||
        approvedCanary);
    return {
      programConfigured: configured,
      fundingEnabled,
      automationEnabled: fundingEnabled && Boolean(this.options.keeperEnabled),
      reasons,
    };
  }
  async verifyDeployment() {
    this.verified = false;
    this.verificationReasons = [];
    if (!this.options.programId || !this.options.programVerified) {
      this.verificationReasons.push(
        "Deploy and independently verify the guarded program before funding",
      );
      return;
    }
    if (
      this.options.cluster === "mainnet-beta" &&
      (!/^[a-f0-9]{64}$/i.test(this.options.expectedProgramSha256 ?? "") ||
        !this.options.expectedUpgradeAuthority)
    ) {
      this.verificationReasons.push(
        "A published program-data hash and upgrade authority are required",
      );
      return;
    }
    try {
      const expectedGenesis =
        this.options.cluster === "mainnet-beta"
          ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
          : this.options.cluster === "devnet"
            ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
            : null;
      if (
        expectedGenesis &&
        (await this.connection.getGenesisHash()) !== expectedGenesis
      )
        throw Error(
          "Configured RPC does not match the selected Solana cluster",
        );
      const program = await this.connection.getAccountInfo(
        key(this.options.programId),
      );
      if (!program?.executable)
        throw Error("Configured program is not executable");
      const loader = new PublicKey(
        "BPFLoaderUpgradeab1e11111111111111111111111",
      );
      if (program.owner.equals(loader)) {
        if (program.data.length !== 36 || program.data.readUInt32LE(0) !== 2)
          throw Error("Invalid upgradeable program account");
        const data = await this.connection.getAccountInfo(
          new PublicKey(program.data.subarray(4, 36)),
        );
        if (
          !data ||
          !data.owner.equals(loader) ||
          data.data.length <= 45 ||
          data.data.readUInt32LE(0) !== 3
        )
          throw Error("Invalid deployed program data");
        const authority =
          data.data[12] === 1
            ? new PublicKey(data.data.subarray(13, 45)).toBase58()
            : "immutable";
        if (
          this.options.expectedUpgradeAuthority &&
          authority !== this.options.expectedUpgradeAuthority
        )
          throw Error(
            "Program upgrade authority differs from the published authority",
          );
        if (
          this.options.expectedProgramSha256 &&
          bytesHash(data.data.subarray(45)) !==
            this.options.expectedProgramSha256.toLowerCase()
        )
          throw Error(
            "Deployed bytecode differs from the published program-data hash",
          );
      } else if (this.options.cluster === "mainnet-beta")
        throw Error(
          "Mainnet program must match the reviewed deployment format",
        );
      const addresses = deriveProgramAddresses(
        this.options.programId,
        PublicKey.default.toBase58(),
      );
      const config = await this.connection.getAccountInfo(
        key(addresses.config),
      );
      if (!config) throw Error("The guarded program configuration is missing");
      decodeServiceConfig(config, this.options.programId);
      this.verified = true;
      this.verifiedAt = Date.now();
    } catch (error) {
      this.verificationReasons = [errorText(error)];
    }
  }
  private async requireFunding(owner: string) {
    if (Date.now() - this.verifiedAt > 60_000) await this.verifyDeployment();
    if (!this.readiness(owner).fundingEnabled)
      throw Error(this.readiness(owner).reasons.join("; "));
  }
  private program() {
    if (!this.options.programId)
      throw Error("Guarded program address is not configured");
    return this.options.programId;
  }
  private async vault(owner: string): Promise<{
    state: ChainVaultState;
    balance: string;
    slot: number;
    checkedAt: string;
  } | null> {
    const a = deriveProgramAddresses(this.program(), owner);
    const response = await this.connection.getMultipleAccountsInfoAndContext([
      key(a.vault),
      key(a.vaultUsdc),
    ]);
    if (!response.value[0]) return null;
    const state = decodeVaultState(response.value[0], this.program());
    if (state.owner !== owner) throw Error("Strategy owner mismatch");
    const account = response.value[1];
    if (!account) throw Error("USDC vault account is missing");
    const usdc = unpackAccount(key(a.vaultUsdc), account, key(TOKEN_PROGRAM));
    if (
      usdc.owner.toBase58() !== a.vault ||
      usdc.mint.toBase58() !== USDC.mint ||
      usdc.delegate ||
      usdc.closeAuthority ||
      usdc.isFrozen
    )
      throw Error("USDC vault authority or transfer state changed");
    return {
      state,
      balance: usdc.amount.toString(),
      slot: response.context.slot,
      checkedAt: new Date().toISOString(),
    };
  }
  async portfolio(owner: string): Promise<Portfolio> {
    const address = key(owner);
    const responses = [];
    for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM])
      responses.push(
        await this.connection.getTokenAccountsByOwner(address, {
          programId: key(program),
        }),
      );
    const amounts = new Map<string, { amount: bigint; accounts: string[] }>();
    let usdc = 0n;
    for (const response of responses)
      for (const entry of response.value) {
        const account = unpackAccount(
          entry.pubkey,
          entry.account,
          entry.account.owner,
        );
        if (!account.owner.equals(address))
          throw Error(
            "RPC returned a token account belonging to another owner",
          );
        const mint = account.mint.toBase58();
        if (mint === USDC.mint) usdc += account.amount;
        const market = marketByMint(mint);
        if (!market || account.amount === 0n) continue;
        const previous = amounts.get(mint) ?? { amount: 0n, accounts: [] };
        previous.amount += account.amount;
        previous.accounts.push(entry.pubkey.toBase58());
        amounts.set(mint, previous);
      }
    const snapshots = await this.markets.snapshot();
    const sol = await this.connection.getBalanceAndContext(address);
    return {
      owner,
      solBalanceLamports: safeLamports(sol.value).toString(),
      usdcBalanceRaw: usdc.toString(),
      holdings: [...amounts].map(([mint, balance]) => {
        const asset = marketByMint(mint)!;
        const multiplier =
          snapshots.find((s) => s.mint === mint)?.multiplier ?? "1";
        return {
          symbol: asset.symbol,
          mint,
          amountRaw: balance.amount.toString(),
          decimals: asset.decimals,
          multiplier,
          displayAmount: scaledDisplay(
            balance.amount.toString(),
            asset.decimals,
            multiplier,
          ),
          tokenAccounts: balance.accounts,
        };
      }),
      slot: Math.min(sol.context.slot, ...responses.map((r) => r.context.slot)),
      checkedAt: new Date().toISOString(),
    };
  }
  async refreshStrategy(strategy: Strategy): Promise<Strategy> {
    if (!this.options.programId) return strategy;
    const current = await this.vault(strategy.owner);
    if (!current)
      return {
        ...strategy,
        status: "draft",
        vaultAddress: deriveProgramAddresses(
          this.program(),
          strategy.owner,
          strategy.policy.assetMint,
        ).vault,
        balanceUsdcRaw: "0",
        depositedPrincipalRaw: "0",
        nonce: "0",
      };
    const s = current.state;
    const asset = marketByMint(s.assetMint);
    if (!asset) throw Error("Vault asset is not in the reviewed registry");
    const expired = s.expiresAt * 1000 <= Date.now();
    return {
      ...strategy,
      vaultAddress: deriveProgramAddresses(
        this.program(),
        strategy.owner,
        s.assetMint,
      ).vault,
      keeperAddress: s.keeper,
      policy: {
        ...strategy.policy,
        assetMint: s.assetMint,
        poolBuy: s.buyPoolFirst ? s.poolA : s.poolB,
        poolSell: s.buyPoolFirst ? s.poolB : s.poolA,
        cycleAmountRaw: s.cycleAmountRaw,
        minProfitRaw: s.minProfitRaw,
        ...(s.expiresAt > 0
          ? { expiresAt: new Date(s.expiresAt * 1000).toISOString() }
          : {}),
      },
      status: s.paused ? "paused" : expired ? "expired" : "active",
      pauseReason: s.paused
        ? "Paused on Solana"
        : expired
          ? "Automation permission expired"
          : null,
      balanceUsdcRaw: current.balance,
      depositedPrincipalRaw: s.principalUsdcRaw,
      nonce: s.nonce,
      confirmedCyclesToday:
        s.executionDay === Math.floor(Date.now() / 86400000)
          ? s.dailyCycles
          : 0,
      chainSlot: current.slot,
      checkedAt: current.checkedAt,
      updatedAt: new Date().toISOString(),
    };
  }
  private async build(
    instructions: TransactionInstruction[],
    payer: string,
    summary: PreparedTransaction["summary"],
    simulate = true,
  ): Promise<PreparedTransaction> {
    const latest = await this.connection.getLatestBlockhash();
    let tables: AddressLookupTableAccount[] = [];
    if (this.options.lookupTable && summary.action === "execute") {
      const table = await this.connection.getAddressLookupTable(
        key(this.options.lookupTable),
      );
      if (!table.value || !table.value.isActive())
        throw Error("The execution lookup table is missing or inactive");
      tables = [table.value];
    }
    const compile = (units: number) =>
      new TransactionMessage({
        payerKey: key(payer),
        recentBlockhash: latest.blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
          ...instructions,
        ],
      }).compileToV0Message(tables);
    let computeLimit = 1_400_000;
    let message = compile(computeLimit);
    let transaction = new VersionedTransaction(message);
    if (transaction.serialize().length > 1232)
      throw Error(
        "This cycle exceeds the transaction size limit; configure the reviewed address lookup table",
      );
    let unitsConsumed: number | null = null;
    if (simulate) {
      const result = await this.connection.simulateTransaction(transaction, {
        sigVerify: false,
        commitment: "confirmed",
      });
      if (result.value.err)
        throw Error(
          `Transaction simulation failed: ${simulationError(result.value.err, result.value.logs)}`,
        );
      const used = result.value.unitsConsumed;
      if (!used || used > 1_400_000)
        throw Error("Simulation did not produce a valid compute estimate");
      unitsConsumed = used;
      computeLimit = Math.min(1_400_000, Math.ceil(used * 1.2));
      message = compile(computeLimit);
      transaction = new VersionedTransaction(message);
    }
    const fee = await this.connection.getFeeForMessage(message);
    if (fee.value === null || !Number.isSafeInteger(fee.value) || fee.value < 0)
      throw Error("Network fee estimate unavailable");
    const estimatedFee = Math.max(
      fee.value,
      5000 + Math.ceil((computeLimit * 1000) / 1_000_000),
    );
    if (summary.action === "execute" || summary.action === "fee-refund") {
      const hash = bytesHash(message.serialize());
      this.keeperReviews.set(hash, {
        owner: summary.owner,
        action: summary.action,
        expiresAt: Date.now() + 30_000,
        instructions: TransactionMessage.decompile(message, {
          addressLookupTableAccounts: tables,
        }).instructions,
      });
      for (const [id, review] of this.keeperReviews)
        if (review.expiresAt < Date.now()) this.keeperReviews.delete(id);
    }
    return {
      transactionBase64: Buffer.from(transaction.serialize()).toString(
        "base64",
      ),
      messageBase64: Buffer.from(message.serialize()).toString("base64"),
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      feeLamportsRaw: String(estimatedFee),
      cluster: this.options.cluster,
      summary: { ...summary, feePayer: payer, unitsConsumed },
    };
  }
  async prepareOwnerAction(
    owner: string,
    action: ActionKind,
    payload: Record<string, unknown>,
    feeWallet?: string,
  ): Promise<PreparedTransaction> {
    if (action === "fee-funding") {
      await this.requireFunding(owner);
      if (!feeWallet)
        throw Error("The isolated prepaid fee wallet is unavailable");
      const amount = rawInteger(payload.amountRaw);
      const balance = BigInt(await this.feeWalletBalance(feeWallet));
      if (balance + amount > BigInt(BETA_LIMITS.feeBalanceLamports))
        throw Error("Prepaid fee balance exceeds the beta cap");
      return this.build(
        [
          SystemProgram.transfer({
            fromPubkey: key(owner),
            toPubkey: key(feeWallet),
            lamports: amount,
          }),
        ],
        owner,
        {
          action,
          owner,
          feePayer: owner,
          amountRaw: amount.toString(),
          recipient: feeWallet,
          token: "SOL",
        },
      );
    }
    if (
      ![
        "initialize",
        "configure",
        "deposit",
        "pause",
        "revoke",
        "withdraw",
        "recover",
      ].includes(action)
    )
      throw Error("Unsupported owner action");
    if (["initialize", "configure", "deposit"].includes(action))
      await this.requireFunding(owner);
    const current = await this.vault(owner);
    const policy = policyFrom(payload);
    const assetMint = current?.state.assetMint ?? policy?.assetMint;
    if (!assetMint || !marketByMint(assetMint))
      throw Error("Select a supported strategy asset");
    if (action !== "initialize" && !current)
      throw Error("Create the owner vault before this action");
    if (action === "initialize" && current)
      throw Error("A vault already exists for this owner");
    const a = deriveProgramAddresses(this.program(), owner, assetMint);
    let keeper = feeWallet ?? current?.state.keeper;
    let enabled = false;
    if (action === "configure") {
      if (!policy || policy.assetMint !== assetMint)
        throw Error("Changing assets requires an empty closed vault");
      enabled = payload.enable === true;
      if (enabled && !keeper)
        throw Error("A verified keeper fee wallet is required");
      const cfgInfo = await this.connection.getAccountInfo(key(a.config));
      if (!cfgInfo) throw Error("Program configuration unavailable");
      const cfg = decodeServiceConfig(cfgInfo, this.program());
      if (cfg.paused && enabled) throw Error("The guarded program is paused");
    }
    if (
      action === "deposit" &&
      current &&
      BigInt(current.state.principalUsdcRaw) + rawInteger(payload.amountRaw) >
        BigInt(BETA_LIMITS.depositUsdcRaw)
    )
      throw Error("Deposited principal exceeds the 100 USDC cap");
    if (
      action === "withdraw" &&
      current &&
      rawInteger(payload.amountRaw) > BigInt(current.balance)
    )
      throw Error("Withdrawal exceeds the current USDC vault balance");
    const instruction = buildOwnerInstruction({
      programId: this.program(),
      owner,
      action: action as OwnerAction,
      assetMint,
      amountRaw:
        typeof payload.amountRaw === "string" ? payload.amountRaw : undefined,
      cycleAmountRaw: policy?.cycleAmountRaw ?? current?.state.cycleAmountRaw,
      minProfitRaw: policy?.minProfitRaw ?? current?.state.minProfitRaw,
      keeper,
      expiresAt: policy ? Math.floor(Date.parse(policy.expiresAt) / 1000) : 0,
      enabled,
      buyPoolFirst: policy
        ? policy.poolBuy === marketByMint(assetMint)!.pools[0]
        : current?.state.buyPoolFirst,
    });
    const token = ["deposit", "withdraw"].includes(action)
      ? "USDC"
      : marketByMint(assetMint)!.symbol;
    const instructions: TransactionInstruction[] = [];
    if (action === "withdraw")
      instructions.push(ownerAtaCreation(owner, USDC.mint));
    if (action === "recover")
      instructions.push(
        ownerAtaCreation(
          owner,
          assetMint,
          marketByMint(assetMint)!.tokenProgram,
        ),
      );
    instructions.push(instruction);
    return this.build(instructions, owner, {
      action,
      owner,
      feePayer: owner,
      amountRaw:
        typeof payload.amountRaw === "string" ? payload.amountRaw : undefined,
      recipient: action === "withdraw" ? a.ownerUsdc : a.vault,
      token,
      assetMint,
      keeper,
      enabled,
      policy,
    });
  }
  async verifySignedOwnerTransaction(
    prepared: PreparedTransaction,
    signedBase64: string,
  ) {
    const raw = Buffer.from(signedBase64, "base64");
    if (raw.length > 1232) throw Error("Signed transaction is too large");
    const tx = VersionedTransaction.deserialize(raw);
    if (
      !Buffer.from(tx.message.serialize()).equals(
        Buffer.from(prepared.messageBase64, "base64"),
      )
    )
      throw Error("Signed transaction differs from the prepared owner action");
    const required = tx.message.header.numRequiredSignatures;
    if (
      required !== 1 ||
      tx.message.staticAccountKeys[0].toBase58() !== prepared.summary.owner ||
      prepared.summary.feePayer !== prepared.summary.owner
    )
      throw Error("Unexpected owner transaction signers");
    if (
      !verifySignature(
        tx.signatures[0],
        tx.message.serialize(),
        tx.message.staticAccountKeys[0],
      )
    )
      throw Error("Owner signature is invalid");
    return {
      signature: bs58.encode(tx.signatures[0]),
      wireBase64: raw.toString("base64"),
    };
  }
  async broadcastSignedTransaction(wireBase64: string) {
    const raw = Buffer.from(wireBase64, "base64");
    const tx = VersionedTransaction.deserialize(raw);
    const expected = bs58.encode(tx.signatures[0]);
    const signature = await this.connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 0,
      preflightCommitment: "confirmed",
    });
    if (signature !== expected)
      throw Error("RPC signature differs from the persisted transaction");
    return signature;
  }
  async inspectOwnerAction(
    owner: string,
    signature: string,
    expected: {
      action: "pause" | "revoke" | "withdraw" | "recover";
      amountRaw?: string;
    },
  ) {
    if (bs58.decode(signature).length !== 64)
      throw Error("Invalid transaction signature");
    const statuses = await this.connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    if (
      !statuses.value[0] ||
      statuses.value[0].confirmationStatus === "processed"
    )
      return null;
    const receipt = await this.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!receipt?.meta) return null;
    const message = receipt.transaction.message;
    const transaction = new VersionedTransaction(message);
    transaction.signatures = receipt.transaction.signatures.map((s) =>
      bs58.decode(s),
    );
    if (
      receipt.transaction.signatures[0] !== signature ||
      message.header.numRequiredSignatures !== 1 ||
      message.staticAccountKeys[0].toBase58() !== owner ||
      !verifySignature(
        transaction.signatures[0],
        message.serialize(),
        key(owner),
      )
    )
      throw Error("External transaction is not signed solely by this owner");
    const current = await this.vault(owner);
    if (!current)
      throw Error("Owner vault state is unavailable for receipt verification");
    const s = current.state;
    const policy: Strategy["policy"] = {
      assetMint: s.assetMint,
      poolBuy: s.buyPoolFirst ? s.poolA : s.poolB,
      poolSell: s.buyPoolFirst ? s.poolB : s.poolA,
      cycleAmountRaw: s.cycleAmountRaw,
      minProfitRaw: s.minProfitRaw,
      expiresAt: new Date(s.expiresAt * 1000).toISOString(),
      dailyFeeLimitLamports: BETA_LIMITS.dailyFeeLamports,
      maxFeePerAttemptLamports: BETA_LIMITS.attemptFeeLamports,
      maxCyclesPerDay: 10,
      cooldownSeconds: 60,
      slippageBps: 50,
    };
    const wireBase64 = Buffer.from(transaction.serialize()).toString("base64");
    validateOwnerTransaction(transaction.serialize(), {
      action: expected.action,
      owner,
      programId: this.program(),
      amountRaw: expected.amountRaw,
      policy,
    });
    const payload = { amountRaw: expected.amountRaw };
    const prepared: PreparedTransaction = {
      transactionBase64: wireBase64,
      messageBase64: Buffer.from(message.serialize()).toString("base64"),
      blockhash: message.recentBlockhash,
      lastValidBlockHeight: Number.MAX_SAFE_INTEGER,
      expiresAt: new Date().toISOString(),
      feeLamportsRaw: safeLamports(receipt.meta.fee).toString(),
      cluster: this.options.cluster,
      summary: {
        action: expected.action,
        owner,
        feePayer: owner,
        amountRaw: expected.amountRaw,
        token:
          expected.action === "withdraw"
            ? "USDC"
            : expected.action === "recover"
              ? marketByMint(s.assetMint)!.symbol
              : "Permission",
        recipient: owner,
      },
    };
    const reconciliation = await this.reconcile({
      signature,
      feePayer: owner,
      owner,
      strategyId: "external-owner-action",
      kind: expected.action,
      payload,
      prepared,
      lastValidBlockHeight: Number.MAX_SAFE_INTEGER,
      feeWallet: null,
    });
    return {
      kind: expected.action,
      prepared,
      reconciliation,
      payload,
      wireBase64,
    };
  }
  async reconcile(
    intent: Pick<
      IntentRecord,
      | "signature"
      | "lastValidBlockHeight"
      | "feePayer"
      | "prepared"
      | "owner"
      | "strategyId"
      | "payload"
      | "kind"
      | "feeWallet"
    >,
  ): Promise<Reconciliation> {
    if (!intent.signature) return { status: "pending", feeLamportsRaw: "0" };
    const statuses = await this.connection.getSignatureStatuses(
      [intent.signature],
      { searchTransactionHistory: true },
    );
    const status = statuses.value[0];
    if (!status || status.confirmationStatus === "processed") {
      const height = await this.connection.getBlockHeight("finalized");
      return {
        status:
          !status && height > intent.lastValidBlockHeight
            ? "expired"
            : "pending",
        feeLamportsRaw: "0",
      };
    }
    const transaction = await this.connection.getTransaction(intent.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!transaction?.meta) return { status: "pending", feeLamportsRaw: "0" };
    const message = transaction.transaction.message;
    const accounts = message.getAccountKeys({
      accountKeysFromLookups: transaction.meta.loadedAddresses,
    });
    if (
      transaction.transaction.signatures[0] !== intent.signature ||
      !Buffer.from(message.serialize()).equals(
        Buffer.from(intent.prepared.messageBase64, "base64"),
      )
    )
      throw Error("Chain receipt differs from the persisted signed intent");
    if (accounts.get(0)?.toBase58() !== intent.feePayer)
      throw Error("Receipt fee payer differs from the prepared intent");
    if (transaction.meta.preBalances.length !== accounts.length)
      throw Error("Chain receipt account-balance proof is incomplete");
    const fee = networkFeeFromReceipt(transaction.meta, this.options.cluster);
    if (transaction.meta.err)
      return {
        status: "failed",
        feeLamportsRaw: fee,
        slot: transaction.slot,
        confirmedAt: new Date(
          (transaction.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
        ).toISOString(),
        error: JSON.stringify(transaction.meta.err),
      };
    const tokenDelta = (address: string) => {
      const index = Array.from({ length: accounts.length }, (_, i) =>
        accounts.get(i)?.toBase58(),
      ).indexOf(address);
      if (index < 0) return 0n;
      const before =
        transaction.meta!.preTokenBalances?.find(
          (b) => b.accountIndex === index && b.mint === USDC.mint,
        )?.uiTokenAmount.amount ?? "0";
      const after =
        transaction.meta!.postTokenBalances?.find(
          (b) => b.accountIndex === index && b.mint === USDC.mint,
        )?.uiTokenAmount.amount ?? "0";
      return BigInt(after) - BigInt(before);
    };
    let usdcDelta = 0n;
    let chainStrategy: Partial<Strategy> | undefined;
    if (this.options.programId && intent.strategyId) {
      const a = deriveProgramAddresses(this.program(), intent.owner);
      usdcDelta = tokenDelta(a.vaultUsdc);
      const current = await this.vault(intent.owner);
      if (current) {
        const s = current.state;
        chainStrategy = {
          vaultAddress: a.vault,
          keeperAddress: s.keeper,
          balanceUsdcRaw: current.balance,
          depositedPrincipalRaw: s.principalUsdcRaw,
          nonce: s.nonce,
          confirmedCyclesToday:
            s.executionDay === Math.floor(Date.now() / 86400000)
              ? s.dailyCycles
              : 0,
          status: s.paused
            ? "paused"
            : s.expiresAt * 1000 <= Date.now()
              ? "expired"
              : "active",
          pauseReason: s.paused ? "Paused on Solana" : null,
          chainSlot: current.slot,
          policy: {
            ...((intent.payload.policy as Strategy["policy"]) ?? {}),
            assetMint: s.assetMint,
            poolBuy: s.buyPoolFirst ? s.poolA : s.poolB,
            poolSell: s.buyPoolFirst ? s.poolB : s.poolA,
            cycleAmountRaw: s.cycleAmountRaw,
            minProfitRaw: s.minProfitRaw,
            ...(s.expiresAt > 0
              ? { expiresAt: new Date(s.expiresAt * 1000).toISOString() }
              : {}),
          } as Strategy["policy"],
        };
      }
    }
    const result: Reconciliation = {
      status: "confirmed",
      feeLamportsRaw: fee,
      slot: transaction.slot,
      confirmedAt: new Date(
        (transaction.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
      ).toISOString(),
      usdcDeltaRaw: usdcDelta.toString(),
      chainStrategy,
    };
    if (intent.kind === "execute" && this.options.programId) {
      const metadata = extractCycleMetadata(
        transaction.meta.logMessages ?? [],
        this.program(),
        intent.owner,
      );
      if (!metadata)
        throw Error(
          "Guarded cycle metadata is unavailable; receipt verification remains pending",
        );
      if (metadata) {
        if (
          BigInt(metadata.returnedUsdcRaw) -
            BigInt(metadata.startingUsdcRaw) !==
            usdcDelta ||
          BigInt(metadata.profitRaw) !== usdcDelta ||
          (typeof intent.prepared.summary.assetMint === "string" &&
            metadata.assetMint !== intent.prepared.summary.assetMint) ||
          (typeof intent.prepared.summary.poolBuy === "string" &&
            metadata.poolBuy !== intent.prepared.summary.poolBuy) ||
          (typeof intent.prepared.summary.poolSell === "string" &&
            metadata.poolSell !== intent.prepared.summary.poolSell) ||
          (typeof intent.payload.nonce === "string" &&
            metadata.nonce !== intent.payload.nonce)
        )
          throw Error(
            "Guarded cycle event differs from chain balance accounting",
          );
        result.mintFingerprint = metadata.mintFingerprint;
        result.assetReceivedRaw = metadata.assetReceivedRaw;
      }
    }
    if (intent.kind === "fee-funding" && intent.feeWallet) {
      const recipient = Array.from({ length: accounts.length }, (_, i) =>
        accounts.get(i)?.toBase58(),
      ).indexOf(intent.feeWallet);
      const amount = rawInteger(intent.payload.amountRaw);
      if (
        recipient < 0 ||
        safeLamports(transaction.meta.postBalances[recipient]) -
          safeLamports(transaction.meta.preBalances[recipient]) !==
          amount
      )
        throw Error("Fee funding receipt does not match the expected transfer");
      result.feeFundingRaw = amount.toString();
    }
    if (intent.kind === "fee-refund") {
      const recipient = Array.from({ length: accounts.length }, (_, i) =>
        accounts.get(i)?.toBase58(),
      ).indexOf(intent.owner);
      const amount = rawInteger(intent.prepared.summary.amountRaw);
      if (
        recipient < 0 ||
        safeLamports(transaction.meta.postBalances[recipient]) -
          safeLamports(transaction.meta.preBalances[recipient]) !==
          amount
      )
        throw Error("Refund receipt does not match the owner transfer");
      result.refundRaw = amount.toString();
    }
    return result;
  }
  async executionPreview(strategy: Strategy): Promise<ExecutionPreview> {
    const checkedAt = new Date().toISOString();
    const preview: ExecutionPreview = {
      id: randomUUID(),
      strategyId: strategy.id,
      assetMint: strategy.policy.assetMint,
      poolBuy: strategy.policy.poolBuy,
      poolSell: strategy.policy.poolSell,
      startingUsdcRaw: strategy.policy.cycleAmountRaw,
      estimatedTokenOutRaw: null,
      estimatedReturnedUsdcRaw: null,
      estimatedProfitUsdcRaw: null,
      minimumProfitUsdcRaw: strategy.policy.minProfitRaw,
      estimatedFeeLamports: null,
      estimatedFeeUsdcRaw: null,
      simulation: null,
      slot: 0,
      checkedAt,
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
      status: "blocked",
      reasons: [],
      multiplier: "1",
    };
    try {
      const quote = await this.markets.quoteCycle(strategy.policy);
      Object.assign(preview, {
        estimatedTokenOutRaw: quote.tokenOutRaw,
        estimatedReturnedUsdcRaw: quote.returnedRaw,
        estimatedProfitUsdcRaw: quote.profitRaw,
        slot: quote.slot,
        multiplier: quote.multiplier,
        multiplierEffectiveAt: quote.multiplierEffectiveAt,
      });
      if (BigInt(quote.profitRaw) < BigInt(strategy.policy.minProfitRaw)) {
        preview.status = "not-profitable";
        preview.reasons = [
          "The exact-pool cycle does not meet the minimum USDC profit",
        ];
        return preview;
      }
      await this.requireFunding(strategy.owner);
      const current = await this.refreshStrategy(strategy);
      if (current.status !== "active" || !current.keeperAddress)
        throw Error(
          "Fund and authorize the owner strategy before full execution simulation",
        );
      if (
        BigInt(current.balanceUsdcRaw) < BigInt(current.policy.cycleAmountRaw)
      )
        throw Error("The strategy has insufficient USDC capital");
      const prepared = await this.buildExecution(current, quote);
      const fee = BigInt(prepared.feeLamportsRaw);
      if (fee > BigInt(strategy.policy.maxFeePerAttemptLamports))
        throw Error("Estimated network fee exceeds the owner limit");
      const sol = (await this.markets.snapshot()).find(
        (m) => m.symbol === "SOL",
      );
      const solPrice = sol?.pools.find((p) => p.priceUsd !== null)?.priceUsd;
      if (!solPrice || sol?.status !== "available")
        throw Error("A fresh SOL/USDC cost estimate is required");
      // Conversion is only a conservative cost gate; the on-chain profit guard remains raw USDC.
      const feeUsdc = BigInt(Math.ceil((Number(fee) * solPrice) / 1000));
      const required =
        BigInt(current.policy.minProfitRaw) + (feeUsdc * 125n + 99n) / 100n;
      preview.estimatedFeeLamports = fee.toString();
      preview.estimatedFeeUsdcRaw = feeUsdc.toString();
      preview.simulation = {
        success: true,
        unitsConsumed:
          typeof prepared.summary.unitsConsumed === "number"
            ? prepared.summary.unitsConsumed
            : null,
        error: null,
      };
      if (BigInt(quote.profitRaw) < required) {
        preview.status = "not-profitable";
        preview.reasons = [
          "Quoted return does not cover the profit floor and buffered network costs",
        ];
        return preview;
      }
      if (Date.now() - Date.parse(preview.checkedAt) >= 10_000)
        throw Error(
          "Pool observation expired during simulation; request a fresh preview",
        );
      preview.status = "ready";
      this.previews.set(preview.id, {
        quote,
        prepared,
        nonce: current.nonce,
        expiresAt: Date.parse(preview.expiresAt),
      });
      for (const [id, p] of this.previews)
        if (p.expiresAt < Date.now()) this.previews.delete(id);
      return preview;
    } catch (error) {
      preview.reasons = [errorText(error)];
      return preview;
    }
  }
  private async buildExecution(
    strategy: Strategy,
    quote: CycleQuote,
  ): Promise<PreparedTransaction> {
    const pool = (p: CycleQuote["buy"], ticks: PublicKey[]) => ({
      pool: p.id.toBase58(),
      config: p.state.configId.toBase58(),
      usdcVault: (p.state.mintA.toBase58() === USDC.mint
        ? p.state.vaultA
        : p.state.vaultB
      ).toBase58(),
      assetVault: (p.state.mintA.toBase58() === USDC.mint
        ? p.state.vaultB
        : p.state.vaultA
      ).toBase58(),
      observation: p.state.observationId.toBase58(),
      tickAccounts: [
        ...new Set([
          ...(p.bitmapExists ? [deriveProgramBitmap(p.id.toBase58())] : []),
          ...ticks.map((t) => t.toBase58()),
        ]),
      ],
    });
    const market = marketByMint(strategy.policy.assetMint)!;
    const first = quote.buy.id.toBase58() === market.pools[0];
    const instruction = buildExecuteInstruction({
      programId: this.program(),
      owner: strategy.owner,
      keeper: strategy.keeperAddress,
      assetMint: market.mint,
      nonce: strategy.nonce,
      deadlineSlot: (quote.slot + 20).toString(),
      buyMinimumOutRaw: quote.buyMinOutRaw,
      sellMinimumOutRaw: (
        BigInt(quote.inputRaw) + BigInt(strategy.policy.minProfitRaw)
      ).toString(),
      poolA: pool(
        first ? quote.buy : quote.sell,
        first ? quote.buyTicks : quote.sellTicks,
      ),
      poolB: pool(
        first ? quote.sell : quote.buy,
        first ? quote.sellTicks : quote.buyTicks,
      ),
      buyPoolFirst: first,
    });
    return this.build([instruction], strategy.keeperAddress, {
      action: "execute",
      owner: strategy.owner,
      feePayer: strategy.keeperAddress,
      amountRaw: quote.inputRaw,
      recipient: deriveProgramAddresses(this.program(), strategy.owner).vault,
      token: "USDC",
      assetMint: market.mint,
      poolBuy: strategy.policy.poolBuy,
      poolSell: strategy.policy.poolSell,
      multiplier: quote.multiplier,
      multiplierEffectiveAt: quote.multiplierEffectiveAt,
    });
  }
  async prepareExecution(
    strategy: Strategy,
    preview: ExecutionPreview,
    feePayer: string,
  ) {
    await this.requireFunding(strategy.owner);
    const cached = this.previews.get(preview.id);
    if (!cached || cached.expiresAt < Date.now())
      throw Error("Execution preview expired; request a fresh simulation");
    const current = await this.refreshStrategy(strategy);
    if (
      current.status !== "active" ||
      current.nonce !== cached.nonce ||
      current.keeperAddress !== feePayer
    )
      throw Error("Strategy permissions changed after simulation");
    // Re-read both pools and simulate again directly before submission. Never sign cached pool state.
    const fresh = await this.markets.quoteCycle(current.policy);
    const prepared = await this.buildExecution(current, fresh);
    const fee = BigInt(prepared.feeLamportsRaw);
    if (fee > BigInt(current.policy.maxFeePerAttemptLamports))
      throw Error("The network fee moved above the owner limit");
    const sol = (await this.markets.snapshot()).find((m) => m.symbol === "SOL");
    const price = sol?.pools.find((p) => p.priceUsd !== null)?.priceUsd;
    if (!price || sol?.status !== "available")
      throw Error("A fresh SOL/USDC cost estimate is required");
    const cost = BigInt(Math.ceil((Number(fee) * price) / 1000));
    if (
      BigInt(fresh.profitRaw) <
      BigInt(current.policy.minProfitRaw) + (cost * 125n + 99n) / 100n
    )
      throw Error(
        "The opportunity moved below the profit floor and buffered fee cost",
      );
    return prepared;
  }
  async signKeeperTransaction(
    prepared: PreparedTransaction,
    feeSecret: Uint8Array,
    expectedOwner: string,
  ) {
    if (prepared.summary.owner !== expectedOwner)
      throw Error("The fee wallet owner differs from the reviewed intent");
    const signer = Keypair.fromSecretKey(feeSecret);
    if (signer.publicKey.toBase58() !== prepared.summary.feePayer)
      throw Error("The prepaid fee signer does not match the intent");
    const tx = VersionedTransaction.deserialize(
      Buffer.from(prepared.transactionBase64, "base64"),
    );
    if (
      !Buffer.from(tx.message.serialize()).equals(
        Buffer.from(prepared.messageBase64, "base64"),
      ) ||
      tx.message.header.numRequiredSignatures !== 1
    )
      throw Error("Invalid prepared keeper transaction");
    const review = this.keeperReviews.get(bytesHash(tx.message.serialize()));
    if (
      !review ||
      review.expiresAt < Date.now() ||
      review.owner !== expectedOwner ||
      review.action !== prepared.summary.action
    )
      throw Error(
        "The keeper transaction has no fresh independent message review; prepare and simulate again",
      );
    let tables: AddressLookupTableAccount[] = [];
    if (tx.message.version === 0 && tx.message.addressTableLookups.length) {
      if (
        !this.options.lookupTable ||
        tx.message.addressTableLookups.some(
          (t) => t.accountKey.toBase58() !== this.options.lookupTable,
        )
      )
        throw Error("Unexpected execution lookup table");
      const table = await this.connection.getAddressLookupTable(
        key(this.options.lookupTable),
      );
      if (!table.value) throw Error("Execution lookup table unavailable");
      tables = [table.value];
    }
    const decoded = TransactionMessage.decompile(tx.message, {
      addressLookupTableAccounts: tables,
    });
    const reconstructed = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: decoded.recentBlockhash,
      instructions: review.instructions,
    }).compileToV0Message(tables);
    if (
      !Buffer.from(reconstructed.serialize()).equals(
        Buffer.from(tx.message.serialize()),
      )
    )
      throw Error(
        "Keeper instruction accounts differ from the independently reviewed message",
      );
    if (prepared.summary.action === "fee-refund") {
      const actual = decoded.instructions.at(-1)!;
      const canonical = SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: key(expectedOwner),
        lamports: rawInteger(prepared.summary.amountRaw),
      });
      if (
        !actual.programId.equals(canonical.programId) ||
        !actual.data.equals(canonical.data) ||
        actual.keys.some((a, i) => !a.pubkey.equals(canonical.keys[i]?.pubkey))
      )
        throw Error("Refund differs from the verified owner transfer");
    }
    const balance = BigInt(
      await this.feeWalletBalance(signer.publicKey.toBase58()),
    );
    const transfer =
      prepared.summary.action === "fee-refund"
        ? BigInt(prepared.summary.amountRaw ?? "0")
        : 0n;
    if (balance < transfer + BigInt(prepared.feeLamportsRaw))
      throw Error("The prepaid SOL allowance cannot cover this transaction");
    if (
      BigInt(prepared.feeLamportsRaw) > BigInt(BETA_LIMITS.attemptFeeLamports)
    )
      throw Error("Keeper fee exceeds the beta cap");
    tx.sign([signer]);
    return {
      signature: bs58.encode(tx.signatures[0]),
      wireBase64: Buffer.from(tx.serialize()).toString("base64"),
    };
  }
  async prepareRefund(owner: string, feeWallet: string, amountRaw: string) {
    const amount = rawInteger(amountRaw);
    return this.build(
      [
        SystemProgram.transfer({
          fromPubkey: key(feeWallet),
          toPubkey: key(owner),
          lamports: amount,
        }),
      ],
      feeWallet,
      {
        action: "fee-refund",
        owner,
        feePayer: feeWallet,
        amountRaw,
        recipient: owner,
        token: "SOL",
      },
      false,
    );
  }
  async feeWalletBalance(address: string) {
    return safeLamports(
      await this.connection.getBalance(key(address), "confirmed"),
    ).toString();
  }
}
function deriveProgramBitmap(pool: string) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_tick_array_bitmap_extension"), key(pool).toBuffer()],
    key("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"),
  )[0].toBase58();
}
