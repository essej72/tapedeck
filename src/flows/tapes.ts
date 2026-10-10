// Recorded launches in the one shape the engine replays, whichever feed they came from.

import type { DatabaseSync } from "node:sqlite";
import { SLOT_SECONDS, type Order, type Tape } from "../engine/replay.ts";

// pump.fun's curve fee at the time of collection: 0.95% protocol + 0.30% creator, charged on top of the amount
// that reaches the curve. A DBC config takes its fee out of what the buyer sends, so a buy is replayed with the
// budget that puts the same amount on a 1.25% DBC curve: recorded / (1 - fee). That is 0.016% more than the buyer
// actually paid on pump.fun.
export const PUMP_CURVE_FEE = 0.0125;

/** One trade as a feed or a chain history gives it. `spent` is what a buyer sent; all in smallest units. */
export type TradeRow = { slot: number; seq: number; wallet: string; buy: boolean; spent: number; quote: number; tokens: number; inCreateTx?: boolean };
type PfTrade = { slot: number; seq: number; wallet: string; buy: number; amm: number; lamports: number; tokens: number };
type PfTape = { mint: string; kind: string; creator: string | null; complete: number; graduated: number; mayhem: number | null };

/**
 * Trades -> orders: buys as quote spent, sells as the share of holdings sold.
 *
 * A trade list shows trades, not transfers. A wallet that sells tokens it never bought on the tape got them from
 * another wallet, so the two are treated as one trader: it is merged with whichever wallet held the most unsold
 * tokens at that moment. Bundles that buy in one wallet and sell from others come out as the single trader they are.
 */
export function toTape(meta: { id: string; source: string; creator: string | null; graduated: boolean; complete: boolean }, rows: TradeRow[], slot0: number, maxSeconds = 3600): Tape {
  const sorted = rows.filter((t) => t.quote > 0 && t.tokens > 0 && (t.slot - slot0) * SLOT_SECONDS <= maxSeconds).sort((a, b) => a.slot - b.slot || a.seq - b.seq);

  // Pass 1: find which wallets are one trader.
  const index = new Map<string, number>();
  const id = (wallet: string) => index.get(wallet) ?? (index.set(wallet, index.size), index.size - 1);
  const parent: number[] = [];
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const held: number[] = [];
  for (const t of sorted) {
    const w = id(t.wallet);
    if (parent[w] === undefined) {
      parent[w] = w;
      held[w] = 0;
    }
    let e = find(w);
    if (t.buy) {
      held[e] += t.tokens;
      continue;
    }
    for (let merges = 0; held[e] < t.tokens * 0.999 && merges < 4; merges++) {
      let donor = -1;
      for (let x = 0; x < parent.length; x++) if (parent[x] === x && x !== e && held[x] > (donor < 0 ? 0 : held[donor])) donor = x;
      if (donor < 0) break;
      parent[e] = donor;
      held[donor] += held[e];
      e = donor;
    }
    held[e] = Math.max(0, held[e] - t.tokens);
  }

  // Pass 2: orders, with every wallet standing for its trader.
  const trader = new Map<number, number>();
  const tid = (w: number) => {
    const e = find(w);
    return trader.get(e) ?? (trader.set(e, trader.size), trader.size - 1);
  };
  const balance: number[] = [];
  const orders: Order[] = [];
  const recorded: number[] = [];
  for (const t of sorted) {
    const w = tid(index.get(t.wallet)!);
    balance[w] ??= 0;
    const slot = Math.max(0, t.slot - slot0);
    if (t.buy) {
      balance[w] += t.tokens;
      orders.push({ t: slot * SLOT_SECONDS, slot, wallet: w, buy: true, quote: BigInt(Math.round(t.spent)), fraction: 0, inCreateTx: Boolean(t.inCreateTx) });
    } else {
      if (balance[w] <= 0) continue; // nothing on the tape explains these tokens
      const fraction = Math.min(1, t.tokens / balance[w]);
      balance[w] -= Math.min(t.tokens, balance[w]);
      orders.push({ t: slot * SLOT_SECONDS, slot, wallet: w, buy: false, quote: 0n, fraction });
    }
    recorded.push(t.quote / t.tokens);
  }
  const creator = meta.creator !== null && index.has(meta.creator) ? tid(index.get(meta.creator)!) : -1;
  return { id: meta.id, source: meta.source, creator, wallets: trader.size, orders, graduated: meta.graduated, complete: meta.complete, recorded };
}

/**
 * A pump.fun tape. Trades on the AMM after graduation are kept, up to `maxSeconds` after launch: under another
 * config they may well land on the curve.
 */
export function fromPumpfun(meta: PfTape, trades: PfTrade[], maxSeconds = 3600): Tape {
  const slot0 = trades.reduce((m, t) => Math.min(m, t.slot), Infinity);
  const rows: TradeRow[] = trades.map((t) => ({
    slot: t.slot,
    seq: t.seq,
    wallet: t.wallet,
    buy: t.buy === 1,
    // On the AMM the recorded amount is what the buyer sent; on the curve the fee came on top (see above).
    spent: t.amm ? t.lamports : Math.ceil(t.lamports / (1 - PUMP_CURVE_FEE)),
    quote: t.lamports,
    tokens: t.tokens,
    inCreateTx: t.slot === slot0 && !t.amm && t.wallet === meta.creator,
  }));
  return toTape({ id: meta.mint, source: "pump.fun", creator: meta.creator, graduated: meta.graduated === 1, complete: meta.complete === 1 }, rows, slot0, maxSeconds);
}

export function loadPumpfunTapes(db: DatabaseSync, where = "complete = 1 AND COALESCE(mayhem, 0) = 0 AND n_curve > 0"): Tape[] {
  const trades = db.prepare("SELECT slot, seq, wallet, buy, amm, lamports, tokens FROM pf_trades WHERE mint = ?");
  return db
    .prepare(`SELECT mint, kind, creator, complete, graduated, mayhem FROM pf_tape WHERE ${where}`)
    .all()
    .map((m) => fromPumpfun(m as unknown as PfTape, trades.all(m.mint as string) as unknown as PfTrade[]));
}
