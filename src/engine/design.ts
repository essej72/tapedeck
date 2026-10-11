// From a config a builder designs to a config the engine can run, and to a file Meteora's Invent CLI can launch.
//
// A design is written once, as the input of one of the SDK's curve builders. From there:
//   designParams()  runs the builder: the parameters of a create_config instruction, validated by the SDK.
//   deriveConfig()  adds what the program derives when it stores them (the migration price above all), so the
//                   design can be flown before it is ever sent to the chain.
//   inventConfig()  wraps the same input in the shape of the Invent CLI's dbc_config.jsonc.

import {
  ActivationType,
  BaseFeeMode,
  buildCurve,
  buildCurveWithLiquidityWeights,
  buildCurveWithMarketCap,
  CollectFeeMode,
  getMigrationBaseToken,
  getMigrationQuoteAmountFromMigrationQuoteThreshold,
  getMigrationThresholdPrice,
  MigrationFeeOption,
  MigrationOption,
  TokenDecimal,
  TokenType,
  type BaseFeeParams,
  type ConfigParameters,
  type PoolConfig,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import Decimal from "decimal.js";

const ZERO = new BN(0);
const CURVE_SLOTS = 20;
const SOL_MINT = "So11111111111111111111111111111111111111112";

/** The stored form of a create_config instruction's parameters, as far as trading and migration are concerned. */
export function deriveConfig(p: ConfigParameters): PoolConfig {
  const curve = [...p.curve];
  while (curve.length < CURVE_SLOTS) curve.push({ sqrtPrice: ZERO, liquidity: ZERO });
  const d = p.poolFees.dynamicFee;
  const migrationSqrtPrice = getMigrationThresholdPrice(p.migrationQuoteThreshold, p.sqrtStartPrice, p.curve);
  const migrationQuoteAmount = getMigrationQuoteAmountFromMigrationQuoteThreshold(new Decimal(p.migrationQuoteThreshold.toString()), p.migrationFee.feePercentage);
  return {
    poolFees: {
      baseFee: { ...p.poolFees.baseFee },
      dynamicFee: d
        ? { initialized: 1, maxVolatilityAccumulator: d.maxVolatilityAccumulator, variableFeeControl: d.variableFeeControl, binStep: d.binStep, filterPeriod: d.filterPeriod, decayPeriod: d.decayPeriod, reductionFactor: d.reductionFactor, binStepU128: d.binStepU128 }
        : { initialized: 0, maxVolatilityAccumulator: 0, variableFeeControl: 0, binStep: 0, filterPeriod: 0, decayPeriod: 0, reductionFactor: 0, binStepU128: ZERO },
    },
    collectFeeMode: p.collectFeeMode,
    migrationOption: p.migrationOption,
    activationType: p.activationType,
    tokenDecimal: p.tokenDecimal,
    creatorTradingFeePercentage: p.creatorTradingFeePercentage,
    enableFirstSwapWithMinFee: p.enableFirstSwapWithMinFee ? 1 : 0,
    migrationQuoteThreshold: p.migrationQuoteThreshold,
    sqrtStartPrice: p.sqrtStartPrice,
    migrationSqrtPrice,
    migrationBaseThreshold: getMigrationBaseToken(new BN(migrationQuoteAmount.floor().toFixed()), migrationSqrtPrice, p.migrationOption),
    migrationFeeOption: p.migrationFeeOption,
    migrationFeePercentage: p.migrationFee.feePercentage,
    creatorMigrationFeePercentage: p.migrationFee.creatorFeePercentage,
    migratedPoolFeeBps: p.migratedPoolFee?.poolFeeBps ?? 0,
    migratedCollectFeeMode: p.migratedPoolFee?.collectFeeMode ?? 0,
    partnerLiquidityPercentage: p.partnerLiquidityPercentage,
    partnerPermanentLockedLiquidityPercentage: p.partnerPermanentLockedLiquidityPercentage,
    creatorLiquidityPercentage: p.creatorLiquidityPercentage,
    creatorPermanentLockedLiquidityPercentage: p.creatorPermanentLockedLiquidityPercentage,
    partnerLiquidityVestingInfo: { vestingPercentage: p.partnerLiquidityVestingInfo?.vestingPercentage ?? 0 },
    creatorLiquidityVestingInfo: { vestingPercentage: p.creatorLiquidityVestingInfo?.vestingPercentage ?? 0 },
    curve,
  } as unknown as PoolConfig;
}

/** The curve itself: either two market caps (optionally with a shape), or a raise and what is left for the pool. */
export type CurveSpec =
  | {
      /** Market cap at the first trade and at migration, in quote tokens (SOL). */
      initialMarketCap: number;
      migrationMarketCap: number;
      /** Relative liquidity of the 16 price bands between the two market caps; omitted = one constant-product band. */
      liquidityWeights?: number[];
    }
  | {
      /** Quote raised when the curve completes, and the percentage of supply that migrates with it. */
      raise: number;
      supplyOnMigration: number;
    };

export type DesignSpec = CurveSpec & {
  baseFee: BaseFeeParams;
  dynamicFee?: boolean;
  collectFeeMode?: CollectFeeMode;
  creatorTradingFeePercentage?: number;
  enableFirstSwapWithMinFee?: boolean;
  activationType?: ActivationType;
  /** Fee tier of the pool the curve migrates into (default 0.25%), and the share of the raise taken at migration. */
  migrationFeeOption?: MigrationFeeOption;
  migrationFeePercentage?: number;
  creatorMigrationFeePercentage?: number;
  /** Who owns the migrated liquidity, in percent; whatever is left over is the creator's and withdrawable. */
  partnerLockedLiquidity?: number;
  partnerLiquidity?: number;
  creatorLockedLiquidity?: number;
};

export const flatFee = (bps: number): BaseFeeParams => ({
  baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
  feeSchedulerParam: { startingFeeBps: bps, endingFeeBps: bps, numberOfPeriod: 0, totalDuration: 0 },
});

/** A design as the input of an SDK curve builder: which builder (Invent's buildCurveMode) and its argument. */
function builderInput(s: DesignSpec) {
  const partnerLocked = s.partnerLockedLiquidity ?? 100;
  const partner = s.partnerLiquidity ?? 0;
  const creatorLocked = s.creatorLockedLiquidity ?? 0;
  const base = {
    // The weighted builder needs a little slack to absorb rounding across its 16 bands: 1,000 of a billion tokens.
    token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 9, tokenAuthorityOption: 1, totalTokenSupply: 1_000_000_000, leftover: "liquidityWeights" in s && s.liquidityWeights ? 1000 : 0 },
    fee: {
      baseFeeParams: s.baseFee,
      dynamicFeeEnabled: Boolean(s.dynamicFee),
      collectFeeMode: s.collectFeeMode ?? CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: s.creatorTradingFeePercentage ?? 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: Boolean(s.enableFirstSwapWithMinFee),
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: s.migrationFeeOption ?? MigrationFeeOption.FixedBps25,
      migrationFee: { feePercentage: s.migrationFeePercentage ?? 0, creatorFeePercentage: s.creatorMigrationFeePercentage ?? 0 },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: partner,
      creatorLiquidityPercentage: Math.max(0, 100 - partnerLocked - partner - creatorLocked),
      partnerPermanentLockedLiquidityPercentage: partnerLocked,
      creatorPermanentLockedLiquidityPercentage: creatorLocked,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: s.activationType ?? ActivationType.Slot,
  };
  if ("raise" in s) return { mode: 0 as const, input: { ...base, percentageSupplyOnMigration: s.supplyOnMigration, migrationQuoteThreshold: s.raise } };
  const caps = { ...base, initialMarketCap: s.initialMarketCap, migrationMarketCap: s.migrationMarketCap };
  return s.liquidityWeights ? { mode: 3 as const, input: { ...caps, liquidityWeights: s.liquidityWeights } } : { mode: 1 as const, input: caps };
}

/** create_config parameters for a one-billion-supply, six-decimal, SOL-quoted launch, built by the SDK. */
export function designParams(s: DesignSpec): ConfigParameters {
  const b = builderInput(s);
  return b.mode === 0 ? buildCurve(b.input) : b.mode === 3 ? buildCurveWithLiquidityWeights(b.input) : buildCurveWithMarketCap(b.input);
}

export const design = (s: DesignSpec): PoolConfig => deriveConfig(designParams(s));

/**
 * The design as a config file for Meteora's Invent CLI (studio/config/dbc_config.jsonc): `dbcConfig` is the
 * builder input verbatim plus the builder's number. dryRun is on and the network is devnet; the keypair, fee
 * claimer and leftover receiver are the launcher's to fill in.
 */
export function inventConfig(s: DesignSpec): Record<string, unknown> {
  const b = builderInput(s);
  return {
    rpcUrl: "https://api.devnet.solana.com",
    dryRun: true,
    keypairFilePath: "./keypair.json",
    computeUnitPriceMicroLamports: 100000,
    quoteMint: SOL_MINT,
    dbcConfig: { buildCurveMode: b.mode, ...b.input, leftoverReceiver: "YOUR_LEFTOVER_RECEIVER_ADDRESS", feeClaimer: "YOUR_FEE_CLAIMER_ADDRESS" },
  };
}

// pump.fun's curve as a DBC config. Its constants: 30 SOL and 1,073,000,000 tokens of virtual reserves, 793,100,000
// of a billion tokens on sale. That sale raises 85.005359 SOL and leaves 20.69% of supply for the pool. The SDK's
// builder turns those two numbers into one constant-product segment that sells the same tokens for the same SOL
// (its first price is 0.007% above pump.fun's).
export const PUMP_CURVE = { raise: 85.005359057, supplyOnMigration: 20.69 };
