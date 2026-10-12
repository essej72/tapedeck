// Before release: does program 0.2.2 take what SDK 2.0's createConfig2 builds, and do the two refuse the same things?
//
//   node src/config2.ts run [designs, default 300] --sdk data/sdk.mjs [--out data/config2.jsonl]
//   node src/config2.ts report [--file data/config2.jsonl] [--json web/data/config2.json] [--name "SDK 2.0 at ..."]
//
// builders.ts puts the curve builders in front of the live program through createConfig, because create_config2 is
// not on mainnet. It is on devnet, where the program was redeployed on 8 October 2026. So this runs there (RPC_URL
// overrides the endpoint): the same random builder inputs through createConfig2, and the part of 0.2.2 that mainnet
// cannot show at all, a transfer fee on the base mint.
//
// Each case is put to both sides. The SDK either builds the transaction or refuses. Where it refuses, the same
// instruction is built without the SDK's checks and sent anyway, to hear what the program says. A public devnet node
// simulates; nothing is signed or sent. Four outcomes, kept apart:
//   both take it          and then: is what the program stores what the SDK derives?
//   both refuse it        agreement
//   the SDK builds it and the program refuses      a transaction that fails for the user
//   the SDK refuses it and the program takes it    a config the SDK keeps its users from
//
// Transfer fee cases come three to a design: settings picked at random from the valid range, one edge of that range
// (a fee over the cap, an unknown authority, a zero fee that can never change), and one valid fee on a config that
// breaks a single rule for such configs (not Token-2022, vesting, a fixed migration fee tier, a migrated pool that
// does not compound, a supply that is not constant).

import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { build, designs, storedDifferences, type Design } from "./builders.ts";
import { dryRun } from "./deploy.ts";
import { CONFIG } from "./layout.ts";
import { readLines } from "./migration.ts";
import { Rpc } from "./rpc.ts";

