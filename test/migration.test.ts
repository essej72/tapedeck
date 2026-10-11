// What a completed curve hands to the pool it migrates into (src/migration.ts), held offline.
//
// Each fixture row is one real migration: the config, the pool account, the token amounts that moved into the new
// pool's vaults in the migration transaction, and what DAMM v2 recorded when it initialised the pool. The engine has
// to say the same, to the unit.

import assert from "node:assert/strict";
import { test } from "node:test";
import BN from "bn.js";
import { MigratedPool } from "../src/engine/amm.ts";
import { configFromBytes } from "../src/engine/bytes.ts";
import { enginePool, migrationDifferences, poolShape, protocolCut, readMigrations, summarize } from "../src/migration.ts";

const rows = readMigrations(new URL("fixtures/migrations.jsonl", import.meta.url));
const configOf = (r: (typeof rows)[number]) => configFromBytes(Uint8Array.from(Buffer.from(r.configData, "base64"))) as unknown as Record<string, any>;

test("every recorded migration put into the new pool what the engine says, to the unit, at the price it says", () => {
  assert.ok(rows.length >= 25);
  for (const r of rows) assert.deepEqual(migrationDifferences(r), [], r.pool);
});

test("the recorded migrations cover both targets, split liquidity, compounding pools and pools from before the protocol's fee", () => {
  const s = summarize(rows);
  assert.ok(s.dammV1 >= 2 && s.dammV2 >= 15, JSON.stringify(s));
  assert.ok(rows.some((r) => (r.damm?.positions ?? 0) > 1), "no migration with two positions");
  assert.ok(rows.some((r) => configOf(r).migratedCollectFeeMode === 2), "no compounding pool");
  assert.ok(rows.some((r) => protocolCut(r)?.bps === 0) && rows.some((r) => protocolCut(r)?.bps === 20), "protocol fee rates");
});

test("the protocol's cut of the tokens is the base side of its quote cut, not a fifth of a percent of the tokens", () => {
  // The simpler rule is what this engine used before it was held against the chain: one unit out in most pools.
  let simplerIsWrong = 0;
  for (const r of rows) {
    const cut = protocolCut(r);
    if (r.target !== "DAMM v2" || !cut || cut.bps === 0 || cut.base === "0" || configOf(r).migratedCollectFeeMode === 2) continue;
    assert.equal(enginePool(r).protocolFee.base.toString(), cut.base, r.pool);
    if ((configOf(r).migrationBaseThreshold as BN).muln(cut.bps).divn(10_000).toString() !== cut.base) simplerIsWrong++;
  }
  assert.ok(simplerIsWrong > 0);
});

test("the engine knows from the config what kind of DAMM v2 pool comes out: range, fee side, dynamic fee, fee schedule", () => {
  const shapes = rows.filter((r) => r.damm).map((r) => ({ r, shape: poolShape(r)! }));
  const dynamic = shapes.filter((x) => x.r.damm!.dynamicFee);
  assert.ok(dynamic.length >= 3 && dynamic.every((x) => !x.shape.flatFee));
  assert.ok(shapes.some((x) => configOf(x.r).migratedCollectFeeMode === 2), "no compounding pool");
  for (const x of shapes) assert.ok(x.shape.fullRange && x.shape.feeAsEngine && x.shape.feeSideAsEngine && x.shape.dynamicAsEngine && x.shape.scheduleAsEngine, x.r.pool);
  const plain = shapes.filter((x) => x.shape.fullRange && x.shape.feeAsEngine && x.shape.flatFee && x.shape.feeSideAsEngine);
  assert.ok(plain.length >= 10);
  // where the config asks for the fee from the output token, the engine takes a buy's fee in tokens
  const outputSide = plain.find((x) => x.r.damm!.collectFeeMode === 0)!;
  const pool = new MigratedPool(configFromBytes(Uint8Array.from(Buffer.from(outputSide.r.configData, "base64"))));
  const buy = pool.buy(new BN(1_000_000));
  assert.equal(buy.feeOnBase, true);
  assert.ok(buy.fee.gtn(0) && pool.baseFeesCollected.eq(buy.fee) && pool.feesCollected.isZero());
});
