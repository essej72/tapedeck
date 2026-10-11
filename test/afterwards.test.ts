// Trading in the pool a curve migrated into (src/afterwards.ts), held offline.
//
// Each fixture row is a real migration followed by the first events of the DAMM v2 pool it created: the pool
// initialised, liquidity added or removed, and swaps, as DAMM v2 itself recorded them. The engine's migrated pool is
// built from the DBC accounts alone and has to give every swap's amounts, next price and fee.

import assert from "node:assert/strict";
import { test } from "node:test";
import BN from "bn.js";
import { readAfterwards, replayAfterwards } from "../src/afterwards.ts";
import { enginePool } from "../src/migration.ts";

const rows = readAfterwards(new URL("fixtures/afterwards.jsonl", import.meta.url));
const verdicts = rows.map((r) => ({ r, v: replayAfterwards(r) }));
const replayed = verdicts.filter((x) => x.v.swaps > 0);

test("the first swaps in each migrated pool come out as DAMM v2 recorded them, from the DBC accounts alone", () => {
  assert.ok(replayed.length >= 6);
  for (const { r, v } of verdicts) assert.deepEqual(v.mismatches, [], r.pool);
  assert.ok(replayed.reduce((n, x) => n + x.v.swaps, 0) >= 100);
});

test("the recorded swaps cover what happens there: exact-out, fees on either side, split liquidity, liquidity coming and going", () => {
  assert.ok(replayed.some((x) => x.v.exactOut > 0), "no exact-out swap");
  assert.ok(replayed.some((x) => x.r.damm!.collectFeeMode === 0) && replayed.some((x) => x.r.damm!.collectFeeMode === 1), "fee side");
  assert.ok(replayed.some((x) => x.r.damm!.positions > 1), "no pool with two positions");
  assert.ok(replayed.some((x) => x.r.after.some((e) => e.kind === "liquidity" && e.sig !== x.r.sig)), "no later change of liquidity");
});

test("DAMM v2's dynamic fee: the engine reads its settings off the config, and the fees do not match without it", () => {
  const dynamic = replayed.filter((x) => x.r.damm!.dynamicFee);
  assert.ok(dynamic.length >= 2);
  for (const { r } of dynamic) {
    const pool = enginePool(r);
    const theirs = r.after.find((e) => e.kind === "init")!.dynamic!;
    for (const [k, v] of Object.entries(pool.dynamic!)) assert.equal(String(v), theirs[k], `${r.pool} ${k}`);
    // the same swaps with the dynamic fee switched off: some fee has to come out lower than the chain's
    pool.dynamic = null;
    let short = 0;
    for (const e of r.after) {
      if (e.kind === "liquidity" && e.sig !== r.sig) pool.liquidity = e.remove ? pool.liquidity!.sub(new BN(e.delta)) : pool.liquidity!.add(new BN(e.delta));
      if (e.kind !== "swap") continue;
      if (e.mode !== 2) {
        const out = e.buy ? pool.buy(new BN(e.amount), e.ts) : pool.sell(new BN(e.amount), e.ts);
        if (out.fee.lt(new BN(e.fee))) short++;
      }
      // keep to the chain's path, so that each swap starts where the real one did
      pool.sqrtPrice = new BN(e.nextSqrtPrice);
    }
    assert.ok(short > 0, r.pool);
  }
});

test("every kind of DAMM v2 pool a config can migrate into is among them: flat fee, dynamic fee, fee schedule, compounding", () => {
  assert.ok(replayed.some((x) => !x.r.damm!.dynamicFee && !x.r.damm!.scheduled && x.r.damm!.collectFeeMode !== 2), "flat");
  assert.ok(replayed.some((x) => x.r.damm!.dynamicFee), "dynamic fee");
  assert.ok(replayed.some((x) => x.r.damm!.scheduled), "fee schedule");
  assert.ok(replayed.some((x) => x.r.damm!.collectFeeMode === 2), "compounding");
});

test("an event of DAMM v2 the reader does not know stops the replay there, and it says so", () => {
  const { r } = replayed.find((x) => x.v.swaps >= 5)!;
  // just after its third swap
  const at = r.after.map((e, i) => (e.kind === "swap" ? i : -1)).filter((i) => i >= 0)[2] + 1;
  const v = replayAfterwards({ ...r, after: [...r.after.slice(0, at), { kind: "unknown", sig: "x" }, ...r.after.slice(at)] });
  assert.match(v.stopped ?? "", /does not know/);
  assert.equal(v.swaps, 3);
  assert.deepEqual(v.mismatches, []);
});
