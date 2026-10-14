import { decimalToRaw, rawToDecimal } from "../../../shared/amounts.ts";
/** Monetary inputs and balances never travel through a floating-point conversion. */
export function parseAmount(value: string, decimals: number): string {
  return decimalToRaw(value.trim(), decimals);
}

export function rawDecimal(
  raw: string | null | undefined,
  decimals: number,
): string | null {
  if (raw == null || !/^-?\d+$/.test(raw)) return null;
  return rawToDecimal(raw, decimals);
}

export function amount(
  raw: string | null | undefined,
  decimals = 6,
  signed = false,
): string {
  const value = rawDecimal(raw, decimals);
  if (value == null) return "—";
  const [whole, fraction] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const positive = signed && BigInt(raw!) > 0n ? "+" : "";
  return `${positive}${grouped}${fraction ? `.${fraction}` : ""}`;
}

export function currency(
  value: number | null | undefined,
  compact = false,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value !== 0 && Math.abs(value) < 0.01)
    return `${value < 0 ? "-" : ""}<$0.01`;
  const abbreviate = compact && Math.abs(value) >= 1000;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: abbreviate ? 0 : 2,
    maximumFractionDigits: abbreviate ? 1 : 2,
    ...(abbreviate ? { notation: "compact" } : {}),
  }).format(Object.is(value, -0) ? 0 : value);
}

export function percent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value !== 0 && Math.abs(value) < 0.01)
    return `${value < 0 ? "-" : ""}<0.01%`;
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Object.is(value, -0) ? 0 : value)}%`;
}

export function shortAddress(address: string): string {
  return address.length > 14
    ? `${address.slice(0, 6)}…${address.slice(-6)}`
    : address;
}
export function dateTime(at: number | string | null | undefined): string {
  if (at == null) return "Not checked";
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? "Not checked"
    : date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
}
export function age(
  at: number | string | null | undefined,
  now: number,
): string {
  if (at == null) return "Awaiting data";
  const seconds = Math.max(
    0,
    Math.floor((now - new Date(at).getTime()) / 1000),
  );
  if (!Number.isFinite(seconds)) return "Awaiting data";
  return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}
