// What the live program did with configs the SDK's curve builders built (src/builders.ts), held offline.
//
// The fixture rows are the program's own answers to simulated create_config transactions, recorded on 11 October 2026
// with the installed SDK (1.5.13): the bytes it would store, or its refusal. Three things in them are behaviour of
// 1.5.13 that the SDK's 2.0 branch changes; when the installed SDK moves to 2.0 those three tests should start to
// fail, and that is the signal to record the rows again.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as sdk from "@meteora-ag/dynamic-bonding-curve-sdk";
import Decimal from "decimal.js";
import { build, designs, programQuoteAmount, storedDifferences, supplyShortfall, type Outcome } from "../src/builders.ts";
import { configFromBytes } from "../src/engine/bytes.ts";

const rows: Outcome[] = readFileSync(new URL("fixtures/builders.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const all = designs(600);
const designOf = (r: Outcome) => all[r.n - 1];
const paramsOf = (r: Outcome) => build(sdk, designOf(r)).params!;
const bytes = (r: Outcome) => Uint8Array.from(Buffer.from(r.data!, "base64"));
const stored = rows.filter((r) => r.stage === "stored");
const refused = rows.filter((r) => r.stage === "program");
const fee = (r: Outcome) => designOf(r).input.migration.migrationFee.feePercentage as number;

test("the random builder inputs are repeatable, and the SDK still builds every recorded one", () => {
  assert.ok(stored.length >= 20 && refused.length >= 10);
  assert.deepEqual(designs(5), designs(5));
  for (const r of rows) {
    assert.equal(designOf(r).builder, r.builder, `input ${r.n}`);
    assert.ok(build(sdk, designOf(r)).params, `input ${r.n}`);
  }
});

test("without a migration fee the program stores exactly what the SDK's helpers derive", () => {
  const plain = stored.filter((r) => fee(r) === 0);
  assert.ok(plain.length >= 8);
  for (const r of plain) assert.deepEqual(storedDifferences(sdk, paramsOf(r), bytes(r)), [], `input ${r.n}`);
});

test("with a migration fee the program rounds the quote amount up, and the migration base is the only field that moves", () => {
  const withFee = stored.filter((r) => fee(r) > 0);
  assert.ok(withFee.length >= 6);
  for (const r of withFee) {
    const p = paramsOf(r);
    const s = configFromBytes(bytes(r));
    const diff = storedDifferences(sdk, p, bytes(r));
    assert.ok(diff.every((d) => d.startsWith("migrationBaseThreshold")), `input ${r.n}: ${diff.join(" | ")}`);
    const base = sdk.getMigrationBaseToken(programQuoteAmount(p.migrationQuoteThreshold, fee(r)), s.migrationSqrtPrice, p.migrationOption);
    assert.equal(base.toString(), s.migrationBaseThreshold.toString(), `input ${r.n}`);
  }
});

test("a config the program refused is short of its supply rule; a config it stored is not", () => {
  for (const r of refused) {
    assert.equal(r.error, "InvalidTokenSupply");
    assert.match(supplyShortfall(sdk, paramsOf(r)) ?? "", /base units short/, `input ${r.n}`);
    // every one of them has a migration fee and no leftover: nothing absorbs the rounding
    assert.ok(fee(r) > 0 && designOf(r).input.token.leftover === 0, `input ${r.n}`);
  }
  for (const r of stored) assert.equal(supplyShortfall(sdk, paramsOf(r)), null, `input ${r.n}`);
});

test("SDK 1.5.13's two-segment builders drop the fraction of percentageSupplyOnMigration, and the config migrates too high", () => {
  const off = stored.filter((r) => r.capError && Math.abs(r.capError.migration) > 1e-3);
  assert.ok(off.length >= 5);
  for (const r of off) {
    const d = designOf(r);
    assert.match(d.builder, /TwoSegments|MidPrice/);
    const s = configFromBytes(bytes(r));
    const cap = new Decimal(sdk.getPriceFromSqrtPrice(s.migrationSqrtPrice, d.input.token.tokenBaseDecimal, d.input.token.tokenQuoteDecimal).toString()).mul(d.input.token.totalTokenSupply).toNumber();
    const asked = d.input.percentageSupplyOnMigration as number;
    assert.ok(Math.abs(cap / d.input.migrationMarketCap - asked / Math.floor(asked)) < 1e-5, `input ${r.n}: asked ${asked}%, cap ${cap} against ${d.input.migrationMarketCap}`);
  }
  // with a whole percentage the same builders hit the cap that was asked for
  const whole = stored.filter((r) => /TwoSegments|MidPrice/.test(r.builder) && Number.isInteger(designOf(r).input.percentageSupplyOnMigration));
  for (const r of whole) assert.ok(Math.abs(r.capError!.migration) < 1e-5, `input ${r.n}`);
});
