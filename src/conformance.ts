// Conformance run: is the engine the chain, across every way a DBC config can charge a fee?
//
//   node src/conformance.ts pick [perKind]     # choose pools spread over fee modes, quote tokens and activation types
//   node src/conformance.ts busy [n]           # add the n busiest pools of the last day, whatever their config
//   node src/conformance.ts run [kind]         # fetch each pool's history, replay it, record the verdict
//                                              # (optionally only kinds containing the given text)
//   node src/conformance.ts report             # totals by kind of config; writes web/data/conformance.json
//   node src/conformance.ts export <file>      # the verified histories as one portable corpus (JSON lines, gzipped)
//   node src/conformance.ts rerun [--corpus <file>] [--math <module.mjs>]
//                                              # replay every history again, offline: from the local store or from
//                                              # a corpus file, with the installed SDK's math or another build's.
//                                              # This is how a release candidate is checked against mainnet history.
//
// A "kind" is the combination of settings that changes the swap path: base fee mode, dynamic fee, where the fee is
// collected, slot or timestamp activation, the first-swap minimum fee, quote token.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import bs58 from "bs58";
import { kindOf } from "./census/fields.ts";
import { CENSUS_DB } from "./census/pull.ts";
import { SDK_MATH, type QuoteMath } from "./engine/pool.ts";
import { loadPool, openTapes, TX_RPC_URL } from "./flows/chain.ts";
import type { ChainTx } from "./flows/history.ts";
import { RPC_URL } from "./rpc.ts";
import { buildFixture, replayFixture } from "./validate.ts";

const SCHEMA = `CREATE TABLE IF NOT EXISTS conformance (pool TEXT PRIMARY KEY, kind TEXT, recent INTEGER, state TEXT, swaps INTEGER, mismatches INTEGER,
  final_checked INTEGER, note TEXT, checked REAL)`;

function pick(perKind: number): void {
  const census = new DatabaseSync(CENSUS_DB, { readOnly: true });
  const db = openTapes();
  db.exec(SCHEMA);
  const kinds = new Map<string, string>();
  for (const r of census.prepare("SELECT address, data FROM configs").iterate()) kinds.set(Buffer.from(r.address as Uint8Array).toString("hex"), kindOf(Buffer.from(r.data as Uint8Array)));
  const now = Date.now() / 1000;
  const slotNow = (census.prepare("SELECT MAX(activation_point) s FROM pools WHERE activation_point < 1e9").get() as { s: number }).s;
  // Pools that traded for real: fees collected, and not finished in the launch second.
  const chosen = new Map<string, { pool: string; recent: number; weight: number }[]>();
  for (const p of census.prepare("SELECT address, config, activation_point ap, total_trading_quote_fee qf, total_trading_base_fee bf, migration_progress mp, finish_curve_timestamp ft FROM pools WHERE total_trading_quote_fee > 0 OR total_trading_base_fee > 0").iterate()) {
    const kind = kinds.get(Buffer.from(p.config as Uint8Array).toString("hex"));
    if (!kind) continue;
    const ap = p.ap as number;
    const recent = ap > 1e9 ? (now - ap < 20 * 3600 ? 1 : 0) : slotNow - ap < 300_000 ? 1 : 0;
    const list = chosen.get(kind) ?? [];
    chosen.set(kind, list);
    // Reservoir: recent pools first (a keyless endpoint with short history can serve them), random within that.
    const weight = recent * 10 + Math.random();
    if (list.length < perKind) list.push({ pool: bs58.encode(p.address as Uint8Array), recent, weight });
    else {
      let lo = 0;
      for (let i = 1; i < list.length; i++) if (list[i].weight < list[lo].weight) lo = i;
      if (weight > list[lo].weight) list[lo] = { pool: bs58.encode(p.address as Uint8Array), recent, weight };
    }
  }
  const put = db.prepare("INSERT OR IGNORE INTO conformance (pool, kind, recent, state) VALUES (?, ?, ?, 'todo')");
  let n = 0;
  for (const [kind, list] of chosen) for (const c of list) n += Number(put.run(c.pool, kind, c.recent).changes);
  console.log(`${chosen.size} kinds of config, ${n} pools added`);
}

