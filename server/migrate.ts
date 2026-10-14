import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { loadConfig } from './config.ts'
import { ProductStore } from './store.ts'

const migrationUrl = process.env.DATABASE_MIGRATION_URL || (process.env.NODE_ENV !== 'production' ? process.env.DATABASE_URL : undefined)
if (!migrationUrl) throw new Error('Set a separate DATABASE_MIGRATION_URL for the one-off production migration process; never run the service with the admin connection')
const config = loadConfig({ ...process.env, DATABASE_URL: migrationUrl, DATABASE_CA_CERT: process.env.DATABASE_MIGRATION_CA_CERT || process.env.DATABASE_CA_CERT })
const databaseUrl = config.databaseUrl!
const sql = await readFile(path.resolve('migrations/001_product.sql'), 'utf8')
if (databaseUrl.startsWith('pglite:')) {
  const { LocalDatabasePool } = await import('./databaseLocal.ts')
  const pool = new LocalDatabasePool(databaseUrl.slice('pglite:'.length))
  try { await pool.migrate(sql) } finally { await pool.end() }
} else {
  const store = new ProductStore(databaseUrl, { caPem: config.databaseCaCert, rolePolicy: 'migration' })
  const db = await store.pool.connect()
  try { await db.query(sql) } finally { db.release(); await store.close() }
}
process.stdout.write('DoubleTake database migration completed.\n')
