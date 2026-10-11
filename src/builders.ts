// Does the live program take what the SDK's curve builders build?
//
//   node src/builders.ts run [designs, default 300] [--sdk data/sdk.mjs] [--out data/builders.jsonl]
//   node src/builders.ts report [--file data/builders.jsonl]
//
// The deck's own dry run (dryrun.ts) covers the settings of its form. This one covers the builders themselves: random
// inputs over all six curve builders, both token programs, base decimals 6 to 9, SOL and USDC quotes, every fee
// scheduler, migration fee and liquidity split. Each input goes through a builder of the SDK under test (the
// installed one, or any checkout bundled by scripts/bundle-sdk.mjs), then through its createConfig, and a public node
// simulates the transaction against the live program. Nothing is signed or sent.
//
// Three things can happen to an input, and the report keeps them apart:
//   the SDK refuses it          (a builder or its validation throws: nothing unusable reaches the user)
//   the program refuses it      (the builder returned a config the program will not store)
//   the program stores it       (and then: is what it stored what the SDK said it would be, and what was asked for?)

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, type Transaction } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";
import { dryRun } from "./deploy.ts";
import { configFromBytes } from "./engine/bytes.ts";
import { Rpc, RPC_URL } from "./rpc.ts";

const MINTS = { SOL: "So11111111111111111111111111111111111111112", USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } as const;
const QUOTE_DECIMALS = { SOL: 9, USDC: 6 } as const;
// With signature checks off any funded address can stand in as payer; these are large exchange wallets. Untouched.
const PAYERS = ["5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS"];

const BUILDERS = ["buildCurve", "buildCurveWithMarketCap", "buildCurveWithTwoSegments", "buildCurveWithMidPrice", "buildCurveWithLiquidityWeights", "buildCurveWithCustomSqrtPrices"] as const;
type Builder = (typeof BUILDERS)[number];
/** One input: which builder, what it is quoted in, and the builder's argument (custom prices are kept as numbers). */
export type Design = { n: number; builder: Builder; quote: keyof typeof MINTS; input: Record<string, any>; prices?: number[] };

// ---------------------------------------------------------------- random inputs, repeatable

let seed = 20261011;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const between = (lo: number, hi: number, step = 1) => Math.round((lo + rnd() * (hi - lo)) / step) * step;
const round = (x: number, digits: number) => Number(x.toPrecision(digits));

function liquiditySplit() {
  // partner, creator, partner locked, creator locked: percentages of the migrated liquidity
  const fixed = pick<number[] | null>([[0, 0, 100, 0], [0, 0, 100, 0], [0, 0, 0, 100], [0, 0, 50, 50], [45, 45, 10, 0], [0, 90, 10, 0], [50, 50, 0, 0], [20, 20, 30, 30], null, null]);
  if (fixed) return fixed;
  const a = between(0, 100);
  const b = between(0, 100 - a);
  const c = between(0, 100 - a - b);
  return [a, b, c, 100 - a - b - c];
}

