// The parts of a PoolConfig account that define how a launch trades, read straight from the account bytes.
// Reading by offset keeps a pass over half a million configs fast; the offsets come from the IDL (layout.ts).

import { createHash } from "node:crypto";
import bs58 from "bs58";
import { CONFIG, off } from "../layout.ts";

const o = (path: string) => off(CONFIG, path);
const u64 = (d: Buffer, path: string) => Number(d.readBigUInt64LE(o(path)));
const u128 = (d: Buffer, at: number) => d.readBigUInt64LE(at) + (d.readBigUInt64LE(at + 8) << 64n);
const FEE_DENOMINATOR = 1e9;
const BPS = 1e4;
const MAX_FEE_BPS = 9900;

export type ConfigFields = {
  quoteMint: string;
  feeClaimer: string;
  /** 0 linear scheduler, 1 exponential scheduler, 2 rate limiter. */
  baseFeeMode: number;
  startFeeBps: number;
  /** Scheduler: fee after the last period. Rate limiter: same as start (the fee grows with size, not time). */
  endFeeBps: number;
  /** Scheduler: periods x frequency. Rate limiter: how long it applies. In slots or seconds (activationType). */
  feeDuration: number;
  feePeriods: number;
  limiterReferenceAmount: number;
  limiterIncrementBps: number;
  dynamicFee: boolean;
  collectFeeMode: number;
  migrationOption: number;
  /** 0 slot, 1 timestamp. */
  activationType: number;
  tokenDecimal: number;
  tokenType: number;
  creatorTradingFeePct: number;
  firstSwapMinFee: boolean;
  migrationFeeOption: number;
  migratedPoolFeeBps: number;
  migrationFeePct: number;
  creatorMigrationFeePct: number;
  partnerVestedLpPct: number;
  creatorVestedLpPct: number;
  partnerLockedLpPct: number;
  partnerLpPct: number;
  creatorLockedLpPct: number;
  creatorLpPct: number;
  lockedVesting: boolean;
  poolCreationFee: number;
  migrationQuoteThreshold: number;
  swapBaseAmount: number;
  preMigrationSupply: number;
  sqrtStartPrice: bigint;
  migrationSqrtPrice: bigint;
  curveSegments: number;
  /** Migration price over start price. */
  priceMultiple: number;
};

export function readConfig(d: Buffer): ConfigFields {
  const mode = d[o("pool_fees.base_fee.base_fee_mode")];
  const cliff = u64(d, "pool_fees.base_fee.cliff_fee_numerator");
  const first = d.readUInt16LE(o("pool_fees.base_fee.first_factor"));
  const second = u64(d, "pool_fees.base_fee.second_factor");
  const third = u64(d, "pool_fees.base_fee.third_factor");
  const startFeeBps = (cliff / FEE_DENOMINATOR) * BPS;
  let endFeeBps = startFeeBps;
  let feeDuration = 0;
  if (mode === 0) endFeeBps = ((cliff - first * third) / FEE_DENOMINATOR) * BPS;
  else if (mode === 1) endFeeBps = startFeeBps * (1 - third / BPS) ** first;
  if (mode === 2) feeDuration = second;
  else feeDuration = first * second;
  const curveAt = o("curve");
  let curveSegments = 0;
  while (curveSegments < 20 && u128(d, curveAt + curveSegments * 32 + 16) > 0n) curveSegments++;
  const sqrtStartPrice = u128(d, o("sqrt_start_price"));
  const migrationSqrtPrice = u128(d, o("migration_sqrt_price"));
  return {
    quoteMint: bs58.encode(d.subarray(o("quote_mint"), o("quote_mint") + 32)),
    feeClaimer: bs58.encode(d.subarray(o("fee_claimer"), o("fee_claimer") + 32)),
    baseFeeMode: mode,
    startFeeBps: Math.min(startFeeBps, MAX_FEE_BPS),
    endFeeBps: Math.max(0, endFeeBps),
    feeDuration,
    feePeriods: mode === 2 ? 0 : first,
    limiterReferenceAmount: mode === 2 ? third : 0,
    limiterIncrementBps: mode === 2 ? first : 0,
    dynamicFee: d[o("pool_fees.dynamic_fee.initialized")] !== 0,
    collectFeeMode: d[o("collect_fee_mode")],
    migrationOption: d[o("migration_option")],
    activationType: d[o("activation_type")],
    tokenDecimal: d[o("token_decimal")],
    tokenType: d[o("token_type")],
    creatorTradingFeePct: d[o("creator_trading_fee_percentage")],
    firstSwapMinFee: d[o("enable_first_swap_with_min_fee")] === 1,
    migrationFeeOption: d[o("migration_fee_option")],
    migratedPoolFeeBps: d.readUInt16LE(o("migrated_pool_fee_bps")),
    migrationFeePct: d[o("migration_fee_percentage")],
    creatorMigrationFeePct: d[o("creator_migration_fee_percentage")],
    partnerVestedLpPct: d[o("partner_liquidity_vesting_info.vesting_percentage")],
    creatorVestedLpPct: d[o("creator_liquidity_vesting_info.vesting_percentage")],
    partnerLockedLpPct: d[o("partner_permanent_locked_liquidity_percentage")],
    partnerLpPct: d[o("partner_liquidity_percentage")],
    creatorLockedLpPct: d[o("creator_permanent_locked_liquidity_percentage")],
    creatorLpPct: d[o("creator_liquidity_percentage")],
    lockedVesting: u64(d, "locked_vesting_config.amount_per_period") > 0 || u64(d, "locked_vesting_config.cliff_unlock_amount") > 0,
    poolCreationFee: u64(d, "pool_creation_fee"),
    migrationQuoteThreshold: u64(d, "migration_quote_threshold"),
    swapBaseAmount: u64(d, "swap_base_amount"),
    preMigrationSupply: u64(d, "pre_migration_token_supply"),
    sqrtStartPrice,
    migrationSqrtPrice,
    curveSegments,
    priceMultiple: sqrtStartPrice > 0n ? (Number(migrationSqrtPrice) / Number(sqrtStartPrice)) ** 2 : 0,
  };
}

/** Identical trading mechanics, whoever collects the fees: a hash of everything from pool_fees on, plus the quote mint. */
export function designHash(d: Buffer): string {
  return createHash("sha1").update(d.subarray(o("quote_mint"), o("quote_mint") + 32)).update(d.subarray(o("pool_fees"))).digest("hex").slice(0, 16);
}
