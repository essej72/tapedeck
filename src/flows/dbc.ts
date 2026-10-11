// Tapes of real DBC launches, straight from the chain.
//
//   node src/flows/dbc.ts pick [n]     # recent, busy, SOL-quoted pools from the census
//   node src/flows/dbc.ts fetch        # their full histories (keyless RPC)
//   node src/flows/dbc.ts status
//
// A pool goes on the shelf only if the engine replays its whole history without a single mismatch (validate.ts).
// Side A for such a tape is the pool's own config.

import { DatabaseSync } from "node:sqlite";
import bs58 from "bs58";
import { readConfig } from "../census/fields.ts";
import { CENSUS_DB } from "../census/pull.ts";
import type { Tape } from "../engine/replay.ts";
import { buildFixture, replayFixture } from "../validate.ts";
import { openTapes, TX_RPC_URL } from "./chain.ts";
import { fromChain } from "./chaintape.ts";

const SOL = "So11111111111111111111111111111111111111112";
const SCHEMA = `CREATE TABLE IF NOT EXISTS dbc_tape (pool TEXT PRIMARY KEY, design TEXT, state TEXT, swaps INTEGER, mismatches INTEGER, fixture TEXT, fetched REAL)`;

function pick(n: number): void {
  const census = new DatabaseSync(CENSUS_DB, { readOnly: true });
  const db = openTapes();
  db.exec(SCHEMA);
  // SOL-quoted configs that take their fee in SOL, with a threshold worth trading towards.
  const ok = new Map<string, string>();
  for (const r of census.prepare("SELECT address, data FROM configs").iterate()) {
    const f = readConfig(Buffer.from(r.data as Uint8Array));
    if (f.quoteMint === SOL && f.collectFeeMode === 0 && f.migrationQuoteThreshold >= 20e9) ok.set(Buffer.from(r.address as Uint8Array).toString("hex"), `${f.startFeeBps}->${f.endFeeBps}/${f.feeDuration} thr ${f.migrationQuoteThreshold / 1e9}`);
  }
  const now = Date.now() / 1000;
  const slotNow = (census.prepare("SELECT MAX(activation_point) s FROM pools WHERE activation_point < 1e9").get() as { s: number }).s;
  const rows = census
    .prepare("SELECT address, config, activation_point ap, total_trading_quote_fee fee, migration_progress mp, finish_curve_timestamp ft FROM pools WHERE total_trading_quote_fee > 2e8 ORDER BY total_trading_quote_fee DESC")
    .all()
    .filter((p) => {
      const ap = p.ap as number;
      const recent = ap > 1e9 ? now - ap < 18 * 3600 : slotNow - ap < 280_000;
      return recent && ok.has(Buffer.from(p.config as Uint8Array).toString("hex"));
    });
  // Half the busiest that completed, half the busiest that did not.
  const done = rows.filter((p) => (p.mp as number) >= 1).slice(0, Math.ceil(n / 2));
  const open = rows.filter((p) => (p.mp as number) === 0).slice(0, Math.floor(n / 2));
  const put = db.prepare("INSERT OR IGNORE INTO dbc_tape (pool, design, state) VALUES (?, ?, 'todo')");
  let added = 0;
  for (const p of [...done, ...open]) added += Number(put.run(bs58.encode(p.address as Uint8Array), ok.get(Buffer.from(p.config as Uint8Array).toString("hex"))!).changes);
  console.log(`${rows.length} recent busy pools on SOL-quoted configs; ${added} queued (${done.length} completed, ${open.length} still open)`);
}

async function fetchAll(): Promise<void> {
  const db = openTapes();
  db.exec(SCHEMA);
  const done = db.prepare("UPDATE dbc_tape SET state=?, swaps=?, mismatches=?, fixture=?, fetched=? WHERE pool=?");
  for (const job of db.prepare("SELECT pool FROM dbc_tape WHERE state='todo'").all()) {
    const pool = job.pool as string;
    try {
      const f = await buildFixture(pool, { url: TX_RPC_URL, maxTx: 5000 });
      const v = replayFixture(f);
      const state = v.skipped ? "skipped" : v.mismatches.length ? "mismatch" : "ok";
      done.run(state, v.swaps, v.mismatches.length, state === "ok" ? JSON.stringify({ config: f.config, configData: f.configData, complete: f.complete }) : null, Date.now() / 1000, pool);
      console.log(`${pool.slice(0, 8)} ${state} ${v.swaps} swaps ${v.mismatches.length} mismatches ${v.skipped ?? ""}`);
    } catch (e) {
      done.run("error", 0, 0, null, Date.now() / 1000, pool);
      console.log(`${pool.slice(0, 8)} error ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    }
  }
}

export type VerifiedPool = { tape: Tape; config: string; configData: string; swaps: number };

/**
 * Every pool whose whole history replayed without a mismatch, as a tape with its config: the ones recorded for the
 * shelf (dbc_tape) and the ones the conformance run verified, where those are SOL-quoted with the fee in SOL.
 */
export function loadVerified(db: DatabaseSync): VerifiedPool[] {
  const has = (table: string) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(table));
  const txs = db.prepare("SELECT sig, slot, block_time, payer, events FROM chain_tx WHERE pool = ? ORDER BY seq");
  const history = (pool: string) => txs.all(pool).map((t) => ({ sig: t.sig as string, slot: t.slot as number, blockTime: t.block_time as number, payer: t.payer as string, events: JSON.parse(t.events as string) }));
  const out = new Map<string, VerifiedPool>();
  if (has("dbc_tape")) {
    for (const r of db.prepare("SELECT pool, swaps, fixture FROM dbc_tape WHERE state='ok' AND swaps >= 20").all()) {
      const fx = JSON.parse(r.fixture as string) as { config: string; configData: string };
      const tape = fromChain({ pool: r.pool as string, txs: history(r.pool as string) });
      if (tape) out.set(r.pool as string, { tape, config: fx.config, configData: fx.configData, swaps: r.swaps as number });
    }
  }
  if (has("conformance")) {
    const census = new DatabaseSync(CENSUS_DB, { readOnly: true });
    const configOf = census.prepare("SELECT data FROM configs WHERE address = ?");
    for (const r of db.prepare("SELECT pool, swaps FROM conformance WHERE state='done' AND mismatches = 0 AND swaps >= 20").all()) {
      const pool = r.pool as string;
      if (out.has(pool)) continue;
      const h = history(pool);
      const init = h.flatMap((tx) => tx.events).find((e) => e.name === "evtInitializePool" && e.data.pool === pool);
      const row = init && configOf.get(Buffer.from(bs58.decode(init.data.config as string)));
      if (!row) continue;
      const data = Buffer.from(row.data as Uint8Array);
      const f = readConfig(data);
      if (f.quoteMint !== SOL || f.collectFeeMode !== 0) continue;
      const tape = fromChain({ pool, txs: h });
      if (tape) out.set(pool, { tape, config: init.data.config as string, configData: data.toString("base64"), swaps: r.swaps as number });
    }
  }
  return [...out.values()];
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "pick") pick(Number(arg) || 40);
  else if (cmd === "fetch") await fetchAll();
  else if (cmd === "status") console.log(openTapes().prepare("SELECT state, COUNT(*) n, SUM(swaps) swaps FROM dbc_tape GROUP BY state").all());
  else console.log("usage: node src/flows/dbc.ts pick [n] | fetch | status");
}