/** The busiest pools of the last day: where most of the swaps are. */
function busy(n: number): void {
  const census = new DatabaseSync(CENSUS_DB, { readOnly: true });
  const db = openTapes();
  db.exec(SCHEMA);
  const kinds = new Map<string, string>();
  for (const r of census.prepare("SELECT address, data FROM configs").iterate()) kinds.set(Buffer.from(r.address as Uint8Array).toString("hex"), kindOf(Buffer.from(r.data as Uint8Array)));
  const now = Date.now() / 1000;
  const slotNow = (census.prepare("SELECT MAX(activation_point) s FROM pools WHERE activation_point < 1e9").get() as { s: number }).s;
  const put = db.prepare("INSERT OR IGNORE INTO conformance (pool, kind, recent, state) VALUES (?, ?, 1, 'todo')");
  let added = 0;
  for (const p of census.prepare("SELECT address, config, activation_point ap FROM pools WHERE total_trading_quote_fee + total_trading_base_fee > 0 ORDER BY total_trading_quote_fee DESC").iterate()) {
    const ap = p.ap as number;
    if (!(ap > 1e9 ? now - ap < 18 * 3600 : slotNow - ap < 280_000)) continue;
    const kind = kinds.get(Buffer.from(p.config as Uint8Array).toString("hex"));
    if (!kind) continue;
    added += Number(put.run(bs58.encode(p.address as Uint8Array), kind).changes);
    if (added >= n) break;
  }
  console.log(`${added} busy recent pools added`);
}

async function run(only = ""): Promise<void> {
  const db = openTapes();
  db.exec(SCHEMA);
  if (!db.prepare("PRAGMA table_info(conformance)").all().some((c) => c.name === "older")) db.exec("ALTER TABLE conformance ADD COLUMN older INTEGER DEFAULT 0");
  const done = db.prepare("UPDATE conformance SET state=?, swaps=?, mismatches=?, final_checked=?, note=?, checked=?, older=? WHERE pool=?");
  for (;;) {
    // recent pools first (the fast endpoint has them); within that, one pool per kind before a second of any
    const job = db.prepare("SELECT c.pool, c.kind, c.recent FROM conformance c WHERE c.state='todo' AND c.kind LIKE ? ORDER BY c.recent DESC, (SELECT COUNT(*) FROM conformance d WHERE d.kind = c.kind AND d.state <> 'todo') LIMIT 1").get(`%${only}%`);
    if (!job) break;
    const pool = job.pool as string;
    let state = "done";
    let v = { swaps: 0, older: 0 as number | undefined, mismatches: [] as string[], finalChecked: false, skipped: undefined as string | undefined };
    try {
      // A recent pool's whole history is on the fast endpoint; an old one needs the archive.
      // The archive endpoint allows about 40 requests per 10 s per method; stay under it.
      const archive = { url: RPC_URL, maxTx: 3000, gapMs: 320 };
      let f = await buildFixture(pool, job.recent ? { url: TX_RPC_URL, maxTx: 3000 } : archive);
      v = { ...v, ...replayFixture(f) };
      if (v.skipped && job.recent) {
        f = await buildFixture(pool, { ...archive, refetch: true });
        v = { ...v, skipped: undefined, ...replayFixture(f) };
      }
      if (v.skipped) state = "skipped";
    } catch (e) {
      state = "error";
      v.skipped = e instanceof Error ? e.message.slice(0, 200) : String(e);
    }
    done.run(state, v.swaps, v.mismatches.length, v.finalChecked ? 1 : 0, v.skipped ?? v.mismatches.slice(0, 3).join(" | "), Date.now() / 1000, v.older ?? 0, pool);
    console.log(`${new Date().toISOString().slice(11, 19)} ${pool.slice(0, 8)} [${job.kind}] ${state} ${v.swaps} swaps ${v.mismatches.length} mismatches ${v.skipped ?? ""}`);
  }
}

