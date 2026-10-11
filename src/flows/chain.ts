// The complete on-chain history of a DBC pool: every transaction that touched it, with the program's own events
// (pool created, swap, curve complete) decoded. This is the ground truth the engine is checked against, and the
// native source of order tapes.
//
//   node src/flows/chain.ts <pool address> [...more]      # fetch and store
//
// Reads only. Uses a second keyless endpoint so it does not compete with the census for the first one's allowance.

import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import bs58 from "bs58";
import { decodeEventIx } from "../engine/codec.ts";
import { PROGRAM_ID } from "../layout.ts";
import { Rpc } from "../rpc.ts";

export const TX_RPC_URL = process.env.TX_RPC_URL ?? "https://solana-rpc.publicnode.com";
const DATA_DIR = new URL("../../data/", import.meta.url);
mkdirSync(DATA_DIR, { recursive: true });
export const TAPES_DB = new URL("tapes.db", DATA_DIR);

export type ChainEvent = { name: string; data: Record<string, unknown> };
export type ChainTx = { sig: string; slot: number; blockTime: number; payer: string; events: ChainEvent[] };

type SigInfo = { signature: string; slot: number; blockTime: number | null; err: unknown };
type RawTx = {
  slot: number;
  blockTime: number | null;
  transaction: { message: { accountKeys: string[]; instructions: RawIx[] } };
  meta: { err: unknown; innerInstructions: { index: number; instructions: RawIx[] }[] | null; loadedAddresses?: { writable: string[]; readonly: string[] } } | null;
};
type RawIx = { programIdIndex: number; data: string };

/** BN, PublicKey and nested structs -> plain JSON (integers as decimal strings, keys as base58). */
function plain(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const o = v as { toBase58?: () => string; toString: (r?: number) => string; constructor: { name: string } };
  if (typeof o.toBase58 === "function") return o.toBase58();
  if (o.constructor.name === "BN") return o.toString(10);
  if (Array.isArray(v)) return v.map(plain);
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]));
}

export async function signaturesOf(rpc: Rpc, address: string, max = 20_000): Promise<SigInfo[]> {
  const out: SigInfo[] = [];
  let before: string | undefined;
  while (out.length < max) {
    const page = await rpc.call<SigInfo[]>("getSignaturesForAddress", [address, { limit: 1000, ...(before ? { before } : {}) }]);
    out.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  return out.reverse(); // oldest first, block order preserved inside a slot
}

export async function transactionOf(rpc: Rpc, sig: string): Promise<ChainTx | null> {
  const tx = await rpc.call<RawTx | null>("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
  if (!tx?.meta || tx.meta.err) return null;
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const events: ChainEvent[] = [];
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== PROGRAM_ID) continue;
      const ev = decodeEventIx(Buffer.from(bs58.decode(ix.data)));
      if (ev) events.push({ name: ev.name, data: plain(ev.data) as Record<string, unknown> });
    }
  }
  return { sig, slot: tx.slot, blockTime: tx.blockTime ?? 0, payer: keys[0], events };
}

export function openTapes(): DatabaseSync {
  const db = new DatabaseSync(TAPES_DB);
  // Several collectors write this file at once; wait for the other writer instead of failing.
  db.exec("PRAGMA busy_timeout=60000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS chain_tx (pool TEXT, seq INTEGER, sig TEXT, slot INTEGER, block_time INTEGER, payer TEXT, events TEXT, PRIMARY KEY (pool, seq));
    CREATE TABLE IF NOT EXISTS chain_pool (pool TEXT PRIMARY KEY, n_sigs INTEGER, n_tx INTEGER, complete INTEGER, fetched REAL);
  `);
  return db;
}

/**
 * Fetch a pool's history from its creation, oldest transaction first, `lanes` requests in flight at a time, and
 * store it. A long history is cut after `maxTx` transactions; chain_pool.complete says whether it was.
 */
export async function fetchPool(db: DatabaseSync, pool: string, opts: { lanes?: number; maxTx?: number; gapMs?: number; url?: string } = {}): Promise<ChainTx[]> {
  const { lanes = 4, maxTx = 6000, gapMs = 120, url = TX_RPC_URL } = opts;
  const sigs = (await signaturesOf(new Rpc(url, gapMs), pool, 80_000)).filter((s) => !s.err);
  const complete = sigs.length <= maxTx;
  const want = sigs.slice(0, maxTx);
  const txs: (ChainTx | null)[] = new Array(want.length).fill(null);
  let next = 0;
  const lane = async () => {
    const mine = new Rpc(url, gapMs * lanes);
    while (next < want.length) {
      const i = next++;
      txs[i] = await transactionOf(mine, want[i].signature);
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  const insert = db.prepare("INSERT OR REPLACE INTO chain_tx VALUES (?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  db.prepare("DELETE FROM chain_tx WHERE pool = ?").run(pool);
  const kept: ChainTx[] = [];
  for (const tx of txs) {
    if (!tx || tx.events.length === 0) continue;
    insert.run(pool, kept.length, tx.sig, tx.slot, tx.blockTime, tx.payer, JSON.stringify(tx.events));
    kept.push(tx);
  }
  db.prepare("INSERT OR REPLACE INTO chain_pool VALUES (?,?,?,?,?)").run(pool, sigs.length, kept.length, complete ? 1 : 0, Date.now() / 1000);
  db.exec("COMMIT");
  return kept;
}

export const isComplete = (db: DatabaseSync, pool: string): boolean => db.prepare("SELECT complete FROM chain_pool WHERE pool = ?").get(pool)?.complete === 1;

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
