// The deck's own Side B designs: the few knobs its form exposes, and the designs it ships with.
// No DOM here, so the same designs can be built, flown and dry-run against the program from Node.

import { ActivationType, BaseFeeMode, MigrationFeeOption } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { flatFee, PUMP_CURVE, type DesignSpec } from "./design.ts";

/** Fees in percent, the schedule in seconds, market caps in SOL, locked liquidity in percent. */
export type Custom = { start: number; end: number; secs: number; mode: 0 | 1; dyn: boolean; creator: number; first: boolean; cStart: number; cEnd: number; shape: "cp" | "flat" | "steep"; lock: number };

export const PUMP_START = 27.96;
export const PUMP_END = 410.88;

export const BUILT_IN: Record<string, { label: string; note: string; custom: Custom }> = {
  guard30: {
    label: "Guard: 50% settling to 1.25% over 30 s",
    note: "pump.fun's curve with a launch fee that starts at half the buy and decays. Nothing goes back to the creator.",
    custom: { start: 50, end: 1.25, secs: 30, mode: 1, dyn: false, creator: 0, first: false, cStart: PUMP_START, cEnd: PUMP_END, shape: "cp", lock: 100 },
  },
  guard300: {
    label: "Long guard: 90% settling to 1.25% over 5 min",
    note: "A slow descending clock: whoever buys first pays for the seat, and the price of the seat falls until someone takes it.",
    custom: { start: 90, end: 1.25, secs: 300, mode: 1, dyn: false, creator: 0, first: false, cStart: PUMP_START, cEnd: PUMP_END, shape: "cp", lock: 100 },
  },
  pump: {
    label: "pump.fun's curve, 1.25% flat (same as Side A)",
    note: "The curve the tape was recorded on, rebuilt as a DBC config.",
    custom: { start: 1.25, end: 1.25, secs: 0, mode: 1, dyn: false, creator: 24, first: false, cStart: PUMP_START, cEnd: PUMP_END, shape: "cp", lock: 100 },
  },
};

export function specOf(c: Custom): DesignSpec {
  // The schedule is counted in seconds (timestamp activation), so "30 s" stays 30 s whatever a slot lasts.
  const secs = Math.max(1, Math.round(c.secs));
  const periods = Math.min(100, secs);
  const scheduled = c.secs > 0 && c.start > c.end;
  const baseFee = scheduled
    ? { baseFeeMode: c.mode === 0 ? BaseFeeMode.FeeSchedulerLinear : BaseFeeMode.FeeSchedulerExponential, feeSchedulerParam: { startingFeeBps: Math.round(c.start * 100), endingFeeBps: Math.round(c.end * 100), numberOfPeriod: periods, totalDuration: periods * Math.max(1, Math.round(secs / periods)) } }
    : flatFee(Math.round(c.end * 100));
  const asPump = c.shape === "cp" && Math.abs(c.cStart - PUMP_START) < 0.01 && Math.abs(c.cEnd - PUMP_END) < 0.05;
  const weights = c.shape === "flat" ? Array.from({ length: 16 }, (_, i) => 1.45 ** (15 - i)) : c.shape === "steep" ? Array.from({ length: 16 }, (_, i) => 1.45 ** i) : undefined;
  const curve = asPump ? PUMP_CURVE : { initialMarketCap: c.cStart, migrationMarketCap: c.cEnd, liquidityWeights: weights };
  return { ...curve, baseFee: baseFee as DesignSpec["baseFee"], dynamicFee: c.dyn, creatorTradingFeePercentage: c.creator, enableFirstSwapWithMinFee: c.first, activationType: ActivationType.Timestamp, migrationFeeOption: MigrationFeeOption.FixedBps100, partnerLockedLiquidity: c.lock };
}
