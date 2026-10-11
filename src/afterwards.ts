// Does trading in the migrated pool go the way the engine says?
//
//   node src/afterwards.ts run [swaps per pool, default 40]     read what happened in each migrated DAMM v2 pool
//   node src/afterwards.ts check [--file data/afterwards.jsonl] [--json web/data/afterwards.json]
//
// migration.ts holds the engine to what moves into the new pool. This goes one step on: the first transactions of
// each DAMM v2 pool after its migration, with DAMM v2's own events (pool initialised, liquidity added or removed,
// swaps). The engine's migrated pool is built from the DBC config and pool accounts alone, takes the moment of migration and
// later changes of liquidity from the chain, and
// has to give every swap's output, next price and fee as DAMM v2 recorded them.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createDammV2Program, DAMM_V2_PROGRAM_ID } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { enginePool, poolShape, readLines, readMigrations, type Migration } from "./migration.ts";
import { Rpc, RPC_URL } from "./rpc.ts";

/** One DAMM v2 event of the pool, in chain order. Integers as decimal strings. */
export type After =
  | { kind: "init"; sig: string; liquidity: string; sqrtPrice: string; /** DAMM v2's dynamic fee settings, when the pool has one. */ dynamic?: Record<string, string> | null; /** The base fee as DAMM v2 took it (27 bytes, hex) and when the pool opened. */ baseFee?: string; activationPoint?: string }
  | { kind: "liquidity"; sig: string; delta: string; remove: boolean; /** The token amounts that moved with it. */ base?: string; quote?: string }
  | { kind: "swap"; sig: string; buy: boolean; mode: number; amount: string; spent: string; out: string; nextSqrtPrice: string; fee: string; amountLeft: string; transferFee: boolean; /** Unix time of the swap. */ ts?: number }
  /** An event of DAMM v2 this reader does not know (an older swap event, a fee update): the replay stops there. */
  | { kind: "unknown"; sig: string };
export type Afterwards = Migration & { after: After[]; transactions: number };

/** `exactOut`: how many of the swaps were exact-out. `cutShort`: partial fills that ran out of range, taken from the chain. */
export type AfterVerdict = { swaps: number; exactOut: number; cutShort: number; mismatches: string[]; stopped?: string };

