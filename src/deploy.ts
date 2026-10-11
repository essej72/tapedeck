// From the deck to mainnet: the create_config transaction for a design, a dry run of it against the live program,
// and a check that what the program would store is the config the deck has been flying.
//
// Nothing here holds a key. The transaction is built for whoever will pay (in the deck, the visitor's own wallet);
// the dry run is a simulateTransaction with signature checks off, so it needs no signature at all.
// No Node APIs: the deck uses this file as it is.

import { DynamicBondingCurveClient, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { type Connection, PublicKey, type Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { configFromBytes } from "./engine/bytes.ts";
import { deriveConfig, designParams, type DesignSpec } from "./engine/design.ts";

export const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export type Who = { payer: PublicKey; feeClaimer: PublicKey; leftoverReceiver: PublicKey };

/** The transaction that creates the account `config` from a design. Besides the payer, the new account signs it. */
export async function configTransaction(connection: Connection, spec: DesignSpec, who: Who, config: PublicKey): Promise<Transaction> {
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const tx = await client.partner.createConfig({ config, feeClaimer: who.feeClaimer, leftoverReceiver: who.leftoverReceiver, quoteMint: SOL_MINT, payer: who.payer, ...designParams(spec) });
  tx.feePayer = who.payer;
  return tx;
}

export type DryRun = {
  ok: boolean;
  /** The program's error name, or the node's reason, when it refused. */
  error: string | null;
  logs: string[];
  /** The config account as the program would leave it, and the rent it would hold. */
  data: Uint8Array | null;
  lamports: number;
};

type Simulated = { value: { err: unknown; logs: string[] | null; accounts: ({ data: [string, string]; lamports: number } | null)[] | null } };

/** Have a node run the transaction against the live program without signatures. Nothing is sent. */
export async function dryRun(rpcUrl: string, tx: Transaction, config: PublicKey): Promise<DryRun> {
  tx.recentBlockhash ??= bs58.encode(new Uint8Array(32).fill(1)); // replaced by the node
  const wire = btoa(String.fromCharCode(...tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [wire, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", encoding: "base64", accounts: { encoding: "base64", addresses: [config.toBase58()] } }] }),
  });
  const body = (await res.json()) as { result?: Simulated; error?: { message: string } };
  if (!body.result) return { ok: false, error: body.error?.message ?? `HTTP ${res.status}`, logs: [], data: null, lamports: 0 };
  const v = body.result.value;
  const logs = v.logs ?? [];
  if (v.err) {
    const named = logs.map((l) => /Error Code: (\w+)/.exec(l)?.[1]).filter(Boolean).pop();
    return { ok: false, error: named ?? JSON.stringify(v.err), logs, data: null, lamports: 0 };
  }
  const acc = v.accounts?.[0];
  return { ok: true, error: null, logs, data: acc ? Uint8Array.from(atob(acc.data[0]), (c) => c.charCodeAt(0)) : null, lamports: acc?.lamports ?? 0 };
}

/** Field by field: where the stored config differs from the one the deck derived from the design. Empty = same. */
export function differences(spec: DesignSpec, stored: Uint8Array, who?: Who): string[] {
  const out: string[] = [];
  const onChain = configFromBytes(stored);
  const walk = (mine: unknown, theirs: unknown, path: string) => {
    if (mine !== null && typeof mine === "object" && !("toArrayLike" in (mine as object))) {
      for (const [k, v] of Object.entries(mine as Record<string, unknown>)) walk(v, (theirs as Record<string, unknown> | undefined)?.[k], path ? `${path}.${k}` : k);
      return;
    }
    if (String(mine) !== String(theirs)) out.push(`${path}: deck ${String(mine)}, program ${String(theirs)}`);
  };
  walk(deriveConfig(designParams(spec)) as PoolConfig, onChain, "");
  if (onChain.quoteMintAddress !== SOL_MINT.toBase58()) out.push(`quote mint: ${onChain.quoteMintAddress}`);
  if (who && onChain.feeClaimerAddress !== who.feeClaimer.toBase58()) out.push(`fee claimer: ${onChain.feeClaimerAddress}`);
  return out;
}
