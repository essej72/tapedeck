// Byte offsets of every field in the DBC program's zero-copy accounts, derived from the IDL that ships with the
// official SDK rather than typed by hand, so a program upgrade that moves a field moves these with it.

import { DynamicBondingCurveIdl } from "@meteora-ag/dynamic-bonding-curve-sdk";

type IdlType = string | { defined: { name: string } } | { array: [IdlType, number] };
type IdlField = { name: string; type: IdlType };
type Idl = {
  address: string;
  accounts: { name: string; discriminator: number[] }[];
  events: { name: string; discriminator: number[] }[];
  types: { name: string; type: { fields?: IdlField[] } }[];
};

const idl = DynamicBondingCurveIdl as unknown as Idl;
const TYPES = new Map(idl.types.map((t) => [t.name, t.type.fields ?? []]));
const PRIMITIVE: Record<string, number> = { u8: 1, bool: 1, u16: 2, u32: 4, u64: 8, i64: 8, u128: 16, pubkey: 32 };

export function sizeOf(t: IdlType): number {
  if (typeof t === "string") {
    const n = PRIMITIVE[t];
    if (!n) throw new Error(`unknown primitive ${t}`);
    return n;
  }
  if ("array" in t) return sizeOf(t.array[0]) * t.array[1];
  const fields = TYPES.get(t.defined.name);
  if (!fields) throw new Error(`unknown type ${t.defined.name}`);
  return fields.reduce((s, f) => s + sizeOf(f.type), 0);
}

export type Field = { offset: number; size: number; type: IdlType };

/** Flat map of dotted field path -> offset for an account, e.g. "pool_state.metrics.total_trading_quote_fee". */
export function layoutOf(account: string): { size: number; fields: Map<string, Field> } {
  const fields = new Map<string, Field>();
  const walk = (name: string, base: number, prefix: string): number => {
    let o = base;
    for (const f of TYPES.get(name) ?? []) {
      const size = sizeOf(f.type);
      fields.set(prefix + f.name, { offset: o, size, type: f.type });
      if (typeof f.type !== "string" && "defined" in f.type) walk(f.type.defined.name, o, `${prefix}${f.name}.`);
      o += size;
    }
    return o;
  };
  return { size: walk(account, 8, ""), fields };
}

export const PROGRAM_ID = idl.address;
export const discriminator = (account: string): Uint8Array => {
  const a = idl.accounts.find((x) => x.name === account);
  if (!a) throw new Error(`no account ${account} in IDL`);
  return Uint8Array.from(a.discriminator);
};
export const eventDiscriminator = (event: string): Uint8Array => {
  const e = idl.events.find((x) => x.name === event);
  if (!e) throw new Error(`no event ${event} in IDL`);
  return Uint8Array.from(e.discriminator);
};

export const CONFIG = layoutOf("PoolConfig");
export const POOL = layoutOf("VirtualPool");

export function off(l: { fields: Map<string, Field> }, path: string): number {
  const f = l.fields.get(path);
  if (!f) throw new Error(`no field ${path}`);
  return f.offset;
}
