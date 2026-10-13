import { USDC, assetForMint, displayAmount } from '../lib/assets.js';
import { fetchQuote, routeDetails } from '../lib/jupiter.js';

const INPUT_RAW = '100000000'; // 100 USDC, at six decimals.

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const mint = String(req.query.mint || '');
  const asset = assetForMint(mint);
  if (!asset) return res.status(400).json({ error: 'Unsupported mint' });
  try {
    const buy = await fetchQuote(USDC.mint, mint, INPUT_RAW);
    // Keep the exact integer output; display rounding must never enter leg two.
    const sell = await fetchQuote(mint, USDC.mint, buy.outAmount);
    const notionalUsdc = displayAmount(INPUT_RAW, USDC.decimals);
    const sellUsdc = displayAmount(sell.outAmount, USDC.decimals);
    const quotedPnlUsdc = Number(BigInt(sell.outAmount) - BigInt(INPUT_RAW)) / 10 ** USDC.decimals;
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      notionalUsdc,
      buyTokens: displayAmount(buy.outAmount, asset.decimals),
      sellUsdc,
      quotedPnlUsdc,
      quotedPnlPct: quotedPnlUsdc / notionalUsdc * 100,
      inputAmountRaw: INPUT_RAW,
      buyAmountRaw: buy.outAmount,
      sellAmountRaw: sell.outAmount,
      buyRoute: routeDetails(buy.routePlan),
      sellRoute: routeDetails(sell.routePlan),
      buyQuotedAt: buy.quotedAt,
      sellQuotedAt: sell.quotedAt,
      quotedAt: buy.quotedAt,
      ...(buy.contextSlot !== undefined ? { buyContextSlot: buy.contextSlot } : {}),
      ...(sell.contextSlot !== undefined ? { sellContextSlot: sell.contextSlot } : {}),
      note: 'Sequential unrestricted Jupiter quotes, not an executable or simultaneous arbitrage. Quoted output includes route fees and price impact; network costs and slippage are excluded. xStock amounts are unscaled token units.',
    });
  } catch (error) {
    return res.status(503).json({
      error: 'Cannot verify two live routes right now. No round-trip estimate available.',
      detail: String(error?.message || error).slice(0, 140),
    });
  }
}
