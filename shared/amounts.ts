export const U64_MAX = (1n << 64n) - 1n;
export function rawInteger(value: unknown, allowZero = false): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)$/.test(value) ||
    value.length > 20
  )
    throw new Error("Amount must be an unsigned raw integer string");
  const amount = BigInt(value);
  if (amount > U64_MAX || (!allowZero && amount === 0n))
    throw new Error("Amount is outside the supported range");
  return amount;
}
export function decimalToRaw(input: string, decimals: number): string {
  if (
    !Number.isSafeInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    !/^\d+(\.\d+)?$/.test(input)
  )
    throw new Error("Enter a valid decimal amount");
  const [whole, fraction = ""] = input.split(".");
  if (fraction.length > decimals)
    throw new Error(`Use at most ${decimals} decimal places`);
  const result =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  return rawInteger(result.toString()).toString();
}
export function rawToDecimal(raw: string, decimals: number): string {
  if (!/^-?\d+$/.test(raw)) throw new Error("Invalid integer amount");
  const amount = BigInt(raw),
    negative = amount < 0n,
    value = negative ? -amount : amount,
    scale = 10n ** BigInt(decimals);
  const fraction = (value % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${value / scale}${fraction ? "." + fraction : ""}`;
}
export function scaledDisplay(
  raw: string,
  decimals: number,
  multiplier = "1",
): string {
  const exponent = /^(\d+(?:\.\d+)?)[eE]([+-]?\d+)$/.exec(multiplier);
  if (exponent) {
    const power = Number(exponent[2]);
    if (!Number.isSafeInteger(power) || Math.abs(power) > 400)
      throw new Error("Invalid multiplier");
    const [whole, fraction = ""] = exponent[1].split(".");
    const digits = whole + fraction,
      point = whole.length + power;
    multiplier =
      point <= 0
        ? "0." + "0".repeat(-point) + digits
        : point >= digits.length
          ? digits + "0".repeat(point - digits.length)
          : digits.slice(0, point) + "." + digits.slice(point);
  }
  if (!/^\d+(\.\d+)?$/.test(multiplier)) throw new Error("Invalid multiplier");
  const [whole, fraction = ""] = multiplier.split(".");
  const precision = fraction.length;
  const scaled = BigInt(raw) * BigInt(whole + fraction);
  return rawToDecimal(scaled.toString(), decimals + precision);
}
