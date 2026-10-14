import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto'
import Fastify, { type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import staticPlugin from '@fastify/static'
import { existsSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import { BETA_LIMITS, marketByMint } from '../shared/registry.ts'
import type { FeeCredit, RuntimeConfig, Strategy, StrategyPolicy, TransactionIntent } from '../shared/types.ts'
import type { ActionKind, BackendConfig, ChainGateway, IntentRecord, MarketGateway, PreparedTransaction } from './ports.ts'
import { authMessage, encryptSecret, integer, requireEmail, sha256, token, validWallet, verifyWalletMessage } from './security.ts'
import { DatabaseRoleFailure, type ProductStore, type Session } from './store.ts'

export class ApiFailure extends Error { constructor(public readonly statusCode: number, public readonly code: string, message: string, public readonly reasons?: string[]) { super(message) } }
function body(req: FastifyRequest): Record<string, unknown> { if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new ApiFailure(400, 'INVALID_INPUT', 'A JSON object is required'); return req.body as Record<string, unknown> }
function idempotency(req: FastifyRequest, value: Record<string, unknown>) {
  const key = req.headers['x-idempotency-key'] || value.idempotencyKey
  if (typeof key !== 'string' || !/^[A-Za-z0-9:_-]{8,100}$/.test(key)) throw new ApiFailure(400, 'IDEMPOTENCY_REQUIRED', 'Supply an X-Idempotency-Key for this action')
  return key
}
export function validatePolicy(value: unknown, now = Date.now()): StrategyPolicy {
  if (!value || typeof value !== 'object') throw new Error('A strategy policy is required')
  const p = value as Record<string, unknown>
  const asset = marketByMint(String(p.assetMint))
  if (!asset) throw new Error('Select a supported asset')
  if (p.poolBuy === p.poolSell || !asset.pools.includes(String(p.poolBuy)) || !asset.pools.includes(String(p.poolSell))) throw new Error('Select the two approved pools for this asset')
  const expires = typeof p.expiresAt === 'string' ? Date.parse(p.expiresAt) : NaN
  if (!Number.isFinite(expires) || expires <= now || expires > now + BETA_LIMITS.permissionSeconds * 1000) throw new Error('Automation permission must expire within 24 hours')
  const maxCyclesPerDay = p.maxCyclesPerDay ?? 10; const cooldownSeconds = p.cooldownSeconds ?? 60; const slippageBps = p.slippageBps ?? 50
  if (!Number.isInteger(maxCyclesPerDay) || Number(maxCyclesPerDay) < 1 || Number(maxCyclesPerDay) > 10) throw new Error('Daily cycle limit must be between 1 and 10')
  if (!Number.isInteger(cooldownSeconds) || Number(cooldownSeconds) < 60 || Number(cooldownSeconds) > 86400) throw new Error('Cooldown must be at least 60 seconds')
  if (!Number.isInteger(slippageBps) || Number(slippageBps) < 1 || Number(slippageBps) > 50) throw new Error('Slippage must be between 1 and 50 basis points')
  return { assetMint: asset.mint, poolBuy: String(p.poolBuy), poolSell: String(p.poolSell), cycleAmountRaw: integer(p.cycleAmountRaw, 'Cycle amount', 1n, 25000000n), minProfitRaw: integer(p.minProfitRaw, 'Minimum profit', 50000n), dailyFeeLimitLamports: integer(p.dailyFeeLimitLamports, 'Daily SOL allowance', 5000n, 500000n), maxFeePerAttemptLamports: integer(p.maxFeePerAttemptLamports ?? '50000', 'Per-attempt SOL limit', 5000n, 50000n), maxCyclesPerDay: Number(maxCyclesPerDay), cooldownSeconds: Number(cooldownSeconds), expiresAt: new Date(expires).toISOString(), slippageBps: Number(slippageBps) }
}
export function publicIntent(intent: IntentRecord): TransactionIntent {
  const safe = { ...intent } as Record<string, unknown>
  for (const key of ['idempotencyKey', 'payload', 'prepared', 'wireBase64', 'feeWallet']) delete safe[key]
  return safe as unknown as TransactionIntent
}
export function makeIntent(owner: string, strategyId: string | null, kind: ActionKind, key: string, payload: Record<string, unknown>, prepared: PreparedTransaction, feeWallet: string | null = null, reserved = '0'): IntentRecord {
  const now = new Date().toISOString()
  return { id: randomUUID(), owner, strategyId, kind, status: 'prepared', idempotencyKey: key, payload, prepared, wireBase64: null, feeWallet, unsignedTransactionBase64: prepared.transactionBase64, messageHash: sha256(prepared.messageBase64), feePayer: prepared.summary.feePayer, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight, signature: null, expectedUsdcDeltaRaw: typeof payload.amountRaw === 'string' && kind === 'deposit' ? payload.amountRaw : null, reservedFeeLamports: reserved, summary: { title: prepared.summary.action, recipient: prepared.summary.recipient || owner, amountRaw: prepared.summary.amountRaw || null, token: prepared.summary.token || (kind.startsWith('fee-') ? 'SOL' : 'USDC'), cluster: prepared.cluster, networkFeeLamports: prepared.feeLamportsRaw }, createdAt: now, updatedAt: now, error: null }
}
export interface AppDependencies { config: BackendConfig; store: ProductStore | null; chain: ChainGateway; markets: MarketGateway; logger?: boolean }
export async function createApp({ config, store, chain, markets, logger = true }: AppDependencies) {
  const app = Fastify({ logger: logger ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body', 'res.headers.set-cookie'], serializers: { req: req => ({ method: req.method, url: req.url.split('?')[0], id: req.id }) } } : false, bodyLimit: 100000, trustProxy: false })
  await app.register(cookie)
  const sessions = new WeakMap<object, Session>()
  const rates = new Map<string, { count: number; until: number }>()
  let databaseReady = false; let readinessCheckedAt = 0
  async function requireStore() {
    if (!store) throw new ApiFailure(503, 'DATABASE_REQUIRED', 'Connect Postgres and configure the invite beta to use accounts and strategies')
    if (Date.now() - readinessCheckedAt > 10000) { databaseReady = await store.healthy(); readinessCheckedAt = Date.now() }
    if (!databaseReady) throw new ApiFailure(503, 'DATABASE_UNAVAILABLE', store.readinessProblem() || 'The account database is unavailable; try again shortly')
    return store
  }
  function csrf(sessionToken: string) { return createHmac('sha256', config.sessionSecret).update(sessionToken).digest('base64url') }
  async function authenticate(req: FastifyRequest, checkCsrf = true) {
    const cached = sessions.get(req); if (cached) return cached
    const db = await requireStore(); const raw = req.cookies.dt_session
    if (!raw || raw.length > 100) throw new ApiFailure(401, 'SIGN_IN_REQUIRED', 'Connect your invited wallet and sign in')
    const session = await db.session(sha256(raw))
    if (!session) throw new ApiFailure(401, 'SESSION_EXPIRED', 'Sign in again with your wallet')
    if (checkCsrf && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && sha256(String(req.headers['x-csrf-token'] || '')) !== session.csrfHash) throw new ApiFailure(403, 'CSRF_FAILED', 'Refresh your session before submitting this action')
    sessions.set(req, session); return session
  }
  app.addHook('onRequest', async req => {
    if (!req.url.startsWith('/api/')) return
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.url !== '/api/notifications/webhook' && req.headers.origin !== config.origin) throw new ApiFailure(403, 'ORIGIN_FAILED', 'Requests must come from the DoubleTake application origin')
    const now = Date.now(); const key = `${req.ip}:${req.url.startsWith('/api/auth/') ? 'auth' : 'api'}`
    const current = rates.get(key); const limit = req.url.startsWith('/api/auth/') ? 20 : 120
    if (!current || current.until <= now) rates.set(key, { count: 1, until: now + 60000 })
    else if (++current.count > limit) throw new ApiFailure(429, 'RATE_LIMITED', 'Too many requests; try again in a minute')
    if (rates.size > 5000) for (const [k, entry] of rates) if (entry.until < now) rates.delete(k)
  })
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ApiFailure) return reply.code(error.statusCode).send({ error: error.message, code: error.code, reasons: error.reasons })
    if (error instanceof DatabaseRoleFailure) return reply.code(503).send({ error: error.message, code: 'DATABASE_ROLE_UNSAFE' })
    const sqlCode = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (sqlCode === '23505') return reply.code(409).send({ error: 'An action is already pending; inspect Activity before retrying', code: 'ACTION_PENDING' })
    if (error instanceof Error && error.message.startsWith('Transaction simulation failed:')) return reply.code(422).send({ error: 'Solana simulation rejected this action. Check your wallet SOL and token balances, and the current vault permissions.', code: 'SIMULATION_FAILED' })
    if (error instanceof Error && /^(Create the owner vault|Changing assets requires|The strategy has insufficient|Withdrawal exceeds|Deposited principal exceeds|Refund exceeds|Wait for pending|The prepaid SOL cap|Email verification is limited)/.test(error.message)) return reply.code(409).send({ error: error.message.slice(0, 250), code: 'ACTION_BLOCKED' })
    if (error instanceof Error && /must be|required|Select |within 24|permitted|Cooldown|Slippage|Enter a valid|Idempotency|owner-signed|beta is full/.test(error.message)) return reply.code(400).send({ error: error.message, code: 'INVALID_INPUT' })
    return reply.code(503).send({ error: 'This service is temporarily unavailable; no new action was confirmed', code: 'SERVICE_UNAVAILABLE' })
  })
  async function runtimeConfig(owner?: string): Promise<RuntimeConfig> {
    const ready = chain.readiness(owner); const reasons = [...ready.reasons]
    const dbReady = store ? await store.healthy() : false
    if (!dbReady) reasons.push(store?.readinessProblem() || 'Postgres account and transaction database is not configured or available')
    if (!config.inviteWallets.length) reasons.push('The five-wallet invite allowlist is not configured')
    if (!config.feeEncryptionKey) reasons.push('The prepaid fee-wallet encryption key is not configured')
    if (!config.resendApiKey || !config.emailFrom) reasons.push('A verified sending domain and email delivery credentials are required')
    if (!config.backupDirectory || !config.backupEncryptionKey) reasons.push('Configure an encrypted daily backup directory on persistent storage')
    const notificationPause = dbReady && store ? await store.notificationServicePause() : null
    const operatorPaused = config.killSwitch || config.serviceBudgetExhausted || (dbReady && store ? await store.operatorPaused() : false)
    if (operatorPaused) reasons.push('Automation is paused by the operator or service budget limit')
    if (notificationPause) reasons.push(notificationPause)
    const fundingEnabled = ready.fundingEnabled && dbReady && Boolean(config.feeEncryptionKey) && Boolean(config.inviteWallets.length) && Boolean(config.backupDirectory && config.backupEncryptionKey)
    const automationEnabled = ready.automationEnabled && fundingEnabled && !operatorPaused && !notificationPause && Boolean(config.resendApiKey && config.emailFrom)
    const founderCanary = Boolean(owner && config.canaryApproved && config.canaryOwner === owner && !chain.readiness().fundingEnabled && fundingEnabled)
    return { cluster: config.cluster, programId: process.env.SOLANA_PROGRAM_ID || process.env.PROGRAM_ID || null, rpcEndpoint: '/api/rpc', phase: founderCanary ? 'canary' : fundingEnabled ? 'invite-beta' : ready.programConfigured ? 'verification-required' : 'configuration-required', readiness: { ready: !reasons.length, reasons }, fundingEnabled, automationEnabled, upgradeAuthority: process.env.PROGRAM_UPGRADE_AUTHORITY || null, limits: BETA_LIMITS }
  }
  app.get('/api/config', async req => {
    let owner: string | undefined
    if (store && req.cookies.dt_session) { try { owner = (await authenticate(req)).owner } catch { /* Public readiness remains available while accounts are unavailable. */ } }
    return runtimeConfig(owner)
  })
  app.get('/health/live', async () => ({ status: 'ok' }))
  app.get('/healthz', async () => ({ status: 'ok' }))
  app.get('/health/ready', async (_req, reply) => { const ready = store ? await store.healthy() : false; return reply.code(ready || !store ? 200 : 503).send({ status: ready ? 'ready' : store ? 'degraded' : 'configuration-required', accountsReady: ready }) })
  app.get('/api/markets', async () => ({ markets: await markets.snapshot() }))
  app.post('/api/rpc', async req => {
    await authenticate(req, false) // The proxy is read-only, but requires an account to protect its RPC allowance.
    const input = body(req)
    const allowed = ['getLatestBlockhash', 'getBalance', 'getAccountInfo', 'getMultipleAccounts', 'getSignatureStatuses', 'getTransaction', 'getSlot', 'getBlockHeight', 'getVersion', 'getRecentPrioritizationFees', 'isBlockhashValid']
    if (input.jsonrpc !== '2.0' || typeof input.method !== 'string' || !allowed.includes(input.method) || !Array.isArray(input.params) || input.params.length > 10) throw new ApiFailure(400, 'RPC_METHOD_BLOCKED', 'This RPC method is not available through the application')
    if (input.method === 'getTransaction') {
      const options = input.params[1] && typeof input.params[1] === 'object' ? input.params[1] as Record<string, unknown> : {}
      input.params[1] = { ...options, maxSupportedTransactionVersion: 0 }
    }
    if (!markets.readRpc) throw new ApiFailure(503, 'RPC_UNAVAILABLE', 'The authenticated RPC proxy is unavailable')
    return { jsonrpc: '2.0', id: input.id ?? null, result: await markets.readRpc(input.method, input.params) }
  })
  app.post('/api/auth/challenge', async req => {
    const input = body(req); const owner = input.wallet || input.owner
    if (!validWallet(owner)) throw new ApiFailure(400, 'INVALID_WALLET', 'Supply a valid Solana wallet')
    const db = await requireStore()
    if (!config.inviteWallets.includes(owner) && !await db.knownUser(owner)) throw new ApiFailure(403, 'INVITE_REQUIRED', 'This beta is available to invited wallets')
    const issued = new Date(); const expires = new Date(issued.getTime() + 300000); const id = randomUUID(); const nonce = token()
    const message = authMessage(owner, config.origin, config.cluster, nonce, issued.toISOString(), expires.toISOString())
    await db.createChallenge({ id, owner, message, expiresAt: expires.toISOString(), consumedAt: null })
    return { challengeId: id, message, expiresAt: expires.toISOString(), cluster: config.cluster }
  })
  app.post('/api/auth/verify', async (req, reply) => {
    const input = body(req); const owner = input.wallet || input.owner; const id = input.challengeId; const signature = input.signatureBase64 || input.signature
    if (!validWallet(owner) || typeof id !== 'string' || typeof signature !== 'string') throw new ApiFailure(403, 'AUTH_FAILED', 'The wallet sign-in could not be verified')
    const db = await requireStore()
    if (!config.inviteWallets.includes(owner) && !await db.knownUser(owner)) throw new ApiFailure(403, 'AUTH_FAILED', 'The wallet is not a member of this beta')
    const challenge = await db.challenge(owner, id)
    if (!challenge || challenge.consumedAt || Date.parse(challenge.expiresAt) <= Date.now() || !verifyWalletMessage(owner, challenge.message, signature)) throw new ApiFailure(403, 'AUTH_FAILED', 'This sign-in challenge is invalid, expired or already used')
    const sessionToken = token(); const csrfToken = csrf(sessionToken); const expiresAt = new Date(Date.now() + 86400000).toISOString()
    if (!await db.consumeChallengeAndSession(owner, id, sha256(sessionToken), sha256(csrfToken), expiresAt)) throw new ApiFailure(403, 'CHALLENGE_USED', 'This sign-in challenge was already used')
    reply.setCookie('dt_session', sessionToken, { path: '/', httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', maxAge: 86400 })
    return { user: { wallet: owner, invited: config.inviteWallets.includes(owner), expiresAt }, csrfToken }
  })
  app.get('/api/auth/session', async req => {
    if (!store || !req.cookies.dt_session) return { user: null }
    try { const session = await authenticate(req); return { user: { wallet: session.owner, invited: config.inviteWallets.includes(session.owner), expiresAt: session.expiresAt }, csrfToken: csrf(req.cookies.dt_session!) } } catch (error) { if (error instanceof ApiFailure && error.statusCode === 401) return { user: null }; throw error }
  })
  app.post('/api/auth/logout', async (req, reply) => { await authenticate(req); await store!.logout(sha256(req.cookies.dt_session!)); reply.clearCookie('dt_session', { path: '/' }); return { success: true } })
  app.get('/api/portfolio', async req => { const session = await authenticate(req); return chain.portfolio(session.owner) })
  async function currentStrategy(owner: string) {
    const strategy = await store!.strategy(owner)
    if (strategy && chain.refreshStrategy && chain.readiness(owner).programConfigured) { const current = await chain.refreshStrategy(strategy); await store!.saveChainStrategy(current); return current }
    return strategy
  }
  app.get('/api/strategy', async req => { const session = await authenticate(req); return { strategy: await currentStrategy(session.owner) } })
  app.put('/api/strategy', async req => {
    const session = await authenticate(req); const input = body(req); const policy = validatePolicy(input.policy || input)
    const previous = await store!.strategy(session.owner); const now = new Date().toISOString()
    const strategy: Strategy = { id: previous?.id || randomUUID(), owner: session.owner, vaultAddress: '', keeperAddress: '', policy, status: 'draft', pauseReason: null, balanceUsdcRaw: '0', depositedPrincipalRaw: '0', nonce: '0', confirmedCyclesToday: 0, consecutiveFailures: 0, chainSlot: null, createdAt: previous?.createdAt || now, updatedAt: now }
    return { strategy: await store!.saveDraft(strategy) }
  })
  app.post('/api/strategy/preview', async req => {
    const session = await authenticate(req); const input = body(req); const stored = await store!.strategy(session.owner)
    if (!stored) throw new ApiFailure(409, 'STRATEGY_REQUIRED', 'Save a strategy before requesting an execution preview')
    const strategy = { ...stored, policy: input.policy ? validatePolicy(input.policy) : stored.policy }
    return chain.executionPreview(strategy)
  })
  async function ensureFeeWallet(owner: string) {
    if (!config.feeEncryptionKey) throw new ApiFailure(503, 'FEE_WALLET_UNAVAILABLE', 'Configure the fee-wallet encryption key before funding')
    const existing = await store!.feeWallet(owner); if (existing) return existing
    const pair = Keypair.generate()
    try { return await store!.createFeeWallet({ owner, address: pair.publicKey.toBase58(), encryptedSecret: encryptSecret(pair.secretKey, config.feeEncryptionKey, owner), balanceRaw: '0' }) } finally { pair.secretKey.fill(0) }
  }
  async function prepareAction(req: FastifyRequest, forcedAction?: ActionKind) {
    const session = await authenticate(req); const input = body(req); const key = idempotency(req, input)
    const action = forcedAction || input.action
    const allowed: ActionKind[] = ['initialize', 'configure', 'deposit', 'pause', 'revoke', 'withdraw', 'recover', 'fee-funding']
    if (typeof action !== 'string' || !allowed.includes(action as ActionKind)) throw new ApiFailure(400, 'INVALID_ACTION', 'Select a supported owner action')
    if (input.policy !== undefined && !['initialize', 'configure'].includes(action)) throw new ApiFailure(400, 'INVALID_INPUT', 'Strategy policy changes require the configure action')
    if (input.enable !== undefined && action !== 'configure') throw new ApiFailure(400, 'INVALID_INPUT', 'Automation authorization requires the configure action')
    const previous = await store!.preparedByKey(session.owner, key)
    if (previous) {
      if (previous.kind !== action || previous.payload.amountRaw !== input.amountRaw || (input.policy && JSON.stringify(previous.payload.policy) !== JSON.stringify(validatePolicy(input.policy))) || previous.payload.enable !== input.enable) throw new ApiFailure(409, 'IDEMPOTENCY_MISMATCH', 'This idempotency key belongs to another action or amount')
      return publicIntent(previous)
    }
    const runtime = await runtimeConfig(session.owner)
    if (!config.inviteWallets.includes(session.owner) && (['initialize', 'deposit', 'fee-funding'].includes(action) || (action === 'configure' && input.enable === true))) throw new ApiFailure(403, 'INVITE_REVOKED', 'Your invitation is inactive; pause, revoke and withdrawal controls remain available')
    if (['initialize', 'deposit', 'fee-funding'].includes(action) && !runtime.fundingEnabled) throw new ApiFailure(503, 'FUNDING_DISABLED', 'Funding is awaiting deployment verification', runtime.readiness.reasons)
    if (action === 'configure' && input.enable === true) {
      if (!runtime.automationEnabled) throw new ApiFailure(503, 'AUTOMATION_DISABLED', 'Automation is awaiting deployment verification', runtime.readiness.reasons)
      const notifications = await store!.notifications(session.owner)
      if (!notifications.verified) throw new ApiFailure(409, 'EMAIL_VERIFICATION_REQUIRED', 'Verify your email before enabling automation')
    }
    const strategy = await store!.strategy(session.owner)
    if (!strategy && action !== 'fee-funding') throw new ApiFailure(409, 'STRATEGY_REQUIRED', 'Save a strategy before preparing an owner action')
    const payload: Record<string, unknown> = { strategyId: strategy?.id || null, owner: session.owner }
    if (input.enable !== undefined) {
      if (typeof input.enable !== 'boolean') throw new ApiFailure(400, 'INVALID_INPUT', 'Enable must be a boolean')
      payload.enable = input.enable
    }
    if (input.policy) payload.policy = validatePolicy(input.policy)
    if (strategy) { payload.strategy = strategy; if (!payload.policy) payload.policy = strategy.policy }
    if (['deposit', 'withdraw', 'recover', 'fee-funding'].includes(action)) payload.amountRaw = integer(input.amountRaw, 'Amount', 1n, action === 'fee-funding' ? 5000000n : action === 'deposit' ? 100000000n : 18446744073709551615n)
    let feeWallet: string | null = null
    let keeperFeeWallet: string | undefined
    if (action === 'initialize' || action === 'configure') {
      const wallet = await ensureFeeWallet(session.owner); keeperFeeWallet = wallet.address
      if (action === 'configure' && input.enable === true) {
        const balance = await chain.feeWalletBalance(wallet.address, true); await store!.setFeeBalance(session.owner, balance)
        if (BigInt(balance) < BigInt((payload.policy as StrategyPolicy).maxFeePerAttemptLamports)) throw new ApiFailure(409, 'FEE_ALLOWANCE_REQUIRED', 'Fund the prepaid SOL allowance before enabling automation')
        if (BigInt(balance) > 5000000n) throw new ApiFailure(409, 'FEE_BALANCE_CAP', 'Refund excess prepaid SOL before enabling automation')
      }
    }
    if (action === 'fee-funding') {
      const wallet = await ensureFeeWallet(session.owner); const balance = await chain.feeWalletBalance(wallet.address, true); await store!.setFeeBalance(session.owner, balance)
      if (BigInt(balance) + BigInt(String(payload.amountRaw)) > 5000000n) throw new ApiFailure(400, 'FEE_BALANCE_CAP', 'The prepaid fee balance cannot exceed 0.005 SOL')
      feeWallet = wallet.address; payload.recipient = feeWallet
    }
    chain.invalidateOwner?.(session.owner)
    const prepared = await chain.prepareOwnerAction(session.owner, action as ActionKind, payload, feeWallet || keeperFeeWallet)
    return publicIntent(await store!.createIntent(makeIntent(session.owner, strategy?.id || null, action as ActionKind, key, payload, prepared, feeWallet)))
  }
  app.post('/api/transactions/prepare', async req => ({ intent: await prepareAction(req) }))
  app.post('/api/fees/funding-intent', async req => ({ intent: await prepareAction(req, 'fee-funding') }))
  app.post('/api/transactions/submit', async req => {
    const session = await authenticate(req); const input = body(req)
    if (typeof input.intentId !== 'string' || typeof input.signedTransactionBase64 !== 'string') throw new ApiFailure(400, 'INVALID_INPUT', 'Supply the prepared intent and wallet-signed transaction')
    const intent = await store!.intent(session.owner, input.intentId)
    if (!intent) throw new ApiFailure(404, 'INTENT_NOT_FOUND', 'This transaction intent does not belong to your wallet')
    if (intent.status !== 'prepared') return { intent: publicIntent(intent) }
    const increasesExposure = ['initialize', 'deposit', 'fee-funding'].includes(intent.kind) || (intent.kind === 'configure' && intent.payload.enable === true)
    if (increasesExposure) {
      const runtime = await runtimeConfig(session.owner)
      if (!config.inviteWallets.includes(session.owner)) throw new ApiFailure(403, 'INVITE_REVOKED', 'Your invitation is inactive; use the owner exit controls')
      if (!runtime.fundingEnabled || (intent.kind === 'configure' && !runtime.automationEnabled)) throw new ApiFailure(503, 'ACTION_DISABLED', 'This action is awaiting deployment verification or operator renewal', runtime.readiness.reasons)
    }
    if (Date.parse(intent.prepared.expiresAt) <= Date.now()) throw new ApiFailure(409, 'INTENT_EXPIRED', 'This prepared transaction expired; prepare a new one')
    let signed: { signature: string; wireBase64: string }
    try { signed = await chain.verifySignedOwnerTransaction(intent.prepared, input.signedTransactionBase64) } catch { throw new ApiFailure(400, 'TRANSACTION_REJECTED', 'The wallet-signed transaction does not match the approved intent') }
    const claimed = await store!.markSubmitted(session.owner, intent.id, signed.signature, signed.wireBase64)
    if (!claimed) return { intent: publicIntent((await store!.intent(session.owner, intent.id))!) }
    try { await chain.broadcastSignedTransaction(signed.wireBase64) } catch { /* Signature is durable. Reconciliation decides its outcome without a second broadcast. */ }
    return { intent: publicIntent(claimed) }
  })
  app.post('/api/transactions/import', async req => {
    const session = await authenticate(req); const input = body(req)
    if (!chain.inspectOwnerAction) throw new ApiFailure(503, 'IMPORT_UNAVAILABLE', 'Owner-action receipt verification is unavailable; your direct owner controls remain usable')
    if (typeof input.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(input.signature) || !['pause', 'revoke', 'withdraw', 'recover'].includes(String(input.action))) throw new ApiFailure(400, 'INVALID_IMPORT', 'Supply a Solana signature and a supported owner exit action')
    const action = input.action as 'pause' | 'revoke' | 'withdraw' | 'recover'
    const expected = { action, ...(input.amountRaw === undefined ? {} : { amountRaw: integer(input.amountRaw, 'Owner action amount', 1n) }) }
    const existingSignature = await store!.intentBySignature(session.owner, input.signature)
    if (existingSignature) return { intent: publicIntent(existingSignature) }
    const key = `import:${sha256(`${input.signature}:${action}:${expected.amountRaw || ''}`)}`
    const existing = await store!.preparedByKey(session.owner, key)
    if (existing) return { intent: publicIntent(existing) }
    let proof
    try { proof = await chain.inspectOwnerAction(session.owner, input.signature, expected) } catch { throw new ApiFailure(400, 'IMPORT_REJECTED', 'The chain transaction could not be verified as your specified owner action') }
    const strategy = await store!.strategy(session.owner)
    const placeholder: PreparedTransaction = { transactionBase64: '', messageBase64: '', blockhash: '', lastValidBlockHeight: 0, expiresAt: new Date(Date.now() + 86400000).toISOString(), feeLamportsRaw: '0', cluster: config.cluster, summary: { action: `Verify ${action} from Solana`, owner: session.owner, feePayer: session.owner, recipient: session.owner } }
    let intent = makeIntent(session.owner, strategy?.id || null, proof?.kind || action, key, { ...(proof?.payload || {}), external: true, externalUnverified: !proof, expectedAction: action, ...expected }, proof?.prepared || placeholder)
    intent.status = proof ? 'submitted' : 'unresolved'; intent.signature = input.signature; intent.wireBase64 = proof?.wireBase64 || null
    intent = await store!.createIntent(intent)
    if (proof) { chain.invalidateOwner?.(session.owner); await store!.finalize(intent, proof.reconciliation); intent = (await store!.intent(session.owner, intent.id))! }
    return { intent: publicIntent(intent) }
  })
  app.get('/api/activity', async req => { const session = await authenticate(req); const data = await store!.activity(session.owner); return { receipts: data.receipts, intents: data.intents.map(publicIntent) } })
  app.get('/api/fees', async req => {
    const session = await authenticate(req); const wallet = await store!.feeWallet(session.owner)
    if (wallet) { const balance = await chain.feeWalletBalance(wallet.address); await store!.setFeeBalance(session.owner, balance) }
    const state = await store!.feeState(session.owner); const strategy = await store!.strategy(session.owner)
    const available = BigInt(state.balanceLamports) - BigInt(state.reservedLamports)
    const response: FeeCredit = { ...state, availableLamports: (available > 0n ? available : 0n).toString(), maxBalanceLamports: '5000000', dailyLimitLamports: strategy?.policy.dailyFeeLimitLamports || '500000', custody: 'service-controlled', ...(wallet ? { checkedAt: new Date().toISOString() } : {}) }
    return response
  })
  app.post('/api/fees/reconcile', async req => {
    const session = await authenticate(req); const input = body(req)
    if (typeof input.intentId !== 'string') throw new ApiFailure(400, 'INTENT_REQUIRED', 'Select an existing funding or refund intent')
    const intent = await store!.intent(session.owner, input.intentId)
    if (!intent || !intent.kind.startsWith('fee-')) throw new ApiFailure(404, 'INTENT_NOT_FOUND', 'This fee intent does not belong to your wallet')
    if (['submitted', 'unresolved'].includes(intent.status)) { const result = await chain.reconcile(intent); if (result.status !== 'pending') chain.invalidateOwner?.(session.owner); await store!.finalize(intent, result) }
    return { intent: publicIntent((await store!.intent(session.owner, intent.id))!) }
  })
  app.post('/api/fees/refund', async req => {
    const session = await authenticate(req); const input = body(req); const key = idempotency(req, input)
    const previous = await store!.preparedByKey(session.owner, key); if (previous) { if (previous.kind !== 'fee-refund' || (input.amountRaw !== undefined && previous.payload.amountRaw !== input.amountRaw)) throw new ApiFailure(409, 'IDEMPOTENCY_MISMATCH', 'The idempotency key was used for another action or amount'); return { intent: publicIntent(previous) } }
    if (!config.feeEncryptionKey) throw new ApiFailure(503, 'REFUND_UNAVAILABLE', 'Fee-wallet service is unavailable')
    const wallet = await store!.feeWallet(session.owner)
    if (!wallet) throw new ApiFailure(409, 'NO_FEE_WALLET', 'No prepaid fee wallet exists for this account')
    const balance = await chain.feeWalletBalance(wallet.address, true); await store!.setFeeBalance(session.owner, balance)
    const state = await store!.feeState(session.owner)
    if (state.pendingRefund || BigInt(state.reservedLamports) > 0n) throw new ApiFailure(409, 'FEES_RESERVED', 'Wait for pending executions or refunds to reconcile before refunding fees')
    let amount: string; let prepared: PreparedTransaction
    if (input.amountRaw === undefined) {
      const quote = await chain.prepareRefund(session.owner, wallet.address, balance)
      const remaining = BigInt(balance) - BigInt(quote.feeLamportsRaw)
      if (remaining <= 0n) throw new ApiFailure(400, 'REFUND_FEE_REQUIRED', 'The remaining allowance is too small to pay its refund network fee')
      amount = remaining.toString(); prepared = await chain.prepareRefund(session.owner, wallet.address, amount)
    } else { amount = integer(input.amountRaw, 'Refund amount', 1n, BigInt(balance)); prepared = await chain.prepareRefund(session.owner, wallet.address, amount) }
    if (BigInt(amount) + BigInt(prepared.feeLamportsRaw) > BigInt(balance)) throw new ApiFailure(400, 'REFUND_FEE_REQUIRED', 'Keep enough SOL in the allowance to pay the refund transaction fee')
    // The authenticated owner requests a fixed-recipient refund; the worker signs it after durable reservation.
    return { intent: publicIntent(await store!.createIntent(makeIntent(session.owner, null, 'fee-refund', key, { amountRaw: amount, recipient: session.owner }, prepared, wallet.address, prepared.feeLamportsRaw))) }
  })
  app.get('/api/notifications', async req => { const session = await authenticate(req); return { ...(await store!.notifications(session.owner)), delivery: await store!.notificationStatus(session.owner) } })
  app.get('/api/notifications/deliveries', async req => {
    const session = await authenticate(req)
    const delivery = await store!.notificationStatus(session.owner)
    return { deliveries: delivery.map(row => ({ id: row.id, event: row.kind, status: row.status, createdAt: row.created_at, sentAt: ['sent', 'delivered'].includes(row.status) ? row.updated_at : null, error: row.status === 'failed' ? 'Email could not be delivered after retries' : null })) }
  })
  app.put('/api/notifications', async req => {
    const session = await authenticate(req); const input = body(req); const preferences: Record<string, boolean> = {}
    for (const key of ['executions', 'failures', 'pauses', 'lowFeeBalance']) if (typeof input[key] === 'boolean') preferences[key] = input[key]
    await store!.setPreferences(session.owner, preferences); return store!.notifications(session.owner)
  })
  async function requestEmailVerification(req: FastifyRequest) {
    const session = await authenticate(req); const input = body(req); const email = requireEmail(input.email)
    if (!config.resendApiKey || !config.emailFrom) throw new ApiFailure(503, 'EMAIL_UNAVAILABLE', 'Email delivery needs a verified sending domain and credentials')
    const verification = token(); await store!.requestEmailVerification(session.owner, email, sha256(verification), `${config.origin}/api/notifications/verify-email?token=${encodeURIComponent(verification)}`)
    return { status: 'queued', email }
  }
  app.post('/api/notifications/verify-email', requestEmailVerification)
  app.post('/api/notifications/verify', requestEmailVerification)
  app.post('/api/notifications/confirm', async req => {
    const input = body(req)
    if (typeof input.token !== 'string' || input.token.length > 100) throw new ApiFailure(400, 'INVALID_TOKEN', 'This email verification token is invalid')
    if (!await (await requireStore()).verifyEmail(sha256(input.token))) throw new ApiFailure(400, 'INVALID_TOKEN', 'This verification token expired or was already used')
    return { verified: true }
  })
  app.get('/api/notifications/verify-email', async (req, reply) => {
    const input = req.query as Record<string, unknown>; if (typeof input.token !== 'string' || input.token.length > 100) throw new ApiFailure(400, 'INVALID_TOKEN', 'This email verification link is invalid')
    const db = await requireStore(); if (!await db.verifyEmail(sha256(input.token))) throw new ApiFailure(400, 'INVALID_TOKEN', 'This verification link expired or was already used')
    return reply.type('text/html').send('<!doctype html><meta name="viewport" content="width=device-width"><title>Email verified · DoubleTake</title><h1>Email verified</h1><p>You can return to DoubleTake and enable your strategy.</p><a href="/">Return to DoubleTake</a>')
  })
  await app.register(async webhook => {
    webhook.removeContentTypeParser('application/json')
    webhook.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 50000 }, (_req, raw, done) => done(null, raw))
    webhook.post('/api/notifications/webhook', async req => {
      if (!config.emailWebhookSecret) throw new ApiFailure(503, 'WEBHOOK_DISABLED', 'Delivery webhooks require a signing secret')
      const id = req.headers['svix-id']; const timestamp = req.headers['svix-timestamp']; const signatures = req.headers['svix-signature']
      if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signatures !== 'string' || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !Buffer.isBuffer(req.body)) throw new ApiFailure(403, 'WEBHOOK_FAILED', 'Invalid email webhook signature')
      const secret = Buffer.from(config.emailWebhookSecret.replace(/^whsec_/, ''), 'base64')
      if (secret.length < 16) throw new ApiFailure(503, 'WEBHOOK_DISABLED', 'Email webhook signing secret is invalid')
      const expected = createHmac('sha256', secret).update(`${id}.${timestamp}.`).update(req.body).digest()
      const valid = signatures.split(' ').some(part => { const [version, value] = part.split(','); if (version !== 'v1' || !value) return false; const bytes = Buffer.from(value, 'base64'); return bytes.length === expected.length && timingSafeEqual(bytes, expected) })
      if (!valid) throw new ApiFailure(403, 'WEBHOOK_FAILED', 'Invalid email webhook signature')
      const event = JSON.parse(req.body.toString('utf8')) as { type?: unknown; data?: { email_id?: unknown } }
      if (typeof event.data?.email_id === 'string') {
        const status = event.type === 'email.delivered' ? 'delivered' : event.type === 'email.bounced' || event.type === 'email.complained' ? 'bounced' : event.type === 'email.failed' ? 'failed' : null
        if (status) await (await requireStore()).emailDelivery(event.data.email_id, status)
      }
      return { received: true }
    })
  })
  if (existsSync(config.staticDirectory)) {
    await app.register(staticPlugin, { root: config.staticDirectory, prefix: '/', wildcard: true })
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ code: 'NOT_FOUND', error: req.url.startsWith('/api/') ? 'API endpoint not found' : 'Resource not found' }))
  }
  return app
}