/** Replay a migrated pool's first swaps from the DBC accounts alone and compare each with what DAMM v2 recorded. */
export function replayAfterwards(row: Afterwards): AfterVerdict {
  const shape = poolShape(row);
  if (!shape || !row.damm || !(shape.fullRange && shape.feeAsEngine && shape.feeSideAsEngine)) return { swaps: 0, exactOut: 0, cutShort: 0, mismatches: [], stopped: "a kind of pool the engine does not model" };
  const pool = enginePool(row);
  const opening = row.after.find((e) => e.kind === "init");
  if (row.damm.scheduled && (!opening || opening.kind !== "init" || !opening.baseFee)) return { swaps: 0, exactOut: 0, cutShort: 0, mismatches: [], stopped: "a fee schedule, read before the reader kept its settings" };
  if ((!pool.liquidity && !pool.compounding) || !pool.sqrtPrice) return { swaps: 0, exactOut: 0, cutShort: 0, mismatches: [], stopped: "not a DAMM v2 pool" };
  const mismatches: string[] = [];
  const same = (label: string, mine: unknown, theirs: unknown) => {
    if (String(mine) !== String(theirs)) mismatches.push(`${label}: engine ${String(mine)}, chain ${String(theirs)}`);
  };
  // The fee schedule: DAMM v2's own record of it (cliff, periods, step, expiry, reduction, mode) against the engine's
  // reading of the config. It counts from the moment the pool opened, which is the chain's to say.
  if (opening?.kind === "init" && opening.baseFee) {
    const b = Buffer.from(opening.baseFee, "hex");
    const mode = b[26];
    if (mode === 3 || mode === 4) {
      const mine = pool.schedule;
      same("fee schedule", mine ? "on" : "off", "on");
      if (mine) {
        same("fee schedule periods", mine.numberOfPeriod, b.readUInt16LE(8));
        same("fee schedule step", mine.sqrtPriceStepBps, b.readUInt32LE(10));
        same("fee schedule expiry", mine.expirationDuration, b.readUInt32LE(14));
        same("fee schedule reduction", mine.reductionFactor, b.readBigUInt64LE(18));
        same("fee schedule kind", mine.exponential ? 4 : 3, mode);
      }
    } else same("fee schedule", pool.schedule ? "on" : "off", "off");
    pool.openedAt = Number(opening.activationPoint ?? 0);
  }
  // The dynamic fee: whether the pool has one, and its settings, are the engine's reading of the config.
  const theirs = row.after.find((e) => e.kind === "init")?.dynamic ?? null;
  if (Boolean(theirs) !== Boolean(pool.dynamic)) same("dynamic fee", pool.dynamic ? "on" : "off", theirs ? "on" : "off");
  else if (theirs && pool.dynamic) for (const [k, v] of Object.entries(pool.dynamic)) same(`dynamic fee ${k}`, v, theirs[k]);
  if (mismatches.length) return { swaps: 0, exactOut: 0, cutShort: 0, mismatches };
  // The migration transaction itself: the pool opens with the first position and may get a second. Together they
  // have to be the liquidity the engine worked out from the config.
  let opened = new BN(0);
  let swaps = 0;
  let exactOut = 0;
  let cutShort = 0;
  let migrating = true;
  for (const e of row.after) {
    if (migrating && e.sig !== row.sig) {
      migrating = false;
      if (pool.liquidity) same("liquidity at migration", pool.liquidity, opened);
      if (mismatches.length) return { swaps, exactOut, cutShort, mismatches };
    }
    if (e.kind === "unknown") return { swaps, exactOut, cutShort, mismatches, stopped: "an event of DAMM v2 this reader does not know" };
    if (e.kind === "init") {
      opened = opened.add(new BN(e.liquidity));
      same("opening price", pool.sqrtPrice, e.sqrtPrice);
    } else if (e.kind === "liquidity") {
      if (migrating) opened = opened.add(new BN(e.delta));
      else if (pool.liquidity) pool.liquidity = e.remove ? pool.liquidity.sub(new BN(e.delta)) : pool.liquidity.add(new BN(e.delta));
      else {
        // a compounding pool is just what it holds: the tokens that came or went are the change
        if (e.base === undefined || e.quote === undefined) return { swaps, exactOut, cutShort, mismatches, stopped: "a change of liquidity read before the reader kept its amounts" };
        pool.base = e.remove ? pool.base.sub(new BN(e.base)) : pool.base.add(new BN(e.base));
        pool.quote = e.remove ? pool.quote.sub(new BN(e.quote)) : pool.quote.add(new BN(e.quote));
      }
    } else {
      if (e.transferFee) return { swaps, exactOut, cutShort, mismatches, stopped: "a token with a transfer fee" };
      if (e.amountLeft !== "0") {
        // a partial fill that ran out of price range: taken from the chain, not replayed
        cutShort++;
        pool.sqrtPrice = new BN(e.nextSqrtPrice);
        continue;
      }
      swaps++;
      const at = `swap ${swaps} ${e.sig.slice(0, 8)}`;
      if (e.mode === 2) {
        exactOut++;
        const r = e.buy ? pool.buyExactOut(new BN(e.amount), e.ts ?? 0) : pool.sellExactOut(new BN(e.amount), e.ts ?? 0);
        same(`${at} exact-out cost`, r.cost, e.spent);
        same(`${at} fee`, r.fee, e.fee);
      } else {
        const r = e.buy ? pool.buy(new BN(e.amount), e.ts ?? 0) : pool.sell(new BN(e.amount), e.ts ?? 0);
        same(`${at} output`, r.out, e.out);
        same(`${at} fee`, r.fee, e.fee);
      }
      same(`${at} next price`, pool.sqrtPrice, e.nextSqrtPrice);
      if (mismatches.length) return { swaps, exactOut, cutShort, mismatches };
    }
  }
  if (migrating && pool.liquidity) same("liquidity at migration", pool.liquidity, opened);
  return { swaps, exactOut, cutShort, mismatches };
}

