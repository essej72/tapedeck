// Before release: swaps on a base mint with a transfer fee, program 0.2.2 against SDK 2.0's quotes.
//
//   node src/transferfee.ts run [cases, default 300] --sdk data/sdk.mjs [--out data/transferfee.jsonl]
//   node src/transferfee.ts check --sdk data/sdk.mjs [--file data/transferfee.jsonl(.gz)] [--json web/data/transferfee.json] [--name ...]
//   node src/transferfee.ts history --sdk data/sdk.mjs [--out data/transferfee-history.jsonl]   # the real pools there are
//
// A transfer fee on the base mint is new in program 0.2.2, which is on devnet and not on mainnet. No history can
// check it: on 12 October 2026 devnet held two such pools, one swap each. So a whole life is put into one
// transaction and simulated there (RPC_URL overrides the endpoint): create a config with a transfer fee, create a
// pool on it, buy, sell. A public node runs it against the deployed program; nothing is signed, nothing is sent, and
// none of the accounts exist afterwards. The program's own events (EvtSwap2 for the swap, EvtSwap3 for what the
// transfer fee did to both sides) and the trader's token balances are then held against what the SDK quotes.
//
// The SDK is asked the way an integrator asks: swapQuote2 with the config account the program stored and the pool
// as it stood before each swap, and for the first swap also getQuoteFromInputAmount / getQuoteFromOutputAmount, which
// quote a builder's output before any pool exists.
//
// Every simulation is saved with the accounts it left, so `check` can put another build of the SDK to the same swaps
// offline.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { build, designs, type Design } from "./builders.ts";
import { CONFIG, POOL } from "./layout.ts";
import { Rpc } from "./rpc.ts";

const ENDPOINT = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
const MODES = ["exact-in", "partial fill", "exact-out"] as const;
const TOKEN_INSUFFICIENT_FUNDS = '{"Custom":1}';
const U64_MAX = new BN("18446744073709551615");

type Sdk = Record<string, any>;
type TransferFee = { transferFeeBasisPoints: number; withheldAuthority: number; migratedTransferFeeAuthorityOption: number };
/** One swap asked for: `amount` is what goes in, or for exact-out what must come out (after the transfer fee). */
export type Step = { buy: boolean; mode: 0 | 1 | 2; amount: string };
/** What the program recorded for one swap, integers as decimal strings. */
export type Recorded = {
  includedFeeInputAmount: string;
  excludedFeeInputAmount: string;
  amountLeft: string;
  outputAmount: string;
  nextSqrtPrice: string;
  tradingFee: string;
  protocolFee: string;
  referralFee: string;
  quoteReserve: string;
  includedTransferFeeAmountIn: string;
  excludedTransferFeeAmountIn: string;
  includedTransferFeeAmountOut: string;
  excludedTransferFeeAmountOut: string;
};
/** One simulated transaction. */
export type Sim = {
  n: number;
  builder: string;
  transferFee: TransferFee;
  /** The builder's input, for getQuoteFromInputAmount; custom prices are kept beside it. */
  input: Record<string, any>;
  prices?: number[];
  /** Whether the swaps were shown the instructions sysvar, which is what makes a first swap eligible for the minimum fee. */
  sysvar: boolean;
  steps: Step[];
  /** Lamports wrapped for the trader before the first swap. */
  wrap: string;
  /** The config and pool accounts the transaction left, base64; null when it was refused. */
  configData: string | null;
  poolData: string | null;
  clock: { slot: number; timestamp: number };
  events: Recorded[];
  /** The trader's token accounts after the transaction. */
  balances: { base: string; quote: string } | null;
  /** The step the program refused, and its error. */
  refusedAt: number | null;
  error: string | null;
};

// ---------------------------------------------------------------- cases, repeatable

let seed = 20261013;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

/** Builder inputs in the one shape a transfer fee config may have, quoted in SOL. */
function shaped(count: number): Design[] {
  const out: Design[] = [];
  for (const d of designs(count * 6)) {
    if (d.quote !== "SOL") continue;
    const input = structuredClone(d.input);
    input.token.tokenType = 1;
    input.lockedVesting = { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 };
    input.migration.migrationFeeOption = 6;
    input.migration.migratedPoolFee = { collectFeeMode: 2, dynamicFee: pick([0, 1]), poolFeeBps: pick([10, 25, 100, 250, 1000]), compoundingFeeBps: pick([0, 0, 1000, 5000, 10000]) };
    // keep the raise within what the stand-in trader holds
    if (input.migrationQuoteThreshold !== undefined) input.migrationQuoteThreshold = pick([0.5, 1, 2, 5, 10]);
    out.push({ ...d, input });
  }
  return out;
}