function report(): void {
  const db = openTapes();
  // Pools verified while recording tapes count too (flows/dbc.ts); a pool is counted once.
  const rows = new Map<string, { kind: string; pools: number; swaps: number; mismatches: number; bad: number; finals: number }>();
  const add = (kind: string, swaps: number, mismatches: number, final: number) => {
    const r = rows.get(kind) ?? { kind, pools: 0, swaps: 0, mismatches: 0, bad: 0, finals: 0 };
    rows.set(kind, { kind, pools: r.pools + 1, swaps: r.swaps + swaps, mismatches: r.mismatches + mismatches, bad: r.bad + (mismatches > 0 ? 1 : 0), finals: r.finals + final });
  };
  const seen = new Set<string>();
  let older = 0;
  // A pool whose first recorded swap the engine refuses has no replayed swaps and still counts: it disagrees.
  const disagree: { pool: string; kind: string; swaps: number; first: string }[] = [];
  for (const r of db.prepare("SELECT pool, kind, swaps, mismatches, final_checked, older, note FROM conformance WHERE state='done' AND (swaps > 0 OR mismatches > 0)").all()) {
    seen.add(r.pool as string);
    if ((r.mismatches as number) === 0) older += Number(r.older ?? 0);
    add(r.kind as string, r.swaps as number, r.mismatches as number, r.final_checked as number);
    if ((r.mismatches as number) > 0) disagree.push({ pool: r.pool as string, kind: r.kind as string, swaps: r.swaps as number, first: String(r.note).split(" | ")[0] });
  }
  if (db.prepare("SELECT name FROM sqlite_master WHERE name='dbc_tape'").get()) {
    for (const r of db.prepare("SELECT pool, swaps, mismatches, fixture FROM dbc_tape WHERE state IN ('ok','mismatch') AND swaps > 0").all()) {
      if (seen.has(r.pool as string)) continue;
      const fixture = r.fixture ? (JSON.parse(r.fixture as string) as { configData: string }) : null;
      add(fixture ? kindOf(Buffer.from(fixture.configData, "base64")) : "unknown", r.swaps as number, r.mismatches as number, 0);
    }
  }
  const kinds = [...rows.values()].sort((a, b) => b.swaps - a.swaps);
  const sum = kinds.reduce((t, r) => ({ pools: t.pools + r.pools, swaps: t.swaps + r.swaps, mismatches: t.mismatches + r.mismatches, finals: t.finals + r.finals }), { pools: 0, swaps: 0, mismatches: 0, finals: 0 });
  // `pools` and `swaps` are the ones that agree on every swap; the pools that do not are listed beside them.
  const total = { pools: sum.pools - disagree.length, swaps: sum.swaps - disagree.reduce((n, d) => n + d.swaps, 0), older, mismatches: sum.mismatches, finals: sum.finals, disagreeing: disagree.length };
  for (const r of kinds) console.log(`${String(r.pools).padStart(4)} pools ${String(r.swaps).padStart(8)} swaps ${String(r.mismatches).padStart(5)} mismatches (${r.bad} pools)  ${r.kind}`);
  console.log(total, db.prepare("SELECT state, COUNT(*) n FROM conformance GROUP BY state").all());
  for (const d of disagree) console.log(`  disagrees: ${d.pool} [${d.kind}] ${d.first}`);
  mkdirSync(new URL("../web/data/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../web/data/conformance.json", import.meta.url), JSON.stringify({ generatedAt: new Date().toISOString(), total, kinds, disagree }));
}

type CorpusPool = { pool: string; kind: string; config: string; configData: string; txs: ChainTx[] };

