import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import {
  Connection,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  type AccountInfo,
} from "@solana/web3.js";
import {
  unpackMint,
  getExtensionTypes,
  ExtensionType,
  getScaledUiAmountConfig,
  getTransferHook,
  getPausableConfig,
  getDefaultAccountState,
  getPermanentDelegate,
} from "@solana/spl-token";
import {
  PoolInfoLayout,
  ClmmConfigLayout,
  ObservationLayout,
  TickArrayLayout,
  TickArrayBitmapExtensionLayout,
  TickArrayBitmapUtil,
  TickArrayUtil,
  TickUtil,
  getPdaExBitmapAccount,
  getPdaTickArrayAddress,
  getPdaPoolVaultId,
  swapInternal,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import {
  MARKETS,
  USDC,
  BETA_LIMITS,
  RAYDIUM_CLMM_PROGRAM,
  TOKEN_2022_PROGRAM,
  type MarketDefinition,
} from "../shared/registry.ts";
import { rawInteger } from "../shared/amounts.ts";
import type {
  MarketSnapshot,
  PoolSnapshot,
  StrategyPolicy,
} from "../shared/types.ts";
import type { MarketGateway } from "./ports.ts";

const PROGRAM = new PublicKey(RAYDIUM_CLMM_PROGRAM);
type PoolState = ReturnType<typeof PoolInfoLayout.decode>;
type ConfigState = ReturnType<typeof ClmmConfigLayout.decode>;
type BitmapState = ReturnType<typeof TickArrayBitmapExtensionLayout.decode>;
type TickState = ReturnType<typeof TickArrayLayout.decode>;
const disc = (name: string) =>
  createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
function validateData(
  info: AccountInfo<Buffer> | null,
  name: string,
  span: number,
) {
  if (
    !info ||
    !info.owner.equals(PROGRAM) ||
    info.data.length !== span ||
    !info.data.subarray(0, 8).equals(disc(name))
  )
    throw Error(`Invalid ${name} owner, length, or discriminator`);
  return info.data;
}
function publicError(error: unknown) {
  return error instanceof Error
    ? error.message.slice(0, 180)
    : "Pool source unavailable";
}
export interface LoadedPool {
  id: PublicKey;
  state: PoolState;
  config: ConfigState;
  bitmap: BitmapState;
  bitmapExists: boolean;
  ticks: { address: PublicKey; value: TickState }[];
  slot: number;
  clock: number;
  market: MarketDefinition;
  multiplier: string;
  multiplierEffectiveAt: string | null;
}
export interface CycleQuote {
  buy: LoadedPool;
  sell: LoadedPool;
  inputRaw: string;
  tokenOutRaw: string;
  returnedRaw: string;
  profitRaw: string;
  buyMinOutRaw: string;
  sellMinOutRaw: string;
  buyTicks: PublicKey[];
  sellTicks: PublicKey[];
  slot: number;
  multiplier: string;
  multiplierEffectiveAt: string | null;
}
export interface MintSafety {
  multiplier: string;
  effectiveAt: string | null;
  warnings: string[];
  reason: string | null;
}
export function mintSafety(
  market: MarketDefinition,
  info: AccountInfo<Buffer> | null,
  clock: number,
): MintSafety {
  if (!info || info.owner.toBase58() !== market.tokenProgram)
    throw Error("Mint has an unexpected token program");
  const mint = unpackMint(
    new PublicKey(market.mint),
    info,
    new PublicKey(market.tokenProgram),
  );
  if (!mint.isInitialized || mint.decimals !== market.decimals)
    throw Error("Mint initialization or decimals changed");
  const warnings: string[] = [];
  let reason: string | null = null;
  let multiplier = "1",
    effectiveAt: string | null = null;
  if (market.category === "xstock") {
    if (mint.freezeAuthority)
      warnings.push("The issuer can freeze token accounts.");
    if (getPermanentDelegate(mint))
      warnings.push("The issuer has permanent-delegate authority.");
  }
  if (market.tokenProgram === TOKEN_2022_PROGRAM) {
    const allowed = new Set([
      ExtensionType.Uninitialized,
      ExtensionType.ConfidentialTransferMint,
      ExtensionType.DefaultAccountState,
      ExtensionType.PermanentDelegate,
      ExtensionType.TransferHook,
      ExtensionType.MetadataPointer,
      ExtensionType.TokenMetadata,
      ExtensionType.GroupMemberPointer,
      ExtensionType.TokenGroupMember,
      ExtensionType.ScaledUiAmountConfig,
      ExtensionType.PausableConfig,
    ]);
    for (const extension of getExtensionTypes(mint.tlvData))
      if (!allowed.has(extension))
        reason = `Unsupported token extension: ${ExtensionType[extension] ?? extension}`;
    const hook = getTransferHook(mint);
    if (hook && !hook.programId.equals(PublicKey.default))
      reason = "The issuer activated a transfer hook.";
    if (getPausableConfig(mint)?.paused)
      reason = "The issuer paused this mint.";
    const defaultState = getDefaultAccountState(mint);
    if (defaultState && defaultState.state !== 1)
      reason = "New token accounts are not initialized for public transfers.";
    const scale = getScaledUiAmountConfig(mint);
    if (scale) {
      const at = Number(scale.newMultiplierEffectiveTimestamp);
      const value = clock >= at ? scale.newMultiplier : scale.multiplier;
      if (!Number.isFinite(value) || value <= 0)
        reason = "The active token multiplier is invalid.";
      else multiplier = value.toString();
      if (Number.isSafeInteger(at) && at > 0) {
        effectiveAt = new Date(at * 1000).toISOString();
        if (
          scale.newMultiplier !== scale.multiplier &&
          Math.abs(clock - at) <= 900
        )
          reason =
            "Trading pauses for 15 minutes around an issuer multiplier adjustment.";
      }
    } else if (market.category === "xstock")
      reason = "Expected xStock scaled-amount configuration is missing.";
  }
  return { multiplier, effectiveAt, warnings, reason };
}
export class RpcBudget {
  private requests: number[] = [];
  private total = 0;
  private stoppedUntil = 0;
  private month = new Date().toISOString().slice(0, 7);
  constructor(
    private maxCredits = 900_000,
    private filename?: string,
  ) {
    if (filename) {
      mkdirSync(path.dirname(filename), { recursive: true });
      if (existsSync(filename)) {
        const state = JSON.parse(readFileSync(filename, "utf8"));
        if (
          typeof state.month !== "string" ||
          !Number.isSafeInteger(state.credits) ||
          state.credits < 0
        )
          throw Error("Invalid durable RPC budget");
        if (state.month === this.month) this.total = state.credits;
      }
      this.persist();
    }
  }
  private persist() {
    if (this.filename) {
      const temp = this.filename + ".tmp";
      writeFileSync(
        temp,
        JSON.stringify({ month: this.month, credits: this.total }),
        { mode: 0o600 },
      );
      for (let attempt = 0; ; attempt++) {
        try {
          renameSync(temp, this.filename);
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            process.platform !== "win32" ||
            !["EPERM", "EACCES"].includes(code ?? "") ||
            attempt >= 5
          )
            throw error;
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            20 * (attempt + 1),
          );
        }
      }
    }
  }
  async consume(weight = 1, critical = false) {
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > 100)
      throw Error("Invalid RPC credit weight");
    for (;;) {
      const now = Date.now(),
        month = new Date(now).toISOString().slice(0, 7);
      if (month !== this.month) {
        this.month = month;
        this.total = 0;
      }
      this.requests = this.requests.filter((at) => now - at < 1000);
      const cap =
        critical || this.maxCredits < 1000
          ? this.maxCredits
          : Math.floor(this.maxCredits * 0.875);
      if (now < this.stoppedUntil || this.total + weight > cap)
        throw Error(
          critical
            ? "RPC request budget exhausted; execution paused"
            : "RPC scanning budget exhausted; critical reconciliation reserve retained",
        );
      if (this.requests.length < 8) {
        this.requests.push(now);
        this.total += weight;
        this.persist();
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, 1001 - (now - this.requests[0]))),
      );
    }
  }
  backoff() {
    this.stoppedUntil = Date.now() + 30_000;
  }
}
export function budgetConnection(endpoint: string, budget = new RpcBudget()) {
  return new Connection(endpoint, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: budgetedFetch(budget),
  });
}
function budgetedFetch(budget: RpcBudget): typeof fetch {
  return async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const entries = Array.isArray(body) ? body : [body];
    const weight = entries.reduce(
      (sum, item) =>
        sum +
        ([
          "getTransaction",
          "getSignaturesForAddress",
          "getBlock",
          "getBlocks",
          "getBlocksWithLimit",
        ].includes(item?.method)
          ? 10
          : 1),
      0,
    );
    const critical = entries.every(
      (item) =>
        item?.method !== "getMultipleAccounts" ||
        (Array.isArray(item.params?.[0]) && item.params[0].length <= 2),
    );
    await budget.consume(weight, critical);
    const response = await fetch(input, {
      ...init,
      signal: AbortSignal.timeout(12_000),
      redirect: "error",
    });
    if (response.status === 429) {
      budget.backoff();
      throw Error("RPC provider rate limit reached");
    }
    return response;
  };
}
export class RaydiumMarkets implements MarketGateway {
  readonly connection: Connection;
  private snapshots: MarketSnapshot[] = [];
  private checked = 0;
  private pending: Promise<MarketSnapshot[]> | null = null;
  private metadata = new Map<string, { tvl: number }>();
  private metadataAt = 0;
  private depthChecked = new Map<string, { at: number; amountRaw: string }>();
  private configCache = new Map<string, ConfigState>();
  private configAt = 0;
  private rpcFetch: typeof fetch;
  constructor(
    private endpoint: string,
    connection?: Connection,
  ) {
    const file =
      process.env.RPC_USAGE_FILE ||
      (process.env.BACKUP_DIRECTORY
        ? path.join(process.env.BACKUP_DIRECTORY, ".rpc-usage.json")
        : undefined);
    const cap = Number(process.env.RPC_MONTHLY_CREDIT_CAP ?? 900_000);
    if (!Number.isSafeInteger(cap) || cap < 1000 || cap > 900_000)
      throw Error("RPC monthly credit cap must be 1000–900000");
    const budget = new RpcBudget(cap, file);
    this.rpcFetch = budgetedFetch(budget);
    this.connection = connection ?? budgetConnection(endpoint, budget);
  }
  async readRpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await this.rpcFetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw Error("Solana RPC unavailable");
    const body = (await response.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (body.error) throw Error(body.error.message ?? "Solana RPC failed");
    return body.result;
  }
  async snapshot(): Promise<MarketSnapshot[]> {
    if (Date.now() - this.checked < 5000 && this.snapshots.length)
      return this.snapshots;
    if (this.pending) return this.pending;
    this.pending = this.refresh().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async loadMetadata() {
    if (Date.now() - this.metadataAt < 300_000) return;
    try {
      const ids = MARKETS.flatMap((m) => m.pools).join(",");
      const response = await fetch(
        `https://api-v3.raydium.io/pools/info/ids?ids=${encodeURIComponent(ids)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) throw Error("Raydium metadata unavailable");
      const body = (await response.json()) as { data?: unknown[] };
      if (!Array.isArray(body.data)) throw Error("Invalid metadata");
      for (const entry of body.data) {
        const p = entry as { id?: unknown; tvl?: unknown };
        if (
          typeof p.id === "string" &&
          typeof p.tvl === "number" &&
          Number.isFinite(p.tvl) &&
          p.tvl >= 0 &&
          MARKETS.some((m) => m.pools.includes(p.id! as string))
        )
          this.metadata.set(p.id, { tvl: p.tvl });
      }
      this.metadataAt = Date.now();
    } catch {
      /* The RPC price can remain visible; stale/missing liquidity cannot authorize execution. */
    }
  }
  private async refresh(): Promise<MarketSnapshot[]> {
    const at = new Date().toISOString();
    try {
      await this.loadMetadata();
      const keys = [
        ...MARKETS.flatMap((m) => m.pools.map((p) => new PublicKey(p))),
        ...MARKETS.map((m) => new PublicKey(m.mint)),
        SYSVAR_CLOCK_PUBKEY,
      ];
      const response = await this.connection.getMultipleAccountsInfoAndContext(
        keys,
        { commitment: "confirmed" },
      );
      const clockInfo = response.value.at(-1);
      if (
        !clockInfo ||
        !clockInfo.owner.equals(
          new PublicKey("Sysvar1111111111111111111111111111111111111"),
        ) ||
        clockInfo.data.length !== 40
      )
        throw Error("Cluster clock unavailable");
      const clock = Number(clockInfo.data.readBigInt64LE(32));
      if (!Number.isSafeInteger(clock)) throw Error("Invalid cluster clock");
      const states = new Map<string, PoolState>();
      MARKETS.forEach((market, i) =>
        market.pools.forEach((id, j) => {
          try {
            states.set(
              id,
              PoolInfoLayout.decode(
                validateData(
                  response.value[i * 2 + j],
                  "PoolState",
                  PoolInfoLayout.span,
                ),
              ),
            );
          } catch {}
        }),
      );
      const configIds = [
        ...new Set([...states.values()].map((p) => p.configId.toBase58())),
      ];
      if (
        Date.now() - this.configAt >= 300_000 ||
        configIds.some((id) => !this.configCache.has(id))
      ) {
        const configs = await this.connection.getMultipleAccountsInfo(
          configIds.map((p) => new PublicKey(p)),
        );
        const cache = new Map<string, ConfigState>();
        configs.forEach((info, i) => {
          try {
            cache.set(
              configIds[i],
              ClmmConfigLayout.decode(
                validateData(info, "AmmConfig", ClmmConfigLayout.span),
              ),
            );
          } catch {}
        });
        this.configCache = cache;
        this.configAt = Date.now();
      }
      const configMap = this.configCache;
      this.snapshots = MARKETS.map((market, i) => {
        let safety: MintSafety;
        try {
          safety = mintSafety(
            market,
            response.value[MARKETS.length * 2 + i],
            clock,
          );
        } catch (e) {
          safety = {
            multiplier: "1",
            effectiveAt: null,
            warnings: [],
            reason: publicError(e),
          };
        }
        const pools: PoolSnapshot[] = market.pools.map((poolId) => {
          const state = states.get(poolId),
            config = state && configMap.get(state.configId.toBase58());
          let reason: string | undefined;
          if (!state || !config)
            reason = "Pool state or configuration is unavailable";
          else if (
            ![state.mintA.toBase58(), state.mintB.toBase58()].includes(
              market.mint,
            ) ||
            ![state.mintA.toBase58(), state.mintB.toBase58()].includes(
              USDC.mint,
            )
          )
            reason = "Pool mint pair mismatch";
          else if ((state.status & 16) !== 0)
            reason = "Pool swaps are disabled";
          else if (state.dynamicFeeInfo.dynamicFeeControl !== 0)
            reason = "Dynamic-fee pools are not approved for this beta";
          const tvl = this.metadata.get(poolId)?.tvl ?? null;
          let price: number | null = null;
          if (!reason && state) {
            const ratio = TickUtil.sqrtPriceX64ToPrice(
              state.sqrtPriceX64,
              state.mintDecimalsA,
              state.mintDecimalsB,
            ).toNumber();
            price =
              (state.mintA.toBase58() === market.mint ? ratio : 1 / ratio) /
              Number(safety.multiplier);
            if (!Number.isFinite(price) || price <= 0) {
              price = null;
              reason = "Invalid pool price";
            }
          }
          const depth = this.depthChecked.get(poolId),
            depthReady = !reason && Date.now() - (depth?.at ?? 0) < 10_000;
          return {
            poolId,
            programId: RAYDIUM_CLMM_PROGRAM,
            venue: "Raydium CLMM",
            priceUsd: price,
            liquidityUsd: tvl,
            feeBps: config ? config.tradeFeeRate / 100 : 0,
            mintA: state?.mintA.toBase58() ?? "",
            mintB: state?.mintB.toBase58() ?? "",
            slot: response.context.slot,
            checkedAt: at,
            depthReady,
            ...(depthReady ? { quotedDepthUsdcRaw: depth!.amountRaw } : {}),
            sourceUrl: `https://dexscreener.com/solana/${poolId}`,
            status: reason ? "unavailable" : "available",
            ...(reason ? { reason } : {}),
          };
        });
        const [a, b] = pools;
        const eligible =
          !safety.reason &&
          pools.every(
            (p) =>
              p.status === "available" &&
              p.liquidityUsd !== null &&
              p.liquidityUsd >= BETA_LIMITS.minPoolLiquidityUsd,
          ) &&
          Date.now() - this.metadataAt < 300_000;
        const reason =
          safety.reason ??
          (!eligible
            ? "Both approved pools need current liquidity above the beta threshold."
            : undefined);
        return {
          symbol: market.symbol,
          name: market.name,
          mint: market.mint,
          decimals: market.decimals,
          category: market.category,
          tokenProgram: market.tokenProgram,
          multiplier: safety.multiplier,
          multiplierEffectiveAt: safety.effectiveAt,
          issuerWarnings: safety.warnings,
          pools,
          observedGapPct:
            a.priceUsd && b.priceUsd
              ? (a.priceUsd / b.priceUsd - 1) * 100
              : null,
          checkedAt: at,
          slot: response.context.slot,
          status: safety.reason
            ? "blocked"
            : pools.every((p) => p.status === "available")
              ? "available"
              : "unavailable",
          ...(reason ? { reason } : {}),
          quoteEligible: eligible,
          executionEligible: eligible && pools.every((p) => p.depthReady),
        };
      });
      this.checked = Date.now();
      return this.snapshots;
    } catch (error) {
      const reason = publicError(error);
      this.snapshots = MARKETS.map((m) => {
        const prior = this.snapshots.find((p) => p.mint === m.mint);
        return prior
          ? {
              ...prior,
              status: "stale",
              quoteEligible: false,
              executionEligible: false,
              reason,
            }
          : {
              symbol: m.symbol,
              name: m.name,
              mint: m.mint,
              decimals: m.decimals,
              category: m.category,
              tokenProgram: m.tokenProgram,
              multiplier: "1",
              multiplierEffectiveAt: null,
              issuerWarnings: [],
              pools: [],
              observedGapPct: null,
              checkedAt: at,
              slot: 0,
              status: "unavailable",
              quoteEligible: false,
              executionEligible: false,
              reason,
            };
      });
      this.checked = Date.now();
      return this.snapshots;
    }
  }
  async loadExactPools(
    market: MarketDefinition,
    poolIds: readonly [string, string],
  ): Promise<[LoadedPool, LoadedPool]> {
    if (
      poolIds[0] === poolIds[1] ||
      poolIds.some((id) => !market.pools.includes(id))
    )
      throw Error("Only distinct approved pools can execute");
    const initial = await this.connection.getMultipleAccountsInfoAndContext([
      ...poolIds.map((id) => new PublicKey(id)),
      new PublicKey(market.mint),
      SYSVAR_CLOCK_PUBKEY,
    ]);
    const clockData = initial.value[3];
    if (!clockData || clockData.data.length !== 40)
      throw Error("Cluster clock unavailable");
    const clock = Number(clockData.data.readBigInt64LE(32));
    const safety = mintSafety(market, initial.value[2], clock);
    if (safety.reason) throw Error(safety.reason);
    const states = poolIds.map((id, i) => ({
      id: new PublicKey(id),
      state: PoolInfoLayout.decode(
        validateData(initial.value[i], "PoolState", PoolInfoLayout.span),
      ),
    }));
    const secondKeys = states.flatMap((p) => [
      p.state.configId,
      getPdaExBitmapAccount(PROGRAM, p.id).publicKey,
      p.state.observationId,
    ]);
    const second = await this.connection.getMultipleAccountsInfoAndContext(
      secondKeys,
      { minContextSlot: initial.context.slot },
    );
    const loaded = states.map((p, i) => {
      const s = p.state;
      if (
        ![s.mintA.toBase58(), s.mintB.toBase58()].includes(market.mint) ||
        ![s.mintA.toBase58(), s.mintB.toBase58()].includes(USDC.mint)
      )
        throw Error("Approved pool mint pair changed");
      if ((s.status & 16) !== 0 || s.dynamicFeeInfo.dynamicFeeControl !== 0)
        throw Error("Pool swap policy changed");
      if (
        !s.vaultA.equals(getPdaPoolVaultId(PROGRAM, p.id, s.mintA).publicKey) ||
        !s.vaultB.equals(getPdaPoolVaultId(PROGRAM, p.id, s.mintB).publicKey)
      )
        throw Error("Pool account relationships changed");
      const config = ClmmConfigLayout.decode(
        validateData(second.value[i * 3], "AmmConfig", ClmmConfigLayout.span),
      );
      if (
        !ObservationLayout.decode(
          validateData(
            second.value[i * 3 + 2],
            "ObservationState",
            ObservationLayout.span,
          ),
        ).poolId.equals(p.id)
      )
        throw Error("Observation pool association changed");
      const bitmapInfo = second.value[i * 3 + 1];
      const bitmap = bitmapInfo
        ? TickArrayBitmapExtensionLayout.decode(
            validateData(
              bitmapInfo,
              "TickArrayBitmapExtension",
              TickArrayBitmapExtensionLayout.span,
            ),
          )
        : ({
            poolId: p.id,
            positiveTickArrayBitmap: Buffer.alloc(896),
            negativeTickArrayBitmap: Buffer.alloc(896),
          } as BitmapState);
      if (!bitmap.poolId.equals(p.id))
        throw Error("Pool bitmap association changed");
      const indices = [
        ...new Set(
          (["zeroForOne", "oneForZero"] as const).flatMap((type) =>
            TickArrayBitmapUtil.findTickArrayStartIndex({
              tickSpacing: s.tickSpacing,
              poolBitmap: s.tickArrayBitmap,
              tickArrayBitmap: bitmap,
              findInfo: { type, count: 7, tickArrayCurrent: s.tickCurrent },
            }),
          ),
        ),
      ];
      return { ...p, config, bitmap, indices };
    });
    const tickKeys = loaded.flatMap((p) =>
      p.indices.map(
        (start) => getPdaTickArrayAddress(PROGRAM, p.id, start).publicKey,
      ),
    );
    if (tickKeys.length > 100) throw Error("Tick account limit exceeded");
    const tickResponse =
      await this.connection.getMultipleAccountsInfoAndContext(tickKeys, {
        minContextSlot: second.context.slot,
      });
    // Re-read pools, mints and tick accounts in one RPC context to remove state races between discovery reads.
    const coherentKeys = [
      ...states.map((p) => p.id),
      ...secondKeys,
      ...tickKeys,
      new PublicKey(market.mint),
      SYSVAR_CLOCK_PUBKEY,
    ];
    if (coherentKeys.length > 100)
      throw Error("Coherent account snapshot exceeds beta limits");
    const coherent = await this.connection.getMultipleAccountsInfoAndContext(
      coherentKeys,
      { minContextSlot: tickResponse.context.slot },
    );
    const coherentClock = coherent.value.at(-1);
    if (
      !coherentClock ||
      !coherentClock.owner.equals(
        new PublicKey("Sysvar1111111111111111111111111111111111111"),
      ) ||
      coherentClock.data.length !== 40
    )
      throw Error("Cluster clock unavailable");
    const nowClock = Number(coherentClock.data.readBigInt64LE(32));
    if (!Number.isSafeInteger(nowClock)) throw Error("Invalid cluster clock");
    const finalSafety = mintSafety(
      market,
      coherent.value.at(-2) ?? null,
      nowClock,
    );
    if (finalSafety.reason) throw Error(finalSafety.reason);
    let offset = 8;
    const result = loaded.map((p, i) => {
      const state = PoolInfoLayout.decode(
        validateData(coherent.value[i], "PoolState", PoolInfoLayout.span),
      );
      if (
        !state.configId.equals(p.state.configId) ||
        state.tickSpacing !== p.state.tickSpacing
      )
        throw Error("Pool configuration changed during refresh");
      if (
        !state.mintA.equals(p.state.mintA) ||
        !state.mintB.equals(p.state.mintB) ||
        !state.vaultA.equals(p.state.vaultA) ||
        !state.vaultB.equals(p.state.vaultB) ||
        !state.observationId.equals(p.state.observationId) ||
        (state.status & 16) !== 0 ||
        state.dynamicFeeInfo.dynamicFeeControl !== 0
      )
        throw Error("Pool relationships or swap policy changed during refresh");
      const config = ClmmConfigLayout.decode(
        validateData(
          coherent.value[2 + i * 3],
          "AmmConfig",
          ClmmConfigLayout.span,
        ),
      );
      if (
        !ObservationLayout.decode(
          validateData(
            coherent.value[4 + i * 3],
            "ObservationState",
            ObservationLayout.span,
          ),
        ).poolId.equals(p.id)
      )
        throw Error("Observation pool association changed");
      const bitmapInfo = coherent.value[3 + i * 3];
      const bitmap = bitmapInfo
        ? TickArrayBitmapExtensionLayout.decode(
            validateData(
              bitmapInfo,
              "TickArrayBitmapExtension",
              TickArrayBitmapExtensionLayout.span,
            ),
          )
        : p.bitmap;
      const ticks = p.indices
        .map((start) => {
          const address = getPdaTickArrayAddress(
            PROGRAM,
            p.id,
            start,
          ).publicKey;
          const info = coherent.value[offset++];
          if (!info) return null;
          const value = TickArrayLayout.decode(
            validateData(info, "TickArrayState", TickArrayLayout.span),
          );
          if (!value.poolId.equals(p.id) || value.startTickIndex !== start)
            throw Error("Tick array association changed");
          return { address, value };
        })
        .filter(
          (t): t is { address: PublicKey; value: TickState } => t !== null,
        );
      if (!bitmap.poolId.equals(p.id))
        throw Error("Pool bitmap association changed");
      return {
        id: p.id,
        state,
        config,
        bitmap,
        bitmapExists: Boolean(bitmapInfo),
        ticks,
        slot: coherent.context.slot,
        clock: nowClock,
        market,
        multiplier: finalSafety.multiplier,
        multiplierEffectiveAt: finalSafety.effectiveAt,
      };
    });
    return result as [LoadedPool, LoadedPool];
  }
  async quoteCycle(policy: StrategyPolicy): Promise<CycleQuote> {
    const market = MARKETS.find((m) => m.mint === policy.assetMint);
    if (!market) throw Error("Unsupported strategy mint");
    const amount = rawInteger(policy.cycleAmountRaw);
    if (amount > BigInt(BETA_LIMITS.cycleUsdcRaw))
      throw Error("Cycle exceeds beta cap");
    const snapshot = (await this.snapshot()).find(
      (m) => m.mint === market.mint,
    );
    if (!snapshot?.quoteEligible)
      throw Error(snapshot?.reason ?? "Market cannot be quoted");
    const [buy, sell] = await this.loadExactPools(market, [
      policy.poolBuy,
      policy.poolSell,
    ]);
    const quote = (pool: LoadedPool, input: string, raw: string) => {
      const zeroForOne = pool.state.mintA.toBase58() === input;
      const start = TickArrayUtil.getTickArrayStartIndex(
        pool.state.tickCurrent,
        pool.state.tickSpacing,
      );
      const ticks = pool.ticks
        .filter((t) =>
          zeroForOne
            ? t.value.startTickIndex <= start
            : t.value.startTickIndex >= start,
        )
        .sort((a, b) =>
          zeroForOne
            ? b.value.startTickIndex - a.value.startTickIndex
            : a.value.startTickIndex - b.value.startTickIndex,
        );
      const q = swapInternal({
        programId: PROGRAM,
        poolId: pool.id,
        poolInfo: pool.state,
        configInfo: pool.config,
        tickarrayBitmapExtension: pool.bitmap,
        tickArrays: ticks,
        amountSpecified: new BN(raw),
        sqrtPriceLimitX64: new BN(0),
        zeroForOne,
        isBaseInput: true,
        blockTimestamp: pool.clock,
        includeExtraTickArrays: true,
      });
      if (
        !q.allTrade ||
        !q.amountSpecifiedRemaining.isZero() ||
        q.amountCalculated.lten(0)
      )
        throw Error("Approved pool lacks sufficient executable tick depth");
      return q;
    };
    const first = quote(buy, USDC.mint, amount.toString()),
      second = quote(sell, market.mint, first.amountCalculated.toString());
    this.depthChecked.set(buy.id.toBase58(), {
      at: Date.now(),
      amountRaw: amount.toString(),
    });
    this.depthChecked.set(sell.id.toBase58(), {
      at: Date.now(),
      amountRaw: amount.toString(),
    });
    if (
      policy.slippageBps < 0 ||
      policy.slippageBps > 50 ||
      !Number.isInteger(policy.slippageBps)
    )
      throw Error("Slippage must be 0–50 basis points");
    const floor = (raw: string) =>
      (
        (BigInt(raw) * BigInt(10_000 - policy.slippageBps)) /
        10_000n
      ).toString();
    return {
      buy,
      sell,
      inputRaw: amount.toString(),
      tokenOutRaw: first.amountCalculated.toString(),
      returnedRaw: second.amountCalculated.toString(),
      profitRaw: (
        BigInt(second.amountCalculated.toString()) - amount
      ).toString(),
      buyMinOutRaw: floor(first.amountCalculated.toString()),
      sellMinOutRaw: floor(second.amountCalculated.toString()),
      buyTicks: first.accounts,
      sellTicks: second.accounts,
      slot: Math.min(buy.slot, sell.slot),
      multiplier: buy.multiplier,
      multiplierEffectiveAt: buy.multiplierEffectiveAt,
    };
  }
}
