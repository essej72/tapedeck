// Does Meteora's DAMM v2 SDK quote the way DAMM v2 trades?
//
//   node src/dammsdk.ts accounts [--file data/afterwards.jsonl] [--out data/damm-pools.jsonl]
//   node src/dammsdk.ts check [--sdk data/damm-sdk.cjs] [--file data/afterwards.jsonl] [--pools data/damm-pools.jsonl] [--json web/data/dammsdk.json]
//
// afterwards.ts replays the first swaps of each migrated DAMM v2 pool with this project's engine and holds every one
// to DAMM v2's own events. This puts the SDK in the engine's seat. Before each swap the SDK is handed the pool as an
// integrator would have fetched it: the pool's own account for what does not move (fee settings, price range,
// activation), with the price, liquidity, reserves and remembered volatility as they stood before that swap. Its
// answer (output or cost, fee, next price) has to be what the program recorded.
//
// Without --sdk it is the published package this project installs. With it, a bundle of any checkout
// (scripts/bundle-damm-sdk.mjs), so a branch can be checked before release.

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Connection } from "@solana/web3.js";
import BN from "bn.js";
import { readAfterwards, replayAfterwards, type After, type Afterwards } from "./afterwards.ts";
import type { MigratedPool } from "./engine/amm.ts";
import { readLines } from "./migration.ts";
import { Rpc, RPC_URL } from "./rpc.ts";

type Swap = Extract<After, { kind: "swap" }>;
/** The SDK's SwapResult2, as far as it is compared. */
type Result = { outputAmount: BN; includedFeeInputAmount: BN; nextSqrtPrice: BN; claimingFee: BN; compoundingFee: BN; protocolFee: BN; referralFee: BN };
/** The pool account as the SDK decodes it; only the fields that move are named. */
type PoolState = {
  sqrtPrice: BN;
  liquidity: BN;
  tokenAAmount: BN;
  tokenBAmount: BN;
  activationType: number;
  collectFeeMode: number;
  poolFees: { dynamicFee: { initialized: number; lastUpdateTimestamp: BN; sqrtPriceReference: BN; volatilityAccumulator: BN; volatilityReference: BN; [k: string]: unknown }; [k: string]: unknown };
  [k: string]: unknown;
};
export type DammSdk = {
  CpAmm: new (c: Connection) => { _program: { coder: { accounts: { decode(name: string, data: Buffer): PoolState } } } };
  getFeeMode(collectFeeMode: number, tradeDirection: number, hasReferral: boolean): unknown;
  getSwapResultFromExactInput(pool: PoolState, amount: BN, feeMode: unknown, tradeDirection: number, currentPoint: BN): Result;
  getSwapResultFromPartialInput(pool: PoolState, amount: BN, feeMode: unknown, tradeDirection: number, currentPoint: BN): Result;
  getSwapResultFromExactOutput(pool: PoolState, amount: BN, feeMode: unknown, tradeDirection: number, currentPoint: BN): Result;
};

// DAMM v2's TradeDirection: token A is the launched token, token B the quote.
const A_TO_B = 0;
const B_TO_A = 1;

/** The account with the engine's state before a swap laid over the fields that move. */
function before(account: PoolState, pool: MigratedPool): PoolState {
  const d = account.poolFees.dynamicFee;
  const v = pool.volatility;
  return {
    ...account,
    sqrtPrice: pool.sqrtPrice!,
    liquidity: pool.liquidity ?? account.liquidity,
    // a compounding pool trades on what it holds
    ...(pool.compounding ? { tokenAAmount: pool.base, tokenBAmount: pool.quote } : {}),
    poolFees: { ...account.poolFees, dynamicFee: d.initialized ? { ...d, lastUpdateTimestamp: new BN(v.lastUpdate), sqrtPriceReference: v.sqrtPriceReference, volatilityAccumulator: v.accumulator, volatilityReference: v.reference } : d },
  };
}

export type SdkVerdict = { swaps: number; exactOut: number; partial: number; mismatches: string[]; skipped?: string };

/** One pool: every swap the engine replays, asked of the SDK first. `data` is the DAMM v2 pool account. */
export function sdkAgainstPool(sdk: DammSdk, decode: (data: Buffer) => PoolState, row: Afterwards, data: Buffer): SdkVerdict {
  const account = decode(data);
  const out: SdkVerdict = { swaps: 0, exactOut: 0, partial: 0, mismatches: [] };
  // The fee schedule and the pool's opening are counted in seconds here. A pool that counts in slots would need each
  // swap's slot, which the rows do not keep.
  if (account.activationType !== 1) return { ...out, skipped: "counts in slots" };
  const same = (label: string, sdkSays: unknown, chain: unknown) => {
    if (String(sdkSays) !== String(chain)) out.mismatches.push(`${label}: SDK ${String(sdkSays)}, chain ${String(chain)}`);
  };
  const engine = replayAfterwards(row, (pool, e: Swap, n) => {
    if (out.mismatches.length) return;
    const at = `swap ${n} ${e.sig.slice(0, 8)}`;
    const direction = e.buy ? B_TO_A : A_TO_B;
    const feeMode = sdk.getFeeMode(account.collectFeeMode, direction, false);
    const state = before(account, pool);
    const point = new BN(e.ts ?? 0);
    let r: Result;
    try {
      r = e.mode === 2 ? sdk.getSwapResultFromExactOutput(state, new BN(e.amount), feeMode, direction, point) : e.mode === 1 ? sdk.getSwapResultFromPartialInput(state, new BN(e.amount), feeMode, direction, point) : sdk.getSwapResultFromExactInput(state, new BN(e.amount), feeMode, direction, point);
    } catch (err) {
      out.mismatches.push(`${at}: the SDK throws (${err instanceof Error ? err.message || err.name : String(err)}), the program traded`);
      return;
    }
    out.swaps++;
    if (e.mode === 2) out.exactOut++;
    if (e.mode === 1) out.partial++;
    if (e.mode === 2) same(`${at} exact-out cost`, r.includedFeeInputAmount, e.spent);
    else same(`${at} output`, r.outputAmount, e.out);
    same(`${at} fee`, r.claimingFee.add(r.compoundingFee).add(r.protocolFee).add(r.referralFee), e.fee);
    same(`${at} next price`, r.nextSqrtPrice, e.nextSqrtPrice);
  });
  // Where the engine itself is off, its state is no ground to judge the SDK from.
  if (engine.mismatches.length) return { swaps: 0, exactOut: 0, partial: 0, mismatches: [], skipped: "the engine does not agree with the chain here" };
  return out;
}

