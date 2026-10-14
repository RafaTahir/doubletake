# DoubleTake backend

The Node service serves the Vite build, owner-scoped API and a bounded keeper. Markets work without Postgres. Financial account state never falls back to an in-memory store.

## Configuration

Use `.env.example` at the repository root. Important backend variables:

| Variable | Purpose |
| --- | --- |
| `APP_ORIGIN` | Exact browser origin. Mutating API requests must send this origin. |
| `DATABASE_URL` | Private Postgres connection; use a dedicated runtime role without superuser or RLS-bypass privileges. |
| `BETA_INVITE_WALLETS` | Comma-separated list of at most five invited Solana addresses. |
| `SESSION_SECRET` | At least 32 random characters; enables durable wallet sessions. |
| `FEE_ENCRYPTION_KEY` | A server-held 32-byte hex key for isolated prepaid fee wallets. |
| `BACKUP_DIRECTORY` | Directory on a mounted persistent volume for encrypted daily financial snapshots. |
| `BACKUP_ENCRYPTION_KEY` | A separate 32-byte hex key. Keep an offline copy for disaster recovery. |
| `SOLANA_CLUSTER`, `SOLANA_RPC_URL` | Cluster and private RPC endpoint. Localnet is required for PGlite. |
| `KEEPER_ENABLED` | Enables the worker after the chain, database, backup and email gates pass. |
| `OPERATOR_KILL_SWITCH` | Pauses executions while receipts, owner controls and refunds continue. |
| `SERVICE_BUDGET_EXHAUSTED` | Stops executions when the service spending allowance is exhausted. |
| `CANARY_APPROVED`, `CANARY_OWNER` | Explicit founder-only approval and an invited public wallet for a deployment canary; neither flag is enabled by default. A canary does not claim the mainnet beta is verified. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email delivery credentials and a verified sending domain. |
| `RESEND_WEBHOOK_SECRET` | Svix signing secret; bounce/delivery webhooks remain disabled without it. |

Program bytecode, upgrade-authority and canary verification variables are documented in the deployment guide. `/api/config` returns the actual reasons that funding/automation remain disabled.

Production requires an HTTPS `APP_ORIGIN` so authenticated cookies always use Secure transport. HTTP origins are accepted only for loopback development outside production.

Remote/production Postgres requires `sslmode=verify-full` and validates the certificate chain plus hostname. `DATABASE_CA_CERT` optionally supplies trusted PEM certificates; SSL/host override URL parameters are rejected. The runtime and migration command use the same connector. Only loopback development may use plaintext Postgres.

The runtime role must not be superuser, `BYPASSRLS`, `CREATEROLE`, or a member of a superuser/`BYPASSRLS` role. Production/remote repository transactions recheck those permissions before accessing data. Unsafe roles disable the financial service and produce a readiness reason; local development PGlite may use its default role. Migrations use a separate one-off `DATABASE_MIGRATION_URL`, never the application's runtime login; `docs/BETA-SETUP.md` supplies the restricted role/grants SQL.

Run `npm run db:migrate` with the server environment loaded before `npm run dev` or `npm start`. Runtime credentials stay on the backend; no Supabase browser database keys are used. The migration enables and forces owner-scoped RLS. `ProductStore.scope` sets scope only inside a transaction, with a separate trusted system scope for reconciliation and jobs.

For localnet only, `DATABASE_URL=pglite:.local/database` uses real embedded Postgres. Production and mainnet configurations reject this adapter.

## Financial lifecycle

1. Wallet-signature sign-in uses a one-time, five-minute origin/cluster-bound challenge and a 24-hour HttpOnly session. Private mutations require the returned `csrfToken` in `X-CSRF-Token`.
2. A draft remains off-chain until its owner-signed configuration is confirmed. Raw quantities stay integer strings.
3. Preparing an action requires an `X-Idempotency-Key`. The signed message must exactly match the prepared message. The transaction signature and wire bytes are committed **before** the first broadcast.
4. Send failures remain submitted/unresolved. The worker reads chain receipts or proves blockhash expiry; it never blindly rebroadcasts. USDC changes and network fees are recorded only from verified receipts.
5. Fee reservations are row locked. The 0.005 SOL balance cap includes pending funding; concurrent refunds cannot consume reserved execution fees. Confirmed failed executions charge their actual network fee once.
6. Three failed/expired submitted cycles block further execution until an owner-signed renewal. The worker also blocks expired permissions, inactive invites, unsupported mint/pool state, exhausted allowances and operator pauses.

Owner-signed pause/revoke/withdraw/recovery controls can bypass the worker. `/api/transactions/import` accepts only a public signature/action claim; it never broadcasts client wires. Unknown signatures remain unverified, reserve no fees and cannot hold an execution lease. They use persisted exponential reconciliation backoff, while verified submitted transactions receive priority. Actual canonical owner instructions and chain receipts must be verified before the claim is added to the financial ledger; server-proven receipts can import even when the unverified-claim limit is reached. Fresh vault nonces and full simulation continue to guard execution against actual owner exits. Former invitees retain authentication for owner exits and fee refunds while new funding and automation are denied.

Confirmed execution receipts retain the guard's actual mint fingerprint and raw received-token quantity when those event fields are available, alongside the captured multiplier context. Missing event metadata stays null rather than being inferred from estimates.

## HTTP interfaces

- Public: `GET /api/config`, `GET /api/markets` and health checks.
- Auth: `POST /api/auth/challenge`, `POST /api/auth/verify`, `GET /api/auth/session`, `POST /api/auth/logout`.
- Account: `GET /api/portfolio`, `GET/PUT /api/strategy`, `POST /api/strategy/preview`, `GET /api/activity` and authenticated `POST /api/rpc`. The RPC proxy allows reads only and shares the service credit budget.
- Owner actions: `POST /api/transactions/prepare`, `/submit`, `/import`.
- Prepaid SOL: `GET /api/fees`, `POST /api/fees/funding-intent`, `/reconcile`, `/refund`. An omitted refund amount requests the balance less the actual prepared network fee.
- Notifications: `GET/PUT /api/notifications`, `POST /api/notifications/verify`, `/confirm`, `GET /api/notifications/deliveries`, signed provider webhook.

Financial endpoints return `{intent}`. An email status of `sent` means provider acceptance; `delivered` requires a signed delivery webhook. Failed notification delivery cannot alter financial accounting.

Email provider quota/authentication failures durably pause new automated executions. Their outbox records stay queued and retry through a timed provider probe, including after restarts; an accepted provider send clears the pause. Changing or bouncing a verified email blocks an existing strategy before quoting or signing, until the owner verifies the email and renews automation. Owner exits, fee refunds and transaction reconciliation continue throughout this delivery outage.

## Backups and verification

The worker creates one authenticated AES-256-GCM financial snapshot per UTC day, preserving user settings, strategy metadata, intents, receipts, prepaid-fee events, encrypted fee keys and outbox state. It does not write plaintext backups or copy authentication sessions. Price observations stay in Postgres for 30 days. Startup refuses funding when a configured durable backup cannot be written and decrypted. Keep the backup volume and both encryption keys independently recoverable.

`npx tsx --test tests/backend-product.test.ts` exercises real Postgres migrations, concurrent auth/replay, CSRF, durable transaction claims, duplicate settlement, fee/funding/refund races, external owner actions, exclusive leases, failure pauses, notification deduplication and encrypted backup integrity. Chain and program tests supply the independent proof that actual swaps and owner instructions are valid; these backend tests use injected chain boundaries and do not send transactions.
