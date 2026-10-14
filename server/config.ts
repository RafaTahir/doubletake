import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { BackendConfig } from './ports.ts'
import type { Cluster } from '../shared/types.ts'
import { validWallet } from './security.ts'
import { postgresConnectionOptions } from './databaseTls.ts'

function boolean(value: string | undefined) { return value === 'true' }
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const cluster = (env.SOLANA_CLUSTER || 'mainnet-beta') as Cluster
  if (!['devnet', 'localnet', 'mainnet-beta'].includes(cluster)) throw new Error('SOLANA_CLUSTER must be devnet, localnet, or mainnet-beta')
  const originUrl = new URL(env.APP_ORIGIN || 'http://localhost:3000')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname)
  if (originUrl.protocol !== 'https:' && !(originUrl.protocol === 'http:' && loopback && env.NODE_ENV !== 'production')) throw new Error('APP_ORIGIN must use HTTPS; HTTP is supported only for loopback development')
  const origin = originUrl.origin
  if (env.DATABASE_URL?.startsWith('pglite:') && (cluster !== 'localnet' || env.NODE_ENV === 'production')) throw new Error('PGlite is supported only for localnet development; production requires Postgres')
  if (env.DATABASE_URL && !env.DATABASE_URL.startsWith('pglite:')) postgresConnectionOptions(env.DATABASE_URL, { production: env.NODE_ENV === 'production', caPem: env.DATABASE_CA_CERT })
  const inviteWallets = [...new Set((env.BETA_INVITE_WALLETS || '').split(',').map(x => x.trim()).filter(Boolean))]
  if (inviteWallets.length > 5) throw new Error('The beta supports at most five invited wallets')
  if (boolean(env.CANARY_APPROVED) && (!validWallet(env.CANARY_OWNER) || !inviteWallets.includes(env.CANARY_OWNER!))) throw new Error('CANARY_OWNER must be an invited Solana wallet before approving a canary')
  const configuredSecret = env.SESSION_SECRET
  if (env.DATABASE_URL && (!configuredSecret || configuredSecret.length < 32)) throw new Error('Set SESSION_SECRET to at least 32 random characters before enabling accounts')
  if (env.FEE_ENCRYPTION_KEY && !/^[a-fA-F0-9]{64}$/.test(env.FEE_ENCRYPTION_KEY)) throw new Error('FEE_ENCRYPTION_KEY must be a 32-byte hex key')
  if (env.BACKUP_ENCRYPTION_KEY && !/^[a-fA-F0-9]{64}$/.test(env.BACKUP_ENCRYPTION_KEY)) throw new Error('BACKUP_ENCRYPTION_KEY must be a 32-byte hex key')
  return {
    databaseUrl: env.DATABASE_URL, databaseCaCert: env.DATABASE_CA_CERT, origin, cluster, inviteWallets,
    sessionSecret: configuredSecret || randomBytes(32).toString('hex'), feeEncryptionKey: env.FEE_ENCRYPTION_KEY,
    cookieSecure: origin.startsWith('https://'), keeperEnabled: boolean(env.KEEPER_ENABLED),
    killSwitch: boolean(env.OPERATOR_KILL_SWITCH), serviceBudgetExhausted: boolean(env.SERVICE_BUDGET_EXHAUSTED),
    canaryApproved: boolean(env.CANARY_APPROVED), canaryOwner: env.CANARY_OWNER,
    resendApiKey: env.RESEND_API_KEY, emailFrom: env.EMAIL_FROM, emailWebhookSecret: env.RESEND_WEBHOOK_SECRET,
    backupDirectory: env.BACKUP_DIRECTORY, backupEncryptionKey: env.BACKUP_ENCRYPTION_KEY,
    host: env.HOST || '0.0.0.0', port: Number(env.PORT || 3000),
    staticDirectory: path.resolve(env.STATIC_DIRECTORY || 'dist'),
    rpcUrl: env.SOLANA_RPC_URL || (cluster === 'localnet' ? 'http://127.0.0.1:8899' : cluster === 'mainnet-beta' ? 'https://api.mainnet.solana.com' : 'https://api.devnet.solana.com'),
  }
}
