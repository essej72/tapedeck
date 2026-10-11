// Swaps nobody has made on mainnet, checked against the program itself: each fixture is one transaction a public
// node simulated against the live program (src/probe.ts), with the pool account before and after and the program's
// own events. The engine has to give the same answer from the account before. Exact-out is the path this covers.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { SDK_MATH, type QuoteMath } from "../src/engine/pool.ts";
import { checkProbe, type Probe } from "../src/probe.ts";

const probes = readFileSync(new URL("fixtures/probes.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Probe);
const modeOf = (e: Record<string, unknown>) => (e.swapParameters as { swapMode: number }).swapMode;

test("there are simulated swaps to check, most of them exact-out", () => {
  const swaps = probes.flatMap((p) => p.events);
  assert.ok(probes.length >= 30, `only ${probes.length} simulations`);
  assert.ok(swaps.filter((e) => modeOf(e) === SwapMode.ExactOut).length >= 40);
  assert.ok(new Set(probes.map((p) => p.kind)).size >= 8);
});

test("the engine agrees with the program on every simulated swap and on the account it leaves", () => {
  for (const p of probes) assert.deepEqual(checkProbe(p), [], `${p.pool} ${p.label}`);
});

test("the program refuses one token more than the curve holds, and so does the engine", () => {
  const over = probes.filter((p) => p.refusedAt !== null);
  assert.ok(over.length > 0);
  for (const p of over) assert.ok(["InsufficientLiquidity", "AmountLeftIsNotZero"].includes(String(p.error)), `${p.pool} ${p.label}: ${p.error}`);
});

test("an exact-out quote that is one lamport off is caught", () => {
  const off: QuoteMath = {
    ...SDK_MATH,
    getSwapResultFromExactOutput: (...args) => {
      const r = SDK_MATH.getSwapResultFromExactOutput(...args);
      return { ...r, includedFeeInputAmount: r.includedFeeInputAmount.addn(1) };
    },
  };
  const withExactOut = probes.filter((p) => p.events.some((e) => modeOf(e) === SwapMode.ExactOut));
  for (const p of withExactOut) assert.notDeepEqual(checkProbe(p, off), [], `${p.pool} ${p.label}`);
});
