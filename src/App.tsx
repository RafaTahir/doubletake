import React, { useCallback, useEffect, useRef, useState } from "react";
import "./style.css";
import "./fonts.css";
import { WalletShell, WalletConnect, useWallet } from "./wallet/Wallet";
import {
  product,
  errorMessage,
  toBase64,
  fromBase64,
  ProductError,
} from "./services/product";
import type {
  RuntimeConfig,
  MarketSnapshot,
  SessionUser,
  Strategy,
  StrategyPolicy,
  OwnerAction,
  TransactionIntent,
  ExecutionReceipt,
  FeeCredit,
  NotificationPreferences,
  Portfolio,
} from "./services/product";
import {
  validateOwnerTransaction,
  prepareIndependentOwnerAction,
  DEVELOPMENT_PROGRAM_ID,
} from "../shared/program.ts";
import { Markets } from "./components/product/Markets";
import { Strategies } from "./components/product/Strategies";
import { Activity } from "./components/product/Activity";
import { Settings } from "./components/product/Settings";
import { TransactionReview } from "./components/product/TransactionReview";
import { Recovery, publicRpc } from "./components/product/Recovery";
import { Connection } from "@solana/web3.js";
import {
  decodeOwnerTransaction,
  validateFeeFunding,
  verifyWalletReturnedMessage,
  signedTransactionSignature,
} from "./components/product/transactions";
import {
  Banner,
  Heading,
  Loading,
  ExplorerLink,
} from "./components/product/Common";
import {
  pendingOwnerActions,
  queueOwnerAction,
  removePendingSignatures,
  markPendingImported,
} from "./components/product/pending";
import { shortAddress } from "./components/product/format";
import { BETA_LIMITS } from "../shared/registry.ts";
import { validateSignInChallenge } from "./components/product/auth";

type View = "markets" | "strategies" | "activity" | "settings";
const views: View[] = ["markets", "strategies", "activity", "settings"];
function viewFromLocation(): View {
  const hash = window.location.hash.replace(/^#\/?/, "").toLowerCase();
  return views.includes(hash as View) ? (hash as View) : "markets";
}
interface PreparedReview {
  intent: TransactionIntent;
  action?: OwnerAction;
  amountRaw?: string;
  policy?: StrategyPolicy;
  independent?: boolean;
  rpcEndpoint?: string;
}
function recoveryBuildConfig(): RuntimeConfig | null {
  const selected = import.meta.env.VITE_SOLANA_CLUSTER || "mainnet-beta";
  const cluster = ["mainnet-beta", "devnet", "localnet"].includes(selected)
    ? (selected as RuntimeConfig["cluster"])
    : "mainnet-beta";
  const local =
    cluster === "localnet" &&
    import.meta.env.VITE_ALLOW_LOCALNET_PROGRAM === "true" &&
    ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const programId =
    import.meta.env.VITE_PROGRAM_ID || (local ? DEVELOPMENT_PROGRAM_ID : null);
  return programId
    ? {
        cluster,
        programId,
        rpcEndpoint: "/api/rpc",
        phase: "verification-required",
        fundingEnabled: false,
        automationEnabled: false,
        upgradeAuthority: null,
        limits: BETA_LIMITS,
        readiness: {
          ready: false,
          reasons: [
            "Service connection is pending. The build-pinned program remains available for independent owner recovery.",
          ],
        },
      }
    : null;
}
function pinProgram(config: RuntimeConfig): RuntimeConfig {
  const localTest =
    import.meta.env.VITE_ALLOW_LOCALNET_PROGRAM === "true" &&
    config.cluster === "localnet" &&
    ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const pinned =
    import.meta.env.VITE_PROGRAM_ID ||
    (localTest ? DEVELOPMENT_PROGRAM_ID : null);
  if (config.programId && pinned === config.programId) return config;
  const reason = pinned
    ? "The configured strategy program does not match this verified application build."
    : "A verified strategy program is not configured in this application build.";
  return {
    ...config,
    programId: null,
    fundingEnabled: false,
    automationEnabled: false,
    readiness: { ready: false, reasons: [reason, ...config.readiness.reasons] },
  };
}

class WorkspaceBoundary extends React.Component<
  { children: React.ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="app-shell initial-load">
        <Banner
          kind="error"
          title="The workspace could not display this data"
          retry={() => window.location.reload()}
        >
          Refresh the page to reconnect. No wallet action is triggered by a
          refresh.
        </Banner>
      </div>
    ) : (
      this.props.children
    );
  }
}

