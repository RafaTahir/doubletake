import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import {
  SolanaChainGateway,
  networkFeeFromReceipt,
  extractCycleMetadata,
} from "../server/chain.ts";
import { createHash } from "node:crypto";
import {
  deriveProgramAddresses,
  DEVELOPMENT_PROGRAM_ID,
} from "../shared/program.ts";
import { MARKETS, RAYDIUM_CLMM_PROGRAM } from "../shared/registry.ts";
import { RaydiumMarkets, RpcBudget } from "../server/markets.ts";
import type { IntentRecord } from "../server/ports.ts";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("keeper signing binds the independently prepared message, fee-wallet owner and refund recipient", async () => {
  const owner = Keypair.generate().publicKey.toBase58(),
    fee = Keypair.generate();
  const rpc = {
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    getFeeForMessage: async () => ({ value: 6400 }),
    getBalance: async () => 1_000_000,
  };
  const markets = new RaydiumMarkets(
    "http://127.0.0.1:8899",
    rpc as unknown as Connection,
  );
  const chain = new SolanaChainGateway(
    { rpcUrl: "http://127.0.0.1:8899", cluster: "localnet" },
    markets,
  );
  const prepared = await chain.prepareRefund(
    owner,
    fee.publicKey.toBase58(),
    "900000",
  );
  const signed = await chain.signKeeperTransaction(
    prepared,
    fee.secretKey,
    owner,
  );
  assert.equal(bs58.decode(signed.signature).length, 64);
  await assert.rejects(
    () =>
      chain.signKeeperTransaction(
        prepared,
        fee.secretKey,
        Keypair.generate().publicKey.toBase58(),
      ),
    /owner differs/,
  );
  const decoded = TransactionMessage.decompile(
    VersionedTransaction.deserialize(
      Buffer.from(prepared.transactionBase64, "base64"),
    ).message,
  );
  decoded.instructions[2] = SystemProgram.transfer({
    fromPubkey: fee.publicKey,
    toPubkey: Keypair.generate().publicKey,
    lamports: 900000n,
  });
  const changed = new VersionedTransaction(
    new TransactionMessage(decoded).compileToV0Message(),
  );
  const tampered = {
    ...prepared,
    transactionBase64: Buffer.from(changed.serialize()).toString("base64"),
    messageBase64: Buffer.from(changed.message.serialize()).toString("base64"),
  };
  await assert.rejects(
    () => chain.signKeeperTransaction(tampered, fee.secretKey, owner),
    /independent message review/,
  );
});

test("confirmed fees reconcile only against the exact persisted signed message", async () => {
  const fee = Keypair.generate(),
    owner = Keypair.generate().publicKey;
  let receipt: any;
  const rpc = {
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    getFeeForMessage: async () => ({ value: 6400 }),
    getBalance: async () => 1_000_000,
    getSignatureStatuses: async () => ({
      value: [{ confirmationStatus: "confirmed" }],
    }),
    getTransaction: async () => receipt,
  };
  const chain = new SolanaChainGateway(
    { rpcUrl: "http://127.0.0.1:8899", cluster: "localnet" },
    new RaydiumMarkets("http://127.0.0.1:8899", rpc as unknown as Connection),
  );
  const prepared = await chain.prepareRefund(
    owner.toBase58(),
    fee.publicKey.toBase58(),
    "900000",
  );
  const signed = await chain.signKeeperTransaction(
    prepared,
    fee.secretKey,
    owner.toBase58(),
  );
  const tx = VersionedTransaction.deserialize(
    Buffer.from(signed.wireBase64, "base64"),
  );
  const keys = tx.message.getAccountKeys();
  const balance = Array.from({ length: keys.length }, () => 0);
  balance[0] = 1000000;
  const post = [...balance];
  post[0] = 93800;
  post[1] = 900000;
  receipt = {
    transaction: { message: tx.message, signatures: [signed.signature] },
    meta: { err: null, fee: 6200, preBalances: balance, postBalances: post },
    slot: 1,
    blockTime: 1800000000,
  };
  const intent = {
    signature: signed.signature,
    feePayer: fee.publicKey.toBase58(),
    owner: owner.toBase58(),
    strategyId: null,
    kind: "fee-refund",
    payload: {},
    prepared,
    feeWallet: fee.publicKey.toBase58(),
    lastValidBlockHeight: 100,
  } as IntentRecord;
  const result = await chain.reconcile(intent);
  assert.equal(result.feeLamportsRaw, "6200");
  assert.equal(result.refundRaw, "900000");
  receipt.meta.err = { InstructionError: [2, "Custom"] };
  receipt.meta.postBalances = [...balance];
  receipt.meta.postBalances[0] = 993800;
  assert.equal((await chain.reconcile(intent)).status, "failed");
  assert.equal((await chain.reconcile(intent)).feeLamportsRaw, "6200");
  receipt.transaction.signatures = [bs58.encode(Keypair.generate().secretKey)];
  await assert.rejects(
    () => chain.reconcile(intent),
    /persisted signed intent/,
  );
});
test("fee conservation includes priority fees and excludes transfers and account rent", () => {
  assert.equal(
    networkFeeFromReceipt(
      {
        fee: 5000,
        preBalances: [1_000_000, 0, 1],
        postBalances: [894_749, 100_000, 1],
      },
      "localnet",
    ),
    "5251",
  );
  assert.equal(
    networkFeeFromReceipt({
      fee: 5251,
      preBalances: [1_000_000, 0],
      postBalances: [994_749, 0],
    }),
    "5251",
  );
  assert.throws(
    () =>
      networkFeeFromReceipt({
        fee: 5000,
        preBalances: [1_000_000, 0],
        postBalances: [994_749, 0],
      }),
    /metadata and balance proof disagree/,
  );
  assert.throws(() =>
    networkFeeFromReceipt({ fee: 5000, preBalances: [0], postBalances: [1] }),
  );
});

