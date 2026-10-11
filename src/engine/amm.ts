// The pool a completed curve migrates into, as far as a replay needs it.
//
// Exact here, and held against the chain by src/migration.ts: what moves into the new pool. The migration fee comes
// off the quote threshold; the protocol takes its liquidity fee (0.2% for pools created today, kept on each pool
// account); for DAMM v2 the liquidity that the remaining quote buys at the curve's last price then sets both
// deposits, as the program computes them, and for DAMM v1 or a compounding pool both sides simply lose the fee.
// Trading afterwards, in a DAMM v2 pool, is DAMM v2's own arithmetic: one liquidity over the whole price range,
// the price moved and the output read off as the program does it, the fee rounded up and taken in quote or from
// the output token as the config says, and DAMM v2's dynamic fee on top where the pool has one: every fixed fee
// tier does, a customizable config when it asks (cp-amm state/pool.rs, state/fee.rs). src/afterwards.ts holds that
// against real swaps in migrated pools. A config can also give the new pool a fee that steps down as the price
// climbs (DAMM v2's market-cap fee scheduler, cp-amm base_fee/fee_market_cap_scheduler.rs); that is applied too.
// A compounding DAMM v2 pool is plain constant product on what it holds, with a share of every fee left in the
// pool (cp-amm liquidity_handler/compounding_liquidity.rs). A DAMM v1 pool is modelled as two plain reserves with
// a flat fee, and is the one kind not held against the chain.

