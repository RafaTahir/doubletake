import { useState } from "react";
import type {
  ExecutionReceipt,
  TransactionIntent,
  RuntimeConfig,
} from "../../services/product";
import { Banner, Heading, Empty, Loading, ExplorerLink } from "./Common";
import { amount, dateTime, shortAddress } from "./format";
const labels: Record<string, string> = {
  initialize: "Vault created",
  configure: "Strategy authorization",
  deposit: "USDC deposit",
  pause: "Strategy paused",
  revoke: "Keeper revoked",
  withdraw: "USDC withdrawal",
  recover: "Residual token recovery",
  execute: "Atomic arbitrage cycle",
  "fee-funding": "SOL fee funding",
  "fee-refund": "Unused fee credit refund",
};
export function Activity({
  receipts,
  intents,
  loading,
  error,
  retry,
  config,
  openStrategies,
}: {
  receipts: ExecutionReceipt[];
  intents: TransactionIntent[];
  loading: boolean;
  error: string;
  retry: () => void;
  config: RuntimeConfig | null;
  openStrategies: () => void;
}) {
  const [filter, setFilter] = useState<
    "all" | "confirmed" | "pending" | "failed"
  >("all");
  const receiptIds = new Set(receipts.map((receipt) => receipt.intentId));
  const pending = intents.filter(
    (intent) => !receiptIds.has(intent.id) && intent.status !== "prepared",
  );
  const rows = [
    ...receipts.map((receipt) => ({
      id: receipt.id,
      kind: receipt.kind,
      status: receipt.status,
      at: receipt.occurredAt,
      signature: receipt.signature,
      usdc: receipt.usdcDeltaRaw,
      fee: receipt.networkFeeLamports,
      error: receipt.error,
      slot: receipt.slot,
    })),
    ...pending.map((intent) => ({
      id: intent.id,
      kind: intent.kind,
      status:
        intent.status === "failed"
          ? "failed"
          : intent.status === "expired"
            ? "expired"
            : "pending",
      at: intent.updatedAt,
      signature: intent.signature,
      usdc: null,
      fee: null,
      error: intent.error,
      slot: null,
    })),
  ]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .filter(
      (row) =>
        filter === "all" ||
        (filter === "confirmed" &&
          (row.status === "confirmed" || row.status === "finalized")) ||
        filter === row.status,
    );
  return (
    <>
      <Heading
        eyebrow="03 / The transaction ledger"
        title="Every result, accounted for."
        actions={
          <button
            type="button"
            className="secondary-button"
            onClick={retry}
            disabled={loading}
          >
            {loading ? "Reconciling…" : "Refresh activity ↻"}
          </button>
        }
      >
        Track confirmed USDC changes and actual SOL network fees. Submitted
        transactions remain pending until their signatures are reconciled on
        Solana.
      </Heading>
      {error && (
        <Banner
          kind="error"
          title="Activity could not be refreshed"
          retry={retry}
        >
          {error}
        </Banner>
      )}
      {loading && !receipts.length && !intents.length ? (
        <Loading label="Reconciling your transaction history…" />
      ) : (
        <section className="instrument-box">
          <div className="activity-toolbar" aria-label="Filter activity">
            {(["all", "confirmed", "pending", "failed"] as const).map(
              (value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {value.charAt(0).toUpperCase() + value.slice(1)}
                </button>
              ),
            )}
          </div>
          {!rows.length ? (
            <div className="panel-body">
              <Empty
                title={
                  filter === "all"
                    ? "Your ledger starts here."
                    : `No ${filter} transactions`
                }
              >
                {filter === "all"
                  ? "Deposits, strategy controls and cycle receipts appear here after your first on-chain action."
                  : "Choose All to see the rest of your activity."}
                {filter === "all" ? <span /> : null}
              </Empty>
              {filter === "all" && (
                <div className="form-actions">
                  <button
                    type="button"
                    className="brass-button"
                    onClick={openStrategies}
                  >
                    Configure your strategy →
                  </button>
                </div>
              )}
            </div>
          ) : (
            <ol className="activity-list">
              {rows.map((row) => (
                <li className="activity-row" key={row.id}>
                  <span className="activity-icon" aria-hidden="true">
                    {row.kind === "execute"
                      ? "⇄"
                      : row.kind === "deposit" || row.kind === "fee-funding"
                        ? "↓"
                        : row.kind === "withdraw" || row.kind === "fee-refund"
                          ? "↑"
                          : "◇"}
                  </span>
                  <div>
                    <div className="activity-title">
                      <h3>{labels[row.kind] || row.kind}</h3>
                      <span
                        className={`badge ${row.status === "finalized" ? "confirmed" : row.status}`}
                      >
                        {row.status.toUpperCase()}
                      </span>
                    </div>
                    <small>
                      {dateTime(row.at)}
                      {row.slot
                        ? ` · slot ${row.slot.toLocaleString("en-US")}`
                        : ""}
                    </small>
                    {row.error && <p className="negative">{row.error}</p>}
                    {row.signature ? (
                      <ExplorerLink
                        signature
                        address={row.signature}
                        cluster={config?.cluster}
                      >
                        {shortAddress(row.signature)}
                      </ExplorerLink>
                    ) : (
                      <p>Signature not yet available.</p>
                    )}
                    {row.status === "pending" && (
                      <p>
                        Checking the signature before allowing another cycle or
                        charging fees.
                      </p>
                    )}
                  </div>
                  <div className="activity-values">
                    <strong
                      className={
                        row.usdc?.startsWith("-")
                          ? "negative"
                          : row.usdc && BigInt(row.usdc) > 0n
                            ? "positive"
                            : ""
                      }
                    >
                      {row.usdc === null
                        ? "Pending"
                        : `${amount(row.usdc, 6, true)} USDC`}
                    </strong>
                    <small className="number">
                      {row.fee === null
                        ? "Fee pending"
                        : `${amount(row.fee, 9)} SOL fee`}
                    </small>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </>
  );
}
