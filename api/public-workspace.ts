import { RaydiumMarkets, RpcBudget } from "../server/markets.ts";
import { BETA_LIMITS } from "../shared/registry.ts";
import type { ApiError, MarketSnapshot, RuntimeConfig } from "../shared/types.ts";

const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const CACHE_SECONDS = 5;
const CONFIGURATION_REASON =
  "The account and execution service awaits Railway, Postgres, verified program deployment and email configuration.";

export interface PublicWorkspaceRequest {
  method?: string;
  url?: string;
  query?: Record<string, unknown>;
}
export interface PublicWorkspaceResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): PublicWorkspaceResponse;
  json(body: unknown): unknown;
}
export interface PublicWorkspaceDependencies {
  snapshot(): Promise<MarketSnapshot[]>;
  now?: () => number;
}

// This deployment has no account database, transaction builder, signer or keeper.
// Funding gates are constants rather than environment flags.
export const publicWorkspaceConfig: RuntimeConfig = Object.freeze({
  cluster: "mainnet-beta",
  programId: null,
  rpcEndpoint: "/api/rpc",
  phase: "configuration-required",
  readiness: { ready: false, reasons: [CONFIGURATION_REASON] },
  fundingEnabled: false,
  automationEnabled: false,
  upgradeAuthority: null,
  limits: BETA_LIMITS,
});

function routeFrom(request: PublicWorkspaceRequest) {
  const rewritten = request.query?.route;
  if (typeof rewritten === "string") return rewritten.replace(/^\/+|\/+$/g, "");
  if (Array.isArray(rewritten) && rewritten.every((part) => typeof part === "string"))
    return rewritten.join("/").replace(/^\/+|\/+$/g, "");
  return new URL(request.url || "/", "https://doubletake.invalid")
    .pathname.replace(/^\/api\/?/, "")
    .replace(/\/+$/, "");
}

export function createPublicWorkspaceHandler({ snapshot, now = Date.now }: PublicWorkspaceDependencies) {
  let pending: Promise<MarketSnapshot[]> | null = null;
  let cached: MarketSnapshot[] | null = null;
  let cacheStartedAt = 0;
  let requestWindow = 0;
  let requestsInWindow = 0;

  return async function handler(request: PublicWorkspaceRequest, response: PublicWorkspaceResponse) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const route = routeFrom(request);
    if (!["config", "markets", "auth/session"].includes(route)) {
      const error: ApiError = {
        error: "The beta account and execution service has not been deployed yet.",
        code: "SERVICE_CONFIGURATION_REQUIRED",
        reasons: [CONFIGURATION_REASON],
      };
      return response.status(503).json(error);
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      return response.status(405).json({ error: "This endpoint accepts GET only.", code: "METHOD_NOT_ALLOWED" });
    }
    if (route === "config") return response.status(200).json(publicWorkspaceConfig);
    if (route === "auth/session") return response.status(200).json({ user: null });

    const started = now();
    if (started - requestWindow >= 60_000) {
      requestWindow = started;
      requestsInWindow = 0;
    }
    // A bounded per-instance rate protects the public RPC. It is not a durable,
    // deployment-wide credit budget; the persistent service owns that control.
    if (++requestsInWindow > 120) {
      response.setHeader("Retry-After", "60");
      return response.status(429).json({ error: "Live markets are refreshing frequently. Retry shortly.", code: "MARKET_RATE_LIMIT" });
    }
    try {
      if (pending || !cached || started - cacheStartedAt >= CACHE_SECONDS * 1000) {
        if (!pending) {
          cacheStartedAt = started;
          pending = snapshot().then((markets) => {
            // Snapshot discovery does not perform a tick-depth quote or simulate
            // an executable transaction in this public deployment.
            cached = markets.map((market) => ({ ...market, executionEligible: false }));
            return cached;
          }).finally(() => { pending = null; });
        }
        await pending;
      }
      const remaining = Math.max(0, CACHE_SECONDS - Math.ceil((now() - cacheStartedAt) / 1000));
      if (remaining && cached?.every((market) => !["stale", "unavailable"].includes(market.status)))
        response.setHeader("Cache-Control", `public, max-age=0, s-maxage=${remaining}, must-revalidate`);
      return response.status(200).json({ markets: cached });
    } catch {
      cached = null;
      return response.status(503).json({ error: "Live pool sources are unavailable. Try again shortly.", code: "MARKET_SOURCE_UNAVAILABLE" });
    }
  };
}

let markets: RaydiumMarkets | undefined;
const publicHandler = createPublicWorkspaceHandler({
  snapshot: () => {
    // Explicit memory-only budget avoids inherited Railway filesystem settings
    // and private provider credentials in a serverless public-market deployment.
    markets ??= new RaydiumMarkets(PUBLIC_RPC, undefined, new RpcBudget(900_000));
    return markets.snapshot();
  },
});
export default publicHandler;
