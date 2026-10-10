// What it costs to fake a graduation under a config.
//
// The cheapest way to get a token onto every "just migrated" feed is for its creator to buy the whole curve in the
// launch transaction. Whether that is expensive or free is decided by the config: how big the fee is at second zero,
// who the fee goes to, and who owns the liquidity after migration. walkAway() prices the round trip for a creator
// who completes their own curve at launch and then leaves, with nobody else trading: buy the curve, take back
// whatever the config hands a creator (fee share, migration fee share, unlocked liquidity), sell every token into
// what is left of the migrated pool.
//
// The curve leg is exact (the engine). The migrated pool is modelled as a full-range constant-product pool holding
// the migration amounts, which is what DAMM v1 and a full-range DAMM v2 position are; its fee schedule after
// migration is taken as the configured flat pool fee.

import { SwapMode, TradeDirection, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { SimPool } from "./pool.ts";

const PROTOCOL_LIQUIDITY_MIGRATION_FEE = 0.002; // constants.rs PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS = 20
const HUGE = new BN("18446744073709551615");

export type WalkAway = {
  /** Quote the creator pays to complete the curve alone at launch, fees included. Null if one buy cannot do it. */
  spend: number | null;
  /** Trading fee on that buy, as a share of the spend (fee in tokens counted at the average fill price). */
  feeRate: number;
  /** Share of that fee that flows back to the creator. */
  feeBackToCreator: number;
  /** Share of the migrated pool the creator can withdraw at once, later (vesting), and never. */
  lpNow: number;
  lpLater: number;
  lpNever: number;
  /** Quote recovered straight after migration, and after vesting ends. */
  recoveredNow: number;
  recoveredLater: number;
  /** Net loss of the round trip, in quote and as a share of the migration threshold. */
  cost: number;
  costShare: number;
  costLater: number;
  costLaterShare: number;
};

type Extras = {
  migrationBaseThreshold: BN;
  migrationFeePercentage: number;
  creatorMigrationFeePercentage: number;
  migratedPoolFeeBps: number;
  migrationFeeOption: number;
  partnerPermanentLockedLiquidityPercentage: number;
  partnerLiquidityPercentage: number;
  creatorPermanentLockedLiquidityPercentage: number;
  partnerLiquidityVestingInfo: { vestingPercentage: number };
  creatorLiquidityVestingInfo: { vestingPercentage: number };
};

// MigrationFeeOption -> the migrated pool's flat fee, in bps (6 = customizable: migratedPoolFeeBps).
const FIXED_POOL_FEE_BPS = [25, 30, 100, 200, 400, 600];

export type WalkAwayOptions = {
  /** The buy rides in the pool-creation transaction, so it gets the minimum fee where the config allows. Default true. */
  inCreateTx?: boolean;
  /**
   * The same party also owns the config's partner side (its fee claimer). True for an operator running a private
   * config; false for a creator on a launchpad they do not own. Default false.
   */
  ownsPartnerSide?: boolean;
  /** Wait this long after launch before buying, in the config's activation unit (slots or seconds). Default 0. */
  wait?: number;
  quoteDecimals?: number;
};

export function walkAway(config: PoolConfig, opts: WalkAwayOptions = {}): WalkAway {
  const c = config as PoolConfig & Extras;
  const unit = 10 ** (opts.quoteDecimals ?? 9);
  const threshold = Number(c.migrationQuoteThreshold.toString());
  const none: WalkAway = { spend: null, feeRate: 0, feeBackToCreator: 0, lpNow: 0, lpLater: 0, lpNever: 0, recoveredNow: 0, recoveredLater: 0, cost: 0, costShare: 0, costLater: 0, costLaterShare: 0 };
  if (threshold <= 0) return none;

  // 1. Buy the curve at the launch instant.
  const launch = new BN(1_700_000_000); // works as a slot or a unix time; only differences from it matter
  const pool = SimPool.fresh(config, launch);
  let fill;
  try {
    const at = launch.addn(opts.wait ?? 0);
    fill = pool.swap(TradeDirection.QuoteToBase, HUGE, { point: at, timestamp: at }, { mode: SwapMode.PartialFill, firstSwapInCreateTx: (opts.inCreateTx ?? true) && !opts.wait });
  } catch {
    return none;
  }
  if (!pool.complete) return none;
  const spend = Number(fill.amountIn.toString());
  let tokens = Number(fill.amountOut.toString());
  const feeTotal = fill.protocolFee.add(fill.referralFee).add(fill.partnerFee).add(fill.creatorFee);
  let quoteBack = 0;
  let feeRate: number;
  const own = opts.ownsPartnerSide ? fill.creatorFee.add(fill.partnerFee) : fill.creatorFee;
  const feeBackToCreator = feeTotal.isZero() ? 0 : Number(own.toString()) / Number(feeTotal.toString());
  if (fill.feeOnBase) {
    // Fee was taken from the tokens bought; the creator's share comes back as tokens.
    const gross = tokens + Number(feeTotal.toString());
    feeRate = gross > 0 ? Number(feeTotal.toString()) / gross : 0;
    tokens += Number(own.toString());
  } else {
    feeRate = spend > 0 ? Number(feeTotal.toString()) / spend : 0;
    quoteBack += Number(own.toString());
  }

  // 2. Migration: a fee comes off the quote, the rest and the migration base amount become the pool.
  const migrationFee = Math.floor((threshold * c.migrationFeePercentage) / 100);
  quoteBack += opts.ownsPartnerSide ? migrationFee : (migrationFee * c.creatorMigrationFeePercentage) / 100;
  const poolQuote = (threshold - migrationFee) * (1 - PROTOCOL_LIQUIDITY_MIGRATION_FEE);
  const poolBase = Number(c.migrationBaseThreshold.toString()) * (1 - PROTOCOL_LIQUIDITY_MIGRATION_FEE);
  // The creator's unlocked share is whatever the other five buckets leave (config.rs get_liquidity_distribution).
  const locked = (c.partnerPermanentLockedLiquidityPercentage + c.creatorPermanentLockedLiquidityPercentage) / 100;
  const partnerNow = c.partnerLiquidityPercentage / 100;
  const partnerLater = c.partnerLiquidityVestingInfo.vestingPercentage / 100;
  const creatorLater = c.creatorLiquidityVestingInfo.vestingPercentage / 100;
  const creatorNow = Math.max(0, 1 - locked - partnerNow - partnerLater - creatorLater);
  const lpNow = creatorNow + (opts.ownsPartnerSide ? partnerNow : 0);
  const lpLater = creatorLater + (opts.ownsPartnerSide ? partnerLater : 0);
  const lpNever = Math.max(0, 1 - lpNow - lpLater);
  const poolFee = (c.migrationFeeOption < FIXED_POOL_FEE_BPS.length ? FIXED_POOL_FEE_BPS[c.migrationFeeOption] : c.migratedPoolFeeBps) / 1e4;

  // 3. Withdraw what is withdrawable, sell every token into the rest.
  const exit = (share: number) => {
    const restQuote = poolQuote * (1 - share);
    const restBase = poolBase * (1 - share);
    const selling = tokens + poolBase * share;
    const sold = restBase + selling > 0 ? (restQuote * selling) / (restBase + selling) : 0;
    return quoteBack + poolQuote * share + sold * (1 - poolFee);
  };
  const recoveredNow = exit(lpNow);
  const recoveredLater = exit(lpNow + lpLater);
  return {
    spend: spend / unit,
    feeRate,
    feeBackToCreator,
    lpNow,
    lpLater,
    lpNever,
    recoveredNow: recoveredNow / unit,
    recoveredLater: recoveredLater / unit,
    cost: (spend - recoveredNow) / unit,
    costShare: (spend - recoveredNow) / threshold,
    costLater: (spend - recoveredLater) / unit,
    costLaterShare: (spend - recoveredLater) / threshold,
  };
}
