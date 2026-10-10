// A PoolConfig account's bytes -> the config object the engine runs, without Anchor.
//
// codec.ts decodes through the SDK's Anchor coder and is the reference. This reader does the same job from the IDL
// offsets alone, so the browser build can load any config straight from an RPC response. test/bytes.test.ts holds
// the two to the same answer on real mainnet accounts.

import type { PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import bs58 from "bs58";
import { CONFIG, off } from "../layout.ts";

const o = (path: string) => off(CONFIG, path);

export type LoadedConfig = PoolConfig & { quoteMintAddress: string; feeClaimerAddress: string };

export function configFromBytes(data: Uint8Array): LoadedConfig {
  const d = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (d.length < CONFIG.size) throw new Error(`a PoolConfig account is ${CONFIG.size} bytes; got ${d.length}`);
  const u8 = (path: string) => d[o(path)];
  const u16 = (path: string) => d.readUInt16LE(o(path));
  const u32 = (path: string) => d.readUInt32LE(o(path));
  const u64 = (path: string) => new BN(d.subarray(o(path), o(path) + 8), "le");
  const u128at = (at: number) => new BN(d.subarray(at, at + 16), "le");
  const key = (path: string) => bs58.encode(d.subarray(o(path), o(path) + 32));
  const vesting = (prefix: string) => ({
    isInitialized: u8(`${prefix}.is_initialized`),
    vestingPercentage: u8(`${prefix}.vesting_percentage`),
    bpsPerPeriod: u16(`${prefix}.bps_per_period`),
    numberOfPeriods: u16(`${prefix}.number_of_periods`),
    frequency: u32(`${prefix}.frequency`),
    cliffDurationFromMigrationTime: u32(`${prefix}.cliff_duration_from_migration_time`),
  });
  const curveAt = o("curve");
  const curve = Array.from({ length: 20 }, (_, i) => ({ sqrtPrice: u128at(curveAt + i * 32), liquidity: u128at(curveAt + i * 32 + 16) }));
  return {
    quoteMintAddress: key("quote_mint"),
    feeClaimerAddress: key("fee_claimer"),
    poolFees: {
      baseFee: {
        cliffFeeNumerator: u64("pool_fees.base_fee.cliff_fee_numerator"),
        secondFactor: u64("pool_fees.base_fee.second_factor"),
        thirdFactor: u64("pool_fees.base_fee.third_factor"),
        firstFactor: u16("pool_fees.base_fee.first_factor"),
        baseFeeMode: u8("pool_fees.base_fee.base_fee_mode"),
      },
      dynamicFee: {
        initialized: u8("pool_fees.dynamic_fee.initialized"),
        maxVolatilityAccumulator: u32("pool_fees.dynamic_fee.max_volatility_accumulator"),
        variableFeeControl: u32("pool_fees.dynamic_fee.variable_fee_control"),
        binStep: u16("pool_fees.dynamic_fee.bin_step"),
        filterPeriod: u16("pool_fees.dynamic_fee.filter_period"),
        decayPeriod: u16("pool_fees.dynamic_fee.decay_period"),
        reductionFactor: u16("pool_fees.dynamic_fee.reduction_factor"),
        binStepU128: u128at(o("pool_fees.dynamic_fee.bin_step_u128")),
      },
    },
    partnerLiquidityVestingInfo: vesting("partner_liquidity_vesting_info"),
    creatorLiquidityVestingInfo: vesting("creator_liquidity_vesting_info"),
    collectFeeMode: u8("collect_fee_mode"),
    migrationOption: u8("migration_option"),
    activationType: u8("activation_type"),
    tokenDecimal: u8("token_decimal"),
    version: u8("version"),
    tokenType: u8("token_type"),
    quoteTokenFlag: u8("quote_token_flag"),
    partnerPermanentLockedLiquidityPercentage: u8("partner_permanent_locked_liquidity_percentage"),
    partnerLiquidityPercentage: u8("partner_liquidity_percentage"),
    creatorPermanentLockedLiquidityPercentage: u8("creator_permanent_locked_liquidity_percentage"),
    creatorLiquidityPercentage: u8("creator_liquidity_percentage"),
    migrationFeeOption: u8("migration_fee_option"),
    fixedTokenSupplyFlag: u8("fixed_token_supply_flag"),
    creatorTradingFeePercentage: u8("creator_trading_fee_percentage"),
    tokenUpdateAuthority: u8("token_update_authority"),
    migrationFeePercentage: u8("migration_fee_percentage"),
    creatorMigrationFeePercentage: u8("creator_migration_fee_percentage"),
    swapBaseAmount: u64("swap_base_amount"),
    migrationQuoteThreshold: u64("migration_quote_threshold"),
    migrationBaseThreshold: u64("migration_base_threshold"),
    migrationSqrtPrice: u128at(o("migration_sqrt_price")),
    preMigrationTokenSupply: u64("pre_migration_token_supply"),
    postMigrationTokenSupply: u64("post_migration_token_supply"),
    migratedCollectFeeMode: u8("migrated_collect_fee_mode"),
    migratedDynamicFee: u8("migrated_dynamic_fee"),
    migratedPoolFeeBps: u16("migrated_pool_fee_bps"),
    migratedPoolBaseFeeMode: u8("migrated_pool_base_fee_mode"),
    enableFirstSwapWithMinFee: u8("enable_first_swap_with_min_fee"),
    poolCreationFee: u64("pool_creation_fee"),
    sqrtStartPrice: u128at(o("sqrt_start_price")),
    curve,
  } as unknown as LoadedConfig;
}