import { getDeltaAmountBaseUnsigned, getDeltaAmountQuoteUnsigned, getDynamicFeeParams, getFeeNumeratorOnExponentialFeeScheduler, getInitialLiquidityFromDeltaQuote, getNextSqrtPriceFromInput, getNextSqrtPriceFromOutput, MAX_SQRT_PRICE, MIN_SQRT_PRICE, mulDiv, Rounding, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";

const FEE_DENOMINATOR = new BN(1_000_000);
// DAMM v2 counts a fee in parts per billion
const DAMM_FEE_DENOMINATOR = new BN(1_000_000_000);
/** constants.rs PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS: what a pool created today carries. Older pools carry 0. */
export const PROTOCOL_LIQUIDITY_FEE_BPS = 20;
// MigrationFeeOption -> pool fee in bps (index 6 = customizable: the config's migratedPoolFeeBps).
const FIXED_POOL_FEE_BPS = [25, 30, 100, 200, 400, 600];
// MigratedCollectFeeMode
const OUTPUT_TOKEN = 1;
const COMPOUNDING = 2;
const ZERO = new BN(0);
const ONE_Q64 = new BN(1).shln(64);
const BASIS_POINTS = new BN(10_000);
// cp-amm constants: the fee can never pass half of the amount (fee version 0); the protocol takes a fifth of a fee
const DAMM_MAX_FEE_NUMERATOR = new BN(500_000_000);
const DAMM_PROTOCOL_FEE_PERCENT = 20;

/** floor(sqrt(quote / base)) as a Q64.64 sqrt price: how a compounding pool reads its price off what it holds. */
function sqrtPriceOf(base: BN, quote: BN, roundUp = false): BN {
  const [b, q] = [BigInt(base.toString()), BigInt(quote.toString()) << 128n];
  const x = roundUp ? (q + b - 1n) / b : q / b;
  let r = BigInt(Math.floor(Math.sqrt(Number(x))));
  while (r * r > x) r--;
  while ((r + 1n) * (r + 1n) <= x) r++;
  return new BN(r.toString());
}

/** DAMM v2's dynamic fee settings (cp-amm DynamicFeeStruct). */
export type DynamicFee = { binStep: number; binStepU128: BN; filterPeriod: number; decayPeriod: number; reductionFactor: number; maxVolatilityAccumulator: number; variableFeeControl: number };

/** DAMM v2's market-cap fee schedule: the fee falls one step for every `sqrtPriceStepBps` the sqrt price gains on its opening value. */
export type FeeSchedule = { exponential: boolean; numberOfPeriod: number; sqrtPriceStepBps: number; expirationDuration: number; reductionFactor: BN };

/** The schedule a config gives its migrated pool, or null (config.rs build_damm_v2_base_fee_params). */
export function migratedFeeSchedule(config: PoolConfig): FeeSchedule | null {
  const c = config as PoolConfig & MigrationFields & { migratedPoolBaseFeeMode?: number; migratedPoolBaseFeeBytes?: number[] | Uint8Array };
  const mode = c.migratedPoolBaseFeeMode ?? 0;
  if (c.migrationOption !== 1 || c.migrationFeeOption < FIXED_POOL_FEE_BPS.length || (mode !== 3 && mode !== 4) || !c.migratedPoolBaseFeeBytes) return null;
  const b = Buffer.from(c.migratedPoolBaseFeeBytes);
  return { exponential: mode === 4, numberOfPeriod: b.readUInt16LE(0), sqrtPriceStepBps: b.readUInt16LE(2), expirationDuration: b.readUInt32LE(4), reductionFactor: new BN(b.subarray(8, 16), "le") };
}

/** The scheduled fee after `period` steps, in parts per billion. */
function scheduledFee(cliff: BN, s: FeeSchedule, period: number): BN {
  const steps = Math.min(period, s.numberOfPeriod);
  return s.exponential ? getFeeNumeratorOnExponentialFeeScheduler(cliff, s.reductionFactor, steps) : cliff.sub(s.reductionFactor.muln(steps));
}

/**
 * The dynamic fee a config's migrated pool gets, or null. A fixed fee tier migrates into one of DAMM v2's public
 * configs, which have it on whatever the DBC config says; a customizable config gets it when it asks, sized by the
 * program from the pool fee (damm_v2_utils.rs calculate_dynamic_fee_params, the SDK's getDynamicFeeParams).
 */
export function migratedDynamicFee(config: PoolConfig): DynamicFee | null {
  const c = config as PoolConfig & MigrationFields & { migratedDynamicFee?: number; migratedPoolBaseFeeMode?: number };
  if (c.migrationOption !== 1) return null;
  const fixedTier = c.migrationFeeOption < FIXED_POOL_FEE_BPS.length;
  if (!fixedTier && c.migratedDynamicFee !== 1) return null;
  const p = getDynamicFeeParams(migratedPoolFeeBps(config));
  const d: DynamicFee = { binStep: p.binStep, binStepU128: p.binStepU128, filterPeriod: p.filterPeriod, decayPeriod: p.decayPeriod, reductionFactor: p.reductionFactor, maxVolatilityAccumulator: p.maxVolatilityAccumulator, variableFeeControl: p.variableFeeControl };
  // Under a fee schedule the program sizes the dynamic fee from the lowest fee the schedule reaches: a fifth of it
  // at the most volatile.
  const schedule = migratedFeeSchedule(config);
  if (schedule) {
    const lowest = scheduledFee(new BN(migratedPoolFeeBps(config) * 100_000), schedule, schedule.numberOfPeriod);
    const most = new BN(d.maxVolatilityAccumulator).muln(d.binStep).sqr();
    d.variableFeeControl = lowest.muln(20).divn(100).mul(new BN("100000000000")).sub(new BN("99999999999")).div(most).toNumber();
  }
  return d;
}

type MigrationFields = {
  migrationBaseThreshold: BN;
  migrationSqrtPrice: BN;
  migrationOption: number;
  migrationFeePercentage: number;
  migrationFeeOption: number;
  migratedPoolFeeBps: number;
  migratedCollectFeeMode: number;
  partnerLiquidityVestingInfo?: { vestingPercentage?: number };
};

export const migratedPoolFeeBps = (config: PoolConfig): number => {
  const c = config as PoolConfig & MigrationFields;
  return c.migrationFeeOption < FIXED_POOL_FEE_BPS.length ? FIXED_POOL_FEE_BPS[c.migrationFeeOption] : c.migratedPoolFeeBps;
};

export class MigratedPool {
  /** What the pool holds. At migration: exactly what moved into its vaults. */
  base: BN;
  quote: BN;
  /** DAMM v2 only: the liquidity over the whole price range (both positions together) and the current sqrt price. */
  liquidity: BN | null = null;
  sqrtPrice: BN | null = null;
  /** DAMM v2 only: the pool's dynamic fee settings, and what it remembers between swaps. */
  dynamic: DynamicFee | null = null;
  readonly volatility = { lastUpdate: 0, sqrtPriceReference: ZERO, accumulator: ZERO, reference: ZERO };
  /** DAMM v2 only: a fee that steps down as the price climbs from where the pool opened, until it expires. */
  schedule: FeeSchedule | null = null;
  /** When the pool opened (Unix seconds) and at what sqrt price: what a fee schedule counts from. */
  openedAt = 0;
  private opening: BN = ZERO;
  private clock = 0;
  /** A compounding DAMM v2 pool: this share of each trading fee (in basis points) stays in the pool. Null otherwise. */
  compounding: { feeBps: number } | null = null;
  /** Fee per million of each trade. */
  readonly feePpm: BN;
  /** True when the pool takes its fee from whatever the trade pays out; false when it always takes it in quote. */
  readonly feeOnOutput: boolean;
  /** Quote taken at migration as the config's migration fee. */
  readonly migrationFee: BN;
  /** The protocol's liquidity fee at migration, on each side. */
  readonly protocolFee: { base: BN; quote: BN };
  /** Fees collected in quote, and (when the fee is taken from the output) in tokens. */
  feesCollected = new BN(0);
  baseFeesCollected = new BN(0);

  /** `protocolFeeBps`: the pool account's protocol_liquidity_migration_fee_bps. */
  constructor(config: PoolConfig, protocolFeeBps: number = PROTOCOL_LIQUIDITY_FEE_BPS) {
    const c = config as PoolConfig & MigrationFields;
    const threshold = c.migrationQuoteThreshold;
    const kept = threshold.muln(100 - (c.migrationFeePercentage ?? 0)).addn(99).divn(100); // rounds up, as the program does
    this.migrationFee = threshold.sub(kept);
    const cut = (x: BN) => x.muln(protocolFeeBps).divn(10_000);
    const baseThreshold = c.migrationBaseThreshold ?? new BN(0);
    if (c.migrationOption === 1 && c.migratedCollectFeeMode !== COMPOUNDING && c.migrationSqrtPrice && !baseThreshold.isZero()) {
      // DAMM v2 (concentrated_liquidity.rs): the quote left after the protocol's cut is turned into liquidity at the
      // migration price, rounded down, and the pool takes the token amounts of that liquidity, rounded up.
      const price = c.migrationSqrtPrice;
      const afterCut = kept.sub(cut(kept));
      const liquidity = getInitialLiquidityFromDeltaQuote(afterCut, MIN_SQRT_PRICE, price);
      const amounts = (l: BN) => ({ base: getDeltaAmountBaseUnsigned(price, MAX_SQRT_PRICE, l, Rounding.Up), quote: getDeltaAmountQuoteUnsigned(MIN_SQRT_PRICE, price, l, Rounding.Up) });
      // Partner and creator each get a position. The larger share opens the pool; the other is sized from the quote
      // that is left, so splitting the liquidity can cost up to a lamport's worth of tokens (config.rs
      // get_liquidity_distribution, migrate_damm_v2_initialize_pool.rs).
      const share = (percentage: number | undefined) => liquidity.muln(percentage ?? 0).divn(100);
      const partner = share(c.partnerPermanentLockedLiquidityPercentage).add(share(c.partnerLiquidityVestingInfo?.vestingPercentage)).add(share(c.partnerLiquidityPercentage));
      const creator = liquidity.sub(partner);
      const firstLiquidity = partner.gt(creator) ? partner : creator;
      const first = amounts(firstLiquidity);
      const secondLiquidity = partner.isZero() || creator.isZero() ? new BN(0) : getInitialLiquidityFromDeltaQuote(afterCut.sub(first.quote), MIN_SQRT_PRICE, price);
      const second = secondLiquidity.isZero() ? { base: new BN(0), quote: new BN(0) } : amounts(secondLiquidity);
      this.quote = first.quote.add(second.quote);
      this.base = first.base.add(second.base);
      this.liquidity = firstLiquidity.add(secondLiquidity);
      this.sqrtPrice = price;
      this.opening = price;
      this.dynamic = migratedDynamicFee(config);
      this.schedule = migratedFeeSchedule(config);
      // the protocol's base cut is the base side of the liquidity its quote cut would have bought
      this.protocolFee = { quote: cut(kept), base: getDeltaAmountBaseUnsigned(price, MAX_SQRT_PRICE, getInitialLiquidityFromDeltaQuote(cut(kept), MIN_SQRT_PRICE, price), Rounding.Down) };
    } else {
      // DAMM v1 and compounding DAMM v2 (compounding_liquidity.rs): each side less the protocol's cut.
      this.protocolFee = { quote: cut(kept), base: cut(baseThreshold) };
      this.quote = kept.sub(this.protocolFee.quote);
      this.base = baseThreshold.sub(this.protocolFee.base);
      if (c.migrationOption === 1 && c.migratedCollectFeeMode === COMPOUNDING && !this.base.isZero()) {
        this.compounding = { feeBps: (c as { migratedCompoundingFeeBps?: number }).migratedCompoundingFeeBps ?? 0 };
        // the pool opens at the price of the two amounts, rounded up (calculate_compounding_initial_sqrt_price_and_liquidity)
        this.sqrtPrice = sqrtPriceOf(this.base, this.quote, true);
        this.opening = this.sqrtPrice;
        this.dynamic = migratedDynamicFee(config);
        this.schedule = migratedFeeSchedule(config);
      }
    }
    this.feePpm = new BN(migratedPoolFeeBps(config) * 100);
    this.feeOnOutput = c.migratedCollectFeeMode === OUTPUT_TOKEN;
  }

  get usable(): boolean {
    return !this.base.isZero() && !this.quote.isZero();
  }

  /** Quote units per base unit. */
  get price(): number {
    if (this.sqrtPrice) return (Number(this.sqrtPrice.toString()) / 2 ** 64) ** 2;
    return Number(this.quote.toString()) / Number(this.base.toString());
  }

  /** Twice the number of price bins between two sqrt prices (DynamicFeeStruct::get_delta_bin_id). */
  private bins(a: BN, b: BN): BN {
    const [upper, lower] = a.gt(b) ? [a, b] : [b, a];
    return upper.shln(64).div(lower).sub(ONE_Q64).div(this.dynamic!.binStepU128).muln(2);
  }

  /** Before a swap: after a quiet spell the reference price moves to where the pool is, and the memory decays. */
  private settle(timestamp: number): void {
    this.clock = timestamp;
    const d = this.dynamic;
    const v = this.volatility;
    if (!d || !this.sqrtPrice) return;
    const elapsed = Math.max(0, timestamp - v.lastUpdate);
    if (elapsed < d.filterPeriod) return;
    v.sqrtPriceReference = this.sqrtPrice;
    v.reference = elapsed < d.decayPeriod ? v.accumulator.muln(d.reductionFactor).div(BASIS_POINTS) : ZERO;
  }

  /** After a swap: how far the price now is from the reference, and the time, if the swap crossed a bin. */
  private record(before: BN, timestamp: number): void {
    const d = this.dynamic;
    const v = this.volatility;
    if (!d || !this.sqrtPrice) return;
    v.accumulator = BN.min(v.reference.add(this.bins(this.sqrtPrice, v.sqrtPriceReference).mul(BASIS_POINTS)), new BN(d.maxVolatilityAccumulator));
    if (this.bins(before, this.sqrtPrice).gt(ZERO)) v.lastUpdate = timestamp;
  }

  /** The fee rate in parts per billion: the pool fee, plus the dynamic fee for the volatility remembered. */
  get feeNumerator(): BN {
    let base = this.feePpm.muln(1000);
    const s = this.schedule;
    if (s && this.sqrtPrice) {
      // every step once the schedule has run out; otherwise one for each stretch of price gained since the opening
      const expired = this.clock > this.openedAt + s.expirationDuration || this.clock < this.openedAt;
      const gained = this.sqrtPrice.lte(this.opening) ? 0 : BN.min(this.sqrtPrice.sub(this.opening).mul(BASIS_POINTS).div(this.opening).divn(s.sqrtPriceStepBps), new BN(s.numberOfPeriod)).toNumber();
      base = scheduledFee(base, s, expired ? s.numberOfPeriod : gained);
    }
    if (!this.dynamic) return base;
    const square = this.volatility.accumulator.muln(this.dynamic.binStep).sqr();
    const variable = square.muln(this.dynamic.variableFeeControl).add(new BN("99999999999")).div(new BN("100000000000"));
    return BN.min(base.add(variable), DAMM_MAX_FEE_NUMERATOR);
  }

  /** DAMM v2's fee on an amount: parts per billion, rounded up. */
  private fee(amount: BN): BN {
    return mulDiv(amount, this.feeNumerator, DAMM_FEE_DENOMINATOR, Rounding.Up);
  }

  /** The amount that leaves `amount` once DAMM v2's fee has come off it, rounded up. */
  private beforeFee(amount: BN): BN {
    return mulDiv(amount, DAMM_FEE_DENOMINATOR, DAMM_FEE_DENOMINATOR.sub(this.feeNumerator), Rounding.Up);
  }

  /** After a swap in a compounding pool: part of the fee stays in the pool, and the price is read off what it holds. */
  private compound(fee: BN, before: BN, timestamp: number): void {
    const trading = fee.sub(fee.muln(DAMM_PROTOCOL_FEE_PERCENT).divn(100));
    this.quote = this.quote.add(trading.muln(this.compounding!.feeBps).divn(10_000));
    this.sqrtPrice = sqrtPriceOf(this.base, this.quote);
    this.record(before, timestamp);
    this.feesCollected = this.feesCollected.add(fee);
  }

  /** DAMM v2 pools only: what it costs in quote to receive exactly `baseOut` tokens. */
  buyExactOut(baseOut: BN, timestamp = 0): { cost: BN; fee: BN; feeOnBase: boolean } {
    if (this.compounding && this.sqrtPrice) {
      this.settle(timestamp);
      const before = this.sqrtPrice;
      const moving = mulDiv(this.quote, baseOut, this.base.sub(baseOut), Rounding.Up);
      const cost = this.beforeFee(moving);
      this.quote = this.quote.add(moving);
      this.base = this.base.sub(baseOut);
      this.compound(cost.sub(moving), before, timestamp);
      return { cost, fee: cost.sub(moving), feeOnBase: false };
    }
    if (!this.liquidity || !this.sqrtPrice) throw new Error("exact-out is only modelled for a DAMM v2 pool");
    this.settle(timestamp);
    const before = this.sqrtPrice;
    const gross = this.feeOnOutput ? this.beforeFee(baseOut) : baseOut;
    const next = getNextSqrtPriceFromOutput(this.sqrtPrice, this.liquidity, gross, false);
    const moving = getDeltaAmountQuoteUnsigned(this.sqrtPrice, next, this.liquidity, Rounding.Up);
    const cost = this.feeOnOutput ? moving : this.beforeFee(moving);
    const fee = this.feeOnOutput ? gross.sub(baseOut) : cost.sub(moving);
    this.sqrtPrice = next;
    this.record(before, timestamp);
    this.quote = this.quote.add(moving);
    this.base = this.base.sub(gross);
    if (this.feeOnOutput) this.baseFeesCollected = this.baseFeesCollected.add(fee);
    else this.feesCollected = this.feesCollected.add(fee);
    return { cost, fee, feeOnBase: this.feeOnOutput };
  }

  /** DAMM v2 pools only: how many tokens it takes to receive exactly `quoteOut`. */
  sellExactOut(quoteOut: BN, timestamp = 0): { cost: BN; fee: BN; feeOnBase: boolean } {
    if (this.compounding && this.sqrtPrice) {
      this.settle(timestamp);
      const before = this.sqrtPrice;
      const gross = this.beforeFee(quoteOut);
      const cost = mulDiv(this.base, gross, this.quote.sub(gross), Rounding.Up);
      this.base = this.base.add(cost);
      this.quote = this.quote.sub(gross);
      this.compound(gross.sub(quoteOut), before, timestamp);
      return { cost, fee: gross.sub(quoteOut), feeOnBase: false };
    }
    if (!this.liquidity || !this.sqrtPrice) throw new Error("exact-out is only modelled for a DAMM v2 pool");
    this.settle(timestamp);
    const before = this.sqrtPrice;
    const gross = this.beforeFee(quoteOut);
    const next = getNextSqrtPriceFromOutput(this.sqrtPrice, this.liquidity, gross, true);
    const cost = getDeltaAmountBaseUnsigned(next, this.sqrtPrice, this.liquidity, Rounding.Up);
    const fee = gross.sub(quoteOut);
    this.sqrtPrice = next;
    this.record(before, timestamp);
    this.base = this.base.add(cost);
    this.quote = this.quote.sub(gross);
    this.feesCollected = this.feesCollected.add(fee);
    return { cost, fee, feeOnBase: false };
  }

  /** `feeOnBase`: the fee is in tokens, not quote. `timestamp` (Unix seconds) only matters to a dynamic fee. */
  buy(quoteIn: BN, timestamp = 0): { out: BN; fee: BN; feeOnBase: boolean } {
    if (this.liquidity && this.sqrtPrice) {
      this.settle(timestamp);
      const before = this.sqrtPrice;
      // In quote: the fee comes off what is paid, and the rest moves the price. From the output: all of it moves the
      // price and the fee comes off the tokens.
      const fee = this.feeOnOutput ? new BN(0) : this.fee(quoteIn);
      const moving = quoteIn.sub(fee);
      const next = getNextSqrtPriceFromInput(this.sqrtPrice, this.liquidity, moving, false);
      const gross = getDeltaAmountBaseUnsigned(this.sqrtPrice, next, this.liquidity, Rounding.Down);
      const feeOut = this.feeOnOutput ? this.fee(gross) : new BN(0);
      this.sqrtPrice = next;
      this.record(before, timestamp);
      this.quote = this.quote.add(moving);
      this.base = this.base.sub(gross);
      this.feesCollected = this.feesCollected.add(fee);
      this.baseFeesCollected = this.baseFeesCollected.add(feeOut);
      return { out: gross.sub(feeOut), fee: this.feeOnOutput ? feeOut : fee, feeOnBase: this.feeOnOutput };
    }
    if (this.compounding && this.sqrtPrice) {
      // the fee comes off the quote paid, the rest buys along x * y = k
      this.settle(timestamp);
      const before = this.sqrtPrice;
      const fee = this.fee(quoteIn);
      const net = quoteIn.sub(fee);
      const out = this.base.mul(net).div(this.quote.add(net));
      this.quote = this.quote.add(net);
      this.base = this.base.sub(out);
      this.compound(fee, before, timestamp);
      return { out, fee, feeOnBase: false };
    }
    if (this.feeOnOutput) {
      const gross = this.base.mul(quoteIn).div(this.quote.add(quoteIn));
      const fee = gross.mul(this.feePpm).div(FEE_DENOMINATOR);
      this.quote = this.quote.add(quoteIn);
      this.base = this.base.sub(gross);
      this.baseFeesCollected = this.baseFeesCollected.add(fee);
      return { out: gross.sub(fee), fee, feeOnBase: true };
    }
    const fee = quoteIn.mul(this.feePpm).div(FEE_DENOMINATOR);
    const net = quoteIn.sub(fee);
    const out = this.base.mul(net).div(this.quote.add(net));
    this.quote = this.quote.add(net);
    this.base = this.base.sub(out);
    this.feesCollected = this.feesCollected.add(fee);
    return { out, fee, feeOnBase: false };
  }

  sell(baseIn: BN, timestamp = 0): { out: BN; fee: BN; feeOnBase: boolean } {
    if (this.liquidity && this.sqrtPrice) {
      // a sale pays out quote, and the fee comes off that in either mode
      this.settle(timestamp);
      const before = this.sqrtPrice;
      const next = getNextSqrtPriceFromInput(this.sqrtPrice, this.liquidity, baseIn, true);
      const gross = getDeltaAmountQuoteUnsigned(next, this.sqrtPrice, this.liquidity, Rounding.Down);
      const fee = this.fee(gross);
      this.sqrtPrice = next;
      this.record(before, timestamp);
      this.base = this.base.add(baseIn);
      this.quote = this.quote.sub(gross);
      this.feesCollected = this.feesCollected.add(fee);
      return { out: gross.sub(fee), fee, feeOnBase: false };
    }
    if (this.compounding && this.sqrtPrice) {
      this.settle(timestamp);
      const before = this.sqrtPrice;
      const gross = this.quote.mul(baseIn).div(this.base.add(baseIn));
      const fee = this.fee(gross);
      this.base = this.base.add(baseIn);
      this.quote = this.quote.sub(gross);
      this.compound(fee, before, timestamp);
      return { out: gross.sub(fee), fee, feeOnBase: false };
    }
    const gross = this.quote.mul(baseIn).div(this.base.add(baseIn));
    const fee = gross.mul(this.feePpm).div(FEE_DENOMINATOR);
    this.base = this.base.add(baseIn);
    this.quote = this.quote.sub(gross);
    this.feesCollected = this.feesCollected.add(fee);
    return { out: gross.sub(fee), fee, feeOnBase: false };
  }
}
