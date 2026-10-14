import { useEffect, useState } from "react";
import { MARKETS, BETA_LIMITS } from "../../../shared/registry.ts";
import { product, errorMessage } from "../../services/product";
import type {
  RuntimeConfig,
  MarketSnapshot,
  Strategy,
  StrategyPolicy,
  ExecutionPreview,
  OwnerAction,
  FeeCredit,
  NotificationPreferences,
  Portfolio,
} from "../../services/product";
import { Banner, Heading, ExplorerLink, ReadinessPanel } from "./Common";
import {
  amount,
  dateTime,
  parseAmount,
  rawDecimal,
  shortAddress,
} from "./format";
type OwnerActionHandler = (
  action: OwnerAction,
  amountRaw?: string,
  policy?: StrategyPolicy,
) => Promise<void>;
export function Strategies({
  config,
  markets,
  strategy,
  fees,
  preferences,
  portfolio,
  selectedMint,
  now,
  busy,
  refreshing,
  reload,
  ownerAction,
  openSettings,
}: {
  config: RuntimeConfig | null;
  markets: MarketSnapshot[];
  strategy: Strategy | null;
  fees: FeeCredit | null;
  preferences: NotificationPreferences | null;
  portfolio: Portfolio | null;
  selectedMint: string;
  now: number;
  busy: boolean;
  refreshing: boolean;
  reload: () => Promise<void>;
  ownerAction: OwnerActionHandler;
  openSettings: () => void;
}) {
  const [mint, setMint] = useState(
    selectedMint || strategy?.policy.assetMint || MARKETS[0].mint,
  );
  const [direction, setDirection] = useState("AB");
  const [cycle, setCycle] = useState("25");
  const [profit, setProfit] = useState("0.05");
  const [dailyFee, setDailyFee] = useState("0.0005");
  const [attemptFee, setAttemptFee] = useState("0.00005");
  const [preview, setPreview] = useState<ExecutionPreview | null>(null);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deposit, setDeposit] = useState("25");
  const [withdraw, setWithdraw] = useState("");
  const [recoverAmount, setRecoverAmount] = useState("");
  useEffect(() => {
    if (selectedMint) {
      setMint(selectedMint);
      setPreview(null);
    }
  }, [selectedMint]);
  useEffect(() => {
    if (strategy) {
      const chosenMint =
        strategy.chainSlot !== null
          ? strategy.policy.assetMint
          : selectedMint || strategy.policy.assetMint;
      setMint(chosenMint);
      setCycle(rawDecimal(strategy.policy.cycleAmountRaw, 6) || "25");
      setProfit(rawDecimal(strategy.policy.minProfitRaw, 6) || ".05");
      setDailyFee(
        rawDecimal(strategy.policy.dailyFeeLimitLamports, 9) || ".0005",
      );
      setAttemptFee(
        rawDecimal(strategy.policy.maxFeePerAttemptLamports, 9) || ".00005",
      );
      const definition = MARKETS.find((asset) => asset.mint === chosenMint);
      setDirection(
        chosenMint !== strategy.policy.assetMint ||
          strategy.policy.poolBuy === definition?.pools[0]
          ? "AB"
          : "BA",
      );
    }
  }, [strategy?.id]);
  const onChain = !!strategy && strategy.chainSlot !== null;
  const definition = MARKETS.find((asset) => asset.mint === mint)!;
  const market = markets.find((asset) => asset.mint === mint);
  const expiredPreview =
    !!preview && now >= new Date(preview.expiresAt).getTime();
  const marketFresh =
    !!market &&
    now - new Date(market.checkedAt).getTime() < 30_000 &&
    market.status === "available";
  function policy(): StrategyPolicy | undefined {
    const nextErrors: Record<string, string> = {};
    let cycleRaw = "",
      profitRaw = "",
      dailyRaw = "",
      attemptRaw = "";
    for (const [key, value, decimals, min, max] of [
      ["cycle", cycle, 6, "1", BETA_LIMITS.cycleUsdcRaw],
      [
        "profit",
        profit,
        6,
        BETA_LIMITS.minProfitUsdcRaw,
        "18446744073709551615",
      ],
      ["daily-fee", dailyFee, 9, "5000", BETA_LIMITS.dailyFeeLamports],
      ["attempt-fee", attemptFee, 9, "5000", BETA_LIMITS.attemptFeeLamports],
    ] as const) {
      try {
        const raw = parseAmount(value, decimals);
        if (BigInt(raw) < BigInt(min) || BigInt(raw) > BigInt(max))
          throw new Error(
            key === "cycle"
              ? "Choose an amount above zero and at most 25 USDC."
              : key === "profit"
                ? "Minimum profit must be at least 0.05 USDC."
                : `Use a fee limit above zero and at most ${amount(max, decimals)} SOL.`,
          );
        if (key === "cycle") cycleRaw = raw;
        else if (key === "profit") profitRaw = raw;
        else if (key === "daily-fee") dailyRaw = raw;
        else attemptRaw = raw;
      } catch (e) {
        nextErrors[key] = errorMessage(e);
      }
    }
    if (dailyRaw && attemptRaw && BigInt(attemptRaw) > BigInt(dailyRaw))
      nextErrors["attempt-fee"] =
        "Per-attempt fees cannot exceed the daily limit.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      document.getElementById(Object.keys(nextErrors)[0])?.focus();
      return;
    }
    return {
      assetMint: mint,
      poolBuy: definition.pools[direction === "AB" ? 0 : 1],
      poolSell: definition.pools[direction === "AB" ? 1 : 0],
      cycleAmountRaw: cycleRaw,
      minProfitRaw: profitRaw,
      dailyFeeLimitLamports: dailyRaw,
      maxFeePerAttemptLamports: attemptRaw,
      maxCyclesPerDay: BETA_LIMITS.maxCyclesPerDay,
      cooldownSeconds: BETA_LIMITS.cooldownSeconds,
      expiresAt: new Date(
        // Leave room for a confirmed bank's clock to trail the browser clock.
        (Math.floor(Date.now() / 1000) + BETA_LIMITS.permissionSeconds - 60) * 1000,
      ).toISOString(),
      slippageBps: 50,
    };
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const value = policy();
    if (!value) return;
    setWorking("save");
    setError("");
    setNotice("");
    try {
      await product.saveStrategy(value);
      setNotice(
        "Draft saved. Inspect the exact cycle before authorizing automation.",
      );
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWorking("");
    }
  }
  async function inspect() {
    const value = policy();
    if (!value) return;
    setWorking("preview");
    setError("");
    setNotice("");
    setPreview(null);
    try {
      if (!onChain) {
        await product.saveStrategy(value);
        await reload();
      }
      setPreview(await product.preview(value));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWorking("");
    }
  }
  async function act(action: OwnerAction, raw?: string) {
    setError("");
    setNotice("");
    const value =
      action === "initialize" || action === "configure"
        ? policy()
        : action === "recover"
          ? strategy?.policy
          : undefined;
    if ((action === "initialize" || action === "configure") && !value) return;
    setWorking(action);
    try {
      if (action === "initialize" && value) {
        await product.saveStrategy(value);
        await reload();
      }
      await ownerAction(action, raw, value);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWorking("");
    }
  }
  async function transfer(action: "deposit" | "withdraw") {
    try {
      const raw = parseAmount(action === "deposit" ? deposit : withdraw, 6);
      if (
        action === "deposit" &&
        BigInt(raw) > BigInt(BETA_LIMITS.depositUsdcRaw)
      )
        throw new Error("Maximum deposited capital is 100 USDC.");
      if (
        action === "withdraw" &&
        strategy &&
        BigInt(raw) > BigInt(strategy.balanceUsdcRaw)
      )
        throw new Error("Withdrawal exceeds the confirmed vault balance.");
      await act(action, raw);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function recover() {
    try {
      const asset = MARKETS.find(
        (value) => value.mint === strategy?.policy.assetMint,
      );
      if (!asset)
        throw new Error(
          "Load the confirmed strategy asset before recovering tokens.",
        );
      const raw = parseAmount(recoverAmount, asset.decimals);
      await act("recover", raw);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const unavailable = busy || working !== "";
  const capitalReady = (() => {
    try {
      return (
        !!strategy &&
        BigInt(strategy.balanceUsdcRaw) >= BigInt(parseAmount(cycle, 6))
      );
    } catch {
      return false;
    }
  })();
  const feeReady = (() => {
    try {
      return (
        !!fees &&
        BigInt(fees.availableLamports) >= BigInt(parseAmount(attemptFee, 9))
      );
    } catch {
      return false;
    }
  })();
  const canEnable =
    !!config?.automationEnabled &&
    !!strategy &&
    strategy.chainSlot !== null &&
    !!preferences?.verified &&
    !!fees &&
    feeReady &&
    marketFresh &&
    !!market?.quoteEligible &&
    capitalReady;
  return (
    <>
      <Heading
        eyebrow="02 / The strategy engine"
        title="Set the bounds. Keep control."
      >
        A vault belongs to your wallet. Your signature sets the two pools,
        capital limits and permission window. The keeper can execute the
        approved cycle; your wallet can pause or withdraw.
      </Heading>
      {error && (
        <Banner kind="error" title="Strategy action could not complete">
          {error}
        </Banner>
      )}
      {notice && (
        <Banner kind="success" title="Strategy draft saved">
          {notice}
        </Banner>
      )}
      <div className="two-columns">
        <section className="instrument-box">
          <header className="panel-header">
            <h2>Strategy policy</h2>
            <span className={`badge ${strategy?.status || "review"}`}>
              {strategy?.status.toUpperCase() || "NEW DRAFT"}
            </span>
          </header>
          <div className="panel-body">
            <form onSubmit={save}>
              <div className="form-grid">
                <div className="field full">
                  <label htmlFor="strategy-asset">Market</label>
                  <select
                    id="strategy-asset"
                    value={mint}
                    onChange={(e) => {
                      setMint(e.target.value);
                      setPreview(null);
                    }}
                    disabled={unavailable || onChain}
                  >
                    {MARKETS.map((asset) => (
                      <option value={asset.mint} key={asset.mint}>
                        {asset.symbol} — {asset.name}
                      </option>
                    ))}
                  </select>
                  {onChain && (
                    <small>
                      The market is fixed for this vault. Pool direction and
                      capital limits can be changed with a new owner
                      authorization.
                    </small>
                  )}
                </div>
                <div className="field full">
                  <label htmlFor="strategy-direction">Exact cycle</label>
                  <select
                    id="strategy-direction"
                    value={direction}
                    onChange={(e) => {
                      setDirection(e.target.value);
                      setPreview(null);
                    }}
                    disabled={unavailable}
                  >
                    <option value="AB">Buy at Pool A → sell at Pool B</option>
                    <option value="BA">Buy at Pool B → sell at Pool A</option>
                  </select>
                  <small>
                    USDC → {definition.symbol} → USDC · Raydium CLMM only
                  </small>
                </div>
                {[
                  {
                    id: "cycle",
                    label: "USDC per cycle",
                    value: cycle,
                    set: setCycle,
                    hint: "Maximum 25 USDC per cycle.",
                  },
                  {
                    id: "profit",
                    label: "Minimum USDC profit",
                    value: profit,
                    set: setProfit,
                    hint: "At least 0.05 USDC returned above starting capital.",
                  },
                  {
                    id: "daily-fee",
                    label: "Daily fee limit · SOL",
                    value: dailyFee,
                    set: setDailyFee,
                    hint: "Maximum 0.0005 SOL each UTC day.",
                  },
                  {
                    id: "attempt-fee",
                    label: "Fee per attempt · SOL",
                    value: attemptFee,
                    set: setAttemptFee,
                    hint: "Maximum 0.00005 SOL, including priority fees.",
                  },
                ].map((field) => (
                  <div className="field" key={field.id}>
                    <label htmlFor={field.id}>{field.label}</label>
                    <input
                      id={field.id}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      spellCheck={false}
                      value={field.value}
                      onChange={(e) => {
                        field.set(e.target.value);
                        setPreview(null);
                      }}
                      disabled={unavailable}
                      aria-invalid={errors[field.id] ? "true" : undefined}
                      aria-describedby={`${field.id}-hint${errors[field.id] ? ` ${field.id}-error` : ""}`}
                    />
                    <small id={`${field.id}-hint`}>{field.hint}</small>
                    {errors[field.id] && (
                      <p className="field-error" id={`${field.id}-error`}>
                        {errors[field.id]}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              <div className="field-note">
                <strong>Up to 24 hours per authorization.</strong> The default
                lasts 23 hours 59 minutes; review its exact expiry before
                signing. Renew with your wallet after it expires. At most ten
                confirmed cycles per day, with a
                60-second cooldown. Preview adds a 25% buffer to estimated
                network costs.
              </div>
              <p className="helper">
                Full execution previews require a funded, authorized vault.
                Capped monitoring can be authorized while current returns are
                negative; the keeper executes only after a cycle passes all
                profit, cost and simulation checks.
              </p>
              <div className="form-actions">
                <button
                  className="secondary-button"
                  type="submit"
                  disabled={unavailable || onChain}
                >
                  {working === "save" ? "Saving…" : "Save draft"}
                </button>
                <button
                  className="brass-button"
                  type="button"
                  onClick={inspect}
                  disabled={unavailable}
                >
                  {working === "preview"
                    ? "Simulating cycle…"
                    : "Inspect exact cycle →"}
                </button>
              </div>
            </form>
            <div className="form-divider" />
            <span className="eyebrow">Approved pools</span>
            <dl className="control-spec full">
              <dt>Buy pool</dt>
              <dd>
                <ExplorerLink
                  address={definition.pools[direction === "AB" ? 0 : 1]}
                  cluster={config?.cluster}
                >
                  {shortAddress(definition.pools[direction === "AB" ? 0 : 1])}
                </ExplorerLink>
              </dd>
              <dt>Sell pool</dt>
              <dd>
                <ExplorerLink
                  address={definition.pools[direction === "AB" ? 1 : 0]}
                  cluster={config?.cluster}
                >
                  {shortAddress(definition.pools[direction === "AB" ? 1 : 0])}
                </ExplorerLink>
              </dd>
            </dl>
            {market?.reason && (
              <p className="helper negative">{market.reason}</p>
            )}
            {preview && (
              <section aria-label="Execution preview">
                <div className="form-divider" />
                <div className="toolbar">
                  <strong>Cycle preview</strong>
                  <span
                    className={`badge ${expiredPreview ? "review" : preview.status === "ready" ? "ready" : "blocked"}`}
                  >
                    {expiredPreview
                      ? "EXPIRED"
                      : preview.status.replaceAll("-", " ").toUpperCase()}
                  </span>
                </div>
                <div className="readout-grid">
                  <div className="readout">
                    <span className="kicker">Starting USDC</span>
                    <strong>{amount(preview.startingUsdcRaw)}</strong>
                  </div>
                  <div className="readout">
                    <span className="kicker">Estimated returned USDC</span>
                    <strong>{amount(preview.estimatedReturnedUsdcRaw)}</strong>
                  </div>
                  <div className="readout">
                    <span className="kicker">Estimated USDC profit</span>
                    <strong
                      className={
                        preview.estimatedProfitUsdcRaw?.startsWith("-")
                          ? "negative"
                          : "positive"
                      }
                    >
                      {amount(preview.estimatedProfitUsdcRaw, 6, true)}
                    </strong>
                  </div>
                  <div className="readout">
                    <span className="kicker">Estimated network fee · SOL</span>
                    <strong>{amount(preview.estimatedFeeLamports, 9)}</strong>
                  </div>
                </div>
                <p className="helper">
                  {preview.simulation?.success
                    ? "Full transaction simulation passed."
                    : preview.simulation?.error ||
                      "Full transaction simulation has not passed."}{" "}
                  Checked {dateTime(preview.checkedAt)} · expires{" "}
                  {dateTime(preview.expiresAt)}.
                </p>
                {preview.reasons.length > 0 && (
                  <ul className="gate-list">
                    {preview.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
                {preview.estimatedTokenOutRaw !== null && (
                  <p className="helper">
                    Estimated token output:{" "}
                    <span className="number">
                      {amount(
                        preview.estimatedTokenOutRaw,
                        definition.decimals,
                      )}
                    </span>{" "}
                    {definition.symbol} unscaled token units · issuer display
                    multiplier{" "}
                    <span className="number">{preview.multiplier}×</span>. The
                    on-chain sell uses the quantity actually received.
                  </p>
                )}
              </section>
            )}
          </div>
        </section>
        <div className="strategy-summary">
          <section className="instrument-box">
            <header className="panel-header">
              <h2>Your vault</h2>
              <span className={`badge ${strategy?.status || "review"}`}>
                {onChain ? "ON CHAIN" : "NOT CREATED"}
              </span>
            </header>
            <div className="panel-body">
              <div className="readout-grid">
                <div className="readout paper">
                  <span className="kicker">Confirmed vault · USDC</span>
                  <strong>
                    {onChain ? amount(strategy!.balanceUsdcRaw) : "—"}
                  </strong>
                </div>
                <div className="readout">
                  <span className="kicker">Wallet · USDC</span>
                  <strong>
                    {portfolio ? amount(portfolio.usdcBalanceRaw) : "—"}
                  </strong>
                </div>
              </div>
              <p className="helper">
                Wallet balance checked{" "}
                {portfolio ? dateTime(portfolio.checkedAt) : "—"}.{" "}
                <button
                  type="button"
                  className="text-button"
                  disabled={refreshing || busy}
                  onClick={() => void reload()}
                >
                  {refreshing ? "Refreshing balances…" : "Refresh balances"}
                </button>
              </p>
              {onChain && (
                <p className="helper">
                  Vault balance checked{" "}
                  {strategy?.checkedAt ? dateTime(strategy.checkedAt) : "—"}.
                </p>
              )}
              {strategy?.vaultAddress && (
                <p className="helper">
                  <ExplorerLink
                    address={strategy.vaultAddress}
                    cluster={config?.cluster}
                  >
                    Vault {shortAddress(strategy.vaultAddress)}
                  </ExplorerLink>
                  {strategy.chainSlot
                    ? ` · confirmed slot ${strategy.chainSlot.toLocaleString("en-US")}`
                    : " · awaiting initialization"}
                </p>
              )}
              {strategy?.pauseReason && (
                <p className="helper negative">
                  Paused: {strategy.pauseReason}
                </p>
              )}
              <div className="form-actions">
                {!strategy || strategy.chainSlot === null ? (
                  <button
                    type="button"
                    className="brass-button"
                    disabled={unavailable || !config?.fundingEnabled}
                    onClick={() => act("initialize")}
                  >
                    Create vault
                  </button>
                ) : (
                  <button
                    type="button"
                    className="brass-button"
                    disabled={unavailable || !canEnable}
                    onClick={() => act("configure")}
                  >
                    {strategy.status === "active"
                      ? "Renew permission"
                      : "Authorize monitoring"}
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={unavailable || !onChain}
                  onClick={() => act("pause")}
                >
                  Pause
                </button>
                <button
                  type="button"
                  className="secondary-button danger-button"
                  disabled={unavailable || !onChain}
                  onClick={() => act("revoke")}
                >
                  Revoke keeper
                </button>
              </div>
              {!config?.fundingEnabled && (
                <p className="helper">
                  Vault creation and deposits open after deployment
                  verification.
                </p>
              )}
              {!canEnable && strategy?.chainSlot !== null && (
                <p className="helper">
                  Automation requires a funded vault, verified email, available
                  SOL fee credit and an eligible market. Every execution still
                  requires a fresh successful cycle simulation.{" "}
                  <button
                    type="button"
                    className="text-button"
                    onClick={openSettings}
                  >
                    Account settings →
                  </button>
                </p>
              )}
              <div className="form-divider" />
              <fieldset>
                <legend>Move USDC</legend>
                <div className="field">
                  <label htmlFor="deposit-amount">Deposit amount · USDC</label>
                  <input
                    id="deposit-amount"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={deposit}
                    onChange={(e) => setDeposit(e.target.value)}
                    disabled={unavailable}
                  />
                  <small>
                    100 USDC maximum deposited capital. Deposits require your
                    wallet signature.
                  </small>
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={
                      unavailable || !config?.fundingEnabled || !onChain
                    }
                    onClick={() => transfer("deposit")}
                  >
                    Review deposit
                  </button>
                </div>
                <div className="form-divider" />
                <div className="field">
                  <label htmlFor="withdraw-amount">
                    Withdraw amount · USDC
                  </label>
                  <input
                    id="withdraw-amount"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={withdraw}
                    onChange={(e) => setWithdraw(e.target.value)}
                    disabled={unavailable}
                    placeholder="0.00"
                  />
                  <small>
                    Your wallet can withdraw even when automation is paused or
                    the keeper is offline.
                  </small>
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={unavailable || !config?.programId}
                    onClick={() => transfer("withdraw")}
                  >
                    Review withdrawal
                  </button>
                </div>
                <div className="form-divider" />
                <div className="field">
                  <label htmlFor="recover-amount">
                    Recover residual asset · unscaled token units
                  </label>
                  <input
                    id="recover-amount"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={recoverAmount}
                    onChange={(event) => setRecoverAmount(event.target.value)}
                    disabled={unavailable}
                  />
                  <small>
                    Recover existing residual tokens from the confirmed vault
                    asset. Successful cycles leave no new intermediate
                    inventory.
                  </small>
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={unavailable || !config?.programId || !onChain}
                    onClick={() => void recover()}
                  >
                    Review token recovery
                  </button>
                </div>
              </fieldset>
              <p className="helper">
                SOL transaction fees for owner actions come from your connected
                wallet. The service fee wallet pays automated execution fees
                only.
              </p>
            </div>
          </section>
          <ReadinessPanel config={config} />
        </div>
      </div>
    </>
  );
}
