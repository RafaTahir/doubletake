import { X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import { checkServerIdentity } from 'node:tls'
import type { PoolConfig } from 'pg'

export interface DatabaseTlsOptions { production?: boolean; caPem?: string }

/** Construct explicit pg options so URI SSL parameters cannot overwrite verification or CA settings. */
export function postgresConnectionOptions(databaseUrl: string, options: DatabaseTlsOptions = {}): PoolConfig {
  let uri: URL
  try { uri = new URL(databaseUrl) } catch { throw new Error('DATABASE_URL must be a PostgreSQL connection URL') }
  if (!['postgres:', 'postgresql:'].includes(uri.protocol) || !uri.hostname) throw new Error('DATABASE_URL must name a PostgreSQL host')
  const hostname = uri.hostname.replace(/^\[|\]$/g, '')
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(hostname)
  const modes = uri.searchParams.getAll('sslmode')
  if (modes.length > 1) throw new Error('DATABASE_URL must specify sslmode only once')
  for (const key of uri.searchParams.keys()) if (!['sslmode', 'application_name'].includes(key)) throw new Error('DATABASE_URL supports only sslmode and application_name parameters; configure a trusted CA through DATABASE_CA_CERT')
  const production = options.production ?? process.env.NODE_ENV === 'production'
  const verifiedTls = production || !loopback || modes[0] === 'verify-full'
  if (verifiedTls && modes[0] !== 'verify-full') throw new Error('Remote and production DATABASE_URL connections require sslmode=verify-full; certificate verification cannot be disabled')
  if (!verifiedTls && modes[0] && modes[0] !== 'disable') throw new Error('Use sslmode=verify-full for TLS, or plaintext only for loopback development')
  const ca = options.caPem?.replace(/\\n/g, '\n').trim()
  if (ca) {
    const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
    if (!certificates?.length || ca.length > 1048576) throw new Error('DATABASE_CA_CERT must contain trusted PEM certificates')
    try { for (const certificate of certificates) new X509Certificate(certificate) } catch { throw new Error('DATABASE_CA_CERT contains an invalid PEM certificate') }
  }
  let user: string | undefined; let password: string | undefined; let database: string | undefined
  try { user = decodeURIComponent(uri.username) || undefined; password = decodeURIComponent(uri.password) || undefined; database = decodeURIComponent(uri.pathname.slice(1)) || undefined } catch { throw new Error('DATABASE_URL contains invalid percent encoding') }
  return {
    host: hostname, port: Number(uri.port || 5432), user, password, database,
    application_name: uri.searchParams.get('application_name') || 'doubletake',
    ssl: verifiedTls ? { rejectUnauthorized: true, ...(ca ? { ca } : {}), ...(!isIP(hostname) ? { servername: hostname } : {}), checkServerIdentity: (_servername, certificate) => checkServerIdentity(hostname, certificate) } : false,
    max: 5, idleTimeoutMillis: 30000, statement_timeout: 10000, connectionTimeoutMillis: 10000,
  }
}
