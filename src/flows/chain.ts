// The collectors' store of pool histories: fetch a DBC pool's whole on-chain history (history.ts) with the
// program's events decoded by the SDK's own Anchor coder, and keep it in data/tapes.db.
//
//   node src/flows/chain.ts <pool address> [...more]      # fetch and store
//
// Reads only. Uses a second keyless endpoint so it does not compete with the census for the first one's allowance.

import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { decodeEventIx } from "../engine/codec.ts";
import { RPC_URL } from "../rpc.ts";
import { fetchHistory, type ChainTx, type EventDecoder } from "./history.ts";

export type { ChainEvent, ChainTx } from "./history.ts";

export const TX_RPC_URL = process.env.TX_RPC_URL ?? "https://solana-rpc.publicnode.com";
// Asked, in turn, for a transaction the first endpoint cannot give whole. The public mainnet endpoint keeps some old
// transactions without their inner instructions; the second archive has had them.
export const ARCHIVES = [RPC_URL, "https://public.rpc.solanavibestation.com"];
const DATA_DIR = new URL("../../data/", import.meta.url);
mkdirSync(DATA_DIR, { recursive: true });
export const TAPES_DB = new URL("tapes.db", DATA_DIR);

/** BN, PublicKey and nested structs -> plain JSON (integers as decimal strings, keys as base58). */
function plain(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const o = v as { toBase58?: () => string; toString: (r?: number) => string; constructor: { name: string } };
  if (typeof o.toBase58 === "function") return o.toBase58();
  if (o.constructor.name === "BN") return o.toString(10);
  if (Array.isArray(v)) return v.map(plain);
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]));
}

/** Events through the SDK's Anchor coder: the reference decoder. */
export const anchorDecode: EventDecoder = (data) => {
  const ev = decodeEventIx(Buffer.from(data));
  return ev ? { name: ev.name, data: plain(ev.data) as Record<string, unknown> } : null;
};

export function openTapes(): DatabaseSync {
  const db = new DatabaseSync(TAPES_DB);
  // Several collectors write this file at once; wait for the other writer instead of failing.
  db.exec("PRAGMA busy_timeout=60000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS chain_tx (pool TEXT, seq INTEGER, sig TEXT, slot INTEGER, block_time INTEGER, payer TEXT, events TEXT, PRIMARY KEY (pool, seq));
    CREATE TABLE IF NOT EXISTS chain_pool (pool TEXT PRIMARY KEY, n_sigs INTEGER, n_tx INTEGER, complete INTEGER, fetched REAL);
  `);
  if (!db.prepare("PRAGMA table_info(chain_pool)").all().some((c) => c.name === "holes")) db.exec("ALTER TABLE chain_pool ADD COLUMN holes INTEGER DEFAULT 0");
  return db;
}

/**
 * Fetch a pool's history from its creation, oldest transaction first, and store it. A long history is cut after
 * `maxTx` transactions; chain_pool.complete says whether it was. `keepRaw` also stores each event's raw bytes.
 */
export async function fetchPool(db: DatabaseSync, pool: string, opts: { lanes?: number; maxTx?: number; gapMs?: number; url?: string; keepRaw?: boolean } = {}): Promise<ChainTx[]> {
  const { txs, signatures, complete, holes } = await fetchHistory(pool, {
    url: opts.url ?? TX_RPC_URL,
    fallbacks: ARCHIVES,
    decode: anchorDecode,
    lanes: opts.lanes,
    gapMs: opts.gapMs,
    maxTx: opts.maxTx,
    withBytes: opts.keepRaw ? (event, bytes) => (event.raw = Buffer.from(bytes).toString("base64")) : undefined,
  });
  const insert = db.prepare("INSERT OR REPLACE INTO chain_tx VALUES (?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  db.prepare("DELETE FROM chain_tx WHERE pool = ?").run(pool);
  txs.forEach((tx, seq) => insert.run(pool, seq, tx.sig, tx.slot, tx.blockTime, tx.payer, JSON.stringify(tx.events)));
  db.prepare("INSERT OR REPLACE INTO chain_pool (pool, n_sigs, n_tx, complete, fetched, holes) VALUES (?,?,?,?,?,?)").run(pool, signatures, txs.length, complete ? 1 : 0, Date.now() / 1000, holes.length);
  db.exec("COMMIT");
  return txs;
}

export const isComplete = (db: DatabaseSync, pool: string): boolean => db.prepare("SELECT complete FROM chain_pool WHERE pool = ?").get(pool)?.complete === 1;
/** Transactions of the stored history that no endpoint could give whole (each may hide a swap). */
export const holesIn = (db: DatabaseSync, pool: string): number => Number(db.prepare("SELECT holes FROM chain_pool WHERE pool = ?").get(pool)?.holes ?? 0);

export function loadPool(db: DatabaseSync, pool: string): ChainTx[] {
  return db
    .prepare("SELECT sig, slot, block_time, payer, events FROM chain_tx WHERE pool = ? ORDER BY seq")
    .all(pool)
    .map((r) => ({ sig: r.sig as string, slot: r.slot as number, blockTime: r.block_time as number, payer: r.payer as string, events: JSON.parse(r.events as string) }));
}

if (import.meta.main) {
  const db = openTapes();
  for (const pool of process.argv.slice(2)) {
    const t0 = Date.now();
    const txs = await fetchPool(db, pool);
    const names = new Map<string, number>();
    for (const tx of txs) for (const e of tx.events) names.set(e.name, (names.get(e.name) ?? 0) + 1);
    console.log(`${pool}  ${txs.length} tx  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${[...names].map(([k, v]) => `${k}:${v}`).join(" ")}`);
  }
}