function randomDesign(n: number): Design {
  const quote = rnd() < 0.75 ? "SOL" : "USDC";
  const unit = quote === "SOL" ? 1 : 150; // about one SOL, in quote tokens
  const decimals = pick([6, 6, 6, 7, 8, 9, 9]);
  const supply = pick([1e9, 1e9, 1e9, 1e9, 1e8, 1e7, 1e6, 1e10]);
  const end = pick([25, 50, 100, 125, 200, 500, 1000]);
  const scheduled = rnd() < 0.5;
  const [partner, creator, partnerLocked, creatorLocked] = liquiditySplit();
  const feeOption = pick([0, 1, 2, 3, 4, 5, 6, 6]);
  const vested = rnd() < 0.2 ? supply * pick([0.05, 0.1, 0.2]) : 0;
  const base: Record<string, any> = {
    token: { tokenType: pick([0, 0, 1]), tokenBaseDecimal: decimals, tokenQuoteDecimal: QUOTE_DECIMALS[quote], tokenAuthorityOption: pick([0, 1, 1, 1, 2, 2, 0, 1, 3, 4]), totalTokenSupply: supply, leftover: pick([0, 1, 1000, supply * 0.001, supply * 0.01, supply * 0.05]) },
    fee: {
      baseFeeParams: {
        baseFeeMode: scheduled ? pick([0, 1]) : 0,
        feeSchedulerParam: scheduled ? { startingFeeBps: pick([between(end, 9900), 5000, 9000, 9900]), endingFeeBps: end, numberOfPeriod: pick([1, 10, 60, 100, 600]), totalDuration: pick([600, 600, 3600, 86400, 60, 10]) } : { startingFeeBps: end, endingFeeBps: end, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: rnd() < 0.3,
      collectFeeMode: pick([0, 0, 1]),
      creatorTradingFeePercentage: pick([0, 0, 10, 50, 100, between(0, 100)]),
      poolCreationFee: pick([0, 0, 0, 0.01, 0.1, 1]),
      enableFirstSwapWithMinFee: rnd() < 0.2,
    },
    migration: {
      migrationOption: 1,
      migrationFeeOption: feeOption,
      migrationFee: pick([{ feePercentage: 0, creatorFeePercentage: 0 }, { feePercentage: 0, creatorFeePercentage: 0 }, { feePercentage: 1, creatorFeePercentage: 0 }, { feePercentage: 5, creatorFeePercentage: 50 }, { feePercentage: 10, creatorFeePercentage: 100 }, { feePercentage: between(0, 50), creatorFeePercentage: between(0, 100) }]),
      ...(feeOption === 6 ? { migratedPoolFee: { collectFeeMode: pick([0, 0, 1]), dynamicFee: pick([0, 1]), poolFeeBps: pick([10, 25, 100, 250, 1000]) } } : {}),
    },
    liquidityDistribution: { partnerLiquidityPercentage: partner, creatorLiquidityPercentage: creator, partnerPermanentLockedLiquidityPercentage: partnerLocked, creatorPermanentLockedLiquidityPercentage: creatorLocked },
    lockedVesting: vested
      ? { totalLockedVestingAmount: vested, numberOfVestingPeriod: pick([1, 12, 365]), cliffUnlockAmount: vested * pick([0, 0.1]), totalVestingDuration: pick([30, 365]) * 86400, cliffDurationFromMigrationTime: pick([0, 86400]) }
      : { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: pick([0, 1]),
  };
  const builder = pick(BUILDERS);
  const initialMarketCap = round(unit * pick([27.96, between(5, 200, 0.5), between(20, 60, 0.01)]), 6);
  const migrationMarketCap = round(initialMarketCap * pick([2, 5, 14.7, between(2, 60, 0.5), 100]), 6);
  // A single constant-product segment between two market caps leaves this share of supply for the migrated pool;
  // the segmented builders only have solutions near it.
  const ratio = Math.sqrt(initialMarketCap / migrationMarketCap);
  const natural = (100 * ratio) / (1 + ratio);
  const percentageSupplyOnMigration = builder === "buildCurve" ? pick([10, 15, 20, 20.69, 25, 30, between(2, 50)]) : round(natural * pick([0.6, 0.8, 0.9, 1, 1, 1.1, 1.25, 1.5, between(0.3, 3, 0.01)]), 4);
  if (builder === "buildCurve") return { n, builder, quote, input: { ...base, percentageSupplyOnMigration, migrationQuoteThreshold: round(unit * pick([10, 50, 85, 100, 250, 500, between(5, 2000)]), 6) } };
  if (builder === "buildCurveWithMarketCap") return { n, builder, quote, input: { ...base, initialMarketCap, migrationMarketCap } };
  if (builder === "buildCurveWithTwoSegments") return { n, builder, quote, input: { ...base, initialMarketCap, migrationMarketCap, percentageSupplyOnMigration } };
  const p0 = initialMarketCap / supply;
  const p1 = migrationMarketCap / supply;
  if (builder === "buildCurveWithMidPrice") return { n, builder, quote, input: { ...base, initialMarketCap, migrationMarketCap, percentageSupplyOnMigration, midPrice: round(Math.sqrt(p0 * p1) * pick([0.7, 0.85, 1, 1, 1.2, 1.4, 0.4, 2.5]), 8) } };
  if (builder === "buildCurveWithLiquidityWeights") {
    const a = pick([0.6, 0.8, 1, 1.2, 1.5, 1.8]);
    return { n, builder, quote, input: { ...base, initialMarketCap, migrationMarketCap, liquidityWeights: Array.from({ length: 16 }, (_, i) => round(a ** i, 8)) } };
  }
  const segments = pick([1, 2, 3, 5, 8]);
  const prices = Array.from({ length: segments + 1 }, (_, i) => round(p0 * (p1 / p0) ** (i / segments), 10));
  return { n, builder, quote, prices, input: { ...base, ...(rnd() < 0.5 ? { liquidityWeights: Array.from({ length: segments }, () => between(1, 5)) } : {}) } };
}

export function designs(count: number): Design[] {
  seed = 20261011;
  return Array.from({ length: count }, (_, i) => randomDesign(i + 1));
}

// ---------------------------------------------------------------- one input through one SDK

type Sdk = Record<string, any>;
export type Outcome = {
  n: number;
  builder: Builder;
  quote: string;
  /** Where it stopped: the SDK refused it, the program refused it, or the program stored it. */
  stage: "sdk" | "program" | "stored";
  error?: string;
  /** Stored, but not as the SDK's own helpers derive it from the builder's output. */
  differs?: string[];
  /** Asked-for market caps against the ones the stored prices give, as relative errors. */
  capError?: { initial: number; migration: number };
  data?: string;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 110);

/** The builder's output for a design, or the SDK's refusal. */
export function build(sdk: Sdk, d: Design): { params?: Record<string, any>; error?: string } {
  if (typeof sdk[d.builder] !== "function") return { error: `this SDK has no ${d.builder}` };
  try {
    const input = d.prices ? { ...d.input, sqrtPrices: sdk.createSqrtPrices(d.prices, d.input.token.tokenBaseDecimal, d.input.token.tokenQuoteDecimal) } : d.input;
    return { params: sdk[d.builder](input) };
  } catch (e) {
    return { error: message(e) };
  }
}

/** Field by field: where a stored config is not what the SDK's own helpers say the builder's output becomes. */
export function storedDifferences(sdk: Sdk, params: Record<string, any>, stored: Uint8Array): string[] {
  const s = configFromBytes(stored) as Record<string, any>;
  const out: string[] = [];
  const same = (label: string, mine: unknown, theirs: unknown) => {
    if (String(mine) !== String(theirs)) out.push(`${label}: SDK ${String(mine)}, program ${String(theirs)}`);
  };
  // what was sent is what was stored
  same("sqrtStartPrice", params.sqrtStartPrice, s.sqrtStartPrice);
  same("migrationQuoteThreshold", params.migrationQuoteThreshold, s.migrationQuoteThreshold);
  for (let i = 0; i < 20; i++) {
    same(`curve[${i}].sqrtPrice`, params.curve[i]?.sqrtPrice ?? 0, s.curve[i].sqrtPrice);
    same(`curve[${i}].liquidity`, params.curve[i]?.liquidity ?? 0, s.curve[i].liquidity);
  }
  for (const k of ["cliffFeeNumerator", "firstFactor", "secondFactor", "thirdFactor", "baseFeeMode"]) same(`baseFee.${k}`, params.poolFees.baseFee[k], s.poolFees.baseFee[k]);
  same("dynamicFee", params.poolFees.dynamicFee ? 1 : 0, s.poolFees.dynamicFee.initialized);
  for (const k of ["collectFeeMode", "activationType", "tokenDecimal", "tokenType", "partnerLiquidityPercentage", "creatorLiquidityPercentage", "partnerPermanentLockedLiquidityPercentage", "creatorPermanentLockedLiquidityPercentage", "migrationFeeOption", "creatorTradingFeePercentage", "tokenUpdateAuthority"]) same(k, params[k], s[k]);
  same("migrationFeePercentage", params.migrationFee.feePercentage, s.migrationFeePercentage);
  same("creatorMigrationFeePercentage", params.migrationFee.creatorFeePercentage, s.creatorMigrationFeePercentage);
  same("enableFirstSwapWithMinFee", params.enableFirstSwapWithMinFee ? 1 : 0, s.enableFirstSwapWithMinFee);
  if (params.tokenSupply) {
    same("preMigrationTokenSupply", params.tokenSupply.preMigrationTokenSupply, s.preMigrationTokenSupply);
    same("postMigrationTokenSupply", params.tokenSupply.postMigrationTokenSupply, s.postMigrationTokenSupply);
  }
  // what the program derives is what the SDK's helpers derive
  let migrationSqrtPrice: BN;
  try {
    migrationSqrtPrice = sdk.getMigrationThresholdPrice(params.migrationQuoteThreshold, params.sqrtStartPrice, params.curve);
  } catch (e) {
    out.push(`migrationSqrtPrice: SDK throws (${message(e)}), program ${s.migrationSqrtPrice}`);
    return out;
  }
  same("migrationSqrtPrice", migrationSqrtPrice, s.migrationSqrtPrice);
  const fee = params.migrationFee.feePercentage;
  // SDK 2.0 names the helper after the threshold and returns an integer; 1.5 returns a decimal, floored here.
  const quoteAmount: BN = sdk.getMigrationQuoteAmountFromThreshold ? sdk.getMigrationQuoteAmountFromThreshold(params.migrationQuoteThreshold, fee) : new BN(sdk.getMigrationQuoteAmountFromMigrationQuoteThreshold(new Decimal(params.migrationQuoteThreshold.toString()), fee).floor().toFixed());
  try {
    same("migrationBaseThreshold", sdk.getMigrationBaseToken(quoteAmount, migrationSqrtPrice, params.migrationOption, params.migratedPoolFee?.collectFeeMode), s.migrationBaseThreshold);
    same("swapBaseAmount", sdk.getBaseTokenForSwap(params.sqrtStartPrice, migrationSqrtPrice, params.curve), s.swapBaseAmount);
  } catch (e) {
    out.push(`migration amounts: SDK throws (${message(e)})`);
  }
  return out;
}

/** The migration quote amount as the program takes it from the threshold: what is left after the migration fee, rounded up. */
export const programQuoteAmount = (threshold: BN, feePercentage: number): BN => threshold.mul(new BN(100 - feePercentage)).addn(99).divn(100);

/**
 * The program's rule for a fixed supply (process_create_config), applied to a builder's output with the SDK's own
 * helpers: the supply after migration must cover the tokens on the curve, the migration base and the vesting, and
 * the supply before it must cover the same with the curve's buffer. Returns what is short, or null when it fits.
 */
export function supplyShortfall(sdk: Sdk, params: Record<string, any>): string | null {
  if (!params.tokenSupply) return null;
  const price: BN = sdk.getMigrationThresholdPrice(params.migrationQuoteThreshold, params.sqrtStartPrice, params.curve);
  const migration: BN = sdk.getMigrationBaseToken(programQuoteAmount(params.migrationQuoteThreshold, params.migrationFee.feePercentage), price, params.migrationOption, params.migratedPoolFee?.collectFeeMode);
  const swap: BN = sdk.getBaseTokenForSwap(params.sqrtStartPrice, price, params.curve);
  const v = params.lockedVesting;
  const vesting: BN = v.amountPerPeriod.mul(new BN(v.numberOfPeriod)).add(v.cliffUnlockAmount);
  const { preMigrationTokenSupply: pre, postMigrationTokenSupply: post } = params.tokenSupply;
  const need = swap.add(migration).add(vesting);
  const buffered = sdk.getSwapAmountWithBuffer(swap, params.sqrtStartPrice, params.curve).add(migration).add(vesting);
  if (need.gt(post)) return `the supply after migration is ${need.sub(post)} base units short`;
  if (post.gt(pre)) return "the supply after migration is larger than the supply before it";
  if (buffered.gt(pre)) return `the supply before migration is ${buffered.sub(pre)} base units short of the buffered minimum`;
  return null;
}

/** Market caps asked for against the ones the stored start and migration prices give. */
function capErrors(sdk: Sdk, d: Design, stored: Uint8Array) {
  if (d.input.initialMarketCap == null) return undefined;
  const s = configFromBytes(stored) as Record<string, any>;
  const cap = (sqrtPrice: BN) => new Decimal(sdk.getPriceFromSqrtPrice(sqrtPrice, d.input.token.tokenBaseDecimal, d.input.token.tokenQuoteDecimal).toString()).mul(d.input.token.totalTokenSupply).toNumber();
  return { initial: cap(s.sqrtStartPrice) / d.input.initialMarketCap - 1, migration: cap(s.migrationSqrtPrice) / d.input.migrationMarketCap - 1 };
}

// ---------------------------------------------------------------- commands

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sdkPath = flag("--sdk");
const sdkName = sdkPath ?? "the installed SDK";
const loadSdk = async (): Promise<Sdk> => (sdkPath ? await import(new URL(`file://${process.cwd().replace(/\\/g, "/")}/${sdkPath}`).href) : await import("@meteora-ag/dynamic-bonding-curve-sdk"));

function summarize(rows: Outcome[]) {
  const by = (stage: Outcome["stage"]) => rows.filter((r) => r.stage === stage);
  const stored = by("stored");
  const reasons = (xs: Outcome[]) => {
    const m = new Map<string, number>();
    for (const r of xs) m.set(r.error ?? "", (m.get(r.error ?? "") ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([why, count]) => ({ why, count }));
  };
  const caps = stored.filter((r) => r.capError);
  const worst = (k: "initial" | "migration") => caps.reduce((m, r) => Math.max(m, Math.abs(r.capError![k])), 0);
  return {
    designs: rows.length,
    refusedBySdk: by("sdk").length,
    refusedByProgram: by("program").length,
    stored: stored.length,
    storedAsDerived: stored.filter((r) => !r.differs?.length).length,
    storedDifferently: stored.filter((r) => r.differs?.length).length,
    /** Stored, and the only field that differs is the migration base, by the rounding of the quote amount. */
    storedMigrationBaseOnly: stored.filter((r) => r.differs?.length && r.differs.every((x) => x.startsWith("migrationBaseThreshold"))).length,
    worstInitialCapError: worst("initial"),
    worstMigrationCapError: worst("migration"),
    /** Stored configs whose migration market cap is more than 0.1% off the one asked for. */
    migrationCapOff: caps.filter((r) => Math.abs(r.capError!.migration) > 1e-3).length,
    withMarketCaps: caps.length,
    byBuilder: BUILDERS.map((b) => ({ builder: b, designs: rows.filter((r) => r.builder === b).length, refusedBySdk: by("sdk").filter((r) => r.builder === b).length, refusedByProgram: by("program").filter((r) => r.builder === b).length, stored: stored.filter((r) => r.builder === b).length })),
    sdkReasons: reasons(by("sdk")),
    programReasons: reasons(by("program")),
  };
}

function print(rows: Outcome[], name: string) {
  const s = summarize(rows);
  console.log(`${name}: ${s.designs} builder inputs`);
  console.log(`  ${s.refusedBySdk} refused by the SDK before anything is sent`);
  console.log(`  ${s.refusedByProgram} built by the SDK and refused by the program`);
  console.log(`  ${s.stored} stored by the program: ${s.storedAsDerived} exactly as the SDK's helpers derive, ${s.storedDifferently} differently`);
  console.log(`  market caps asked for against stored prices, worst relative error: start ${s.worstInitialCapError.toExponential(1)}, migration ${s.worstMigrationCapError.toExponential(1)}`);
  for (const b of s.byBuilder) console.log(`    ${b.builder.padEnd(32)} ${String(b.designs).padStart(4)} inputs  ${String(b.refusedBySdk).padStart(4)} SDK refuses  ${String(b.refusedByProgram).padStart(4)} program refuses  ${String(b.stored).padStart(4)} stored`);
  for (const r of s.programReasons) console.log(`  program: ${r.count} x ${r.why}`);
  for (const r of s.sdkReasons.slice(0, 12)) console.log(`  sdk: ${r.count} x ${r.why}`);
  const diff = rows.filter((r) => r.differs?.length);
  for (const r of diff.slice(0, 8)) console.log(`  differs: #${r.n} ${r.builder}: ${r.differs!.slice(0, 3).join(" | ")}`);
  return s;
}

const readRows = (file: string): Outcome[] => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

if (args[0] === "run") {
  const count = Number(args[1] && !args[1].startsWith("--") ? args[1] : 300);
  const out = flag("--out") ?? "data/builders.jsonl";
  const sdk = await loadSdk();
  const rpc = new Rpc(RPC_URL, 500);
  let payer: PublicKey | null = null;
  for (const a of PAYERS) {
    const acc = (await rpc.call<{ value: { owner: string; lamports: number; data: [string, string] } | null }>("getAccountInfo", [a, { encoding: "base64" }])).value;
    if (acc && acc.owner === SystemProgram.programId.toBase58() && acc.data[0] === "" && acc.lamports > 1e9) {
      payer = new PublicKey(a);
      break;
    }
  }
  if (!payer) throw new Error("no stand-in payer is a funded system account; edit PAYERS");
  const client = new sdk.DynamicBondingCurveClient(new Connection(RPC_URL, "confirmed"), "confirmed");
  const done = existsSync(out) ? new Set(readRows(out).map((r) => r.n)) : new Set<number>();
  for (const d of designs(count)) {
    if (done.has(d.n)) continue;
    const row: Outcome = { n: d.n, builder: d.builder, quote: d.quote, stage: "sdk" };
    const built = build(sdk, d);
    if (!built.params) row.error = built.error;
    else {
      const config = Keypair.generate().publicKey; // an address for the account to be; its key is thrown away
      let tx: Transaction | null = null;
      try {
        tx = await client.partner.createConfig({ config, feeClaimer: payer, leftoverReceiver: payer, quoteMint: new PublicKey(MINTS[d.quote]), payer, ...built.params });
        tx!.feePayer = payer;
      } catch (e) {
        row.error = message(e);
      }
      if (tx) {
        await new Promise((r) => setTimeout(r, 450));
        const run = await dryRun(RPC_URL, tx, config);
        if (!run.ok || !run.data) {
          row.stage = "program";
          row.error = run.error ?? "no account returned";
        } else {
          row.stage = "stored";
          row.differs = storedDifferences(sdk, built.params, run.data);
          row.capError = capErrors(sdk, d, run.data);
          row.data = Buffer.from(run.data).toString("base64");
        }
      }
    }
    appendFileSync(out, JSON.stringify(row) + "\n");
    if (row.stage !== "stored" || row.differs?.length) console.log(`#${d.n} ${d.builder} [${d.quote}] ${row.stage}: ${row.error ?? row.differs!.slice(0, 2).join(" | ")}`);
  }
  print(readRows(out), sdkName);
} else if (args[0] === "report") {
  const file = flag("--file") ?? "data/builders.jsonl";
  print(readRows(file), flag("--name") ?? file);
} else if (args[0] === "compare") {
  // node src/builders.ts compare <installed-sdk rows> <other rows> <other bundle> <other name>
  // The same inputs through the installed SDK and another build: both summaries, outcome against outcome, and the
  // program's refusals checked against its own supply rule. Writes web/data/builders.json for the site and README.
  const [, fileA, fileB, bundleB, nameB] = args;
  const a = readRows(fileA);
  const b = readRows(fileB);
  const installed: Sdk = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const other: Sdk = await import(new URL(`file://${process.cwd().replace(/\\/g, "/")}/${bundleB}`).href);
  const all = designs(Math.max(a.length, b.length));
  const explain = (rows: Outcome[], sdk: Sdk) => {
    const refused = rows.filter((r) => r.stage === "program");
    const stored = rows.filter((r) => r.stage === "stored");
    const shortfall = (r: Outcome) => supplyShortfall(sdk, build(sdk, all[r.n - 1]).params!);
    const short = (r: Outcome) => shortfall(r) !== null;
    // how far short the refused ones are, in base units (the smallest unit of the token)
    const units = refused.map((r) => ({ units: Number(/(\d+) base units/.exec(shortfall(r) ?? "")?.[1] ?? NaN), decimals: all[r.n - 1].input.token.tokenBaseDecimal as number })).filter((x) => !Number.isNaN(x.units));
    const most = (f: (x: { units: number; decimals: number }) => number) => (units.length ? Math.max(...units.map(f)) : 0);
    return { refused: refused.length, refusedAndShort: refused.filter(short).length, stored: stored.length, storedAndShort: stored.filter(short).length, shortByMin: units.length ? Math.min(...units.map((x) => x.units)) : 0, shortByMax: most((x) => x.units), shortByMaxTokens: most((x) => x.units / 10 ** x.decimals) };
  };
  const inB = new Map(b.map((r) => [r.n, r]));
  const cross: Record<string, number> = {};
  for (const r of a) {
    const o = inB.get(r.n);
    if (o) cross[`${r.stage} -> ${o.stage}`] = (cross[`${r.stage} -> ${o.stage}`] ?? 0) + 1;
  }
  const truncated = a.filter((r) => r.stage === "stored" && r.capError && Math.abs(r.capError.migration) > 1e-3).map((r) => ({ n: r.n, builder: r.builder, percentage: all[r.n - 1].input.percentageSupplyOnMigration as number, error: r.capError!.migration }));
  const lost = a.filter((r) => r.stage === "stored" && inB.get(r.n)?.stage === "sdk").map((r) => ({ n: r.n, builder: r.builder, percentage: all[r.n - 1].input.percentageSupplyOnMigration as number | undefined, error: inB.get(r.n)!.error }));
  const previous = existsSync(new URL("../web/data/builders.json", import.meta.url)) ? JSON.parse(readFileSync(new URL("../web/data/builders.json", import.meta.url), "utf8")) : {};
  const result = {
    generatedAt: new Date().toISOString(),
    createConfig2: previous.createConfig2,
    installed: { name: "SDK 1.5.13", ...print(a, "SDK 1.5.13"), supplyRule: explain(a, installed) },
    other: { name: nameB, ...print(b, nameB), supplyRule: explain(b, other) },
    cross,
    lost,
    /** Stored configs of the installed SDK whose migration cap is off, with the percentage that was asked for. */
    truncated,
    truncationExplains: truncated.filter((t) => Math.abs(t.percentage / Math.floor(t.percentage) - 1 - t.error) < 1e-5).length,
  };
  console.log("outcome under 1.5.13 -> under the other build:", JSON.stringify(cross));
  console.log(`supply rule, 1.5.13: ${JSON.stringify(result.installed.supplyRule)}   other: ${JSON.stringify(result.other.supplyRule)}`);
  console.log(`migration cap off by more than 0.1% under 1.5.13: ${truncated.length}, of which percentage / floor(percentage) explains ${result.truncationExplains}`);
  writeFileSync(new URL("../web/data/builders.json", import.meta.url), JSON.stringify(result, null, 1));
} else if (args[0] === "config2") {
  // node src/builders.ts config2 --sdk data/sdk.mjs
  // Is create_config2, the instruction SDK 2.0 creates configs with, on mainnet yet? One simulation; the answer is
  // kept in web/data/builders.json.
  const sdk = await loadSdk();
  if (typeof sdk.DynamicBondingCurveClient?.prototype === "undefined") throw new Error("not an SDK bundle");
  const payer = new PublicKey(PAYERS[0]);
  const client = new sdk.DynamicBondingCurveClient(new Connection(RPC_URL, "confirmed"), "confirmed");
  if (typeof client.partner.createConfig2 !== "function") throw new Error(`${sdkName} has no createConfig2`);
  const d = designs(600).find((x) => x.builder === "buildCurveWithMarketCap" && build(sdk, x).params)!;
  const config = Keypair.generate().publicKey;
  const tx: Transaction = await client.partner.createConfig2({ config, feeClaimer: payer, leftoverReceiver: payer, quoteMint: new PublicKey(MINTS[d.quote]), payer, ...build(sdk, d).params, transferFeeParameters: null, totalTokenSupply: d.input.token.totalTokenSupply, leftover: d.input.token.leftover });
  tx.feePayer = payer;
  const run = await dryRun(RPC_URL, tx, config);
  const answer = { checkedAt: new Date().toISOString(), live: run.ok, error: run.error };
  console.log(`create_config2 on mainnet: ${run.ok ? "accepted" : `refused (${run.error})`}`);
  const file = new URL("../web/data/builders.json", import.meta.url);
  if (existsSync(file)) writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), createConfig2: answer }, null, 1));
} else if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, "/").split("/").pop() ?? "-")) {
  console.log("usage: node src/builders.ts run [designs] [--sdk data/sdk.mjs] [--out data/builders.jsonl]\n       node src/builders.ts report [--file data/builders.jsonl]\n       node src/builders.ts compare <installed-sdk rows> <other rows> <other bundle> <other name>\n       node src/builders.ts config2 --sdk data/sdk.mjs");
}
