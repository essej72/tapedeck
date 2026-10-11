// Proof that the engine is the chain, as a pure function: replay a pool's whole swap history from its own events
// and compare every swap, to the lamport, with what the program recorded, then the final state with the account.
// No I/O here: the collectors (validate.ts) and the browser deck both hand it a fixture.

import type { SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import type { ChainTx } from "../flows/history.ts";
import { configFromBytes, poolFromBytes } from "./bytes.ts";
import { SimPool } from "./pool.ts";

/** A pool, its config, both accounts' bytes (base64) and its transactions from creation on. */
export type Fixture = { pool: string; config: string; configData: string; poolData: string; txs: ChainTx[]; complete: boolean };
export type Verdict = { swaps: number; mismatches: string[]; finalChecked: boolean; skipped?: string };

const base64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function replayFixture(f: Fixture): Verdict {
  const config = configFromBytes(base64(f.configData));
  const live = poolFromBytes(base64(f.poolData));
  const created = f.txs.findIndex((tx) => tx.events.some((e) => e.name === "evtInitializePool" && e.data.pool === f.pool));
  if (created < 0) return { swaps: 0, mismatches: [], finalChecked: false, skipped: "history does not reach the pool's creation" };
  const init = f.txs[created].events.find((e) => e.name === "evtInitializePool")!;
  const sim = SimPool.fresh(config, new BN(init.data.activationPoint as string));
  const bySlot = config.activationType === 0;
  const mismatches: string[] = [];
  let swaps = 0;
  for (const [i, tx] of f.txs.entries()) {
    for (const e of tx.events) {
      if (e.name !== "evtSwap2" || e.data.pool !== f.pool) continue;
      const d = e.data as { tradeDirection: number; hasReferral: boolean; swapParameters: { amount0: string; swapMode: number }; swapResult: Record<string, string>; quoteReserveAmount: string; currentTimestamp: string };
      const fill = sim.swap(d.tradeDirection, new BN(d.swapParameters.amount0), { point: new BN(bySlot ? tx.slot : d.currentTimestamp), timestamp: new BN(d.currentTimestamp) }, {
        mode: d.swapParameters.swapMode as SwapMode,
        hasReferral: d.hasReferral,
        firstSwapInCreateTx: i === created,
      });
      swaps++;
      const got: Record<string, string> = {
        includedFeeInputAmount: fill.amountIn.toString(),
        amountLeft: fill.amountLeft.toString(),
        outputAmount: fill.amountOut.toString(),
        nextSqrtPrice: fill.nextSqrtPrice.toString(),
        tradingFee: fill.partnerFee.add(fill.creatorFee).toString(),
        protocolFee: fill.protocolFee.toString(),
        referralFee: fill.referralFee.toString(),
      };
      for (const [k, v] of Object.entries(got)) {
        if (v !== String(d.swapResult[k])) mismatches.push(`swap ${swaps} ${tx.sig.slice(0, 8)} ${k}: engine ${v} chain ${d.swapResult[k]}`);
      }
      if (sim.state.quoteReserve.toString() !== String(d.quoteReserveAmount)) mismatches.push(`swap ${swaps} ${tx.sig.slice(0, 8)} quoteReserve: engine ${sim.state.quoteReserve} chain ${d.quoteReserveAmount}`);
      if (mismatches.length > 20) return { swaps, mismatches, finalChecked: false };
    }
  }
  // The live account is only comparable when the tape is whole and the curve is finished (nothing traded since).
  if (!f.complete || !sim.complete) return { swaps, mismatches, finalChecked: false };
  // Totals never decrease and claims do not touch them, so they must equal the live account's.
  const finals: [string, BN, BN][] = [
    ["sqrtPrice", sim.state.sqrtPrice, live.sqrtPrice],
    ["quoteReserve", sim.state.quoteReserve, live.quoteReserve],
    ["totalTradingQuoteFee", sim.state.totalTradingQuoteFee, live.totalTradingQuoteFee],
    ["totalProtocolQuoteFee", sim.state.totalProtocolQuoteFee, live.totalProtocolQuoteFee],
    ["totalTradingBaseFee", sim.state.totalTradingBaseFee, live.totalTradingBaseFee],
    ["totalProtocolBaseFee", sim.state.totalProtocolBaseFee, live.totalProtocolBaseFee],
  ];
  for (const [k, a, b] of finals) if (!a.eq(b)) mismatches.push(`final ${k}: engine ${a} chain ${b}`);
  return { swaps, mismatches, finalChecked: true };
}
