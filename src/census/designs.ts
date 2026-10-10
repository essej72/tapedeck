// From the raw census to the question it answers: how is DBC actually configured on mainnet, what happened to the
// launches under each design, and what would it have cost to fake a graduation there.
//
//   node src/census/designs.ts          # writes web/data/census.json and prints the head of the table
//
// A "design" is a set of configs with identical trading mechanics: everything in the account from pool_fees on,
// plus the quote mint. Who collects the fees does not matter to it, so one design can span many launchpads.

import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import bs58 from "bs58";
import { walkAway, type WalkAway } from "../engine/buyout.ts";
import { decodeConfig } from "../engine/codec.ts";
import { Rpc } from "../rpc.ts";
import { designHash, readConfig, type ConfigFields } from "./fields.ts";
import { CENSUS_DB } from "./pull.ts";

const SOL = "So11111111111111111111111111111111111111112";
const KNOWN_DECIMALS: Record<string, number> = { [SOL]: 9, EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6 };
const KNOWN_SYMBOL: Record<string, string> = { [SOL]: "SOL", EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC", Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT" };

type Cost = Pick<WalkAway, "spend" | "feeRate" | "feeBackToCreator" | "lpNow" | "lpLater" | "lpNever" | "cost" | "costShare">;
type Design = {
  hash: string;
  example: string;
  fields: ConfigFields;
  quoteDecimals: number;
  configs: number;
  claimers: Map<string, number>;
  creators: Set<string>;
  pools: number;
  traded: number;
  completed: number;
  migrated: number;
  quoteFees: number;
  quoteRaised: number;
  firstTs: number;
  lastTs: number;
  secs: number[];
  seen: number;
  suffixes: Map<string, number>;
  costs: Record<"creatorAtLaunch" | "operatorAtLaunch" | "creatorPatient" | "operatorPatient", Cost | null>;
};

const slim = (w: WalkAway): Cost | null =>
  w.spend === null ? null : { spend: w.spend, feeRate: w.feeRate, feeBackToCreator: w.feeBackToCreator, lpNow: w.lpNow, lpLater: w.lpLater, lpNever: w.lpNever, cost: w.cost, costShare: w.costShare };

function costsOf(data: Buffer, f: ConfigFields, quoteDecimals: number): Design["costs"] {
  try {
    const config = decodeConfig(data);
    const wait = f.baseFeeMode === 2 ? 0 : f.feeDuration; // a scheduler runs out; a rate limiter charges by size
    return {
      creatorAtLaunch: slim(walkAway(config, { quoteDecimals })),
      operatorAtLaunch: slim(walkAway(config, { quoteDecimals, ownsPartnerSide: true })),
      creatorPatient: slim(walkAway(config, { quoteDecimals, wait })),
      operatorPatient: slim(walkAway(config, { quoteDecimals, wait, ownsPartnerSide: true })),
    };
  } catch {
    return { creatorAtLaunch: null, operatorAtLaunch: null, creatorPatient: null, operatorPatient: null };
  }
}

/** Slot -> unix time, from block times sampled across the range and interpolated between them. */
async function slotClock(db: DatabaseSync, minSlot: number, maxSlot: number): Promise<(slot: number) => number> {
  db.exec("CREATE TABLE IF NOT EXISTS slot_time (slot INTEGER PRIMARY KEY, ts INTEGER)");
  const have = () => db.prepare("SELECT slot, ts FROM slot_time ORDER BY slot").all() as { slot: number; ts: number }[];
  const wanted = Array.from({ length: 61 }, (_, i) => Math.round(minSlot + ((maxSlot - minSlot) * i) / 60));
  const step = (maxSlot - minSlot) / 60;
  const rpc = new Rpc(undefined, 600);
  const put = db.prepare("INSERT OR REPLACE INTO slot_time VALUES (?, ?)");
  for (const slot of wanted) {
    if (have().some((a) => Math.abs(a.slot - slot) < step / 2)) continue;
    for (let k = 0; k < 12; k++) {
      const ts = await rpc.call<number | null>("getBlockTime", [slot - k]).catch(() => null);
      if (ts) {
        put.run(slot - k, ts);
        break;
      }
    }
  }
  const anchors = have();
  if (anchors.length < 2) throw new Error("no block times available to date slots");
  return (slot) => {
    let i = anchors.findIndex((a) => a.slot >= slot);
    if (i <= 0) i = i === 0 ? 1 : anchors.length - 1;
    const [a, b] = [anchors[i - 1], anchors[i]];
    return a.ts + ((slot - a.slot) * (b.ts - a.ts)) / (b.slot - a.slot);
  };
}