const ENDPOINT = process.env.RPC_URL ?? "https://api.devnet.solana.com";
// wrapped SOL is the same mint everywhere; USDC on devnet is Circle's test mint
const MINTS: Record<string, string> = { SOL: "So11111111111111111111111111111111111111112", USDC: process.env.USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" };

type Sdk = Record<string, any>;
type TransferFee = { transferFeeBasisPoints: number; withheldAuthority: number; migratedTransferFeeAuthorityOption: number };
export type Row = {
  n: number;
  kind: "plain" | "fee";
  /** What the case is: "plain", "fee: valid", "fee: 1001 bps", "fee on: vesting"... */
  label: string;
  transferFee: TransferFee | null;
  /** The builder refused the input: nothing to send. */
  builder?: string;
  /** null: the SDK built the transaction. */
  sdk?: string | null;
  /** null: the program stored the config. */
  program?: string | null;
  /** Both took it: where the stored config is not what the SDK derives. */
  differs?: string[];
  /** The config account as the program would store it, base64. */
  data?: string;
};

// ---------------------------------------------------------------- cases, repeatable

let seed = 20261012;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

/** A design moved into the one shape a transfer fee config may have. */
function feeShaped(d: Design): Design {
  const input = structuredClone(d.input);
  input.token.tokenType = 1;
  input.lockedVesting = { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 };
  input.migration.migrationFeeOption = 6;
  input.migration.migratedPoolFee = { collectFeeMode: 2, dynamicFee: pick([0, 1]), poolFeeBps: pick([10, 25, 100, 250, 1000]), compoundingFeeBps: pick([0, 0, 1000, 5000, 10000]) };
  return { ...d, input };
}

const validFee = (): TransferFee => {
  const transferFeeBasisPoints = pick([1, 10, 25, 100, 500, 1000, 0]);
  // a zero fee has to stay changeable after migration: the creator's or the partner's
  return { transferFeeBasisPoints, withheldAuthority: pick([0, 1]), migratedTransferFeeAuthorityOption: transferFeeBasisPoints === 0 ? pick([2, 3]) : pick([0, 1, 2, 3]) };
};

const EDGES: [string, TransferFee][] = [
  ["1000 bps, the cap", { transferFeeBasisPoints: 1000, withheldAuthority: 0, migratedTransferFeeAuthorityOption: 0 }],
  ["1001 bps", { transferFeeBasisPoints: 1001, withheldAuthority: 0, migratedTransferFeeAuthorityOption: 0 }],
  ["10000 bps", { transferFeeBasisPoints: 10000, withheldAuthority: 1, migratedTransferFeeAuthorityOption: 2 }],
  ["withheld authority 2", { transferFeeBasisPoints: 100, withheldAuthority: 2, migratedTransferFeeAuthorityOption: 0 }],
  ["authority option 4", { transferFeeBasisPoints: 100, withheldAuthority: 0, migratedTransferFeeAuthorityOption: 4 }],
  ["0 bps, immutable", { transferFeeBasisPoints: 0, withheldAuthority: 0, migratedTransferFeeAuthorityOption: 0 }],
  ["0 bps, revoked at zero", { transferFeeBasisPoints: 0, withheldAuthority: 1, migratedTransferFeeAuthorityOption: 1 }],
  ["0 bps, creator's to change", { transferFeeBasisPoints: 0, withheldAuthority: 1, migratedTransferFeeAuthorityOption: 2 }],
];

/** One rule for transfer fee configs broken: on the builder's input, or on its output where the builder cannot make it. */
const BROKEN: [string, (input: Record<string, any>) => void, ((params: Record<string, any>) => void)?][] = [
  ["an SPL token", (i) => (i.token.tokenType = 0)],
  ["vesting", (i) => (i.lockedVesting = { totalLockedVestingAmount: i.token.totalTokenSupply * 0.05, numberOfVestingPeriod: 12, cliffUnlockAmount: 0, totalVestingDuration: 365 * 86400, cliffDurationFromMigrationTime: 0 })],
  ["a fixed migration fee tier", (i) => ((i.migration.migrationFeeOption = pick([0, 2, 5])), delete i.migration.migratedPoolFee)],
  ["a migrated pool collecting in quote", (i) => ((i.migration.migratedPoolFee.collectFeeMode = 0), (i.migration.migratedPoolFee.compoundingFeeBps = 0))],
  ["a migrated pool collecting in the output token", (i) => ((i.migration.migratedPoolFee.collectFeeMode = 1), (i.migration.migratedPoolFee.compoundingFeeBps = 0))],
  ["a supply that shrinks at migration", () => {}, (p) => (p.tokenSupply = { ...p.tokenSupply, postMigrationTokenSupply: p.tokenSupply.postMigrationTokenSupply.sub(new BN(1)) })],
  ["no fixed supply", () => {}, (p) => (p.tokenSupply = null)],
];

type Case = { n: number; kind: Row["kind"]; label: string; design: Design; transferFee: TransferFee | null; after?: (params: Record<string, any>) => void };

/** `count` plain cases, and three transfer fee cases for every second design. */
export function cases(count: number): Case[] {
  seed = 20261012;
  const out: Case[] = [];
  for (const d of designs(count)) {
    out.push({ n: d.n, kind: "plain", label: "plain", design: d, transferFee: null });
    if (d.n % 2) continue;
    const shaped = feeShaped(d);
    out.push({ n: d.n, kind: "fee", label: "fee: valid", design: shaped, transferFee: validFee() });
    const [edge, fee] = pick(EDGES);
    out.push({ n: d.n, kind: "fee", label: `fee: ${edge}`, design: shaped, transferFee: fee });
    const [what, onInput, onParams] = pick(BROKEN);
    const input = structuredClone(shaped.input);
    onInput(input);
    out.push({ n: d.n, kind: "fee", label: `fee on: ${what}`, design: { ...shaped, input }, transferFee: validFee(), after: onParams });
  }
  return out;
}

// ---------------------------------------------------------------- the stored transfer fee

/** The four transfer fee bytes of a stored config and their flag (state/config.rs, 0.2.2). */
export function storedTransferFee(data: Uint8Array): (TransferFee & { flag: number }) | null {
  const at = CONFIG.fields.has("transfer_fee_basis_points") ? CONFIG.fields.get("transfer_fee_basis_points")!.offset : CONFIG.fields.get("padding_0")?.offset;
  if (at === undefined) return null;
  const d = Buffer.from(data);
  return { transferFeeBasisPoints: d.readUInt16LE(at), withheldAuthority: d[at + 2], migratedTransferFeeAuthorityOption: d[at + 3], flag: d[at + 4] };
}

// ---------------------------------------------------------------- report

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 110);
const readRows = (file: string): Row[] => readLines(file).map((l) => JSON.parse(l)); // .gz too

