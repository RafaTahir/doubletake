import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BackendConfig } from './ports.ts'
import type { ProductStore } from './store.ts'

const AAD = 'doubletake:financial-backup:v1'
export function encryptBackup(snapshot: unknown, keyHex: string) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv)
  cipher.setAAD(Buffer.from(AAD))
  const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(snapshot))), cipher.final()])
  return JSON.stringify({ version: 1, algorithm: 'AES-256-GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') })
}
export function decryptBackup(envelope: string, keyHex: string) {
  const parsed = JSON.parse(envelope) as { version: number; algorithm: string; iv: string; tag: string; ciphertext: string }
  if (parsed.version !== 1 || parsed.algorithm !== 'AES-256-GCM') throw new Error('Unsupported backup format')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(parsed.iv, 'base64'))
  decipher.setAAD(Buffer.from(AAD)); decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as { version: number; capturedAt: string; tables: Record<string, unknown[]> }
}
export async function writeDailyBackup(store: ProductStore, config: BackendConfig) {
  if (!config.backupDirectory || !config.backupEncryptionKey) return null
  const directory = path.resolve(config.backupDirectory)
  await mkdir(directory, { recursive: true })
  const filename = path.join(directory, `doubletake-${new Date().toISOString().slice(0, 10)}.enc`)
  try { await access(filename); const prior = decryptBackup(await readFile(filename, 'utf8'), config.backupEncryptionKey); if (prior.version === 1) return filename } catch { /* Missing/corrupt backups are regenerated atomically. */ }
  const snapshot = await store.financialBackup(); const temp = path.join(directory, `.doubletake-${randomUUID()}.tmp`)
  await writeFile(temp, encryptBackup(snapshot, config.backupEncryptionKey), { mode: 0o600 })
  await rename(temp, filename)
  const verified = decryptBackup(await readFile(filename, 'utf8'), config.backupEncryptionKey)
  if (verified.version !== 1 || verified.capturedAt !== snapshot.capturedAt) throw new Error('The written financial backup did not pass verification')
  return filename
}
