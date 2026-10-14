import type { Cluster } from "../../../shared/types.ts";
export interface PendingOwnerAction {
  owner: string;
  signature: string;
  action: "pause" | "revoke" | "withdraw" | "recover";
  amountRaw?: string;
  cluster: Cluster;
  createdAt: string;
  importedId?: string;
}
export function markPendingImported(signature: string, intentId: string): void {
  try {
    localStorage.setItem(
      key,
      JSON.stringify(
        pendingOwnerActions().map((item) =>
          item.signature === signature
            ? { ...item, importedId: intentId }
            : item,
        ),
      ),
    );
  } catch {}
}
const key = "doubletake:pending-owner-actions:v1";
/** Only public transaction metadata is kept locally; no wallet keys or RPC credentials. */
export function pendingOwnerActions(owner?: string): PendingOwnerAction[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is PendingOwnerAction =>
          item &&
          typeof item.owner === "string" &&
          typeof item.signature === "string" &&
          ["pause", "revoke", "withdraw", "recover"].includes(item.action) &&
          ["mainnet-beta", "devnet", "localnet"].includes(item.cluster) &&
          typeof item.createdAt === "string" &&
          (!owner || item.owner === owner),
      )
      .slice(-20);
  } catch {
    return [];
  }
}
export function queueOwnerAction(value: PendingOwnerAction): void {
  try {
    const previous = pendingOwnerActions().filter(
      (item) => item.signature !== value.signature,
    );
    localStorage.setItem(key, JSON.stringify([...previous, value].slice(-20)));
  } catch {
    /* Direct owner controls still work when local storage is unavailable. */
  }
}
export function removePendingSignatures(signatures: Set<string>): void {
  try {
    localStorage.setItem(
      key,
      JSON.stringify(
        pendingOwnerActions().filter((item) => !signatures.has(item.signature)),
      ),
    );
  } catch {}
}
