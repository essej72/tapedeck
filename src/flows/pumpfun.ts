// Wallet-level order tapes of real pump.fun launches, from pump.fun's public trade feed.
//
// Why pump.fun: its curve has one flat fee and no launch protection, so its tapes show what unprotected launch flow
// looks like. That is the flow a new DBC launchpad's config will meet, and the natural baseline to replay through
// configs that do protect the launch.
//
//   node src/flows/pumpfun.ts enqueue-recorder <stream.db>   # launches and graduations seen by a local recorder
//   node src/flows/pumpfun.ts enqueue-listing [pages]        # recent graduates from pump.fun's own listing
//   node src/flows/pumpfun.ts run                            # work the queue until stopped (about 18 requests/min)
//   node src/flows/pumpfun.ts status
//
// Reads only. The feed pages newest-first, 100 trades a page, so a graduate is fetched as soon as it graduates,
// before trading on the AMM piles up in front of its curve phase.

import { DatabaseSync } from "node:sqlite";
import { openTapes } from "./chain.ts";

const SWAP_API = "https://swap-api.pump.fun";
const FRONT_API = "https://frontend-api-v3.pump.fun";
const HEADERS = { "user-agent": "Mozilla/5.0", accept: "application/json", origin: "https://pump.fun", referer: "https://pump.fun/" };
const GAP_MS = 3300; // measured: the trade feed blocks for 60 s above about 20 requests a minute
const MAX_PAGES = 45;
const SETTLE_S = 45 * 60; // a launch that did not graduate is read once it is this old

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pf_queue (mint TEXT PRIMARY KEY, kind TEXT, launch_ts REAL, creator TEXT, mayhem INTEGER, ready_at REAL);
CREATE TABLE IF NOT EXISTS pf_tape (mint TEXT PRIMARY KEY, kind TEXT, launch_ts REAL, creator TEXT, mayhem INTEGER,
  n INTEGER, n_curve INTEGER, complete INTEGER, graduated INTEGER, pages INTEGER, fetched REAL);
CREATE TABLE IF NOT EXISTS pf_trades (mint TEXT, slot INTEGER, seq INTEGER, ts INTEGER, wallet TEXT, buy INTEGER, amm INTEGER,
  lamports INTEGER, tokens INTEGER, PRIMARY KEY (mint, slot, seq)) WITHOUT ROWID;
