// Account and event decoding through the official SDK's Anchor coder, so the shapes here are the SDK's own types.

import { createDbcProgram, type PoolConfig, type VirtualPool } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection } from "@solana/web3.js";
import { RPC_URL } from "../rpc.ts";

// The coder never touches the network; the connection only satisfies the constructor.
const { program } = createDbcProgram(new Connection(RPC_URL));

export const decodeConfig = (data: Buffer): PoolConfig => program.coder.accounts.decode("poolConfig", data) as PoolConfig;
export const decodePool = (data: Buffer): VirtualPool => program.coder.accounts.decode("virtualPool", data) as VirtualPool;

export type DbcEvent = { name: string; data: Record<string, any> };

// Anchor's emit_cpi! wraps every event in a self-CPI whose data starts with this fixed tag.
const EVENT_IX_TAG = Buffer.from("e445a52e51cb9a1d", "hex");

/** Decode the data of one inner instruction addressed to the DBC program; null when it is not an event. */
export function decodeEventIx(data: Buffer): DbcEvent | null {
  if (data.length < 16 || !data.subarray(0, 8).equals(EVENT_IX_TAG)) return null;
  return program.coder.events.decode(data.subarray(8).toString("base64")) as DbcEvent | null;
}
