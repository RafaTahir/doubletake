import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto'
import bs58 from 'bs58'

export function validWallet(owner: unknown): owner is string {
  if (typeof owner !== 'string' || owner.length < 32 || owner.length > 44) return false
  try { return bs58.decode(owner).length === 32 } catch { return false }
}
export function sha256(value: string) { return createHash('sha256').update(value).digest('hex') }
export function token() { return randomBytes(32).toString('base64url') }
export function verifyWalletMessage(owner: string, message: string, signature: string) {
  try {
    if (!validWallet(owner) || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false
    const bytes = Buffer.from(signature, 'base64')
    if (bytes.length !== 64) return false
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(bs58.decode(owner))]), format: 'der', type: 'spki' })
    return verify(null, Buffer.from(message, 'utf8'), publicKey, bytes)
  } catch { return false }
}
export function encryptSecret(secret: Uint8Array, keyHex: string, owner: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv)
  cipher.setAAD(Buffer.from(`doubletake:fee-wallet:v1:${owner}`))
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.')
}
export function decryptSecret(encrypted: string, keyHex: string, owner: string) {
  const [version, iv, tag, body] = encrypted.split('.')
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('Invalid fee-wallet key envelope')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'base64'))
  decipher.setAAD(Buffer.from(`doubletake:fee-wallet:v1:${owner}`))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]))
}
export function equalSecret(a: string, b: string) {
  const left = Buffer.from(a); const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
export function integer(value: unknown, name: string, min: bigint = 0n, max: bigint = 18446744073709551615n): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be a raw integer string`)
  const amount = BigInt(value)
  if (amount < min || amount > max) throw new Error(`${name} is outside its permitted range`)
  return value
}
export function requireEmail(value: unknown) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Enter a valid email address')
  return value.trim().toLowerCase()
}
export function authMessage(owner: string, origin: string, cluster: string, nonce: string, issuedAt: string, expiresAt: string) {
  return `${new URL(origin).host} wants you to sign in with your Solana account:\n${owner}\n\nSign in to DoubleTake. This signature does not authorize a transaction.\n\nURI: ${origin}\nVersion: 1\nChain ID: solana:${cluster}\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`
}
export function feeAvailable(balanceRaw: string, reservedRaw: string, spentTodayRaw: string, dailyLimitRaw: string, proposedRaw: string) {
  const balance = BigInt(balanceRaw); const reserved = BigInt(reservedRaw); const spent = BigInt(spentTodayRaw)
  const limit = BigInt(dailyLimitRaw); const fee = BigInt(proposedRaw)
  if (fee <= 0n || fee > 50000n) return { allowed: false, reason: 'Per-attempt fee cap exceeded' }
  if (limit > 500000n || limit <= 0n || spent + reserved + fee > limit) return { allowed: false, reason: 'Daily fee allowance exhausted' }
  if (balance - reserved < fee) return { allowed: false, reason: 'Prepaid SOL balance is too low' }
  return { allowed: true, reason: '' }
}