/** `from`: a bundle (scripts/bundle-damm-sdk.mjs), or the name of an installed package. */
export async function loadSdk(from: string): Promise<DammSdk> {
  return (await import(existsSync(from) ? pathToFileURL(resolve(from)).href : from)) as DammSdk;
}

export const decoder = (sdk: DammSdk) => {
  const coder = new sdk.CpAmm(new Connection(RPC_URL))._program.coder.accounts;
  return (data: Buffer) => coder.decode("pool", data);
};

export function summarize(sdk: DammSdk, rows: Afterwards[], accounts: Map<string, Buffer>) {
  const decode = decoder(sdk);
  const verdicts = rows.filter((r) => r.damm && accounts.has(r.damm.pool)).map((r) => ({ pool: r.damm!.pool, row: r, v: sdkAgainstPool(sdk, decode, r, accounts.get(r.damm!.pool)!) }));
  const asked = verdicts.filter((x) => x.v.swaps > 0);
  const differing = verdicts.filter((x) => x.v.mismatches.length).map((x) => ({ pool: x.pool, first: x.v.mismatches[0] }));
  const swapsWhere = (f: (r: Afterwards) => boolean | undefined) => asked.reduce((n, x) => n + (f(x.row) ? x.v.swaps : 0), 0);
  return {
    pools: asked.length,
    swaps: asked.reduce((n, x) => n + x.v.swaps, 0),
    exactOut: asked.reduce((n, x) => n + x.v.exactOut, 0),
    partial: asked.reduce((n, x) => n + x.v.partial, 0),
    dynamicSwaps: swapsWhere((r) => r.damm?.dynamicFee),
    scheduledSwaps: swapsWhere((r) => r.damm?.scheduled),
    compoundingSwaps: swapsWhere((r) => r.damm?.collectFeeMode === 2),
    skipped: verdicts.filter((x) => x.v.skipped).length,
    agree: asked.length - differing.length,
    differing,
  };
}

/** The pool accounts, one `{ pool, data }` line each (data base64). */
export const readAccounts = (file: string | URL): Map<string, Buffer> => new Map(readLines(file).map((l) => JSON.parse(l) as { pool: string; data: string }).map((a) => [a.pool, Buffer.from(a.data, "base64")]));

// ---------------------------------------------------------------- commands

const args = import.meta.main ? process.argv.slice(2) : [];
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

if (args[0] === "accounts") {
  const out = flag("--out") ?? "data/damm-pools.jsonl";
  const have = existsSync(out) ? readAccounts(out) : new Map<string, Buffer>();
  const want = readAfterwards(flag("--file") ?? "data/afterwards.jsonl").map((r) => r.damm?.pool).filter((p): p is string => Boolean(p) && !have.has(p!));
  const rpc = new Rpc(RPC_URL, 350);
  for (let i = 0; i < want.length; i += 100) {
    const batch = want.slice(i, i + 100);
    const res = await rpc.call<{ value: ({ data: [string, string] } | null)[] }>("getMultipleAccounts", [batch, { encoding: "base64" }]);
    res.value.forEach((a, j) => a && appendFileSync(out, JSON.stringify({ pool: batch[j], data: a.data[0] }) + "\n"));
  }
  console.log(`${readAccounts(out).size} DAMM v2 pool accounts in ${out}`);
} else if (args[0] === "check") {
  const file = flag("--sdk") ?? "@meteora-ag/cp-amm-sdk";
  const s = summarize(await loadSdk(file), readAfterwards(flag("--file") ?? "data/afterwards.jsonl"), readAccounts(flag("--pools") ?? "data/damm-pools.jsonl"));
  console.log(`${s.swaps} swaps in ${s.pools} DAMM v2 pools put to the SDK (${s.exactOut} exact-out, ${s.partial} partial-fill; ${s.dynamicSwaps} under a dynamic fee, ${s.scheduledSwaps} under a fee schedule, ${s.compoundingSwaps} in compounding pools)`);
  console.log(`output or cost, fee and next price as the program recorded them in ${s.agree} of ${s.pools} pools; ${s.skipped} pools left out`);
  for (const d of s.differing.slice(0, 20)) console.log(`  ${d.pool.slice(0, 8)} ${d.first}`);
  if (flag("--json")) writeFileSync(flag("--json")!, JSON.stringify({ generatedAt: new Date().toISOString(), sdk: flag("--name") ?? file, ...s, differing: s.differing.slice(0, 20) }, null, 1));
  process.exit(s.differing.length ? 1 : 0);
}