export function App() {
  const wallet = useWallet();
  const [view, setView] = useState<View>(viewFromLocation);
  const [config, setConfig] = useState<RuntimeConfig | null>(
    recoveryBuildConfig,
  );
  const [configError, setConfigError] = useState("");
  const [sessionReady, setSessionReady] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [markets, setMarkets] = useState<MarketSnapshot[]>([]);
  const [marketBusy, setMarketBusy] = useState(false);
  const [marketError, setMarketError] = useState("");
  const [now, setNow] = useState(Date.now());
  const marketRunning = useRef(false);
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [receipts, setReceipts] = useState<ExecutionReceipt[]>([]);
  const [intents, setIntents] = useState<TransactionIntent[]>([]);
  const [fees, setFees] = useState<FeeCredit | null>(null);
  const [preferences, setPreferences] =
    useState<NotificationPreferences | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [selectedMint, setSelectedMint] = useState("");
  const [notice, setNotice] = useState("");
  const [lastOwnerSignature, setLastOwnerSignature] = useState<string | null>(
    null,
  );
  const importingOwnerActions = useRef(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [preparing, setPreparing] = useState(false);
  const [review, setReview] = useState<PreparedReview | null>(null);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState("");
  const accountRunning = useRef<string | null>(null);
  const activeOwner = useRef<string | null>(null);
  activeOwner.current = user?.wallet || null;
  const [activityBusy, setActivityBusy] = useState(false);
  const [activityError, setActivityError] = useState("");
  const activityRunning = useRef<string | null>(null);
  const seenReceipts = useRef<Set<string>>(new Set());
  const emailTokenProcessed = useRef(false);
  const navigate = useCallback((next: View) => {
    setView(next);
    window.history.replaceState(null, "", `#/${next}`);
    document.getElementById("workspace")?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    setNotice("");
  }, []);
  useEffect(() => {
    const change = () => {
      const hash = window.location.hash.replace(/^#\/?/, "").toLowerCase();
      if (views.includes(hash as View)) setView(hash as View);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const connection = () => setOnline(navigator.onLine);
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    return () => {
      clearInterval(tick);
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
    };
  }, []);
  const loadConfig = useCallback(async () => {
    try {
      setConfig(pinProgram(await product.config()));
      setConfigError("");
    } catch (error) {
      setConfigError(errorMessage(error));
    }
  }, []);
  const loadMarkets = useCallback(async () => {
    if (marketRunning.current) return;
    marketRunning.current = true;
    setMarketBusy(true);
    try {
      setMarkets((await product.markets()).markets);
      setMarketError("");
    } catch (error) {
      setMarketError(errorMessage(error));
    } finally {
      setMarketBusy(false);
      marketRunning.current = false;
    }
  }, []);
  useEffect(() => {
    void loadConfig();
    void loadMarkets();
    product
      .session()
      .then((value) => {
        setUser(value);
        setSessionError("");
      })
      .catch((error) => setSessionError(errorMessage(error)))
      .finally(() => setSessionReady(true));
  }, [loadConfig, loadMarkets]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine)
        void loadMarkets();
    }, 5000);
    return () => clearInterval(timer);
  }, [loadMarkets]);
  const loadAccount = useCallback(async () => {
    if (!user || accountRunning.current === user.wallet) return;
    const requestedOwner = user.wallet;
    accountRunning.current = requestedOwner;
    setAccountBusy(true);
    const results = await Promise.allSettled([
      product.strategy(),
      product.activity(),
      product.fees(),
      product.notifications(),
      product.portfolio(),
    ]);
    if (activeOwner.current !== requestedOwner) {
      if (accountRunning.current === requestedOwner) {
        accountRunning.current = null;
        setAccountBusy(false);
      }
      return;
    }
    const failures: string[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        if (index === 0)
          setStrategy((result.value as { strategy: Strategy | null }).strategy);
        else if (index === 1) {
          const activity = result.value as {
            receipts: ExecutionReceipt[];
            intents: TransactionIntent[];
          };
          setReceipts(activity.receipts);
          setIntents(activity.intents);
          seenReceipts.current = new Set(
            activity.receipts.map(
              (receipt) => `${receipt.id}:${receipt.status}`,
            ),
          );
          removePendingSignatures(
            new Set([
              ...activity.receipts.map((receipt) => receipt.signature),
              ...activity.intents
                .filter(
                  (intent) =>
                    ["confirmed", "finalized", "failed", "expired"].includes(
                      intent.status,
                    ) && intent.signature,
                )
                .map((intent) => intent.signature!),
            ]),
          );
        } else if (index === 2) setFees(result.value as FeeCredit);
        else if (index === 3)
          setPreferences(result.value as NotificationPreferences);
        else setPortfolio(result.value as Portfolio);
      } else {
        failures.push(errorMessage(result.reason));
        if (
          result.reason instanceof ProductError &&
          result.reason.status === 401
        )
          setUser(null);
      }
    }
    setAccountError([...new Set(failures)].join(" "));
    setAccountBusy(false);
    accountRunning.current = null;
  }, [user?.wallet]);
  const importPendingOwnerActions = useCallback(async () => {
    if (!user || importingOwnerActions.current) return;
    importingOwnerActions.current = true;
    try {
      for (const action of pendingOwnerActions(user.wallet)
        .filter((item) => item.cluster === config?.cluster && !item.importedId)
        .slice(0, 5)) {
        try {
          const imported = await product.importOwnerAction(
            action.signature,
            action.action,
            action.amountRaw,
          );
          if (
            ["confirmed", "finalized", "failed", "expired"].includes(
              imported.intent.status,
            )
          )
            removePendingSignatures(new Set([action.signature]));
          else markPendingImported(action.signature, imported.intent.id);
        } catch {
          /* Preserve a public signature until the account service can verify it. */
        }
      }
    } finally {
      importingOwnerActions.current = false;
    }
  }, [user?.wallet, config?.cluster]);
  const loadActivity = useCallback(async () => {
    if (!user || activityRunning.current === user.wallet) return;
    const owner = user.wallet;
    activityRunning.current = owner;
    setActivityBusy(true);
    try {
      const [activity, prefs] = await Promise.all([
        product.activity(),
        product.notifications(),
      ]);
      if (activeOwner.current !== owner) return;
      const fresh = activity.receipts.some(
        (receipt) =>
          !seenReceipts.current.has(`${receipt.id}:${receipt.status}`),
      );
      seenReceipts.current = new Set(
        activity.receipts.map((receipt) => `${receipt.id}:${receipt.status}`),
      );
      setReceipts(activity.receipts);
      setIntents(activity.intents);
      setPreferences(prefs);
      setActivityError("");
      removePendingSignatures(
        new Set([
          ...activity.receipts.map((receipt) => receipt.signature),
          ...activity.intents
            .filter(
              (intent) =>
                ["confirmed", "finalized", "failed", "expired"].includes(
                  intent.status,
                ) && intent.signature,
            )
            .map((intent) => intent.signature!),
        ]),
      );
      if (fresh) void loadAccount();
    } catch (error) {
      if (activeOwner.current === owner) {
        setActivityError(errorMessage(error));
        if (error instanceof ProductError && error.status === 401)
          setUser(null);
      }
    } finally {
      if (activityRunning.current === owner) {
        activityRunning.current = null;
        setActivityBusy(false);
      }
    }
  }, [user?.wallet, loadAccount]);
  useEffect(() => {
    if (!user) return;
    void importPendingOwnerActions();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine)
        void importPendingOwnerActions();
    }, 15_000);
    return () => clearInterval(timer);
  }, [user?.wallet, importPendingOwnerActions]);
  useEffect(() => {
    if (user) void loadAccount();
    else {
      setStrategy(null);
      setFees(null);
      setPreferences(null);
      setPortfolio(null);
      setReceipts([]);
      setIntents([]);
      setAccountError("");
    }
  }, [user?.wallet, loadAccount]);
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine)
        void loadAccount();
    }, 300_000);
    return () => clearInterval(timer);
  }, [user?.wallet, loadAccount]);
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine)
        void loadActivity();
    }, 15_000);
    const visible = () => {
      if (document.visibilityState === "visible") void loadActivity();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [user?.wallet, loadActivity]);
  useEffect(() => {
    const token = new URL(window.location.href).searchParams.get("verify");
    if (!token || !user || emailTokenProcessed.current) return;
    emailTokenProcessed.current = true;
    setView("settings");
    product
      .confirmEmail(token)
      .then(() => {
        setNotice("Email verified. Notification preferences are ready.");
        void loadAccount();
      })
      .catch((error) => setAccountError(errorMessage(error)))
      .finally(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete("verify");
        url.hash = "/settings";
        window.history.replaceState(null, "", url);
      });
  }, [user?.wallet, loadAccount]);
  async function signIn() {
    if (!wallet.publicKey || !wallet.signMessage) return;
    setAuthBusy(true);
    setSessionError("");
    try {
      const owner = wallet.publicKey.toBase58();
      const challenge = await product.challenge(owner);
      validateSignInChallenge(
        challenge.message,
        owner,
        window.location.origin,
        config?.cluster || challenge.cluster || "mainnet-beta",
        challenge.expiresAt,
      );
      const id = challenge.challengeId || challenge.id;
      if (!id) throw new Error("The sign-in challenge is incomplete.");
      const signature = await wallet.signMessage(
        new TextEncoder().encode(challenge.message),
      );
      setUser(await product.verify(owner, id, toBase64(signature)));
      await loadConfig();
      setNotice("Wallet signed in. Loading your strategy and balances.");
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setAuthBusy(false);
    }
  }
  async function logout() {
    try {
      await product.logout();
      setUser(null);
      await loadConfig();
      setView("markets");
      setNotice("Signed out. Public markets remain available.");
    } catch (error) {
      setAccountError(errorMessage(error));
    }
  }
  async function ownerAction(
    action: OwnerAction,
    amountRaw?: string,
    policy?: StrategyPolicy,
  ) {
    if (
      !user ||
      !wallet.publicKey ||
      wallet.publicKey.toBase58() !== user.wallet
    )
      throw new Error(
        "Connect the signed-in owner wallet before preparing this action.",
      );
    setPreparing(true);
    setSignError("");
    try {
      let intent: TransactionIntent;
      let independent = false;
      try {
        intent = await product.prepare(action, amountRaw, policy);
      } catch (error) {
        if (
          !config?.programId ||
          !["pause", "revoke", "withdraw"].includes(action)
        )
          throw error;
        const prepared = await prepareIndependentOwnerAction({
          rpcEndpoint: publicRpc(config),
          programId: config.programId,
          owner: user.wallet,
          action: action as "pause" | "revoke" | "withdraw",
          amountRaw,
          cluster: config.cluster,
        });
        intent = prepared;
        independent = true;
      }
      setReview({
        intent,
        action,
        amountRaw,
        policy,
        independent,
        rpcEndpoint: independent && config ? publicRpc(config) : undefined,
      });
    } finally {
      setPreparing(false);
    }
  }
  async function reviewFeeFunding(
    intent: TransactionIntent,
    expectedRaw: string,
  ) {
    if (!user || intent.owner !== user.wallet)
      throw new Error(
        "Fee-funding intent does not match the signed-in wallet.",
      );
    setFees(await product.fees());
    setSignError("");
    setReview({ intent, amountRaw: expectedRaw });
  }
  async function signPrepared() {
    if (
      !review ||
      !wallet.publicKey ||
      wallet.publicKey.toBase58() !== review.intent.owner ||
      !wallet.signTransaction
    ) {
      setSignError(
        "Connect the owner wallet and use a wallet that supports transaction signing.",
      );
      return;
    }
    setSigning(true);
    setSignError("");
    try {
      const intent = review.intent;
      const owner = wallet.publicKey.toBase58();
      if (intent.owner !== owner || intent.summary.cluster !== config?.cluster)
        throw new Error(
          "The prepared transaction has an unexpected owner or network.",
        );
      const bytes = fromBase64(intent.unsignedTransactionBase64);
      if (intent.kind === "fee-funding")
        validateFeeFunding(intent, owner, fees, review.amountRaw);
      else {
        if (!config?.programId || !review.action)
          throw new Error("Strategy program configuration is unavailable.");
        validateOwnerTransaction(bytes, {
          action: review.action,
          owner,
          programId: config.programId,
          amountRaw: review.amountRaw,
          policy: review.policy,
          keeper:
            review.action === "configure"
              ? fees?.walletAddress
              : strategy?.keeperAddress,
          enabled: review.action === "configure",
        });
      }
      const transaction = decodeOwnerTransaction(intent);
      const originalMessage = decodeOwnerTransaction(intent);
      const signed = await wallet.signTransaction(transaction);
      verifyWalletReturnedMessage(originalMessage, signed);
      const serialized = signed.serialize();
      if (review.independent) {
        const connection = new Connection(
          review.rpcEndpoint || publicRpc(config!),
          "confirmed",
        );
        const signature = signedTransactionSignature(signed);
        if (
          !review.action ||
          !["pause", "revoke", "withdraw", "recover"].includes(review.action)
        )
          throw new Error("This independent owner action is not supported.");
        queueOwnerAction({
          owner,
          signature,
          action: review.action as "pause" | "revoke" | "withdraw" | "recover",
          amountRaw: review.amountRaw,
          cluster: config!.cluster,
          createdAt: new Date().toISOString(),
        });
        setLastOwnerSignature(signature);
        try {
          const accepted = await connection.sendRawTransaction(serialized, {
            skipPreflight: false,
            maxRetries: 0,
          });
          if (accepted !== signature)
            throw new Error("RPC returned an unexpected signature.");
          setNotice(
            `Owner transaction ${signature} submitted. It remains pending until Solana confirms it.`,
          );
        } catch {
          setNotice(
            `Owner transaction ${signature} has an unresolved outcome. Check its signature before submitting another withdrawal.`,
          );
        }
        void importPendingOwnerActions();
      } else {
        await product.submit(intent.id, toBase64(serialized));
        setNotice(
          "Transaction submitted. Its result remains pending until confirmed on Solana.",
        );
      }
      setReview(null);
      setView("activity");
      await loadAccount();
    } catch (error) {
      setSignError(errorMessage(error));
    } finally {
      setSigning(false);
    }
  }
  const ownerConnected = wallet.publicKey?.toBase58() === user?.wallet;
  const accountNeeded = view !== "markets";
  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>
      <header className="masthead">
        <a
          className="wordmark"
          href="#/markets"
          onClick={() => navigate("markets")}
          aria-label="DoubleTake markets"
        >
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
          </span>
          DoubleTake
          <span className="brand-edition">THE ATOMIC STRATEGY ENGINE</span>
        </a>
        <div className="masthead-right">
          <span className="network-tag">
            <i className={config?.readiness.ready ? "" : "disabled"} />
            {config?.cluster.toUpperCase() || "CONNECTING"}
          </span>
          {user ? (
            <button
              type="button"
              className="secondary-button account-button"
              onClick={() => navigate("settings")}
            >
              {shortAddress(user.wallet)}
            </button>
          ) : (
            <WalletConnect />
          )}
        </div>
      </header>
      <div className="workspace-navigation">
        <nav className="workspace-tabs" aria-label="Main workspace">
          {views.map((next) => (
            <button
              key={next}
              type="button"
              aria-current={view === next ? "page" : undefined}
              onClick={() => navigate(next)}
            >
              {next.charAt(0).toUpperCase() + next.slice(1)}
            </button>
          ))}
        </nav>
        <span className="edition-note">CAPPED STRATEGIES / OWNER CONTROL</span>
      </div>
      <main
        id="workspace"
        className="workspace-content"
        tabIndex={-1}
        key={view}
      >
        {!online && (
          <Banner kind="error" title="You are offline">
            Reconnect to refresh markets or submit a wallet action.
          </Banner>
        )}
        {configError && (
          <Banner
            kind="error"
            title="Service configuration unavailable"
            retry={() => void loadConfig()}
          >
            {configError}
          </Banner>
        )}
        {notice && (
          <Banner kind="success" title="Workspace updated">
            {notice}
            {lastOwnerSignature && notice.includes(lastOwnerSignature) && (
              <>
                <br />
                <ExplorerLink
                  signature
                  address={lastOwnerSignature}
                  cluster={config?.cluster}
                >
                  Inspect owner transaction
                </ExplorerLink>
              </>
            )}
          </Banner>
        )}
        {view === "markets" && (
          <Markets
            markets={markets}
            config={config}
            loading={marketBusy}
            error={marketError}
            now={now}
            retry={() => void loadMarkets()}
            choose={(mint) => {
              setSelectedMint(mint);
              navigate("strategies");
            }}
          />
        )}
        {accountNeeded && !sessionReady ? (
          <Loading label="Checking your wallet session…" />
        ) : accountNeeded && !user ? (
          <>
            <Heading eyebrow="Owner access" title="Your wallet. Your strategy.">
              Invited beta wallets can configure a strategy, fund a vault and
              inspect every transaction. Public market inspection is available
              to everyone.
            </Heading>
            <section className="signin-panel instrument-box">
              <div className="panel-body">
                <h2>Connect, then sign in.</h2>
                <p>
                  Connect Phantom or Solflare, then sign a single-use message to
                  verify your wallet. A sign-in message does not authorize a
                  transfer.
                </p>
                <WalletConnect showAddress />
                {sessionError && (
                  <Banner kind="error" title="Sign-in could not complete">
                    {sessionError}
                  </Banner>
                )}
                <button
                  type="button"
                  className="brass-button"
                  onClick={signIn}
                  disabled={
                    authBusy || !wallet.connected || !wallet.signMessage
                  }
                >
                  {authBusy
                    ? "Awaiting sign-in signature…"
                    : "Sign in with wallet →"}
                </button>
                {wallet.connected && !wallet.signMessage && (
                  <p className="helper negative">
                    This wallet does not support message signing. Connect
                    Phantom or Solflare.
                  </p>
                )}
                <p className="helper">
                  Access is limited to the initial five invited users.
                  Connecting a wallet does not trigger signatures automatically.
                </p>
              </div>
            </section>
          </>
        ) : accountNeeded && user ? (
          <>
            {!ownerConnected && (
              <Banner title="Connect the owner wallet to sign actions">
                <WalletConnect showAddress />
                Your current session belongs to {shortAddress(user.wallet)}.
              </Banner>
            )}
            {accountError && view !== "activity" && (
              <Banner
                kind="error"
                title="Account data could not be refreshed"
                retry={() => void loadAccount()}
              >
                {accountError}
              </Banner>
            )}
            {accountBusy && !strategy && !fees && !preferences ? (
              <Loading label="Loading confirmed balances and account controls…" />
            ) : view === "strategies" ? (
              <Strategies
                key={user.wallet}
                config={config}
                markets={markets}
                strategy={strategy}
                fees={fees}
                preferences={preferences}
                portfolio={portfolio}
                selectedMint={selectedMint}
                now={now}
                busy={preparing || signing}
                refreshing={accountBusy}
                reload={loadAccount}
                ownerAction={ownerAction}
                openSettings={() => navigate("settings")}
              />
            ) : view === "activity" ? (
              <Activity
                receipts={receipts}
                intents={intents}
                loading={activityBusy || accountBusy}
                error={activityError}
                retry={() => void loadActivity()}
                config={config}
                openStrategies={() => navigate("strategies")}
              />
            ) : (
              <Settings
                key={user.wallet}
                user={user}
                config={config}
                fees={fees}
                preferences={preferences}
                portfolio={portfolio}
                busy={preparing || signing}
                refreshing={accountBusy}
                reload={loadAccount}
                reviewFeeFunding={reviewFeeFunding}
                logout={logout}
              />
            )}
          </>
        ) : null}
        {accountNeeded && (
          <Recovery
            config={config}
            owner={wallet.publicKey?.toBase58()}
            busy={preparing || signing}
            review={(intent, action, amountRaw, rpcEndpoint) => {
              setSignError("");
              setReview({
                intent,
                action,
                amountRaw,
                independent: true,
                rpcEndpoint,
              });
            }}
          />
        )}
      </main>
      <footer className="footer">
        <span>
          DOUBLETAKE · FREE INVITED BETA
          <br />
          USDC vault control stays with your wallet.
        </span>
        <span>
          Automatic cycles require verified deployment,
          <br />
          fresh pool state and funded execution fees.
        </span>
        <a
          href="https://github.com/RafaTahir/doubletake"
          target="_blank"
          rel="noopener noreferrer"
        >
          Source & engineering ↗
        </a>
      </footer>
      {review && (
        <TransactionReview
          intent={review.intent}
          policy={review.policy}
          config={config}
          busy={signing}
          error={signError}
          onClose={() => {
            if (!signing) setReview(null);
          }}
          onSign={() => void signPrepared()}
        />
      )}
    </div>
  );
}

export default function Root() {
  return (
    <WorkspaceBoundary>
      <WalletShell>
        <App />
      </WalletShell>
    </WorkspaceBoundary>
  );
}
