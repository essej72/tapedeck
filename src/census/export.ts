// What the web deck needs from the census, small enough to ship: one row per design for the evidence chart, and
// the account bytes of the most used designs so they can be loaded onto Side B and flown.
//
//   node src/census/export.ts      # reads web/data/census_all.json and data/census.db, writes web/data/evidence.json

import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import bs58 from "bs58";
import { CENSUS_DB } from "./pull.ts";

type Cost = { spend: number; feeRate: number; feeBackToCreator: number; lpNow: number; lpLater: number; lpNever: number; cost: number; costShare: number } | null;
type Row = {
  hash: string;
  example: string;
  quote: string;
  quoteDecimals: number;
  fields: Record<string, number | boolean | string>;
  configs: number;
  claimers: number;
  topClaimers: { address: string; pools: number; name: string | null; website: string | null }[];
  creators: number;
  pools: number;
  traded: number;
  completed: number;
  migrated: number;
  quoteFees: number;
  quoteRaised: number;
  firstTs: number;
  lastTs: number;
  medianSecsToComplete: number | null;
  shareCompletedWithin10s: number | null;
  topSuffix: { suffix: string; share: number } | null;
  costs: Record<"creatorAtLaunch" | "operatorAtLaunch" | "creatorPatient" | "operatorPatient", Cost>;
};

const web = new URL("../../web/data/", import.meta.url);
const census = JSON.parse(readFileSync(new URL("census_all.json", web), "utf8")) as { totals: Record<string, number | string>; designs: Row[] };
const db = new DatabaseSync(CENSUS_DB, { readOnly: true });
const bytesOf = (address: string): string | null => {
  const r = db.prepare("SELECT data FROM configs WHERE address = ?").get(Buffer.from(bs58.decode(address)));
  return r ? Buffer.from(r.data as Uint8Array).toString("base64") : null;
};

const round = (x: number | null | undefined, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const feeText = (f: Row["fields"]): string => {
  const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`;
  const unit = f.activationType ? "s" : " slots";
  if (f.baseFeeMode === 2) return `${pct(f.startFeeBps as number)} + size surcharge for ${f.feeDuration}${unit}`;
  if (f.startFeeBps === f.endFeeBps || !f.feeDuration) return `${pct(f.startFeeBps as number)} flat`;
  return `${pct(f.startFeeBps as number)} to ${pct(f.endFeeBps as number)} over ${f.feeDuration}${unit}`;
};

// The cheapest way to fake a graduation under a design: whoever can do it cheaper, a creator or the config's owner.
const cheapest = (r: Row): number | null => {
  const xs = [r.costs.creatorAtLaunch, r.costs.operatorAtLaunch, r.costs.creatorPatient, r.costs.operatorPatient].filter((c): c is NonNullable<Cost> => c !== null).map((c) => c.costShare);
  return xs.length ? Math.min(...xs) : null;
};

const designs = census.designs
  .filter((r) => r.pools >= 100)
  .map((r) => ({
    hash: r.hash.slice(0, 10),
    example: r.example,
    quote: r.quote,
    name: r.topClaimers[0]?.name ?? null,
    suffix: r.topSuffix,
    claimers: r.claimers,
    configs: r.configs,
    creators: r.creators,
    pools: r.pools,
    completed: r.completed,
    fees: Math.round(r.quoteFees),
    medianSecs: r.medianSecsToComplete === null ? null : Math.round(r.medianSecsToComplete),
    within10s: round(r.shareCompletedWithin10s, 3),
    threshold: round((r.fields.migrationQuoteThreshold as number) / 10 ** r.quoteDecimals, 2),
    fee: feeText(r.fields),
    feeInTokens: r.fields.collectFeeMode === 1,
    creatorFeePct: r.fields.creatorTradingFeePct,
    costCreator: round(r.costs.creatorAtLaunch?.costShare),
    costOperator: round(r.costs.operatorAtLaunch?.costShare),
    costCheapest: round(cheapest(r)),
    lpNow: round(r.costs.operatorAtLaunch?.lpNow, 2),
    lastTs: r.lastTs,
  }));

// Presets: the most used SOL-quoted designs on each side of the divide, with their bytes.
const sol = census.designs.filter((r) => r.quote === "SOL" && cheapest(r) !== null && r.pools >= 1500);
const earned = sol.filter((r) => r.completed / r.pools < 0.1).slice(0, 7);
const oneAct = sol.filter((r) => r.completed / r.pools > 0.9).slice(0, 4);
const presets = [...earned, ...oneAct]
  .map((r) => ({
    hash: r.hash.slice(0, 10),
    address: r.example,
    name: r.topClaimers[0]?.name ?? null,
    suffix: r.topSuffix?.suffix ?? null,
    fee: feeText(r.fields),
    threshold: round((r.fields.migrationQuoteThreshold as number) / 1e9, 2),
    pools: r.pools,
    completed: r.completed,
    bytes: bytesOf(r.example),
  }))
  .filter((p) => p.bytes);

const all = census.designs;
const sum = (xs: Row[], f: (r: Row) => number) => xs.reduce((s, r) => s + f(r), 0);
const cheap = all.filter((r) => (cheapest(r) ?? 1) < 0.02);
const dear = all.filter((r) => (cheapest(r) ?? 0) >= 0.1);
const headline = {
  cheap: { designs: cheap.length, pools: sum(cheap, (r) => r.pools), completed: sum(cheap, (r) => r.completed) },
  dear: { designs: dear.length, pools: sum(dear, (r) => r.pools), completed: sum(dear, (r) => r.completed) },
};
// Tokens that present themselves as another venue's: mints ending in "pump" or "bonk", minted through DBC.
const lookalike = all.filter((r) => r.topSuffix && ["pump", "bonk"].includes(r.topSuffix.suffix));
const lookalikes = {
  designs: lookalike.length,
  pools: sum(lookalike, (r) => Math.round(r.pools * r.topSuffix!.share)),
  completedShare: sum(lookalike, (r) => r.completed) / Math.max(1, sum(lookalike, (r) => r.pools)),
};
writeFileSync(new URL("evidence.json", web), JSON.stringify({ totals: census.totals, headline, lookalikes, designs, presets }));
console.log("lookalikes", lookalikes);
console.log(`${designs.length} designs with 100+ pools, ${presets.length} presets`);
console.log(headline);
for (const p of presets) console.log(`  ${p.hash} ${String(p.pools).padStart(6)} pools ${((100 * p.completed) / p.pools).toFixed(1).padStart(5)}% done  thr ${p.threshold}  ${p.fee}  ${p.name ?? ""}`);
