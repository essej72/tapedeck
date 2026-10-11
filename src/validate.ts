// Proof that the engine is the chain, from the command line: fetch a real pool's whole history, replay it
// (engine/verify.ts) and report every field of every swap that differs from what the program recorded.
//
//   node src/validate.ts <pool address> [...more]     # fetch history if missing, replay, report

import { poolFromBytes } from "./engine/bytes.ts";
import { replayFixture, type Fixture } from "./engine/verify.ts";
import { fetchPool, holesIn, isComplete, loadPool, openTapes } from "./flows/chain.ts";
import { Rpc } from "./rpc.ts";

export { replayFixture, type Fixture, type Verdict } from "./engine/verify.ts";

type AccountInfo = { value: { data: [string, string] } | null };

/** A pool's stored history (fetched if missing) with its own and its config's account, as they are now. */
export async function buildFixture(pool: string, opts: { refetch?: boolean; url?: string; maxTx?: number; gapMs?: number; keepRaw?: boolean } = {}): Promise<Fixture> {
  const db = openTapes();
  const rpc = new Rpc(opts.url, 400);
  const account = async (address: string) => {
    const r = await rpc.call<AccountInfo>("getAccountInfo", [address, { encoding: "base64" }]);
    if (!r.value) throw new Error(`no account ${address}`);
    return r.value.data[0];
  };
  let txs = loadPool(db, pool);
  if (opts.refetch || txs.length === 0) txs = await fetchPool(db, pool, { url: opts.url, maxTx: opts.maxTx, gapMs: opts.gapMs, keepRaw: opts.keepRaw });
  const poolData = await account(pool);
  const config = poolFromBytes(Buffer.from(poolData, "base64")).config;
  return { pool, config, configData: await account(config), poolData, txs, complete: isComplete(db, pool), holes: holesIn(db, pool) };
}

if (import.meta.main) {
  for (const pool of process.argv.slice(2)) {
    const v = replayFixture(await buildFixture(pool));
    console.log(`${pool}  ${v.skipped ?? `${v.swaps} swaps replayed, ${v.mismatches.length} mismatches`}`);
    for (const m of v.mismatches.slice(0, 12)) console.log("   " + m);
  }
}
