import type { BackendConfig } from './ports.ts'
import type { OutboxItem, ProductStore } from './store.ts'
import { rawToDecimal } from '../shared/amounts.ts'

export function notificationMessage(item: OutboxItem, origin: string) {
  if (item.kind === 'verify-email') return { subject: 'Verify your DoubleTake email', text: `Verify your email address to receive strategy notifications and enable automation.\n\n${String(item.payload.verificationUrl)}\n\nThis link expires in one hour. If you did not request it, ignore this message.` }
  const title = item.kind === 'execution' ? 'Arbitrage execution confirmed' : item.kind === 'failure' ? 'Execution attempt failed' : item.kind === 'pause' ? 'Your DoubleTake strategy is paused' : 'Your execution-fee allowance needs attention'
  const lines = [title, '']
  if (typeof item.payload.reason === 'string') lines.push(item.payload.reason)
  if (typeof item.payload.signature === 'string') lines.push(`Transaction: ${item.payload.signature}`)
  if (typeof item.payload.usdcDeltaRaw === 'string') lines.push(`Confirmed vault change: ${rawToDecimal(item.payload.usdcDeltaRaw, 6)} USDC`)
  if (typeof item.payload.networkFeeLamports === 'string') lines.push(`Network fee: ${rawToDecimal(item.payload.networkFeeLamports, 9)} SOL`)
  lines.push('', `Inspect your activity and controls: ${origin}`)
  return { subject: title, text: lines.join('\n') }
}
export async function deliverNotification(store: ProductStore, config: BackendConfig, sender: typeof fetch = fetch) {
  if (!config.resendApiKey || !config.emailFrom) return
  const item = await store.nextNotification(); if (!item) return
  const message = notificationMessage(item, config.origin)
  try {
    const response = await sender('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': item.dedupeKey }, body: JSON.stringify({ from: config.emailFrom, to: [item.email], ...message }), signal: AbortSignal.timeout(10000) })
    if (!response.ok) {
      if ([401, 403, 429].includes(response.status)) {
        await store.setNotificationServicePause(response.status === 429 ? 'Email provider quota reached; automation waits for delivery service recovery' : 'Email delivery credentials or sending domain require renewal')
        await store.markNotification(item.id, 'queued', null, `Email provider returned ${response.status}`, Math.max(5, item.attempts)); return
      }
      const permanent = response.status === 400 || response.status === 401 || response.status === 403 || response.status === 422
      await store.markNotification(item.id, permanent || item.attempts >= 5 ? 'failed' : 'queued', null, `Email provider returned ${response.status}`, item.attempts); return
    }
    const receipt = await response.json() as { id?: unknown }
    if (typeof receipt.id !== 'string') throw new Error('Email provider omitted its receipt')
    await store.markNotification(item.id, 'sent', receipt.id, null, item.attempts)
    await store.setNotificationServicePause(null)
  } catch { await store.markNotification(item.id, item.attempts >= 5 ? 'failed' : 'queued', null, 'Email provider unavailable; retry scheduled', item.attempts) }
}
