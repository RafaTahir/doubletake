import { useEffect, useState } from "react";
import { BETA_LIMITS } from "../../../shared/registry.ts";
import { product, errorMessage } from "../../services/product";
import type {
  FeeCredit,
  NotificationPreferences,
  RuntimeConfig,
  TransactionIntent,
  SessionUser,
  Portfolio,
  NotificationDelivery,
} from "../../services/product";
import { Banner, Heading, ExplorerLink } from "./Common";
import { amount, dateTime, parseAmount, shortAddress } from "./format";
export function Settings({
  user,
  config,
  fees,
  preferences,
  portfolio,
  busy,
  refreshing,
  reload,
  reviewFeeFunding,
  logout,
}: {
  user: SessionUser;
  config: RuntimeConfig | null;
  fees: FeeCredit | null;
  preferences: NotificationPreferences | null;
  portfolio: Portfolio | null;
  busy: boolean;
  refreshing: boolean;
  reload: () => Promise<void>;
  reviewFeeFunding: (
    intent: TransactionIntent,
    expectedRaw: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
}) {
  const [email, setEmail] = useState(preferences?.email || "");
  const [token, setToken] = useState("");
  const [funding, setFunding] = useState("0.001");
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [emailError, setEmailError] = useState("");
  const [fundingError, setFundingError] = useState("");
  const [choices, setChoices] = useState({
    executions: preferences?.executions ?? true,
    failures: preferences?.failures ?? true,
    pauses: preferences?.pauses ?? true,
    lowFeeBalance: preferences?.lowFeeBalance ?? true,
  });
  useEffect(() => {
    if (preferences) {
      setEmail(preferences.email || "");
      setChoices({
        executions: preferences.executions,
        failures: preferences.failures,
        pauses: preferences.pauses,
        lowFeeBalance: preferences.lowFeeBalance,
      });
    }
  }, [
    preferences?.email,
    preferences?.verified,
    preferences?.executions,
    preferences?.failures,
    preferences?.pauses,
    preferences?.lowFeeBalance,
  ]);
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);
  const [deliveryError, setDeliveryError] = useState("");
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  async function loadDeliveries() {
    setDeliveryBusy(true);
    try {
      setDeliveries((await product.deliveries()).deliveries);
      setDeliveryError("");
    } catch (e) {
      setDeliveryError(errorMessage(e));
    } finally {
      setDeliveryBusy(false);
    }
  }
  useEffect(() => {
    void loadDeliveries();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadDeliveries();
    }, 15_000);
    return () => clearInterval(timer);
  }, [user.wallet]);
  async function run(
    name: string,
    fn: () => Promise<unknown>,
    success: string,
  ) {
    setWorking(name);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(success);
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWorking("");
    }
  }
  async function verifyEmail(event: React.FormEvent) {
    event.preventDefault();
    setEmailError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setEmailError(
        "Enter an email address that can receive verification messages.",
      );
      document.getElementById("notification-email")?.focus();
      return;
    }
    await run(
      "verify",
      () => product.verifyEmail(email.trim()),
      "Verification requested. Open the link sent to your email; delivery status appears below when available.",
    );
  }
  async function confirmEmail(event: React.FormEvent) {
    event.preventDefault();
    if (!token.trim()) return;
    await run(
      "confirm",
      async () => {
        const result = await product.confirmEmail(token.trim());
        setToken("");
        return result;
      },
      "Email verification completed.",
    );
  }
  async function fund() {
    setFundingError("");
    let raw: string;
    try {
      raw = parseAmount(funding, 9);
      if (
        BigInt(raw) > BigInt(BETA_LIMITS.feeBalanceLamports) ||
        (fees &&
          BigInt(fees.balanceLamports) + BigInt(raw) >
            BigInt(BETA_LIMITS.feeBalanceLamports))
      )
        throw new Error("The prepaid SOL wallet can hold at most 0.005 SOL.");
    } catch (e) {
      setFundingError(errorMessage(e));
      document.getElementById("fee-funding")?.focus();
      return;
    }
    setWorking("fund");
    setError("");
    try {
      const intent = await product.feeFunding(raw);
      await reviewFeeFunding(intent, raw);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWorking("");
    }
  }
  const unavailable = busy || working !== "";
  return (
    <>
      <Heading
        eyebrow="04 / Account & controls"
        title="Keep the engine on your terms."
      >
        Set notifications and a separate execution-fee allowance. USDC stays in
        your owner-controlled vault; SOL fee credit is held by the service.
      </Heading>
      {error && (
        <Banner kind="error" title="Account action could not complete">
          {error}
        </Banner>
      )}
      {notice && (
        <Banner kind="success" title="Account updated">
          {notice}
        </Banner>
      )}
      <div className="settings-grid">
        <section className="instrument-box">
          <header className="panel-header">
            <h2>Notifications</h2>
            <span
              className={`badge ${preferences?.verified ? "ready" : "review"}`}
            >
              {preferences?.verified ? "EMAIL VERIFIED" : "VERIFY EMAIL"}
            </span>
          </header>
          <div className="panel-body">
            <form onSubmit={verifyEmail}>
              <div className="field">
                <label htmlFor="notification-email">Email address</label>
                <input
                  id="notification-email"
                  type="email"
                  autoComplete="email"
                  spellCheck={false}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={unavailable}
                  aria-invalid={emailError ? "true" : undefined}
                  aria-describedby={
                    emailError
                      ? "notification-email-error"
                      : "notification-email-hint"
                  }
                />
                <small id="notification-email-hint">
                  Verified email is required before enabling automation.
                </small>
                {emailError && (
                  <p className="field-error" id="notification-email-error">
                    {emailError}
                  </p>
                )}
              </div>
              <div className="form-actions">
                <button
                  type="submit"
                  className="secondary-button"
                  disabled={unavailable}
                >
                  {working === "verify"
                    ? "Sending verification…"
                    : preferences?.verified && preferences.email === email
                      ? "Send a new verification"
                      : "Send verification email"}
                </button>
              </div>
            </form>
            {!preferences?.verified && (
              <details className="receipt-details">
                <summary>Have a verification token?</summary>
                <form onSubmit={confirmEmail}>
                  <div className="field">
                    <label htmlFor="verification-token">
                      Email verification token
                    </label>
                    <input
                      id="verification-token"
                      type="text"
                      autoComplete="one-time-code"
                      spellCheck={false}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      disabled={unavailable}
                    />
                  </div>
                  <div className="form-actions">
                    <button
                      type="submit"
                      className="secondary-button"
                      disabled={unavailable || !token.trim()}
                    >
                      {working === "confirm" ? "Verifying…" : "Verify token"}
                    </button>
                  </div>
                </form>
              </details>
            )}
            <div className="form-divider" />
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  "save",
                  () => product.saveNotifications(choices),
                  "Notification preferences saved.",
                );
              }}
            >
              <fieldset>
                <legend>Email me about</legend>
                <div className="notification-list">
                  {[
                    {
                      key: "executions",
                      title: "Confirmed executions",
                      description: "USDC result and transaction signature.",
                    },
                    {
                      key: "failures",
                      title: "Failed attempts",
                      description:
                        "Failure reason and any confirmed network fee.",
                    },
                    {
                      key: "lowFeeBalance",
                      title: "Low SOL fee balance",
                      description:
                        "An alert before the engine runs out of fee credit.",
                    },
                    {
                      key: "pauses",
                      title: "Strategy pauses",
                      description:
                        "Expired permissions, safeguards and paused automation.",
                    },
                  ].map((option) => (
                    <label className="check-field" key={option.key}>
                      <input
                        type="checkbox"
                        checked={choices[option.key as keyof typeof choices]}
                        onChange={(e) =>
                          setChoices((value) => ({
                            ...value,
                            [option.key]: e.target.checked,
                          }))
                        }
                        disabled={unavailable}
                      />
                      <span>
                        <b>{option.title}</b>
                        {option.description}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <button
                type="submit"
                className="brass-button"
                disabled={unavailable}
              >
                {working === "save"
                  ? "Saving preferences…"
                  : "Save preferences"}
              </button>
            </form>
            <p className="helper">
              Delivery failures are recorded separately from transaction
              results. Your transaction ledger remains available in Activity.
            </p>
            <div className="form-divider" />
            <div className="toolbar">
              <strong>Delivery history</strong>
              <button
                type="button"
                className="text-button"
                disabled={deliveryBusy}
                onClick={() => void loadDeliveries()}
              >
                {deliveryBusy ? "Checking…" : "Refresh ↻"}
              </button>
            </div>
            {deliveryError && (
              <Banner
                kind="error"
                title="Delivery status unavailable"
                retry={() => void loadDeliveries()}
              >
                {deliveryError}
              </Banner>
            )}
            {deliveries.length ? (
              <ul className="gate-list">
                {deliveries.map((delivery) => (
                  <li key={delivery.id}>
                    <div>
                      <b>
                        {delivery.event.replaceAll("_", " ")} ·{" "}
                        {delivery.status}
                      </b>
                      <small>
                        {dateTime(delivery.sentAt || delivery.createdAt)}
                        {delivery.error ? " · " + delivery.error : ""}
                      </small>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="helper">
                {deliveryBusy
                  ? "Loading delivery status…"
                  : "No notification deliveries yet."}
              </p>
            )}
          </div>
        </section>
        <div className="strategy-summary">
          <section className="instrument-box">
            <header className="panel-header">
              <h2>Execution fee credit</h2>
              <span className="badge review">SERVICE CONTROLLED</span>
            </header>
            <div className="panel-body">
              <div className="readout-grid">
                <div className="readout paper">
                  <span className="kicker">Available · SOL</span>
                  <strong>{amount(fees?.availableLamports, 9)}</strong>
                </div>
                <div className="readout">
                  <span className="kicker">Spent today · SOL</span>
                  <strong>{amount(fees?.spentTodayLamports, 9)}</strong>
                </div>
              </div>
              <dl className="control-spec full">
                <dt>Pending fee reservation</dt>
                <dd>{amount(fees?.reservedLamports, 9)} SOL</dd>
                <dt>Maximum prepaid balance</dt>
                <dd>0.005 SOL</dd>
                <dt>Daily fee ceiling</dt>
                <dd>0.0005 SOL</dd>
                <dt>Connected wallet balance</dt>
                <dd>{amount(portfolio?.solBalanceLamports, 9)} SOL</dd>
              </dl>
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
              {fees?.walletAddress && (
                <p className="helper">
                  Fee balance checked{" "}
                  {fees.checkedAt ? dateTime(fees.checkedAt) : "—"}.
                </p>
              )}
              {fees?.walletAddress && (
                <p className="helper">
                  <ExplorerLink
                    address={fees.walletAddress}
                    cluster={config?.cluster}
                  >
                    Fee wallet {shortAddress(fees.walletAddress)}
                  </ExplorerLink>
                </p>
              )}
              <p className="field-note">
                <strong>A separate SOL allowance.</strong> This wallet is
                controlled by DoubleTake and pays execution fees, including
                confirmed failed attempts. Unused-credit refunds depend on the
                service. Deposits always require your approval; there is no
                automatic top-up.
              </p>
              <div className="form-divider" />
              <div className="field">
                <label htmlFor="fee-funding">Add fee credit · SOL</label>
                <input
                  id="fee-funding"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={funding}
                  onChange={(e) => setFunding(e.target.value)}
                  disabled={unavailable}
                  aria-invalid={fundingError ? "true" : undefined}
                  aria-describedby={
                    fundingError ? "fee-funding-error" : "fee-funding-hint"
                  }
                />
                <small id="fee-funding-hint">
                  Review the recipient and exact amount before signing.
                </small>
                {fundingError && (
                  <p id="fee-funding-error" className="field-error">
                    {fundingError}
                  </p>
                )}
              </div>
              <div className="form-actions">
                <button
                  type="button"
                  className="brass-button"
                  onClick={fund}
                  disabled={unavailable || !config?.fundingEnabled}
                >
                  {working === "fund"
                    ? "Preparing transfer…"
                    : "Review fee funding"}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    unavailable ||
                    !fees ||
                    BigInt(fees.availableLamports) === 0n ||
                    fees.pendingRefund
                  }
                  onClick={() =>
                    run(
                      "refund",
                      () => product.refund(),
                      "Refund requested. Track its confirmed transfer in Activity.",
                    )
                  }
                >
                  {working === "refund"
                    ? "Requesting refund…"
                    : fees?.pendingRefund
                      ? "Refund pending"
                      : "Refund unused credit"}
                </button>
              </div>
            </div>
          </section>
          <section className="instrument-box">
            <header className="panel-header">
              <h2>Wallet session</h2>
            </header>
            <div className="panel-body">
              <span className="kicker">Signed-in owner</span>
              <p className="transaction-review-address">{user.wallet}</p>
              <dl className="control-spec full">
                <dt>Access</dt>
                <dd>{user.invited ? "Invited beta" : "Markets only"}</dd>
                <dt>Network</dt>
                <dd>{config?.cluster || "Awaiting configuration"}</dd>
              </dl>
              {config?.programId && (
                <p className="helper">
                  <ExplorerLink
                    address={config.programId}
                    cluster={config.cluster}
                  >
                    Strategy program {shortAddress(config.programId)}
                  </ExplorerLink>
                </p>
              )}
              {config?.upgradeAuthority && (
                <p className="helper">
                  <ExplorerLink
                    address={config.upgradeAuthority}
                    cluster={config.cluster}
                  >
                    Upgrade authority {shortAddress(config.upgradeAuthority)}
                  </ExplorerLink>
                </p>
              )}
              <p className="helper">
                Signing out or disconnecting does not pause active monitoring.
                Use Pause or Revoke keeper to end its permission.
              </p>
              <button
                className="secondary-button"
                type="button"
                onClick={() => logout()}
                disabled={unavailable}
              >
                Sign out
              </button>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
