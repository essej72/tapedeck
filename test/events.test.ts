// The IDL-only event decoder (used in the browser) must agree with the SDK's Anchor coder on real event bytes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeEvent } from "../src/events.ts";
import { anchorDecode } from "../src/flows/chain.ts";

const events = JSON.parse(readFileSync(new URL("fixtures/events.json", import.meta.url), "utf8")) as { name: string; data: Record<string, unknown>; raw: string }[];

test(`decodeEvent matches the Anchor coder on ${events.length} mainnet events`, () => {
  const kinds = new Set(events.map((e) => e.name));
  assert.ok(events.length >= 50);
  for (const k of ["evtInitializePool", "evtSwap", "evtSwap2", "evtCurveComplete"]) assert.ok(kinds.has(k), `fixture has no ${k}`);
  for (const e of events) {
    const bytes = Buffer.from(e.raw, "base64");
    assert.deepEqual(decodeEvent(bytes), anchorDecode(bytes));
    assert.deepEqual(decodeEvent(bytes), { name: e.name, data: e.data });
  }
});

test("bytes that are not a DBC event decode to nothing", () => {
  assert.equal(decodeEvent(new Uint8Array(40)), null);
  assert.equal(decodeEvent(Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d, 1, 2, 3, 4, 5, 6, 7, 8, 9])), null);
});
