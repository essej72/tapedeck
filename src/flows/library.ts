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
import { decodeConfig } from "../engine/codec.ts";
import { design, flatFee, PUMP_CURVE } from "../engine/design.ts";
import { openTapes } from "./chain.ts";
import { loadVerified } from "./dbc.ts";
import { MIN_ORDERS, pack, type PackedTape } from "./pack.ts";
import { loadPumpfunTapes, PUMP_CURVE_FEE } from "./tapes.ts";

export const PUMP_CLONE = () => design({ ...PUMP_CURVE, baseFee: flatFee(125), creatorTradingFeePercentage: 24, migrationFeeOption: 2 });

if (import.meta.main) {
  const max = Number(process.argv[2]) || 60;
  const db = openTapes();
  const pump = loadPumpfunTapes(db);
  const verdicts = pump.map((t) => pack(t, PUMP_CLONE(), PUMP_CURVE_FEE));
  const packed = verdicts.filter((t): t is PackedTape => typeof t !== "string");
  const tooShort = verdicts.filter((v) => v === "short").length;
  const misfit = verdicts.filter((v) => v === "misfit").length;
  const span = db.prepare("SELECT MIN(fetched) lo, MAX(fetched) hi FROM pf_tape WHERE complete = 1").get() as { lo: number; hi: number };
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  // A spread of kinds, the busiest of each first.
  const byKind = new Map<string, PackedTape[]>();
  for (const t of packed) byKind.set(t.kind, [...(byKind.get(t.kind) ?? []), t]);
  const chosen: PackedTape[] = [];
  const share: Record<string, number> = { "one-party buyout": 0.25, "contested graduation": 0.45, "died on the curve": 0.3 };
  for (const [kind, list] of byKind) chosen.push(...list.sort((a, b) => b.orders.length - a.orders.length).slice(0, Math.ceil(max * (share[kind] ?? 0.3))));

  const chain: PackedTape[] = [];
  for (const v of loadVerified(db)) {
    const p = pack(v.tape, decodeConfig(Buffer.from(v.configData, "base64")));
    // A pool traded by one or two wallets is somebody talking to themselves, not a launch.
    if (typeof p !== "string" && p.wallets >= 10) chain.push({ ...p, config: { address: v.config, bytes: v.configData }, exactSwaps: v.swaps });
  }
  // Graduations that were fought over are the rare ones: they go first, then the busiest of the rest.
  const rank = (t: PackedTape) => (t.kind === "contested graduation" ? 0 : t.kind === "one-party buyout" ? 1 : 2);
  chain.sort((a, b) => rank(a) - rank(b) || b.wallets - a.wallets);

  const counts = (xs: PackedTape[]) => Object.fromEntries([...new Set(xs.map((t) => t.kind))].map((k) => [k, xs.filter((t) => t.kind === k).length]));
  mkdirSync(new URL("../../web/data/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("../../web/data/tapes.json", import.meta.url),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      slotSeconds: 0.219,
      // what was recorded and passed, before the shelf was cut to size
      pumpfun: { considered: pump.length, passed: packed.length, tooShort, misfit, recordedFrom: day(span.lo), recordedTo: day(span.hi), kinds: counts(packed) },
      dbc: { passed: chain.length, kinds: counts(chain), swaps: chain.reduce((s, t) => s + (t.exactSwaps ?? 0), 0) },
      tapes: [...chain.slice(0, 24), ...chosen],
    }),
  );
  console.log(`pump.fun: ${pump.length} tapes recorded ${day(span.lo)} to ${day(span.hi)}; ${tooShort} under ${MIN_ORDERS} orders, ${misfit} fail the fit check, ${packed.length} pass, ${chosen.length} on the shelf`, counts(packed));
  console.log(`DBC: ${chain.length} verified pools on the shelf`, counts(chain));
  for (const t of [...chain.slice(0, 24), ...chosen].slice(0, 50)) console.log(`  ${t.source.padEnd(12)} ${t.id.slice(0, 6)} ${t.kind.padEnd(22)} ${String(t.orders.length).padStart(5)} orders ${String(t.wallets).padStart(5)} traders ${t.seconds.toFixed(0).padStart(6)}s launch-slot ${t.launchSlotBuys}/${t.curveBuys}`);
}
