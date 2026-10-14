# DoubleTake — release and demo checks

**Colosseum Crypto World's Fair · Solana ecosystem track**

Live app: https://doubletake-app.vercel.app
Source: https://github.com/RafaTahir/doubletake
Competition: https://colosseum.com/worldsfair

The founder handles signup and submission. Preparing or deploying the app does not register or submit it.

## Verify the app before recording

1. Build with `npm run build`, then verify the deployed revision on desktop and a narrow mobile viewport.
2. Choose AAPLx in the example portfolio. Make clear that balances are fictional; pool observations are fetched live.
3. Inspect two qualifying USDC pools, their prices and liquidity, then open a source pool link. With only one available pool, a gap must not be fabricated.
4. Request a fresh $100 round-trip quote. Returned USDC minus 100 USDC must match the quoted P&L. The observed pool gap must not be added to it.
5. Check that token amounts use the mint's decimals and are labeled as token units. Do not describe an xStock token as one share without an asset-specific scaling basis.
6. Wait for the quote's 30-second expiry and refresh it. An old quote must not remain presented as current.
7. Verify an unavailable quote does not imply zero cost, zero price or profit. Optional wallet lookup may fail independently; the example remains available.

## Honest demo narration

“DoubleTake helps active xStock arbitrage traders investigate a price gap before committing capital. These are two observed pool prices, with their source links and liquidity. Here is a separate $100 Jupiter round-trip quote. Its output tells us about those quoted routes, which may differ from the pools above. The legs are sequential and indicative; this is research, not a guaranteed arbitrage trade.”

Describe the result actually on screen. A negative quote is a valid demonstration. Do not pre-write a positive result, replace an unavailable provider with fictional market output, or present example balances as a real portfolio. No transaction is signed or submitted.

## Submission reference for the founder

The official deadline is **October 13, 2026, 2:59 p.m. MYT** (October 12, 11:59 p.m. Pacific). Leave time for video uploads and form completion.

The [current FAQ](https://colosseum.com/hackathon?year=fall2026) lists product identity, logo, chains/tools, location, founder/team backgrounds, GitHub access, a separate 2–3 minute presentation video, a product-demo video of at most 3 minutes, and go-to-market/demand-validation information. All teammates must register; each person/team may submit one product. The authenticated form may ask additional questions.

Confirm development history rather than inferring it from commit dates. Available history starts September 25; disclose any earlier work and previous submissions accurately. Do not claim users, revenue, validated profitability or trading functionality without evidence. Make video and repository links accessible to judges and retain the portal's completed-submission confirmation.

[Official rules](https://colosseum.com/legal/Crypto%20World%27s%20Fair%20Hackathon%20Rules.pdf) take precedence. No late entry or reopening is assumed.
