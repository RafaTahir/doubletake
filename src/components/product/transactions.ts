import { Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import {
  validateOwnerTransaction,
  DEVELOPMENT_PROGRAM_ID,
} from "../../../shared/program.ts";
import type { TransactionIntent, FeeCredit } from "../../services/product";
import { fromBase64 } from "../../services/product";
export function decodeOwnerTransaction(
  intent: TransactionIntent,
): Transaction | VersionedTransaction {
  const bytes = fromBase64(intent.unsignedTransactionBase64);
  try {
    return Transaction.from(bytes);
  } catch {
    return VersionedTransaction.deserialize(bytes);
  }
}
export function verifyWalletReturnedMessage(
  before: Transaction | VersionedTransaction,
  after: Transaction | VersionedTransaction,
): void {
  const original =
    before instanceof VersionedTransaction
      ? before.message.serialize()
      : before.serializeMessage();
  const returned =
    after instanceof VersionedTransaction
      ? after.message.serialize()
      : after.serializeMessage();
  if (
    original.length !== returned.length ||
    original.some((byte, index) => byte !== returned[index])
  )
    throw new Error(
      "The wallet returned a different transaction message. Prepare this action again.",
    );
}
export function signedTransactionSignature(
  transaction: Transaction | VersionedTransaction,
): string {
  const signature =
    transaction instanceof VersionedTransaction
      ? transaction.signatures[0]
      : transaction.signature;
  if (!signature || signature.every((byte) => byte === 0))
    throw new Error("The wallet did not return an owner signature.");
  return bs58.encode(signature);
}
export function validateFeeFunding(
  intent: TransactionIntent,
  owner: string,
  fees: FeeCredit | null,
  expectedRaw?: string,
): void {
  if (
    !fees ||
    intent.kind !== "fee-funding" ||
    intent.owner !== owner ||
    intent.summary.token !== "SOL" ||
    !intent.summary.amountRaw
  )
    throw new Error("The fee transfer does not match this wallet.");
  if (
    expectedRaw !== intent.summary.amountRaw ||
    intent.summary.recipient !== fees.walletAddress
  )
    throw new Error("The fee-wallet recipient or transfer amount changed.");
  validateOwnerTransaction(fromBase64(intent.unsignedTransactionBase64), {
    action: "fee-funding",
    owner,
    programId: DEVELOPMENT_PROGRAM_ID,
    amountRaw: expectedRaw,
    feeWallet: fees.walletAddress,
  });
}
