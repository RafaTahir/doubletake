import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createPrivateKey, generateKeyPairSync, randomUUID, sign, X509Certificate } from 'node:crypto'
import { rootCertificates, type ConnectionOptions } from 'node:tls'
import pg from 'pg'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import bs58 from 'bs58'
import { createApp, makeIntent, validatePolicy } from '../server/app.ts'
import { loadConfig } from '../server/config.ts'
import { LocalDatabasePool } from '../server/databaseLocal.ts'
import { postgresConnectionOptions } from '../server/databaseTls.ts'
import { DatabaseRoleFailure, ProductStore } from '../server/store.ts'
import { decryptSecret, encryptSecret, feeAvailable, sha256, verifyWalletMessage } from '../server/security.ts'
import { passesSpotScreen, ProductWorker, qualifyingPreview } from '../server/worker.ts'
import { deliverNotification } from '../server/notifications.ts'
import { decryptBackup, encryptBackup } from '../server/backup.ts'
import { MARKETS } from '../shared/registry.ts'
import type { MarketSnapshot, Strategy, StrategyPolicy } from '../shared/types.ts'
import type { ChainGateway, IntentRecord, PreparedTransaction } from '../server/ports.ts'

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { owner: bs58.encode(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)), privateKey }
}
const alice = wallet(); const bob = wallet()
const now = () => new Date().toISOString()
const policy = (): StrategyPolicy => ({ assetMint: MARKETS[0].mint, poolBuy: MARKETS[0].pools[0], poolSell: MARKETS[0].pools[1], cycleAmountRaw: '25000000', minProfitRaw: '50000', dailyFeeLimitLamports: '500000', maxFeePerAttemptLamports: '50000', maxCyclesPerDay: 10, cooldownSeconds: 60, expiresAt: new Date(Date.now() + 23 * 3600000).toISOString(), slippageBps: 50 })
const strategy = (owner: string): Strategy => ({ id: randomUUID(), owner, vaultAddress: '', keeperAddress: '', policy: policy(), status: 'draft', pauseReason: null, balanceUsdcRaw: '0', depositedPrincipalRaw: '0', nonce: '0', confirmedCyclesToday: 0, consecutiveFailures: 0, chainSlot: null, createdAt: now(), updatedAt: now() })
const prepared = (owner: string, action = 'deposit'): PreparedTransaction => ({ transactionBase64: Buffer.from('test unsigned transaction').toString('base64'), messageBase64: Buffer.from(`expected ${owner} ${action}`).toString('base64'), blockhash: 'test-blockhash', lastValidBlockHeight: 999, expiresAt: new Date(Date.now() + 60000).toISOString(), feeLamportsRaw: '5000', cluster: 'localnet', summary: { action, owner, feePayer: owner, recipient: owner, amountRaw: '1000000', token: 'USDC' } })

