// One virtual pool, advanced swap by swap the way the on-chain program does it.
//
// Pricing and fees come from the official SDK's quote functions. What the SDK leaves to the program is done here,
// in the program's order (instructions/swap/process_swap.rs and state/virtual_pool.rs): the volatility tracker is
// refreshed before the quote, the result is applied to reserves and fee buckets, the tracker is updated after, and
// the curve is marked complete once the quote reserve reaches the migration threshold.

import {
  getFeeMode,
  getSwapResultFromExactInput,
  getSwapResultFromExactOutput,
  getSwapResultFromPartialInput,
  SwapMode,
  TradeDirection,
  type PoolConfig,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";

const ZERO = new BN(0);
const ONE_Q64 = new BN(1).shln(64);
const BASIS_POINT_MAX = new BN(10_000);

export type Clock = {
  /** Slot or unix time, whichever the config's activation type counts in. Drives the fee schedule. */
  point: BN;
  /** Unix time. Drives the volatility tracker. */
  timestamp: BN;
};

export type SwapOptions = {
  /**
   * ExactIn (default): `amount` is what the trader pays, and the swap fails if it does not fit below the migration
   * price. PartialFill: fill what fits and hand the rest back. ExactOut: `amount` is what the trader receives.
   */
  mode?: SwapMode;
  hasReferral?: boolean;
  /** The creator's buy inside the pool-creation transaction, when the config enables the minimum-fee first swap. */
  firstSwapInCreateTx?: boolean;
};

export type Fill = {
  direction: TradeDirection;
  /** What left the trader's wallet (fee included when the fee is taken on input). */
  amountIn: BN;
  /** What reached the trader's wallet. */
  amountOut: BN;
  /** Input that did not fit below the migration price (partial fill only). */
  amountLeft: BN;
  /** Fee by recipient, in the token named by feeOnBase. protocol + referral + partner + creator = total fee. */
  protocolFee: BN;
  referralFee: BN;
  partnerFee: BN;
  creatorFee: BN;
  feeOnBase: boolean;
  nextSqrtPrice: BN;
  curveComplete: boolean;
};

type Tracker = VirtualPool["poolState"]["volatilityTracker"];

export type PoolState = {
  volatilityTracker: Tracker;
  sqrtPrice: BN;
  activationPoint: BN;
  baseReserve: BN;
  quoteReserve: BN;
  protocolBaseFee: BN;
  protocolQuoteFee: BN;
  partnerBaseFee: BN;
  partnerQuoteFee: BN;
  creatorBaseFee: BN;
  creatorQuoteFee: BN;
  totalProtocolBaseFee: BN;
  totalProtocolQuoteFee: BN;
  totalTradingBaseFee: BN;
  totalTradingQuoteFee: BN;
  hasSwap: boolean;
};

/** Price ratio between two sqrt prices, counted in bin steps (state/fee.rs get_delta_bin_id). */
function deltaBinId(binStepU128: BN, a: BN, b: BN): BN {
  const [upper, lower] = a.gt(b) ? [a, b] : [b, a];
  return upper.shln(64).div(lower).sub(ONE_Q64).div(binStepU128).muln(2);
}

export class SimPool {
  readonly config: PoolConfig;
  readonly state: PoolState;

  constructor(config: PoolConfig, state: PoolState) {
    this.config = config;
    this.state = state;
  }

  /** A pool as initialize_virtual_pool leaves it: at the start price, nothing traded. */
  static fresh(config: PoolConfig, activationPoint: BN, baseReserve: BN = ZERO): SimPool {
    return new SimPool(config, {
      volatilityTracker: { lastUpdateTimestamp: ZERO, padding: [], sqrtPriceReference: ZERO, volatilityAccumulator: ZERO, volatilityReference: ZERO } as unknown as Tracker,
      sqrtPrice: config.sqrtStartPrice,
      activationPoint,
      baseReserve,
      quoteReserve: ZERO,
      protocolBaseFee: ZERO,
      protocolQuoteFee: ZERO,
      partnerBaseFee: ZERO,
      partnerQuoteFee: ZERO,
      creatorBaseFee: ZERO,
      creatorQuoteFee: ZERO,
      totalProtocolBaseFee: ZERO,
      totalProtocolQuoteFee: ZERO,
      totalTradingBaseFee: ZERO,
      totalTradingQuoteFee: ZERO,
      hasSwap: false,
    });
  }

  get complete(): boolean {
    return this.state.quoteReserve.gte(this.config.migrationQuoteThreshold);
  }

  swap(direction: TradeDirection, amount: BN, clock: Clock, opts: SwapOptions = {}): Fill {
    const { config, state } = this;
    if (this.complete) throw new Error("pool is completed");
    if (amount.isZero()) throw new Error("amount is zero");

    const dynamic = config.poolFees.dynamicFee;
    const dynamicOn = dynamic.initialized !== 0;
    if (dynamicOn) this.updateReferences(clock.timestamp);

    const firstSwapWithMinFee = Boolean(opts.firstSwapInCreateTx) && config.enableFirstSwapWithMinFee === 1 && !state.hasSwap;
    const feeMode = getFeeMode(config.collectFeeMode, direction, Boolean(opts.hasReferral));
    const quote =
      opts.mode === SwapMode.PartialFill ? getSwapResultFromPartialInput : opts.mode === SwapMode.ExactOut ? getSwapResultFromExactOutput : getSwapResultFromExactInput;
    const r = quote({ poolState: state } as unknown as VirtualPool, config, amount, feeMode, direction, clock.point, firstSwapWithMinFee);

    // apply_swap_result
    const oldSqrtPrice = state.sqrtPrice;
    state.sqrtPrice = r.nextSqrtPrice;
    const creatorFee = config.creatorTradingFeePercentage === 0 ? ZERO : r.tradingFee.muln(config.creatorTradingFeePercentage).divn(100);
    const partnerFee = r.tradingFee.sub(creatorFee);
    if (feeMode.feesOnBaseToken) {
      state.partnerBaseFee = state.partnerBaseFee.add(partnerFee);
      state.protocolBaseFee = state.protocolBaseFee.add(r.protocolFee);
      state.creatorBaseFee = state.creatorBaseFee.add(creatorFee);
      state.totalProtocolBaseFee = state.totalProtocolBaseFee.add(r.protocolFee);
      state.totalTradingBaseFee = state.totalTradingBaseFee.add(r.tradingFee);
    } else {
      state.partnerQuoteFee = state.partnerQuoteFee.add(partnerFee);
      state.protocolQuoteFee = state.protocolQuoteFee.add(r.protocolFee);
      state.creatorQuoteFee = state.creatorQuoteFee.add(creatorFee);
      state.totalProtocolQuoteFee = state.totalProtocolQuoteFee.add(r.protocolFee);
      state.totalTradingQuoteFee = state.totalTradingQuoteFee.add(r.tradingFee);
    }
    const leavesReserve = feeMode.feesOnInput ? r.outputAmount : r.outputAmount.add(r.tradingFee).add(r.protocolFee).add(r.referralFee);
    if (direction === TradeDirection.BaseToQuote) {
      state.baseReserve = state.baseReserve.add(r.excludedFeeInputAmount);
      state.quoteReserve = state.quoteReserve.sub(leavesReserve);
    } else {
      state.quoteReserve = state.quoteReserve.add(r.excludedFeeInputAmount);
      state.baseReserve = state.baseReserve.sub(leavesReserve);
    }

    // update_post_swap
    if (dynamicOn) {
      const t = state.volatilityTracker;
      const va = t.volatilityReference.add(deltaBinId(dynamic.binStepU128, state.sqrtPrice, t.sqrtPriceReference).mul(BASIS_POINT_MAX));
      t.volatilityAccumulator = BN.min(va, new BN(dynamic.maxVolatilityAccumulator));
      if (deltaBinId(dynamic.binStepU128, oldSqrtPrice, state.sqrtPrice).gt(ZERO)) t.lastUpdateTimestamp = clock.timestamp;
    }
    state.hasSwap = true;

    return {
      direction,
      amountIn: r.includedFeeInputAmount,
      amountOut: r.outputAmount,
      amountLeft: r.amountLeft,
      protocolFee: r.protocolFee,
      referralFee: r.referralFee,
      partnerFee,
      creatorFee,
      feeOnBase: feeMode.feesOnBaseToken,
      nextSqrtPrice: r.nextSqrtPrice,
      curveComplete: this.complete,
    };
  }

  /** state/fee.rs update_references, called before every swap when the dynamic fee is on. */
  private updateReferences(timestamp: BN): void {
    const dynamic = this.config.poolFees.dynamicFee;
    const t = this.state.volatilityTracker;
    const elapsed = BN.max(timestamp.sub(t.lastUpdateTimestamp), ZERO);
    if (elapsed.gten(dynamic.filterPeriod)) {
      t.sqrtPriceReference = this.state.sqrtPrice;
      t.volatilityReference = elapsed.ltn(dynamic.decayPeriod) ? t.volatilityAccumulator.muln(dynamic.reductionFactor).div(BASIS_POINT_MAX) : ZERO;
    }
  }
}
