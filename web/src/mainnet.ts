// From Side B to mainnet. Two steps, the first needs no wallet:
//   1. ask the live program whether it takes the design (a simulation, nothing signed);
//   2. create the config account with the visitor's own wallet as payer and fee claimer.
// The page never holds a wallet key. The only key made here is the new account's own, which has to co-sign its
// creation and is thrown away afterwards.

import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { configTransaction, differences, dryRun } from "../../src/deploy.ts";
import type { DesignSpec } from "../../src/engine/design.ts";
import { $ } from "./util.ts";

const RPC = "https://solana-rpc.publicnode.com";
// For step 1 any funded address can stand in as payer, since nothing is signed: a large exchange wallet.
const STAND_IN = new PublicKey("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");

type Wallet = {
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signAndSendTransaction?(tx: Transaction): Promise<{ signature: string }>;
  signTransaction?(tx: Transaction): Promise<Transaction>;
};

function wallet(): Wallet | null {
  const w = window as unknown as { phantom?: { solana?: Wallet }; solflare?: Wallet; backpack?: Wallet; solana?: Wallet };
  return w.phantom?.solana ?? w.solflare ?? w.backpack ?? w.solana ?? null;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.result === undefined) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  return body.result;
}

const solOf = (lamports: number) => (lamports / 1e9).toFixed(4);
// Two signatures (the wallet's and the new account's) at 5,000 lamports each. A wallet may add a priority fee on top.
const NETWORK_FEE = 10_000;

/** `spec` returns the design on Side B, or null when Side B is a config that already exists on mainnet. */
export function mountMainnet(spec: () => DesignSpec | null, created: (address: string) => void): void {
  const status = $("mainnet-status");
  const connection = new Connection(RPC, "confirmed");
  const say = (text: string, bad = false) => {
    status.textContent = text;
    status.classList.toggle("error", bad);
  };

  $("btn-ask").onclick = async () => {
    const s = spec();
    if (!s) return say("Side B is already a config on mainnet. Launch on its address.");
    say("Asking the program…");
    try {
      const account = Keypair.generate().publicKey;
      const who = { payer: STAND_IN, feeClaimer: STAND_IN, leftoverReceiver: STAND_IN };
      const run = await dryRun(RPC, await configTransaction(connection, s, who, account), account);
      if (!run.ok || !run.data) return say(`The program refuses this config: ${run.error}.`, true);
      const diff = differences(s, run.data, who);
      say(diff.length ? `The program takes it but would store it differently from Side B: ${diff.slice(0, 2).join("; ")}.` : `The live program accepts this config, and what it would store is exactly what Side B is flying. The account costs ${solOf(run.lamports)} SOL in rent. Nothing was signed or sent.`, diff.length > 0);
    } catch (e) {
      say(`Could not ask: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  };

  $("btn-create").onclick = async () => {
    const s = spec();
    if (!s) return say("Side B is already a config on mainnet. Launch on its address.");
    const w = wallet();
    if (!w) return say("No Solana wallet found in this browser (Phantom, Solflare or Backpack). Step 1 works without one.", true);
    try {
      say("Waiting for the wallet…");
      const me = new PublicKey((await w.connect()).publicKey.toBase58());
      const account = Keypair.generate();
      const who = { payer: me, feeClaimer: me, leftoverReceiver: me };
      const tx = await configTransaction(connection, s, who, account.publicKey);
      tx.recentBlockhash = (await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
      // Rehearse with the real payer first: an empty wallet or a refusal shows up here, before the wallet asks.
      const run = await dryRun(RPC, tx, account.publicKey);
      if (!run.ok || !run.data) {
        // A wallet with no SOL does not exist on chain, and all the node says is "AccountNotFound". Find out what
        // the account costs from the stand-in and say how much is missing.
        const have = (await rpc<{ value: number }>("getBalance", [me.toBase58(), { commitment: "confirmed" }])).value;
        const standIn = { payer: STAND_IN, feeClaimer: STAND_IN, leftoverReceiver: STAND_IN };
        const cost = await dryRun(RPC, await configTransaction(connection, s, standIn, account.publicKey), account.publicKey);
        const need = cost.lamports + NETWORK_FEE;
        if (cost.ok && have < need) {
          const address = me.toBase58();
          return say(`Your wallet ${address.slice(0, 4)}…${address.slice(-4)} holds ${solOf(have)} SOL on mainnet. Creating this config takes ${solOf(need)} SOL: rent for one account plus the network fee. Top it up and press again. Nothing was sent.`, true);
        }
        return say(`The program would refuse it from this wallet: ${run.error}.`, true);
      }
      if (differences(s, run.data, who).length) return say("The program would store this differently from Side B, so nothing was sent.", true);
      tx.partialSign(account);
      say(`Approve in your wallet: one account, ${solOf(run.lamports)} SOL rent plus the network fee. You become its fee claimer.`);
      let signature: string;
      if (w.signAndSendTransaction) signature = (await w.signAndSendTransaction(tx)).signature;
      else if (w.signTransaction) signature = await rpc<string>("sendTransaction", [btoa(String.fromCharCode(...(await w.signTransaction(tx)).serialize())), { encoding: "base64" }]);
      else return say("This wallet cannot sign a transaction from a page.", true);
      const address = account.publicKey.toBase58();
      say(`Sent. Waiting for the network to confirm ${address}…`);
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = (await rpc<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>("getSignatureStatuses", [[signature]])).value[0];
        if (st?.err) return say(`The transaction failed on chain: ${JSON.stringify(st.err)}.`, true);
        if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
          say(`Created on mainnet: ${address}. Anyone can launch a pool on it; trading fees go to your wallet. Loading it back from the chain onto Side B…`);
          created(address);
          return;
        }
      }
      say(`Sent, but not confirmed after 90 seconds. Check ${address} in an explorer before trying again.`, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      say(/reject|denied|cancel/i.test(msg) ? "Cancelled in the wallet. Nothing was sent." : `Did not go through: ${msg}`, true);
    }
  };
}
