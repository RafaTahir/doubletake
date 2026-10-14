import { useEffect, useRef, useState } from "react";
import { MARKETS, USDC, marketByMint } from "../../../shared/registry.ts";
import type {
  RuntimeConfig,
  StrategyPolicy,
  TransactionIntent,
} from "../../services/product";
import { Banner, ExplorerLink } from "./Common";
import { amount, dateTime, shortAddress } from "./format";
export function TransactionReview({
  intent,
  policy,
  config,
  busy,
  error,
  onClose,
  onSign,
}: {
  intent: TransactionIntent;
  policy?: StrategyPolicy;
  config: RuntimeConfig | null;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSign: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
    };
  }, []);
  const summary = intent.summary;
  const serviceCredit = intent.kind === "fee-funding";
  const reviewedAsset =
    intent.kind === "recover" && policy
      ? marketByMint(policy.assetMint)
      : [USDC, ...MARKETS].find((asset) => asset.symbol === summary.token);
  return (
    <dialog
      ref={dialog}
      className="review-dialog"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      aria-labelledby="transaction-review-title"
    >
      <header className="panel-header">
        <div>
          <span className="eyebrow">Owner authorization</span>
          <h2 id="transaction-review-title">{summary.title}</h2>
        </div>
        <button
          type="button"
          className="dialog-close"
          aria-label="Close transaction review"
          onClick={onClose}
          disabled={busy}
        >
          ×
        </button>
      </header>
      <div className="panel-body">
        {error && (
          <Banner kind="error" title="Transaction could not be signed">
            {error}
          </Banner>
        )}
        <dl className="control-spec full transaction-review">
          <dt>Action</dt>
          <dd>{intent.kind.replaceAll("-", " ")}</dd>
          <dt>Network</dt>
          <dd>{summary.cluster}</dd>
          <dt>Owner</dt>
          <dd>{shortAddress(intent.owner)}</dd>
          <dt>Recipient</dt>
          <dd>
            <ExplorerLink address={summary.recipient} cluster={config?.cluster}>
              {shortAddress(summary.recipient)}
            </ExplorerLink>
          </dd>
          {summary.amountRaw !== null && (
            <>
              <dt>
                {intent.kind === "recover"
                  ? "Unscaled token amount"
                  : "Exact amount"}
              </dt>
              <dd>
                {reviewedAsset
                  ? amount(summary.amountRaw, reviewedAsset.decimals)
                  : "—"}{" "}
                {reviewedAsset?.symbol || summary.token}
              </dd>
            </>
          )}
          <dt>Estimated network fee</dt>
          <dd>{amount(summary.networkFeeLamports, 9)} SOL</dd>
          <dt>Prepared</dt>
          <dd>{dateTime(intent.createdAt)}</dd>
        </dl>
        {intent.kind === "recover" && summary.amountRaw !== null && (
          <p className="helper">
            Recovery uses unscaled token units. Raw transfer amount:{" "}
            <span className="number">{summary.amountRaw}</span>.
          </p>
        )}
        {["initialize", "withdraw", "recover"].includes(intent.kind) && (
          <p className="helper">
            Creating a vault or needed token accounts also requires SOL rent,
            paid by your wallet. Rent is separate from this network fee
            estimate.
          </p>
        )}
        {policy && (
          <dl className="control-spec full transaction-review">
            <dt>Cycle amount</dt>
            <dd>{amount(policy.cycleAmountRaw)} USDC</dd>
            <dt>Minimum profit</dt>
            <dd>{amount(policy.minProfitRaw)} USDC</dd>
            <dt>Buy pool</dt>
            <dd>{shortAddress(policy.poolBuy)}</dd>
            <dt>Sell pool</dt>
            <dd>{shortAddress(policy.poolSell)}</dd>
            <dt>Daily fee ceiling</dt>
            <dd>{amount(policy.dailyFeeLimitLamports, 9)} SOL</dd>
            <dt>Permission expires</dt>
            <dd>{dateTime(policy.expiresAt)}</dd>
          </dl>
        )}
        <p className="transaction-notice">
          {serviceCredit
            ? "This transfers SOL to your service-controlled fee wallet. DoubleTake uses this credit to pay execution fees; unused-credit refunds depend on the service."
            : "Your wallet will sign an instruction to the strategy program. Review the program and recipient before approving. Vault controls require your owner signature."}
        </p>
        <p className="helper">
          The transaction message is checked locally before a wallet prompt. A
          signature submits an action; a confirmed result appears in Activity
          after Solana reconciliation.
        </p>
        <label className="check-field">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            disabled={busy}
          />
          <span>I reviewed the action, network, recipient and fee.</span>
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="brass-button"
            onClick={onSign}
            disabled={busy || !acknowledged}
          >
            {busy ? "Awaiting wallet / network…" : "Sign with wallet →"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
