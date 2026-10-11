// Ask the program itself.
//
// History can only check the swaps people have made. Exact-out swaps are in the program and in the SDK, but nobody
// makes them on mainnet (none in the conformance corpus, none in a sample of 6,376 recent swaps), so no history can
// check them. This builds such a swap for a real pool, has a public RPC node simulate it against the live program
// (simulateTransaction: nothing is signed, nothing is sent, there is no key), and compares the program's own
// EvtSwap2 and the pool account it leaves behind with what the engine predicts from the pool account before.
// Every simulation is saved, so the comparison can be run again offline against another build of the SDK.
//
//   node src/probe.ts run [poolsPerKind] [sol|usdc]  # simulate against open pools spread over kinds of config
//   node src/probe.ts pool <address>...              # the pools named
//   node src/probe.ts fresh [minutes]                # watch for new pools and ask those whose fee schedule or rate
//                                                    # limiter is still running (an old pool's has run out)
//   node src/probe.ts check [--file f] [--math m]    # compare every saved simulation again, with the installed
//                                                    # SDK's math or another build's (see scripts/bundle-sdk-math.mjs)
//   node src/probe.ts sample <out.jsonl> [perKind]   # a spread of them for the offline tests
//
// Each pool gets a control (exact-in buy then sell, a path history already proves) and then exact-out buys and sells
// of several sizes, with and without a referral, up to the last token on the curve and one past it.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { createDbcProgram, deriveDbcPoolAuthority, SwapMode, TradeDirection, type VirtualPool } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { kindOf, readConfig } from "./census/fields.ts";
import { CENSUS_DB } from "./census/pull.ts";
import { configFromBytes } from "./engine/bytes.ts";
import { decodePool } from "./engine/codec.ts";
import { SDK_MATH, SimPool, type Clock, type PoolState, type QuoteMath } from "./engine/pool.ts";
import { decodeEvent } from "./events.ts";
import { transactionOf } from "./flows/history.ts";
import { PROGRAM_ID } from "./layout.ts";
import { Rpc, RPC_URL } from "./rpc.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// `--only <text>` asks just the questions whose name contains the text (to add a new question to a finished run).
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : "";
export const PROBES = resolve(ROOT, "data/probes.jsonl");
const SOL = NATIVE_MINT.toBase58();
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** What the stand-in trader holds: lamports, and USDC in its associated token account. */
type Funds = { lamports: number; usdc: number };
const LAMPORTS = 1_000_000_000;

type Step = { direction: TradeDirection; mode: SwapMode; amount0: string; amount1: string; referral: boolean };

/** One simulated transaction: the pool before, what was asked, and what the program answered. */
export type Probe = {
  pool: string;
  kind: string;
  label: string;
  config: string;
  configData: string;
  /** The pool account before and after the simulated transaction, base64. `post` is null when the program refused. */
  pre: string;
  post: string | null;
  /** The clock the program saw. */
  slot: number;
  timestamp: number;
  steps: Step[];
  /** The program's EvtSwap2 for each step, or the step it refused at and why. */
  events: Record<string, unknown>[];
  refusedAt: number | null;
  error: string | null;
  /** Token balances of the pool's two vaults, before and after. */
  vaults?: { base: [string, string]; quote: [string, string] };
  at: number;
};

/** A VirtualPool account as the engine's state. */
export function stateOf(pool: VirtualPool): PoolState {
  const s = pool.poolState as unknown as Record<string, BN> & { volatilityTracker: PoolState["volatilityTracker"]; metrics: Record<string, BN>; hasSwap: number };
  return {
    volatilityTracker: { ...s.volatilityTracker },
    sqrtPrice: s.sqrtPrice,
    activationPoint: s.activationPoint,
    baseReserve: s.baseReserve,
    quoteReserve: s.quoteReserve,
    protocolBaseFee: s.protocolBaseFee,
    protocolQuoteFee: s.protocolQuoteFee,
    partnerBaseFee: s.partnerBaseFee,
    partnerQuoteFee: s.partnerQuoteFee,
    creatorBaseFee: s.creatorBaseFee,
    creatorQuoteFee: s.creatorQuoteFee,
    totalProtocolBaseFee: s.metrics.totalProtocolBaseFee,
    totalProtocolQuoteFee: s.metrics.totalProtocolQuoteFee,
    totalTradingBaseFee: s.metrics.totalTradingBaseFee,
    totalTradingQuoteFee: s.metrics.totalTradingQuoteFee,
    hasSwap: s.hasSwap,
  };
}

const bytes = (b64: string) => Buffer.from(b64, "base64");
const simOf = (p: { configData: string; pre: string }, math: QuoteMath = SDK_MATH) => new SimPool(configFromBytes(bytes(p.configData)), stateOf(decodePool(bytes(p.pre))), math);

type SwapEvent = { tradeDirection: number; hasReferral: boolean; swapParameters: { amount0: string; swapMode: number }; swapResult: Record<string, string>; quoteReserveAmount: string; currentTimestamp: string };