const randomFee = (): TransferFee => {
  const transferFeeBasisPoints = pick([1, 10, 25, 100, 250, 500, 1000, 1000, 0]);
  return { transferFeeBasisPoints, withheldAuthority: pick([0, 1]), migratedTransferFeeAuthorityOption: transferFeeBasisPoints === 0 ? pick([2, 3]) : pick([0, 1, 2, 3]) };
};

const share = (x: BN, f: number) => BN.max(new BN(1), x.mul(new BN(Math.round(f * 1e9))).div(new BN(1e9)));

// ---------------------------------------------------------------- the SDK's answers

const big = (x: string) => new BN(x);
const str = (x: unknown) => (x as { toString(): string }).toString();

/** Twice the number of bins between two prices, as the program's volatility tracker counts them. */
const deltaBins = (binStepU128: BN, a: BN, b: BN) => {
  const [upper, lower] = a.gt(b) ? [a, b] : [b, a];
  return upper.shln(64).div(lower).sub(new BN(1).shln(64)).div(binStepU128).muln(2);
};

export type Verdict = { swaps: number; refusals: number; mismatches: string[] };

/**
 * Put the SDK to one saved simulation. `client` is the SDK's client (any connection; nothing is fetched) and gives
 * the account decoders and the quote functions.
 */
