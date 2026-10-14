# Beta release evidence

Verification date: 15 October 2026. This branch implements the application, persistent API, keeper, prepaid-fee accounting and guarded Solana program. The canonical public workspace and Node service are deployed at [DoubleTake on Railway](https://doubletake-production-446f.up.railway.app/). Signed-out health, configuration, session and seven live market responses passed. Postgres, email, financial keys, invitations and program identity remain unconfigured, so funding and automation are disabled. No mainnet execution is recorded.

## Verified locally

| Area | Evidence |
|---|---|
| Application and API | `npm test`: 71 tests passed, including the existing quote/calculation tests, 24 backend tests using embedded Postgres and the real Fastify API, and three public-workspace adapter tests |
| Retained Vercel adapter | Tests verify constant disabled funding/automation gates, explicit unavailable account/actions, source timestamps, five-second cache expiry, request deduplication and bounded per-instance requests. The earlier hosted workspace returned configuration/session HTTP 200 and seven actual pool observations with fees, prices, source slots and timestamps. All snapshots set execution eligibility false; JUP quoting remained blocked by depth checks, and private actions returned HTTP 503. The current public Vercel address redirects to Railway |
| Production build and runtime | `npm run build` passed after the hosting fixes: frontend TypeScript/Vite and compiled Node service. `npm run test:runtime` passed against compiled native Node modules. The wallet bundle produces a size advisory, with no build error |
| GitHub CI | All three jobs in [run 38617449710](https://github.com/RafaTahir/doubletake/actions/runs/38617449710) passed application checks including the compiled runtime, production Docker startup, and Rust program unit tests for active source commit `d2c3424cd07e8da9ec69aa3fe1818679db931ab6` |
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

## Hosted Railway service

The canonical workspace is [doubletake-production-446f.up.railway.app](https://doubletake-production-446f.up.railway.app/). Railway shows active, successful deployment `99e2b963-d6f7-4b14-8544-b6d791098ea1`, titled “Redirect the Vercel root explicitly to Railway,” from source commit `d2c3424cd07e8da9ec69aa3fe1818679db931ab6`. The public application has Railway canonical metadata and checked frontend asset `index-D-jcudr_.js`; all seven markets are available and funding/automation remain false.

Actual build logs confirm base image `node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e`, current container digest `sha256:ab1eb4f2c971771b882eeaca4516c89d968b54d71e3ddce39817ebb6d7a2c809`, and a successful `/healthz` deployment check. Runtime version evidence comes from these Docker logs rather than the platform's language badge.

The initial verified deployment `69213239-68e1-4317-81aa-4cc605bf5255`, from commit `bf3d0c670a5519f9e7ad591d04f254aa4c549875` and Docker image identifier `72b6b12891a2a6872a3493a18fa0f470bb5c23041c1a9dd35e7e28a15ae5da45`, is historical evidence. Railway has removed that older deployment; it is not the active release and its image identifier is not attributed to the current build.

| Resource | Actual identifier or setting |
|---|---|
| Project | `DoubleTake`, `4b286573-c40f-4a25-8441-b9eb36ad5dab` |
| Environment | `6e5176b3-7a10-4472-bda0-d5611e362e15` |
| Service | `730bef0b-034e-4331-a998-662e04da69eb` |
| Persistent volume | `13d9d76b-eab5-47e9-96fe-78d13c4f9234`, mounted at `/data` |
| RPC usage counter | `/data/backups/.rpc-usage.json` |
| Runtime/deployment | Dockerfile builder at `/Dockerfile`; actual logs confirm Node 22.22.2. Region `iad`, one replica, `/healthz`, at most three failure restarts |
| Source/deployment gate | Automatic GitHub deployment disabled; “Wait for CI” unchecked. Future releases must be manually deployed only after CI passes for the exact commit |
| Active configuration | Railway service dashboard; `railway.toml` is not active for this new project |
| Trial boundaries | 30-day trial, US$5 credit cap; plan maxima 2 vCPU, 1 GB memory and 1 GB disk. Custom CPU/memory limits could not be set with the disabled trial sliders |

Signed-out `/healthz` returned HTTP 200 with `ok`; `/health/ready` returned HTTP 200 with `configuration-required` and `accountsReady=false`. `/api/config` returned HTTP 200 with funding/automation false and no program identity. `/api/auth/session` returned HTTP 200 with no user. `/api/markets` returned HTTP 200 with all seven markets available from actual Raydium state. JUP quoting was blocked by depth checks, and all execution eligibility values remained false.

The active Railway workspace was inspected in a 1280 × 720 browser viewport with no horizontal overflow. Its canonical metadata and engineering source link point to the current Railway origin and deployed branch; actual AAPLx prices, issuer multipliers and source slots loaded.

This confirms cloud process/public-market availability, not complete account or financial workflows. Database, email, fee/backup encryption keys, program identity and invitees are unset; encrypted financial backup/restoration is unverified. The trial cap is not the intended paid US$20 monthly hard limit: that control was unavailable in the trial dashboard and remains required before any founder-approved billing upgrade. No paid upgrade or new account terms were accepted.

Automatic GitHub deployment was disabled through Railway's Source settings after verification to freeze this beta. This also left its “Wait for CI” checkbox unchecked; no automatic CI gate is claimed. A documentation-only push leaves the verified container running. Future releases require passing CI, a manual deployment and fresh hosted checks.

## Vercel deployment history

The earlier [Vercel workspace](https://stocklana-kkgy2ga3i-rafaeitahir-5792s-projects.vercel.app), deployment `dpl_6ZjRhHFdzspPzpYt3sfiE43tMQGW`, was built from clean commit `a6696721a8d536d94f98ef97aaef38297e8b06d0`. Signed-out production API and browser checks verified the workspace and seven real market observations. The [verified preview](https://stocklana-b9uo6cd8p-rafaeitahir-5792s-projects.vercel.app), deployment `dpl_Eju2bY2NaceWgNv59exhUXpXPS95`, also remains part of the history. The historical project name `stocklana` and real deployment identifiers were preserved.

The current [doubletake-app.vercel.app](https://doubletake-app.vercel.app/) alias points to redirect deployment `dpl_A5oe1qpQU37YaWCnm3CxQmsfGbeQ`, [deployment URL](https://stocklana-pqbfy4n5a-rafaeitahir-5792s-projects.vercel.app/), built from commit `d2c3424cd07e8da9ec69aa3fe1818679db931ab6`. Signed-out requests to `/` and `/api/config` returned HTTP 307 to the matching Railway destination, and browser navigation arrived at the actual Railway workspace. The configuration includes an explicit root rule as well as the rule for other paths. CI for the preceding frontend metadata/source-link change passed in [run 38616846640](https://github.com/RafaTahir/doubletake/actions/runs/38616846640); all jobs for the final redirect rule passed in [run 38617449710](https://github.com/RafaTahir/doubletake/actions/runs/38617449710).

## Engineering review

A separate implementation agent reviewed custody, signing, replay, accounting and owner-exit paths. Six concrete issues were corrected: pre-created ATA initialization, nonce/cooldown reset on vault recreation, loss of email verification, unknown imported signatures blocking leases, production HTTP sessions, and production fee authority. Regression checks accompany the fixes. This is an engineering review, **not a formal external audit**. A founder-designated independent engineer must review the final deployment and canary before admitting mainnet users.

Hard capital/profit/cooldown/daily-cycle/expiry guards reside on chain. Any owner-selected limits stricter than the program's ten-cycle/60-second defaults, and the separate SOL spend limits, are enforced by the service. SOL credit remains service controlled; refunds depend on that service.

## Gates still open

- Founder wallet, initial invitees, usable Supabase/Helius/Resend configuration and an owned, DNS-verifiable email domain.
- Real hosted Postgres/TLS connectivity, actual email verification/delivery/webhooks, financial encryption keys, encrypted backup/restoration and provider usage limits. The existing Railway volume alone does not satisfy these gates.
- Founder-owned program address and deployment authority; rebuilding for that address, publishing and verifying the deployed ProgramData hash and authority. The development artifact above is not a production deployment identity.
- Final deployment review, issuer eligibility for intended xStock users, asset-specific activation checks and a founder-approved small mainnet canary.
- Actual wallet-driven desktop/mobile funding → authorization → execution → accounting → pause/withdraw/refund checks against the deployed service. API/SVM tests and disconnected browser inspection do not substitute for those checks.
- The US$20 paid monthly hard usage limit before any approved billing upgrade.

Keep `PROGRAM_VERIFIED=false`, `MAINNET_CANARY_VERIFIED=false`, `KEEPER_ENABLED=false` and `OPERATOR_KILL_SWITCH=true` until the documented evidence exists. [Setup instructions](BETA-SETUP.md) and [program reproduction details](../onchain/VERIFICATION.md) describe the remaining steps. No external users, real fills or real email deliveries are claimed.

The retained Vercel adapter has no database, fee-wallet signer, transaction builder or keeper; its rate and credit counters are instance-local. Railway now runs the Node service with persistent RPC usage accounting, while the missing financial prerequisites keep every market's `executionEligible=false`. A price gap is observation data and cannot activate trading.