export const readAfterwards = (file: string | URL): Afterwards[] => readLines(file).map((l) => JSON.parse(l));

export function summarize(rows: Afterwards[]) {
  const verdicts = rows.map((r) => ({ pool: r.pool, v: replayAfterwards(r) }));
  const replayed = verdicts.filter((x) => x.v.swaps > 0 || (!x.v.stopped && x.v.mismatches.length === 0));
  const differing = verdicts.filter((x) => x.v.mismatches.length).map((x) => ({ pool: x.pool, first: x.v.mismatches[0] }));
  return {
    pools: rows.length,
    notModelled: verdicts.filter((x) => x.v.stopped?.startsWith("a kind of pool")).length,
    compoundingPools: rows.filter((r, i) => r.damm?.collectFeeMode === 2 && verdicts[i].v.swaps > 0).length,
    compoundingSwaps: rows.reduce((n, r, i) => n + (r.damm?.collectFeeMode === 2 ? verdicts[i].v.swaps : 0), 0),
    scheduledPools: rows.filter((r, i) => r.damm?.scheduled && verdicts[i].v.swaps > 0).length,
    scheduledSwaps: rows.reduce((n, r, i) => n + (r.damm?.scheduled ? verdicts[i].v.swaps : 0), 0),
    // pools with DAMM v2's dynamic fee among those replayed, and their swaps
    dynamicPools: rows.filter((r, i) => r.damm?.dynamicFee && verdicts[i].v.swaps > 0).length,
    dynamicSwaps: rows.reduce((n, r, i) => n + (r.damm?.dynamicFee ? verdicts[i].v.swaps : 0), 0),
    replayed: replayed.length,
    withSwaps: verdicts.filter((x) => x.v.swaps > 0).length,
    swaps: verdicts.reduce((n, x) => n + x.v.swaps, 0),
    buys: rows.reduce((n, r, i) => n + (verdicts[i].v.swaps ? r.after.filter((e) => e.kind === "swap" && e.buy).length : 0), 0),
    liquidityChanges: rows.reduce((n, r) => n + r.after.filter((e) => e.kind === "liquidity" && e.sig !== r.sig).length, 0),
    exactOut: verdicts.reduce((n, x) => n + x.v.exactOut, 0),
    takenFromChain: verdicts.reduce((n, x) => n + x.v.cutShort, 0),
    stoppedEarly: verdicts.filter((x) => x.v.stopped && !x.v.stopped.startsWith("a kind of pool")).length,
    agree: replayed.length - differing.length,
    differing,
  };
}

// ---------------------------------------------------------------- commands

type RawTx = { slot: number; transaction: { message: { accountKeys: string[] } }; meta: { err: unknown; innerInstructions: { instructions: { programIdIndex: number; data: string }[] }[] | null; loadedAddresses?: { writable: string[]; readonly: string[] } } | null };
const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
// DAMM v2 once reported liquidity with EvtAddLiquidity and EvtRemoveLiquidity, which its IDL no longer lists; for a
// while it emitted them next to EvtLiquidityChange. Both start: pool, position, owner, then the liquidity as a u128.
const LEGACY_LIQUIDITY: Record<string, boolean> = { aff2089d1ef7b9a9: false, "572e5862af60225b": true }; // discriminator -> is a removal
// And swaps with EvtSwap, before EvtSwap2: pool, direction, referral flag, amount in, minimum out, then the result
// (output, next sqrt price, four fees), the amount actually taken and the time. 122 bytes, always exact-in.
const LEGACY_SWAP = "1b3c15d58aaabb93";
// only when this file is the one being run: another tool that imports it keeps its own arguments
const args = import.meta.main ? process.argv.slice(2) : [];
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