export function summarize(rows: Row[]) {
  const sent = rows.filter((r) => !r.builder);
  const count = (xs: Row[]) => {
    const both = xs.filter((r) => r.sdk === null && r.program === null);
    return {
      cases: xs.length,
      bothTake: both.length,
      storedAsDerived: both.filter((r) => !r.differs?.length).length,
      bothRefuse: xs.filter((r) => r.sdk && r.program).length,
      sdkBuildsProgramRefuses: xs.filter((r) => r.sdk === null && r.program).length,
      sdkRefusesProgramTakes: xs.filter((r) => r.sdk && r.program === null).length,
    };
  };
  const list = (xs: Row[]) => {
    const m = new Map<string, number>();
    for (const r of xs) {
      const k = `${r.label} | SDK: ${r.sdk ?? "builds it"} | program: ${r.program ?? "stores it"}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m].sort((a, b) => b[1] - a[1]).map(([what, n]) => ({ what, n }));
  };
  const labels = [...new Set(sent.filter((r) => r.kind === "fee").map((r) => r.label))].sort();
  return {
    rows: rows.length,
    refusedByBuilder: rows.length - sent.length,
    plain: count(sent.filter((r) => r.kind === "plain")),
    fee: count(sent.filter((r) => r.kind === "fee")),
    byLabel: labels.map((label) => ({ label, ...count(sent.filter((r) => r.label === label)) })),
    disagreements: list(sent.filter((r) => (r.sdk === null) !== (r.program === null))),
    storedDifferently: sent.filter((r) => r.differs?.length).slice(0, 12).map((r) => ({ n: r.n, label: r.label, first: r.differs![0] })),
  };
}

function print(rows: Row[], name: string) {
  const s = summarize(rows);
  const line = (c: ReturnType<typeof summarize>["plain"]) => `${c.cases} sent: both take ${c.bothTake} (${c.storedAsDerived} stored as the SDK derives), both refuse ${c.bothRefuse}, SDK builds and program refuses ${c.sdkBuildsProgramRefuses}, SDK refuses and program takes ${c.sdkRefusesProgramTakes}`;
  console.log(`${name} against the program at ${ENDPOINT}: ${s.rows} cases, ${s.refusedByBuilder} refused by a builder before anything is built`);
  console.log(`  no transfer fee   ${line(s.plain)}`);
  console.log(`  transfer fee      ${line(s.fee)}`);
  for (const l of s.byLabel) console.log(`    ${l.label.padEnd(48)} ${String(l.cases).padStart(4)}  take ${String(l.bothTake).padStart(3)}  refuse ${String(l.bothRefuse).padStart(3)}  SDK only ${String(l.sdkBuildsProgramRefuses).padStart(3)}  program only ${String(l.sdkRefusesProgramTakes).padStart(3)}`);
  for (const d of s.disagreements.slice(0, 25)) console.log(`  disagree ${String(d.n).padStart(3)} x ${d.what}`);
  for (const d of s.storedDifferently) console.log(`  stored differently: #${d.n} ${d.label}: ${d.first}`);
  return s;
}

// ---------------------------------------------------------------- commands

const args = import.meta.main ? process.argv.slice(2) : [];
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

if (args[0] === "run") {
  const count = Number(args[1] && !args[1].startsWith("--") ? args[1] : 300);
  const out = flag("--out") ?? "data/config2.jsonl";
  if (!flag("--sdk")) throw new Error("--sdk <bundle from scripts/bundle-sdk.mjs>: the installed SDK has no createConfig2");
  const sdk: Sdk = await import(pathToFileURL(resolve(flag("--sdk")!)).href);
  const rpc = new Rpc(ENDPOINT, 400);
  // With signature checks off any funded system account can stand in as payer: a validator's identity. Untouched.
  let payer: PublicKey | null = null;
  const votes = await rpc.call<{ current: { nodePubkey: string; activatedStake: number }[] }>("getVoteAccounts", []);
  for (const v of votes.current.sort((a, b) => b.activatedStake - a.activatedStake).slice(0, 20)) {
    const a = (await rpc.call<{ value: { owner: string; lamports: number; data: [string, string] } | null }>("getAccountInfo", [v.nodePubkey, { encoding: "base64" }])).value;
    if (a && a.owner === "11111111111111111111111111111111" && a.data[0] === "" && a.lamports > 2e9) {
      payer = new PublicKey(v.nodePubkey);
      break;
    }
  }
  if (!payer) throw new Error("no funded system account found to stand in as payer");
  const usdc = (await rpc.call<{ value: unknown | null }>("getAccountInfo", [MINTS.USDC, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])).value !== null;
  const client = new sdk.DynamicBondingCurveClient(new Connection(ENDPOINT, "confirmed"), "confirmed");
  if (typeof client.partner.createConfig2 !== "function") throw new Error("this SDK has no createConfig2");
  const key = (r: { n: number; label: string }) => `${r.n} ${r.label}`;
  const done = existsSync(out) ? new Set(readRows(out).map(key)) : new Set<string>();
  for (const c of cases(count)) {
    if (done.has(key(c)) || (c.design.quote === "USDC" && !usdc)) continue;
    const row: Row = { n: c.n, kind: c.kind, label: c.label, transferFee: c.transferFee };
    const built = build(sdk, c.design);
    if (!built.params) row.builder = built.error;
    else {
      const params = built.params;
      c.after?.(params);
      const config = Keypair.generate().publicKey; // an address for the account to be; its key is thrown away
      const accounts = { config, feeClaimer: payer, leftoverReceiver: payer, quoteMint: new PublicKey(MINTS[c.design.quote]), payer };
      let tx: Transaction | null = null;
      try {
        tx = await client.partner.createConfig2({ ...accounts, ...params, transferFeeParameters: c.transferFee });
        row.sdk = null;
      } catch (e) {
        row.sdk = short(e);
        // the same instruction without the SDK's checks, to hear the program's answer
        try {
          tx = await client.partner.program.methods.createConfig2(params, c.transferFee).accountsPartial(accounts).transaction();
        } catch (e2) {
          row.program = `cannot be encoded (${short(e2)})`;
        }
      }
      if (tx) {
        tx.feePayer = payer;
        await new Promise((r) => setTimeout(r, Number(process.env.PACE_MS ?? 800))); // a public node: go slowly
        const run = await dryRun(ENDPOINT, tx, config);
        if (!run.ok || !run.data) row.program = run.error ?? "no account returned";
        else {
          row.program = null;
          const differs = storedDifferences(sdk, params, run.data);
          const stored = storedTransferFee(run.data);
          const want = c.transferFee ? { ...c.transferFee, flag: 1 } : { transferFeeBasisPoints: 0, withheldAuthority: 0, migratedTransferFeeAuthorityOption: 0, flag: 0 };
          if (JSON.stringify(stored) !== JSON.stringify(want)) differs.push(`transfer fee: sent ${JSON.stringify(want)}, program ${JSON.stringify(stored)}`);
          if (row.sdk === null) row.differs = differs;
          row.data = Buffer.from(run.data).toString("base64");
        }
      }
    }
    appendFileSync(out, JSON.stringify(row) + "\n");
    if (!row.builder && ((row.sdk === null) !== (row.program === null) || row.differs?.length)) console.log(`#${c.n} ${c.design.builder} ${c.label}: SDK ${row.sdk ?? "builds it"} | program ${row.program ?? "stores it"}${row.differs?.length ? ` | ${row.differs.slice(0, 2).join(" | ")}` : ""}`);
  }
  print(readRows(out), flag("--sdk")!);
} else if (args[0] === "report") {
  const file = flag("--file") ?? "data/config2.jsonl";
  const s = print(readRows(file), flag("--name") ?? file);
  if (flag("--json")) writeFileSync(flag("--json")!, JSON.stringify({ generatedAt: new Date().toISOString(), sdk: flag("--name") ?? file, endpoint: ENDPOINT, ...s }, null, 1));
} else if (import.meta.main) {
  console.log("usage: node src/config2.ts run [designs] --sdk data/sdk.mjs [--out data/config2.jsonl]\n       node src/config2.ts report [--file data/config2.jsonl] [--json web/data/config2.json] [--name ...]");
}
