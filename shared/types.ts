export type RawAmount = string;
export type Cluster = "mainnet-beta" | "devnet" | "localnet";
export type MarketCategory = "xstock" | "crypto";
export interface Readiness {
  ready: boolean;
  reasons: string[];
}
export interface RuntimeConfig {
  cluster: Cluster;
  programId: string | null;
  rpcEndpoint: string;
  phase:
    | "configuration-required"
    | "verification-required"
    | "canary"
    | "invite-beta";
  readiness: Readiness;
  fundingEnabled: boolean;
  automationEnabled: boolean;
  upgradeAuthority: string | null;
  limits: typeof import("./registry.ts").BETA_LIMITS;
}
export interface PoolSnapshot {
  poolId: string;
  programId: string;
  venue: "Raydium CLMM";
  priceUsd: number | null;
  liquidityUsd: number | null;
  feeBps: number;
  mintA: string;
  mintB: string;
  slot: number;
  checkedAt: string;
  depthReady: boolean;
  quotedDepthUsdcRaw?: RawAmount;
  sourceUrl: string;
  status: "available" | "unavailable";
  reason?: string;
}
export interface MarketSnapshot {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  category: MarketCategory;
  tokenProgram: string;
  multiplier: string;
  multiplierEffectiveAt: string | null;
  issuerWarnings: string[];
  pools: PoolSnapshot[];
  observedGapPct: number | null;
  checkedAt: string;
  slot: number;
  status: "available" | "stale" | "unavailable" | "blocked";
  reason?: string;
  quoteEligible?: boolean;
  executionEligible: boolean;
}
export interface StrategyPolicy {
  assetMint: string;
  poolBuy: string;
  poolSell: string;
  cycleAmountRaw: RawAmount;
  minProfitRaw: RawAmount;
  dailyFeeLimitLamports: RawAmount;
  maxFeePerAttemptLamports: RawAmount;
  maxCyclesPerDay: number;
  cooldownSeconds: number;
  expiresAt: string;
  slippageBps: number;
}
export type StrategyStatus =
  | "draft"
  | "active"
  | "paused"
  | "expired"
  | "blocked";
export interface Strategy {
  id: string;
  owner: string;
  vaultAddress: string;
  keeperAddress: string;
  policy: StrategyPolicy;
  status: StrategyStatus;
  pauseReason: string | null;
  balanceUsdcRaw: RawAmount;
  depositedPrincipalRaw: RawAmount;
  nonce: RawAmount;
  confirmedCyclesToday: number;
  consecutiveFailures: number;
  chainSlot: number | null;
  createdAt: string;
  updatedAt: string;
  checkedAt?: string;
}
export interface ExecutionPreview {
  id: string;
  strategyId: string;
  assetMint: string;
  poolBuy: string;
  poolSell: string;
  startingUsdcRaw: RawAmount;
  estimatedTokenOutRaw: RawAmount | null;
  estimatedReturnedUsdcRaw: RawAmount | null;
  estimatedProfitUsdcRaw: RawAmount | null;
  minimumProfitUsdcRaw: RawAmount;
  estimatedFeeLamports: RawAmount | null;
  estimatedFeeUsdcRaw: RawAmount | null;
  simulation: {
    success: boolean;
    unitsConsumed: number | null;
    error: string | null;
  } | null;
  slot: number;
  checkedAt: string;
  expiresAt: string;
  status: "ready" | "blocked" | "not-profitable";
  reasons: string[];
  multiplier: string;
  multiplierEffectiveAt?: string | null;
}
export type OwnerAction =
  | "initialize"
  | "configure"
  | "deposit"
  | "pause"
  | "revoke"
  | "withdraw"
  | "recover";
export type IntentKind = OwnerAction | "execute" | "fee-funding" | "fee-refund";
export type IntentStatus =
  | "prepared"
  | "submitted"
  | "confirmed"
  | "finalized"
  | "failed"
  | "expired"
  | "unresolved";
export interface TransactionIntent {
  id: string;
  owner: string;
  strategyId: string | null;
  kind: IntentKind;
  status: IntentStatus;
  unsignedTransactionBase64: string;
  messageHash: string;
  feePayer: string;
  blockhash: string;
  lastValidBlockHeight: number;
  signature: string | null;
  expectedUsdcDeltaRaw: RawAmount | null;
  reservedFeeLamports: RawAmount;
  summary: {
    title: string;
    recipient: string;
    amountRaw: RawAmount | null;
    token: string;
    cluster: Cluster;
    networkFeeLamports: RawAmount;
  };
  createdAt: string;
  updatedAt: string;
  error: string | null;
}
export interface ExecutionReceipt {
  id: string;
  intentId: string;
  owner: string;
  strategyId: string | null;
  kind: IntentKind;
  signature: string;
  status: "confirmed" | "finalized" | "failed";
  slot: number;
  usdcDeltaRaw: RawAmount;
  networkFeeLamports: RawAmount;
  multiplier: string | null;
  mintFingerprint?: string | null;
  assetReceivedRaw?: RawAmount | null;
  multiplierEffectiveAt?: string | null;
  occurredAt: string;
  error: string | null;
}
export interface FeeCredit {
  walletAddress: string;
  balanceLamports: RawAmount;
  reservedLamports: RawAmount;
  availableLamports: RawAmount;
  spentTodayLamports: RawAmount;
  maxBalanceLamports: RawAmount;
  dailyLimitLamports: RawAmount;
  pendingRefund: boolean;
  custody: "service-controlled";
  checkedAt?: string;
}
export interface PortfolioHolding {
  symbol: string;
  mint: string;
  amountRaw: RawAmount;
  decimals: number;
  multiplier: string;
  displayAmount: string;
  tokenAccounts: string[];
}
export interface Portfolio {
  owner: string;
  solBalanceLamports: RawAmount;
  usdcBalanceRaw: RawAmount;
  holdings: PortfolioHolding[];
  slot: number;
  checkedAt: string;
}
export interface NotificationPreferences {
  email: string | null;
  verified: boolean;
  executions: boolean;
  failures: boolean;
  pauses: boolean;
  lowFeeBalance: boolean;
}
export interface SessionUser {
  wallet: string;
  invited: boolean;
  expiresAt: string;
}
export interface ApiError {
  error: string;
  code: string;
  reasons?: string[];
}
