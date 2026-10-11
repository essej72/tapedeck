// Would the program take every config the deck can design?
//
//   node src/dryrun.ts [random designs, default 120]
//
// Builds the create_config transaction for the deck's built-in designs and for random settings of its form, has a
// public node simulate each against the live program (nothing is signed or sent), and compares the config account
// the program would store with the config the deck derives and flies. Writes test/fixtures/designs.json: the designs
// with the account bytes the program returned, which the offline tests hold the deck to.

import { writeFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { configTransaction, differences, dryRun } from "./deploy.ts";
import { BUILT_IN, specOf, type Custom } from "./engine/presets.ts";
import { Rpc, RPC_URL } from "./rpc.ts";

// With signature checks off any funded address can stand in as payer; these are large exchange wallets. Untouched.
const PAYERS = ["5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS"];

// A small deterministic generator, so a run can be repeated.
let seed = 20261011;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const between = (lo: number, hi: number, step = 1) => Math.round((lo + rnd() * (hi - lo)) / step) * step;

/** Settings the deck's form accepts, over its whole range. */
function randomCustom(): Custom {
  const end = pick([0.25, 0.5, 1, 1.25, 2, 5, 10]);
  const start = pick([end, end, between(end, 99, 0.25), 50, 90, 99]);
  const cStart = pick([27.96, between(5, 200, 0.5), between(20, 60, 0.01)]);
  return {
    start: Math.max(start, end),
    end,
    secs: pick([0, 1, 5, 30, 60, 300, 3600, between(2, 7200)]),
    mode: pick([0, 1]),
    dyn: rnd() < 0.4,
    creator: pick([0, 0, 10, 24, 50, 100, between(0, 100)]),
    first: rnd() < 0.3,
    cStart,
    cEnd: cStart === 27.96 && rnd() < 0.4 ? 410.88 : Math.round(cStart * between(2, 60, 0.5) * 100) / 100,
    shape: pick(["cp", "cp", "flat", "steep"]),
    lock: pick([100, 100, 50, 10, 0, between(0, 100)]),
  };
}

const n = Number(process.argv[2] ?? 120);
const rpc = new Rpc(RPC_URL, 500);
let payer: PublicKey | null = null;
for (const a of PAYERS) {
  const acc = (await rpc.call<{ value: { owner: string; lamports: number; data: [string, string] } | null }>("getAccountInfo", [a, { encoding: "base64" }])).value;
  if (acc && acc.owner === SystemProgram.programId.toBase58() && acc.data[0] === "" && acc.lamports > 1e9) {
    payer = new PublicKey(a);
    break;
  }
}
if (!payer) throw new Error("no stand-in payer is a funded system account; edit PAYERS");
const who = { payer, feeClaimer: payer, leftoverReceiver: payer };
const connection = new Connection(RPC_URL, "confirmed");

const designs: { name: string; custom: Custom }[] = [...Object.entries(BUILT_IN).map(([name, d]) => ({ name, custom: d.custom })), ...Array.from({ length: n }, (_, i) => ({ name: `random ${i + 1}`, custom: randomCustom() }))];
const kept: { name: string; custom: Custom; data: string }[] = [];
const tally = { accepted: 0, same: 0, refusedByDeck: 0, refusedByProgram: 0, different: 0 };
const reasons = new Map<string, number>();
for (const d of designs) {
  const config = Keypair.generate().publicKey; // an address for the account to be; its key is thrown away
  let tx;
  try {
    tx = await configTransaction(connection, specOf(d.custom), who, config);
  } catch (e) {
    // The SDK's own validation refuses the design before anything is built: the deck shows the same message.
    tally.refusedByDeck++;
    const why = (e as Error).message.slice(0, 70);
    reasons.set(`deck: ${why}`, (reasons.get(`deck: ${why}`) ?? 0) + 1);
    continue;
  }
  await new Promise((r) => setTimeout(r, 450));
  const run = await dryRun(RPC_URL, tx, config);
  if (!run.ok || !run.data) {
    tally.refusedByProgram++;
    reasons.set(`program: ${run.error}`, (reasons.get(`program: ${run.error}`) ?? 0) + 1);
    console.log(`  ${d.name}: the program refuses (${run.error}) ${JSON.stringify(d.custom)}`);
    continue;
  }
  tally.accepted++;
  const diff = differences(specOf(d.custom), run.data, who);
  if (diff.length) {
    tally.different++;
    console.log(`  ${d.name}: stored config differs: ${diff.slice(0, 3).join(" | ")}`);
  } else {
    tally.same++;
    if (kept.length < 24) kept.push({ name: d.name, custom: d.custom, data: Buffer.from(run.data).toString("base64") });
  }
}
console.log(`${designs.length} designs: ${tally.accepted} accepted by the program, ${tally.same} of those stored exactly as the deck derives them, ${tally.different} stored differently; ${tally.refusedByDeck} refused by the SDK's validation before sending, ${tally.refusedByProgram} refused by the program`);
for (const [why, k] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${k} x ${why}`);
writeFileSync(new URL("../test/fixtures/designs.json", import.meta.url), JSON.stringify(kept));
console.log(`${kept.length} designs with the program's stored bytes -> test/fixtures/designs.json`);