/** Where the engine and the program disagree about one saved simulation. Empty when they agree. */
export function checkProbe(p: Probe, math: QuoteMath = SDK_MATH): string[] {
  const out: string[] = [];
  const sim = simOf(p, math);
  const bySlot = sim.config.activationType === 0;
  const clock = (ts: number | string): Clock => ({ point: new BN(bySlot ? p.slot : ts), timestamp: new BN(ts) });

  if (p.refusedAt !== null) {
    // The program refused step `refusedAt`: the engine has to get that far and then refuse too.
    for (const [i, s] of p.steps.entries()) {
      try {
        const fill = sim.swap(s.direction, new BN(s.amount0), clock(p.timestamp), { mode: s.mode, hasReferral: s.referral });
        // The limit the trader set (swap_exact_out.rs, swap_exact_in.rs): at most amount1 in, or at least amount1 out.
        if (s.mode === SwapMode.ExactOut ? fill.amountIn.gt(new BN(s.amount1)) : fill.amountOut.lt(new BN(s.amount1))) throw new Error("ExceededSlippage");
      } catch (e) {
        if (i < p.refusedAt) out.push(`step ${i}: engine refuses (${(e as Error).message.slice(0, 60)}), program accepted`);
        return out;
      }
      if (i === p.refusedAt) out.push(`step ${i}: program refuses (${p.error}), engine accepts`);
    }
    return out;
  }

  for (const [i, raw] of p.events.entries()) {
    const d = raw as unknown as SwapEvent;
    let fill;
    try {
      fill = sim.swap(d.tradeDirection, new BN(d.swapParameters.amount0), clock(d.currentTimestamp), { mode: d.swapParameters.swapMode as SwapMode, hasReferral: d.hasReferral });
    } catch (e) {
      out.push(`step ${i}: engine refuses (${(e as Error).message.slice(0, 60)}), program accepted`);
      return out;
    }
    const got: Record<string, string> = {
      includedFeeInputAmount: fill.amountIn.toString(),
      amountLeft: fill.amountLeft.toString(),
      outputAmount: fill.amountOut.toString(),
      nextSqrtPrice: fill.nextSqrtPrice.toString(),
      tradingFee: fill.partnerFee.add(fill.creatorFee).toString(),
      protocolFee: fill.protocolFee.toString(),
      referralFee: fill.referralFee.toString(),
    };
    for (const [k, v] of Object.entries(got)) if (v !== String(d.swapResult[k])) out.push(`step ${i} ${k}: engine ${v} program ${d.swapResult[k]}`);
    if (sim.state.quoteReserve.toString() !== String(d.quoteReserveAmount)) out.push(`step ${i} quoteReserve: engine ${sim.state.quoteReserve} program ${d.quoteReserveAmount}`);
  }
  if (!p.post) return out;
  // The account the program left behind: reserves, every fee bucket, and the volatility tracker.
  const live = stateOf(decodePool(bytes(p.post)));
  const flat = (s: PoolState): Record<string, string> => {
    const { volatilityTracker: t, ...rest } = s;
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(rest)) o[k] = String(v);
    for (const k of ["lastUpdateTimestamp", "sqrtPriceReference", "volatilityAccumulator", "volatilityReference"] as const) o[`tracker.${k}`] = String(t[k]);
    return o;
  };
  const [a, b] = [flat(sim.state), flat(live)];
  for (const k of Object.keys(a)) if (a[k] !== b[k]) out.push(`after ${k}: engine ${a[k]} program ${b[k]}`);
  // The program's books against its vaults: tokens that moved = change in reserve plus change in every fee bucket.
  if (p.vaults) {
    const before = stateOf(decodePool(bytes(p.pre)));
    const booked = (s: PoolState, side: "Base" | "Quote") => s[side === "Base" ? "baseReserve" : "quoteReserve"].add(s[`protocol${side}Fee`]).add(s[`partner${side}Fee`]).add(s[`creator${side}Fee`]);
    for (const [side, [was, is]] of [["Base", p.vaults.base], ["Quote", p.vaults.quote]] as const) {
      const moved = new BN(is).sub(new BN(was));
      const books = booked(live, side).sub(booked(before, side));
      if (!moved.eq(books)) out.push(`${side.toLowerCase()} vault moved ${moved}, the pool's books moved ${books}`);
    }
  }
  return out;
}

export function readProbes(file = PROBES): Probe[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file);
  return (file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Probe);
}

// ---------------------------------------------------------------------------------------------------------------
// Asking

const { program } = createDbcProgram(new Connection(RPC_URL));
const POOL_AUTHORITY = deriveDbcPoolAuthority();
// Receives referral fees in the simulation. Any address will do; this one is nobody's.
const REFERRER = new PublicKey(Buffer.alloc(32, 7));
// The simulated trader has to hold SOL (and USDC, for pools quoted in it). With signature checks off any funded address can stand in, so these are
// large exchange wallets; the first that is a plain system account with enough SOL is used. Nothing touches them.
const PAYERS = ["5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS", "GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE"];

type Account = { data: [string, string]; owner: string; lamports: number } | null;
type Simulated = {
  err: unknown;
  logs: string[] | null;
  accounts: Account[] | null;
  innerInstructions?: { index: number; instructions: { programId?: string; programIdIndex?: number; data?: string }[] }[] | null;
};