function partnerNames(db: DatabaseSync): Map<string, { name: string; website: string }> {
  const out = new Map<string, { name: string; website: string }>();
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE name = 'partners'").get();
  if (!exists) return out;
  for (const r of db.prepare("SELECT data FROM partners").all()) {
    const d = Buffer.from(r.data as Uint8Array);
    try {
      let at = 8 + 32 + 96;
      const str = () => {
        const n = d.readUInt32LE(at);
        const s = d.subarray(at + 4, at + 4 + n).toString("utf8");
        at += 4 + n;
        return s;
      };
      out.set(bs58.encode(d.subarray(8, 40)), { name: str(), website: str() });
    } catch {
      /* malformed metadata: skip */
    }
  }
  return out;
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

const db = new DatabaseSync(CENSUS_DB);
const designs = new Map<string, Design>();
const byConfig = new Map<string, Design>();
let configCount = 0;
let claimerIsNotReceiver = 0;
for (const r of db.prepare("SELECT address, data FROM configs").iterate()) {
  const data = Buffer.from(r.data as Uint8Array);
  // fee_claimer (offset 40) against leftover_receiver (offset 72): the SDK's getPoolConfigsByOwner filters on the latter
  if (!data.subarray(40, 72).equals(data.subarray(72, 104))) claimerIsNotReceiver++;
  const hash = designHash(data);
  let d = designs.get(hash);
  if (!d) {
    const fields = readConfig(data);
    const quoteDecimals = KNOWN_DECIMALS[fields.quoteMint] ?? 9;
    d = {
      hash, example: bs58.encode(r.address as Uint8Array), fields, quoteDecimals, configs: 0, claimers: new Map(), creators: new Set(),
      pools: 0, traded: 0, completed: 0, migrated: 0, quoteFees: 0, quoteRaised: 0, firstTs: Infinity, lastTs: 0, secs: [], seen: 0, suffixes: new Map(),
      costs: costsOf(data, fields, quoteDecimals),
    };
    designs.set(hash, d);
  }
  d.configs++;
  configCount++;
  byConfig.set(Buffer.from(r.address as Uint8Array).toString("hex"), d);
  // remember each config's claimer under its own key so pools can be credited to a launchpad
  (d as any)[`c:${Buffer.from(r.address as Uint8Array).toString("hex")}`] = bs58.encode(data.subarray(40, 72));
}
console.log(`${configCount} configs, ${designs.size} distinct designs`);

const range = db.prepare("SELECT MIN(activation_point) lo, MAX(activation_point) hi FROM pools WHERE activation_point < 1e9 AND activation_point > 1e8").get() as { lo: number; hi: number };
const toTs = await slotClock(db, range.lo, range.hi);

let poolCount = 0;
let orphan = 0;
for (const p of db.prepare("SELECT config, creator, base_mint, quote_reserve, activation_point, is_migrated, migration_progress, total_trading_quote_fee, total_protocol_quote_fee, total_trading_base_fee, finish_curve_timestamp FROM pools").iterate()) {
  poolCount++;
  const key = Buffer.from(p.config as Uint8Array).toString("hex");
  const d = byConfig.get(key);
  if (!d) {
    orphan++;
    continue;
  }
  const unit = 10 ** d.quoteDecimals;
  const completed = (p.migration_progress as number) >= 1;
  d.pools++;
  if (completed || (p.quote_reserve as number) > 0 || (p.total_trading_quote_fee as number) > 0 || (p.total_trading_base_fee as number) > 0) d.traded++;
  if (completed) d.completed++;
  if (p.is_migrated) d.migrated++;
  d.quoteFees += ((p.total_trading_quote_fee as number) + (p.total_protocol_quote_fee as number)) / unit;
  d.quoteRaised += (p.quote_reserve as number) / unit;
  const ts = d.fields.activationType === 1 ? (p.activation_point as number) : toTs(p.activation_point as number);
  if (ts < d.firstTs) d.firstTs = ts;
  if (ts > d.lastTs) d.lastTs = ts;
  if (completed && (p.finish_curve_timestamp as number) > 0) {
    // reservoir sample of launch-to-completion times
    d.seen++;
    const dt = Math.max(0, (p.finish_curve_timestamp as number) - ts);
    if (d.secs.length < 3000) d.secs.push(dt);
    else if (Math.random() < 3000 / d.seen) d.secs[Math.floor(Math.random() * 3000)] = dt;
  }
  // Launchpads mint vanity addresses; the last four characters are how a token presents itself to a terminal.
  const suffix = bs58.encode(p.base_mint as Uint8Array).slice(-4);
  d.suffixes.set(suffix, (d.suffixes.get(suffix) ?? 0) + 1);
  if (d.suffixes.size > 4000) for (const [k, v] of d.suffixes) if (v === 1) d.suffixes.delete(k);
  if (d.creators.size < 50_000) d.creators.add(Buffer.from(p.creator as Uint8Array).subarray(0, 8).toString("hex"));
  const claimer = (d as any)[`c:${key}`] as string;
  d.claimers.set(claimer, (d.claimers.get(claimer) ?? 0) + 1);
}
console.log(`${poolCount} pools, ${orphan} under configs not in the census`);

const names = partnerNames(db);
const all = [...designs.values()].filter((d) => d.pools > 0).sort((a, b) => b.pools - a.pools);
const row = (d: Design) => {
  const top = [...d.claimers].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const { sqrtStartPrice, migrationSqrtPrice, feeClaimer, ...fields } = d.fields;
  return {
    hash: d.hash,
    example: d.example,
    quote: KNOWN_SYMBOL[d.fields.quoteMint] ?? d.fields.quoteMint.slice(0, 4) + "...",
    quoteDecimals: d.quoteDecimals,
    fields,
    configs: d.configs,
    claimers: d.claimers.size,
    topClaimers: top.map(([address, pools]) => ({ address, pools, name: names.get(address)?.name ?? null, website: names.get(address)?.website ?? null })),
    creators: d.creators.size,
    pools: d.pools,
    traded: d.traded,
    completed: d.completed,
    migrated: d.migrated,
    quoteFees: Math.round(d.quoteFees * 100) / 100,
    quoteRaised: Math.round(d.quoteRaised * 100) / 100,
    firstTs: Math.round(d.firstTs),
    lastTs: Math.round(d.lastTs),
    medianSecsToComplete: median(d.secs),
    shareCompletedWithin10s: d.secs.length ? d.secs.filter((s) => s <= 10).length / d.secs.length : null,
    topSuffix: (() => {
      const [suffix, n] = [...d.suffixes].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
      return n / d.pools >= 0.2 ? { suffix, share: Math.round((n / d.pools) * 1000) / 1000 } : null;
    })(),
    costs: d.costs,
  };
};
const totals = {
  generatedAt: new Date().toISOString(),
  configs: configCount,
  configsWhereClaimerIsNotReceiver: claimerIsNotReceiver,
  designs: designs.size,
  designsWithPools: all.length,
  pools: poolCount,
  poolsUnderUnknownConfigs: orphan,
  traded: all.reduce((s, d) => s + d.traded, 0),
  completed: all.reduce((s, d) => s + d.completed, 0),
  migrated: all.reduce((s, d) => s + d.migrated, 0),
};
const out = new URL("../../web/data/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("census.json", out), JSON.stringify({ totals, designs: all.slice(0, 600).map(row) }));
writeFileSync(new URL("census_all.json", out), JSON.stringify({ totals, designs: all.map(row) }));
console.log(totals);
const pct = (x: number | null | undefined) => (x == null ? "    n/a" : (100 * x).toFixed(1).padStart(6) + "%");
for (const d of all.slice(0, 30)) {
  const r = row(d);
  console.log(
    `${d.hash.slice(0, 6)} pools ${String(d.pools).padStart(6)} cfgs ${String(d.configs).padStart(6)} claimers ${String(d.claimers.size).padStart(6)} done ${pct(d.completed / d.pools)} <=10s ${pct(r.shareCompletedWithin10s)} | fake: creator ${pct(d.costs.creatorAtLaunch?.costShare)} operator ${pct(d.costs.operatorAtLaunch?.costShare)} patient op ${pct(d.costs.operatorPatient?.costShare)} | ${r.quote} thr ${(d.fields.migrationQuoteThreshold / 10 ** d.quoteDecimals).toFixed(1)} fee ${d.fields.startFeeBps.toFixed(0)}->${d.fields.endFeeBps.toFixed(0)} ${r.topClaimers[0]?.name ?? ""}`,
  );
}
