# DoubleTake | Which price is real?

**A read-only, live venue-gap viewer for tokenized stocks on Solana.** Solo project for the 2026 Stocklana hackathon. Formerly named Stocklana; the hackathon name is unchanged.

## The relatable problem

"Why does my tokenized stock show a different price in another app?" The same xStock can trade in multiple Solana liquidity pools. A visible pool quote is not a guaranteed execution price, and neither one is necessarily the US exchange share price. This app measures the gap between two observed venues and explains the market clocks, fragmentation, and liquidity behind the difference.

## 60-second judge demo

1. Open the live demo. The example balances are explicitly fictional; the market quotes load live.
2. Look at AAPLx, TSLAx and NVDAx. Each card selects the two USDC pools with the most reported USD liquidity above $1,000 and shows their respective token prices and percentage venue gap.
3. Open Pool A or Pool B to inspect the source market. Tap Refresh prices.
4. Paste a public Solana mainnet wallet address to attempt a live SPL Token and Token-2022 lookup. Some public RPC endpoints may reject browser requests, so the example route remains the reliable demo.
5. Read the explanation below: different clocks, different markets, different depth.

## Why Solana?

The app identifies xStocks by their verified Solana mints and compares Solana-native liquidity venues. The optional wallet path reads actual SPL token accounts by mint. It is not a generic stock ticker page: the problem is onchain market fragmentation and the need for trustworthy price context.

## Architecture

Single-page React/TypeScript app. No backend, wallet signature, custody, contract or trading. `src/data/assets.json` maps five official xStocks Solana mints (AAPLx, TSLAx, NVDAx, MSFTx and GOOGLx), verified from the xStocks public asset API. `src/App.tsx` queries DexScreener per mint, filters Solana pairs where the xStock is base and USDC is quote, requires reported liquidity above $1,000, sorts by reported liquidity, and compares the top two `priceUsd` quotes: `(Pool A / Pool B - 1) × 100`. Quotes and links are checked live and labeled unavailable if absent. Demo balances are fictional and have no bearing on pricing. The wallet path attempts Solana mainnet `getTokenAccountsByOwner` for both token programs and sums positive balances of recognized mints. `src/style.css` handles mobile and desktop presentation.

## Limitations and honesty

- Only five verified mints and qualifying USDC pools appear. A real wallet can contain others. A market with only one pool has no calculable venue gap.
- Public mainnet RPC can reject browser requests, and the wallet lookup has not been verified end-to-end in the hosted browser. It is an experimental path. Demo mode is the reliable happy path.
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

This is an Instinct Files source project using React and `@instinct/files` supplied by the host. `src/main.tsx` mounts the UI; no secret or API key is bundled. To port to a conventional Vite host, install React, React DOM, TypeScript and the Files kit or replace its layout primitives. Set up a reliable first-party Solana RPC proxy if wallet lookup is important, and an authenticated server-side market feed if comparing the actual US share price. Preserve the distinction between share, issuer indicative token, and pool execution quotes.
