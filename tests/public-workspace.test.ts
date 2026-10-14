import test from "node:test";
import assert from "node:assert/strict";
import {
  createPublicWorkspaceHandler,
  publicWorkspaceConfig,
  type PublicWorkspaceResponse,
} from "../api/public-workspace.ts";
import type { MarketSnapshot } from "../shared/types.ts";

class ResponseCapture implements PublicWorkspaceResponse {
  headers: Record<string, string> = {};
  statusCode = 200;
  body: unknown;
  setHeader(name: string, value: string) { this.headers[name] = value; }
  status(code: number) { this.statusCode = code; return this; }
  json(body: unknown) { this.body = body; return this; }
}
const snapshot = (): MarketSnapshot => ({
  symbol: "SOL", name: "Solana", mint: "So11111111111111111111111111111111111111112",
  decimals: 9, category: "crypto", tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  multiplier: "1", multiplierEffectiveAt: null, issuerWarnings: [], pools: [],
  observedGapPct: 0.3, checkedAt: "2026-10-15T00:00:00.000Z", slot: 123,
  status: "available", quoteEligible: true, executionEligible: true,
});

test("public configuration and sessions cannot activate account or trading services", async () => {
  const old = process.env.KEEPER_ENABLED;
  process.env.KEEPER_ENABLED = "true";
  try {
    const handler = createPublicWorkspaceHandler({ snapshot: async () => { throw Error("Must not load markets"); } });
    const config = new ResponseCapture();
    await handler({ method: "GET", query: { route: "config" } }, config);
    assert.equal(config.statusCode, 200);
    assert.equal(config.body, publicWorkspaceConfig);
    assert.equal(publicWorkspaceConfig.fundingEnabled, false);
    assert.equal(publicWorkspaceConfig.automationEnabled, false);
    assert.equal(publicWorkspaceConfig.programId, null);
    assert.equal(publicWorkspaceConfig.readiness.ready, false);
    const session = new ResponseCapture();
    await handler({ method: "GET", url: "/api/auth/session" }, session);
    assert.deepEqual(session.body, { user: null });
    assert.equal(session.headers["Cache-Control"], "no-store");
    for (const route of ["rpc", "transactions/prepare", "transactions/submit", "fees/refund", "auth/challenge", "anything"]) {
      const response = new ResponseCapture();
      await handler({ method: "POST", query: { route } }, response);
      assert.equal(response.statusCode, 503);
      assert.equal((response.body as { code: string }).code, "SERVICE_CONFIGURATION_REQUIRED");
    }
    const post = new ResponseCapture();
    await handler({ method: "POST", url: "/api/markets" }, post);
    assert.equal(post.statusCode, 405);
    assert.equal(post.headers.Allow, "GET");
  } finally {
    if (old === undefined) delete process.env.KEEPER_ENABLED;
    else process.env.KEEPER_ENABLED = old;
  }
});

test("market requests deduplicate, retain source timestamps and expire without stale cache serving", async () => {
  let clock = 60_000;
  let calls = 0;
  let finish!: (value: MarketSnapshot[]) => void;
  const handler = createPublicWorkspaceHandler({ now: () => clock, snapshot: () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  } });
  const first = new ResponseCapture(), second = new ResponseCapture();
  const a = handler({ method: "GET", query: { route: "markets" } }, first);
  const b = handler({ method: "GET", query: { route: "markets" } }, second);
  assert.equal(calls, 1);
  finish([snapshot()]);
  await Promise.all([a, b]);
  assert.equal(first.headers["Cache-Control"], "public, max-age=0, s-maxage=5, must-revalidate");
  const result = (first.body as { markets: MarketSnapshot[] }).markets[0];
  assert.equal(result.checkedAt, snapshot().checkedAt);
  assert.equal(result.executionEligible, false);
  clock += 2000;
  const cached = new ResponseCapture();
  await handler({ method: "GET", url: "/api/markets" }, cached);
  assert.equal(calls, 1);
  assert.match(cached.headers["Cache-Control"], /s-maxage=3/);
  clock += 3000;
  const refreshed = new ResponseCapture();
  const c = handler({ method: "GET", url: "/api/markets" }, refreshed);
  assert.equal(calls, 2);
  const duringRefresh = new ResponseCapture();
  const d = handler({ method: "GET", url: "/api/markets" }, duringRefresh);
  assert.equal(duringRefresh.body, undefined);
  assert.equal(calls, 2);
  finish([{ ...snapshot(), status: "stale" }]);
  await Promise.all([c, d]);
  assert.equal(refreshed.headers["Cache-Control"], "no-store");
  assert.equal((duringRefresh.body as { markets: MarketSnapshot[] }).markets[0].status, "stale");
});

test("source failures return unavailable JSON and bounded requests do not spend unlimited instance RPC", async () => {
  let calls = 0;
  const handler = createPublicWorkspaceHandler({ now: () => 60_000, snapshot: async () => { calls++; throw Error("private endpoint secret"); } });
  for (let i = 0; i < 120; i++) {
    const response = new ResponseCapture();
    await handler({ method: "GET", url: "/api/markets" }, response);
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["Cache-Control"], "no-store");
    assert.equal(JSON.stringify(response.body).includes("secret"), false);
  }
  const rate = new ResponseCapture();
  await handler({ method: "GET", url: "/api/markets" }, rate);
  assert.equal(rate.statusCode, 429);
  assert.equal(rate.headers["Retry-After"], "60");
  assert.equal(calls, 120);
});