async function accountOf(rpc: Rpc, address: string): Promise<Account> {
  return (await rpc.call<{ value: Account }>("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }])).value;
}

async function findPayer(rpc: Rpc): Promise<{ payer: PublicKey; funds: Funds }> {
  for (const a of PAYERS) {
    const acc = await accountOf(rpc, a);
    if (!acc || acc.owner !== SystemProgram.programId.toBase58() || bytes(acc.data[0]).length !== 0 || acc.lamports < 2000 * LAMPORTS) continue;
    const payer = new PublicKey(a);
    const usdc = await accountOf(rpc, getAssociatedTokenAddressSync(new PublicKey(USDC), payer, true).toBase58());
    return { payer, funds: { lamports: acc.lamports, usdc: usdc ? Number(bytes(usdc.data[0]).readBigUInt64LE(64)) : 0 } };
  }
  throw new Error("none of the stand-in payers is a system account with 2,000 SOL; edit PAYERS");
}

type Target = { pool: string; kind: string; config: string; configData: string; pre: string };
type Snapshot = { pool: string; vaults: [string, string]; base: string; quote: string };

const tokenAmount = (acc: Account): string => (acc ? bytes(acc.data[0]).readBigUInt64LE(64).toString() : "0");

/** The pool account and its two vault balances at one slot. */
async function snapshot(rpc: Rpc, pool: string, vaults?: [string, string]): Promise<Snapshot | null> {
  if (!vaults) {
    const acc = await accountOf(rpc, pool);
    if (!acc) return null;
    const p = decodePool(bytes(acc.data[0])).poolState;
    vaults = [p.baseVault.toBase58(), p.quoteVault.toBase58()];
  }
  const got = (await rpc.call<{ value: Account[] }>("getMultipleAccounts", [[pool, ...vaults], { encoding: "base64", commitment: "confirmed" }])).value;
  if (!got[0]) return null;
  return { pool: got[0].data[0], vaults, base: tokenAmount(got[1]), quote: tokenAmount(got[2]) };
}

/** The swaps to ask about, sized from the pool's own curve by the engine. */
function plans(t: Target, now: Clock): { label: string; steps: Step[]; wrap: BN }[] {
  const fresh = () => simOf(t);
  const huge = fresh().config.migrationQuoteThreshold.muln(100);
  let rest;
  try {
    rest = fresh().swap(TradeDirection.QuoteToBase, huge, now, { mode: SwapMode.PartialFill });
  } catch {
    return [];
  }
  const [maxOut, maxCost] = [rest.amountOut, rest.amountIn];
  if (maxOut.ltn(10_000) || maxCost.ltn(10_000)) return [];
  const wrap = maxCost.muln(12).divn(10).addn(LAMPORTS / 20);
  const step = (direction: TradeDirection, mode: SwapMode, amount0: BN, amount1: BN, referral: boolean): Step => ({ direction, mode, amount0: amount0.toString(), amount1: amount1.toString(), referral });
  const out: { label: string; steps: Step[]; wrap: BN }[] = [];

  // Control: exact-in buy, exact-in sell of half. History already proves this path, so a mismatch here is the harness.
  {
    const spend = BN.max(maxCost.divn(200), new BN(1000));
    const got = fresh().swap(TradeDirection.QuoteToBase, spend, now).amountOut;
    out.push({ label: "control exact-in", wrap, steps: [step(TradeDirection.QuoteToBase, SwapMode.ExactIn, spend, new BN(0), false), step(TradeDirection.BaseToQuote, SwapMode.ExactIn, got.divn(2), new BN(0), false)] });
  }
  // Exact-out buy of a share of what is left on the curve, then an exact-out sell of a share of what that would fetch.
  for (const [label, buyBp, sellPct, referral] of [["exact-out small", 20, 50, false], ["exact-out mid, referral", 1500, 60, true], ["exact-out large", 8500, 30, false], ["exact-out large, referral", 6000, 90, true]] as const) {
    const want = maxOut.muln(buyBp).divn(10_000);
    if (want.isZero()) continue;
    const steps = [step(TradeDirection.QuoteToBase, SwapMode.ExactOut, want, wrap, referral)];
    try {
      const s = fresh();
      s.swap(TradeDirection.QuoteToBase, want, now, { mode: SwapMode.ExactOut, hasReferral: referral });
      const fetch = s.swap(TradeDirection.BaseToQuote, want, now, { hasReferral: referral }).amountOut.muln(sellPct).divn(100);
      if (!fetch.isZero()) steps.push(step(TradeDirection.BaseToQuote, SwapMode.ExactOut, fetch, want, referral));
    } catch {
      // The engine cannot size the sell (it refuses the buy): ask the program about the buy alone.
    }
    out.push({ label, wrap, steps });
  }
  // Dust: the smallest amounts there are, where rounding decides everything.
  out.push({ label: "exact-out, one unit", wrap, steps: [step(TradeDirection.QuoteToBase, SwapMode.ExactOut, new BN(1), wrap, false)] });
  out.push({ label: "exact-in, one lamport", wrap, steps: [step(TradeDirection.QuoteToBase, SwapMode.ExactIn, new BN(1), new BN(0), false)] });
  // One unit of quote more than it takes to reach the migration price, as an exact-in buy. Older builds of the
  // program let such a buy run on past the migration price; today it is refused whole unless rounding absorbs it.
  out.push({ label: "exact-in, one unit more than the curve takes", wrap, steps: [step(TradeDirection.QuoteToBase, SwapMode.ExactIn, maxCost.addn(1), new BN(0), false)] });
  // The last token on the curve, and one more than the curve holds.
  out.push({ label: "exact-out, all that is left", wrap, steps: [step(TradeDirection.QuoteToBase, SwapMode.ExactOut, maxOut, wrap, false)] });
  out.push({ label: "exact-out, one past the end", wrap, steps: [step(TradeDirection.QuoteToBase, SwapMode.ExactOut, maxOut.addn(1), wrap, false)] });
  return out;
}

async function transactionFor(t: Target, steps: Step[], wrap: BN, payer: PublicKey): Promise<Transaction> {
  const pool = decodePool(bytes(t.pre)).poolState;
  const config = configFromBytes(bytes(t.configData));
  const baseProgram = pool.poolType === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const ata = (mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  const quoteMint = new PublicKey(config.quoteMintAddress);
  const native = quoteMint.equals(NATIVE_MINT);
  const [quoteAta, baseAta] = [ata(quoteMint, payer, TOKEN_PROGRAM_ID), ata(pool.baseMint, payer, baseProgram)];
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    // SOL has to be wrapped first; USDC is spent from the token account the stand-in already has.
    ...(native ? [createAssociatedTokenAccountIdempotentInstruction(payer, quoteAta, payer, NATIVE_MINT), SystemProgram.transfer({ fromPubkey: payer, toPubkey: quoteAta, lamports: BigInt(wrap.toString()) }), createSyncNativeInstruction(quoteAta)] : []),
    createAssociatedTokenAccountIdempotentInstruction(payer, baseAta, payer, pool.baseMint, baseProgram),
  ];
  const referrals = new Map<string, PublicKey>();
  for (const s of steps) {
    const buy = s.direction === TradeDirection.QuoteToBase;
    let referral: PublicKey | null = null;
    if (s.referral) {
      // The referral is paid in the fee token: base only when the fee is taken from the output of a buy.
      const inBase = config.collectFeeMode === 1 && buy;
      const [mint, tokenProgram] = inBase ? [pool.baseMint, baseProgram] : [quoteMint, TOKEN_PROGRAM_ID];
      referral = ata(mint, REFERRER, tokenProgram);
      if (!referrals.has(referral.toBase58())) {
        referrals.set(referral.toBase58(), referral);
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer, referral, REFERRER, mint, tokenProgram));
      }
    }
    ixs.push(
      await program.methods
        .swap2({ amount0: new BN(s.amount0), amount1: new BN(s.amount1), swapMode: s.mode })
        .accountsPartial({
          poolAuthority: POOL_AUTHORITY,
          config: new PublicKey(t.config),
          pool: new PublicKey(t.pool),
          inputTokenAccount: buy ? quoteAta : baseAta,
          outputTokenAccount: buy ? baseAta : quoteAta,
          baseVault: pool.baseVault,
          quoteVault: pool.quoteVault,
          baseMint: pool.baseMint,
          quoteMint,
          payer,
          tokenBaseProgram: baseProgram,
          tokenQuoteProgram: TOKEN_PROGRAM_ID,
          referralTokenAccount: referral,
        })
        // While a rate limiter runs the program wants to see the whole transaction (one buy per pool per transaction).
        .remainingAccounts([{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }])
        .instruction(),
    );
  }
  const tx = new Transaction();
  tx.feePayer = payer;
  tx.recentBlockhash = bs58.encode(Buffer.alloc(32, 1)); // replaced by the node
  tx.add(...ixs);
  return tx;
}

