import { useState } from "react";
import MechanicalObservatory from "../MechanicalObservatory";
import { MARKETS, BETA_LIMITS } from "../../../shared/registry.ts";
import type { MarketSnapshot, RuntimeConfig } from "../../services/product";
import { Banner, Heading, Loading, ReadinessPanel } from "./Common";
import { age, amount,currency, percent, shortAddress } from "./format";
export function Markets({
  markets,
  config,
  loading,
  error,
  now,
  retry,
  choose,
}: {
  markets: MarketSnapshot[];
  config: RuntimeConfig | null;
  loading: boolean;
  error: string;
  now: number;
  retry: () => void;
  choose: (mint: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "xstock" | "crypto">("all");
  return (
    <>
      <Heading
        eyebrow="01 / The market observatory"
        title="A closer look at every cycle."
        actions={
          <button
            type="button"
            className="secondary-button"
            onClick={retry}
            disabled={loading}
          >
            {loading ? "Checking pools…" : "Refresh pools ↻"}
          </button>
        }
      >
        Investigate exact Raydium pools, inspect their fees and depth, then
        build an atomic strategy. Every cycle must return more USDC than it
        spends.
      </Heading>
      {error && (
        <Banner kind="error" title="Market checks unavailable" retry={retry}>
          {error} Last received observations are marked stale.
        </Banner>
      )}
      <div className="markets-layout">
        <div>
          <div className="toolbar">
            <div className="workspace-tabs" aria-label="Filter markets">
              {(["all", "xstock", "crypto"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-current={filter === value ? "page" : undefined}
                  onClick={() => setFilter(value)}
                >
                  {value === "all"
                    ? "All markets"
                    : value === "xstock"
                      ? "xStocks"
                      : "Solana tokens"}
                </button>
              ))}
            </div>
            <span>Exact pool pairs</span>
          </div>
          {loading && !markets.length ? (
            <Loading
              label="Inspecting pool accounts and mint controls…"
              count={3}
            />
          ) : (
            <div className="market-list">
              {MARKETS.filter(
                (asset) => filter === "all" || asset.category === filter,
              ).map((asset) => {
                const market = markets.find(
                  (value) => value.mint === asset.mint,
                );
                const stale =
                  !!market &&
                  (error !== "" ||
                    market.status === "stale" ||
                    now - new Date(market.checkedAt).getTime() > 30_000);
                const eligible = !!market?.executionEligible && !stale;
                const quotable = !!market?.quoteEligible&&!stale;
                return (
                  <article
                    className="market-card instrument-box"
                    key={asset.mint}
                    aria-label={`${asset.symbol} market`}
                  >
                    <div className="market-card-top">
                      <div className="market-identity">
                        <span className="asset-seal" aria-hidden="true">
                          {asset.symbol.slice(0, 1)}
                        </span>
                        <div>
                          <h2>{asset.symbol}</h2>
                          <small>
                            {asset.name} ·{" "}
                            {asset.category === "xstock"
                              ? "Token-2022"
                              : "SPL Token"}
                          </small>
                        </div>
                      </div>
                      <span
                        className={`badge ${eligible ? "ready" : market?.status === "blocked" ? "blocked" : "review"}`}
                      >
                        {stale
                          ? "STALE"
                          : eligible
                            ? "TICK DEPTH VERIFIED"
                            : market?.status === "blocked"
                              ? "BLOCKED"
                              : market
                                ? quotable?'SIMULATION REQUIRED':'INSPECTION REQUIRED'
                                : "AWAITING DATA"}
                      </span>
                    </div>
                    <div className="market-card-grid">
                      {[0, 1].map((index) => {
                        const pool = market?.pools[index];
                        return pool && pool.status === "available" ? (
                          <div className="pool-readout" key={index}>
                            <span className="kicker">
                              Pool {index === 0 ? "A" : "B"} · Raydium CLMM
                            </span>
                            <strong>{currency(pool.priceUsd)}</strong>
                            <span className="kicker">USD / {asset.category==='xstock'?'scaled token':'token'}</span>
                            <div className="pool-meta">
                              <span>Fee {percent(pool.feeBps / 100)}</span>
                              <span>
                                Liquidity {currency(pool.liquidityUsd, true)}
                              </span>
                              <span>
                                {pool.depthReady
                                  ? `Depth verified${pool.quotedDepthUsdcRaw?` at ${amount(pool.quotedDepthUsdcRaw)} USDC`:''}`
                                  : "Tick simulation required"}
                              </span>
                            </div>
                            <a
                              href={
                                pool.sourceUrl ||
                                `https://explorer.solana.com/address/${pool.poolId}`
                              }
                              target="_blank"
                              rel="noopener noreferrer"
                              title={pool.poolId}
                            >
                              Pool {shortAddress(pool.poolId)} ↗
                            </a>
                          </div>
                        ) : (
                          <div className="pool-empty" key={index}>
                            {pool?.reason ||
                              `Pool ${index === 0 ? "A" : "B"} account data unavailable`}
                          </div>
                        );
                      })}
                    </div>
                    <div className="market-facts">
                      <span>
                        OBSERVED GAP{" "}
                        <strong>{percent(market?.observedGapPct)}</strong>
                      </span>
                      <span>
                        {age(market?.checkedAt, now)}
                        {market?.slot
                          ? ` · slot ${market.slot.toLocaleString("en-US")}`
                          : ""}
                      </span>
                      {asset.category === "xstock" && (
                        <span>
                          DISPLAY MULTIPLIER{" "}
                          <strong>
                            {market && market.status !== "unavailable"
                              ? `${market.multiplier}×`
                              : "—"}
                          </strong>
                        </span>
                      )}
                    </div>
                    <div className="market-bottom">
                      <p>
                        {stale
                          ? "Refresh this market before preparing a strategy."
                          : market?.reason ||
                            market?.issuerWarnings[0] ||
                            "Observed prices guide investigation. Only a fresh full-transaction simulation can qualify an execution."}
                      </p>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => choose(asset.mint)}
                      >
                        Build strategy <span aria-hidden="true">→</span>
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
        <aside className="workstation-aside">
          <section className="instrument-box">
            <div className="aside-machine" aria-hidden="true">
              <MechanicalObservatory />
            </div>
            <div className="panel-body">
              <span className="eyebrow">The DoubleTake engine</span>
              <h2 className="aside-title">
                One transaction.
                <br />
                Two exact pools.
              </h2>
              <p className="aside-copy">
                Buy through one pool, sell the actual received tokens through
                the other. The program requires a profitable USDC result or
                reverts both swaps.
              </p>
              <dl className="control-spec">
                <dt>Deposit ceiling</dt>
                <dd>100 USDC</dd>
                <dt>Maximum cycle</dt>
                <dd>25 USDC</dd>
                <dt>Profit floor</dt>
                <dd>0.05 USDC</dd>
                <dt>Daily cycles</dt>
                <dd>{BETA_LIMITS.maxCyclesPerDay}</dd>
                <dt>Permission window</dt>
                <dd>24 hours</dd>
              </dl>
              <p className="helper">
                Network fees can still be charged for a failed transaction. SOL
                fee credit is tracked separately.
              </p>
            </div>
          </section>
          <ReadinessPanel config={config} />
        </aside>
      </div>
    </>
  );
}
