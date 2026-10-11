// Small shared pieces for the web deck: DOM helpers, number formats, data loading, canvas set-up.

import type { Order, Tape } from "../../src/engine/replay.ts";

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

export const sol = (x: number, digits?: number): string => {
  const a = Math.abs(x);
  const d = digits ?? (a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3);
  return x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};
export const signed = (x: number): string => (x > 0 ? "+" : x < 0 ? "−" : "") + sol(Math.abs(x));
export const pct = (x: number, digits = 1): string => `${(100 * x).toFixed(digits)}%`;
export const int = (x: number): string => Math.round(x).toLocaleString("en-US");
export const clock = (t: number): string => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
};
export const span = (seconds: number): string => (seconds < 90 ? `${Math.round(seconds)} s` : seconds < 5400 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`);

export type PackedTape = {
  id: string;
  source: string;
  kind: string;
  creator: number;
  wallets: number;
  graduated: boolean;
  seconds: number;
  launchSlotBuys: number;
  curveBuys: number;
  fit: [number, number];
  orders: [number, number, number][];
  createBuy: number;
  config?: { address: string; bytes: string };
  exactSwaps?: number;
};
export type Library = {
  slotSeconds: number;
  pumpfun: { considered: number; passed: number; tooShort: number; misfit: number; recordedFrom: string; recordedTo: string; kinds: Record<string, number> };
  dbc: { passed: number; kinds: Record<string, number>; swaps: number };
  tapes: PackedTape[];
};
export const bytesOf = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

export function unpack(p: PackedTape, slotSeconds: number): Tape {
  const orders: Order[] = p.orders.map(([slot, wallet, amount], i) =>
    amount > 0
      ? { t: slot * slotSeconds, slot, wallet, buy: true, quote: BigInt(amount), fraction: 0, inCreateTx: i === p.createBuy }
      : { t: slot * slotSeconds, slot, wallet, buy: false, quote: 0n, fraction: -amount / 1e6 },
  );
  return { id: p.id, source: p.source, creator: p.creator, wallets: p.wallets, orders, graduated: p.graduated, complete: true };
}

export async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Size a canvas to its CSS box at the device's pixel ratio; returns a context scaled to CSS pixels. */
export function fit(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
