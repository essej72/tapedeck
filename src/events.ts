// The DBC program's events, decoded from the IDL that ships with the SDK and nothing else, so a browser can read a
// transaction without Anchor. codec.ts decodes the same bytes through the SDK's Anchor coder; test/events.test.ts
// holds the two to the same answer on real transactions.
//
// Values come out as plain JSON: 64-bit and wider integers as decimal strings, keys as base58, field names in the
// camelCase Anchor gives them.

import { DynamicBondingCurveIdl } from "@meteora-ag/dynamic-bonding-curve-sdk";
import bs58 from "bs58";

type T = string | { defined: { name: string } } | { array: [T, number] } | { option: T } | { vec: T };
type Idl = {
  events: { name: string; discriminator: number[] }[];
  types: { name: string; type: { kind: string; fields?: { name: string; type: T }[] } }[];
};

const idl = DynamicBondingCurveIdl as unknown as Idl;
const STRUCTS = new Map(idl.types.filter((t) => t.type.kind === "struct").map((t) => [t.name, t.type.fields ?? []]));
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const EVENTS = idl.events.map((e) => ({ type: e.name, name: e.name[0].toLowerCase() + e.name.slice(1), discriminator: e.discriminator }));

// Anchor's emit_cpi! wraps every event in a self-CPI whose data starts with this fixed tag.
const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];

export type DecodedEvent = { name: string; data: Record<string, unknown> };

/** Decode the data of one inner instruction addressed to the DBC program; null when it is not a known event. */
export function decodeEvent(data: Uint8Array): DecodedEvent | null {
  if (data.length < 16 || EVENT_IX_TAG.some((b, i) => data[i] !== b)) return null;
  const event = EVENTS.find((e) => e.discriminator.every((b, i) => data[8 + i] === b));
  if (!event || !STRUCTS.has(event.type)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 16;
  const uint = (bytes: number): bigint => {
    let v = 0n;
    for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(data[at + i]);
    at += bytes;
    return v;
  };
  const read = (t: T): unknown => {
    if (typeof t === "string") {
      switch (t) {
        case "u8":
          return data[at++];
        case "bool":
          return data[at++] !== 0;
        case "u16":
          at += 2;
          return view.getUint16(at - 2, true);
        case "u32":
          at += 4;
          return view.getUint32(at - 4, true);
        case "u64":
          return uint(8).toString();
        case "i64":
          return BigInt.asIntN(64, uint(8)).toString();
        case "u128":
          return uint(16).toString();
        case "pubkey":
          at += 32;
          return bs58.encode(data.subarray(at - 32, at));
        case "string": {
          const n = view.getUint32(at, true);
          at += 4 + n;
          return new TextDecoder().decode(data.subarray(at - n, at));
        }
        default:
          throw new Error(`unsupported type ${t}`);
      }
    }
    if ("array" in t) return Array.from({ length: t.array[1] }, () => read(t.array[0]));
    if ("vec" in t) {
      const n = view.getUint32(at, true);
      at += 4;
      return Array.from({ length: n }, () => read(t.vec));
    }
    if ("option" in t) return data[at++] === 0 ? null : read(t.option);
    const fields = STRUCTS.get(t.defined.name);
    if (!fields) throw new Error(`unsupported type ${t.defined.name}`);
    return Object.fromEntries(fields.map((f) => [camel(f.name), read(f.type)]));
  };
  try {
    return { name: event.name, data: read({ defined: { name: event.type } }) as Record<string, unknown> };
  } catch {
    return null;
  }
}
