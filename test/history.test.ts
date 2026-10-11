// What a replay does with histories that are not straightforward: swaps recorded only as the older event, pools
// traded under older builds of the program, and histories with a hole in them. The rule in all three: never report
// agreement that was not checked, and never hide a disagreement.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { replayFixture, type Fixture } from "../src/validate.ts";

const load = (path: string) => JSON.parse(readFileSync(new URL(`fixtures/${path}.json`, import.meta.url), "utf8")) as Fixture;

test("swaps from before August 2025, recorded only as EvtSwap, are replayed and match", () => {
  const v = replayFixture(load("pools/J5fhQreaKwHvKAz6tsdvEc4WEygPpeCGNruFK1NmVsd6"));
  assert.equal(v.swaps, 132);
  assert.equal(v.older, 119);
  assert.deepEqual(v.mismatches, []);
});

test("a curve completed by an exact-in buy that ran past the migration price is reported, not skipped", () => {
  // October 2025, before program release 0.1.7 stopped exact-in buys at the migration price.
  const v = replayFixture(load("old-program/DcbTZTZe1bkcEqbPykWX2x2DzUbddC9wzFBY46NuUtFa"));
  assert.equal(v.swaps, 0);
  assert.equal(v.mismatches.length, 1);
  assert.match(v.mismatches[0], /the engine refuses it \(Insufficient Liquidity\); the chain recorded it/);
});

test("a swap made while the maximum fee was 50% disagrees with today's math on the fee", () => {
  // May 2025, before program release 0.1.3 raised the maximum fee to 99%: base fee plus dynamic fee was capped.
  const v = replayFixture(load("old-program/4jwc1YPpLjzPUUFYPMsFzJK65Z2iUP6UkLsx8kRUvhV3"));
  assert.ok(v.mismatches.some((m) => /swap 2 .* tradingFee: engine 80003464 chain 80000000/.test(m)), v.mismatches.join("\n"));
});

test("a history with a hole in it is not replayed at all", () => {
  const whole = load("pools/J5fhQreaKwHvKAz6tsdvEc4WEygPpeCGNruFK1NmVsd6");
  const v = replayFixture({ ...whole, holes: 1 });
  assert.equal(v.swaps, 0);
  assert.match(v.skipped ?? "", /holes/);
});
