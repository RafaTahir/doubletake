# DoubleTake | Which price is real?

**A read-only venue-gap lens with connected-wallet balances and indicative Jupiter routes for tokenized stocks on Solana.** Solo project for the 2026 Stocklana hackathon. Formerly named Stocklana; the hackathon name is unchanged.

## The relatable problem

"Why does my tokenized stock show a different price in another app?" The same xStock can trade in multiple Solana liquidity pools. A visible pool quote is not a guaranteed execution price, and neither one is necessarily the US exchange share price. This app measures the gap between two observed venues and explains the market clocks, fragmentation, and liquidity behind the difference.

## 60-second judge demo

1. Open the live demo. The example balances are explicitly fictional; the market quotes load live.
2. Look at AAPLx, TSLAx and NVDAx. Each card selects the two USDC pools with the most reported USD liquidity above $1,000 and shows their respective token prices and percentage venue gap.
3. Open Pool A or Pool B to inspect the source market. Tap Refresh prices.
4. Use the one-tap asset selection, expand a card to see liquidity and the in-memory live gap trail (45-second checks while visible), or paste a public Solana mainnet wallet address to attempt a live SPL Token and Token-2022 lookup. The server function may be rate-limited by public RPC; use the example if lookup fails.
5. Read the explanation below: different clocks, different markets, different depth.

## Why Solana?

The app identifies xStocks by their verified Solana mints and compares Solana-native liquidity venues. The optional wallet path reads actual SPL token accounts by mint. It is not a generic stock ticker page: the problem is onchain market fragmentation and the need for trustworthy price context.

## Architecture

React/TypeScript app with Vercel server functions for read-only RPC balances and indicative Jupiter route quotes. Wallet-adapter offers Phantom and Solflare connections, with no signature requests, custody, contract, or trading. `src/data/assets.json` maps five official xStocks Solana mints (AAPLx, TSLAx, NVDAx, MSFTx and GOOGLx), verified from the xStocks public asset API. `src/App.tsx` queries DexScreener per mint, filters Solana pairs where the xStock is base and USDC is quote, requires reported liquidity above $1,000, sorts by reported liquidity, and compares the top two `priceUsd` quotes: `(Pool A / Pool B - 1) × 100`. Quotes and links are checked live and labeled unavailable if absent. Demo balances are fictional and have no bearing on pricing. The wallet path attempts Solana mainnet `getTokenAccountsByOwner` for both token programs and sums positive balances of recognized mints. `src/style.css` handles mobile and desktop presentation.

## Limitations and honesty

- Only five verified mints and qualifying USDC pools appear. A real wallet can contain others. A market with only one pool has no calculable venue gap.
- The server uses public mainnet RPC unless SOLANA_RPC_URL is set; rate limits or downtime can make balance lookup unavailable. Demo mode remains the reliable happy path.
- DexScreener reports pool prices and liquidity; values may be delayed. Pool selection is a heuristic, not best execution. Fees, spread, route, slippage and pool changes are excluded.
- No US exchange-share or issuer-quote comparison is claimed. xStocks' public issuer API currently does not provide browser CORS access in this host; Pyth Hermes latest prices require an API key (since August 2026). No Pyth bounty claim is made.
- No investment advice, redemption guarantee, quote-to-fill promise or trade execution.

## Sources

- [xStocks API and mint registry](https://docs.xstocks.fi/apis/openapi.md)
- [Solana wallet token-account RPC](https://solana.com/docs/rpc/http/gettokenaccountsbyowner)
- [DexScreener API](https://docs.dexscreener.com/api/reference)
- [Pyth Hermes API-key requirement](https://docs.pyth.network/price-feeds/core/upgrade/preparing)
- [Stocklana official page](https://hackathons.solana.com/hackathons/stocklana)

## Run and extend

This is a React + TypeScript + Vite app with local layout components. Run `npm ci`, `npm run dev` for local development, and `npm run build` for the deployable `dist/` folder. No secret or API key is bundled. Vercel project: `stocklana`, team `rafaeitahir-5792s-projects`, production alias `https://doubletake-app.vercel.app`. Set SOLANA_RPC_URL to a private, reliable mainnet provider for production-grade balance lookup. The current server route defaults to public RPC and can still be rate limited. Preserve the distinction between share, issuer indicative token, and pool execution quotes.

## Phase 1 trading preview

Each card has a separate read-only Jupiter route quote for 10 USDC → xStock and 0.01 xStock → USDC. The route uses Jupiter Lite Swap V1 quote, not Swap V2 Order/Execute, requires no API key, and is explicitly indicative. No transaction is assembled, signed, or submitted. Quotes have no integrator fee, so there is no fee revenue yet. Actual execution, referral-account setup, exact fee disclosure and confirmation need separate Phase 2 work and approval.

## Arbitrage screening (not execution)

The cost screen compares the DexScreener observed gross spot spread with a Jupiter unrestricted $100 USDC → xStock → USDC quote round trip, then subtracts another 1% two-leg slippage stress and $0.02 assumed network cost. A negative estimate is labeled not viable at this size; a positive estimate is only an unverified candidate. The Jupiter routes are *not locked to the two displayed pools*, the legs are quoted sequentially, liquidity changes, and actual network fees can differ. The displayed estimates are not realized arbitrage, promises of profit, investment advice, or transactions. Execution remains disabled.
