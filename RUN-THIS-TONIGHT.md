# DoubleTake submission runbook (Stocklana hackathon)

Live demo and GitHub URLs must be verified after the DoubleTake redeploy and repo rename. The prior public demo is https://stocklana-app.vercel.app and the prior source repo is https://github.com/RafaTahir/stocklana; do not submit a new URL until it is checked.

## Before submitting

1. Open the live demo on a phone and desktop. Example balances are fictional; both pool quotes should load within a few seconds. If prices are unavailable, use Refresh prices once. Do not portray sample balances as a real wallet.
2. Publish this source to the GitHub repo if account access is available. Verify the README and `src/App.tsx` are visible to someone signed out.
3. Record a short screen capture: hero, AAPLx two pool quotes and venue gap, click Pool A/B, scroll to the explanation. Show a working happy path, not a trade. Narrate: "A tokenized US stock can trade across onchain pools even when the share market is closed. These two pools disagree by X%; the app tells me what each number represents."
4. Sign in with a wallet on https://hackathons.solana.com/hackathons/stocklana/submit . The unauthenticated page only shows "Sign in to submit a project" and "Connect Wallet", so the exact form fields beyond the public requirements cannot be verified here. Use a project name, live demo URL and GitHub URL; attach a video if the form requests it.
5. Review the final entry. The site allows edits until the deadline. The user asked us not to click Submit; submit yourself before Saturday Sep 26, 4:00 AM Kuala Lumpur (Friday Sep 25, 4:00 PM ET).

## Honest positioning

This is a **Solana pool-to-pool** comparison. It is not an underlying-share vs xStock comparison or a Pyth live-feed integration. xStocks' issuer API did not permit browser-origin reads here and Pyth Hermes requires an API key. Wallet lookup also hit public-RPC browser restrictions, so demo mode is the dependable showcase. Do not claim a working Pyth bounty entry. Explain what was actually verified.
