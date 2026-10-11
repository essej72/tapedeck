// A tape, checked, classified and packed small for the shelf. Pure: the library builder and the browser deck
// both use it.

import type { PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Session, type Tape } from "../engine/replay.ts";

export type PackedTape = {
  id: string;
  source: string;
  kind: "one-party buyout" | "contested graduation" | "died on the curve";
  creator: number;
  wallets: number;
  graduated: boolean;
  /** Seconds from launch to the last order kept. */
  seconds: number;
  /** Quote bought in the launch slot, and in total on the curve, whole tokens. */
  launchSlotBuys: number;
  curveBuys: number;
  /** Median and 90th-percentile gap between replayed and recorded tokens received, over the curve buys, as a fraction. */
  fit: [number, number];
  /** One row per order: [slot, wallet, amount]. amount > 0: buy, smallest quote units. amount < 0: sell, parts per million of holdings. */
  orders: [number, number, number][];
  /** Index of the creator's buy inside the launch transaction, or -1. */
  createBuy: number;
  /** DBC tapes: the pool's config (address, account bytes) and how many swaps replayed exactly against the chain. */
  config?: { address: string; bytes: string };
  exactSwaps?: number;
  /** How the tape was checked, in words, when the default wording does not fit (a pool loaded in the browser). */
  proof?: string;
};

export const MIN_ORDERS = 12;
const MAX_ORDERS = 3500;

/**
 * Pack a tape, or say why it does not go on the shelf.
 *
 * `fitFee`: for a tape from a feed (pump.fun), the fee the feed's amounts exclude. The tape is then kept only if
 * Side A returns the recorded number of tokens on its curve buys. A DBC tape has already been verified swap by swap.
 */
export function pack(tape: Tape, sideA: PoolConfig, fitFee?: number, minOrders = MIN_ORDERS): PackedTape | "short" | "misfit" {
  if (tape.orders.length < minOrders) return "short";
  const s = new Session(sideA, tape, { record: true });
  s.runToEnd();
  let fit: [number, number] = [0, 0];
  if (fitFee !== undefined) {
    const gaps: number[] = [];
    for (const f of s.fills) {
      const was = f.order >= 0 ? tape.recorded?.[f.order] : undefined;
      if (!f.onCurve || !f.buy || !was) continue;
      gaps.push(Math.abs((f.quote * 1e9 * (1 - fitFee)) / f.tokens / was - 1));
    }
    if (gaps.length === 0) return "misfit";
    gaps.sort((a, b) => a - b);
    fit = [gaps[Math.floor(gaps.length / 2)], gaps[Math.floor(gaps.length * 0.9)]];
    if (fit[0] > 0.01 || fit[1] > 0.05) return "misfit";
  }
  // The replay must also agree with the tape on whether the launch graduated.
  if (s.curve.complete !== tape.graduated) return "misfit";
  let launchSlotBuys = 0;
  let curveBuys = 0;
  for (const f of s.fills) {
    if (!f.onCurve || !f.buy) continue;
    curveBuys += f.quote;
    if (tape.orders[f.order].slot === 0) launchSlotBuys += f.quote;
  }
  const kind = !tape.graduated ? "died on the curve" : launchSlotBuys >= 0.9 * curveBuys ? "one-party buyout" : "contested graduation";
  const orders = tape.orders.slice(0, MAX_ORDERS);
  return {
    id: tape.id,
    source: tape.source,
    kind,
    creator: tape.creator,
    wallets: tape.wallets,
    graduated: tape.graduated,
    seconds: orders[orders.length - 1].t,
    launchSlotBuys: Math.round(launchSlotBuys * 100) / 100,
    curveBuys: Math.round(curveBuys * 100) / 100,
    fit: [Math.round(fit[0] * 1e4) / 1e4, Math.round(fit[1] * 1e4) / 1e4],
    orders: orders.map((o) => [o.slot, o.wallet, o.buy ? Number(o.quote) : -Math.max(1, Math.round(o.fraction * 1e6))]),
    createBuy: orders.findIndex((o) => o.inCreateTx),
  };
}
