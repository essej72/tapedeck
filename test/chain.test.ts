// The engine is the chain: every swap of every recorded pool, replayed from the pool's own events, has to match
// what the program recorded, to the lamport. One pool per kind of config (fee mode, fee token, activation, ...).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { replayFixture, type Fixture } from "../src/validate.ts";

const dir = new URL("fixtures/pools/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

test("there are pool histories to replay", () => assert.ok(files.length >= 8, `only ${files.length} fixtures`));

for (const file of files) {
  test(`pool ${file.slice(0, 8)} replays against its own on-chain history`, () => {
    const fixture = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Fixture;
    const verdict = replayFixture(fixture);
    assert.equal(verdict.skipped, undefined);
    assert.ok(verdict.swaps > 0);
    assert.deepEqual(verdict.mismatches, []);
  });
}