export function checkSim(sdk: Sdk, client: any, s: Sim): Verdict {
  const out: Verdict = { swaps: 0, refusals: 0, mismatches: [] };
  if (!s.configData) return out; // refused before any swap: config2.ts covers what configs the program takes
  const coder = client.partner.program.coder.accounts;
  const config = coder.decode("poolConfig", Buffer.from(s.configData, "base64"));
  const params = build(sdk, { n: s.n, builder: s.builder as Design["builder"], quote: "SOL", input: s.input, prices: s.prices }).params;
  const pool = s.poolData ? coder.decode("virtualPool", Buffer.from(s.poolData, "base64")) : null;
  const point = new BN(config.activationType === 0 ? s.clock.slot : s.clock.timestamp);
  // the pool as initialize_pool leaves it; it opens at once, so its activation point is the moment of the transaction
  const state = { sqrtPrice: config.sqrtStartPrice as BN, quoteReserve: new BN(0), activationPoint: (pool?.activationPoint as BN | undefined) ?? point, hasSwap: 0, volatilityTracker: { volatilityAccumulator: new BN(0) } };
  const same = (label: string, mine: unknown, theirs: unknown) => {
    if (String(mine) !== String(theirs)) out.mismatches.push(`${label}: SDK ${String(mine)}, program ${String(theirs)}`);
  };
  let base = new BN(0);
  let quote = big(s.wrap);
  for (let i = 0; i < s.steps.length; i++) {
    const step = s.steps[i];
    const at = `${s.n}.${i + 1} ${step.buy ? "buy" : "sell"} ${MODES[step.mode]}`;
    const refused = s.refusedAt === i;
    const eligible = i === 0 && s.sysvar;
    const amount = big(step.amount);
    const ask = (f: () => any): { quote?: any; error?: string } => {
      try {
        return { quote: f() };
      } catch (e) {
        return { error: (e instanceof Error ? e.message : String(e)).slice(0, 90) };
      }
    };
    const answers: [string, { quote?: any; error?: string }][] = [
      ["swapQuote2", ask(() => client.pool.swapQuote2({ virtualPool: { poolState: state }, config, swapBaseForQuote: !step.buy, hasReferral: false, eligibleForFirstSwapWithMinFee: eligible, currentPoint: point, swapMode: step.mode, ...(step.mode === 2 ? { amountOut: amount } : { amountIn: amount }) }))],
    ];
    // before any pool exists the SDK quotes the builder's output; that is the first swap of a pool that opens at once
    if (i === 0 && params) {
      const common = { config: params, swapBaseForQuote: !step.buy, hasReferral: false, eligibleForFirstSwapWithMinFee: eligible, currentPoint: point, baseTransferFeeBasisPoints: s.transferFee.transferFeeBasisPoints };
      answers.push(step.mode === 2 ? ["getQuoteFromOutputAmount", ask(() => client.pool.getQuoteFromOutputAmount({ ...common, amountOut: amount }))] : ["getQuoteFromInputAmount", ask(() => client.pool.getQuoteFromInputAmount({ ...common, amountIn: amount, swapMode: step.mode }))]);
    }
    if (refused) {
      out.refusals++;
      for (const [name, a] of answers) {
        if (!a.quote) continue; // both refuse
        // The token program, not the pool, refuses a swap the trader cannot pay for (its error 1, insufficient
        // funds). That agrees with a quote that asks for more than the trader holds.
        if (s.error === TOKEN_INSUFFICIENT_FUNDS && new BN(str(a.quote.includedTransferFeeAmountIn)).gt(step.buy ? quote : base)) continue;
        out.mismatches.push(`${at}: ${name} quotes ${str(a.quote.outputAmount)} out, the program refuses (${s.error})`);
      }
      break;
    }
    const ev = s.events[i];
    if (!ev) break; // a later step of a transaction refused earlier
    out.swaps++;
    for (const [name, a] of answers) {
      if (!a.quote) {
        out.mismatches.push(`${at}: ${name} throws (${a.error}), the program swapped`);
        continue;
      }
      const q = a.quote;
      const total = (r: any) => str(new BN(str(r.tradingFee)).add(new BN(str(r.protocolFee))).add(new BN(str(r.referralFee))));
      same(`${at} ${name} input with fee`, q.includedFeeInputAmount, ev.includedFeeInputAmount);
      same(`${at} ${name} input without fee`, q.excludedFeeInputAmount, ev.excludedFeeInputAmount);
      same(`${at} ${name} amount left`, q.amountLeft, ev.amountLeft);
      same(`${at} ${name} output`, q.outputAmount, ev.outputAmount);
      same(`${at} ${name} next price`, q.nextSqrtPrice, ev.nextSqrtPrice);
      same(`${at} ${name} fees`, total(q), total(ev));
      same(`${at} ${name} leaves the trader`, q.includedTransferFeeAmountIn, ev.includedTransferFeeAmountIn);
      same(`${at} ${name} reaches the trader`, q.excludedTransferFeeAmountOut, ev.excludedTransferFeeAmountOut);
    }
    // the pool after this swap, from the program's own record
    const before = state.sqrtPrice;
    state.sqrtPrice = big(ev.nextSqrtPrice);
    state.quoteReserve = big(ev.quoteReserve);
    state.hasSwap = 1;
    const dynamic = config.poolFees.dynamicFee;
    // a fresh pool's first swap sets the reference to the price it started from; the memory is then the distance moved
    if (dynamic.initialized && i === 0) state.volatilityTracker.volatilityAccumulator = BN.min(deltaBins(dynamic.binStepU128, state.sqrtPrice, before).muln(10_000), new BN(dynamic.maxVolatilityAccumulator));
    const [sent, got] = [big(ev.includedTransferFeeAmountIn), big(ev.excludedTransferFeeAmountOut)];
    if (step.buy) [quote, base] = [quote.sub(sent), base.add(got)];
    else [base, quote] = [base.sub(sent), quote.add(got)];
  }
  // what the events say reached the trader is what the token accounts hold (after a refusal: the accounts of the
  // same transaction asked again without the refused swap)
  if (s.balances) {
    if (str(base) !== s.balances.base) out.mismatches.push(`${s.n}: the events leave the trader ${str(base)} tokens, the account holds ${s.balances.base}`);
    if (str(quote) !== s.balances.quote) out.mismatches.push(`${s.n}: the events leave the trader ${str(quote)} lamports wrapped, the account holds ${s.balances.quote}`);
  }
  return out;
}