`;

let nextAt = 0;
async function get(url: string, gapMs: number): Promise<any | null> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = nextAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextAt = Date.now() + gapMs;
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
      if (res.status === 429) {
        nextAt = Date.now() + (Number(res.headers.get("retry-after")) || 60) * 1000 + 2000;
        continue;
      }
      if (res.status === 400 || res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch {
      nextAt = Date.now() + 3000 * (attempt + 1);
    }
  }
  return null;
}

type Trade = { slot: number; seq: number; ts: number; wallet: string; buy: number; amm: number; lamports: number; tokens: number };

async function fetchTape(mint: string): Promise<{ trades: Trade[]; pages: number; complete: boolean } | null> {
  const trades: Trade[] = [];
  let cursor = "0";
  for (let pages = 1; ; pages++) {
    const body = await get(`${SWAP_API}/v2/coins/${mint}/trades?limit=100&cursor=${cursor}&minSolAmount=0`, GAP_MS);
    if (!body) return pages === 1 ? null : { trades, pages, complete: false };
    for (const t of body.trades ?? []) {
      const sid = String(t.slotIndexId);
      trades.push({
        slot: Number(sid.slice(0, 12)),
        seq: Number(sid.slice(12)),
        ts: Math.floor(Date.parse(t.timestamp) / 1000),
        wallet: t.userAddress,
        buy: t.type === "buy" ? 1 : 0,
        amm: t.program === "pump_amm" ? 1 : 0,
        lamports: Math.round(Number(t.amountSol ?? 0) * 1e9),
        tokens: Math.round(Number(t.baseAmount ?? 0) * 1e6),
      });
    }
    if (!body.trades?.length || !body.pagination?.hasMore) return { trades, pages, complete: true };
    if (pages >= MAX_PAGES) return { trades, pages, complete: false };
    cursor = body.pagination.nextCursor;
  }
}

function enqueueRecorder(db: DatabaseSync, path: string): void {
  const src = new DatabaseSync(path, { readOnly: true });
  const put = db.prepare("INSERT OR IGNORE INTO pf_queue VALUES (?,?,?,?,?,?)");
  const promote = db.prepare("UPDATE pf_queue SET kind='graduate', ready_at=? WHERE mint=? AND kind='launch'");
  const done = new Set(db.prepare("SELECT mint FROM pf_tape").all().map((r) => r.mint as string));
  const launches = new Map(src.prepare("SELECT mint, ts, creator, mayhem FROM launches WHERE pool='pump'").all().map((r) => [r.mint as string, r]));
  let added = 0;
  db.exec("BEGIN");
  for (const m of src.prepare("SELECT mint, ts FROM migrations").all()) {
    const l = launches.get(m.mint as string);
    if (done.has(m.mint as string)) continue;
    added += Number(put.run(m.mint, "graduate", l?.ts ?? null, l?.creator ?? null, l?.mayhem ?? null, m.ts).changes);
    promote.run(m.ts, m.mint);
  }
  for (const [mint, l] of launches) {
    if (done.has(mint)) continue;
    added += Number(put.run(mint, "launch", l.ts, l.creator, l.mayhem, (l.ts as number) + SETTLE_S).changes);
  }
  db.exec("COMMIT");
  console.log(`queued ${added} new mints from the recorder`);
}

async function enqueueListing(db: DatabaseSync, pages: number): Promise<void> {
  const put = db.prepare("INSERT OR IGNORE INTO pf_queue VALUES (?,?,?,?,?,?)");
  let added = 0;
  for (let p = 0; p < pages; p++) {
    const rows = await get(`${FRONT_API}/coins?complete=true&sort=created_timestamp&order=DESC&offset=${p * 50}&limit=50&includeNsfw=true`, 1100);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const c of rows) added += Number(put.run(c.mint, "graduate", c.created_timestamp / 1000, c.creator, c.is_mayhem_mode ? 1 : 0, Date.now() / 1000).changes);
  }
  console.log(`queued ${added} graduates from the listing`);
}

const FRESH_S = 12 * 60;

/**
 * Next mint to read. Turns alternate: a settled launch (one page, usually), then a graduate. A graduate is only
 * worth reading while it is fresh: the feed pages newest-first, so once AMM trading has piled up in front of the
 * curve phase the launch itself is out of reach within the page budget.
 */
let turn = 0;
function nextJob(db: DatabaseSync): Record<string, any> | undefined {
  const now = Date.now() / 1000;
  const graduate = () => db.prepare("SELECT * FROM pf_queue WHERE kind='graduate' AND COALESCE(mayhem,0)=0 AND ready_at >= ? ORDER BY ready_at DESC LIMIT 1").get(now - FRESH_S);
  const launch = () => db.prepare("SELECT * FROM pf_queue WHERE kind='launch' AND COALESCE(mayhem,0)=0 AND ready_at <= ? ORDER BY ready_at DESC LIMIT 1").get(now);
  return ++turn % 2 === 0 ? (graduate() ?? launch()) : (launch() ?? graduate());
}

async function run(db: DatabaseSync, recorder?: string): Promise<void> {
  const insert = db.prepare("INSERT OR REPLACE INTO pf_trades VALUES (?,?,?,?,?,?,?,?,?)");
  const finish = db.prepare("INSERT OR REPLACE INTO pf_tape VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const drop = db.prepare("DELETE FROM pf_queue WHERE mint = ?");
  let lastRefill = 0;
  let done = 0;
  for (;;) {
    if (recorder && Date.now() - lastRefill > 120_000) {
      enqueueRecorder(db, recorder);
      lastRefill = Date.now();
    }
    const job = nextJob(db);
    if (!job) {
      await sleep(20_000);
      continue;
    }
    const tape = await fetchTape(job.mint);
    db.exec("BEGIN");
    if (tape) {
      for (const t of tape.trades) insert.run(job.mint, t.slot, t.seq, t.ts, t.wallet, t.buy, t.amm, t.lamports, t.tokens);
      const nCurve = tape.trades.filter((t) => !t.amm).length;
      const graduated = tape.trades.some((t) => t.amm) || job.kind === "graduate" ? 1 : 0;
      finish.run(job.mint, job.kind, job.launch_ts, job.creator, job.mayhem, tape.trades.length, nCurve, tape.complete ? 1 : 0, graduated, tape.pages, Date.now() / 1000);
    } else {
      finish.run(job.mint, job.kind, job.launch_ts, job.creator, job.mayhem, 0, 0, 0, 0, 0, Date.now() / 1000);
    }
    drop.run(job.mint);
    db.exec("COMMIT");
    if (++done % 25 === 0) console.log(`${new Date().toISOString().slice(5, 19)}  tapes this run ${done}  last ${job.kind} ${tape?.trades.length ?? 0} trades ${tape?.pages ?? 0} pages`);
  }
}

function status(db: DatabaseSync): void {
  console.log("queue:", db.prepare("SELECT kind, COUNT(*) n FROM pf_queue GROUP BY kind").all().map((r) => `${r.kind} ${r.n}`).join(", ") || "empty");
  for (const r of db.prepare("SELECT kind, complete, graduated, COUNT(*) n, SUM(n) trades, SUM(n_curve) curve, SUM(pages) pages FROM pf_tape GROUP BY 1,2,3").all())
    console.log(`tapes: ${r.kind} complete=${r.complete} graduated=${r.graduated}  ${r.n} tapes  ${r.trades} trades (${r.curve} on curve)  ${r.pages} pages`);
}

if (import.meta.main) {
  const db = openTapes();
  db.exec(SCHEMA);
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "enqueue-recorder" && arg) enqueueRecorder(db, arg);
  else if (cmd === "enqueue-listing") await enqueueListing(db, Number(arg) || 10);
  else if (cmd === "run") await run(db, arg);
  else if (cmd === "status") status(db);
  else console.log("usage: node src/flows/pumpfun.ts enqueue-recorder <stream.db> | enqueue-listing [pages] | run [stream.db] | status");
}
