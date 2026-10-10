// The tape library the web deck ships with: real launches, checked, classified and packed small.
//
//   node src/flows/library.ts [maxTapes]      # writes web/data/tapes.json
//
// Nothing goes on the shelf unless the engine can reproduce it.
//   pump.fun tapes: flown through a DBC config equal to pump.fun's own curve, every curve buy has to return the
//     recorded number of tokens.
//   DBC tapes: the pool's whole swap history has already replayed against its own events without a mismatch
//     (flows/dbc.ts); Side A for such a tape is the pool's own config.

import { mkdirSync, writeFileSync } from "node:fs";
import type { PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { decodeConfig } from "../engine/codec.ts";
import { design, flatFee, PUMP_CURVE } from "../engine/design.ts";
import { Session, type Tape } from "../engine/replay.ts";
import { openTapes } from "./chain.ts";
import { loadVerified } from "./dbc.ts";
import { loadPumpfunTapes, PUMP_CURVE_FEE } from "./tapes.ts";

export const PUMP_CLONE = () => design({ ...PUMP_CURVE, baseFee: flatFee(125), creatorTradingFeePercentage: 24, migrationFeeOption: 2 });

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
  /** One row per order: [slot, wallet, amount]. amount > 0: buy, lamports. amount < 0: sell, parts per million of holdings. */
  orders: [number, number, number][];
  /** Index of the creator's buy inside the launch transaction, or -1. */
  createBuy: number;
  /** DBC tapes: the pool's config (address, account bytes) and how many swaps replayed exactly against the chain. */
  config?: { address: string; bytes: string };
  exactSwaps?: number;
};

const MAX_ORDERS = 3500;

function pack(tape: Tape, sideA: PoolConfig, check: boolean): PackedTape | null {
  if (tape.orders.length < 12) return null;
  const s = new Session(sideA, tape, { record: true });
  s.runToEnd();
  let fit: [number, number] = [0, 0];
  if (check) {
    // Tokens received per curve buy, replayed against recorded. The feed's price is what the trade paid on
    // average, and it excludes pump.fun's fee, which the buyer paid on top.
    const gaps: number[] = [];
    for (const f of s.fills) {
      const was = f.order >= 0 ? tape.recorded?.[f.order] : undefined;
      if (!f.onCurve || !f.buy || !was) continue;
      gaps.push(Math.abs((f.quote * 1e9 * (1 - PUMP_CURVE_FEE)) / f.tokens / was - 1));
    }
    if (gaps.length === 0) return null;
    gaps.sort((a, b) => a - b);
    fit = [gaps[Math.floor(gaps.length / 2)], gaps[Math.floor(gaps.length * 0.9)]];
    if (fit[0] > 0.01 || fit[1] > 0.05) return null;
  }
  // The replay must also agree with the tape on whether the launch graduated.
  if (s.curve.complete !== tape.graduated) return null;
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

if (import.meta.main) {
  const max = Number(process.argv[2]) || 60;
  const db = openTapes();
  const pump = loadPumpfunTapes(db);
  const packed = pump.map((t) => pack(t, PUMP_CLONE(), true)).filter((t): t is PackedTape => t !== null);
  // A spread of kinds, the busiest of each first.
  const byKind = new Map<string, PackedTape[]>();
  for (const t of packed) byKind.set(t.kind, [...(byKind.get(t.kind) ?? []), t]);
  const chosen: PackedTape[] = [];
  const share: Record<string, number> = { "one-party buyout": 0.25, "contested graduation": 0.45, "died on the curve": 0.3 };
  for (const [kind, list] of byKind) chosen.push(...list.sort((a, b) => b.orders.length - a.orders.length).slice(0, Math.ceil(max * (share[kind] ?? 0.3))));

  const chain: PackedTape[] = [];
  for (const v of loadVerified(db)) {
    const p = pack(v.tape, decodeConfig(Buffer.from(v.configData, "base64")), false);
    // A pool traded by one or two wallets is somebody talking to themselves, not a launch.
    if (p && p.wallets >= 10) chain.push({ ...p, config: { address: v.config, bytes: v.configData }, exactSwaps: v.swaps });
  }
  chain.sort((a, b) => b.orders.length - a.orders.length);

  const counts = (xs: PackedTape[]) => Object.fromEntries([...new Set(xs.map((t) => t.kind))].map((k) => [k, xs.filter((t) => t.kind === k).length]));
  mkdirSync(new URL("../../web/data/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("../../web/data/tapes.json", import.meta.url),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      slotSeconds: 0.219,
      // what was recorded and passed, before the shelf was cut to size
      pumpfun: { considered: pump.length, passed: packed.length, kinds: counts(packed) },
      dbc: { passed: chain.length, kinds: counts(chain), swaps: chain.reduce((s, t) => s + (t.exactSwaps ?? 0), 0) },
      tapes: [...chain.slice(0, 24), ...chosen],
    }),
  );
  console.log(`pump.fun: ${pump.length} tapes considered, ${packed.length} pass the fit check, ${chosen.length} on the shelf`, counts(packed));
  console.log(`DBC: ${chain.length} verified pools on the shelf`, counts(chain));
  for (const t of [...chain.slice(0, 24), ...chosen].slice(0, 50)) console.log(`  ${t.source.padEnd(12)} ${t.id.slice(0, 6)} ${t.kind.padEnd(22)} ${String(t.orders.length).padStart(5)} orders ${String(t.wallets).padStart(5)} traders ${t.seconds.toFixed(0).padStart(6)}s launch-slot ${t.launchSlotBuys}/${t.curveBuys}`);
}
