// Freeze a slice of mainnet into test/fixtures so the test suite runs offline and proves the same things the
// live runs do.   node scripts/make-fixtures.ts
//
//   configs.json        PoolConfig accounts of the most used designs
//   pools/<pool>.json   whole on-chain histories of pools of different config kinds, with their accounts
//   pumpfun/<mint>.json raw pump.fun trade tapes

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import bs58 from "bs58";
import { CENSUS_DB } from "../src/census/pull.ts";
import { openTapes, TX_RPC_URL } from "../src/flows/chain.ts";
import { buildFixture, replayFixture } from "../src/validate.ts";

const out = new URL("../test/fixtures/", import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(new URL("pools/", out), { recursive: true });
mkdirSync(new URL("pumpfun/", out), { recursive: true });

// 1. configs: one account from each of the most used designs
const census = new DatabaseSync(CENSUS_DB, { readOnly: true });
const designs = (JSON.parse(readFileSync(new URL("../web/data/census_all.json", import.meta.url), "utf8")) as { designs: { example: string; pools: number }[] }).designs;
const configs: { address: string; data: string }[] = [];
for (const d of designs.slice(0, 160)) {
  const r = census.prepare("SELECT data FROM configs WHERE address = ?").get(Buffer.from(bs58.decode(d.example)));
  if (r) configs.push({ address: d.example, data: Buffer.from(r.data as Uint8Array).toString("base64") });
}
writeFileSync(new URL("configs.json", out), JSON.stringify(configs));
console.log(`${configs.length} configs`);

// 2. pools: one per kind of config, mid-sized, already verified by the conformance and tape runs
const db = openTapes();
const picked = new Map<string, string>();
for (const r of db.prepare("SELECT pool, kind, swaps FROM conformance WHERE state='done' AND mismatches=0 AND swaps BETWEEN 8 AND 500 ORDER BY swaps DESC").all()) {
  if (!picked.has(r.kind as string)) picked.set(r.kind as string, r.pool as string);
}
const pools = [...picked.values()].slice(0, 14);
for (const r of db.prepare("SELECT pool FROM dbc_tape WHERE state='ok' AND swaps BETWEEN 60 AND 400 ORDER BY swaps LIMIT 2").all()) pools.push(r.pool as string);
let swaps = 0;
for (const pool of pools) {
  const f = await buildFixture(pool, { url: TX_RPC_URL });
  const v = replayFixture(f);
  if (v.skipped || v.mismatches.length) {
    console.log(`  skip ${pool}: ${v.skipped ?? v.mismatches[0]}`);
    continue;
  }
  swaps += v.swaps;
  writeFileSync(new URL(`pools/${pool}.json`, out), JSON.stringify(f));
}
console.log(`${pools.length} pools, ${swaps} swaps`);

// 3. pump.fun tapes: the smallest tape of each kind on the shelf (so each is known to pass the fit check)
const shelf = (JSON.parse(readFileSync(new URL("../web/data/tapes.json", import.meta.url), "utf8")) as { tapes: { id: string; kind: string; source: string; orders: unknown[] }[] }).tapes.filter((t) => t.source === "pump.fun");
for (const kind of ["one-party buyout", "contested graduation", "died on the curve"]) {
  const t = shelf.filter((x) => x.kind === kind && x.orders.length >= 60).sort((a, b) => a.orders.length - b.orders.length)[0];
  if (!t) {
    console.log(`  no tape yet for: ${kind}`);
    continue;
  }
  const meta = db.prepare("SELECT mint, kind, creator, complete, graduated, mayhem FROM pf_tape WHERE mint = ?").get(t.id)!;
  const trades = db.prepare("SELECT slot, seq, wallet, buy, amm, lamports, tokens FROM pf_trades WHERE mint = ?").all(t.id);
  writeFileSync(new URL(`pumpfun/${t.id}.json`, out), JSON.stringify({ kind, meta, trades }));
  console.log(`  ${kind}: ${t.id} (${trades.length} trades)`);
}
