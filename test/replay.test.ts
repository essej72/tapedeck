// Replays of recorded pump.fun launches, and the bookkeeping every replay has to keep.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { BaseFeeMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { walkAway } from "../src/engine/buyout.ts";
import { design, designParams, flatFee, inventConfig, PUMP_CURVE, type DesignSpec } from "../src/engine/design.ts";
import { replay, Session, type Order, type Tape } from "../src/engine/replay.ts";
import { fromPumpfun, PUMP_CURVE_FEE } from "../src/flows/tapes.ts";

const pumpClone = () => design({ ...PUMP_CURVE, baseFee: flatFee(125), creatorTradingFeePercentage: 24, migrationFeeOption: 2 });
const guard: DesignSpec = { ...PUMP_CURVE, baseFee: { baseFeeMode: BaseFeeMode.FeeSchedulerExponential, feeSchedulerParam: { startingFeeBps: 5000, endingFeeBps: 125, numberOfPeriod: 30, totalDuration: 30 } }, activationType: 1, migrationFeeOption: 2 };

const dir = new URL("fixtures/pumpfun/", import.meta.url);
const tapes = readdirSync(dir).map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { kind: string; meta: Parameters<typeof fromPumpfun>[0]; trades: Parameters<typeof fromPumpfun>[1] });

test("there are pump.fun tapes to replay", () => assert.ok(tapes.length >= 2));

for (const t of tapes) {
  test(`pump.fun ${t.kind}: the DBC clone of pump.fun's curve returns the recorded tokens on every curve buy`, () => {
    const tape = fromPumpfun(t.meta, t.trades);
    const s = new Session(pumpClone(), tape, { record: true }).runToEnd();
    const gaps: number[] = [];
    for (const f of s.fills) {
      const was = f.order >= 0 ? tape.recorded?.[f.order] : undefined;
      if (f.onCurve && f.buy && was) gaps.push(Math.abs((f.quote * 1e9 * (1 - PUMP_CURVE_FEE)) / f.tokens / was - 1));
    }
    assert.ok(gaps.length > 0);
    gaps.sort((a, b) => a - b);
    assert.ok(gaps[Math.floor(gaps.length / 2)] < 0.001, `median gap ${gaps[Math.floor(gaps.length / 2)]}`);
    assert.equal(s.curve.complete, tape.graduated, "graduates in the replay exactly when it did in real life");
  });
}

const buy = (t: number, wallet: number, sol: number, inCreateTx = false): Order => ({ t, slot: Math.round(t / 0.219), wallet, buy: true, quote: BigInt(Math.round(sol * 1e9)), fraction: 0, inCreateTx });
const sell = (t: number, wallet: number, fraction: number): Order => ({ t, slot: Math.round(t / 0.219), wallet, buy: false, quote: 0n, fraction });
const tapeOf = (orders: Order[]): Tape => ({ id: "t", source: "test", creator: 0, wallets: 1 + Math.max(...orders.map((o) => o.wallet)), orders, graduated: false, complete: true });

test("money is conserved: what traders paid is in the curve, in fees, or back in their wallets", () => {
  const s = new Session(pumpClone(), tapeOf([buy(0, 0, 2), buy(1, 1, 5), sell(3, 0, 0.5), buy(4, 2, 1.5), sell(9, 1, 1), sell(12, 0, 1)])).runToEnd();
  const o = s.outcome();
  const paid = o.cohorts.reduce((x, c) => x + c.quoteIn, 0);
  const received = o.cohorts.reduce((x, c) => x + c.quoteOut, 0);
  const fees = o.fees.protocol + o.fees.partner + o.fees.creator + o.fees.referral;
  assert.ok(Math.abs(paid - received - fees - o.raised) < 1e-6, `${paid} - ${received} - ${fees} != ${o.raised}`);
});

test("a buy that completes the curve spends its change in the migrated pool", () => {
  const s = new Session(pumpClone(), tapeOf([buy(0, 0, 200, true)]), { record: true }).runToEnd();
  assert.ok(s.curve.complete);
  assert.ok(s.amm !== null);
  assert.ok(Math.abs(s.fills[0].quote - 200) < 1e-6, "the whole 200 SOL was spent");
  assert.ok(s.price > Number(s.config.migrationSqrtPrice.toString()) ** 2 / 2 ** 128, "and it moved the pool's price above the migration price");
});

test("a launch-slot buyout that is nearly free on a flat fee is expensive behind a decaying launch fee", () => {
  const tape = tapeOf([buy(0, 0, 87, true), sell(40, 0, 1)]);
  const flatCost = replay(pumpClone(), tape).cohorts[0];
  const guarded = replay(design(guard), tape);
  assert.ok(replay(pumpClone(), tape).graduated);
  assert.ok(!guarded.graduated, "half the buy went to fees, so the curve is not complete");
  assert.ok(flatCost.quoteIn - flatCost.quoteOut < guarded.cohorts[0].quoteIn - guarded.cohorts[0].quoteOut);
});

test("faking a graduation on pump.fun's own curve costs about the fifth of the raise that stays in the pool", () => {
  const w = walkAway(pumpClone());
  assert.ok(w.spend !== null && Math.abs(w.spend - 86.08) < 0.05, `spend ${w.spend}`);
  assert.ok(w.cost > 17 && w.cost < 20, `cost ${w.cost}`);
  // owning the liquidity makes it free; a 50% launch fee makes it ruinous
  assert.ok(walkAway(design({ ...PUMP_CURVE, baseFee: flatFee(25), partnerLockedLiquidity: 10 })).costShare < 0.05);
  assert.ok(walkAway(design(guard)).costShare > 1);
});

test("a design survives the SDK's own builder and reads back as the Invent CLI's config file", () => {
  const params = designParams(guard);
  assert.equal(params.activationType, 1);
  assert.equal(params.poolFees.baseFee.baseFeeMode, BaseFeeMode.FeeSchedulerExponential);
  const file = inventConfig(guard) as { dryRun: boolean; dbcConfig: { buildCurveMode: number; migrationQuoteThreshold: number; fee: { baseFeeParams: { feeSchedulerParam: { startingFeeBps: number } } } } };
  assert.equal(file.dryRun, true);
  assert.equal(file.dbcConfig.buildCurveMode, 0);
  assert.equal(file.dbcConfig.migrationQuoteThreshold, PUMP_CURVE.raise);
  assert.equal(file.dbcConfig.fee.baseFeeParams.feeSchedulerParam.startingFeeBps, 5000);
});
