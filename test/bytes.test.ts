// The Anchor-free config reader (used in the browser) must agree with the SDK's own coder on real mainnet configs,
// field for field, and the engine must draw the same conclusions from either.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { walkAway } from "../src/engine/buyout.ts";
import { configFromBytes } from "../src/engine/bytes.ts";
import { decodeConfig } from "../src/engine/codec.ts";
import { CONFIG, off } from "../src/layout.ts";

// The SDK's getPoolConfigsByOwner filters PoolConfig accounts at offset 72. In the IDL that same SDK ships, offset
// 72 is the leftover receiver; the fee claimer, the wallet a partner would call a config's owner, is at 40.
test("in the shipped IDL, fee_claimer is at byte 40 and leftover_receiver at byte 72", () => {
  assert.equal(off(CONFIG, "fee_claimer"), 40);
  assert.equal(off(CONFIG, "leftover_receiver"), 72);
});

const configs = JSON.parse(readFileSync(new URL("fixtures/configs.json", import.meta.url), "utf8")) as { address: string; data: string }[];

const flat = (v: unknown, path: string, out: Map<string, string>): void => {
  if (v === null || v === undefined) return;
  if (typeof v !== "object") out.set(path, String(v));
  else if ((v as { constructor: { name: string } }).constructor.name === "BN") out.set(path, (v as { toString(): string }).toString());
  else if (typeof (v as { toBase58?: unknown }).toBase58 === "function") out.set(path, (v as { toBase58(): string }).toBase58());
  else if (Array.isArray(v)) v.forEach((x, i) => flat(x, `${path}[${i}]`, out));
  else for (const [k, x] of Object.entries(v)) flat(x, path ? `${path}.${k}` : k, out);
};

test(`configFromBytes matches the SDK coder on ${configs.length} mainnet configs`, () => {
  assert.ok(configs.length >= 100);
  for (const c of configs) {
    const data = Buffer.from(c.data, "base64");
    const mine = new Map<string, string>();
    const theirs = new Map<string, string>();
    flat(configFromBytes(data), "", mine);
    flat(decodeConfig(data), "", theirs);
    for (const [k, v] of mine) {
      if (k === "quoteMintAddress" || k === "feeClaimerAddress") continue;
      // read from what the installed SDK still calls padding: program 0.2.2 puts a base-mint transfer fee there
      if (k === "transferFeeBasisPoints" || k === "transferFeeFlag") continue;
      assert.equal(v, theirs.get(k), `${c.address} ${k}`);
    }
    // no config made before 0.2.2 has a transfer fee: a non-zero byte here would turn a real pool away
    assert.equal(mine.get("transferFeeFlag"), "0", c.address);
    assert.equal(mine.get("transferFeeBasisPoints"), "0", c.address);
    assert.equal(mine.get("quoteMintAddress"), theirs.get("quoteMint"), c.address);
    assert.deepEqual(walkAway(configFromBytes(data)), walkAway(decodeConfig(data)), c.address);
  }
});
