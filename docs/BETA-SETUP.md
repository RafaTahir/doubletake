# DoubleTake beta setup

Real funding, automation and verified email require the setup below. The founder creates accounts, accepts terms, chooses a wallet/domain and funds deployment. No account was registered on the founder's behalf.

| Service | Purpose | Setup |
|---|---|---|
| Railway | Runs app, API and keeper | Create project from this branch, use Dockerfile, mount persistent volume, set US$20 hard monthly usage ceiling |
| Supabase | Persistent Postgres | Create free project, obtain server connection URL with `sslmode=verify-full`, configure trusted CA if required |
| Helius | Reliable Solana RPC | Create free-tier mainnet key, put private endpoint in `SOLANA_RPC_URL`, keep paid upgrades off |
| Resend | Verification/transaction email | Create free account, verify your own domain through DNS, create sending key and webhook secret |

`doubletake-app.vercel.app` is a hosting subdomain. It cannot verify ownership of `vercel.app` for email. Resend requires [a domain you own](https://resend.com/docs/dashboard/domains/introduction). Domain purchase is a separate founder action/expense. The web app can initially use Railway's generated HTTPS address while email awaits DNS verification.

Review current [Railway plans](https://docs.railway.com/pricing/plans), [usage limits](https://docs.railway.com/reference/usage-limits), [Supabase](https://supabase.com/pricing), [Helius](https://www.helius.dev/pricing) and [Resend](https://resend.com/pricing). Set Railway's ceiling in its dashboard; `railway.toml` does not enforce billing limits. Reserve US$5 of the US$25 service budget. A hard hosting ceiling can stop the service; independent owner withdrawals remain available through direct RPC.

## Deploy with funding disabled

1. Deploy this branch to Railway with one replica. Set `APP_ORIGIN` to its generated HTTPS origin.
2. Set `DATABASE_URL`, a random `SESSION_SECRET` of at least 32 characters and distinct 32-byte hex keys for `FEE_ENCRYPTION_KEY` and `BACKUP_ENCRYPTION_KEY`. Store recovery copies securely with the founder. Losing the fee key can prevent refunds. Never paste secrets in chat.
3. Mount persistent storage (for example `/data`) and set `BACKUP_DIRECTORY=/data/backups`. Funding requires a successful encrypted financial snapshot. Test restoration into a separate database before launch.
4. Set mainnet cluster and private Helius RPC. Set Resend key, verified `EMAIL_FROM` and webhook secret. Configure signed delivery webhooks using the API's notification-webhook route.
5. Run `node build/server/migrate.js` in a one-off process with the separate admin `DATABASE_MIGRATION_URL` (and `DATABASE_MIGRATION_CA_CERT` if needed). Create/grant the dedicated runtime role below, then remove migration-admin credentials from the running service environment. Verify `/healthz`, `/health/ready`, market data, authentication, email and backup restoration.
6. Keep `PROGRAM_VERIFIED=false`, `MAINNET_CANARY_VERIFIED=false`, `KEEPER_ENABLED=false`, `OPERATOR_KILL_SWITCH=true`. Hosting the workspace does not authorize capital movement.

Remote Postgres and every production connection require `sslmode=verify-full`; missing, plaintext, `require`, `verify-ca` and no-verification modes are rejected. The connector verifies both the certificate chain and the URL hostname. For Supabase, use the Connect dialog's direct or session-pooler endpoint and enable its SSL-enforcement setting. If the endpoint requires its own root certificate, download that certificate from the authenticated Supabase Database settings and put its PEM contents in the server-only `DATABASE_CA_CERT` variable (actual newlines or literal `\n` work). This follows [Supabase's verification guidance](https://supabase.com/docs/guides/database/connecting-to-postgres#ssl).

Do not put `sslrootcert`, `sslcert`, `sslkey`, host overrides or verification overrides in the URL; use `DATABASE_CA_CERT` for trust. The connector constructs explicit TLS settings, avoiding the [node-postgres URI override issue](https://node-postgres.com/features/ssl#usage-with-connectionstring). Only `sslmode` and optional `application_name` URL parameters are supported. Plaintext Postgres is accepted only on loopback outside production; PGlite remains localnet-only.

Supabase's default admin connection is for migrations, not the running service. Superuser and `BYPASSRLS` roles bypass policies despite `FORCE ROW LEVEL SECURITY`. Every production/remote runtime transaction verifies its current role and rejects those privileges, role-management privileges, and membership in any superuser or `BYPASSRLS` role. An unsafe role disables account/funding services and worker accounting/signing with an actionable readiness error. [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security#bypassing-row-level-security)

After the migration, run this SQL through the separate trusted admin connection on a dedicated beta database. It creates no password; set the runtime role's password using the provider's secure administration workflow, then use that role in `DATABASE_URL`. Do not grant it ownership or membership in admin/service roles. Replace the database name `postgres` if you selected another name.

```sql
CREATE ROLE doubletake_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE postgres TO doubletake_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO doubletake_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.product_users, public.auth_challenges, public.auth_sessions,
  public.strategies, public.market_observations, public.transaction_intents,
  public.execution_receipts, public.fee_wallets, public.fee_credit_events,
  public.notification_outbox, public.email_verifications, public.operator_settings
  TO doubletake_app;
GRANT USAGE, SELECT ON SEQUENCE
  public.fee_credit_events_id_seq, public.market_observations_id_seq
  TO doubletake_app;
```

Production migration requires the explicit admin URL; its optional CA falls back to `DATABASE_CA_CERT` when both endpoints share trust. Run the migration and runtime health check independently. Keep admin credentials out of Railway's persistent application environment and encrypted application backups. See [Supabase certificate verification/enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement) for the provider setting and root-certificate download.

## Program and first user

1. Choose a Solana wallet; share only its public address for invitation. Separate deployment/admin authority from fee-wallet credentials. Wallet setup and funding are founder actions.
2. Build the pinned program on Linux and run actual fork tests. Resolve blockers and obtain independent engineering review; this is not a formal audit.
3. Follow `onchain/README.md` for program/admin instructions. Publish program address, artifact/deployed-data hashes and upgrade authority. Initialize through the upgrade authority, configure exact registry pools and issuer fingerprints, and invite at most five owners. Verify intended xStock users against [issuer restrictions](https://xstocks.com/partner) before activation.
4. Create a reviewed execution address lookup table for fixed Raydium route/tick accounts; set `BETA_LOOKUP_TABLE`. Oversized routes stay blocked rather than changing pools.
5. Set matching `PROGRAM_ID` and build-time `VITE_PROGRAM_ID`. `PROGRAM_EXPECTED_SHA256` hashes deployed ProgramData bytes after its 45-byte metadata header, including allocation padding. Set actual `PROGRAM_UPGRADE_AUTHORITY` or `immutable`. The live verifier checks bytes and authority; a `PROGRAM_VERIFIED=true` flag alone cannot pass mainnet verification.
6. Match `BETA_INVITE_WALLETS` to on-chain invites. Keep all release gates open until their evidence exists. After program/infrastructure/review verification, the founder explicitly approves a small canary. Only then set `CANARY_APPROVED=true` and `CANARY_OWNER` to that invited founder public key; keep `MAINNET_CANARY_VERIFIED=false`. This enables only the authenticated designated owner, without claiming the canary has passed.
7. In that founder-only mode, connect, verify email, create vault, deposit a small reviewed amount, fund the separate SOL allowance and authorize a small cycle. The usual caps are maximums, not suggested canary sizes. Every cycle still requires a fresh qualifying simulation. Absence of arbitrage is valid.
8. Confirm actual ledger receipts, pending reconciliation, pause, withdrawal and unused-credit refund. Stop the worker and withdraw independently. Only after the canary checks pass set `MAINNET_CANARY_VERIFIED=true` for remaining invites; retain the confirmation evidence. Permissions expire within 24 hours.

## Cutover and operations

Make the verified Railway URL canonical, update real public links and retire Vercel from active use only after end-to-end checks. Preserve deployment history.

This branch needs the persistent Node service. `vercel.json` disables automatic Vercel deployment for `codex/product-beta` using [Vercel's branch configuration](https://vercel.com/docs/project-configuration/git-configuration); it does not change the existing production deployment. Review the cutover before merging.

Keep automatic paid upgrades off. `OPERATOR_KILL_SWITCH=true` stops new execution; `SERVICE_BUDGET_EXHAUSTED=true` pauses automation when budget is unavailable. RPC checks queue within rate limits, back off on provider throttling and stop at the request budget. Provider free-tier quotas remain the final boundary. Reconciliation/refunds continue with keeper disabled. Restart with the same database/keys; never delete a pending intent simply to retry it.

Prepaid maximum is 0.005 SOL, default daily limit 0.0005 SOL and per-attempt limit 0.00005 SOL. Only confirmed chain fees are charged, including failed attempts; unresolved signatures reserve funds. Refunds send unused credit to the authenticated owner, retaining the transfer's network fee. Verify actual receipts before inviting users.
