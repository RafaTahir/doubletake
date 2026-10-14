import type { ReactNode } from "react";
import type { RuntimeConfig } from "../../services/product";
export function Banner({
  title,
  children,
  kind = "",
  retry,
}: {
  title: string;
  children?: ReactNode;
  kind?: string;
  retry?: () => void;
}) {
  return (
    <div
      className={`status-banner ${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      <div>
        <strong>{title}</strong>
        {children && <p>{children}</p>}
      </div>
      {retry && (
        <button className="text-button" type="button" onClick={retry}>
          Try again ↻
        </button>
      )}
    </div>
  );
}
export function Heading({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
      {actions && <div className="page-heading-actions">{actions}</div>}
    </header>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-glyph" aria-hidden="true">
        ◇
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Loading({
  label,
  count = 2,
}: {
  label: string;
  count?: number;
}) {
  return (
    <div aria-busy="true">
      <p className="load-message" role="status">
        {label}
      </p>
      <div className="market-list">
        {Array.from({ length: count }, (_, index) => (
          <div className="skeleton" key={index} aria-hidden="true" />
        ))}
      </div>
    </div>
  );
}
export function ReadinessPanel({ config }: { config: RuntimeConfig | null }) {
  const reasons = config?.readiness.reasons ?? ["Connecting to the service."];
  return (
    <section className="instrument-box">
      <header className="panel-header">
        <h2>System status</h2>
        <span
          className={`badge ${config?.readiness.ready ? "ready" : "review"}`}
        >
          {config?.readiness.ready ? "VERIFIED" : "PENDING"}
        </span>
      </header>
      <div className="panel-body">
        <ul className="gate-list">
          <li>
            <span
              className={`gate-icon ${config?.fundingEnabled ? "pass" : ""}`}
              aria-hidden="true"
            >
              {config?.fundingEnabled ? "✓" : "○"}
            </span>
            <div>
              <b>Vault funding</b>
              <small>
                {config?.fundingEnabled
                  ? "Available to invited wallets."
                  : "Opens after deployment verification."}
              </small>
            </div>
          </li>
          <li>
            <span
              className={`gate-icon ${config?.automationEnabled ? "pass" : ""}`}
              aria-hidden="true"
            >
              {config?.automationEnabled ? "✓" : "○"}
            </span>
            <div>
              <b>Automatic cycles</b>
              <small>
                {config?.automationEnabled
                  ? "Subject to strategy and market checks."
                  : "Requires verified execution and fee credit."}
              </small>
            </div>
          </li>
        </ul>
        {reasons.length > 0 && (
          <details className="receipt-details">
            <summary>View status details</summary>
            <ul className="gate-list">
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
export function ExplorerLink({
  address,
  signature = false,
  cluster = "mainnet-beta",
  children,
}: {
  address: string;
  signature?: boolean;
  cluster?: string;
  children: ReactNode;
}) {
  const query =
    cluster === "mainnet-beta" ? "" : `?cluster=${encodeURIComponent(cluster)}`;
  return (
    <a
      href={`https://explorer.solana.com/${signature ? "tx" : "address"}/${encodeURIComponent(address)}${query}`}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
    >
      {children} ↗
    </a>
  );
}
