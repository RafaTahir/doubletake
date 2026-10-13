import test from 'node:test';
import assert from 'node:assert/strict';
import quoteHandler from '../api/quote.js';
import arbHandler from '../api/arb.js';
import { ASSETS, USDC } from '../lib/assets.js';

const AAPL = ASSETS[0].mint;

async function invoke(handler, query, method = 'GET') {
  const response = {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; },
  };
  await handler({ method, query }, response);
  return response;
}

function upstream(url, overrides = {}) {
  const params = new URL(url).searchParams;
  return {
    inputMint: params.get('inputMint'),
    outputMint: params.get('outputMint'),
    inAmount: params.get('amount'),
    outAmount: '2913913',
    otherAmountThreshold: '2899344',
    priceImpactPct: '0.0015',
    routePlan: [{ swapInfo: { label: 'Raydium CLMM', ammKey: 'pool-a' }, percent: 100 }],
    contextSlot: 456303228,
    ...overrides,
  };
}

function mockQuotes(t, makeQuote = url => upstream(url)) {
  return t.mock.method(globalThis, 'fetch', async url => ({
    ok: true,
    json: async () => makeQuote(url),
  }));
}

for (const asset of ASSETS) {
  test(`${asset.symbol}: buy converts eight-decimal output and retains raw amounts`, async t => {
    const fetch = mockQuotes(t);
    const result = await invoke(quoteHandler, { mint: asset.mint, direction: 'buy' });
    assert.equal(result.statusCode, 200);
    assert.equal(new URL(fetch.mock.calls[0].arguments[0]).origin, 'https://api.jup.ag');
    assert.equal(new URL(fetch.mock.calls[0].arguments[0]).searchParams.get('amount'), '10000000');
    assert.equal(result.body.inputAmount, 10);
    assert.equal(result.body.outputAmount, 0.02913913);
    assert.equal(result.body.minOutputAmount, 0.02899344);
    assert.equal(result.body.inputDecimals, 6);
    assert.equal(result.body.outputDecimals, 8);
    assert.equal(result.body.outputAmountRaw, '2913913');
    assert.equal(result.body.route[0].pool, 'pool-a');
    assert.equal(result.headers['Cache-Control'], 'no-store');
  });
}

test('sell quotes 0.01 xStock as 1000000 raw units, output USDC uses six decimals', async t => {
  const fetch = mockQuotes(t, url => upstream(url, { outAmount: '3430000', otherAmountThreshold: '3412850' }));
  const result = await invoke(quoteHandler, { mint: AAPL, direction: 'sell' });
  const params = new URL(fetch.mock.calls[0].arguments[0]).searchParams;
  assert.equal(params.get('amount'), '1000000');
  assert.equal(params.get('inputMint'), AAPL);
  assert.equal(params.get('outputMint'), USDC.mint);
  assert.equal(result.body.inputAmount, 0.01);
  assert.equal(result.body.outputAmount, 3.43);
  assert.equal(result.body.inputDecimals, 8);
  assert.equal(result.body.outputDecimals, 6);
});

test('Jupiter API key is sent only upstream when configured', async t => {
  const previous = process.env.JUPITER_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.JUPITER_API_KEY;
    else process.env.JUPITER_API_KEY = previous;
  });
  process.env.JUPITER_API_KEY = 'test-only-api-key';
  const fetch = mockQuotes(t);
  const result = await invoke(quoteHandler, { mint: AAPL });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(fetch.mock.calls[0].arguments[1].headers, { 'x-api-key': 'test-only-api-key' });
  assert.equal(JSON.stringify(result.body).includes('test-only-api-key'), false);
  assert.equal(result.body.source, 'Jupiter Swap V1');
});

test('keyless requests omit the authentication header', async t => {
  const previous = process.env.JUPITER_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.JUPITER_API_KEY;
    else process.env.JUPITER_API_KEY = previous;
  });
  delete process.env.JUPITER_API_KEY;
  const fetch = mockQuotes(t);
  await invoke(quoteHandler, { mint: AAPL });
  assert.equal(fetch.mock.calls[0].arguments[1].headers, undefined);
});

