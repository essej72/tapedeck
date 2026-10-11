// A DBC pool's on-chain history as a tape the deck can play.

import type { Tape } from "../engine/replay.ts";
import type { ChainTx } from "./history.ts";
import { toTape, type TradeRow } from "./tapes.ts";

/** Null when the history does not reach the pool's creation. */
export function fromChain(f: { pool: string; txs: ChainTx[] }): Tape | null {
  const created = f.txs.findIndex((tx) => tx.events.some((e) => e.name === "evtInitializePool" && e.data.pool === f.pool));
  if (created < 0) return null;
  const init = f.txs[created].events.find((e) => e.name === "evtInitializePool")!.data as { creator: string };
  const rows: TradeRow[] = [];
  let graduated = false;
  f.txs.forEach((tx, i) => {
    tx.events.forEach((e, j) => {
      if (e.data.pool !== f.pool) return;
      if (e.name === "evtCurveComplete") graduated = true;
      if (e.name !== "evtSwap2") return;
      const d = e.data as { tradeDirection: number; swapResult: Record<string, string> };
      const r = d.swapResult;
      const buy = d.tradeDirection === 1;
      rows.push({
        slot: tx.slot,
        seq: i * 100 + j,
        wallet: tx.payer,
        buy,
        spent: Number(r.includedFeeInputAmount),
        quote: buy ? Number(r.excludedFeeInputAmount) : Number(r.outputAmount),
        tokens: buy ? Number(r.outputAmount) : Number(r.includedFeeInputAmount),
        inCreateTx: buy && i === created,
      });
    });
  });
  return toTape({ id: f.pool, source: "Meteora DBC", creator: init.creator, graduated, complete: true }, rows, f.txs[created].slot, 6 * 3600);
}
