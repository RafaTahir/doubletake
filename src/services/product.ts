import type {
  ApiError,
  RuntimeConfig,
  MarketSnapshot,
  SessionUser,
  Strategy,
  StrategyPolicy,
  ExecutionPreview,
  OwnerAction,
  TransactionIntent,
  ExecutionReceipt,
  FeeCredit,
  NotificationPreferences,
  Portfolio,
} from "../../shared/types.ts";
export type {
  RuntimeConfig,
  MarketSnapshot,
  SessionUser,
  Strategy,
  StrategyPolicy,
  ExecutionPreview,
  OwnerAction,
  TransactionIntent,
  ExecutionReceipt,
  FeeCredit,
  NotificationPreferences,
  Portfolio,
};

let csrfToken: string | undefined;
const retryKeys = new Map<string, string>();
export class ProductError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly reasons: string[] = [],
  ) {
    super(message);
    this.name = "ProductError";
  }
}
async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const keyName = `${path}:${JSON.stringify(body)}`;
  const idempotent =
    method === "POST" &&
    (path === "transactions/prepare" ||
      path === "fees/funding-intent" ||
      path === "fees/refund");
  const key = idempotent ? retryKeys.get(keyName) || crypto.randomUUID() : null;
  if (key) retryKeys.set(keyName, key);
  try {
    const response = await fetch(`/api/${path}`, {
      method,
      credentials: "same-origin",
      signal: controller.signal,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        ...(key ? { "X-Idempotency-Key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ProductError(
        "The service did not return a response. Try again.",
        "INVALID_RESPONSE",
        response.status,
      );
    }
    if (!response.ok) {
      const error = data as ApiError;
      throw new ProductError(
        error.error || "The request could not be completed. Try again.",
        error.code || "REQUEST_FAILED",
        response.status,
        error.reasons,
      );
    }
    if (key) retryKeys.delete(keyName);
    return data as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw new ProductError(
        "The service took too long. Retry once your connection is available.",
        "TIMEOUT",
        0,
      );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
export const product = {
  config: () => request<RuntimeConfig>("config"),
  markets: () => request<{ markets: MarketSnapshot[] }>("markets"),
  async session() {
    const value = await request<{
      user: SessionUser | null;
      csrfToken?: string;
    }>("auth/session");
    csrfToken = value.csrfToken;
    return value.user;
  },
  challenge: (wallet: string) =>
    request<{
      id?: string;
      challengeId?: string;
      message: string;
      expiresAt: string;
      cluster?: RuntimeConfig["cluster"];
    }>("auth/challenge", "POST", { wallet }),
  async verify(wallet: string, challengeId: string, signatureBase64: string) {
    const value = await request<{ user: SessionUser; csrfToken?: string }>(
      "auth/verify",
      "POST",
      { wallet, challengeId, signatureBase64 },
    );
    csrfToken = value.csrfToken;
    return value.user;
  },
  async logout() {
    await request("auth/logout", "POST", {});
    csrfToken = undefined;
  },
  strategy: () => request<{ strategy: Strategy | null }>("strategy"),
  saveStrategy: (policy: StrategyPolicy) =>
    request<{ strategy: Strategy }>("strategy", "PUT", { policy }),
  preview: (policy: StrategyPolicy) =>
    request<ExecutionPreview>("strategy/preview", "POST", { policy }),
  async prepare(
    action: OwnerAction,
    amountRaw?: string,
    policy?: StrategyPolicy,
  ) {
    return (
      await request<{ intent: TransactionIntent }>(
        "transactions/prepare",
        "POST",
        {
          action,
          amountRaw,
          ...(action === "initialize" || action === "configure"
            ? { policy }
            : {}),
          ...(action === "configure" ? { enable: true } : {}),
        },
      )
    ).intent;
  },
  submit: (intentId: string, signedTransactionBase64: string) =>
    request<{ intent: TransactionIntent }>("transactions/submit", "POST", {
      intentId,
      signedTransactionBase64,
    }),
  activity: () =>
    request<{ receipts: ExecutionReceipt[]; intents: TransactionIntent[] }>(
      "activity",
    ),
  importOwnerAction: (
    signature: string,
    action: "pause" | "revoke" | "withdraw" | "recover",
    amountRaw?: string,
  ) =>
    request<{ intent: TransactionIntent }>("transactions/import", "POST", {
      signature,
      action,
      amountRaw,
    }),
  fees: () => request<FeeCredit>("fees"),
  async feeFunding(amountRaw: string) {
    return (
      await request<{ intent: TransactionIntent }>(
        "fees/funding-intent",
        "POST",
        { amountRaw },
      )
    ).intent;
  },
  reconcileFees: (intentId: string) =>
    request("fees/reconcile", "POST", { intentId }),
  refund: () =>
    request<{ intent: TransactionIntent }>("fees/refund", "POST", {}),
  notifications: () => request<NotificationPreferences>("notifications"),
  deliveries: () =>
    request<{ deliveries: NotificationDelivery[] }>("notifications/deliveries"),
  saveNotifications: (
    preferences: Pick<
      NotificationPreferences,
      "executions" | "failures" | "pauses" | "lowFeeBalance"
    >,
  ) => request<NotificationPreferences>("notifications", "PUT", preferences),
  verifyEmail: (email: string) =>
    request<{ message: string }>("notifications/verify", "POST", { email }),
  confirmEmail: (token: string) =>
    request<{ message: string }>("notifications/confirm", "POST", { token }),
  portfolio: () => request<Portfolio>("portfolio"),
};
export interface NotificationDelivery {
  id: string;
  event: string;
  status: string;
  createdAt: string;
  sentAt: string | null;
  error: string | null;
}
export function toBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
export function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request could not be completed. Try again.";
}