test("execution metadata accepts only the guarded program event and verified owner vault", () => {
  const owner = Keypair.generate().publicKey,
    asset = MARKETS[0],
    program = DEVELOPMENT_PROGRAM_ID;
  const event = Buffer.alloc(256);
  createHash("sha256")
    .update("event:CycleReceipt")
    .digest()
    .copy(event, 0, 0, 8);
  owner.toBuffer().copy(event, 8);
  new PublicKey(deriveProgramAddresses(program, owner.toBase58()).vault)
    .toBuffer()
    .copy(event, 40);
  event.writeBigUInt64LE(7n, 72);
  new PublicKey(asset.mint).toBuffer().copy(event, 80);
  new PublicKey(asset.pools[0]).toBuffer().copy(event, 112);
  new PublicKey(asset.pools[1]).toBuffer().copy(event, 144);
  event.writeBigUInt64LE(100000000n, 176);
  event.writeBigUInt64LE(100050001n, 184);
  event.writeBigUInt64LE(2913913n, 192);
  event.writeBigUInt64LE(50001n, 200);
  event.fill(0xab, 224);
  const data = `Program data: ${event.toString("base64")}`;
  const spoof = [
    `Program ${program} invoke [1]`,
    `Program ${RAYDIUM_CLMM_PROGRAM} invoke [2]`,
    data,
    `Program ${RAYDIUM_CLMM_PROGRAM} success`,
    `Program ${program} success`,
  ];
  assert.equal(extractCycleMetadata(spoof, program, owner.toBase58()), null);
  const genuine = [...spoof.slice(0, -1), data, `Program ${program} success`];
  const result = extractCycleMetadata(genuine, program, owner.toBase58());
  assert.equal(result?.assetReceivedRaw, "2913913");
  assert.equal(result?.profitRaw, "50001");
  assert.equal(result?.nonce, "7");
  assert.equal(result?.mintFingerprint, "ab".repeat(32));
  assert.throws(
    () =>
      extractCycleMetadata(
        genuine,
        program,
        Keypair.generate().publicKey.toBase58(),
      ),
    /event owner differs/,
  );
});

test("monthly RPC credits survive restart and retain a critical reconciliation reserve", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "doubletake-credit-"));
  try {
    const file = path.join(directory, "credits.json");
    const first = new RpcBudget(1000, file);
    for (let i = 0; i < 8; i++) await first.consume(100);
    await first.consume(75);
    const resumed = new RpcBudget(1000, file);
    await assert.rejects(() => resumed.consume(), /reserve retained/);
    await resumed.consume(100, true);
    await resumed.consume(25, true);
    await assert.rejects(() => resumed.consume(1, true), /budget exhausted/);
  } finally {
    if (
      !path
        .resolve(directory)
        .startsWith(path.join(os.tmpdir(), "doubletake-credit-"))
    )
      throw Error("Unexpected temporary test directory");
    rmSync(directory, { recursive: true, force: true });
  }
});
