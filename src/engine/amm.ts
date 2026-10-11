// The pool a completed curve migrates into, as far as a replay needs it.
//
// Exact here, and held against the chain by src/migration.ts: what moves into the new pool. The migration fee comes
// off the quote threshold; the protocol takes its liquidity fee (0.2% for pools created today, kept on each pool
// account); for DAMM v2 the liquidity that the remaining quote buys at the curve's last price then sets both
// deposits, as the program computes them, and for DAMM v1 or a compounding pool both sides simply lose the fee.
// Modelled here: trading afterwards. The pool is treated as full-range constant product with the config's fee
// rate, taken in quote or from the output token as the config says. DAMM v2's dynamic fee and market-cap fee
// scheduler after migration are not applied.

import { getDeltaAmountBaseUnsigned, getDeltaAmountQuoteUnsigned, getInitialLiquidityFromDeltaQuote, MAX_SQRT_PRICE, MIN_SQRT_PRICE, Rounding, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";

const FEE_DENOMINATOR = new BN(1_000_000);
/** constants.rs PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS: what a pool created today carries. Older pools carry 0. */
export const PROTOCOL_LIQUIDITY_FEE_BPS = 20;
// MigrationFeeOption -> pool fee in bps (index 6 = customizable: the config's migratedPoolFeeBps).
const FIXED_POOL_FEE_BPS = [25, 30, 100, 200, 400, 600];
// MigratedCollectFeeMode
const OUTPUT_TOKEN = 1;
const COMPOUNDING = 2;

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
  base: BN;
  quote: BN;
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
      const first = amounts(partner.gt(creator) ? partner : creator);
      const second = partner.isZero() || creator.isZero() ? { base: new BN(0), quote: new BN(0) } : amounts(getInitialLiquidityFromDeltaQuote(afterCut.sub(first.quote), MIN_SQRT_PRICE, price));
      this.quote = first.quote.add(second.quote);
      this.base = first.base.add(second.base);
      // the protocol's base cut is the base side of the liquidity its quote cut would have bought
      this.protocolFee = { quote: cut(kept), base: getDeltaAmountBaseUnsigned(price, MAX_SQRT_PRICE, getInitialLiquidityFromDeltaQuote(cut(kept), MIN_SQRT_PRICE, price), Rounding.Down) };
    } else {
      // DAMM v1 and compounding DAMM v2 (compounding_liquidity.rs): each side less the protocol's cut.
      this.protocolFee = { quote: cut(kept), base: cut(baseThreshold) };
      this.quote = kept.sub(this.protocolFee.quote);
      this.base = baseThreshold.sub(this.protocolFee.base);
    }
    this.feePpm = new BN(migratedPoolFeeBps(config) * 100);
    this.feeOnOutput = c.migratedCollectFeeMode === OUTPUT_TOKEN;
  }

  get usable(): boolean {
    return !this.base.isZero() && !this.quote.isZero();
  }

  /** Quote units per base unit. */
  get price(): number {
    return Number(this.quote.toString()) / Number(this.base.toString());
  }

  /** `feeOnBase`: the fee is in tokens, not quote. */
  buy(quoteIn: BN): { out: BN; fee: BN; feeOnBase: boolean } {
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

  sell(baseIn: BN): { out: BN; fee: BN; feeOnBase: boolean } {
    const gross = this.quote.mul(baseIn).div(this.base.add(baseIn));
    const fee = gross.mul(this.feePpm).div(FEE_DENOMINATOR);
    this.base = this.base.add(baseIn);
    this.quote = this.quote.sub(gross);
    this.feesCollected = this.feesCollected.add(fee);
    return { out: gross.sub(fee), fee, feeOnBase: false };
  }
}
