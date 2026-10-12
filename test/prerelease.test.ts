// The two checks made against program 0.2.2 on devnet before its release (src/config2.ts, src/transferfee.ts), offline.
//
// The fixtures are rows of those runs: configs the program stored for createConfig2, and whole simulated lives of
// pools whose base mint charges a transfer fee. The installed SDK predates all of it, so the tests that need the
// 2.0 SDK run only where a bundle of it is at hand (data/sdk-2.mjs, from scripts/bundle-sdk.mjs); the `sdk` workflow
// bundles the upstream pull request and runs the same check there.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Connection } from "@solana/web3.js";
import { cases, storedTransferFee, summarize as summarizeConfigs, type Row } from "../src/config2.ts";
import { readLines } from "../src/migration.ts";
import { checkSim, readSims, summarize as summarizeSwaps } from "../src/transferfee.ts";

const rows: Row[] = readLines(new URL("fixtures/config2.jsonl", import.meta.url)).map((l) => JSON.parse(l));
const sims = readSims(fileURLToPath(new URL("fixtures/transferfee.jsonl", import.meta.url)));
const bundle = fileURLToPath(new URL("../data/sdk-2.mjs", import.meta.url));
const sdk = existsSync(bundle) ? await import(pathToFileURL(bundle).href) : null;
const client = sdk ? new sdk.DynamicBondingCurveClient(new Connection("http://127.0.0.1:1"), "confirmed") : null;

test("the cases are the same every time, and cover a fee, its edges and every broken rule", () => {
  const a = cases(120);
  assert.deepEqual(a.map((c) => [c.n, c.label, c.transferFee]), cases(120).map((c) => [c.n, c.label, c.transferFee]));
  const labels = new Set(a.map((c) => c.label));
  for (const want of ["plain", "fee: valid", "fee: 1001 bps", "fee: 0 bps, immutable", "fee on: vesting", "fee on: an SPL token", "fee on: a fixed migration fee tier", "fee on: no fixed supply"]) assert.ok(labels.has(want), want);
});

test("a stored transfer fee config carries the fee that was sent, and a plain one carries none", () => {
  const stored = rows.filter((r) => r.data);
  assert.ok(stored.some((r) => r.transferFee) && stored.some((r) => !r.transferFee));
  for (const r of stored) {
    const got = storedTransferFee(Uint8Array.from(Buffer.from(r.data!, "base64")));
    assert.deepEqual(got, r.transferFee ? { ...r.transferFee, flag: 1 } : { transferFeeBasisPoints: 0, withheldAuthority: 0, migratedTransferFeeAuthorityOption: 0, flag: 0 }, `${r.n} ${r.label}`);
  }
});

test("in the recorded run the SDK and the program took and refused the same configs", () => {
  const s = summarizeConfigs(rows);
  assert.equal(s.plain.sdkBuildsProgramRefuses + s.plain.sdkRefusesProgramTakes + s.fee.sdkBuildsProgramRefuses + s.fee.sdkRefusesProgramTakes, 0);
  assert.ok(s.fee.bothTake > 0 && s.fee.bothRefuse > 0 && s.plain.bothTake > 0);
  assert.deepEqual(s.storedDifferently, []);
});

test("the simulated lives hold what the check needs: both directions, all three modes, refusals, several fee levels", () => {
  const steps = sims.flatMap((s) => s.events.map((_, i) => s.steps[i]));
  assert.ok(steps.some((st) => st.buy) && steps.some((st) => !st.buy));
  for (const mode of [0, 1, 2]) assert.ok(steps.some((st) => st.mode === mode), `mode ${mode}`);
  assert.ok(sims.some((s) => s.refusedAt !== null));
  assert.ok(new Set(sims.map((s) => s.transferFee.transferFeeBasisPoints)).size >= 4);
  // what the transfer fee took is in the record: a buy's tokens arrive short by the fee
  assert.ok(sims.some((s) => s.transferFee.transferFeeBasisPoints > 0 && s.events[0] && s.steps[0].buy && BigInt(s.events[0].excludedTransferFeeAmountOut) < BigInt(s.events[0].includedTransferFeeAmountOut)));
});

test("SDK 2.0 quotes every recorded transfer fee swap as the program made it", { skip: !sdk && "no bundle of the 2.0 SDK at data/sdk-2.mjs" }, () => {
  const s = summarizeSwaps(sdk, client, sims);
  assert.deepEqual(s.differing, []);
  assert.ok(s.swaps >= 20 && s.refusals >= 1, `${s.swaps} swaps, ${s.refusals} refusals`);
});

test("and the check notices a quote that forgets the transfer fee", { skip: !sdk && "no bundle of the 2.0 SDK at data/sdk-2.mjs" }, () => {
  // the same SDK, asked as if the stored config carried no fee
  const forgetful = { ...client, partner: client.partner, pool: { swapQuote2: (p: any) => client.pool.swapQuote2({ ...p, config: { ...p.config, transferFeeFlag: 0, transferFeeBasisPoints: 0 } }), getQuoteFromInputAmount: (p: any) => client.pool.getQuoteFromInputAmount({ ...p, baseTransferFeeBasisPoints: 0 }), getQuoteFromOutputAmount: (p: any) => client.pool.getQuoteFromOutputAmount({ ...p, baseTransferFeeBasisPoints: 0 }) } };
  const withFee = sims.filter((s) => s.transferFee.transferFeeBasisPoints > 0 && s.events.length > 0);
  const caught = withFee.filter((s) => checkSim(sdk, forgetful, s).mismatches.length > 0);
  assert.equal(caught.length, withFee.length, `${caught.length} of ${withFee.length} caught`);
});