export function readSims(file: string | URL): Sim[] {
  const raw = readFileSync(file);
  return (String(file).endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function summarize(sdk: Sdk, client: any, sims: Sim[]) {
  const verdicts = sims.map((s) => ({ s, v: checkSim(sdk, client, s) }));
  const ran = verdicts.filter((x) => x.s.configData);
  const swaps = ran.flatMap((x) => x.s.events.map((_, i) => x.s.steps[i]));
  const count = (f: (st: Step) => boolean) => swaps.filter(f).length;
  const differing = verdicts.filter((x) => x.v.mismatches.length);
  return {
    simulations: sims.length,
    ran: ran.length,
    swaps: swaps.length,
    buys: count((st) => st.buy),
    sells: count((st) => !st.buy),
    exactIn: count((st) => st.mode === 0),
    partialFill: count((st) => st.mode === 1),
    exactOut: count((st) => st.mode === 2),
    refusals: ran.reduce((n, x) => n + x.v.refusals, 0),
    // first buys that paid the minimum fee: the config allows it and the swap was shown the instructions sysvar
    firstSwapsAtMinimumFee: ran.filter((x) => x.s.sysvar && x.s.events.length > 0 && client.partner.program.coder.accounts.decode("poolConfig", Buffer.from(x.s.configData!, "base64")).enableFirstSwapWithMinFee === 1).length,
    dynamicFeeLives: ran.filter((x) => client.partner.program.coder.accounts.decode("poolConfig", Buffer.from(x.s.configData!, "base64")).poolFees.dynamicFee.initialized === 1).length,
    feeOnOutputLives: ran.filter((x) => client.partner.program.coder.accounts.decode("poolConfig", Buffer.from(x.s.configData!, "base64")).collectFeeMode === 1).length,
    feeLevels: [...new Set(ran.map((x) => x.s.transferFee.transferFeeBasisPoints))].sort((a, b) => a - b),
    builders: [...new Set(ran.map((x) => x.s.builder))].sort(),
    agree: ran.length - differing.length,
    differing: differing.slice(0, 40).map((x) => ({ n: x.s.n, first: x.v.mismatches[0], more: x.v.mismatches.length - 1 })),
  };
}

// ---------------------------------------------------------------- commands

const args = import.meta.main ? process.argv.slice(2) : [];
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const loadSdk = async (): Promise<Sdk> => {
  if (!flag("--sdk")) throw new Error("--sdk <bundle from scripts/bundle-sdk.mjs>: the installed SDK knows nothing of transfer fees");
  return import(pathToFileURL(resolve(flag("--sdk")!)).href);
};

type Simulated = { err: unknown; logs: string[] | null; accounts: ({ data: [string, string] } | null)[] | null; innerInstructions?: { index: number; instructions: { programIdIndex?: number; programId?: string; data?: string }[] }[] | null };

if (args[0] === "run") {
  const count = Number(args[1] && !args[1].startsWith("--") ? args[1] : 300);
  const out = flag("--out") ?? "data/transferfee.jsonl";
  const sdk = await loadSdk();
  const rpc = new Rpc(ENDPOINT, 400);
  const client = new sdk.DynamicBondingCurveClient(new Connection(ENDPOINT, "confirmed"), "confirmed");
  const program = client.partner.program;
  // With signature checks off any funded system account can stand in as creator and trader: the richest of the
  // larger validators' identities. Untouched.
  let payer: PublicKey | null = null;
  let funds = 0;
  const votes = await rpc.call<{ current: { nodePubkey: string; activatedStake: number }[] }>("getVoteAccounts", []);
  for (const v of votes.current.sort((a, b) => b.activatedStake - a.activatedStake).slice(0, 12)) {
    const a = (await rpc.call<{ value: { owner: string; lamports: number; data: [string, string] } | null }>("getAccountInfo", [v.nodePubkey, { encoding: "base64" }])).value;
    if (a && a.owner === SystemProgram.programId.toBase58() && a.data[0] === "" && a.lamports > funds) [payer, funds] = [new PublicKey(v.nodePubkey), a.lamports];
  }
  if (!payer) throw new Error("no funded system account found to stand in as trader");
  console.log(`stand-in trader ${payer.toBase58()} holds ${(funds / 1e9).toFixed(1)} SOL on ${ENDPOINT}`);
  const poolAuthority: PublicKey = sdk.deriveDbcPoolAuthority();
  const done = existsSync(out) ? new Set(readSims(out).map((s) => s.n)) : new Set<number>();
  seed = 20261013;
  let made = done.size;
  for (const d of shaped(count)) {
    // the random stream is drawn the same way whether or not a case is skipped, so a rerun asks the same questions
    const transferFee = randomFee();
    let sysvar = rnd() < 0.5;
    const plan = { buyMode: pick([0, 0, 1, 2] as const), buyShare: pick([1e-7, 0.001, 0.05, 0.3, 0.7, 0.98, 1.5]), sellMode: pick([0, 0, 1, 2] as const), sellShare: pick([1e-6, 0.3, 0.5, 1, 1]), sells: rnd() < 0.8 };
    if (made >= count) break;
    if (done.has(d.n)) continue;
    const built = build(sdk, d);
    // one instruction has to carry the whole config: a curve of more than two segments does not fit beside the rest
    if (!built.params || built.params.curve.length > 2) continue;
    const params = built.params;
    // a config the SDK itself refuses is config2.ts's subject, not this one's
    try {
      sdk.validateConfigParameters?.({ ...params, leftoverReceiver: payer }, { transferFeeParameters: transferFee, feeClaimer: payer });
    } catch {
      continue;
    }
    const threshold: BN = params.migrationQuoteThreshold;
    if (threshold.gt(new BN(Math.floor(funds * 0.25)))) continue;
    let price: BN;
    let onCurve: BN;
    try {
      price = sdk.getMigrationThresholdPrice(threshold, params.sqrtStartPrice, params.curve);
      onCurve = sdk.getBaseTokenForSwap(params.sqrtStartPrice, price, params.curve);
    } catch {
      continue;
    }
    const config = Keypair.generate().publicKey;
    const baseMint = Keypair.generate().publicKey;
    const pool: PublicKey = sdk.deriveDbcPoolAddress(NATIVE_MINT, baseMint, config);
    const baseVault: PublicKey = sdk.deriveDbcTokenVaultAddress(pool, baseMint);
    const quoteVault: PublicKey = sdk.deriveDbcTokenVaultAddress(pool, NATIVE_MINT);
    const quoteAta = getAssociatedTokenAddressSync(NATIVE_MINT, payer, true, TOKEN_PROGRAM_ID);
    const baseAta = getAssociatedTokenAddressSync(baseMint, payer, true, TOKEN_2022_PROGRAM_ID);
    // the buy: a share of the raise going in, or of the curve's tokens coming out
    const buy: Step = { buy: true, mode: plan.buyMode, amount: (plan.buyMode === 2 ? share(onCurve, Math.min(plan.buyShare, 0.98)) : share(threshold, plan.buyShare)).toString() };
    // enough wrapped for the whole raise at a launch fee of 99%
    const wrap = BN.min(threshold.muln(120), new BN(Math.floor(funds * 0.5))).add(new BN(10_000_000));
    const steps: Step[] = [buy];
    // the sell is sized from the SDK's own quote of the buy; if that quote is wrong, the buy shows it
    if (plan.sells && plan.buyShare < 1) {
      try {
        const q = client.pool.getQuoteFromInputAmount && buy.mode !== 2 ? client.pool.getQuoteFromInputAmount({ config: params, swapBaseForQuote: false, amountIn: new BN(buy.amount), swapMode: buy.mode, currentPoint: new BN(0), eligibleForFirstSwapWithMinFee: sysvar, baseTransferFeeBasisPoints: transferFee.transferFeeBasisPoints }) : client.pool.getQuoteFromOutputAmount({ config: params, swapBaseForQuote: false, amountOut: new BN(buy.amount), currentPoint: new BN(0), eligibleForFirstSwapWithMinFee: sysvar, baseTransferFeeBasisPoints: transferFee.transferFeeBasisPoints });
        const held: BN = q.excludedTransferFeeAmountOut;
        const spent: BN = q.excludedFeeInputAmount;
        if (held.gtn(0)) steps.push({ buy: false, mode: plan.sellMode, amount: (plan.sellMode === 2 ? share(spent, Math.min(plan.sellShare, 0.8)) : share(held, plan.sellShare)).toString() });
      } catch {
        // the SDK refuses the buy: the buy alone is asked, and the program's answer decides
      }
    }
    const swapIx = (st: Step) =>
      program.methods
        // no slippage limit either way: an exact-out swap may cost whatever it costs, and the trader's balance is the only bound
        .swap2(st.mode === 2 ? { amount0: new BN(st.amount), amount1: U64_MAX, swapMode: 2 } : { amount0: new BN(st.amount), amount1: new BN(0), swapMode: st.mode })
        .accountsPartial({ poolAuthority, config, pool, inputTokenAccount: st.buy ? quoteAta : baseAta, outputTokenAccount: st.buy ? baseAta : quoteAta, baseVault, quoteVault, baseMint, quoteMint: NATIVE_MINT, payer, tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null })
        .remainingAccounts(sysvar ? [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }] : [])
        .instruction() as Promise<TransactionInstruction>;
    const head: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      await program.methods.createConfig2(params, transferFee).accountsPartial({ config, feeClaimer: payer, leftoverReceiver: payer, quoteMint: NATIVE_MINT, payer }).instruction(),
      await program.methods.initializeVirtualPoolWithToken2022({ name: "t", symbol: "T", uri: "" }).accountsPartial({ config, poolAuthority, creator: payer, baseMint, quoteMint: NATIVE_MINT, pool, baseVault, quoteVault, payer, tokenQuoteProgram: TOKEN_PROGRAM_ID, tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction(),
      createAssociatedTokenAccountIdempotentInstruction(payer, quoteAta, payer, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: quoteAta, lamports: BigInt(wrap.toString()) }),
      createSyncNativeInstruction(quoteAta),
      createAssociatedTokenAccountIdempotentInstruction(payer, baseAta, payer, baseMint, TOKEN_2022_PROGRAM_ID),
    ];
    // as many of the swaps as fit in one transaction
    let wire: string | null = null;
    let tx = new Transaction();
    while (steps.length && !wire) {
      tx = new Transaction();
      tx.feePayer = payer;
      tx.recentBlockhash = bs58.encode(Buffer.alloc(32, 1)); // replaced by the node
      tx.add(...head, ...(await Promise.all(steps.map(swapIx))));
      try {
        wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
      } catch {
        // too large: first without the sysvar account, then without the sell
        if (sysvar && steps.length > 1) sysvar = false;
        else steps.pop();
      }
    }
    if (!wire) continue;
    await new Promise((r) => setTimeout(r, Number(process.env.PACE_MS ?? 900))); // a public node: go slowly
    const r = (await rpc.call<{ value: Simulated }>("simulateTransaction", [wire, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", encoding: "base64", innerInstructions: true, accounts: { encoding: "base64", addresses: [config.toBase58(), pool.toBase58(), SYSVAR_CLOCK_PUBKEY.toBase58(), baseAta.toBase58(), quoteAta.toBase58()] } }])).value;
    const sim: Sim = { n: d.n, builder: d.builder, transferFee, input: d.input, prices: d.prices, sysvar, steps, wrap: wrap.toString(), configData: null, poolData: null, clock: { slot: 0, timestamp: 0 }, events: [], balances: null, refusedAt: null, error: null };
    const first = head.length;
    const named = (r.logs ?? []).map((l) => /Error Code: (\w+)/.exec(l)?.[1]).filter(Boolean).pop();
    const where = (r.err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
    if (r.err && (!where || where[0] < first)) {
      // refused before any swap: the config or the pool, which is config2.ts's subject, or the harness
      sim.error = `before the swaps, at instruction ${where?.[0] ?? "?"}: ${named ?? JSON.stringify(r.err).slice(0, 80)}`;
      appendFileSync(out, JSON.stringify(sim) + "\n");
      console.log(`#${d.n} ${d.builder}: ${sim.error}`);
      continue;
    }
    if (r.err) {
      // A refused transaction leaves nothing behind, and the swaps before the refused one left no events. Ask again
      // without the refused swap and the ones after it, so the accounts and the earlier events are on record.
      sim.refusedAt = where![0] - first;
      sim.error = named ?? JSON.stringify(where![1]);
    }
    const kept = sim.refusedAt === null ? steps : steps.slice(0, sim.refusedAt);
    let answer = r;
    if (r.err) {
      const again = new Transaction();
      again.feePayer = payer;
      again.recentBlockhash = bs58.encode(Buffer.alloc(32, 1));
      again.add(...head, ...(await Promise.all(kept.map(swapIx))));
      await new Promise((res) => setTimeout(res, Number(process.env.PACE_MS ?? 900)));
      answer = (await rpc.call<{ value: Simulated }>("simulateTransaction", [again.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", encoding: "base64", innerInstructions: true, accounts: { encoding: "base64", addresses: [config.toBase58(), pool.toBase58(), SYSVAR_CLOCK_PUBKEY.toBase58(), baseAta.toBase58(), quoteAta.toBase58()] } }])).value;
      tx = again;
      if (answer.err) {
        sim.error = `${sim.error}; and without that swap: ${JSON.stringify(answer.err).slice(0, 80)}`;
        appendFileSync(out, JSON.stringify(sim) + "\n");
        console.log(`#${d.n} ${d.builder}: ${sim.error}`);
        continue;
      }
    }
    const acc = answer.accounts ?? [];
    if (!acc[0] || !acc[1] || !acc[2]) {
      console.log(`#${d.n}: the node returned no accounts`);
      continue;
    }
    sim.configData = acc[0].data[0];
    sim.poolData = acc[1].data[0];
    const clock = Buffer.from(acc[2].data[0], "base64");
    sim.clock = { slot: Number(clock.readBigUInt64LE(0)), timestamp: Number(clock.readBigInt64LE(32)) };
    const amountOf = (a: { data: [string, string] } | null) => (a ? Buffer.from(a.data[0], "base64").readBigUInt64LE(64).toString() : "0");
    sim.balances = { base: amountOf(acc[3]), quote: amountOf(acc[4]) };
    const keys = tx.compileMessage().accountKeys.map((k) => k.toBase58());
    const swap2: any[] = [];
    const swap3: any[] = [];
    for (const group of answer.innerInstructions ?? []) {
      for (const ix of group.instructions) {
        if ((ix.programId ?? keys[ix.programIdIndex ?? -1]) !== PROGRAM_ID || !ix.data) continue;
        const data = bs58.decode(ix.data);
        if (data.length < 16 || EVENT_IX_TAG.some((b, i) => data[i] !== b)) continue;
        let ev = null;
        try {
          ev = program.coder.events.decode(Buffer.from(data.subarray(8)).toString("base64"));
        } catch {
          // an event this IDL does not know
        }
        if (ev?.name === "evtSwap2") swap2.push(ev.data);
        if (ev?.name === "evtSwap3") swap3.push(ev.data);
      }
    }
    if (swap2.length !== kept.length || swap3.length !== kept.length) {
      console.log(`#${d.n}: expected ${kept.length} swaps, the node returned ${swap2.length} EvtSwap2 and ${swap3.length} EvtSwap3`);
      continue;
    }
    sim.events = kept.map((_, i) => ({
      includedFeeInputAmount: str(swap2[i].swapResult.includedFeeInputAmount),
      excludedFeeInputAmount: str(swap2[i].swapResult.excludedFeeInputAmount),
      amountLeft: str(swap2[i].swapResult.amountLeft),
      outputAmount: str(swap2[i].swapResult.outputAmount),
      nextSqrtPrice: str(swap2[i].swapResult.nextSqrtPrice),
      tradingFee: str(swap2[i].swapResult.tradingFee),
      protocolFee: str(swap2[i].swapResult.protocolFee),
      referralFee: str(swap2[i].swapResult.referralFee),
      quoteReserve: str(swap3[i].quoteReserve),
      includedTransferFeeAmountIn: str(swap3[i].includedTransferFeeAmountIn),
      excludedTransferFeeAmountIn: str(swap3[i].excludedTransferFeeAmountIn),
      includedTransferFeeAmountOut: str(swap3[i].includedTransferFeeAmountOut),
      excludedTransferFeeAmountOut: str(swap3[i].excludedTransferFeeAmountOut),
    }));
    appendFileSync(out, JSON.stringify(sim) + "\n");
    made++;
    const v = checkSim(sdk, client, sim);
    if (v.mismatches.length) console.log(`#${d.n} ${d.builder} ${transferFee.transferFeeBasisPoints} bps: ${v.mismatches.slice(0, 3).join(" | ")}`);
  }
  const s = summarize(sdk, client, readSims(out));
  console.log(JSON.stringify({ ...s, differing: s.differing.length }));
} else if (args[0] === "check") {
  const sdk = await loadSdk();
  const client = new sdk.DynamicBondingCurveClient(new Connection(ENDPOINT, "confirmed"), "confirmed");
  const s = summarize(sdk, client, readSims(flag("--file") ?? "data/transferfee.jsonl"));
  console.log(`${s.simulations} simulated lives of a transfer fee pool, ${s.ran} with swaps: ${s.swaps} swaps (${s.buys} buys, ${s.sells} sells; ${s.exactIn} exact-in, ${s.partialFill} partial fill, ${s.exactOut} exact-out) and ${s.refusals} refusals`);
  console.log(`transfer fees of ${s.feeLevels.join(", ")} bps; ${s.firstSwapsAtMinimumFee} first buys at the minimum fee; ${s.dynamicFeeLives} lives with a dynamic fee, ${s.feeOnOutputLives} with the fee on the output token; builders ${s.builders.join(", ")}`);
  console.log(`the SDK's quotes are the program's amounts, fees, next price and what leaves and reaches the trader in ${s.agree} of ${s.ran}`);
  for (const d of s.differing.slice(0, 25)) console.log(`  #${d.n} ${d.first}${d.more ? ` (+${d.more})` : ""}`);
  if (flag("--json")) writeFileSync(flag("--json")!, JSON.stringify({ generatedAt: new Date().toISOString(), sdk: flag("--name") ?? flag("--sdk"), endpoint: ENDPOINT, ...s }, null, 1));
  process.exit(s.differing.length ? 1 : 0);
} else if (args[0] === "history") {
  // The pools with a transfer fee that really exist on the endpoint: the swaps of the first transaction that traded
  // each one, as the program recorded them, put to the SDK from the pool as initialize_pool left it.
  const sdk = await loadSdk();
  const rpc = new Rpc(ENDPOINT, 400);
  const client = new sdk.DynamicBondingCurveClient(new Connection(ENDPOINT, "confirmed"), "confirmed");
  const coder = client.partner.program.coder;
  const flagAt = (CONFIG.fields.get("transfer_fee_basis_points") ?? CONFIG.fields.get("padding_0"))!.offset + 4;
  type Listed = { pubkey: string; account: { data: [string, string] } };
  const configs = await rpc.call<Listed[]>("getProgramAccounts", [PROGRAM_ID, { encoding: "base64", filters: [{ dataSize: CONFIG.size }, { memcmp: { offset: flagAt, bytes: bs58.encode(Uint8Array.from([1])) } }] }]);
  const sims: Sim[] = [];
  for (const c of configs) {
    const pools = await rpc.call<Listed[]>("getProgramAccounts", [PROGRAM_ID, { encoding: "base64", filters: [{ dataSize: POOL.size }, { memcmp: { offset: POOL.fields.get("pool_state.config")!.offset, bytes: c.pubkey } }] }]);
    for (const p of pools) {
      const sigs = (await rpc.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [p.pubkey, { limit: 1000 }])).filter((x) => !x.err).reverse();
      for (const [k, sig] of sigs.entries()) {
        const tx = await rpc.call<any>("getTransaction", [sig.signature, { maxSupportedTransactionVersion: 0, encoding: "json" }]);
        const keys: string[] = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
        const swap2: any[] = [];
        const swap3: any[] = [];
        for (const group of tx.meta.innerInstructions ?? []) {
          for (const ix of group.instructions) {
            const data = bs58.decode(ix.data);
            if (keys[ix.programIdIndex] !== PROGRAM_ID || data.length < 16 || EVENT_IX_TAG.some((b, i) => data[i] !== b)) continue;
            let ev = null;
            try {
              ev = coder.events.decode(Buffer.from(data.subarray(8)).toString("base64"));
            } catch {
              // an event this IDL does not know
            }
            if (ev?.data.pool?.toBase58?.() !== p.pubkey) continue;
            if (ev.name === "evtSwap2") swap2.push(ev.data);
            if (ev.name === "evtSwap3") swap3.push(ev.data);
          }
        }
        if (!swap2.length) continue;
        // a first swap in the transaction that created the pool may have paid the minimum fee, which the record does not say
        if (k === 0 || swap2.length !== swap3.length) break;
        sims.push({
          n: sims.length + 1,
          builder: `pool ${p.pubkey}`,
          transferFee: { transferFeeBasisPoints: Buffer.from(c.account.data[0], "base64").readUInt16LE(flagAt - 4), withheldAuthority: 0, migratedTransferFeeAuthorityOption: 0 },
          input: {},
          sysvar: false,
          steps: swap2.map((e) => ({ buy: e.tradeDirection === 1, mode: e.swapParameters.swapMode, amount: str(e.swapParameters.amount0) })),
          wrap: "0",
          configData: c.account.data[0],
          poolData: p.account.data[0],
          clock: { slot: tx.slot, timestamp: tx.blockTime },
          events: swap2.map((e, i) => ({
            includedFeeInputAmount: str(e.swapResult.includedFeeInputAmount),
            excludedFeeInputAmount: str(e.swapResult.excludedFeeInputAmount),
            amountLeft: str(e.swapResult.amountLeft),
            outputAmount: str(e.swapResult.outputAmount),
            nextSqrtPrice: str(e.swapResult.nextSqrtPrice),
            tradingFee: str(e.swapResult.tradingFee),
            protocolFee: str(e.swapResult.protocolFee),
            referralFee: str(e.swapResult.referralFee),
            quoteReserve: str(swap3[i].quoteReserve),
            includedTransferFeeAmountIn: str(swap3[i].includedTransferFeeAmountIn),
            excludedTransferFeeAmountIn: str(swap3[i].excludedTransferFeeAmountIn),
            includedTransferFeeAmountOut: str(swap3[i].includedTransferFeeAmountOut),
            excludedTransferFeeAmountOut: str(swap3[i].excludedTransferFeeAmountOut),
          })),
          balances: null,
          refusedAt: null,
          error: null,
        });
        break;
      }
    }
  }
  if (flag("--out")) writeFileSync(flag("--out")!, sims.map((x) => JSON.stringify(x) + "\n").join(""));
  console.log(`${configs.length} configs with a transfer fee on ${ENDPOINT}, ${sims.length} pools under them with a swap on record`);
  for (const x of sims) {
    const v = checkSim(sdk, client, x);
    console.log(`  ${x.builder} ${x.transferFee.transferFeeBasisPoints} bps: ${x.steps.map((st) => `${st.buy ? "buy" : "sell"} ${MODES[st.mode]} ${st.amount}`).join(", ")}: ${v.mismatches.length ? v.mismatches.join(" | ") : "as the SDK quotes"}`);
  }
} else if (import.meta.main) {
  console.log("usage: node src/transferfee.ts run [cases] --sdk data/sdk.mjs [--out data/transferfee.jsonl]\n       node src/transferfee.ts check --sdk data/sdk.mjs [--file data/transferfee.jsonl] [--json web/data/transferfee.json]");
}
