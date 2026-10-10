// Fly one recorded launch through a config, order by order.
//
// A tape says who traded, when, and how much. In a replay every buyer spends the same quote amount at the same
// moment, and every seller sells the same share of whatever they hold by then. What changes is the curve and the
// fees they meet, and so what they get. An order fills on the bonding curve until the curve completes, and on the
// migrated pool after that, wherever the original trade happened: under a different config a launch can graduate
// earlier, later or not at all.
//
// This is a static replay. It answers "what would this exact flow have paid and received under this config", not
// "how would these traders have behaved under it". A Session also takes orders that are not on the tape, which is
// how a person, or a behaviour model, flies the launch differently.

import { ActivationType, SwapMode, TradeDirection, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { MigratedPool } from "./amm.ts";
import { SimPool } from "./pool.ts";

export type Order = {
  /** Seconds and slots since the launch transaction. */
  t: number;
  slot: number;
  wallet: number;
  buy: boolean;
  /** Buy: quote spent, in the quote token's smallest unit. */
  quote: bigint;
  /** Sell: share of the wallet's holdings sold, 0..1. */
  fraction: number;
  /** The creator's buy inside the launch transaction itself. */
  inCreateTx?: boolean;
};

export type Tape = {
  id: string;
  source: string;
  name?: string;
  /** Index of the creator's wallet, or -1 when it never traded. */
  creator: number;
  wallets: number;
  orders: Order[];
  /** Whether the launch reached migration in real life, and whether the tape covers it from the first trade. */
  graduated: boolean;
  complete: boolean;
  /** As recorded: the average price each order filled at (quote per base, smallest units), where the feed gives one. */
  recorded?: number[];
};

// Who a wallet is, by when it first bought: in the launch slot, within 2 s, within a minute, or after.
export const COHORTS = ["creator", "launch slot", "first 2 s", "first minute", "later"] as const;
export const cohortOf = (first: { slot: number; t: number }, isCreator: boolean): number => (isCreator ? 0 : first.slot <= 0 ? 1 : first.t <= 2 ? 2 : first.t <= 60 ? 3 : 4);

// Fee windows, in seconds since launch.
export const WINDOWS = [2, 10, 60, Infinity] as const;

/** quoteIn/quoteOut are cash paid and received; held is the cohort's tokens at the end, valued as the session says. */
export type CohortResult = { wallets: number; quoteIn: number; quoteOut: number; held: number; feesPaid: number };

export type Outcome = {
  id: string;
  graduated: boolean;
  /** Seconds from launch to the swap that completed the curve. */
  graduatedAt: number | null;
  ordersFilled: number;
  ordersSkipped: number;
  /** All amounts in whole quote tokens. */
  raised: number;
  buyVolume: number;
  /** Curve-phase trading fees by recipient, the migration fee, and fees taken by the migrated pool. */
  fees: { protocol: number; partner: number; creator: number; referral: number; migration: number; pool: number };
  feesByWindow: number[];
  cohorts: CohortResult[];
  peakPrice: number;
  finalPrice: number;
};

export type FillRecord = {
  /** Index into the tape, or -1 for an order that was not on it. */
  order: number;
  t: number;
  wallet: number;
  buy: boolean;
  /** Quote paid (buy) or received (sell), whole tokens. */
  quote: number;
  tokens: number;
  fee: number;
  /** Price after the fill, quote units per base unit. */
  price: number;
  onCurve: boolean;
};

export type SessionOptions = {
  quoteDecimals?: number;
  /** Shift the moment a tape order executes. Default: as recorded. */
  retime?: (order: Order, index: number) => { t: number; slot: number };
  /** Keep a record of every fill (for charts). Default false: only totals are kept. */
  record?: boolean;
  /** Extra wallets beyond the tape's, for orders flown in by hand. */
  extraWallets?: number;
};

const Q128 = 2 ** 128;
const priceOf = (sqrtPrice: BN): number => Number(sqrtPrice.toString()) ** 2 / Q128;
const num = (x: BN): number => Number(x.toString());
// Any origin works: the fee schedule and the volatility tracker only see differences from it.
const SLOT0 = 1_000_000;
const TS0 = 1_700_000_000;
export const SLOT_SECONDS = 0.219; // measured on mainnet over the collection window

export class Session {
  readonly config: PoolConfig;
  readonly tape: Tape;
  readonly curve: SimPool;
  amm: MigratedPool | null = null;
  /** Next tape order to execute. */
  cursor = 0;
  readonly fills: FillRecord[] = [];
  graduatedAt: number | null = null;
  filled = 0;
  skipped = 0;
  buyVolume = 0;
  peakPrice: number;
  readonly fees = { protocol: 0, partner: 0, creator: 0, referral: 0, migration: 0, pool: 0 };
  readonly feesByWindow = WINDOWS.map(() => 0);
  readonly tokens: BN[];
  readonly ledger: { quoteIn: number; quoteOut: number; fees: number; first: { slot: number; t: number } | null }[];
  private readonly unit: number;
  private readonly bySlot: boolean;
  private readonly opts: SessionOptions;

  constructor(config: PoolConfig, tape: Tape, opts: SessionOptions = {}) {
    this.config = config;
    this.tape = tape;
    this.opts = opts;
    this.unit = 10 ** (opts.quoteDecimals ?? 9);
    this.bySlot = config.activationType === ActivationType.Slot;
    this.curve = SimPool.fresh(config, new BN(this.bySlot ? SLOT0 : TS0));
    const n = tape.wallets + (opts.extraWallets ?? 0);
    this.tokens = Array.from({ length: n }, () => new BN(0));
    this.ledger = Array.from({ length: n }, () => ({ quoteIn: 0, quoteOut: 0, fees: 0, first: null }));
    this.peakPrice = this.price;
  }

  get done(): boolean {
    return this.cursor >= this.tape.orders.length;
  }

  /** Current price, quote units per base unit: the curve's until it completes, the migrated pool's after. */
  get price(): number {
    return this.amm ? this.amm.price : priceOf(this.curve.state.sqrtPrice);
  }

  /** Time of the next tape order, or Infinity. */
  get nextAt(): number {
    const o = this.tape.orders[this.cursor];
    if (!o) return Infinity;
    return this.opts.retime ? this.opts.retime(o, this.cursor).t : o.t;
  }

  /** Execute the next order on the tape. Returns false when the tape has run out. */
  step(): boolean {
    const o = this.tape.orders[this.cursor];
    if (!o) return false;
    const when = this.opts.retime ? this.opts.retime(o, this.cursor) : o;
    this.execute(this.cursor, o.wallet, o.buy, o.quote, o.fraction, when, Boolean(o.inCreateTx));
    this.cursor++;
    return true;
  }

  /** Execute every tape order up to and including time t. */
  runTo(t: number): void {
    while (this.nextAt <= t) this.step();
  }

  runToEnd(): this {
    while (this.step());
    return this;
  }

  /** An order that is not on the tape, executed now (at time t, after everything the tape did up to t). */
  fly(wallet: number, buy: boolean, amount: { quote?: bigint; fraction?: number }, t: number): FillRecord | null {
    this.runTo(t);
    return this.execute(-1, wallet, buy, amount.quote ?? 0n, amount.fraction ?? 0, { t, slot: Math.round(t / SLOT_SECONDS) }, false);
  }

  private execute(index: number, wallet: number, buy: boolean, quote: bigint, fraction: number, when: { t: number; slot: number }, inCreateTx: boolean): FillRecord | null {
    const held = this.tokens[wallet];
    const amount = buy ? new BN(quote.toString()) : fraction >= 1 ? held : held.mul(new BN(Math.round(fraction * 1e9))).div(new BN(1e9));
    if (amount.isZero()) {
      this.skipped++;
      return null;
    }
    let paid: number;
    let got: number;
    let fee = 0;
    let onCurve = true;
    try {
      if (this.amm) {
        onCurve = false;
        const r = buy ? this.amm.buy(amount) : this.amm.sell(amount);
        if (r.out.isZero()) throw new Error("dust");
        fee = num(r.fee) / this.unit;
        this.fees.pool += fee;
        if (buy) {
          this.tokens[wallet] = held.add(r.out);
          paid = num(amount) / this.unit;
          got = num(r.out);
        } else {
          this.tokens[wallet] = held.sub(amount);
          paid = num(amount);
          got = num(r.out) / this.unit;
        }
      } else {
        const clock = { point: new BN(this.bySlot ? SLOT0 + when.slot : TS0 + Math.floor(when.t)), timestamp: new BN(TS0 + Math.floor(when.t)) };
        const f = buy
          ? this.curve.swap(TradeDirection.QuoteToBase, amount, clock, { mode: SwapMode.PartialFill, firstSwapInCreateTx: inCreateTx })
          : this.curve.swap(TradeDirection.BaseToQuote, amount, clock);
        const price = priceOf(f.nextSqrtPrice);
        // Fees in quote terms: a fee taken in tokens is valued at the price the swap ended on.
        const q = (x: BN) => (f.feeOnBase ? num(x) * price : num(x)) / this.unit;
        const parts = { protocol: q(f.protocolFee), partner: q(f.partnerFee), creator: q(f.creatorFee), referral: q(f.referralFee) };
        this.fees.protocol += parts.protocol;
        this.fees.partner += parts.partner;
        this.fees.creator += parts.creator;
        this.fees.referral += parts.referral;
        fee = parts.protocol + parts.partner + parts.creator + parts.referral;
        if (buy) {
          this.tokens[wallet] = held.add(f.amountOut);
          paid = num(f.amountIn) / this.unit;
          got = num(f.amountOut);
        } else {
          this.tokens[wallet] = held.sub(f.amountIn);
          paid = num(f.amountIn);
          got = num(f.amountOut) / this.unit;
        }
        if (f.curveComplete) {
          this.graduatedAt = when.t;
          const amm = new MigratedPool(this.config);
          this.fees.migration = num(amm.migrationFee) / this.unit;
          if (amm.usable) this.amm = amm;
          // The buy that completes the curve usually has money left over. The buyer meant to spend it, so the
          // rest goes into the migrated pool at once, as it would in the next instruction of a real bundle.
          const change = buy ? amount.sub(f.amountIn) : new BN(0);
          if (this.amm && change.gtn(0)) {
            const r = this.amm.buy(change);
            const poolFee = num(r.fee) / this.unit;
            this.fees.pool += poolFee;
            fee += poolFee;
            this.tokens[wallet] = this.tokens[wallet].add(r.out);
            paid += num(change) / this.unit;
            got += num(r.out);
          }
        }
      }
    } catch {
      this.skipped++;
      return null;
    }
    this.filled++;
    const l = this.ledger[wallet];
    l.fees += fee;
    this.feesByWindow[WINDOWS.findIndex((s) => when.t < s)] += fee;
    if (buy) {
      l.quoteIn += paid;
      l.first ??= { slot: when.slot, t: when.t };
      this.buyVolume += paid;
    } else l.quoteOut += got;
    const price = this.price;
    if (price > this.peakPrice) this.peakPrice = price;
    const record: FillRecord = { order: index, t: when.t, wallet, buy, quote: buy ? paid : got, tokens: buy ? got : paid, fee, price, onCurve };
    if (this.opts.record) this.fills.push(record);
    return record;
  }

  /**
   * What a wallet's remaining tokens are worth if it sold them now into what is there, alone. On an unfinished
   * curve that cannot exceed its share of the reserve, so it is marked at that share.
   */
  heldValue(wallet: number): number {
    const held = num(this.tokens[wallet]);
    if (held <= 0) return 0;
    if (this.amm) {
      const out = (num(this.amm.quote) * held) / (num(this.amm.base) + held);
      return (out * (1 - num(this.amm.feePpm) / 1e6)) / this.unit;
    }
    const outstanding = this.tokens.reduce((s, x) => s + num(x), 0);
    return outstanding > 0 ? ((held / outstanding) * num(this.curve.state.quoteReserve)) / this.unit : 0;
  }

  outcome(): Outcome {
    const cohorts: CohortResult[] = COHORTS.map(() => ({ wallets: 0, quoteIn: 0, quoteOut: 0, held: 0, feesPaid: 0 }));
    for (let i = 0; i < this.tape.wallets; i++) {
      const l = this.ledger[i];
      if (!l.first) continue;
      const c = cohorts[cohortOf(l.first, i === this.tape.creator)];
      c.wallets++;
      c.quoteIn += l.quoteIn;
      c.quoteOut += l.quoteOut;
      c.held += this.heldValue(i);
      c.feesPaid += l.fees;
    }
    return {
      id: this.tape.id,
      graduated: this.curve.complete,
      graduatedAt: this.graduatedAt,
      ordersFilled: this.filled,
      ordersSkipped: this.skipped,
      raised: num(this.curve.state.quoteReserve) / this.unit,
      buyVolume: this.buyVolume,
      fees: { ...this.fees },
      feesByWindow: [...this.feesByWindow],
      cohorts,
      peakPrice: this.peakPrice,
      finalPrice: this.price,
    };
  }
}

export const replay = (config: PoolConfig, tape: Tape, opts: SessionOptions = {}): Outcome => new Session(config, tape, opts).runToEnd().outcome();
