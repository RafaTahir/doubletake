import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  decimalToRaw,
  rawToDecimal,
  rawInteger,
  scaledDisplay,
} from "../shared/amounts.ts";
import { MARKETS, USDC } from "../shared/registry.ts";
import { RpcBudget } from "../server/markets.ts";
const require = createRequire(import.meta.url);
const bigint = require("../vendor/bigint-buffer/index.cjs");
test("mint-specific units and scaled display retain exact integer precision", () => {
  assert.equal(USDC.decimals, 6);
  assert.ok(
    MARKETS.filter((m) => m.category === "xstock").every(
      (m) => m.decimals === 8,
    ),
  );
  assert.equal(rawToDecimal("2913913", 8), "0.02913913");
  assert.equal(decimalToRaw("0.01", 8), "1000000");
  assert.equal(decimalToRaw("100", 6), "100000000");
  assert.equal(rawToDecimal("-200000", 6), "-0.2");
  assert.equal(scaledDisplay("2913913", 8, "2.5"), "0.072847825");
  assert.equal(scaledDisplay("100000000", 8, "1e-9"), "0.000000001");
  assert.equal(
    scaledDisplay("100000000", 8, "1e+21"),
    "1000000000000000000000",
  );
  assert.equal(rawInteger("18446744073709551615"), 18446744073709551615n);
  for (const invalid of ["1e6", "1.5", "-1", "18446744073709551616"])
    assert.throws(() => rawInteger(invalid));
  assert.throws(() => decimalToRaw("0.0000001", 6));
});
test("safe bigint compatibility handles exact widths and rejects overflow", () => {
  for (const width of [1, 8, 16, 32])
    for (const n of [0n, 1n, (1n << BigInt(width * 8)) - 1n]) {
      assert.equal(bigint.toBigIntBE(bigint.toBufferBE(n, width)), n);
      assert.equal(bigint.toBigIntLE(bigint.toBufferLE(n, width)), n);
    }
  assert.equal(bigint.toBigIntLE(Buffer.alloc(0)), 0n);
  assert.throws(() => bigint.toBufferLE(256n, 1));
  assert.throws(() => bigint.toBufferBE(-1n, 8));
  assert.throws(() => bigint.toBufferBE(1n, -1));
});
test("RPC bursts queue safely while exhausted credit budgets stop", async () => {
  const budget = new RpcBudget(9);
  await Promise.all(Array.from({ length: 9 }, () => budget.consume()));
  await assert.rejects(() => budget.consume(), /budget exhausted/);
  const blocked = new RpcBudget();
  blocked.backoff();
  await assert.rejects(() => blocked.consume(), /budget exhausted/);
});
