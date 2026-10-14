import { randomUUID } from 'node:crypto'
import type { BackendConfig, ChainGateway, IntentRecord, MarketGateway, PreviewRecord } from './ports.ts'
import type { MarketSnapshot, Strategy } from '../shared/types.ts'
import { makeIntent, validatePolicy } from './app.ts'
import { decryptSecret } from './security.ts'
import type { ProductStore } from './store.ts'
import { deliverNotification } from './notifications.ts'
import { writeDailyBackup } from './backup.ts'

export function qualifyingPreview(preview: PreviewRecord, minimumProfitRaw: string, now = Date.now()) {
  if (preview.status !== 'ready' || !preview.simulation?.success || Date.parse(preview.expiresAt) <= now || now - Date.parse(preview.checkedAt) > 10000) return false
  if (!preview.estimatedProfitUsdcRaw || !preview.estimatedFeeLamports || !preview.estimatedFeeUsdcRaw) return false
  const networkBuffer = (BigInt(preview.estimatedFeeUsdcRaw) * 125n + 99n) / 100n
  return BigInt(preview.estimatedProfitUsdcRaw) >= BigInt(minimumProfitRaw) + networkBuffer
}
/** An optimistic spot/fee bound can reject a cycle; it never authorizes or values an execution. */
export function passesSpotScreen(strategy: Strategy, market: MarketSnapshot) {
  if (market.status !== 'available' || Date.now() - Date.parse(market.checkedAt) > 10000) return false
  const buy = market.pools.find(pool => pool.poolId === strategy.policy.poolBuy)
  const sell = market.pools.find(pool => pool.poolId === strategy.policy.poolSell)
  if (!buy || !sell || buy.status !== 'available' || sell.status !== 'available' || !buy.priceUsd || !sell.priceUsd || !Number.isFinite(buy.priceUsd) || !Number.isFinite(sell.priceUsd)) return false
  if (![buy.feeBps, sell.feeBps].every(fee => Number.isFinite(fee) && fee >= 0 && fee < 10000)) return false
  const optimistic = Number(strategy.policy.cycleAmountRaw) * ((sell.priceUsd / buy.priceUsd) * (1 - buy.feeBps / 10000) * (1 - sell.feeBps / 10000) - 1)
  // Ten raw USDC units allow conservative rounding error in this reject-only screen.
  return optimistic + 10 >= Number(strategy.policy.minProfitRaw)
}
export class ProductWorker {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private stopped = true
  private workerId = randomUUID()
  private lastObservation = 0
  private lastBackup = 0
  constructor(private store: ProductStore, private chain: ChainGateway, private markets: MarketGateway, private config: BackendConfig, private log: (event: Record<string, unknown>) => void = () => {}) {}
  start() { if (this.timer) return; this.stopped = false; this.timer = setInterval(() => { void this.tick() }, 5000); this.timer.unref(); void this.tick() }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; while (this.running) await new Promise(resolve => setTimeout(resolve, 25)) }
  async tick() {
    if (this.running || this.stopped) return
    this.running = true
    try {
      await this.store.expirePrepared()
      await this.reconcile()
      await this.refunds()
      if (Date.now() - this.lastBackup >= 3600000 && this.config.backupDirectory && this.config.backupEncryptionKey) {
        await writeDailyBackup(this.store, this.config); this.lastBackup = Date.now()
      }
      const paused = this.config.killSwitch || this.config.serviceBudgetExhausted || await this.store.operatorPaused() || Boolean(await this.store.notificationServicePause())
      const globalAutomation = this.chain.readiness().automationEnabled
      const canaryOwner = !globalAutomation && this.config.canaryApproved && this.config.canaryOwner && this.chain.readiness(this.config.canaryOwner).automationEnabled ? this.config.canaryOwner : undefined
      if (this.config.keeperEnabled && !paused && (globalAutomation || canaryOwner) && this.config.feeEncryptionKey && this.config.backupDirectory && this.config.backupEncryptionKey && this.config.emailFrom && this.config.resendApiKey) await this.executeOne(canaryOwner)
      try {
        const snapshots = await this.markets.snapshot()
        if (Date.now() - this.lastObservation >= 300000) { await this.store.saveObservations(snapshots); this.lastObservation = Date.now() }
      } catch { this.log({ event: 'market_sampling_deferred' }) }
      try { await deliverNotification(this.store, this.config) } catch { this.log({ event: 'notification_delivery_deferred' }) }
    } catch { this.log({ event: 'worker_tick_failed', recoverable: true }) } finally { this.running = false }
  }
  async reconcile() {
    for (const intent of await this.store.pendingIntents()) {
      try {
        if (intent.payload.externalUnverified === true) {
          if (!this.chain.inspectOwnerAction || !intent.signature) continue
          const proof = await this.chain.inspectOwnerAction(intent.owner, intent.signature, { action: String(intent.payload.expectedAction) as 'pause' | 'revoke' | 'withdraw' | 'recover', ...(typeof intent.payload.amountRaw === 'string' ? { amountRaw: intent.payload.amountRaw } : {}) })
          if (proof) { const promoted = await this.store.promoteExternal(intent, proof); this.chain.invalidateOwner?.(intent.owner); await this.store.finalize(promoted, proof.reconciliation) }
          else await this.store.deferUnverifiedImport(intent)
          continue
        }
        const result = await this.chain.reconcile(intent)
        if (result.status !== 'pending') { this.chain.invalidateOwner?.(intent.owner); const settled = await this.store.finalize(intent, result); if (settled) this.log({ event: 'transaction_reconciled', intentId: intent.id, status: result.status, signature: intent.signature }) }
      } catch { await this.store.deferUnverifiedImport(intent); this.log({ event: 'reconciliation_deferred', intentId: intent.id }) }
    }
  }
  private async submitService(intent: IntentRecord) {
    if (intent.kind === 'execute' && (this.config.killSwitch || this.config.serviceBudgetExhausted || !this.config.inviteWallets.includes(intent.owner) || await this.store.operatorPaused() || await this.store.notificationServicePause() || !this.chain.readiness(intent.owner).automationEnabled)) return
    if (intent.kind === 'execute' && !(await this.store.notifications(intent.owner)).verified) {
      const strategy = await this.store.strategy(intent.owner)
      if (strategy) await this.store.pauseStrategy(strategy, 'Verify your current notification email before renewing automation')
      return
    }
    const wallet = await this.store.feeWallet(intent.owner)
    if (!wallet || !this.config.feeEncryptionKey) throw new Error('The prepaid fee wallet is unavailable')
    const secret = decryptSecret(wallet.encryptedSecret, this.config.feeEncryptionKey, intent.owner)
    try {
      const signed = await this.chain.signKeeperTransaction(intent.prepared, secret, intent.owner)
      const claimed = await this.store.markSubmitted(intent.owner, intent.id, signed.signature, signed.wireBase64)
      if (!claimed) return
      try { await this.chain.broadcastSignedTransaction(signed.wireBase64) } catch { this.log({ event: 'broadcast_unresolved', intentId: intent.id, signature: signed.signature }) }
    } finally { secret.fill(0) }
  }
  async refunds() {
    // Owner exits and prepaid-fee refunds continue when automation is paused.
    if (!this.config.feeEncryptionKey) return
    for (const refund of await this.store.preparedRefunds()) {
      try { await this.submitService(refund) } catch { this.log({ event: 'refund_deferred', intentId: refund.id }) }
    }
  }
  private async executeOne(onlyOwner?: string) {
    const leased = await this.store.leaseStrategy(this.workerId, onlyOwner)
    if (!leased) return
    try {
      if (!this.config.inviteWallets.includes(leased.owner)) { await this.store.pauseStrategy(leased, 'Beta invitation is inactive; owner exit controls remain available'); return }
      if (!this.chain.readiness(leased.owner).automationEnabled) return
      if (!(await this.store.notifications(leased.owner)).verified) { await this.store.pauseStrategy(leased, 'Verify your current notification email before renewing automation'); return }
      try { validatePolicy(leased.policy) } catch { await this.store.pauseStrategy(leased, 'Strategy permission expired or policy is no longer supported'); return }
      const progress = await this.store.executionProgress(leased.owner)
      if (progress.confirmedCyclesToday >= leased.policy.maxCyclesPerDay) { await this.store.pauseStrategy(leased, 'The owner daily cycle limit has been reached'); return }
      if (progress.lastExecutionAt && Date.now() - Date.parse(progress.lastExecutionAt) < leased.policy.cooldownSeconds * 1000) return
      const market = (await this.markets.snapshot()).find(snapshot => snapshot.mint === leased.policy.assetMint)
      if (!market || ['blocked', 'stale', 'unavailable'].includes(market.status)) { await this.store.pauseStrategy(leased, market?.reason || 'Fresh mint and pool state is unavailable'); return }
      if (!passesSpotScreen(leased, market)) return
      const strategy = this.chain.refreshStrategy ? await this.chain.refreshStrategy(leased, true) : leased
      if (strategy.status !== 'active') { await this.store.saveChainStrategy(strategy); return }
      try { validatePolicy(strategy.policy) } catch { await this.store.pauseStrategy(strategy, 'Strategy permission expired or policy is no longer supported'); return }
      const preview = await this.chain.executionPreview(strategy)
      if (!qualifyingPreview(preview, strategy.policy.minProfitRaw)) {
        if (preview.status === 'blocked') await this.store.pauseStrategy(strategy, preview.reasons.join('; ') || 'Current pool or mint state blocks execution')
        return
      }
      const wallet = await this.store.feeWallet(strategy.owner)
      if (!wallet) { await this.store.pauseStrategy(strategy, 'No prepaid SOL allowance is available'); return }
      const balance = await this.chain.feeWalletBalance(wallet.address, true); await this.store.setFeeBalance(strategy.owner, balance)
      if (BigInt(balance) > 5000000n) { await this.store.pauseStrategy(strategy, 'Prepaid SOL balance exceeds the beta allowance cap; refund excess credit'); return }
      const prepared = await this.chain.prepareExecution(strategy, preview, wallet.address)
      if (BigInt(prepared.feeLamportsRaw) > BigInt(strategy.policy.maxFeePerAttemptLamports)) { await this.store.pauseStrategy(strategy, 'Estimated network fee exceeds the per-attempt limit'); return }
      const intent = makeIntent(strategy.owner, strategy.id, 'execute', `execute:${strategy.id}:${strategy.nonce}:${randomUUID()}`, { nonce: strategy.nonce, multiplier: preview.multiplier, preview }, prepared, wallet.address, prepared.feeLamportsRaw)
      if (!await this.store.reserveExecution(intent, strategy.policy.dailyFeeLimitLamports, strategy.policy.maxCyclesPerDay, strategy.policy.cooldownSeconds)) {
        await this.store.pauseStrategy(strategy, 'Fee allowance or daily cycle budget is exhausted')
        await this.store.enqueue(strategy.owner, `low-balance:${strategy.id}:${strategy.nonce}`, 'low-balance', { reason: 'Top up or renew the daily fee allowance before re-enabling automation' })
        return
      }
      await this.submitService(intent)
    } finally { await this.store.releaseLease(leased.id, this.workerId) }
  }
}