test('round trip preserves exact raw leg handoff, signed loss, routes and earliest timestamp', async t => {
  let call = 0;
  t.mock.method(Date, 'now', () => ++call * 1000);
  const fetch = mockQuotes(t, url => {
    const sell = new URL(url).searchParams.get('inputMint') === AAPL;
    return upstream(url, sell
      ? { outAmount: '99800000', otherAmountThreshold: '99301000', contextSlot: 456303230,
          routePlan: [{ swapInfo: { label: 'Whirlpool', ammKey: 'pool-b' }, percent: 100 }] }
      : { outAmount: '29136601', otherAmountThreshold: '28990917' });
  });
  const result = await invoke(arbHandler, { mint: AAPL });
  assert.equal(result.statusCode, 200);
  assert.equal(new URL(fetch.mock.calls[1].arguments[0]).searchParams.get('amount'), '29136601');
  assert.equal(result.body.buyTokens, 0.29136601);
  assert.equal(result.body.sellUsdc, 99.8);
  assert.equal(result.body.quotedPnlUsdc, -0.2);
  assert.equal(result.body.quotedPnlPct, -0.2);
  assert.equal(result.body.buyQuotedAt, 1000);
  assert.equal(result.body.sellQuotedAt, 2000);
  assert.equal(result.body.quotedAt, 1000);
  assert.equal(result.body.buyContextSlot, 456303228);
  assert.equal(result.body.sellContextSlot, 456303230);
  assert.equal(result.body.buyRoute[0].pool, 'pool-a');
  assert.equal(result.body.sellRoute[0].pool, 'pool-b');
  assert.equal('roundTripDragPct' in result.body, false);
});

test('positive quoted return is preserved instead of clamped to zero', async t => {
  mockQuotes(t, url => upstream(url, new URL(url).searchParams.get('inputMint') === AAPL
    ? { outAmount: '100200000', otherAmountThreshold: '99699000' } : {}));
  const result = await invoke(arbHandler, { mint: AAPL });
  assert.equal(result.body.quotedPnlUsdc, 0.2);
  assert.equal(result.body.quotedPnlPct, 0.2);
});

test('leg handoff does not lose precision above Number.MAX_SAFE_INTEGER', async t => {
  const exact = '9007199254740993';
  const fetch = mockQuotes(t, url => upstream(url, new URL(url).searchParams.get('inputMint') === AAPL
    ? { outAmount: '99800000', otherAmountThreshold: '99301000' }
    : { outAmount: exact, otherAmountThreshold: '9000000000000000' }));
  const result = await invoke(arbHandler, { mint: AAPL });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.buyAmountRaw, exact);
  assert.equal(new URL(fetch.mock.calls[1].arguments[0]).searchParams.get('amount'), exact);
});

for (const [name, overrides] of [
  ['zero output', { outAmount: '0' }],
  ['negative output', { outAmount: '-1' }],
  ['fractional output', { outAmount: '2.5' }],
  ['non-numeric output', { outAmount: 'NaN' }],
  ['numeric output instead of raw string', { outAmount: 2913913 }],
  ['overflowing output', { outAmount: '18446744073709551616' }],
  ['missing minimum output', { otherAmountThreshold: undefined }],
  ['minimum above output', { otherAmountThreshold: '3000000' }],
  ['nonfinite price impact', { priceImpactPct: 'Infinity' }],
  ['empty price impact', { priceImpactPct: '' }],
  ['wrong mint', { outputMint: USDC.mint }],
  ['mismatched input', { inAmount: '7' }],
  ['missing routes', { routePlan: [] }],
  ['missing pool identity', { routePlan: [{ swapInfo: { label: 'Raydium' } }] }],
  ['invalid slot', { contextSlot: -1 }],
]) {
  test(`malformed quote: ${name} returns unavailable`, async t => {
    mockQuotes(t, url => upstream(url, overrides));
    const result = await invoke(quoteHandler, { mint: AAPL });
    assert.equal(result.statusCode, 503);
    assert.equal('outputAmount' in result.body, false);
  });
}

test('invalid first leg stops round trip before a sell request', async t => {
  const fetch = mockQuotes(t, url => upstream(url, { outAmount: '0' }));
  const result = await invoke(arbHandler, { mint: AAPL });
  assert.equal(result.statusCode, 503);
  assert.equal(fetch.mock.calls.length, 1);
});

test('upstream failure on second leg produces no round-trip estimate', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async url => ++calls === 1
    ? { ok: true, json: async () => upstream(url) }
    : { ok: false, status: 429 });
  const result = await invoke(arbHandler, { mint: AAPL });
  assert.equal(result.statusCode, 503);
  assert.equal('quotedPnlUsdc' in result.body, false);
});

test('network failure becomes an unavailable quote', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('timeout'); });
  assert.equal((await invoke(quoteHandler, { mint: AAPL })).statusCode, 503);
});

test('invalid request methods, mints and directions never reach the provider', async t => {
  const fetch = mockQuotes(t);
  for (const handler of [quoteHandler, arbHandler]) {
    assert.equal((await invoke(handler, { mint: AAPL }, 'POST')).statusCode, 405);
    assert.equal((await invoke(handler, { mint: 'fake' })).statusCode, 400);
  }
  assert.equal((await invoke(quoteHandler, { mint: AAPL, direction: 'swap' })).statusCode, 400);
  assert.equal(fetch.mock.calls.length, 0);
});
