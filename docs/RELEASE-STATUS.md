# Beta release evidence

Verification date: 15 October 2026. This branch implements the application, persistent API, keeper, prepaid-fee accounting and guarded Solana program. Funding and automation are disabled by default. A separate Vercel adapter exposes the current workspace and public market observations while persistent services await setup. The updated workspace is deployed at [doubletake-app.vercel.app](https://doubletake-app.vercel.app/) and passed signed-out production API and browser checks. No mainnet execution is recorded.

## Verified locally

| Area | Evidence |
|---|---|
| Application and API | `npm test`: 71 tests passed, including the existing quote/calculation tests, 24 backend tests using embedded Postgres and the real Fastify API, and three public-workspace adapter tests |
| Vercel adapter | Tests verify constant disabled funding/automation gates, explicit unavailable account/actions, source timestamps, five-second cache expiry, request deduplication and bounded per-instance requests. Hosted signed-out production returned configuration/session HTTP 200 and seven actual pool observations with fees, prices, source slots and timestamps. All snapshots set execution eligibility false; JUP quoting remains blocked by depth checks, and private actions returned HTTP 503 |
| Production build and runtime | `npm run build` passed after the hosting fixes: frontend TypeScript/Vite and compiled Node service. `npm run test:runtime` passed against compiled native Node modules. The wallet bundle produces a size advisory, with no build error |
| GitHub CI | [Run 38612399311](https://github.com/RafaTahir/doubletake/actions/runs/38612399311) passed application checks including the compiled runtime, production Docker startup, and Rust program unit tests for commit `a6696721a8d536d94f98ef97aaef38297e8b06d0` |
| Dependency installation and advisories | A clean `npm ci` installed 334 packages after the hosting lockfile correction; `npm ls` reported no invalid dependencies and `npm audit --json` returned zero known advisories. The rpc-websockets CommonJS load passed with experimental require-module support disabled |
| Program logic and client checks | 12 locked Rust tests and 8 independent transaction/client checks passed |
| Program bytecode | Clean SBF build with no stack-frame diagnostics; SHA-256 `f29b7ed413790829893c0e7662e79157d1d07f3bfdeb3fc16107ee76f25b7873` |
| Actual owner controls | The built SBF passed offline runtime checks for bootstrap authority, unauthorized actions, pause/withdraw/revoke, close/reinitialize nonce persistence and independent recovery |
| SOL and AAPLx cycles | Native Raydium code and forked pool state passed initialize/deposit/configure, profitable atomic cycles, explicitly losing reverse cycles and second-leg rollback, actual received-amount handoff, replay rejection, exact fee reconciliation and confirmed receipt metadata |
| Token correctness | AAPLx exercised actual Token-2022 mint metadata and scaled amounts; frozen accounts, scheduled multiplier activation and missing ticks blocked execution |
| Pre-created accounts and gifts | An unrelated signer pre-created both canonical vault ATAs and gifted USDC/intermediate dust. Initialization succeeded; cycles retained the dust, and owner withdrawal/recovery returned all funds while admission and service were paused |
| Accounting and restart behavior | Tests cover durable signed intents before broadcast, ambiguous confirmation, exclusive leases, idempotent charges/refunds, unknown-signature imports, fee reservations, failure pauses and authenticated encrypted backup round trips |
| Database isolation | Actual restricted-role Postgres tests reject foreign reads/writes through forced RLS. Remote/production runtime transactions reject superuser, RLS-bypass/role-management privileges and privileged role membership; migrations use a separate admin connection |
| Native SOL credit and refund | The actual local runtime and transaction gateway credited 1,500,000 lamports, confirmed a 1,493,600-lamport owner refund plus 6,400 lamports of network fee, and left the isolated wallet at zero. Fixed recipient, owner balance changes and journal-before-broadcast were verified |
| Notifications | Verified-email preferences, deduplication, provider acceptance/delivery states, quota backoff and a persistent execution pause were tested with a controlled provider fixture |
| Interface | Desktop, tablet and 375-pixel mobile navigation, public markets, real empty states and independent recovery gates were inspected in the browser; no horizontal overflow or unsolicited signing prompt |

The fork fixtures deliberately create a price difference through **local** swaps. Their profits establish execution behavior, not a live arbitrage opportunity. Both token accounts retain any pre-existing dust; the invariant is zero **additional** intermediate inventory.

Production fee accounting uses the confirmed RPC receipt's `meta.fee` and verifies balance conservation. A Surfpool priority-fee discrepancy is handled only on `localnet`; the workaround cannot override production receipt fees.

## Hosted production

[DoubleTake](https://doubletake-app.vercel.app/) points to production deployment `dpl_6ZjRhHFdzspPzpYt3sfiE43tMQGW`, [deployment URL](https://stocklana-kkgy2ga3i-rafaeitahir-5792s-projects.vercel.app), built from clean commit `a6696721a8d536d94f98ef97aaef38297e8b06d0`. Signed-out API checks and browser inspection confirmed the current workspace and seven real market observations on 15 October 2026. Configuration keeps funding and automation disabled. This verifies public market serving, not the persistent account service or financial workflows.

The earlier [verified preview](https://stocklana-b9uo6cd8p-rafaeitahir-5792s-projects.vercel.app), identifier `dpl_Eju2bY2NaceWgNv59exhUXpXPS95`, remains part of the deployment history. The historical Vercel project name is `stocklana`; its identifiers were preserved. Railway's account is accessible, but repository access through its GitHub application is missing. Railway has not been deployed and no canonical-host migration is claimed.

## Engineering review

A separate implementation agent reviewed custody, signing, replay, accounting and owner-exit paths. Six concrete issues were corrected: pre-created ATA initialization, nonce/cooldown reset on vault recreation, loss of email verification, unknown imported signatures blocking leases, production HTTP sessions, and production fee authority. Regression checks accompany the fixes. This is an engineering review, **not a formal external audit**. A founder-designated independent engineer must review the final deployment and canary before admitting mainnet users.

Hard capital/profit/cooldown/daily-cycle/expiry guards reside on chain. Any owner-selected limits stricter than the program's ten-cycle/60-second defaults, and the separate SOL spend limits, are enforced by the service. SOL credit remains service controlled; refunds depend on that service.

## Gates still open

- Founder wallet, initial invitees, Railway GitHub repository access, usable Supabase/Helius/Resend configuration and an owned, DNS-verifiable email domain.
- Real hosted Postgres/TLS connectivity, actual email verification/delivery/webhooks, Railway volume/backup restoration and provider usage limits.
- Founder-owned program address and deployment authority; rebuilding for that address, publishing and verifying the deployed ProgramData hash and authority. The development artifact above is not a production deployment identity.
- Final deployment review, issuer eligibility for intended xStock users, asset-specific activation checks and a founder-approved small mainnet canary.
- Actual wallet-driven desktop/mobile funding → authorization → execution → accounting → pause/withdraw/refund checks against the deployed service. API/SVM tests and disconnected browser inspection do not substitute for those checks.
- Verified Railway deployment URL and persistent-service public-link cutover. The current Vercel production deployment remains the public workspace until that replacement is verified.

Keep `PROGRAM_VERIFIED=false`, `MAINNET_CANARY_VERIFIED=false`, `KEEPER_ENABLED=false` and `OPERATOR_KILL_SWITCH=true` until the documented evidence exists. [Setup instructions](BETA-SETUP.md) and [program reproduction details](../onchain/VERIFICATION.md) describe the remaining steps. No external users, real fills or real email deliveries are claimed.

The Vercel adapter has no database, fee-wallet signer, transaction builder or keeper. All market snapshots set `executionEligible=false`; a price gap is observation data and cannot activate trading. Its rate and credit counters are instance-local rather than a durable monthly limit. Persistent accounting and provider-budget controls belong to the Railway service.
