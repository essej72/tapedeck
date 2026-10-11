// Find pools that saw a kind of swap the conformance corpus lacks, by sampling the DBC program's recent
// transactions. Written to close one gap: no pool in the corpus has an exact-out swap.
//
//   node src/hunt.ts [transactions to sample] [swap mode: 0 exact-in, 1 partial fill, 2 exact-out]
//
// Prints the pools found and the count of swaps by mode. On 11 October 2026 a sample of 6,608 transactions
// held 6,120 exact-in swaps, 256 partial fills and no exact-out swaps.

import { decodeEvent } from "./events.ts";
import { signaturesOf, transactionOf } from "./flows/history.ts";
import { PROGRAM_ID } from "./layout.ts";
import { Rpc } from "./rpc.ts";

const URL = process.env.TX_RPC_URL ?? "https://solana-rpc.publicnode.com";
const want = Number(process.argv[2]) || 8000;
const mode = Number(process.argv[3] ?? 2);
const lanes = 4;

const sigs = (await signaturesOf(new Rpc(URL, 150), PROGRAM_ID, want)).filter((s) => !s.err).slice(-want);
console.log(`${sigs.length} recent DBC transactions to read`);
const found = new Map<string, number>();
const modes = [0, 0, 0];
let next = 0;
let read = 0;
await Promise.all(
  Array.from({ length: lanes }, async () => {
    const rpc = new Rpc(URL, 130 * lanes);
    while (next < sigs.length) {
      const tx = await transactionOf(rpc, sigs[next++].signature, decodeEvent).catch(() => null);
      if (++read % 1000 === 0) console.log(`${read} read; swap modes so far ${modes.join("/")}; pools with mode ${mode}: ${found.size}`);
      for (const e of tx?.events ?? []) {
        if (e.name !== "evtSwap2") continue;
        const d = e.data as { pool: string; swapParameters: { swapMode: number } };
        modes[d.swapParameters.swapMode]++;
        if (d.swapParameters.swapMode === mode) found.set(d.pool, (found.get(d.pool) ?? 0) + 1);
      }
    }
  }),
);
console.log(`swaps by mode (exact-in/partial/exact-out): ${modes.join("/")}`);
for (const [pool, n] of [...found].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`${pool} ${n}`);