/** Simulate one plan against the live program and turn the answer into a saved probe. */
async function ask(rpc: Rpc, t: Target, plan: { label: string; steps: Step[]; wrap: BN }, payer: PublicKey, about: { slot: number; timestamp: number }, snap: Snapshot): Promise<Probe | string> {
  const tx = await transactionFor(t, plan.steps, plan.wrap, payer);
  const firstSwap = tx.instructions.length - plan.steps.length;
  let wire: string;
  try {
    wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  } catch (e) {
    return `could not build: ${(e as Error).message.slice(0, 80)}`;
  }
  const r = (await rpc.call<{ value: Simulated }>("simulateTransaction", [wire, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", encoding: "base64", innerInstructions: true, accounts: { encoding: "base64", addresses: [t.pool, SYSVAR_CLOCK_PUBKEY.toBase58(), ...snap.vaults] } }])).value;
  // A refused transaction comes back without accounts; the clock is then the one read just before asking.
  const clock = r.accounts?.[1] ? bytes(r.accounts[1].data[0]) : null;
  if (!clock && !r.err) return "the node returned no clock";
  const probe: Probe = {
    pool: t.pool,
    kind: t.kind,
    label: plan.label,
    config: t.config,
    configData: t.configData,
    pre: t.pre,
    post: null,
    slot: clock ? Number(clock.readBigUInt64LE(0)) : about.slot,
    timestamp: clock ? Number(clock.readBigInt64LE(32)) : about.timestamp,
    steps: plan.steps,
    events: [],
    refusedAt: null,
    error: null,
    at: Date.now() / 1000,
  };
  if (r.err) {
    const where = (r.err as { InstructionError?: [number, unknown] }).InstructionError;
    const named = (r.logs ?? []).map((l) => /Error Code: (\w+)/.exec(l)?.[1]).filter(Boolean).pop();
    // Only a refusal by a swap instruction says something about the program; anything earlier is the harness.
    if (!where || where[0] < firstSwap) return `setup failed: ${JSON.stringify(r.err).slice(0, 120)} ${(r.logs ?? []).slice(-2).join(" | ").slice(0, 160)}`;
    probe.refusedAt = where[0] - firstSwap;
    probe.error = named ?? JSON.stringify(where[1]);
    return probe;
  }
  const keys = tx.compileMessage().accountKeys.map((k) => k.toBase58());
  for (const group of r.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if ((ix.programId ?? keys[ix.programIdIndex ?? -1]) !== PROGRAM_ID || !ix.data) continue;
      const ev = decodeEvent(bs58.decode(ix.data));
      if (ev?.name === "evtSwap2" && ev.data.pool === t.pool) probe.events.push(ev.data);
    }
  }
  if (probe.events.length !== plan.steps.length) return `expected ${plan.steps.length} swap events, the node returned ${probe.events.length}`;
  probe.post = r.accounts?.[0]?.data[0] ?? null;
  if (r.accounts?.[2] && r.accounts[3]) probe.vaults = { base: [snap.base, tokenAmount(r.accounts[2])], quote: [snap.quote, tokenAmount(r.accounts[3])] };
  return probe;
}

/**
 * Ask every plan for one pool. The pool must not change while we ask, or the answers are about another state: a
 * quiet pool is read before and after the whole set; a busy one (`busy`) before and after every single question.
 */
async function probePool(rpc: Rpc, pool: string, kind: string, payer: PublicKey, funds: Funds, tally: Tally, busy = false): Promise<void> {
  let snap = await snapshot(rpc, pool);
  if (!snap) return;
  const first = snap.pool;
  const live = decodePool(bytes(first)).poolState;
  const configAcc = await accountOf(rpc, live.config.toBase58());
  if (!configAcc) return;
  kind ||= kindOf(bytes(configAcc.data[0]));
  const t: Target = { pool, kind, config: live.config.toBase58(), configData: configAcc.data[0], pre: first };
  const config = configFromBytes(bytes(t.configData));
  const quoted = config.quoteMintAddress === SOL ? "SOL" : config.quoteMintAddress === USDC ? "USDC" : null;
  const budget = quoted === "USDC" ? funds.usdc : funds.lamports;
  t.kind = kind = kind.replace("other quote", quoted ?? "other quote");
  if (!quoted || live.isMigrated || live.migrationProgress !== 0 || live.poolType > 1) {
    console.log(`  ${pool.slice(0, 8)} left out: ${!quoted ? "quoted in neither SOL nor USDC" : live.poolType > 1 ? "transfer-hook pool" : "its curve is finished"}`);
    return;
  }
  const slot0 = await rpc.call<number>("getSlot", [{ commitment: "confirmed" }]);
  const t0 = Date.now();
  // Plans are sized from the state they will be asked about, so a busy pool is re-planned before each question.
  const planned = (pre: string) => {
    const now = Math.floor(Date.now() / 1000);
    const slot = slot0 + Math.round((Date.now() - t0) / 400);
    const all = plans({ ...t, pre }, { point: new BN(config.activationType === 0 ? slot : now), timestamp: new BN(now) }).filter((p) => p.wrap.lt(new BN(String(Math.floor(budget / 2)))));
    return { all, about: { slot, timestamp: now } };
  };
  const labels = planned(first).all.map((p) => p.label).filter((l) => !ONLY || l.includes(ONLY));
  if (!labels.length) console.log(`  ${pool.slice(0, 8)} left out: nothing left on its curve, or it costs more than the stand-in holds`);
  const probes: Probe[] = [];
  let dropped = 0;
  for (const label of labels) {
    const { all, about } = planned(snap.pool);
    const plan = all.find((p) => p.label === label);
    if (!plan) continue;
    const got = await ask(rpc, { ...t, pre: snap.pool }, plan, payer, about, snap);
    if (busy) {
      const after = await snapshot(rpc, pool, snap.vaults);
      if (!after) break;
      const moved = after.pool !== snap.pool || after.base !== snap.base || after.quote !== snap.quote;
      snap = after;
      if (moved) {
        dropped++;
        continue;
      }
    }
    if (typeof got === "string") {
      tally.skipped++;
      console.log(`  ${pool.slice(0, 8)} ${plan.label}: ${got}`);
    } else probes.push(got);
  }
  if (!busy) {
    const after = await snapshot(rpc, pool, snap.vaults);
    if (after?.pool !== snap.pool || after.base !== snap.base || after.quote !== snap.quote) {
      tally.moved++;
      console.log(`  ${pool.slice(0, 8)} traded while being asked; its ${probes.length} answers are dropped`);
      return;
    }
  }
  tally.dropped += dropped;
  for (const p of probes) {
    appendFileSync(PROBES, JSON.stringify(p) + "\n");
    const bad = checkProbe(p);
    tally.add(p, bad);
    if (bad.length) console.log(`  MISMATCH ${pool} ${p.label}: ${bad.slice(0, 4).join(" | ")}`);
  }
  console.log(`${new Date().toISOString().slice(11, 19)} ${pool.slice(0, 8)} [${kind}] ${probes.length} simulations, ${probes.filter((p) => checkProbe(p).length).length} mismatched${dropped ? `, ${dropped} dropped (the pool traded)` : ""}`);
}

class Tally {
  probes = 0;
  swaps = 0;
  exactOut = 0;
  refused = 0;
  mismatched = 0;
  skipped = 0;
  moved = 0;
  dropped = 0;
  vaults = 0;
  timed = 0;
  pools = new Set<string>();
  kinds = new Set<string>();
  add(p: Probe, bad: string[]): void {
    this.probes++;
    this.pools.add(p.pool);
    this.kinds.add(p.kind);
    this.swaps += p.events.length;
    this.exactOut += p.events.filter((e) => (e as unknown as SwapEvent).swapParameters.swapMode === SwapMode.ExactOut).length;
    if (p.refusedAt !== null) this.refused++;
    if (p.vaults) this.vaults++;
    const config = bytes(p.configData);
    const activation = Number(decodePool(bytes(p.pre)).poolState.activationPoint);
    if (scheduleRunning(config, activation, readConfig(config).activationType === 0 ? p.slot : p.timestamp)) this.timed++;
    if (bad.length) this.mismatched++;
  }
  line(): string {
    return `${this.probes} simulations on ${this.pools.size} pools, ${this.kinds.size} kinds of config: ${this.swaps} swaps answered by the program (${this.exactOut} exact-out), ${this.refused} refusals, ${this.vaults} with vault balances checked against the pool's books, ${this.timed} asked while the pool's fee schedule or rate limiter was running, ${this.mismatched} simulations where engine and program disagree`;
  }
}

/** Open pools from the census quoted in the given token, spread over kinds of config. */
function pickPools(perKind: number, quoteMint: string): { pool: string; kind: string }[] {
  const census = new DatabaseSync(CENSUS_DB, { readOnly: true });
  const kinds = new Map<string, string>();
  for (const r of census.prepare("SELECT address, data FROM configs").iterate()) {
    const data = Buffer.from(r.data as Uint8Array);
    if (readConfig(data).quoteMint === quoteMint) kinds.set(Buffer.from(r.address as Uint8Array).toString("hex"), kindOf(data));
  }
  const chosen = new Map<string, { pool: string; weight: number }[]>();
  for (const p of census.prepare("SELECT address, config, has_swap FROM pools WHERE migration_progress = 0 AND is_migrated = 0 AND pool_type < 2").iterate()) {
    const kind = kinds.get(Buffer.from(p.config as Uint8Array).toString("hex"));
    if (!kind) continue;
    // Half the picks from pools that have traded, half from pools nobody has touched (a first swap).
    const key = `${kind}|${p.has_swap ? "traded" : "untouched"}`;
    const list = chosen.get(key) ?? [];
    chosen.set(key, list);
    const weight = Math.random();
    if (list.length < perKind) list.push({ pool: bs58.encode(p.address as Uint8Array), weight });
    else {
      let lo = 0;
      for (let i = 1; i < list.length; i++) if (list[i].weight < list[lo].weight) lo = i;
      if (weight > list[lo].weight) list[lo] = { pool: bs58.encode(p.address as Uint8Array), weight };
    }
  }
  return [...chosen].flatMap(([key, list]) => list.map((c) => ({ pool: c.pool, kind: key.split("|")[0] })));
}

async function run(perKind: number, quote: "sol" | "usdc"): Promise<void> {
  mkdirSync(dirname(PROBES), { recursive: true });
  const rpc = new Rpc(RPC_URL, 450);
  const { payer, funds } = await findPayer(rpc);
  const pools = pickPools(perKind, quote === "usdc" ? USDC : SOL);
  console.log(`${pools.length} open pools quoted in ${quote.toUpperCase()} picked; simulated trader ${payer.toBase58().slice(0, 8)} (${Math.round(funds.lamports / LAMPORTS)} SOL, ${Math.round(funds.usdc / 1e6)} USDC, untouched)`);
  const tally = new Tally();
  for (const { pool, kind } of pools) {
    try {
      await probePool(rpc, pool, kind, payer, funds, tally);
    } catch (e) {
      console.log(`  ${pool.slice(0, 8)} failed: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  console.log(tally.line());
  console.log(`${tally.skipped} plans could not be asked, ${tally.moved} pools and ${tally.dropped} single answers dropped because the pool traded meanwhile`);
}

/** Whether the config's fee still depends on the clock at this point: a scheduler mid-schedule or a live rate limiter. */
function scheduleRunning(configData: Buffer, activationPoint: number, point: number): boolean {
  const f = readConfig(configData);
  const timed = f.baseFeeMode === 2 || (f.feeDuration > 0 && f.startFeeBps !== f.endFeeBps);
  return timed && point >= activationPoint && point - activationPoint < f.feeDuration;
}

/**
 * Pools created minutes ago, asked while their fee schedule or rate limiter is still running (an old pool's schedule
 * has run out, so `run` only ever sees the final fee). Watches the program for new pools for `minutes`, and asks each
 * one that has a running schedule up to four times, a minute apart.
 */
async function fresh(minutes: number): Promise<void> {
  mkdirSync(dirname(PROBES), { recursive: true });
  const rpc = new Rpc(RPC_URL, 450);
  const feed = new Rpc(process.env.TX_RPC_URL ?? "https://solana-rpc.publicnode.com", 200);
  const { payer, funds } = await findPayer(rpc);
  const tally = new Tally();
  const seen = new Set<string>();
  const configs = new Map<string, Buffer | null>();
  type Candidate = { pool: string; kind: string; config: Buffer; activation: number; bySlot: boolean; next: number; asked: number };
  let waiting: Candidate[] = [];
  const until = Date.now() + minutes * 60_000;
  while (Date.now() < until) {
    const sigs = (await feed.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [PROGRAM_ID, { limit: 80 }])).filter((x) => !x.err && !seen.has(x.signature));
    for (const x of sigs) {
      seen.add(x.signature);
      const tx = await transactionOf(feed, x.signature, decodeEvent).catch(() => null);
      for (const e of tx?.events ?? []) {
        if (e.name !== "evtInitializePool") continue;
        const d = e.data as { pool: string; config: string; activationPoint: string };
        if (!configs.has(d.config)) {
          const acc = await accountOf(rpc, d.config);
          configs.set(d.config, acc ? bytes(acc.data[0]) : null);
        }
        const config = configs.get(d.config);
        if (!config) continue;
        const f = readConfig(config);
        if (f.quoteMint !== SOL || !scheduleRunning(config, 0, 0)) continue;
        waiting.push({ pool: d.pool, kind: kindOf(config), config, activation: Number(d.activationPoint), bySlot: f.activationType === 0, next: 0, asked: 0 });
      }
    }
    const slot = await rpc.call<number>("getSlot", [{ commitment: "confirmed" }]);
    waiting = waiting.filter((c) => c.asked < 4 && scheduleRunning(c.config, c.activation, Math.max(c.activation, c.bySlot ? slot : Math.floor(Date.now() / 1000))));
    for (const c of waiting) {
      if (Date.now() < c.next) continue;
      c.asked++;
      c.next = Date.now() + 60_000;
      try {
        await probePool(rpc, c.pool, c.kind, payer, funds, tally, true);
      } catch (err) {
        console.log(`  ${c.pool.slice(0, 8)} failed: ${(err as Error).message.slice(0, 160)}`);
      }
    }
  }
  console.log(tally.line());
  console.log(`${tally.skipped} plans could not be asked, ${tally.moved} pools and ${tally.dropped} single answers dropped because the pool traded meanwhile`);
}

async function check(file: string, mathPath?: string): Promise<void> {
  let math: QuoteMath = SDK_MATH;
  if (mathPath) {
    const mod = (await import(pathToFileURL(resolve(mathPath)).href)) as Record<string, unknown>;
    const names = ["getFeeMode", "getSwapResultFromExactInput", "getSwapResultFromPartialInput", "getSwapResultFromExactOutput"];
    for (const n of names) if (typeof mod[n] !== "function") throw new Error(`${mathPath} does not export ${n}`);
    math = Object.fromEntries(names.map((n) => [n, mod[n]])) as unknown as QuoteMath;
  }
  const tally = new Tally();
  const byLabel = new Map<string, [number, number]>();
  const examples: string[] = [];
  for (const p of readProbes(file)) {
    const bad = checkProbe(p, math);
    tally.add(p, bad);
    const row = byLabel.get(p.label) ?? [0, 0];
    byLabel.set(p.label, [row[0] + 1, row[1] + (bad.length ? 1 : 0)]);
    if (bad.length && examples.length < 12) examples.push(`${p.pool.slice(0, 8)} [${p.kind}] ${p.label}: ${bad.slice(0, 3).join(" | ")}`);
  }
  console.log(`math: ${mathPath ?? "the installed SDK"}   simulations: ${file}`);
  console.log(tally.line());
  if (!mathPath && file === PROBES) {
    // Every figure the site and the README quote, counted here and nowhere else.
    const all = readProbes(file);
    const events = (p: Probe) => p.events as unknown as (SwapEvent & { migrationThreshold: string })[];
    const withOut = all.filter((p) => events(p).some((e) => e.swapParameters.swapMode === SwapMode.ExactOut));
    const off: QuoteMath = { ...SDK_MATH, getSwapResultFromExactOutput: (...a) => ({ ...SDK_MATH.getSwapResultFromExactOutput(...a), includedFeeInputAmount: SDK_MATH.getSwapResultFromExactOutput(...a).includedFeeInputAmount.addn(1) }) };
    const last = all.filter((p) => p.label === "exact-out, all that is left");
    const lamport = all.filter((p) => p.label === "exact-in, one lamport" && p.events.length);
    const over = all.filter((p) => p.label === "exact-in, one unit more than the curve takes");
    const timedPools = new Set(all.filter((p) => scheduleRunning(bytes(p.configData), Number(decodePool(bytes(p.pre)).poolState.activationPoint), readConfig(bytes(p.configData)).activationType === 0 ? p.slot : p.timestamp)).map((p) => p.pool));
    const quoteOf = (p: Probe) => (readConfig(bytes(p.configData)).quoteMint === USDC ? "usdc" : "sol");
    const summary = {
      generatedAt: new Date().toISOString(),
      simulations: tally.probes,
      pools: tally.pools.size,
      solPools: new Set(all.filter((p) => quoteOf(p) === "sol").map((p) => p.pool)).size,
      usdcPools: new Set(all.filter((p) => quoteOf(p) === "usdc").map((p) => p.pool)).size,
      untouchedPools: new Set(all.filter((p) => decodePool(bytes(p.pre)).poolState.hasSwap === 0).map((p) => p.pool)).size,
      kinds: tally.kinds.size,
      swaps: tally.swaps,
      exactOut: tally.exactOut,
      referral: all.reduce((n, p) => n + events(p).filter((e) => e.hasReferral).length, 0),
      refusals: tally.refused,
      pastTheEnd: all.filter((p) => p.label === "exact-out, one past the end" && p.refusedAt !== null).length,
      lastRefused: last.filter((p) => p.refusedAt !== null).length,
      completions: last.filter((p) => events(p).some((e) => BigInt(e.quoteReserveAmount) >= BigInt(e.migrationThreshold))).length,
      lamportBuys: lamport.length,
      lamportBuysNothing: lamport.filter((p) => events(p)[0].swapResult.outputAmount === "0").length,
      feeFree: all.reduce((n, p) => n + events(p).filter((e) => BigInt(e.swapResult.tradingFee) + BigInt(e.swapResult.protocolFee) + BigInt(e.swapResult.referralFee) === 0n).length, 0),
      fullPools: new Set(all.filter((p) => p.label === "control exact-in").map((p) => p.pool)).size,
      overshootAsked: over.length,
      overshootRefused: over.filter((p) => p.refusedAt !== null).length,
      vaults: tally.vaults,
      timed: tally.timed,
      timedPools: timedPools.size,
      offByOneCaught: withOut.filter((p) => checkProbe(p, off).length).length,
      offByOneOf: withOut.length,
      disagreements: tally.mismatched,
    };
    writeFileSync(resolve(ROOT, "web/data/probe.json"), JSON.stringify(summary));
  }
  for (const [label, [n, bad]] of byLabel) console.log(`  ${label.padEnd(30)} ${String(n).padStart(5)} asked ${String(bad).padStart(5)} disagree`);
  for (const e of examples) console.log(`  e.g. ${e}`);
}

/** A spread of saved simulations for the offline tests: every question asked of one pool, for `pools` kinds of config. */
export function sampleProbes(pools: number, file = PROBES): Probe[] {
  const all = readProbes(file);
  const firstOfKind = new Map<string, string>();
  for (const p of all) if (!firstOfKind.has(p.kind)) firstOfKind.set(p.kind, p.pool);
  const kinds = [...firstOfKind.keys()].sort();
  const stride = Math.max(1, Math.floor(kinds.length / pools));
  const chosen = new Set(kinds.filter((_, i) => i % stride === 0).slice(0, pools).map((k) => firstOfKind.get(k)));
  // and one pool that was asked while its fee schedule was still running
  const timed = all.find((p) => scheduleRunning(bytes(p.configData), Number(decodePool(bytes(p.pre)).poolState.activationPoint), readConfig(bytes(p.configData)).activationType === 0 ? p.slot : p.timestamp));
  if (timed) chosen.add(timed.pool);
  return all.filter((p) => chosen.has(p.pool));
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  const flag = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  if (cmd === "run") await run(Number(arg) || 2, process.argv[4] === "usdc" ? "usdc" : "sol");
  else if (cmd === "pool" && arg) {
    const rpc = new Rpc(RPC_URL, 450);
    const { payer, funds } = await findPayer(rpc);
    const tally = new Tally();
    for (const pool of process.argv.slice(3).filter((a) => !a.startsWith("--") && a !== ONLY)) await probePool(rpc, pool, "", payer, funds, tally);
    console.log(tally.line());
  }
  else if (cmd === "fresh") await fresh(Number(arg) || 20);
  else if (cmd === "check") await check(flag("--file") ?? PROBES, flag("--math"));
  else if (cmd === "sample" && arg) {
    const picked = sampleProbes(Number(process.argv[4]) || 8);
    writeFileSync(arg, picked.map((p) => `${JSON.stringify(p)}\n`).join(""));
    console.log(`${picked.length} simulations -> ${arg}`);
  }
  else console.log("usage: node src/probe.ts run [poolsPerKind] [sol|usdc] | pool <address>... | fresh [minutes] | check [--file f] [--math module.mjs] | sample <out.jsonl> [n]");
}
