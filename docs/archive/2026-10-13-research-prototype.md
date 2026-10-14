# DoubleTake | A price gap is a reason to investigate

**Pre-trade research for xStock arbitrage traders on Solana.** Compare observed pool prices, inspect liquidity, and check a separate Jupiter round-trip quote before deciding what deserves further investigation.

[Live app](https://doubletake-app.vercel.app) · [Source](https://github.com/RafaTahir/doubletake) · [Colosseum Crypto World's Fair](https://colosseum.com/worldsfair)

## What the prototype does

An xStock can have different quoted prices across Solana pools. A visible gap alone does not show an executable profit. DoubleTake puts pool observations and a size-specific route check in one research workflow, while keeping the calculations separate.

- Compare the two qualifying USDC pools with the greatest reported liquidity for a supported mint.
- Inspect each source pool, its reported liquidity, and a short in-memory gap history.
- Request an indicative $100 USDC → xStock → USDC round trip through Jupiter. Returned USDC minus starting USDC is the quoted round-trip P&L; the observed pool gap is never added to it.
- Inspect separate 10 USDC buy and 0.01 xStock sell quotes with route details.
- Optionally connect a wallet or paste a public address to read supported balances. Example balances are fictional; market requests are live.

No transaction is created, signed, or submitted. A negative round trip can help a trader move on or investigate further. A positive quote is not proven arbitrage.

## Quick product walkthrough

1. Open the live app and choose AAPLx in the example portfolio. The displayed holdings are fictional.
2. Compare the observed pool prices, inspect liquidity, and follow a source pool link.
3. Request a fresh $100 round-trip quote. Inspect returned USDC, quoted P&L, route labels and timestamp. Jupiter may use different pools from those displayed.
4. Refresh expired quotes; results expire after 30 seconds.
5. Try another supported asset, or optionally inspect a public wallet. No signature or trade is required.

## Data and calculations

The registry recognizes AAPLx, TSLAx, NVDAx, MSFTx and GOOGLx by mint. Supported xStocks use eight token decimals; USDC uses six. Quantities refer to token units, not an assumed number of underlying shares. Asset scaling or corporate actions can make token and share units differ.

DexScreener comparisons select Solana pairs with the supported xStock as base, USDC as quote, and more than $1,000 reported USD liquidity. The two deepest qualifying pools are compared using `(Pool A price / Pool B price - 1) × 100`. Fewer than two qualifying pools means no comparison. This heuristic does not establish best execution.

The Jupiter round trip feeds the first quote's raw xStock output into the second quote. The legs are sequential, unrestricted and indicative. Route costs and price impact are reflected in quoted output; network costs and later price movement are not guaranteed by it. A separate stress scenario subtracts 1% of starting USDC plus a $0.02 network allowance from the quoted P&L. These allowances are assumptions, not measured fills. The observed pool gap and quoted round-trip P&L are independent observations.

Pool checks run every 45 seconds while the page is visible. Gap history lives in memory and resets on reload. A last-good pool observation is marked stale when a later request fails. Route results expire after 30 seconds and must be requested again.

## Architecture and local development

React, TypeScript and Vite provide the interface. Vercel server functions perform read-only Solana RPC balance lookups and Jupiter quote requests. Wallet-adapter supports Phantom and Solflare without requesting signatures. Balance lookup reads SPL Token and Token-2022 accounts and sums recognized positive balances.

```sh
npm ci
npm test
npm run dev
npm run build
```

Use Node.js 22 or later. The checked-in `.npmrc` matches the lockfile's legacy peer dependency resolution. `npm test` checks quote units, raw amount handoff, calculation correctness, expiry and unavailable states. `npm run build` type-checks and generates `dist/`. Vite alone serves the frontend; `/api` functions need a Vercel-compatible development runtime for wallet and quote requests. Configure `SOLANA_RPC_URL` on the server for reliable balance lookup; the public RPC fallback can be rate-limited. No private key is required.

The prototype uses Jupiter Swap V1 through `api.jup.ag`. Keyless access works with provider rate limits; optionally configure `JUPITER_API_KEY` as a server-only Vercel environment variable for the account's API quota. Quotes are requested manually to avoid a burst on page load. Endpoint availability is a live dependency.

## Limits and next milestone

Five supported mints, USDC pool pairs and fixed quote sizes are supported. Source data can be delayed or unavailable. There is no exact-pool arbitrage route, synchronized quote pair, atomic execution, backtest, alert service or guaranteed fill. There is no US exchange-share comparison, issuer redemption valuation or Pyth integration.

No user, revenue or profitability metrics are claimed here. The next validation step is to observe active xStock traders researching actual gaps and measure their time to a decision and willingness to return. Proposed future work includes configurable sizes, exact-pool quote investigation and paid monitoring if demand is validated. The current prototype charges no integrator fee.

## Competition and development history

Prepared for **Colosseum Crypto World's Fair 2026**, Solana ecosystem track. The official cutoff is **October 12, 2026, 11:59 p.m. Pacific / October 13, 2026, 2:59 p.m. Malaysia time**. The founder handles registration and submission.

The available Git history starts September 25, 2026 and already contains the pool viewer, wallet lookup and indicative quote features. Current preparation reuses that code and corrects the quote model and token-unit presentation. The first commit does not prove when development began. Any work before September 14, prior submissions, reused components and funding must be disclosed accurately in the competition form. Git history has not been rewritten.

## Primary sources

- [Colosseum current submission FAQ](https://colosseum.com/hackathon?year=fall2026)
- [Crypto World's Fair official rules](https://colosseum.com/legal/Crypto%20World%27s%20Fair%20Hackathon%20Rules.pdf)
- [xStocks API and mint registry](https://docs.xstocks.fi/apis/openapi.md)
- [DexScreener API](https://docs.dexscreener.com/api/reference)
- [Jupiter quote API](https://developers.jup.ag/docs/api-reference/swap/v1/quote)
- [Solana token-account RPC](https://solana.com/docs/rpc/http/gettokenaccountsbyowner)
