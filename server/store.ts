import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type { ExecutionReceipt, NotificationPreferences, Strategy } from '../shared/types.ts'
import type { ExternalOwnerAction, FeeWalletRecord, IntentRecord, Reconciliation } from './ports.ts'
import { feeAvailable, sha256 } from './security.ts'
import { postgresConnectionOptions, type DatabaseTlsOptions } from './databaseTls.ts'

export interface QueryResult<T = Record<string, any>> { rows: T[]; rowCount: number | null }
export interface QueryClient { query<T = Record<string, any>>(text: string, values?: unknown[]): Promise<QueryResult<T>> }
export interface DatabasePool { connect(): Promise<QueryClient & { release(): void }>; end(): Promise<void>; on?(event: string, fn: () => void): unknown }
export interface Challenge { id: string; owner: string; message: string; expiresAt: string; consumedAt: string | null }
export interface Session { owner: string; csrfHash: string; expiresAt: string }
export interface OutboxItem { id: string; owner: string; kind: string; payload: Record<string, unknown>; email: string; attempts: number; verified: boolean; dedupeKey: string }
export interface StoreOptions extends DatabaseTlsOptions { rolePolicy?: 'runtime' | 'migration' }
export class DatabaseRoleFailure extends Error {}
export class ProductStore {
  readonly pool: DatabasePool
  private readonly enforceRuntimeRole: boolean
  private readinessIssue: string | null = null
  constructor(databaseUrl: string | DatabasePool, options: StoreOptions = {}) {
    const poolOptions = typeof databaseUrl === 'string' ? postgresConnectionOptions(databaseUrl, options) : null
    this.pool = poolOptions ? new pg.Pool(poolOptions) as DatabasePool : databaseUrl as DatabasePool
    const remote = poolOptions?.host && !['localhost', '127.0.0.1', '::1'].includes(poolOptions.host)
    this.enforceRuntimeRole = options.rolePolicy !== 'migration' && Boolean(remote || (options.production ?? process.env.NODE_ENV === 'production'))
    this.pool.on?.('error', () => { /* Requests report readiness without printing credentials. */ })
  }
  async close() { await this.pool.end() }
  readinessProblem() { return this.readinessIssue }
  async healthy() {
    try { await this.scope(null, async db => { await db.query('SELECT count(*) FROM product_users') }); this.readinessIssue = null; return true }
    catch (error) { this.readinessIssue = error instanceof DatabaseRoleFailure ? error.message : 'The account database or runtime table grants are unavailable; apply migrations with the separate admin connection and verify runtime access'; return false }
  }
  private async verifyRuntimeRole(db: QueryClient) {
    let role: Record<string, unknown> | undefined
    try {
      role = (await db.query("SELECT current_user::text AS role_name,r.rolsuper,r.rolbypassrls,r.rolcreaterole,EXISTS(SELECT 1 FROM pg_roles p WHERE (p.rolsuper OR p.rolbypassrls) AND pg_has_role(current_user,p.oid,'MEMBER')) AS privileged_membership FROM pg_roles r WHERE r.rolname=current_user")).rows[0]
    } catch { throw new DatabaseRoleFailure('Cannot verify PostgreSQL runtime-role permissions; use a dedicated nonprivileged runtime role and a separate migration admin connection') }
    if (!role || ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'privileged_membership'].some(key => typeof role![key] !== 'boolean' || role![key] === true)) {
      const message = 'The PostgreSQL runtime role must have NOSUPERUSER, NOBYPASSRLS and NOCREATEROLE, with no membership in superuser or BYPASSRLS roles; use a dedicated runtime role instead of the migration admin'
      this.readinessIssue = message; throw new DatabaseRoleFailure(message)
    }
  }
  async scope<T>(owner: string | null, fn: (db: QueryClient) => Promise<T>, consistentSnapshot = false): Promise<T> {
    const db = await this.pool.connect()
    try {
      await db.query(consistentSnapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
      if (this.enforceRuntimeRole) await this.verifyRuntimeRole(db)
      await db.query("SELECT set_config('app.owner',$1,true),set_config('app.system',$2,true)", [owner || '', owner ? 'off' : 'on'])
      const result = await fn(db)
      await db.query('COMMIT')
      return result
    } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
  }
  async createChallenge(challenge: Challenge) {
    await this.scope(challenge.owner, async db => {
      await db.query('DELETE FROM auth_challenges WHERE expires_at<now() OR consumed_at IS NOT NULL')
      await db.query('INSERT INTO auth_challenges(id,owner,message,expires_at) VALUES($1,$2,$3,$4)', [challenge.id, challenge.owner, challenge.message, challenge.expiresAt])
    })
  }
  async challenge(owner: string, id: string): Promise<Challenge | null> {
    return this.scope(owner, async db => {
      const result = await db.query('SELECT id,owner,message,expires_at,consumed_at FROM auth_challenges WHERE id=$1 AND owner=$2', [id, owner])
      const row = result.rows[0]
      return row ? { id: row.id, owner: row.owner, message: row.message, expiresAt: row.expires_at.toISOString(), consumedAt: row.consumed_at?.toISOString() || null } : null
    })
  }
  async consumeChallengeAndSession(owner: string, id: string, sessionHash: string, csrfHash: string, expiresAt: string) {
    return this.scope(null, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('doubletake:five-user-beta'))")
      const used = await db.query('UPDATE auth_challenges SET consumed_at=now() WHERE id=$1 AND owner=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING id', [id, owner])
      if (!used.rowCount) return false
      const existing = await db.query('SELECT owner FROM product_users WHERE owner=$1', [owner])
      if (!existing.rowCount) {
        const count = await db.query('SELECT count(*)::int AS count FROM product_users')
        if (count.rows[0].count >= 5) throw new Error('The five-user beta is full')
        await db.query('INSERT INTO product_users(owner) VALUES($1)', [owner])
      }
      await db.query('INSERT INTO auth_sessions(token_hash,owner,csrf_hash,expires_at) VALUES($1,$2,$3,$4)', [sessionHash, owner, csrfHash, expiresAt])
      return true
    })
  }
  async session(hash: string): Promise<Session | null> {
    return this.scope(null, async db => {
      const result = await db.query('SELECT owner,csrf_hash,expires_at FROM auth_sessions WHERE token_hash=$1 AND expires_at>now()', [hash])
      const row = result.rows[0]
      return row ? { owner: row.owner, csrfHash: row.csrf_hash, expiresAt: row.expires_at.toISOString() } : null
    })
  }
  async logout(hash: string) { await this.scope(null, async db => { await db.query('DELETE FROM auth_sessions WHERE token_hash=$1', [hash]) }) }
  async knownUser(owner: string) { return this.scope(owner, async db => Boolean((await db.query('SELECT owner FROM product_users WHERE owner=$1', [owner])).rowCount)) }
  async strategy(owner: string): Promise<Strategy | null> { return this.scope(owner, async db => (await db.query('SELECT state FROM strategies WHERE owner=$1', [owner])).rows[0]?.state || null) }
  async saveDraft(strategy: Strategy) {
    return this.scope(strategy.owner, async db => {
      const previous = await db.query('SELECT status FROM strategies WHERE owner=$1 FOR UPDATE', [strategy.owner])
      if (previous.rowCount && previous.rows[0].status !== 'draft') throw new Error('Active strategy changes require an owner-signed configure transaction')
      await db.query(`INSERT INTO strategies(id,owner,state,status) VALUES($1,$2,$3,'draft') ON CONFLICT(owner) DO UPDATE SET state=$3,updated_at=now()`, [strategy.id, strategy.owner, strategy])
      return strategy
    })
  }
  async saveChainStrategy(strategy: Strategy) {
    await this.scope(strategy.owner, async db => {
      const row = (await db.query('SELECT state FROM strategies WHERE id=$1 AND owner=$2 FOR UPDATE', [strategy.id, strategy.owner])).rows[0]
      if (row?.state.status === 'blocked') { strategy.status = 'blocked'; strategy.pauseReason = row.state.pauseReason }
      await db.query('UPDATE strategies SET state=$2,status=$3,updated_at=now() WHERE id=$1 AND owner=$4', [strategy.id, strategy, strategy.status, strategy.owner])
    })
  }
  async preparedByKey(owner: string, key: string): Promise<IntentRecord | null> { return this.scope(owner, async db => (await db.query('SELECT state FROM transaction_intents WHERE owner=$1 AND idempotency_key=$2', [owner, key])).rows[0]?.state || null) }
  async createIntent(intent: IntentRecord): Promise<IntentRecord> {
    return this.scope(intent.owner, async db => {
      const previous = await db.query('SELECT state FROM transaction_intents WHERE owner=$1 AND idempotency_key=$2', [intent.owner, intent.idempotencyKey])
      if (previous.rowCount) {
        const existing = previous.rows[0].state as IntentRecord
        if (existing.kind !== intent.kind || JSON.stringify(existing.payload) !== JSON.stringify(intent.payload)) throw new Error('Idempotency key already belongs to another transaction')
        return existing
      }
      if (intent.kind === 'fee-funding' || intent.kind === 'fee-refund') {
        const wallet = (await db.query('SELECT balance_lamports FROM fee_wallets WHERE owner=$1 FOR UPDATE', [intent.owner])).rows[0]
        if (!wallet) throw new Error('A prepaid fee wallet is required')
        const pending = (await db.query("SELECT COALESCE(sum(reserved_fee),0)::text AS reserved,COALESCE(sum(CASE WHEN kind='fee-funding' THEN (state->'payload'->>'amountRaw')::numeric ELSE 0 END),0)::text AS funding,count(*) FILTER(WHERE kind='fee-refund')::int AS refunds FROM transaction_intents WHERE owner=$1 AND status IN ('prepared','submitted','unresolved')", [intent.owner])).rows[0]
        const amount = BigInt(String(intent.payload.amountRaw))
        if (intent.kind === 'fee-funding' && BigInt(wallet.balance_lamports) + BigInt(pending.funding) + amount > 5000000n) throw new Error('The prepaid SOL cap would be exceeded by pending funding')
        if (intent.kind === 'fee-refund' && (pending.refunds || BigInt(pending.reserved) > 0n || amount + BigInt(intent.reservedFeeLamports) > BigInt(wallet.balance_lamports))) throw new Error('Wait for pending execution fees before requesting a refund')
      }
      if (intent.payload.externalUnverified === true) {
        await db.query('SELECT owner FROM product_users WHERE owner=$1 FOR UPDATE', [intent.owner])
        const count = (await db.query("SELECT count(*)::int AS count FROM transaction_intents WHERE owner=$1 AND status='unresolved' AND state->'payload'->>'externalUnverified'='true'", [intent.owner])).rows[0]
        if (count.count >= 10) throw new Error('Wait for pending owner-action imports to reconcile')
      }
      await db.query('INSERT INTO transaction_intents(id,owner,strategy_id,kind,status,idempotency_key,state,fee_wallet,reserved_fee,signature,wire_base64) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [intent.id, intent.owner, intent.strategyId, intent.kind, intent.status, intent.idempotencyKey, intent, intent.feeWallet, intent.reservedFeeLamports, intent.payload.externalUnverified ? null : intent.signature, intent.wireBase64])
      return intent
    })
  }
  async intent(owner: string, id: string): Promise<IntentRecord | null> { return this.scope(owner, async db => (await db.query('SELECT state FROM transaction_intents WHERE owner=$1 AND id=$2', [owner, id])).rows[0]?.state || null) }
  async intentBySignature(owner: string, signature: string): Promise<IntentRecord | null> { return this.scope(owner, async db => (await db.query('SELECT state FROM transaction_intents WHERE owner=$1 AND signature=$2', [owner, signature])).rows[0]?.state || null) }
  async promoteExternal(intent: IntentRecord, proof: ExternalOwnerAction): Promise<IntentRecord> {
    return this.scope(intent.owner, async db => {
      const existing = (await db.query('SELECT state FROM transaction_intents WHERE owner=$1 AND signature=$2', [intent.owner, intent.signature])).rows[0]
      if (existing) {
        if (existing.state.id !== intent.id) await db.query("UPDATE transaction_intents SET status='expired',state=state || jsonb_build_object('status','expired','error','This signature is recorded by its original transaction intent'),updated_at=now() WHERE id=$1 AND status='unresolved'", [intent.id])
        return existing.state
      }
      const state: IntentRecord = { ...intent, kind: proof.kind, status: 'submitted', prepared: proof.prepared, unsignedTransactionBase64: proof.prepared.transactionBase64, messageHash: sha256(proof.prepared.messageBase64), feePayer: proof.prepared.summary.feePayer, wireBase64: proof.wireBase64, blockhash: proof.prepared.blockhash, lastValidBlockHeight: proof.prepared.lastValidBlockHeight, payload: { ...intent.payload, ...proof.payload, external: true, externalUnverified: false }, summary: { title: proof.prepared.summary.action, recipient: proof.prepared.summary.recipient || intent.owner, amountRaw: proof.prepared.summary.amountRaw || null, token: proof.prepared.summary.token || 'USDC', cluster: proof.prepared.cluster, networkFeeLamports: proof.prepared.feeLamportsRaw }, updatedAt: new Date().toISOString() }
      await db.query("UPDATE transaction_intents SET kind=$2,status='submitted',signature=$3,wire_base64=$4,state=$5,updated_at=now() WHERE id=$1 AND owner=$6 AND status='unresolved'", [intent.id, state.kind, intent.signature, proof.wireBase64, state, intent.owner])
      return state
    })
  }
  async markSubmitted(owner: string, id: string, signature: string, wireBase64: string): Promise<IntentRecord | null> {
    return this.scope(owner, async db => {
      const result = await db.query(`UPDATE transaction_intents SET status='submitted',signature=$3,wire_base64=$4,updated_at=now(),state=state || jsonb_build_object('status','submitted','signature',$3::text,'wireBase64',$4::text,'updatedAt',now()) WHERE owner=$1 AND id=$2 AND status='prepared' AND (state->'prepared'->>'expiresAt')::timestamptz>now() RETURNING state`, [owner, id, signature, wireBase64])
      return result.rows[0]?.state || null
    })
  }
  async pendingIntents(): Promise<IntentRecord[]> {
    return this.scope(null, async db => (await db.query("SELECT state FROM transaction_intents WHERE status IN ('submitted','unresolved') AND (state->>'nextReconcileAt' IS NULL OR (state->>'nextReconcileAt')::timestamptz<=now()) ORDER BY CASE WHEN state->'payload'->>'externalUnverified'='true' THEN 1 ELSE 0 END,updated_at LIMIT 50")).rows.map(row => row.state))
  }
  async deferUnverifiedImport(intent: IntentRecord) {
    if (intent.payload.externalUnverified !== true) return
    const attempts = Math.min(32, (intent.reconciliationAttempts || 0) + 1)
    const delay = Math.min(21600000, 30000 * 2 ** (attempts - 1))
    await this.scope(null, async db => {
      await db.query("UPDATE transaction_intents SET state=state || jsonb_build_object('nextReconcileAt',$2::text,'reconciliationAttempts',$3::int),updated_at=now() WHERE id=$1 AND status='unresolved' AND state->'payload'->>'externalUnverified'='true'", [intent.id, new Date(Date.now() + delay).toISOString(), attempts])
    })
  }
  async preparedRefunds(): Promise<IntentRecord[]> { return this.scope(null, async db => (await db.query("SELECT state FROM transaction_intents WHERE kind='fee-refund' AND status='prepared' ORDER BY created_at LIMIT 5")).rows.map(row => row.state)) }
  async expirePrepared() {
    await this.scope(null, async db => {
      await db.query("UPDATE transaction_intents SET status='expired',reserved_fee=0,updated_at=now(),state=state || jsonb_build_object('status','expired','reservedFeeLamports','0','updatedAt',now()) WHERE status='prepared' AND (state->'prepared'->>'expiresAt')::timestamptz<=now()")
    })
  }
  async finalize(intent: IntentRecord, result: Reconciliation) {
    if (result.status === 'pending') return false
    const status = result.status
    if (result.status !== 'expired' && (!intent.signature || !result.confirmedAt || result.slot === undefined)) throw new Error('A confirmed chain receipt is required before settling an intent')
    return this.scope(null, async db => {
      const locked = await db.query('SELECT status FROM transaction_intents WHERE id=$1 FOR UPDATE', [intent.id])
      if (!locked.rowCount || !['submitted', 'unresolved'].includes(locked.rows[0].status)) return false
      const now = new Date().toISOString()
      const settled = { ...intent, status: result.status, reservedFeeLamports: '0', error: result.error || null, updatedAt: now }
      await db.query('UPDATE transaction_intents SET status=$2,reserved_fee=0,state=$3,updated_at=now() WHERE id=$1', [intent.id, result.status, settled])
      if (result.status !== 'expired') {
        const context = typeof intent.payload.preview === 'object' && intent.payload.preview !== null ? intent.payload.preview as Record<string, unknown> : {}
        const finalMultiplierAt = intent.prepared.summary.multiplierEffectiveAt
        const receipt: ExecutionReceipt = { id: randomUUID(), intentId: intent.id, owner: intent.owner, strategyId: intent.strategyId, kind: intent.kind, signature: intent.signature!, status: status === 'expired' ? 'failed' : status, slot: result.slot!, usdcDeltaRaw: result.usdcDeltaRaw || '0', networkFeeLamports: result.feeLamportsRaw, multiplier: typeof intent.prepared.summary.multiplier === 'string' ? intent.prepared.summary.multiplier : typeof intent.payload.multiplier === 'string' ? intent.payload.multiplier : null, mintFingerprint: result.mintFingerprint ?? null, assetReceivedRaw: result.assetReceivedRaw ?? null, multiplierEffectiveAt: result.multiplierEffectiveAt !== undefined ? result.multiplierEffectiveAt : typeof finalMultiplierAt === 'string' || finalMultiplierAt === null ? finalMultiplierAt : typeof context.multiplierEffectiveAt === 'string' ? context.multiplierEffectiveAt : null, occurredAt: result.confirmedAt!, error: result.error || null }
        await db.query('INSERT INTO execution_receipts(id,intent_id,owner,signature,state,fee_lamports,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(intent_id) DO NOTHING', [receipt.id, intent.id, intent.owner, intent.signature, receipt, result.feeLamportsRaw, result.confirmedAt])
        if (intent.feeWallet) {
          const kind = intent.kind === 'fee-funding' ? 'funding' : intent.kind === 'fee-refund' ? 'refund' : 'network-fee'
          const amount = kind === 'funding' ? result.feeFundingRaw || '0' : kind === 'refund' ? result.refundRaw || '0' : result.feeLamportsRaw
          await db.query('INSERT INTO fee_credit_events(owner,intent_id,signature,kind,amount_lamports,network_fee_lamports,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(intent_id) DO NOTHING', [intent.owner, intent.id, intent.signature, kind, amount, intent.kind === 'fee-funding' ? '0' : result.feeLamportsRaw, result.confirmedAt])
        }
        await this.enqueueInside(db, intent.owner, `intent:${intent.id}:${result.status}`, result.status === 'failed' ? 'failure' : intent.kind === 'execute' ? 'execution' : intent.kind === 'pause' || intent.kind === 'revoke' ? 'pause' : 'activity', { signature: intent.signature, action: intent.kind, status: result.status, usdcDeltaRaw: receipt.usdcDeltaRaw, networkFeeLamports: receipt.networkFeeLamports })
      }
      if (intent.strategyId) {
        const row = await db.query('SELECT state FROM strategies WHERE id=$1 FOR UPDATE', [intent.strategyId])
        if (row.rowCount) {
          const state = row.rows[0].state as Strategy
          const wasBlocked = state.status === 'blocked'; const blockReason = state.pauseReason
          if (result.chainStrategy) {
            const mergedPolicy = { ...state.policy, ...result.chainStrategy.policy }
            Object.assign(state, result.chainStrategy, { policy: mergedPolicy, owner: intent.owner, id: state.id })
          }
          const ownerRenewed = result.status === 'confirmed' && intent.kind === 'configure' && intent.payload.enable === true
          if (wasBlocked && !ownerRenewed && !['pause', 'revoke'].includes(intent.kind)) { state.status = 'blocked'; state.pauseReason = blockReason }
          if (ownerRenewed) state.consecutiveFailures = 0
          if (intent.kind === 'execute') {
            state.consecutiveFailures = result.status === 'failed' || result.status === 'expired' ? state.consecutiveFailures + 1 : result.status === 'confirmed' ? 0 : state.consecutiveFailures
            if (state.consecutiveFailures >= 3) { state.status = 'blocked'; state.pauseReason = 'Three consecutive failed execution attempts'; await this.enqueueInside(db, state.owner, `failure-pause:${intent.id}`, 'pause', { reason: state.pauseReason }) }
          }
          state.updatedAt = now
          await db.query('UPDATE strategies SET state=$2,status=$3,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1', [state.id, state, state.status])
        }
      }
      return true
    })
  }
  async activity(owner: string) {
    return this.scope(owner, async db => ({ receipts: (await db.query('SELECT state FROM execution_receipts WHERE owner=$1 ORDER BY occurred_at DESC LIMIT 100', [owner])).rows.map(row => row.state), intents: (await db.query('SELECT state FROM transaction_intents WHERE owner=$1 ORDER BY created_at DESC LIMIT 100', [owner])).rows.map(row => row.state) }))
  }
  async feeWallet(owner: string): Promise<FeeWalletRecord | null> {
    return this.scope(owner, async db => { const row = (await db.query('SELECT * FROM fee_wallets WHERE owner=$1', [owner])).rows[0]; return row ? { owner, address: row.address, encryptedSecret: row.encrypted_secret, balanceRaw: row.balance_lamports } : null })
  }
  async createFeeWallet(wallet: FeeWalletRecord): Promise<FeeWalletRecord> {
    return this.scope(wallet.owner, async db => {
      await db.query('INSERT INTO fee_wallets(owner,address,encrypted_secret) VALUES($1,$2,$3) ON CONFLICT(owner) DO NOTHING', [wallet.owner, wallet.address, wallet.encryptedSecret])
      const row = (await db.query('SELECT * FROM fee_wallets WHERE owner=$1', [wallet.owner])).rows[0]
      return { owner: wallet.owner, address: row.address, encryptedSecret: row.encrypted_secret, balanceRaw: row.balance_lamports }
    })
  }
  async setFeeBalance(owner: string, balanceRaw: string) { await this.scope(owner, async db => { await db.query('UPDATE fee_wallets SET balance_lamports=$2,checked_at=now() WHERE owner=$1', [owner, balanceRaw]) }) }
  async feeState(owner: string) {
    return this.scope(owner, async db => {
      const wallet = (await db.query('SELECT address,balance_lamports FROM fee_wallets WHERE owner=$1', [owner])).rows[0]
      const pending = (await db.query("SELECT COALESCE(sum(reserved_fee),0)::text AS reserved,bool_or(kind='fee-refund') AS refund FROM transaction_intents WHERE owner=$1 AND status IN ('prepared','submitted','unresolved')", [owner])).rows[0]
      const spent = (await db.query("SELECT COALESCE(sum(network_fee_lamports),0)::text AS spent FROM fee_credit_events WHERE owner=$1 AND occurred_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'", [owner])).rows[0]
      return { walletAddress: wallet?.address || '', balanceLamports: wallet?.balance_lamports || '0', reservedLamports: pending.reserved, spentTodayLamports: spent.spent, pendingRefund: Boolean(pending.refund) }
    })
  }
  async executionProgress(owner: string) {
    return this.scope(owner, async db => {
      const row = (await db.query("SELECT count(*) FILTER(WHERE occurred_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS cycles,max(occurred_at) AS last_execution FROM execution_receipts WHERE owner=$1 AND state->>'kind'='execute' AND state->>'status' IN ('confirmed','finalized')", [owner])).rows[0]
      return { confirmedCyclesToday: row.cycles as number, lastExecutionAt: row.last_execution ? new Date(row.last_execution).toISOString() : null }
    })
  }
  async reserveExecution(intent: IntentRecord, dailyLimitRaw: string, maxCyclesPerDay = 10, cooldownSeconds = 60) {
    return this.scope(null, async db => {
      const wallet = (await db.query('SELECT balance_lamports FROM fee_wallets WHERE owner=$1 FOR UPDATE', [intent.owner])).rows[0]
      if (!wallet) return false
      const pending = (await db.query("SELECT COALESCE(sum(reserved_fee),0)::text AS reserved,count(*) FILTER(WHERE kind='fee-refund')::int AS refunds FROM transaction_intents WHERE owner=$1 AND status IN ('prepared','submitted','unresolved')", [intent.owner])).rows[0]
      const spent = (await db.query("SELECT COALESCE(sum(network_fee_lamports),0)::text AS spent FROM fee_credit_events WHERE owner=$1 AND occurred_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'", [intent.owner])).rows[0]
      if (pending.refunds || !feeAvailable(wallet.balance_lamports, pending.reserved, spent.spent, dailyLimitRaw, intent.reservedFeeLamports).allowed) return false
      const counts = (await db.query("SELECT count(*) FILTER(WHERE occurred_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS cycles,max(occurred_at) AS last_execution FROM execution_receipts WHERE owner=$1 AND state->>'kind'='execute' AND state->>'status' IN ('confirmed','finalized')", [intent.owner])).rows[0]
      if (counts.cycles >= maxCyclesPerDay || (counts.last_execution && Date.now() - new Date(counts.last_execution).getTime() < cooldownSeconds * 1000)) return false
      await db.query('INSERT INTO transaction_intents(id,owner,strategy_id,kind,status,idempotency_key,state,fee_wallet,reserved_fee) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [intent.id, intent.owner, intent.strategyId, intent.kind, intent.status, intent.idempotencyKey, intent, intent.feeWallet, intent.reservedFeeLamports])
      return true
    })
  }
  async leaseStrategy(workerId: string, onlyOwner?: string): Promise<Strategy | null> {
    return this.scope(null, async db => {
      const row = (await db.query("SELECT id,state FROM strategies s WHERE status='active' AND ($1::text IS NULL OR s.owner=$1) AND (lease_until IS NULL OR lease_until<now()) AND NOT EXISTS(SELECT 1 FROM transaction_intents i WHERE i.strategy_id=s.id AND i.status IN ('prepared','submitted','unresolved') AND COALESCE(i.state->'payload'->>'externalUnverified','false')<>'true') ORDER BY last_served_at NULLS FIRST,updated_at LIMIT 1 FOR UPDATE SKIP LOCKED", [onlyOwner || null])).rows[0]
      if (!row) return null
      await db.query("UPDATE strategies SET lease_owner=$2,lease_until=now()+interval '45 seconds',last_served_at=now() WHERE id=$1", [row.id, workerId])
      return row.state
    })
  }
  async releaseLease(id: string, workerId: string) { await this.scope(null, async db => { await db.query('UPDATE strategies SET lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2', [id, workerId]) }) }
  async pauseStrategy(strategy: Strategy, reason: string) {
    await this.scope(null, async db => {
      const row = (await db.query('SELECT state FROM strategies WHERE id=$1 FOR UPDATE', [strategy.id])).rows[0]
      if (!row) return
      const current = row.state as Strategy
      if (current.status !== 'active') return
      current.status = 'blocked'; current.pauseReason = reason; current.updatedAt = new Date().toISOString()
      await db.query("UPDATE strategies SET state=$2,status='blocked',lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [current.id, current])
      await this.enqueueInside(db, current.owner, `pause:${current.id}:${current.nonce}:${reason}`, 'pause', { reason })
    })
  }
  async operatorPaused() { return this.scope(null, async db => (await db.query("SELECT value FROM operator_settings WHERE key='kill-switch'")).rows[0]?.value === true) }
  async notificationServicePause(): Promise<string | null> {
    return this.scope(null, async db => {
      const value = (await db.query("SELECT value FROM operator_settings WHERE key='notification-service-pause'")).rows[0]?.value
      return value?.paused === true && typeof value.reason === 'string' ? value.reason : null
    })
  }
  async setNotificationServicePause(reason: string | null) {
    await this.scope(null, async db => { await db.query("INSERT INTO operator_settings(key,value) VALUES('notification-service-pause',$1) ON CONFLICT(key) DO UPDATE SET value=$1,updated_at=now()", [{ paused: Boolean(reason), reason, nextProbeAt: reason ? new Date(Date.now() + 960000).toISOString() : null }]) })
  }
  async notifications(owner: string): Promise<NotificationPreferences> {
    return this.scope(owner, async db => { const row = (await db.query('SELECT email,email_verified_at,preferences FROM product_users WHERE owner=$1', [owner])).rows[0]; return { email: row?.email || null, verified: Boolean(row?.email_verified_at), executions: true, failures: true, pauses: true, lowFeeBalance: true, ...row?.preferences } })
  }
  async setPreferences(owner: string, preferences: Partial<NotificationPreferences>) {
    await this.scope(owner, async db => { await db.query('UPDATE product_users SET preferences=preferences || $2::jsonb WHERE owner=$1', [owner, preferences]) })
  }
  async requestEmailVerification(owner: string, email: string, hash: string, verificationUrl: string) {
    await this.scope(owner, async db => {
      await db.query('SELECT owner FROM product_users WHERE owner=$1 FOR UPDATE', [owner])
      const count = (await db.query("SELECT count(*)::int AS count FROM notification_outbox WHERE owner=$1 AND kind='verify-email' AND created_at>now()-interval '1 hour'", [owner])).rows[0]
      if (count.count >= 3) throw new Error('Email verification is limited to three requests per hour')
      await db.query('UPDATE product_users SET email=$2,email_verified_at=NULL WHERE owner=$1', [owner, email])
      await db.query('DELETE FROM email_verifications WHERE owner=$1', [owner])
      await db.query("INSERT INTO email_verifications(token_hash,owner,email,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [hash, owner, email])
      await this.enqueueInside(db, owner, `verify-email:${hash}`, 'verify-email', { email, verificationUrl })
    })
  }
  async verifyEmail(hash: string) {
    return this.scope(null, async db => {
      const row = (await db.query('UPDATE email_verifications SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING owner,email', [hash])).rows[0]
      if (!row) return false
      const changed = await db.query('UPDATE product_users SET email_verified_at=now() WHERE owner=$1 AND email=$2', [row.owner, row.email])
      return Boolean(changed.rowCount)
    })
  }
  async enqueueInside(db: QueryClient, owner: string, dedupeKey: string, kind: string, payload: Record<string, unknown>) {
    await db.query('INSERT INTO notification_outbox(id,owner,dedupe_key,kind,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING', [randomUUID(), owner, dedupeKey, kind, payload])
  }
  async enqueue(owner: string, dedupeKey: string, kind: string, payload: Record<string, unknown>) { await this.scope(owner, db => this.enqueueInside(db, owner, dedupeKey, kind, payload)) }
  async nextNotification(): Promise<OutboxItem | null> {
    return this.scope(null, async db => {
      const service = (await db.query("SELECT value FROM operator_settings WHERE key='notification-service-pause' FOR UPDATE")).rows[0]?.value
      if (service?.paused === true && Date.parse(service.nextProbeAt || '') > Date.now()) return null
      const row = (await db.query("SELECT o.*,u.email,u.email_verified_at,u.preferences FROM notification_outbox o JOIN product_users u ON u.owner=o.owner WHERE ((o.status='queued' AND o.next_attempt_at<=now()) OR (o.status='sending' AND o.lease_until<now())) AND (o.attempts<5 OR o.last_error IN ('Email provider returned 401','Email provider returned 403','Email provider returned 429')) ORDER BY o.created_at LIMIT 1 FOR UPDATE OF o SKIP LOCKED")).rows[0]
      if (!row) return null
      const preference = row.kind === 'execution' ? 'executions' : row.kind === 'failure' ? 'failures' : row.kind === 'pause' ? 'pauses' : row.kind === 'low-balance' ? 'lowFeeBalance' : null
      const suppress = row.kind !== 'verify-email' && (!row.email_verified_at || !preference || row.preferences[preference] === false)
      await db.query('UPDATE notification_outbox SET status=$2,attempts=attempts+1,lease_until=now()+interval \'30 seconds\',updated_at=now() WHERE id=$1', [row.id, suppress ? 'suppressed' : 'sending'])
      if (suppress) return null
      if (service?.paused === true) await db.query("UPDATE operator_settings SET value=value || jsonb_build_object('nextProbeAt',$1::text),updated_at=now() WHERE key='notification-service-pause'", [new Date(Date.now() + 960000).toISOString()])
      return { id: row.id, owner: row.owner, email: row.kind === 'verify-email' ? row.payload.email : row.email, kind: row.kind, payload: row.payload, attempts: row.attempts + 1, verified: Boolean(row.email_verified_at), dedupeKey: row.dedupe_key }
    })
  }
  async markNotification(id: string, status: 'sent' | 'delivered' | 'failed' | 'queued', providerId: string | null, error: string | null, attempts: number) {
    await this.scope(null, async db => { await db.query('UPDATE notification_outbox SET status=$2,provider_id=COALESCE($3,provider_id),last_error=$4,lease_until=NULL,next_attempt_at=now()+($5::int * interval \'1 second\'),updated_at=now() WHERE id=$1', [id, status, providerId, error, Math.min(3600, 30 * 2 ** attempts)]) })
  }
  async notificationStatus(owner: string) { return this.scope(owner, async db => (await db.query('SELECT id,kind,status,attempts,created_at,updated_at FROM notification_outbox WHERE owner=$1 ORDER BY created_at DESC LIMIT 30', [owner])).rows) }
  async emailBounce(providerId: string) { await this.scope(null, async db => { await db.query("UPDATE notification_outbox SET status='bounced',updated_at=now() WHERE provider_id=$1", [providerId]) }) }
  async emailDelivery(providerId: string, status: 'delivered' | 'bounced' | 'failed') {
    await this.scope(null, async db => {
      const row = (await db.query('UPDATE notification_outbox SET status=$2,updated_at=now() WHERE provider_id=$1 RETURNING owner', [providerId, status])).rows[0]
      if (row && status === 'bounced') await db.query('UPDATE product_users SET email_verified_at=NULL WHERE owner=$1', [row.owner])
    })
  }
  async financialBackup() {
    return this.scope(null, async db => {
      const tables: Record<string, unknown[]> = {}
      for (const name of ['product_users', 'strategies', 'transaction_intents', 'execution_receipts', 'fee_wallets', 'fee_credit_events', 'notification_outbox', 'operator_settings']) tables[name] = (await db.query(`SELECT * FROM ${name}`)).rows
      return { version: 1, capturedAt: new Date().toISOString(), tables }
    }, true)
  }
  async saveObservations(markets: { symbol: string; checkedAt: string }[]) {
    await this.scope(null, async db => {
      for (const snapshot of markets) await db.query('INSERT INTO market_observations(symbol,observed_at,snapshot) VALUES($1,$2,$3)', [snapshot.symbol, snapshot.checkedAt, snapshot])
      await db.query("DELETE FROM market_observations WHERE observed_at<now()-interval '30 days'")
      await db.query('DELETE FROM auth_sessions WHERE expires_at<now()')
      await db.query('DELETE FROM auth_challenges WHERE expires_at<now()')
      await db.query('DELETE FROM email_verifications WHERE expires_at<now()')
    })
  }
}