// The events a replay reads. Since August 2025 EvtSwap repeats EvtSwap2 and is left out of the corpus; before that
// it is the only record of a swap and is kept.
const REPLAYED = new Set(["evtInitializePool", "evtSwap", "evtSwap2", "evtCurveComplete"]);
const forCorpus = (pool: string, events: ChainTx["events"]): ChainTx["events"] => {
  const mine = events.filter((e) => REPLAYED.has(e.name) && e.data.pool === pool);
  return mine.filter((e, k) => !(e.name === "evtSwap" && mine[k + 1]?.name === "evtSwap2")).map(({ name, data }) => ({ name, data }));
};

/** Every verified pool in the local store, with its config's bytes. */
function* storedPools(): Generator<CorpusPool> {
  const db = openTapes();
  const census = new DatabaseSync(CENSUS_DB, { readOnly: true });
  const configOf = census.prepare("SELECT data FROM configs WHERE address = ?");
  const pools = new Map<string, string>();
  for (const r of db.prepare("SELECT pool, kind FROM conformance WHERE state='done' AND swaps > 0 AND mismatches = 0").all()) pools.set(r.pool as string, r.kind as string);
  if (db.prepare("SELECT name FROM sqlite_master WHERE name='dbc_tape'").get()) {
    for (const r of db.prepare("SELECT pool, fixture FROM dbc_tape WHERE state='ok'").all()) {
      if (!pools.has(r.pool as string)) pools.set(r.pool as string, kindOf(Buffer.from((JSON.parse(r.fixture as string) as { configData: string }).configData, "base64")));
    }
  }
  for (const [pool, kind] of pools) {
    const txs = loadPool(db, pool).map((tx) => ({ ...tx, events: forCorpus(pool, tx.events) })).filter((tx) => tx.events.length);
    const init = txs.flatMap((tx) => tx.events).find((e) => e.name === "evtInitializePool" && e.data.pool === pool);
    const row = init && configOf.get(Buffer.from(bs58.decode(init.data.config as string)));
    if (init && row) yield { pool, kind, config: init.data.config as string, configData: Buffer.from(row.data as Uint8Array).toString("base64"), txs };
  }
}

function exportCorpus(file: string): void {
  const lines: string[] = [];
  // What the corpus covers, counted from the events themselves.
  const c = { swaps: 0, older: 0, buys: 0, sells: 0, exactIn: 0, partialFill: 0, exactOut: 0, cutShort: 0, referral: 0, inCreateTx: 0, completions: 0 };
  for (const p of storedPools()) {
    for (const tx of p.txs) {
      const created = tx.events.some((e) => e.name === "evtInitializePool");
      for (const e of tx.events) {
        if (e.name === "evtCurveComplete") c.completions++;
        if (e.name !== "evtSwap" && e.name !== "evtSwap2") continue;
        const d = e.data as { tradeDirection: number; hasReferral: boolean; swapParameters?: { swapMode: number }; swapResult: { amountLeft?: string } };
        c.swaps++;
        if (e.name === "evtSwap") c.older++;
        if (d.tradeDirection === 1) c.buys++;
        else c.sells++;
        const mode = d.swapParameters?.swapMode ?? 0;
        if (mode === 0) c.exactIn++;
        else if (mode === 1) c.partialFill++;
        else c.exactOut++;
        if (mode === 1 && d.swapResult.amountLeft !== "0") c.cutShort++;
        if (d.hasReferral) c.referral++;
        if (created) c.inCreateTx++;
      }
    }
    lines.push(JSON.stringify(p));
  }
  const packed = gzipSync(lines.join("\n"), { level: 9 });
  writeFileSync(file, packed);
  console.log(`${lines.length} pools, ${c.swaps} swaps, ${(packed.length / 1e6).toFixed(1)} MB -> ${file}`);
  console.log(JSON.stringify({ pools: lines.length, megabytes: Number((packed.length / 1e6).toFixed(1)), ...c }));
  writeFileSync(new URL("../web/data/corpus.json", import.meta.url), JSON.stringify({ generatedAt: new Date().toISOString(), pools: lines.length, megabytes: Number((packed.length / 1e6).toFixed(1)), ...c }));
}