if (args[0] === "run") {
  const perPool = Number(args[1] && !args[1].startsWith("--") ? args[1] : 40);
  const out = flag("--out") ?? "data/afterwards.jsonl";
  const rpc = new Rpc(RPC_URL, 350);
  // Listing a pool's signatures from a given one on is something not every archive does; SIG_RPC_URL can send just
  // that to another endpoint.
  const lister = process.env.SIG_RPC_URL ? new Rpc(process.env.SIG_RPC_URL, 350) : rpc;
  const damm = createDammV2Program(new Connection(RPC_URL, "confirmed")) as unknown as { coder: { events: { decode(b64: string): { name: string; data: Record<string, any> } | null } } };
  const dammProgram = DAMM_V2_PROGRAM_ID.toBase58();
  const done = existsSync(out) ? new Set(readAfterwards(out).map((r) => r.pool)) : new Set<string>();
  // signatures come a thousand to a page, newest first: how far back to page for the migration
  const maxPages = Number(process.env.MAX_PAGES ?? 30);
  for (const m of readMigrations(flag("--migrations") ?? "data/migrations.jsonl")) {
    if (done.has(m.pool) || m.target !== "DAMM v2" || !m.damm || !m.sig) continue;
    // Everything that touched the new pool since the migration, found newest first and read oldest first.
    const later: string[] = [];
    let before: string | undefined;
    let reached = false;
    for (let page = 0; page < maxPages && !reached; page++) {
      const sigs = await lister.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [m.damm.pool, { until: m.sig, limit: 1000, ...(before ? { before } : {}) }]);
      later.push(...sigs.filter((s) => !s.err).map((s) => s.signature));
      reached = sigs.length < 1000;
      before = sigs[sigs.length - 1]?.signature;
    }
    if (!reached) {
      console.log(`${m.pool.slice(0, 8)} busier than ${maxPages},000 transactions since migration: left out (MAX_PAGES raises the limit)`);
      continue;
    }
    const wanted = [m.sig, ...later.reverse().slice(0, perPool)];
    const after: After[] = [];
    for (const sig of wanted) {
      const tx = await rpc.call<RawTx | null>("getTransaction", [sig, { maxSupportedTransactionVersion: 1, encoding: "json" }]);
      if (!tx?.meta?.innerInstructions) {
        after.push({ kind: "unknown", sig });
        break;
      }
      const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      const here = after.length;
      const legacy: After[] = [];
      const legacySwaps: After[] = [];
      for (const group of tx.meta.innerInstructions) {
        for (const ix of group.instructions) {
          if (keys[ix.programIdIndex] !== dammProgram) continue;
          const data = bs58.decode(ix.data);
          if (data.length < 16 || EVENT_IX_TAG.some((b, i) => data[i] !== b)) continue;
          let ev = null;
          try {
            ev = damm.coder.events.decode(Buffer.from(data.subarray(8)).toString("base64"));
          } catch {
            // falls through as unknown
          }
          const d = ev?.data;
          // An event without a pool field, or of another pool in the same transaction, is not this pool's business.
          if (ev && d?.pool && d.pool.toBase58() !== m.damm.pool) continue;
          const old = LEGACY_LIQUIDITY[Buffer.from(data.subarray(8, 16)).toString("hex")];
          if (!ev && Buffer.from(data.subarray(8, 16)).toString("hex") === LEGACY_SWAP && data.length === 16 + 122) {
            const b = Buffer.from(data.subarray(16));
            const u64 = (at: number) => b.readBigUInt64LE(at);
            if (bs58.encode(b.subarray(0, 32)) === m.damm.pool) {
              legacySwaps.push({
                kind: "swap",
                sig,
                buy: b[32] === 1,
                mode: 0,
                amount: u64(34).toString(),
                spent: u64(106).toString(),
                out: u64(50).toString(),
                nextSqrtPrice: ((u64(66) << 64n) | u64(58)).toString(),
                fee: (u64(74) + u64(82) + u64(90) + u64(98)).toString(),
                amountLeft: "0",
                transferFee: u64(106) !== u64(34),
                ts: Number(u64(114)),
              });
            }
            continue;
          }
          if (!ev && old !== undefined && data.length >= 16 + 112) {
            if (bs58.encode(data.subarray(16, 48)) === m.damm.pool) legacy.push({ kind: "liquidity", sig, delta: BigInt(`0x${Buffer.from(data.subarray(112, 128)).reverse().toString("hex")}`).toString(), remove: old });
            continue;
          }
          if (!ev) after.push({ kind: "unknown", sig });
          else if (ev.name === "evtInitializePool") {
            const dyn = d!.poolFees.dynamicFee as Record<string, { toString(radix?: number): string } | number> | null;
            after.push({ kind: "init", sig, liquidity: d!.liquidity.toString(10), sqrtPrice: d!.sqrtPrice.toString(10), dynamic: dyn ? Object.fromEntries(Object.entries(dyn).map(([k, v]) => [k, typeof v === "number" ? String(v) : v.toString(10)])) : null, baseFee: Buffer.from(d!.poolFees.baseFee.data as number[]).toString("hex"), activationPoint: d!.activationPoint.toString(10) });
          }
          else if (ev.name === "evtLiquidityChange") after.push({ kind: "liquidity", sig, delta: d!.liquidityDelta.toString(10), remove: d!.changeType === 1, base: d!.tokenAAmount.toString(10), quote: d!.tokenBAmount.toString(10) });
          else if (ev.name === "evtSwap2") {
            const r = d!.swapResult;
            after.push({
              kind: "swap",
              sig,
              buy: d!.tradeDirection === 1, // token B (quote) in, token A (the launched token) out
              mode: d!.params.swapMode,
              amount: d!.params.amount0.toString(10),
              spent: r.includedFeeInputAmount.toString(10),
              out: r.outputAmount.toString(10),
              nextSqrtPrice: r.nextSqrtPrice.toString(10),
              fee: r.claimingFee.add(r.protocolFee).add(r.compoundingFee).add(r.referralFee).toString(10),
              amountLeft: r.amountLeft.toString(10),
              transferFee: !d!.includedTransferFeeAmountIn.eq(r.includedFeeInputAmount) || !d!.includedTransferFeeAmountOut.eq(d!.excludedTransferFeeAmountOut),
              ts: Number(d!.currentTimestamp.toString(10)),
            });
          } else if (ev.name === "evtUpdatePoolFees" || ev.name === "evtSetPoolStatus") after.push({ kind: "unknown", sig });
          // positions created, locked, split or claimed do not move the price or the liquidity
        }
      }
      // the older events count only where the newer one was not emitted beside them
      if (!after.slice(here).some((e) => e.kind === "liquidity")) after.push(...legacy);
      if (!after.slice(here).some((e) => e.kind === "swap")) after.push(...legacySwaps);
      if (after.some((e) => e.kind === "unknown")) break;
    }
    const row: Afterwards = { ...m, after, transactions: wanted.length - 1 };
    appendFileSync(out, JSON.stringify(row) + "\n");
    const v = replayAfterwards(row);
    console.log(`${m.pool.slice(0, 8)} ${row.transactions} transactions after migration: ${v.stopped ? `${v.swaps} swaps, then ${v.stopped}` : `${v.swaps} swaps`}${v.mismatches.length ? ` | ${v.mismatches[0]}` : ""}`);
  }
  console.log(JSON.stringify({ ...summarize(readAfterwards(out)), differing: undefined }));
} else if (args[0] === "check") {
  const s = summarize(readAfterwards(flag("--file") ?? "data/afterwards.jsonl"));
  console.log(`${s.pools} migrated DAMM v2 pools: ${s.notModelled} of a kind the engine does not model, ${s.replayed} replayed from the DBC accounts alone`);
  console.log(`${s.swaps} swaps in ${s.withSwaps} pools (${s.buys} buys, ${s.exactOut} exact-out), across ${s.liquidityChanges} later changes of liquidity: amounts, next price and fee as DAMM v2 recorded them in ${s.agree} of ${s.replayed} pools`);
  console.log(`${s.takenFromChain} partial fills that ran out of range taken from the chain instead of replayed; ${s.stoppedEarly} pools stopped early at an event this reader does not know`);
  for (const d of s.differing.slice(0, 12)) console.log(`  ${d.pool.slice(0, 8)} ${d.first}`);
  if (flag("--json")) writeFileSync(flag("--json")!, JSON.stringify({ generatedAt: new Date().toISOString(), ...s, differing: s.differing.slice(0, 20) }, null, 1));
  process.exit(s.differing.length ? 1 : 0);
}
