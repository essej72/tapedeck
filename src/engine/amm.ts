// The pool a completed curve migrates into, as far as a replay needs it.
//
// Exact here: the amounts that migrate (the quote threshold less the migration fee, the config's migration base
// amount, both less the 0.2% protocol liquidity fee) and the price they imply, which is the curve's last price.
// Modelled here: trading afterwards. The pool is treated as full-range constant product with one flat fee taken
// in quote, which is what DAMM v1 and a full-range DAMM v2 position are. DAMM v2's own fee scheduler and dynamic
// fee after migration are not applied.

import type { PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";

const FEE_DENOMINATOR = new BN(1_000_000);
const PROTOCOL_LIQUIDITY_FEE_PPM = new BN(2_000); // constants.rs PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS = 20
// MigrationFeeOption -> pool fee in bps (index 6 = customizable: the config's migratedPoolFeeBps).
const FIXED_POOL_FEE_BPS = [25, 30, 100, 200, 400, 600];

type MigrationFields = { migrationBaseThreshold: BN; migrationFeePercentage: number; migrationFeeOption: number; migratedPoolFeeBps: number };

export const migratedPoolFeeBps = (config: PoolConfig): number => {
  const c = config as PoolConfig & MigrationFields;
  return c.migrationFeeOption < FIXED_POOL_FEE_BPS.length ? FIXED_POOL_FEE_BPS[c.migrationFeeOption] : c.migratedPoolFeeBps;
};

export class MigratedPool {
  base: BN;
  quote: BN;
  /** Fee per million of the quote side of each trade. */
  readonly feePpm: BN;
  /** Quote taken at migration as the config's migration fee. */
  readonly migrationFee: BN;
  feesCollected = new BN(0);

  constructor(config: PoolConfig) {
    const c = config as PoolConfig & MigrationFields;
    const threshold = c.migrationQuoteThreshold;
    const kept = threshold.muln(100 - (c.migrationFeePercentage ?? 0)).addn(99).divn(100); // rounds up, as the program does
    this.migrationFee = threshold.sub(kept);
    const net = (x: BN) => x.sub(x.mul(PROTOCOL_LIQUIDITY_FEE_PPM).div(FEE_DENOMINATOR));
    this.quote = net(kept);
    this.base = net(c.migrationBaseThreshold ?? new BN(0));
    this.feePpm = new BN(migratedPoolFeeBps(config) * 100);
  }

  get usable(): boolean {
    return !this.base.isZero() && !this.quote.isZero();
  }

  /** Quote units per base unit. */
  get price(): number {
    return Number(this.quote.toString()) / Number(this.base.toString());
  }

  buy(quoteIn: BN): { out: BN; fee: BN } {
    const fee = quoteIn.mul(this.feePpm).div(FEE_DENOMINATOR);
    const net = quoteIn.sub(fee);
    const out = this.base.mul(net).div(this.quote.add(net));
    this.quote = this.quote.add(net);
    this.base = this.base.sub(out);
    this.feesCollected = this.feesCollected.add(fee);
    return { out, fee };
  }

  sell(baseIn: BN): { out: BN; fee: BN } {
    const gross = this.quote.mul(baseIn).div(this.base.add(baseIn));
    const fee = gross.mul(this.feePpm).div(FEE_DENOMINATOR);
    this.base = this.base.add(baseIn);
    this.quote = this.quote.sub(gross);
    this.feesCollected = this.feesCollected.add(fee);
    return { out: gross.sub(fee), fee };
  }
}