describe('durable product backend', () => {
  let pool: LocalDatabasePool; let store: ProductStore; let app: Awaited<ReturnType<typeof createApp>>
  const cfg = loadConfig({ SOLANA_CLUSTER: 'localnet', APP_ORIGIN: 'http://localhost:3000', SESSION_SECRET: 's'.repeat(64), BETA_INVITE_WALLETS: `${alice.owner},${bob.owner}`, FEE_ENCRYPTION_KEY: 'a'.repeat(64), RESEND_API_KEY: 'test-email-key', EMAIL_FROM: 'test@example.invalid', BACKUP_DIRECTORY: '.local/test-backup', BACKUP_ENCRYPTION_KEY: 'b'.repeat(64) })
  let broadcasts = 0; let authCookie = ''; let csrf = ''
  let rpcReads = 0
  let rpcParams: unknown[] = []
  let externalVerified = false
  const externalSignature = bs58.encode(new Uint8Array(64).fill(17))
  const confirmedExtraSignature = bs58.encode(new Uint8Array(64).fill(18))
  const chain: ChainGateway = {
    readiness: () => ({ programConfigured: true, fundingEnabled: true, automationEnabled: true, reasons: [] }),
    portfolio: async owner => ({ owner, solBalanceLamports: '0', usdcBalanceRaw: '0', holdings: [], slot: 1, checkedAt: now() }),
    prepareOwnerAction: async (owner, action) => prepared(owner, action),
    verifySignedOwnerTransaction: async (expected, signedBase64) => { assert.equal(signedBase64, expected.transactionBase64); return { signature: `sig-${sha256(expected.messageBase64)}`, wireBase64: signedBase64 } },
    broadcastSignedTransaction: async wire => { broadcasts++; throw new Error(`network interrupted after ${wire.length} bytes`) },
    reconcile: async () => ({ status: 'pending', feeLamportsRaw: '0' }),
    executionPreview: async s => ({ id: randomUUID(), strategyId: s.id, assetMint: s.policy.assetMint, poolBuy: s.policy.poolBuy, poolSell: s.policy.poolSell, startingUsdcRaw: s.policy.cycleAmountRaw, estimatedTokenOutRaw: '100', estimatedReturnedUsdcRaw: '25100000', estimatedProfitUsdcRaw: '100000', minimumProfitUsdcRaw: s.policy.minProfitRaw, estimatedFeeLamports: '5000', estimatedFeeUsdcRaw: '500', simulation: { success: true, unitsConsumed: 100, error: null }, slot: 1, checkedAt: now(), expiresAt: new Date(Date.now() + 30000).toISOString(), status: 'ready', reasons: [], multiplier: '1' }),
    prepareExecution: async s => prepared(s.owner, 'execute'),
    signKeeperTransaction: async p => ({ signature: randomUUID(), wireBase64: p.transactionBase64 }),
    prepareRefund: async owner => prepared(owner, 'fee-refund'),
    feeWalletBalance: async () => '2000000',
    inspectOwnerAction: async (owner, signature, expected) => {
      assert.ok([externalSignature, confirmedExtraSignature].includes(signature))
      if (!externalVerified) return null
      return { kind: expected.action, prepared: prepared(owner, expected.action), payload: {}, wireBase64: 'verified-external-wire', reconciliation: { status: 'confirmed', feeLamportsRaw: '5000', slot: 1000, confirmedAt: now(), usdcDeltaRaw: '0', chainStrategy: { status: 'paused', pauseReason: 'Owner paused on Solana' } } }
    },
  }
  before(async () => {
    pool = new LocalDatabasePool(); await pool.migrate(await readFile(new URL('../migrations/001_product.sql', import.meta.url), 'utf8')); store = new ProductStore(pool)
    app = await createApp({ config: cfg, store, chain, markets: { snapshot: async () => [], readRpc: async (method, params) => { rpcReads++; rpcParams = params; return { method, slot: 500 } } }, logger: false })
  })
  after(async () => { await app?.close(); await store?.close() })
  test('wallet sign-in binds the challenge and consumes it once across concurrent requests', async () => {
    const challenge = await app.inject({ method: 'POST', url: '/api/auth/challenge', headers: { origin: cfg.origin }, payload: { wallet: alice.owner } })
    assert.equal(challenge.statusCode, 200)
    const value = challenge.json(); const signatureBase64 = sign(null, Buffer.from(value.message), alice.privateKey).toString('base64')
    assert.equal(verifyWalletMessage(bob.owner, value.message, signatureBase64), false)
    const payload = { wallet: alice.owner, challengeId: value.challengeId, signatureBase64 }
    const results = await Promise.all([app.inject({ method: 'POST', url: '/api/auth/verify', headers: { origin: cfg.origin }, payload }), app.inject({ method: 'POST', url: '/api/auth/verify', headers: { origin: cfg.origin }, payload })])
    assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 403])
    const success = results.find(r => r.statusCode === 200)!
    authCookie = String(success.headers['set-cookie']).split(';')[0]; csrf = success.json().csrfToken
    assert.match(String(success.headers['set-cookie']), /HttpOnly/); assert.match(String(success.headers['set-cookie']), /SameSite=Strict/)
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/verify', headers: { origin: cfg.origin }, payload })).statusCode, 403)
  })
  test('cross-origin and missing CSRF requests cannot mutate a strategy', async () => {
    const payload = { policy: policy() }
    assert.equal((await app.inject({ method: 'PUT', url: '/api/strategy', headers: { cookie: authCookie, origin: 'https://attacker.invalid', 'x-csrf-token': csrf }, payload })).statusCode, 403)
    assert.equal((await app.inject({ method: 'PUT', url: '/api/strategy', headers: { cookie: authCookie, origin: cfg.origin }, payload })).statusCode, 403)
    const saved = await app.inject({ method: 'PUT', url: '/api/strategy', headers: { cookie: authCookie, origin: cfg.origin, 'x-csrf-token': csrf }, payload })
    assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().strategy.status, 'draft')
  })
  test('RPC reads use the authenticated budget gateway while send methods are rejected', async () => {
    const payload = { jsonrpc: '2.0', id: 27, method: 'getSlot', params: [] }
    assert.equal((await app.inject({ method: 'POST', url: '/api/rpc', headers: { origin: cfg.origin }, payload })).statusCode, 401)
    const headers = { cookie: authCookie, origin: cfg.origin }
    const allowed = await app.inject({ method: 'POST', url: '/api/rpc', headers, payload })
    assert.equal(allowed.statusCode, 200); assert.deepEqual(allowed.json(), { jsonrpc: '2.0', id: 27, result: { method: 'getSlot', slot: 500 } })
    assert.equal((await app.inject({ method: 'POST', url: '/api/rpc', headers, payload: { ...payload, method: 'sendTransaction' } })).statusCode, 400)
    assert.equal(rpcReads, 1)
    const receipt = await app.inject({ method: 'POST', url: '/api/rpc', headers, payload: { ...payload, method: 'getTransaction', params: [externalSignature, { maxSupportedTransactionVersion: 1 }] } })
    assert.equal(receipt.statusCode, 200); assert.equal((rpcParams[1] as Record<string, unknown>).maxSupportedTransactionVersion, 0)
  })
  test('owner transaction signatures are durable before broadcast and ambiguous sends are never retried', async () => {
    const headers = { cookie: authCookie, origin: cfg.origin, 'x-csrf-token': csrf, 'x-idempotency-key': randomUUID() }
    const changedPolicy = await app.inject({ method: 'POST', url: '/api/transactions/prepare', headers, payload: { action: 'deposit', amountRaw: '1000000', policy: policy() } })
    assert.equal(changedPolicy.statusCode, 400)
    const response = await app.inject({ method: 'POST', url: '/api/transactions/prepare', headers, payload: { action: 'deposit', amountRaw: '1000000', external: true, externalUnverified: true, multiplier: 'fake' } })
    assert.equal(response.statusCode, 200, response.body)
    const intent = response.json().intent
    const mismatch = await app.inject({ method: 'POST', url: '/api/transactions/prepare', headers, payload: { action: 'deposit', amountRaw: '2000000' } })
    assert.equal(mismatch.statusCode, 409)
    assert.equal('prepared' in intent, false); assert.equal('payload' in intent, false)
    const submits = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/transactions/submit', headers, payload: { intentId: intent.id, signedTransactionBase64: intent.unsignedTransactionBase64 } })))
    assert.equal(broadcasts, 1); assert.ok(submits.every(r => r.statusCode === 200)); assert.ok(submits.every(r => r.json().intent.status === 'submitted'))
    const saved = await store.intent(alice.owner, intent.id); assert.ok(saved?.signature); assert.ok(saved?.wireBase64)
    assert.equal(saved.payload.externalUnverified, undefined); assert.equal(saved.payload.external, undefined); assert.equal(saved.payload.multiplier, undefined)
    assert.equal(await store.intent(bob.owner, intent.id), null)
    assert.equal(await store.finalize(saved!, { status: 'pending', feeLamportsRaw: '0' }), false)
    assert.equal((await store.activity(alice.owner)).receipts.length, 0)
  })
  test('confirmed failed attempts charge actual fees exactly once and release reservations', async () => {
    const saved = await store.strategy(alice.owner); assert.ok(saved)
    await store.createFeeWallet({ owner: alice.owner, address: 'test-fee-address', encryptedSecret: encryptSecret(new Uint8Array(64), cfg.feeEncryptionKey!, alice.owner), balanceRaw: '0' }); await store.setFeeBalance(alice.owner, '2000000')
    const intent = makeIntent(alice.owner, saved.id, 'execute', randomUUID(), {}, prepared(alice.owner, `execute-${randomUUID()}`), 'test-fee-address', '50000')
    assert.equal(await store.reserveExecution(intent, '500000'), true)
    const pending = await store.markSubmitted(alice.owner, intent.id, `failed-${randomUUID()}`, 'wire'); assert.ok(pending)
    const result = { status: 'failed' as const, feeLamportsRaw: '6123', usdcDeltaRaw: '0', confirmedAt: now(), slot: 999, error: 'Profit guard reverted the transaction' }
    const settled = await Promise.all([store.finalize(pending, result), store.finalize(pending, result)])
    assert.deepEqual(settled.sort(), [false, true]); const state = await store.feeState(alice.owner)
    assert.equal(state.reservedLamports, '0'); assert.equal(state.spentTodayLamports, '6123')
    const receipts = (await store.activity(alice.owner)).receipts.filter(r => r.intentId === intent.id)
    assert.equal(receipts.length, 1); assert.equal(receipts[0].networkFeeLamports, '6123')
  })
  test('concurrent fee funding cannot exceed the cap, and refunds cannot race reserved executions', async () => {
    const owner = alice.owner
    const funding = (amount: string) => makeIntent(owner, null, 'fee-funding', randomUUID(), { amountRaw: amount }, prepared(owner, `fund-${randomUUID()}`), 'test-fee-address')
    const fundResults = await Promise.allSettled([store.createIntent(funding('2000000')), store.createIntent(funding('2000000'))])
    assert.equal(fundResults.filter(r => r.status === 'fulfilled').length, 1)
    const s = await store.strategy(owner); assert.ok(s)
    const execution = makeIntent(owner, s.id, 'execute', randomUUID(), {}, prepared(owner, `reserved-${randomUUID()}`), 'test-fee-address', '50000')
    assert.equal(await store.reserveExecution(execution, '500000'), true)
    const refund = makeIntent(owner, null, 'fee-refund', randomUUID(), { amountRaw: '1000000' }, prepared(owner, 'refund'), 'test-fee-address', '5000')
    await assert.rejects(() => store.createIntent(refund), /pending execution/)
  })
  test('verified-email outbox deduplicates events and records provider acceptance without claiming delivery', async () => {
    const emailToken = randomUUID()
    await store.requestEmailVerification(alice.owner, 'alice@example.invalid', sha256(emailToken), `${cfg.origin}/verify?token=${emailToken}`)
    assert.equal(await store.verifyEmail(sha256(emailToken)), true); assert.equal(await store.verifyEmail(sha256(emailToken)), false)
    await store.enqueue(alice.owner, 'same-event', 'execution', { signature: 'on-chain-signature' }); await store.enqueue(alice.owner, 'same-event', 'execution', { signature: 'on-chain-signature' })
    let sends = 0
    const sender: typeof fetch = async (_url, options) => { sends++; assert.ok((options?.headers as Record<string, string>)['Idempotency-Key']); return new Response(JSON.stringify({ id: `email-${sends}` }), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
    for (let i = 0; i < 8; i++) await deliverNotification(store, cfg, sender)
    const delivery = await store.notificationStatus(alice.owner)
    assert.equal(delivery.filter(row => row.kind === 'execution').length, 1); assert.ok(delivery.some(row => row.status === 'sent'))
    assert.equal(delivery.some(row => row.status === 'delivered'), false)
    assert.ok(sends <= 3)
  })
  test('financial backup retains settlement records inside an authenticated encrypted envelope', async () => {
    const snapshot = await store.financialBackup()
    const envelope = encryptBackup(snapshot, cfg.backupEncryptionKey!)
    assert.equal(envelope.includes(alice.owner), false)
    const restored = decryptBackup(envelope, cfg.backupEncryptionKey!)
    assert.equal(restored.tables.execution_receipts.length, snapshot.tables.execution_receipts.length)
    assert.equal(restored.tables.fee_credit_events.length, snapshot.tables.fee_credit_events.length)
    assert.throws(() => decryptBackup(envelope, 'c'.repeat(64)))
  })
  test('independent owner-action claims stay unresolved until chain verification and never broadcast', async () => {
    const initialBroadcasts = broadcasts
    const headers = { cookie: authCookie, origin: cfg.origin, 'x-csrf-token': csrf }
    const input = { signature: externalSignature, action: 'pause' }
    const claimed = await app.inject({ method: 'POST', url: '/api/transactions/import', headers, payload: input })
    assert.equal(claimed.statusCode, 200, claimed.body); assert.equal(claimed.json().intent.status, 'unresolved')
    assert.equal(claimed.json().intent.reservedFeeLamports, '0')
    assert.equal((await store.activity(alice.owner)).receipts.some(r => r.signature === externalSignature), false)
    const worker = new ProductWorker(store, chain, { snapshot: async () => [] }, cfg)
    await worker.reconcile()
    const pendingClaim = await store.intent(alice.owner, claimed.json().intent.id)
    assert.ok(pendingClaim?.nextReconcileAt); assert.equal(pendingClaim.reconciliationAttempts, 1)
    assert.equal((await store.pendingIntents()).some(value => value.id === pendingClaim.id), false)
    externalVerified = true
    await store.scope(null, async db => { await db.query("UPDATE transaction_intents SET state=state || jsonb_build_object('nextReconcileAt',(now()-interval '1 second')::text) WHERE id=$1", [pendingClaim.id]) })
    await worker.reconcile(); await worker.reconcile()
    const recorded = await app.inject({ method: 'POST', url: '/api/transactions/import', headers, payload: input })
    assert.equal(recorded.json().intent.status, 'confirmed')
    assert.equal((await store.activity(alice.owner)).receipts.filter(r => r.signature === externalSignature).length, 1)
    assert.equal(broadcasts, initialBroadcasts)
  })
  test('server-proven owner receipts import even when ten unverified claims already exist', async () => {
    const s = await store.strategy(alice.owner); assert.ok(s)
    for (let i = 0; i < 10; i++) {
      const claim = makeIntent(alice.owner, s.id, 'pause', randomUUID(), { external: true, externalUnverified: true, expectedAction: 'pause' }, prepared(alice.owner, `unverified-${i}`))
      claim.status = 'unresolved'; claim.signature = bs58.encode(new Uint8Array(64).fill(30 + i)); await store.createIntent(claim)
    }
    const response = await app.inject({ method: 'POST', url: '/api/transactions/import', headers: { cookie: authCookie, origin: cfg.origin, 'x-csrf-token': csrf }, payload: { signature: confirmedExtraSignature, action: 'pause', externalUnverified: false } })
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().intent.status, 'confirmed')
    assert.equal((await store.activity(alice.owner)).receipts.filter(value => value.signature === confirmedExtraSignature).length, 1)
  })
  test('a fair exclusive strategy lease and three confirmed failures block further automation', async () => {
    const challenge = (await app.inject({ method: 'POST', url: '/api/auth/challenge', headers: { origin: cfg.origin }, payload: { wallet: bob.owner } })).json()
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/verify', headers: { origin: cfg.origin }, payload: { wallet: bob.owner, challengeId: challenge.challengeId, signatureBase64: sign(null, Buffer.from(challenge.message), bob.privateKey).toString('base64') } })).statusCode, 200)
    const s = strategy(bob.owner); await store.saveDraft(s); s.status = 'active'; await store.saveChainStrategy(s)
    await store.createFeeWallet({ owner: bob.owner, address: 'bob-test-fee-address', encryptedSecret: encryptSecret(new Uint8Array(64), cfg.feeEncryptionKey!, bob.owner), balanceRaw: '0' }); await store.setFeeBalance(bob.owner, '2000000')
    const leases = await Promise.all([store.leaseStrategy('worker-one'), store.leaseStrategy('worker-two')])
    assert.equal(leases.filter(Boolean).length, 1); await store.releaseLease(s.id, leases[0] ? 'worker-one' : 'worker-two')
    for (let i = 0; i < 3; i++) {
      const attempt = makeIntent(bob.owner, s.id, 'execute', randomUUID(), {}, prepared(bob.owner, `attempt-${i}`), 'bob-test-fee-address', '50000')
      assert.equal(await store.reserveExecution(attempt, '500000'), true)
      const submitted = await store.markSubmitted(bob.owner, attempt.id, `bob-attempt-${i}`, 'wire'); assert.ok(submitted)
      await store.finalize(submitted, { status: 'failed', feeLamportsRaw: '5000', confirmedAt: now(), slot: 1000 + i, error: 'Profit guard reverted execution' })
    }
    const blocked = await store.strategy(bob.owner); assert.equal(blocked?.status, 'blocked'); assert.equal(blocked?.consecutiveFailures, 3)
    assert.equal(await store.leaseStrategy('worker-three'), null)
    await store.saveChainStrategy({ ...blocked!, status: 'active', pauseReason: null })
    assert.equal((await store.strategy(bob.owner))?.status, 'blocked')
  })
  test('successful-cycle cooldown skips quoting and the owner lower daily cycle cap is enforced', async () => {
    const charlie = wallet(); await store.scope(null, async db => { await db.query("INSERT INTO product_users(owner,email,email_verified_at) VALUES($1,'charlie@example.invalid',now())", [charlie.owner]) })
    const s = strategy(charlie.owner); s.policy.maxCyclesPerDay = 2; s.policy.cooldownSeconds = 120
    await store.saveDraft(s); s.status = 'active'; await store.saveChainStrategy(s)
    await store.createFeeWallet({ owner: charlie.owner, address: 'charlie-test-fee', encryptedSecret: encryptSecret(new Uint8Array(64), cfg.feeEncryptionKey!, charlie.owner), balanceRaw: '0' }); await store.setFeeBalance(charlie.owner, '2000000')
    const finalPrepared = prepared(charlie.owner, 'completed'); finalPrepared.summary.multiplier = '1.03'; finalPrepared.summary.multiplierEffectiveAt = '2026-10-15T02:00:00.000Z'
    const completed = makeIntent(charlie.owner, s.id, 'execute', randomUUID(), { multiplier: '1.02', preview: { multiplierEffectiveAt: '2026-10-14T00:00:00.000Z', mintFingerprint: 'unconfirmed-preview' } }, finalPrepared, 'charlie-test-fee', '5000')
    assert.equal(await store.reserveExecution(completed, '500000'), true)
    const submitted = await store.markSubmitted(charlie.owner, completed.id, 'charlie-confirmed', 'wire'); assert.ok(submitted)
    await store.finalize(submitted, { status: 'confirmed', feeLamportsRaw: '5000', usdcDeltaRaw: '51000', confirmedAt: now(), slot: 1100, mintFingerprint: 'a'.repeat(64), assetReceivedRaw: '123456789', multiplierEffectiveAt: '2026-10-15T00:00:00.000Z' })
    const receipt = (await store.activity(charlie.owner)).receipts.find(value => value.intentId === completed.id)!
    assert.equal(receipt.mintFingerprint, 'a'.repeat(64)); assert.equal(receipt.assetReceivedRaw, '123456789')
    assert.equal(receipt.multiplierEffectiveAt, '2026-10-15T00:00:00.000Z'); assert.equal(receipt.multiplier, '1.03')
    let quotes = 0
    const gateway = { ...chain, executionPreview: async (value: Strategy) => { quotes++; return chain.executionPreview(value) } }
    const worker = new ProductWorker(store, gateway, { snapshot: async () => [] }, { ...cfg, inviteWallets: [...cfg.inviteWallets, charlie.owner] })
    await (worker as unknown as { executeOne(): Promise<void> }).executeOne()
    assert.equal(quotes, 0); assert.equal((await store.strategy(charlie.owner))?.status, 'active')
    const next = makeIntent(charlie.owner, s.id, 'execute', randomUUID(), {}, prepared(charlie.owner, 'next'), 'charlie-test-fee', '5000')
    assert.equal(await store.reserveExecution(next, '500000', 2, 120), false)
    await store.scope(null, async db => { await db.query("UPDATE execution_receipts SET occurred_at=now()-interval '3 minutes' WHERE intent_id=$1", [completed.id]) })
    assert.equal(await store.reserveExecution(next, '500000', 1, 120), false)
    assert.equal(await store.reserveExecution(next, '500000', 2, 120), true)
  })
  test('loss of verified notification email pauses an existing authorization before quoting or signing', async () => {
    const owner = wallet().owner; const s = strategy(owner)
    await store.scope(null, async db => { await db.query("INSERT INTO product_users(owner,email,email_verified_at) VALUES($1,'old@example.invalid',now())", [owner]) })
    await store.saveDraft(s); s.status = 'active'; await store.saveChainStrategy(s)
    await store.requestEmailVerification(owner, 'new@example.invalid', sha256('new-email-token'), `${cfg.origin}/verify?token=new-email-token`)
    let quotes = 0; let signatures = 0
    const gateway = { ...chain, executionPreview: async (value: Strategy) => { quotes++; return chain.executionPreview(value) }, signKeeperTransaction: async (value: PreparedTransaction) => { signatures++; return { signature: randomUUID(), wireBase64: value.transactionBase64 } } }
    const worker = new ProductWorker(store, gateway, { snapshot: async () => [] }, { ...cfg, inviteWallets: [...cfg.inviteWallets, owner] })
    await (worker as unknown as { executeOne(): Promise<void> }).executeOne()
    assert.equal(quotes, 0); assert.equal(signatures, 0); assert.equal((await store.strategy(owner))?.status, 'blocked')
    assert.match((await store.strategy(owner))?.pauseReason || '', /Verify your current notification email/)
  })
  test('unverified historical owner-action claims cannot deadlock renewed execution leases or reserve fees', async () => {
    const owner = wallet().owner; const s = strategy(owner)
    await store.scope(null, async db => { await db.query('INSERT INTO product_users(owner) VALUES($1)', [owner]) })
    await store.saveDraft(s); s.status = 'paused'; await store.saveChainStrategy(s)
    await store.createFeeWallet({ owner, address: 'renewal-test-fee', encryptedSecret: encryptSecret(new Uint8Array(64), cfg.feeEncryptionKey!, owner), balanceRaw: '0' }); await store.setFeeBalance(owner, '2000000')
    const claim = makeIntent(owner, s.id, 'withdraw', randomUUID(), { external: true, externalUnverified: true, expectedAction: 'withdraw', amountRaw: '1000000' }, prepared(owner, 'unknown-exit'))
    claim.status = 'unresolved'; claim.signature = bs58.encode(new Uint8Array(64).fill(21)); await store.createIntent(claim)
    const renewal = makeIntent(owner, s.id, 'configure', randomUUID(), { enable: true, policy: s.policy }, prepared(owner, 'renewal'))
    await store.createIntent(renewal); const submitted = await store.markSubmitted(owner, renewal.id, 'confirmed-renewal', 'owner-signed-wire'); assert.ok(submitted)
    await store.finalize(submitted, { status: 'confirmed', feeLamportsRaw: '5000', confirmedAt: now(), slot: 1250, chainStrategy: { status: 'active', pauseReason: null } })
    const leased = await store.leaseStrategy('renewal-worker', owner); assert.equal(leased?.id, s.id)
    const cycle = makeIntent(owner, s.id, 'execute', randomUUID(), {}, prepared(owner, 'renewed-cycle'), 'renewal-test-fee', '5000')
    assert.equal(await store.reserveExecution(cycle, '500000'), true)
    assert.equal((await store.intent(owner, claim.id))?.status, 'unresolved')
    assert.equal((await store.activity(owner)).receipts.some(value => value.intentId === claim.id), false)
    assert.equal((await store.feeState(owner)).spentTodayLamports, '0'); await store.releaseLease(s.id, 'renewal-worker')
  })
  test('founder canary readiness is bound to the authenticated owner and never enables other invites', async () => {
    const canaryChain = { ...chain, readiness: (owner?: string) => ({ programConfigured: true, fundingEnabled: owner === alice.owner, automationEnabled: owner === alice.owner, reasons: owner === alice.owner ? [] : ['Founder canary is restricted to its approved owner'] }) }
    const canary = await createApp({ config: { ...cfg, canaryApproved: true, canaryOwner: alice.owner }, store, chain: canaryChain, markets: { snapshot: async () => [] }, logger: false })
    try {
      const anonymous = (await canary.inject('/api/config')).json()
      assert.equal(anonymous.fundingEnabled, false)
      const founder = (await canary.inject({ url: '/api/config', headers: { cookie: authCookie } })).json()
      assert.equal(founder.fundingEnabled, true); assert.equal(founder.phase, 'canary')
      const challenge = (await canary.inject({ method: 'POST', url: '/api/auth/challenge', headers: { origin: cfg.origin }, payload: { wallet: bob.owner } })).json()
      const verified = await canary.inject({ method: 'POST', url: '/api/auth/verify', headers: { origin: cfg.origin }, payload: { wallet: bob.owner, challengeId: challenge.challengeId, signatureBase64: sign(null, Buffer.from(challenge.message), bob.privateKey).toString('base64') } })
      const cookieValue = String(verified.headers['set-cookie']).split(';')[0]
      const other = (await canary.inject({ url: '/api/config', headers: { cookie: cookieValue } })).json()
      assert.equal(other.fundingEnabled, false); assert.equal(other.automationEnabled, false)
      const deposit = await canary.inject({ method: 'POST', url: '/api/transactions/prepare', headers: { cookie: cookieValue, origin: cfg.origin, 'x-csrf-token': verified.json().csrfToken, 'x-idempotency-key': randomUUID() }, payload: { action: 'deposit', amountRaw: '1000000' } })
      assert.equal(deposit.statusCode, 503)
    } finally { await canary.close() }
  })
  test('email quota failures persist a pause and queued retry without changing accounting', async () => {
    const receiptsBefore = (await store.activity(alice.owner)).receipts.length
    await store.enqueue(alice.owner, 'quota-event', 'execution', { signature: 'quota-notification-test' })
    let attempts = 0
    const limited: typeof fetch = async () => { attempts++; return new Response('{}', { status: 429 }) }
    for (let i = 0; i < 20; i++) await deliverNotification(store, cfg, limited)
    assert.equal(attempts, 1); assert.match((await store.notificationServicePause()) || '', /quota/)
    assert.equal((await app.inject({ url: '/api/config', headers: { cookie: authCookie } })).json().automationEnabled, false)
    assert.equal((await store.activity(alice.owner)).receipts.length, receiptsBefore)
    const queued = await store.scope(alice.owner, async db => (await db.query("SELECT id FROM notification_outbox WHERE owner=$1 AND last_error='Email provider returned 429'", [alice.owner])).rows[0]); assert.ok(queued)
    await store.scope(null, async db => {
      await db.query('UPDATE notification_outbox SET next_attempt_at=now(),attempts=6 WHERE id=$1', [queued.id])
      await db.query("UPDATE operator_settings SET value=value || jsonb_build_object('nextProbeAt',(now()-interval '1 second')::text) WHERE key='notification-service-pause'")
    })
    const recovered: typeof fetch = async () => new Response(JSON.stringify({ id: 'quota-recovered' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    await deliverNotification(store, cfg, recovered)
    assert.equal(await store.notificationServicePause(), null)
    assert.equal((await store.activity(alice.owner)).receipts.length, receiptsBefore)
    assert.equal((await store.notificationStatus(alice.owner)).find(row => row.id === queued.id)?.status, 'sent')
  })
})

test('secret envelopes authenticate both key and owner, and malformed raw values are rejected', () => {
  const secret = new Uint8Array(64).fill(19); const encrypted = encryptSecret(secret, '1'.repeat(64), alice.owner)
  assert.deepEqual(decryptSecret(encrypted, '1'.repeat(64), alice.owner), secret)
  assert.throws(() => decryptSecret(encrypted, '1'.repeat(64), bob.owner)); assert.throws(() => decryptSecret(encrypted, '2'.repeat(64), alice.owner))
  assert.throws(() => validatePolicy({ ...policy(), cycleAmountRaw: '25000001' })); assert.throws(() => validatePolicy({ ...policy(), cycleAmountRaw: '1e6' })); assert.throws(() => validatePolicy({ ...policy(), poolBuy: MARKETS[1].pools[0] })); assert.throws(() => validatePolicy({ ...policy(), expiresAt: new Date(Date.now() + 25 * 3600000).toISOString() }))
  assert.equal(feeAvailable('1000000', '50000', '450000', '500000', '5000').allowed, false)
  assert.equal(feeAvailable('10000', '6000', '0', '500000', '5000').allowed, false)
  assert.equal(feeAvailable('1000000', '0', '0', '500000', '50001').allowed, false)
  // Make sure the fixture private key is an Ed25519 key, never an application configuration key.
  assert.equal(createPrivateKey({ key: alice.privateKey.export({ type: 'pkcs8', format: 'der' }), type: 'pkcs8', format: 'der' }).asymmetricKeyType, 'ed25519')
})
test('production sessions require HTTPS and HTTP is limited to loopback development', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'http://doubletake.example' }), /HTTPS/)
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'http://localhost:3000' }), /HTTPS/)
  assert.throws(() => loadConfig({ APP_ORIGIN: 'http://doubletake.example' }), /HTTPS/)
  assert.equal(loadConfig({ APP_ORIGIN: 'http://127.0.0.1:3000' }).cookieSecure, false)
  assert.equal(loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://doubletake.example' }).cookieSecure, true)
})
test('remote database connections require verified TLS and cannot override trusted CA or hostname verification', () => {
  const base = { NODE_ENV: 'production', APP_ORIGIN: 'https://doubletake.example', SESSION_SECRET: 's'.repeat(64) }
  const url = 'postgresql://operator:example-test-password@db.example.invalid:5432/product'
  for (const suffix of ['', '?sslmode=disable', '?sslmode=require', '?sslmode=verify-ca', '?sslmode=no-verify']) assert.throws(() => loadConfig({ ...base, DATABASE_URL: url + suffix }), /verify-full/)
  assert.throws(() => loadConfig({ ...base, DATABASE_URL: `${url}?sslmode=verify-full&ssl=false` }), /parameters/)
  assert.throws(() => loadConfig({ ...base, DATABASE_URL: `${url}?sslmode=verify-full&sslrootcert=arbitrary.pem` }), /DATABASE_CA_CERT/)
  assert.throws(() => postgresConnectionOptions('postgres://operator:test@localhost/product?host=remote.example.invalid', { production: false }), /parameters/)
  assert.equal(postgresConnectionOptions('postgres://operator:test@127.0.0.1/product', { production: false }).ssl, false)
  const certificate = rootCertificates[0]
  const config = loadConfig({ ...base, DATABASE_URL: `${url}?sslmode=verify-full`, DATABASE_CA_CERT: certificate.replace(/\n/g, '\\n') })
  const options = postgresConnectionOptions(config.databaseUrl!, { production: true, caPem: config.databaseCaCert })
  const client = new pg.Client(options)
  const ssl = (client as unknown as { connectionParameters: { ssl: ConnectionOptions } }).connectionParameters.ssl
  assert.equal(ssl.rejectUnauthorized, true); assert.equal(ssl.ca, certificate.trim()); assert.equal(ssl.servername, 'db.example.invalid')
  assert.ok(ssl.checkServerIdentity?.('different.example.invalid', new X509Certificate(certificate).toLegacyObject()))
  assert.throws(() => loadConfig({ ...base, DATABASE_URL: `${url}?sslmode=verify-full`, DATABASE_CA_CERT: 'invalid certificate' }), /PEM/)
})
test('production runtime role rejects bypass privileges and membership while actual owner RLS protects foreign rows', async () => {
  const pool = new LocalDatabasePool(); const store = new ProductStore(pool, { production: true })
  try {
    await pool.migrate(await readFile(new URL('../migrations/001_product.sql', import.meta.url), 'utf8'))
    await pool.db.query('INSERT INTO product_users(owner) VALUES($1),($2)', [alice.owner, bob.owner])
    assert.equal(await store.healthy(), false); assert.match(store.readinessProblem() || '', /NOSUPERUSER|NOBYPASSRLS/)
    await pool.db.exec("CREATE ROLE doubletake_runtime_test NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT; GRANT USAGE ON SCHEMA public TO doubletake_runtime_test; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO doubletake_runtime_test; GRANT USAGE,SELECT ON SEQUENCE fee_credit_events_id_seq,market_observations_id_seq TO doubletake_runtime_test; SET ROLE doubletake_runtime_test;")
    assert.equal(await store.healthy(), true); assert.equal(store.readinessProblem(), null)
    await store.saveObservations([{ symbol: 'SOL', checkedAt: now() }])
    assert.equal(await store.scope(null, async db => (await db.query('SELECT count(*)::int AS count FROM market_observations')).rows[0].count), 1)
    const rows = await store.scope(alice.owner, async db => (await db.query('SELECT owner FROM product_users')).rows)
    assert.deepEqual(rows.map(row => row.owner), [alice.owner])
    assert.equal(await store.scope(alice.owner, async db => (await db.query('UPDATE product_users SET email=$1 WHERE owner=$2', ['forged@example.invalid', bob.owner])).rowCount), 0)
    await assert.rejects(() => store.scope(alice.owner, async db => { await db.query('INSERT INTO product_users(owner) VALUES($1)', [wallet().owner]) }), /row-level security/)
    await pool.db.exec('RESET ROLE; CREATE ROLE doubletake_privileged_test NOLOGIN NOSUPERUSER BYPASSRLS; GRANT doubletake_privileged_test TO doubletake_runtime_test; SET ROLE doubletake_runtime_test;')
    assert.equal(await store.healthy(), false); assert.match(store.readinessProblem() || '', /membership/)
    await assert.rejects(() => store.scope(alice.owner, async db => { await db.query('SELECT owner FROM product_users') }), DatabaseRoleFailure)
    const config = loadConfig({ SOLANA_CLUSTER: 'localnet' })
    const chain = { readiness: () => ({ programConfigured: true, fundingEnabled: true, automationEnabled: true, reasons: [] }) } as ChainGateway
    const app = await createApp({ config, store, chain, markets: { snapshot: async () => [] }, logger: false })
    try { const readiness = (await app.inject('/api/config')).json(); assert.equal(readiness.fundingEnabled, false); assert.match(readiness.readiness.reasons.join(' '), /NOBYPASSRLS/) } finally { await app.close() }
  } finally { await pool.db.exec('RESET ROLE').catch(() => {}); await store.close() }
})
test('execution preview requires freshness, successful simulation and the fee-cost buffer', () => {
  const preview = { status: 'ready', simulation: { success: true }, estimatedProfitUsdcRaw: '50500', estimatedFeeLamports: '5000', estimatedFeeUsdcRaw: '400', checkedAt: now(), expiresAt: new Date(Date.now() + 30000).toISOString() } as Parameters<typeof qualifyingPreview>[0]
  assert.equal(qualifyingPreview(preview, '50000'), true)
  assert.equal(qualifyingPreview({ ...preview, estimatedProfitUsdcRaw: '50499' }, '50000'), false)
  assert.equal(qualifyingPreview({ ...preview, expiresAt: new Date(Date.now() - 1).toISOString() }, '50000'), false)
})
test('the spot and pool-fee screen rejects impossible cycles without declaring profit', () => {
  const s = strategy(alice.owner)
  const market = { status: 'available', checkedAt: now(), pools: [{ poolId: s.policy.poolBuy, status: 'available', priceUsd: 100, feeBps: 30 }, { poolId: s.policy.poolSell, status: 'available', priceUsd: 100.05, feeBps: 30 }] } as MarketSnapshot
  assert.equal(passesSpotScreen(s, market), false)
  const candidate = { ...market, pools: market.pools.map((pool, i) => ({ ...pool, priceUsd: i ? 102 : 100 })) }
  assert.equal(passesSpotScreen(s, candidate), true)
  assert.equal(passesSpotScreen(s, { ...candidate, status: 'stale' }), false)
  assert.equal(passesSpotScreen(s, { ...candidate, checkedAt: new Date(Date.now() - 20000).toISOString() }), false)
})
test('unconfigured production exposes real market data and actionable feature gates', async () => {
  const config = loadConfig({ SOLANA_CLUSTER: 'devnet' })
  const chain = { readiness: () => ({ programConfigured: false, fundingEnabled: false, automationEnabled: false, reasons: ['Program deployment not verified'] }) } as ChainGateway
  const app = await createApp({ config, store: null, chain, markets: { snapshot: async () => [] }, logger: false })
  try {
    assert.equal((await app.inject('/api/markets')).statusCode, 200)
    const status = (await app.inject('/api/config')).json(); assert.equal(status.fundingEnabled, false); assert.equal(status.automationEnabled, false); assert.match(status.readiness.reasons.join(' '), /Postgres/)
    assert.equal((await app.inject('/api/strategy')).statusCode, 503)
    assert.equal((await app.inject({ method: 'POST', url: '/api/notifications/webhook', payload: {} })).statusCode, 503)
  } finally { await app.close() }
  assert.throws(() => loadConfig({ SOLANA_CLUSTER: 'mainnet-beta', DATABASE_URL: 'pglite:.local/db', SESSION_SECRET: 'x'.repeat(32) }), /only for localnet/)
  assert.throws(() => loadConfig({ CANARY_APPROVED: 'true' }), /must be an invited/)
})
test('static assets built after startup are served as files and missing modules return 404', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'doubletake-static-'))
  const config = { ...loadConfig({ SOLANA_CLUSTER: 'devnet' }), staticDirectory: directory }
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>DoubleTake</title>')
  const chain = { readiness: () => ({ programConfigured: false, fundingEnabled: false, automationEnabled: false, reasons: [] }) } as ChainGateway
  const app = await createApp({ config, store: null, chain, markets: { snapshot: async () => [] }, logger: false })
  try {
    await writeFile(path.join(directory, 'new-build.js'), 'export const currentBuild = true;')
    const module = await app.inject('/new-build.js')
    assert.equal(module.statusCode, 200); assert.match(String(module.headers['content-type']), /javascript/); assert.match(module.body, /currentBuild/)
    const missing = await app.inject('/assets/missing-build.js')
    assert.equal(missing.statusCode, 404); assert.equal(missing.body.includes('<!doctype html>'), false)
  } finally {
    await app.close()
    const absolute = path.resolve(directory); const tempRoot = path.resolve(tmpdir()) + path.sep
    assert.ok(absolute.startsWith(tempRoot) && path.basename(absolute).startsWith('doubletake-static-'))
    await rm(absolute, { recursive: true, force: true })
  }
})
