const MAX_U64 = (1n << 64n) - 1n;

function rawAmount(value, allowZero = false) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || value.length > 20) {
    throw Error('Invalid raw quote amount');
  }
  const amount = BigInt(value);
  if (amount > MAX_U64 || (!allowZero && amount === 0n)) throw Error('Invalid raw quote amount');
  return amount;
}

export function routeDetails(routePlan) {
  return routePlan.map(({ swapInfo, percent }) => ({
    venue: swapInfo.label,
    pool: swapInfo.ammKey,
    ...(Number.isFinite(percent) ? { percent } : {}),
    ...(swapInfo.feeAmount !== undefined ? { feeAmount: swapInfo.feeAmount } : {}),
    ...(swapInfo.feeMint !== undefined ? { feeMint: swapInfo.feeMint } : {}),
  }));
}

export async function fetchQuote(inputMint, outputMint, amount) {
  rawAmount(amount);
  const url = new URL('https://lite-api.jup.ag/swap/v1/quote');
  Object.entries({ inputMint, outputMint, amount, slippageBps: '50' })
    .forEach(([key, value]) => url.searchParams.set(key, value));
  // Timestamp the start, so slow upstream responses never appear newer than they are.
  const quotedAt = Date.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw Error(`Jupiter HTTP ${response.status}`);
  const quote = await response.json();
  if (!quote || quote.error) throw Error('No Jupiter quote');
  if (quote.inputMint !== inputMint || quote.outputMint !== outputMint || quote.inAmount !== amount) {
    throw Error('Quote does not match requested amounts or mints');
  }
  const output = rawAmount(quote.outAmount);
  const minimum = rawAmount(quote.otherAmountThreshold, true);
  if (minimum > output) throw Error('Invalid minimum quote output');
  if (!Array.isArray(quote.routePlan) || quote.routePlan.length === 0 ||
      quote.routePlan.some(part => !part?.swapInfo || typeof part.swapInfo.ammKey !== 'string' ||
        !part.swapInfo.ammKey || typeof part.swapInfo.label !== 'string' || !part.swapInfo.label)) {
    throw Error('Missing Jupiter route evidence');
  }
  if ((typeof quote.priceImpactPct !== 'string' && typeof quote.priceImpactPct !== 'number') ||
      String(quote.priceImpactPct).trim() === '' || !Number.isFinite(Number(quote.priceImpactPct))) {
    throw Error('Invalid quote price impact');
  }
  if (quote.contextSlot !== undefined && (!Number.isSafeInteger(quote.contextSlot) || quote.contextSlot < 0)) {
    throw Error('Invalid quote context slot');
  }
  return { ...quote, quotedAt };
}
