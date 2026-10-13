import { USDC, assetForMint, displayAmount } from '../lib/assets.js';
import { fetchQuote, routeDetails } from '../lib/jupiter.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const mint = String(req.query.mint || '');
  const direction = String(req.query.direction || 'buy');
  const asset = assetForMint(mint);
  if (!asset || !['buy', 'sell'].includes(direction)) {
    return res.status(400).json({ error: 'Invalid asset or direction' });
  }
  const input = direction === 'buy' ? USDC : asset;
  const output = direction === 'buy' ? asset : USDC;
  // 10 USDC (6 decimals) or 0.01 unscaled xStock tokens (8 decimals).
  const amount = direction === 'buy' ? '10000000' : '1000000';
  try {
    const quote = await fetchQuote(input.mint, output.mint, amount);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      inputMint: input.mint,
      outputMint: output.mint,
      inputDecimals: input.decimals,
      outputDecimals: output.decimals,
      inputAmountRaw: amount,
      outputAmountRaw: quote.outAmount,
      minOutputAmountRaw: quote.otherAmountThreshold,
      inputAmount: displayAmount(amount, input.decimals),
      outputAmount: displayAmount(quote.outAmount, output.decimals),
      minOutputAmount: displayAmount(quote.otherAmountThreshold, output.decimals),
      priceImpactPct: Number(quote.priceImpactPct),
      route: routeDetails(quote.routePlan),
      slippageBps: 50,
      platformFee: quote.platformFee || null,
      quotedAt: quote.quotedAt,
      ...(quote.contextSlot !== undefined ? { contextSlot: quote.contextSlot } : {}),
      source: 'Jupiter Swap V1',
      note: 'Indicative only. xStock amounts are unscaled token units. No transaction is prepared or signed.',
    });
  } catch (error) {
    return res.status(503).json({
      error: 'Jupiter route unavailable for this pair. No trade attempted.',
      detail: String(error?.message || error).slice(0, 140),
    });
  }
}