/**
 * Replay every verified history again without touching the network. `mathPath` is an ES module exporting
 * getFeeMode and the three getSwapResultFrom* functions (another build of the SDK's math); `corpusPath` is a file
 * written by `export`, used instead of the local store.
 */
async function rerun(opts: { mathPath?: string; corpusPath?: string }): Promise<void> {
  let math: QuoteMath = SDK_MATH;
  if (opts.mathPath) {
    const mod = (await import(pathToFileURL(resolve(opts.mathPath)).href)) as Record<string, unknown>;
    const names = ["getFeeMode", "getSwapResultFromExactInput", "getSwapResultFromPartialInput", "getSwapResultFromExactOutput"] as const;
    for (const n of names) if (typeof mod[n] !== "function") throw new Error(`${opts.mathPath} does not export ${n}`);
    math = Object.fromEntries(names.map((n) => [n, mod[n]])) as unknown as QuoteMath;
  }
  const pools: Iterable<CorpusPool> = opts.corpusPath
    ? gunzipSync(readFileSync(opts.corpusPath)).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as CorpusPool)
    : storedPools();
  const total = { pools: 0, swaps: 0, mismatches: 0, poolsWithMismatch: 0 };
  const byKind = new Map<string, { pools: number; swaps: number; mismatches: number; first: string }>();
  const t0 = Date.now();
  for (const p of pools) {
    let v;
    try {
      v = replayFixture({ pool: p.pool, config: p.config, configData: p.configData, txs: p.txs, complete: true }, math);
    } catch (e) {
      v = { swaps: 0, mismatches: [`threw: ${e instanceof Error ? e.message : e}`], finalChecked: false };
    }
    total.pools++;
    total.swaps += v.swaps;
    total.mismatches += v.mismatches.length;
    if (v.mismatches.length) total.poolsWithMismatch++;
    const k = byKind.get(p.kind) ?? { pools: 0, swaps: 0, mismatches: 0, first: "" };
    byKind.set(p.kind, { pools: k.pools + 1, swaps: k.swaps + v.swaps, mismatches: k.mismatches + v.mismatches.length, first: k.first || (v.mismatches[0] ? `${p.pool.slice(0, 8)} ${v.mismatches[0]}` : "") });
  }
  console.log(`math: ${opts.mathPath ?? "the installed SDK"}   histories: ${opts.corpusPath ?? "the local store"}   ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`${total.pools} pools, ${total.swaps} swaps replayed, ${total.mismatches} mismatches in ${total.poolsWithMismatch} pools, ${byKind.size} kinds of config`);
  for (const [kind, k] of [...byKind].sort((a, b) => b[1].mismatches - a[1].mismatches)) {
    if (k.mismatches) console.log(`  ${String(k.pools).padStart(4)} pools ${String(k.swaps).padStart(7)} swaps ${String(k.mismatches).padStart(5)} mismatches  ${kind}\n       first: ${k.first}`);
  }
  if (total.mismatches) process.exitCode = 1;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "pick") pick(Number(arg) || 6);
else if (cmd === "busy") busy(Number(arg) || 200);
else if (cmd === "run") await run(arg);
else if (cmd === "report") report();
else if (cmd === "export" && arg) exportCorpus(arg);
else if (cmd === "rerun") {
  const args = process.argv.slice(3);
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  await rerun({ mathPath: flag("--math"), corpusPath: flag("--corpus") });
} else console.log("usage: node src/conformance.ts pick [perKind] | busy [n] | run [kind] | report | export <file> | rerun [--corpus <file>] [--math <module.mjs>]");
