// What the deck flies is what the chain would store. Each fixture is a design from the deck's form together with the
// PoolConfig account the live program wrote for it in a simulated create_config (src/dryrun.ts). The config the deck
// derives from the design has to equal the stored account, field for field.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { differences } from "../src/deploy.ts";
import { walkAway } from "../src/engine/buyout.ts";
import { configFromBytes } from "../src/engine/bytes.ts";
import { design } from "../src/engine/design.ts";
import { BUILT_IN, specOf, type Custom } from "../src/engine/presets.ts";

const designs = JSON.parse(readFileSync(new URL("fixtures/designs.json", import.meta.url), "utf8")) as { name: string; custom: Custom; data: string }[];
const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, "base64"));

test("there are designs the program has answered, the built-in ones among them", () => {
  assert.ok(designs.length >= 12, `only ${designs.length}`);
  for (const name of Object.keys(BUILT_IN)) assert.ok(designs.some((d) => d.name === name), `${name} is missing`);
  assert.ok(new Set(designs.map((d) => d.custom.shape)).size === 3, "all three curve shapes");
});

test("the program stores every design exactly as the deck derives it", () => {
  for (const d of designs) assert.deepEqual(differences(specOf(d.custom), bytes(d.data)), [], d.name);
});

test("the cost of faking a graduation is the same from the design and from the stored account", () => {
  for (const d of designs) assert.deepEqual(walkAway(design(specOf(d.custom))), walkAway(configFromBytes(bytes(d.data))), d.name);
});
