import { loadConfig } from './config.ts'
import { createApp } from './app.ts'
import { ProductStore } from './store.ts'
import { ProductWorker } from './worker.ts'
import { RaydiumMarkets } from './markets.ts'
import { SolanaChainGateway } from './chain.ts'
import { writeDailyBackup } from './backup.ts'

const config = loadConfig()
const connection = config.databaseUrl?.startsWith('pglite:') ? new (await import('./databaseLocal.ts')).LocalDatabasePool(config.databaseUrl.slice('pglite:'.length)) : config.databaseUrl
const store = connection ? new ProductStore(connection, { caPem: config.databaseCaCert }) : null
const markets = new RaydiumMarkets(config.rpcUrl)
const chain = new SolanaChainGateway({ rpcUrl: config.rpcUrl, cluster: config.cluster, programId: process.env.PROGRAM_ID || process.env.SOLANA_PROGRAM_ID, programVerified: process.env.PROGRAM_VERIFIED === 'true', expectedProgramSha256: process.env.PROGRAM_EXPECTED_SHA256, expectedUpgradeAuthority: process.env.PROGRAM_UPGRADE_AUTHORITY, mainnetCanaryVerified: process.env.MAINNET_CANARY_VERIFIED === 'true', keeperEnabled: config.keeperEnabled, lookupTable: process.env.BETA_LOOKUP_TABLE, canaryApproved: config.canaryApproved, canaryOwner: config.canaryOwner }, markets)
await chain.verifyDeployment().catch(() => { /* Chain readiness retains deployment verification failures. */ })
if (store && config.backupDirectory && config.backupEncryptionKey) {
  try { await writeDailyBackup(store, config) } catch { config.backupDirectory = undefined /* Funding and automation stay disabled when durable backups cannot be verified. */ }
}
const app = await createApp({ config, store, chain, markets })
const worker = store ? new ProductWorker(store, chain, markets, config, event => app.log.info(event)) : null
await app.listen({ port: config.port, host: config.host })
worker?.start()
let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  await worker?.stop(); await app.close(); await store?.close()
}
process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })
