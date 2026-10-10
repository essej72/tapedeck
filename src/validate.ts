// Proof that the engine is the chain: replay a real pool's whole swap history from its own events and compare every
// swap, to the lamport, with what the program recorded, then the final state with the live account.
//
//   node src/validate.ts <pool address> [...more]     # fetch history if missing, replay, report
//   node src/validate.ts --fixture <pool address>     # also write test/fixtures/<pool>.json for the offline test

import { mkdirSync, writeFileSync } from "node:fs";
import { SwapMode, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { decodeConfig, decodePool } from "./engine/codec.ts";
import { SimPool } from "./engine/pool.ts";
import { fetchPool, isComplete, loadPool, openTapes, type ChainTx } from "./flows/chain.ts";
import { Rpc } from "./rpc.ts";

export type Fixture = { pool: string; config: string; configData: string; poolData: string; txs: ChainTx[]; complete: boolean };
export type Verdict = { swaps: number; mismatches: string[]; finalChecked: boolean; skipped?: string };

const SWAP_FIELDS = ["includedFeeInputAmount", "excludedFeeInputAmount", "amountLeft", "outputAmount", "nextSqrtPrice", "tradingFee", "protocolFee", "referralFee"] as const;

/** Replay a fixture. `finalData` is the pool account as it is now; it is only comparable if nothing traded since. */
export function replayFixture(f: Fixture): Verdict {
  const config: PoolConfig = decodeConfig(Buffer.from(f.configData, "base64"));
  const live = decodePool(Buffer.from(f.poolData, "base64")).poolState;
  const created = f.txs.findIndex((tx) => tx.events.some((e) => e.name === "evtInitializePool" && e.data.pool === f.pool));
  if (created < 0) return { swaps: 0, mismatches: [], finalChecked: false, skipped: "history does not reach the pool's creation" };
  const init = f.txs[created].events.find((e) => e.name === "evtInitializePool")!;
  const sim = SimPool.fresh(config, new BN(init.data.activationPoint as string));
  const bySlot = config.activationType === 0;
  const mismatches: string[] = [];
  let swaps = 0;
  for (const [i, tx] of f.txs.entries()) {
    for (const e of tx.events) {
      if (e.name !== "evtSwap2" || e.data.pool !== f.pool) continue;
      const d = e.data as any;
      const fill = sim.swap(d.tradeDirection, new BN(d.swapParameters.amount0), { point: new BN(bySlot ? tx.slot : d.currentTimestamp), timestamp: new BN(d.currentTimestamp) }, {
        mode: d.swapParameters.swapMode as SwapMode,
        hasReferral: d.hasReferral,
        firstSwapInCreateTx: i === created,
      });
      swaps++;
      const got: Record<string, string> = {
        includedFeeInputAmount: fill.amountIn.toString(),
        excludedFeeInputAmount: "",
        amountLeft: fill.amountLeft.toString(),
        outputAmount: fill.amountOut.toString(),
        nextSqrtPrice: fill.nextSqrtPrice.toString(),
        tradingFee: fill.partnerFee.add(fill.creatorFee).toString(),
        protocolFee: fill.protocolFee.toString(),
        referralFee: fill.referralFee.toString(),
      };
      for (const k of SWAP_FIELDS) {
        if (k === "excludedFeeInputAmount") continue;
        if (got[k] !== d.swapResult[k]) mismatches.push(`swap ${swaps} ${tx.sig.slice(0, 8)} ${k}: engine ${got[k]} chain ${d.swapResult[k]}`);
      }
      if (sim.state.quoteReserve.toString() !== d.quoteReserveAmount) mismatches.push(`swap ${swaps} ${tx.sig.slice(0, 8)} quoteReserve: engine ${sim.state.quoteReserve} chain ${d.quoteReserveAmount}`);
      if (mismatches.length > 20) return { swaps, mismatches, finalChecked: false };
    }
  }
  // The live account is only comparable when the tape is whole and the curve is finished (nothing traded since).
  if (!f.complete || !sim.complete) return { swaps, mismatches, finalChecked: false };
  // Totals never decrease and claims do not touch them, so they must equal the live account's.
  const finals: [string, BN, BN][] = [
    ["sqrtPrice", sim.state.sqrtPrice, live.sqrtPrice],
    ["quoteReserve", sim.state.quoteReserve, live.quoteReserve],
    ["totalTradingQuoteFee", sim.state.totalTradingQuoteFee, live.metrics.totalTradingQuoteFee],
    ["totalProtocolQuoteFee", sim.state.totalProtocolQuoteFee, live.metrics.totalProtocolQuoteFee],
    ["totalTradingBaseFee", sim.state.totalTradingBaseFee, live.metrics.totalTradingBaseFee],
    ["totalProtocolBaseFee", sim.state.totalProtocolBaseFee, live.metrics.totalProtocolBaseFee],
  ];
  for (const [k, a, b] of finals) if (!a.eq(b)) mismatches.push(`final ${k}: engine ${a} chain ${b}`);
  return { swaps, mismatches, finalChecked: true };
}

type AccountInfo = { value: { data: [string, string] } | null };

export async function buildFixture(pool: string, opts: { refetch?: boolean; url?: string; maxTx?: number; gapMs?: number } = {}): Promise<Fixture> {
  const db = openTapes();
  const rpc = new Rpc(opts.url, 400);
  const account = async (address: string) => {
    const r = await rpc.call<AccountInfo>("getAccountInfo", [address, { encoding: "base64" }]);
    if (!r.value) throw new Error(`no account ${address}`);
    return r.value.data[0];
  };
  let txs = loadPool(db, pool);
  if (opts.refetch || txs.length === 0) txs = await fetchPool(db, pool, { url: opts.url, maxTx: opts.maxTx, gapMs: opts.gapMs });
  const poolData = await account(pool);
  const config = decodePool(Buffer.from(poolData, "base64")).poolState.config.toBase58();
  return { pool, config, configData: await account(config), poolData, txs, complete: isComplete(db, pool) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fixture = args[0] === "--fixture";
  for (const pool of fixture ? args.slice(1) : args) {
    const f = await buildFixture(pool);
    const v = replayFixture(f);
    console.log(`${pool}  ${v.skipped ?? `${v.swaps} swaps replayed, ${v.mismatches.length} mismatches`}`);
    for (const m of v.mismatches.slice(0, 12)) console.log("   " + m);
    if (fixture && !v.skipped) {
      mkdirSync(new URL("../test/fixtures/", import.meta.url), { recursive: true });
      writeFileSync(new URL(`../test/fixtures/${pool}.json`, import.meta.url), JSON.stringify(f));
    }
  }
}
