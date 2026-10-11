// A DBC pool's on-chain history, fetched over plain JSON-RPC: every transaction that touched the pool, oldest
// first, with the program's events decoded. No Node APIs, so the same code runs in the browser deck ("load a pool
// from the chain") and in the collectors.

import bs58 from "bs58";
import { PROGRAM_ID } from "../layout.ts";
import { Rpc } from "../rpc.ts";

export type ChainEvent = { name: string; data: Record<string, unknown>; raw?: string };
/**
 * `unreadable`: the node could not give the transaction whole: it did not find it, or it keeps it without the inner
 * instructions that carry the program's events. Such a transaction may hide a swap, so it is never treated as empty.
 */
export type ChainTx = { sig: string; slot: number; blockTime: number; payer: string; events: ChainEvent[]; unreadable?: string };
export type EventDecoder = (data: Uint8Array) => { name: string; data: Record<string, unknown> } | null;

export type SigInfo = { signature: string; slot: number; blockTime: number | null; err: unknown };
type RawIx = { programIdIndex: number; data: string };
type RawTx = {
  slot: number;
  blockTime: number | null;
  transaction: { message: { accountKeys: string[]; instructions: RawIx[] } };
  meta: { err: unknown; innerInstructions: { index: number; instructions: RawIx[] }[] | null; loadedAddresses?: { writable: string[]; readonly: string[] } } | null;
};

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

/** One transaction's DBC events; null for a transaction that failed on chain. `withBytes` also hands back raw event data. */
export async function transactionOf(rpc: Rpc, sig: string, decode: EventDecoder, withBytes?: (event: ChainEvent, bytes: Uint8Array) => void): Promise<ChainTx | null> {
  const tx = await rpc.call<RawTx | null>("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
  if (!tx?.meta) return { sig, slot: tx?.slot ?? 0, blockTime: tx?.blockTime ?? 0, payer: "", events: [], unreadable: "the node does not have it" };
  if (tx.meta.err) return null;
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  // Some archive nodes keep old transactions without inner instructions and logs. Events live in inner instructions.
  if (tx.meta.innerInstructions == null) return { sig, slot: tx.slot, blockTime: tx.blockTime ?? 0, payer: keys[0], events: [], unreadable: "the node keeps it without inner instructions" };
  const events: ChainEvent[] = [];
  for (const group of tx.meta.innerInstructions) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== PROGRAM_ID) continue;
      const bytes = bs58.decode(ix.data);
      const ev = decode(bytes);
      if (!ev) continue;
      const event: ChainEvent = { name: ev.name, data: ev.data };
      withBytes?.(event, bytes);
      events.push(event);
    }
  }
  return { sig, slot: tx.slot, blockTime: tx.blockTime ?? 0, payer: keys[0], events };
}

export type HistoryOptions = {
  url: string;
  decode: EventDecoder;
  /** Requests in flight at once, and the pause between requests overall. */
  lanes?: number;
  gapMs?: number;
  /** A long history is cut after this many transactions, counted from the pool's creation. */
  maxTx?: number;
  /** Other endpoints to ask for a transaction the first one cannot give whole. */
  fallbacks?: string[];
  onProgress?: (done: number, total: number) => void;
  withBytes?: (event: ChainEvent, bytes: Uint8Array) => void;
};

/**
 * The pool's transactions that carry DBC events, from its creation on. `complete` is false when maxTx cut it.
 * `holes` lists the transactions no endpoint could give whole: with any of those, the history cannot be trusted.
 */
export async function fetchHistory(pool: string, opts: HistoryOptions): Promise<{ txs: ChainTx[]; signatures: number; complete: boolean; holes: string[] }> {
  const { url, decode, lanes = 4, gapMs = 120, maxTx = 6000 } = opts;
  const sigs = (await signaturesOf(new Rpc(url, gapMs), pool, 80_000)).filter((s) => !s.err);
  const want = sigs.slice(0, maxTx);
  const txs: (ChainTx | null)[] = new Array(want.length).fill(null);
  let next = 0;
  let done = 0;
  const lane = async () => {
    const mine = new Rpc(url, gapMs * lanes);
    while (next < want.length) {
      const i = next++;
      txs[i] = await transactionOf(mine, want[i].signature, decode, opts.withBytes);
      opts.onProgress?.(++done, want.length);
    }
  };
  await Promise.all(Array.from({ length: lanes }, lane));
  const holes: string[] = [];
  for (const [i, tx] of txs.entries()) {
    if (!tx?.unreadable) continue;
    for (const other of (opts.fallbacks ?? []).filter((u) => u !== url)) {
      const again = await transactionOf(new Rpc(other, 400), want[i].signature, decode, opts.withBytes).catch(() => tx);
      if (!again?.unreadable) {
        txs[i] = again;
        break;
      }
    }
    if (txs[i]?.unreadable) holes.push(want[i].signature);
  }
  return { txs: txs.filter((tx): tx is ChainTx => tx !== null && !tx.unreadable && tx.events.length > 0), signatures: sigs.length, complete: sigs.length <= maxTx, holes };
}
