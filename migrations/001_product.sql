BEGIN;
CREATE TABLE IF NOT EXISTS product_users (
  owner text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(),
  email text, email_verified_at timestamptz,
  preferences jsonb NOT NULL DEFAULT '{"executions":true,"failures":true,"pauses":true,"lowFeeBalance":true}'::jsonb
);
CREATE TABLE IF NOT EXISTS auth_challenges (
  id uuid PRIMARY KEY, owner text NOT NULL, message text NOT NULL,
  expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash text PRIMARY KEY, owner text NOT NULL REFERENCES product_users(owner),
  csrf_hash text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS strategies (
  id uuid PRIMARY KEY, owner text NOT NULL UNIQUE REFERENCES product_users(owner),
  state jsonb NOT NULL, status text NOT NULL CHECK(status IN ('draft','active','paused','expired','blocked')),
  lease_owner text, lease_until timestamptz, last_served_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS market_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, symbol text NOT NULL,
  observed_at timestamptz NOT NULL, snapshot jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS observations_retention ON market_observations(observed_at);
CREATE TABLE IF NOT EXISTS transaction_intents (
  id uuid PRIMARY KEY, owner text NOT NULL REFERENCES product_users(owner),
  strategy_id uuid REFERENCES strategies(id), kind text NOT NULL,
  status text NOT NULL CHECK(status IN ('prepared','submitted','confirmed','finalized','failed','expired','unresolved')),
  idempotency_key text NOT NULL, state jsonb NOT NULL,
  signature text UNIQUE, wire_base64 text,
  fee_wallet text, reserved_fee numeric(20,0) NOT NULL DEFAULT 0 CHECK(reserved_fee >= 0 AND reserved_fee <= 50000),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner,idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_inflight_execution ON transaction_intents(strategy_id)
  WHERE kind='execute' AND status IN ('prepared','submitted','unresolved');
CREATE UNIQUE INDEX IF NOT EXISTS one_inflight_refund ON transaction_intents(owner)
  WHERE kind='fee-refund' AND status IN ('prepared','submitted','unresolved');
CREATE UNIQUE INDEX IF NOT EXISTS one_inflight_owner_action ON transaction_intents(owner)
  WHERE kind NOT IN ('execute','fee-refund','fee-funding') AND status IN ('prepared','submitted','unresolved') AND (state->'payload'->>'external') IS DISTINCT FROM 'true';
CREATE INDEX IF NOT EXISTS pending_reconciliation ON transaction_intents(updated_at) WHERE status IN ('submitted','unresolved');
CREATE TABLE IF NOT EXISTS execution_receipts (
  id uuid PRIMARY KEY, intent_id uuid NOT NULL UNIQUE REFERENCES transaction_intents(id),
  owner text NOT NULL REFERENCES product_users(owner), signature text NOT NULL UNIQUE,
  state jsonb NOT NULL, fee_lamports numeric(20,0) NOT NULL CHECK(fee_lamports>=0),
  occurred_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS fee_wallets (
  owner text PRIMARY KEY REFERENCES product_users(owner), address text NOT NULL UNIQUE,
  encrypted_secret text NOT NULL, balance_lamports numeric(20,0) NOT NULL DEFAULT 0 CHECK(balance_lamports>=0),
  checked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fee_credit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner text NOT NULL REFERENCES product_users(owner), intent_id uuid NOT NULL UNIQUE REFERENCES transaction_intents(id),
  signature text NOT NULL UNIQUE, kind text NOT NULL CHECK(kind IN ('funding','network-fee','refund')),
  amount_lamports numeric(20,0) NOT NULL CHECK(amount_lamports>=0),
  network_fee_lamports numeric(20,0) NOT NULL DEFAULT 0 CHECK(network_fee_lamports>=0),
  occurred_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_outbox (
  id uuid PRIMARY KEY, owner text NOT NULL REFERENCES product_users(owner),
  dedupe_key text NOT NULL UNIQUE, kind text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','delivered','suppressed','bounced','failed')),
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz, provider_id text UNIQUE, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS email_verifications (
  token_hash text PRIMARY KEY, owner text NOT NULL REFERENCES product_users(owner), email text NOT NULL,
  expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operator_settings (
  key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);

-- This database is accessed only by the private backend, never by browser Supabase credentials.
-- Every backend request starts a transaction and sets app.owner or app.system locally.
-- RLS provides a second boundary against accidentally unscoped repository queries.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['product_users','auth_challenges','auth_sessions','strategies','transaction_intents','execution_receipts','fee_wallets','fee_credit_events','notification_outbox','email_verifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='owner_scope') THEN
      EXECUTE format('CREATE POLICY owner_scope ON %I USING (owner=current_setting(''app.owner'',true) OR current_setting(''app.system'',true)=''on'') WITH CHECK (owner=current_setting(''app.owner'',true) OR current_setting(''app.system'',true)=''on'')',t);
    END IF;
  END LOOP;
END $$;
ALTER TABLE market_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS observations_scope ON market_observations;
CREATE POLICY observations_scope ON market_observations USING (current_setting('app.system',true)='on') WITH CHECK(current_setting('app.system',true)='on');
ALTER TABLE operator_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_scope ON operator_settings;
CREATE POLICY operator_scope ON operator_settings USING (current_setting('app.system',true)='on') WITH CHECK(current_setting('app.system',true)='on');
COMMIT;
