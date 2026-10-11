// "Load a DBC pool from the chain": fetch a pool's history in the browser, replay every swap against the events
// the program emitted, and hand the deck a tape whose Side A is the pool's own config.
//
// Everything here is public JSON-RPC from the viewer's browser. An endpoint the viewer types in is used as typed
// and never leaves the page.

import { configFromBytes, poolFromBytes } from "../../src/engine/bytes.ts";
import { replayFixture, type Verdict } from "../../src/engine/verify.ts";
import { decodeEvent } from "../../src/events.ts";
import { fromChain } from "../../src/flows/chaintape.ts";
import { fetchHistory } from "../../src/flows/history.ts";
import { pack, type PackedTape } from "../../src/flows/pack.ts";
import { discriminator } from "../../src/layout.ts";
import { Rpc } from "../../src/rpc.ts";
import { int } from "./util.ts";

const SOL = "So11111111111111111111111111111111111111112";
// Keyless endpoints that answer a browser. The first is fast but keeps about two days of history; the second
// has the archive and allows about one request a second.
const PUBLIC = [
  { url: "https://solana-rpc.publicnode.com", lanes: 4, gapMs: 130, name: "the fast public endpoint" },
  { url: "https://public.rpc.solanavibestation.com", lanes: 1, gapMs: 950, name: "the public archive endpoint (about one request a second)" },
];
const MAX_TX = 2000;

export type LoadedTape = { tape: PackedTape | null; verdict: Verdict; summary: string };

const bytes = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const startsWith = (data: Uint8Array, prefix: Uint8Array) => prefix.every((b, i) => data[i] === b);

export async function loadPoolFromChain(address: string, custom: string, say: (text: string) => void): Promise<LoadedTape> {
  const endpoints = custom ? [{ url: custom, lanes: 4, gapMs: 130, name: "your endpoint" }] : PUBLIC;
  let last = "no endpoint answered";
  for (const [i, ep] of endpoints.entries()) {
    const rpc = new Rpc(ep.url, 300);
    const account = async (key: string): Promise<string | null> => (await rpc.call<{ value: { data: [string, string] } | null }>("getAccountInfo", [key, { encoding: "base64" }])).value?.data[0] ?? null;
    try {
      say(`Reading the pool account from ${ep.name}…`);
      const poolData = await account(address);
      if (!poolData) throw new Error("there is no account at that address");
      const raw = bytes(poolData);
      if (startsWith(raw, discriminator("PoolConfig"))) throw new Error("that address is a config, not a pool: load it with the box under Side B config");
      if (!startsWith(raw, discriminator("VirtualPool"))) throw new Error("that account is not a DBC pool (paste the pool's address, not the token's mint)");
      const pool = poolFromBytes(raw);
      const configData = await account(pool.config);
      if (!configData) throw new Error("the pool's config account could not be read");
      const config = configFromBytes(bytes(configData));
      const history = await fetchHistory(address, { url: ep.url, decode: decodeEvent, lanes: ep.lanes, gapMs: ep.gapMs, maxTx: MAX_TX, onProgress: (done, total) => say(`Fetching transactions from ${ep.name}: ${int(done)} of ${int(total)}…`) });
      if (history.holes.length) {
        last = `this endpoint could not return ${int(history.holes.length)} of the pool's transactions with their events, so the history has holes`;
        if (i + 1 < endpoints.length) {
          say("That endpoint keeps some of the pool's transactions without their events. Trying the archive, which is slower…");
          continue;
        }
        throw new Error(`${last}. Put another archive RPC endpoint in the box and try again`);
      }
      const fixture = { pool: address, config: pool.config, configData, poolData, txs: history.txs, complete: history.complete };
      const verdict = replayFixture(fixture);
      if (verdict.skipped) {
        last = "the history this endpoint keeps does not reach the pool's creation";
        if (i + 1 < endpoints.length) {
          say("That endpoint no longer has the pool's first transactions. Trying the archive, which is slower…");
          continue;
        }
        throw new Error(`${last}. Put an archive RPC endpoint in the box and try again`);
      }
      const scope = history.complete ? `all ${int(verdict.swaps)} swaps` : `the first ${int(verdict.swaps)} swaps`;
      const proof = verdict.mismatches.length === 0 ? `${scope} replay against the chain to the lamport` : `${int(verdict.mismatches.length)} differences from the chain in ${scope}`;
      if (config.quoteMintAddress !== SOL) return { tape: null, verdict, summary: `Verified: ${proof}. The deck plays SOL-quoted pools and this one is quoted in another token, so it was checked but not loaded.` };
      const tape = fromChain(fixture);
      const packed = tape && pack(tape, config, undefined, 2);
      if (!packed || typeof packed === "string") return { tape: null, verdict, summary: `Verified: ${proof}. ${packed === "short" ? "It has too few orders to play." : "It could not be turned into a tape."}` };
      return { tape: { ...packed, config: { address: pool.config, bytes: configData }, exactSwaps: verdict.swaps, proof }, verdict, summary: `Loaded. ${proof[0].toUpperCase()}${proof.slice(1)}.` };
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      // A wrong address is wrong on every endpoint; only connection trouble is worth a second try elsewhere.
      if (/account|config, not a pool|not a DBC pool|archive RPC/.test(last) || i + 1 >= endpoints.length) throw new Error(last);
      say(`${ep.name[0].toUpperCase()}${ep.name.slice(1)} did not answer (${last}). Trying another…`);
    }
  }
  throw new Error(last);
}
