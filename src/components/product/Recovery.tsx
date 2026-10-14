import { useState } from "react";
import { prepareIndependentOwnerAction } from "../../../shared/program.ts";
import type {
  RuntimeConfig,
  TransactionIntent,
  OwnerAction,
} from "../../services/product";
import { errorMessage } from "../../services/product";
import { Banner } from "./Common";
import { parseAmount } from "./format";
export function publicRpc(config: RuntimeConfig): string {
  return config.cluster === "localnet"
    ? "http://127.0.0.1:8899"
    : config.cluster === "devnet"
      ? "https://api.devnet.solana.com"
      : "https://api.mainnet-beta.solana.com";
}
export function Recovery({
  config,
  owner,
  busy,
  review,
}: {
  config: RuntimeConfig | null;
  owner: string | undefined;
  busy: boolean;
  review: (
    intent: TransactionIntent,
    action: OwnerAction,
    amountRaw: string | undefined,
    rpc: string,
  ) => void;
}) {
  const [rpc, setRpc] = useState(
    config ? publicRpc(config) : "https://api.mainnet-beta.solana.com",
  );
  const [withdraw, setWithdraw] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  async function prepare(action: "pause" | "revoke" | "withdraw") {
    if (!owner || !config?.programId) return;
    setWorking(true);
    setError("");
    try {
      const url = new URL(rpc);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        (url.protocol === "http:" &&
          !["localhost", "127.0.0.1"].includes(url.hostname))
      )
        throw new Error("Use HTTPS for public RPC, or a local HTTP RPC.");
      const raw = action === "withdraw" ? parseAmount(withdraw, 6) : undefined;
      const intent = await prepareIndependentOwnerAction({
        rpcEndpoint: url.toString(),
        programId: config.programId,
        owner,
        action,
        amountRaw: raw,
        cluster: config.cluster,
      });
      review(intent, action, raw, url.toString());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWorking(false);
    }
  }
  return (
    <details className="instrument-box recovery-panel">
      <summary>Owner recovery · independent of the keeper</summary>
      <div className="panel-body">
        <p className="helper">
          Connect the owner wallet and use a Solana RPC directly to pause,
          revoke or withdraw. These actions do not require the execution worker,
          email verification or fee credit.
        </p>
        {error && (
          <Banner kind="error" title="Owner action could not be prepared">
            {error}
          </Banner>
        )}
        {!config?.programId && (
          <p className="helper negative">
            The verified strategy program is not configured in this application
            build.
          </p>
        )}
        <div className="field">
          <label htmlFor="recovery-rpc">Solana RPC endpoint</label>
          <input
            id="recovery-rpc"
            type="url"
            autoComplete="url"
            spellCheck={false}
            value={rpc}
            onChange={(e) => setRpc(e.target.value)}
            disabled={busy || working}
          />
          <small>
            Use an RPC for {config?.cluster || "the configured cluster"}. Wallet
            instructions are reconstructed and checked locally.
          </small>
        </div>
        <div className="form-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => void prepare("pause")}
            disabled={!owner || !config?.programId || busy || working}
          >
            Pause on chain
          </button>
          <button
            className="secondary-button danger-button"
            type="button"
            onClick={() => void prepare("revoke")}
            disabled={!owner || !config?.programId || busy || working}
          >
            Revoke on chain
          </button>
        </div>
        <div className="form-divider" />
        <div className="field">
          <label htmlFor="recovery-withdraw">Withdraw from vault · USDC</label>
          <input
            id="recovery-withdraw"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={withdraw}
            onChange={(e) => setWithdraw(e.target.value)}
            disabled={busy || working}
          />
        </div>
        <div className="form-actions">
          <button
            className="brass-button"
            type="button"
            onClick={() => void prepare("withdraw")}
            disabled={!owner || !config?.programId || busy || working}
          >
            {working ? "Inspecting vault on chain…" : "Review owner withdrawal"}
          </button>
        </div>
        <p className="helper">
          Owner actions use your wallet's SOL for network fees. A withdrawal
          that creates your USDC token account also needs separate SOL rent. The
          RPC must be available; public RPC limits can require choosing another
          endpoint.
        </p>
      </div>
    </details>
  );
}
