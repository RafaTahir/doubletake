/** Chain classes stay behind this boundary. Raw monetary values are integer strings. */
import type { Cluster, ExecutionPreview, IntentKind, MarketSnapshot, NotificationPreferences, OwnerAction, Strategy, TransactionIntent } from '../shared/types.ts'
export type Raw = string
export type ActionKind = IntentKind
export type StrategyRecord = Strategy
export type PreviewRecord = ExecutionPreview
export type { NotificationPreferences }
export interface PreparedTransaction {
  transactionBase64: string; messageBase64: string; blockhash: string
  lastValidBlockHeight: number; expiresAt: string; feeLamportsRaw: Raw
  cluster: Cluster; summary: { action: string; owner: string; feePayer: string; amountRaw?: Raw; recipient?: string; token?: string; [key: string]: unknown }
}
export interface IntentRecord extends TransactionIntent {
  idempotencyKey: string; payload: Record<string, unknown>; prepared: PreparedTransaction
  wireBase64: string | null; feeWallet: string | null
  nextReconcileAt?: string; reconciliationAttempts?: number
}
export interface Reconciliation {
  status: 'pending' | 'confirmed' | 'failed' | 'expired'; feeLamportsRaw: Raw
  confirmedAt?: string; slot?: number; error?: string
  /** Movements must be derived and checked against prepared instruction accounts. */
  usdcDeltaRaw?: string; feeFundingRaw?: Raw; refundRaw?: Raw
  mintFingerprint?: string | null; assetReceivedRaw?: Raw | null; multiplierEffectiveAt?: string | null
  chainStrategy?: Partial<StrategyRecord>
}
export interface ExternalOwnerAction {
  kind: OwnerAction; prepared: PreparedTransaction; reconciliation: Reconciliation
  payload: Record<string, unknown>; wireBase64: string
}
export interface ChainGateway {
  readiness(owner?: string): { programConfigured: boolean; fundingEnabled: boolean; automationEnabled: boolean; reasons: string[] }
  portfolio(owner: string): Promise<unknown>
  refreshStrategy?(strategy: StrategyRecord, forceFresh?: boolean): Promise<StrategyRecord>
  invalidateOwner?(owner: string): void
  inspectOwnerAction?(owner: string, signature: string, expected: { action: 'pause' | 'revoke' | 'withdraw' | 'recover'; amountRaw?: string }): Promise<ExternalOwnerAction | null>
  prepareOwnerAction(owner: string, action: ActionKind, payload: Record<string, unknown>, feeWallet?: string): Promise<PreparedTransaction>
  verifySignedOwnerTransaction(prepared: PreparedTransaction, signedBase64: string): Promise<{ signature: string; wireBase64: string }>
  broadcastSignedTransaction(wireBase64: string): Promise<string>
  reconcile(intent: IntentRecord): Promise<Reconciliation>
  executionPreview(strategy: StrategyRecord): Promise<PreviewRecord>
  prepareExecution(strategy: StrategyRecord, preview: PreviewRecord, feePayer: string): Promise<PreparedTransaction>
  signKeeperTransaction(prepared: PreparedTransaction, feeSecret: Uint8Array, expectedOwner: string): Promise<{ signature: string; wireBase64: string }>
  prepareRefund(owner: string, feeWallet: string, amountRaw: Raw): Promise<PreparedTransaction>
  feeWalletBalance(address: string, forceFresh?: boolean): Promise<Raw>
}
export interface MarketGateway { snapshot(): Promise<MarketSnapshot[]>; readRpc?(method: string, params: unknown[]): Promise<unknown> }
export interface BackendConfig {
  databaseUrl?: string; databaseCaCert?: string; origin: string; cluster: Cluster; inviteWallets: string[]
  sessionSecret: string; feeEncryptionKey?: string; cookieSecure: boolean
  keeperEnabled: boolean; killSwitch: boolean; serviceBudgetExhausted: boolean
  canaryApproved: boolean; canaryOwner?: string
  resendApiKey?: string; emailFrom?: string; emailWebhookSecret?: string
  backupDirectory?: string; backupEncryptionKey?: string
  host: string; port: number; staticDirectory: string; rpcUrl: string
}
export interface FeeWalletRecord { owner: string; address: string; encryptedSecret: string; balanceRaw: Raw }
