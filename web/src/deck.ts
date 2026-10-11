// The deck: a tape on the shelf, two sides playing it, a config for Side B, and a stick to fly it yourself.

import { ActivationType, BaseFeeMode, getBaseFeeHandler, MigrationFeeOption, TradeDirection, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { walkAway } from "../../src/engine/buyout.ts";
import { configFromBytes } from "../../src/engine/bytes.ts";
import { design, flatFee, inventConfig, PUMP_CURVE, type DesignSpec } from "../../src/engine/design.ts";
import { COHORTS, cohortOf, Session, SLOT_SECONDS, type FillRecord, type Tape } from "../../src/engine/replay.ts";
import { loadPoolFromChain } from "./loadpool.ts";
import { $, bytesOf, clock, css, el, fit, int, pct, signed, sol, span, unpack, type PackedTape } from "./util.ts";

export type Preset = { hash: string; address: string; name: string | null; suffix: string | null; fee: string; threshold: number; pools: number; completed: number; bytes: string };
type Custom = { start: number; end: number; secs: number; mode: 0 | 1; dyn: boolean; creator: number; first: boolean; cStart: number; cEnd: number; shape: "cp" | "flat" | "steep"; lock: number };
type Mine = { t: number; buy: boolean; quote?: bigint; fraction?: number };
type Side = { label: string; config: PoolConfig; live: Session; full: FillRecord[]; fullGraduatedAt: number | null; mine: number };

const PUMP_START = 27.96;
const PUMP_END = 410.88;
const BUILT_IN: Record<string, { label: string; note: string; custom: Custom }> = {
  guard30: {
    label: "Guard: 50% settling to 1.25% over 30 s",
    note: "pump.fun's curve with a launch fee that starts at half the buy and decays. Nothing goes back to the creator.",
    custom: { start: 50, end: 1.25, secs: 30, mode: 1, dyn: false, creator: 0, first: false, cStart: PUMP_START, cEnd: PUMP_END, shape: "cp", lock: 100 },
  },
  guard300: {
    label: "Long guard: 90% settling to 1.25% over 5 min",
    note: "A slow descending clock: whoever buys first pays for the seat, and the price of the seat falls until someone takes it.",
    custom: { start: 90, end: 1.25, secs: 300, mode: 1, dyn: false, creator: 0, first: false, cStart: PUMP_START, cEnd: PUMP_END, shape: "cp", lock: 100 },
  },
  pump: {
    label: "pump.fun's curve, 1.25% flat (same as Side A)",
    note: "The curve the tape was recorded on, rebuilt as a DBC config.",
    custom: { start: 1.25, end: 1.25, secs: 0, mode: 1, dyn: false, creator: 24, first: false, cStart: PUMP_START, cEnd: PUMP_END, shape: "cp", lock: 100 },
  },
};
const YOU_CASH = 10;
const TAU = 2; // seconds: the time axis is linear below this and logarithmic above

function specOf(c: Custom): DesignSpec {
  // The schedule is counted in seconds (timestamp activation), so "30 s" stays 30 s whatever a slot lasts.
  const secs = Math.max(1, Math.round(c.secs));
  const periods = Math.min(100, secs);
  const scheduled = c.secs > 0 && c.start > c.end;
  const baseFee = scheduled
    ? { baseFeeMode: c.mode === 0 ? BaseFeeMode.FeeSchedulerLinear : BaseFeeMode.FeeSchedulerExponential, feeSchedulerParam: { startingFeeBps: Math.round(c.start * 100), endingFeeBps: Math.round(c.end * 100), numberOfPeriod: periods, totalDuration: periods * Math.max(1, Math.round(secs / periods)) } }
    : flatFee(Math.round(c.end * 100));
  const asPump = c.shape === "cp" && Math.abs(c.cStart - PUMP_START) < 0.01 && Math.abs(c.cEnd - PUMP_END) < 0.05;
  const weights = c.shape === "flat" ? Array.from({ length: 16 }, (_, i) => 1.45 ** (15 - i)) : c.shape === "steep" ? Array.from({ length: 16 }, (_, i) => 1.45 ** i) : undefined;
  const curve = asPump ? PUMP_CURVE : { initialMarketCap: c.cStart, migrationMarketCap: c.cEnd, liquidityWeights: weights };
  return { ...curve, baseFee: baseFee as DesignSpec["baseFee"], dynamicFee: c.dyn, creatorTradingFeePercentage: c.creator, enableFirstSwapWithMinFee: c.first, activationType: ActivationType.Timestamp, migrationFeeOption: MigrationFeeOption.FixedBps100, partnerLockedLiquidity: c.lock };
}

const pumpClone = (): PoolConfig => design(specOf(BUILT_IN.pump.custom));

/** The base fee a 1 SOL buy would pay `seconds` after launch, as a fraction. */
function feeAt(config: PoolConfig, seconds: number): number {
  const f = config.poolFees.baseFee;
  const point = new BN(config.activationType === 0 ? Math.round(seconds / SLOT_SECONDS) : Math.floor(seconds));
  try {
    return getBaseFeeHandler(f.cliffFeeNumerator, f.firstFactor, f.secondFactor, f.thirdFactor, f.baseFeeMode).getBaseFeeNumeratorFromIncludedFeeAmount(point, new BN(0), TradeDirection.QuoteToBase, new BN(1e9)).toNumber() / 1e9;
  } catch {
    return NaN;
  }
}

const supplyUnits = (config: PoolConfig): number => 10 ** (9 + (config.tokenDecimal ?? 6));
const mcap = (config: PoolConfig, price: number): number => (price * supplyUnits(config)) / 1e9;

export function mountDeck(lib: { tapes: PackedTape[]; slotSeconds: number }, presets: Preset[]): void {
  const canvas = $<HTMLCanvasElement>("chart");
  let tape!: Tape;
  let packed!: PackedTape;
  let blind = false;
  let rec = false;
  let filter: string | null = null;
  let T = 10;
  let u = 1;
  let playing = false;
  let monitor: "A" | "B" = "A";
  let mine: Mine[] = [];
  let custom: Custom = { ...BUILT_IN.guard30.custom };
  let loaded: { config: PoolConfig; label: string; note: string } | null = null;
  let A!: Side;
  let B!: Side;

  const toT = (x: number) => TAU * Math.sinh(x * Math.asinh(T / TAU));
  const toU = (t: number) => Math.min(1, Math.asinh(t / TAU) / Math.asinh(T / TAU));
  const you = () => tape.wallets;

  // ---- sessions ----
  const side = (label: string, config: PoolConfig): Side => {
    const whole = new Session(config, tape, { record: true }).runToEnd();
    return { label, config, live: new Session(config, tape, { record: true, extraWallets: 1 }), full: whole.fills, fullGraduatedAt: whole.graduatedAt, mine: 0 };
  };
  const advance = (s: Side, t: number) => {
    while (s.mine < mine.length && mine[s.mine].t <= t) {
      const m = mine[s.mine++];
      s.live.fly(you(), m.buy, { quote: m.quote, fraction: m.fraction }, m.t);
    }
    s.live.runTo(t);
  };
  const restart = (s: Side) => {
    s.live = new Session(s.config, tape, { record: true, extraWallets: 1 });
    s.mine = 0;
  };
  const seek = (next: number) => {
    const t = toT(next);
    if (next < u) [A, B].forEach(restart);
    u = next;
    [A, B].forEach((s) => advance(s, t));
    render();
  };

  // ---- Side B config ----
  const sideBConfig = (): { config: PoolConfig; label: string } => {
    if (loaded) return loaded;
    return { config: design(specOf(custom)), label: "Side B" };
  };
  const applySideB = () => {
    const err = $("config-error");
    try {
      const { config } = sideBConfig();
      B = side("Side B", config);
      err.hidden = true;
    } catch (e) {
      err.textContent = `The SDK rejects this config: ${e instanceof Error ? e.message : String(e)}`;
      err.hidden = false;
      return;
    }
    advance(B, toT(u));
    renderFake();
    render();
  };

  const fields: [keyof Custom, string][] = [["start", "f-start"], ["end", "f-end"], ["secs", "f-secs"], ["creator", "f-creator"], ["cStart", "c-start"], ["cEnd", "c-end"], ["lock", "c-lock"]];
  const fillForm = () => {
    for (const [k, id] of fields) $<HTMLInputElement>(id).value = String(custom[k]);
    $<HTMLSelectElement>("f-mode").value = String(custom.mode);
    $<HTMLSelectElement>("c-shape").value = custom.shape;
    $<HTMLInputElement>("f-dyn").checked = custom.dyn;
    $<HTMLInputElement>("f-first").checked = custom.first;
    $<HTMLFieldSetElement>("custom").disabled = loaded !== null;
    $<HTMLFieldSetElement>("custom-curve").disabled = loaded !== null;
  };
  const readForm = () => {
    for (const [k, id] of fields) {
      const v = Number($<HTMLInputElement>(id).value);
      if (Number.isFinite(v)) (custom[k] as number) = v;
    }
    custom.mode = Number($<HTMLSelectElement>("f-mode").value) as 0 | 1;
    custom.shape = $<HTMLSelectElement>("c-shape").value as Custom["shape"];
    custom.dyn = $<HTMLInputElement>("f-dyn").checked;
    custom.first = $<HTMLInputElement>("f-first").checked;
  };
  const presetSelect = $<HTMLSelectElement>("preset");
  const choosePreset = (key: string) => {
    const note = $("preset-note");
    if (key in BUILT_IN) {
      loaded = null;
      custom = { ...BUILT_IN[key].custom };
      note.textContent = BUILT_IN[key].note;
    } else if (key.startsWith("real:")) {
      const p = presets.find((x) => x.hash === key.slice(5));
      if (!p) return;
      loaded = { config: configFromBytes(bytesOf(p.bytes)), label: p.name ?? (p.suffix ? `the …${p.suffix} design` : `design ${p.hash.slice(0, 6)}`), note: "" };
      note.textContent = `A design live on mainnet: ${int(p.pools)} pools, ${pct(p.completed / p.pools)} completed. Config ${p.address.slice(0, 6)}… is one of them.`;
    } else if (key === "custom") {
      loaded = null;
      note.textContent = "Your own settings.";
    }
    fillForm();
    applySideB();
  };

  const renderFake = () => {
    const box = $("fake-cost");
    const note = $("fake-note");
    const c = B.config;
    const f = c.poolFees.baseFee;
    const wait = f.baseFeeMode === 2 ? 0 : f.firstFactor * f.secondFactor.toNumber();
    const asCreator = walkAway(c);
    const asOwner = walkAway(c, { ownsPartnerSide: true });
    const patient = walkAway(c, { wait });
    if (asCreator.spend === null) {
      box.textContent = "n/a";
      note.textContent = "One buy cannot complete this curve.";
      return;
    }
    box.replaceChildren(`${sol(asCreator.cost)} SOL`, el("small", {}, `${pct(asCreator.costShare)} of the raise, for a creator who buys the whole curve in the launch transaction and then sells out.`));
    const lines = [`If the same party owns the config: ${sol(asOwner.cost)} SOL.`];
    if (wait > 0 && patient.spend !== null) lines.push(`If they wait out the fee instead (${span(c.activationType === 0 ? wait * SLOT_SECONDS : wait)}): ${sol(patient.cost)} SOL, and anyone can buy ahead of them.`);
    lines.push("On pump.fun's own curve the same round trip costs about 19 SOL.");
    note.textContent = lines.join(" ");
  };

  // ---- tape ----
  const loadTape = (p: PackedTape, asBlind: boolean) => {
    packed = p;
    blind = asBlind;
    tape = unpack(p, lib.slotSeconds);
    T = Math.max(5, tape.orders[tape.orders.length - 1].t * 1.02);
    mine = [];
    // A DBC tape plays on the pool's own config; a pump.fun tape on pump.fun's curve rebuilt as a DBC config.
    A = side("Side A", p.config ? configFromBytes(bytesOf(p.config.bytes)) : pumpClone());
    try {
      B = side("Side B", sideBConfig().config);
    } catch {
      B = side("Side B", pumpClone());
    }
    u = blind || rec ? 0 : 1;
    [A, B].forEach((s) => advance(s, toT(u)));
    renderShelf();
    renderFake();
    render();
  };

  const renderShelf = () => {
    const kinds = [...new Set(lib.tapes.map((t) => t.kind))];
    $("kind-chips").replaceChildren(
      ...[null, ...kinds].map((k) => {
        const b = el("button", { class: "chip", type: "button", "aria-pressed": String(filter === k) }, k ?? "all");
        b.onclick = () => {
          filter = k;
          renderShelf();
        };
        return b;
      }),
    );
    const shown = lib.tapes.filter((t) => !filter || t.kind === filter);
    $("shelf-count").textContent = `${shown.length} of ${lib.tapes.length}`;
    $("spines").replaceChildren(
      ...shown.map((t) => {
        const current = t === packed;
        const hide = current && blind;
        const b = el(
          "button",
          { class: "spine", type: "button", "data-kind": t.kind, ...(hide ? { "data-blind": "" } : {}), ...(current ? { "aria-current": "true" } : {}) },
          el("i"),
          el("span", {}, el("b", {}, hide ? "unlabelled" : `${t.id.slice(0, 6)} ${t.config ? "· DBC" : ""}`), el("span", {}, hide ? "play it to find out" : `${t.kind} · ${int(t.orders.length)} orders`)),
          el("em", {}, hide ? "" : span(t.seconds)),
        );
        b.onclick = () => loadTape(t, false);
        return el("li", {}, b);
      }),
    );
  };

  // ---- drawing ----
  const draw = () => {
    const { ctx, w, h } = fit(canvas);
    const m = { l: 50, r: 10, t: 8, b: 22 };
    const pw = w - m.l - m.r;
    const ph = h - m.t - m.b;
    ctx.clearRect(0, 0, w, h);
    const colors = { A: css("--side-a"), B: css("--side-b"), you: css("--you"), dim: css("--glass-dim"), grid: css("--glass-2"), rec: css("--rec"), ink: css("--glass-ink") };
    const tNow = toT(u);
    const hideFuture = blind || rec;
    const series = (s: Side) => (hideFuture ? s.live.fills : s.full);
    // y range: both sides, log scale
    let lo = Infinity;
    let hi = 0;
    for (const s of [A, B]) {
      const start = mcap(s.config, s.live.peakPrice > 0 ? Number(s.config.sqrtStartPrice.toString()) ** 2 / 2 ** 128 : 0);
      lo = Math.min(lo, start);
      hi = Math.max(hi, start);
      for (const f of series(s)) {
        if (hideFuture && f.t > tNow) break;
        const v = mcap(s.config, f.price);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      for (const f of s.live.fills) {
        const v = mcap(s.config, f.price);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    lo = Math.log10(lo * 0.8);
    hi = Math.max(Math.log10(hi * 1.25), lo + 0.3);
    const X = (t: number) => m.l + toU(t) * pw;
    const Y = (v: number) => m.t + (1 - (Math.log10(v) - lo) / (hi - lo)) * ph;

    ctx.font = `11px ${css("--mono")}`;
    ctx.lineWidth = 1;
    ctx.strokeStyle = colors.grid;
    ctx.fillStyle = colors.dim;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (let d = Math.floor(lo); d <= Math.ceil(hi); d++) {
      for (const k of [1, 2, 5]) {
        const v = k * 10 ** d;
        const y = Y(v);
        if (y < m.t || y > m.t + ph) continue;
        ctx.beginPath();
        ctx.moveTo(m.l, y + 0.5);
        ctx.lineTo(m.l + pw, y + 0.5);
        ctx.stroke();
        ctx.fillText(v >= 1000 ? `${v / 1000}k` : String(v), m.l - 6, y);
      }
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    let labelled = -Infinity;
    for (const [t, label] of [[0, "launch"], [1, "1 s"], [5, "5 s"], [30, "30 s"], [120, "2 min"], [600, "10 min"], [3600, "1 h"], [14400, "4 h"]] as [number, string][]) {
      if (t > T) continue;
      const x = X(t);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, m.t);
      ctx.lineTo(x + 0.5, m.t + ph);
      ctx.stroke();
      const at = Math.max(m.l + 16, x);
      const half = ctx.measureText(label).width / 2;
      if (at - half < labelled + 8) continue; // no room next to the previous label
      ctx.fillText(label, at, m.t + ph + 6);
      labelled = at + half;
    }
    ctx.save();
    ctx.translate(11, m.t + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("market cap, SOL", 0, 0);
    ctx.restore();

    // price paths
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.l, m.t, pw, ph);
    ctx.clip();
    for (const [key, s] of [["A", A], ["B", B]] as const) {
      const fills = series(s);
      const start = mcap(s.config, Number(s.config.sqrtStartPrice.toString()) ** 2 / 2 ** 128);
      const path = (from: number, to: number, alpha: number) => {
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = colors[key];
        ctx.lineWidth = key === monitor ? 1.8 : 1.3;
        ctx.beginPath();
        let y = Y(start);
        let begun = false;
        for (const f of fills) {
          if (f.t > to) break;
          const x = X(f.t);
          const ny = Y(mcap(s.config, f.price));
          if (f.t >= from) {
            if (!begun) {
              ctx.moveTo(X(from), y);
              begun = true;
            }
            ctx.lineTo(x, y);
            ctx.lineTo(x, ny);
          }
          y = ny;
        }
        if (!begun) ctx.moveTo(X(from), y);
        ctx.lineTo(X(Math.min(to, T)), y);
        ctx.stroke();
      };
      path(0, tNow, 1);
      if (!hideFuture) path(tNow, T, 0.28);
      const grad = hideFuture ? s.live.graduatedAt : s.fullGraduatedAt;
      if (grad !== null && (!hideFuture || grad <= tNow)) {
        ctx.globalAlpha = 0.9;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(X(grad) + 0.5, m.t);
        ctx.lineTo(X(grad) + 0.5, m.t + ph);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = colors[key];
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        const right = X(grad) > m.l + pw - 90;
        ctx.textAlign = right ? "right" : "left";
        ctx.fillText(`${key} graduates`, X(grad) + (right ? -5 : 5), m.t + (key === "A" ? 3 : 17));
      }
    }
    // fills on the monitored side: who traded, how big
    const s = monitor === "A" ? A : B;
    const big = s.live.fills.length > 600 ? [...s.live.fills].sort((a, b) => b.quote - a.quote)[600].quote : 0;
    for (const f of s.live.fills) {
      if (f.quote < big && f.wallet !== you()) continue;
      const x = X(f.t);
      const y = Y(mcap(s.config, f.price));
      const r = Math.max(1.6, Math.min(13, Math.sqrt(f.quote) * 2.4));
      const first = s.live.ledger[f.wallet].first;
      const insider = f.wallet === tape.creator || (first !== null && first.slot <= 0);
      ctx.globalAlpha = f.wallet === you() ? 1 : 0.55;
      ctx.strokeStyle = ctx.fillStyle = f.wallet === you() ? colors.you : insider ? colors.rec : colors[monitor];
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (f.wallet === you()) {
        ctx.moveTo(x, y - 7);
        ctx.lineTo(x + 6, y);
        ctx.lineTo(x, y + 7);
        ctx.lineTo(x - 6, y);
        ctx.closePath();
      } else ctx.arc(x, y, r, 0, Math.PI * 2);
      if (f.buy) ctx.fill();
      else ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X(tNow) + 0.5, m.t);
    ctx.lineTo(X(tNow) + 0.5, m.t + ph);
    ctx.stroke();
    ctx.restore();
  };

  // ---- ledger and readouts ----
  const tally = (s: Side) => {
    const rows = [...COHORTS, "you"].map(() => ({ wallets: 0, in: 0, out: 0, tokens: 0 }));
    const n = tape.wallets + 1;
    for (let i = 0; i < n; i++) {
      const l = s.live.ledger[i];
      if (!l.first) continue;
      const r = rows[i === you() ? COHORTS.length : cohortOf(l.first, i === tape.creator)];
      r.wallets++;
      r.in += l.quoteIn;
      r.out += l.quoteOut;
      r.tokens += Number(s.live.tokens[i].toString());
    }
    return rows;
  };
  const renderLedger = () => {
    const a = tally(A);
    const b = tally(B);
    const head = el("thead", {},
      el("tr", {}, el("th", {}, ""), el("th", {}, ""), el("th", { colspan: "4", class: "grp ha" }, "Side A"), el("th", { colspan: "4", class: "grp hb" }, "Side B")),
      el("tr", {}, el("th", {}, "Who, by first buy"), el("th", {}, "Wallets"), ...["Paid in", "Took out", "Net cash", "Holds"].map((x, i) => el("th", i === 0 ? { class: "grp" } : {}, x)), ...["Paid in", "Took out", "Net cash", "Holds"].map((x, i) => el("th", i === 0 ? { class: "grp" } : {}, x))),
    );
    const cells = (r: (typeof a)[number], s: Side) => {
      const net = r.out - r.in;
      return [el("td", { class: "grp" }, sol(r.in)), el("td", {}, sol(r.out)), el("td", { class: net > 0.0005 ? "pos" : net < -0.0005 ? "neg" : "" }, signed(net)), el("td", {}, pct(r.tokens / supplyUnits(s.config)))];
    };
    const body = el("tbody");
    [...COHORTS, "you"].forEach((name, i) => {
      if (a[i].wallets + b[i].wallets === 0) return;
      body.append(el("tr", name === "you" ? { class: "you" } : {}, el("td", {}, name === "you" ? "You" : name[0].toUpperCase() + name.slice(1)), el("td", {}, int(Math.max(a[i].wallets, b[i].wallets))), ...cells(a[i], A), ...cells(b[i], B)));
    });
    $("ledger").replaceChildren(head, body);
    const split = (s: Side, cls: string) => {
      const f = s.live.fees;
      const curve = f.protocol + f.partner + f.creator + f.referral;
      return el("div", {}, el("span", { class: cls }, `${s.label}: `), el("b", {}, `${sol(curve)} SOL`), ` in curve fees (protocol ${sol(f.protocol)}, launchpad ${sol(f.partner)}, creator ${sol(f.creator)})`, f.pool > 0 ? `, then ${sol(f.pool)} to the migrated pool` : "");
    };
    $("fee-split").replaceChildren(split(A, "muted"), split(B, "muted"));
  };

  const renderReadouts = () => {
    const tNow = toT(u);
    const now = (s: Side, cls: string) => {
      const done = s.live.curve.complete;
      const raised = Number(s.live.curve.state.quoteReserve.toString()) / Number(s.config.migrationQuoteThreshold.toString());
      return el("div", {}, el("dt", {}, s.label), el("dd", { class: cls }, `${sol(mcap(s.config, s.live.price))} SOL · ${done ? `graduated at ${clock(s.live.graduatedAt ?? 0)}` : `${pct(raised, 0)} of the raise`}`));
    };
    const fa = feeAt(A.config, tNow);
    const fb = feeAt(B.config, tNow);
    $("readouts").replaceChildren(
      el("dl", { style: "display:contents" }, now(A, "ra"), now(B, "rb"), el("div", {}, el("dt", {}, "Fee on a buy right now"), el("dd", {}, el("span", { class: "ra" }, A.live.curve.complete ? "pool" : pct(fa, 2)), " · ", el("span", { class: "rb" }, B.live.curve.complete ? "pool" : pct(fb, 2))))),
    );
    $("counter-time").textContent = clock(tNow);
    $("counter-orders").textContent = `order ${int(A.live.cursor)} / ${int(tape.orders.length)}`;
    $<HTMLInputElement>("scrub").value = String(Math.round(u * 1000));
    const hide = blind;
    const proof = packed.proof ?? (packed.config ? `all ${int(packed.exactSwaps ?? 0)} swaps replay against the chain to the lamport` : `replay matches recorded fills within ${pct(Math.max(packed.fit[1], 0.0001), 2)}`);
    $("tape-title").replaceChildren(el("b", {}, hide ? "unlabelled tape" : `${packed.id.slice(0, 6)}…`), hide ? "" : ` · ${packed.source} · ${packed.kind} · ${int(packed.wallets)} traders · ${proof}`);
    $("legend").replaceChildren(el("span", { class: "la" }, `Side A: as recorded (${packed.config ? "the pool's own config" : "pump.fun's curve"})`), el("span", { class: "lb" }, `Side B: ${loaded?.label ?? "your config"}`), ...(mine.length ? [el("span", { class: "ly" }, "you")] : []), el("em", {}, "dots: filled buys, hollow sells, red for the creator and launch-slot wallets"));
  };

  const renderStick = () => {
    $("stick").hidden = !rec;
    $("btn-rec").setAttribute("aria-pressed", String(rec));
    if (!rec) return;
    const s = monitor === "A" ? A : B;
    const l = s.live.ledger[you()];
    const cash = YOU_CASH - l.quoteIn + l.quoteOut;
    const bag = Number(s.live.tokens[you()].toString());
    const value = s.live.heldValue(you());
    $("you-cash").textContent = `cash ${sol(cash)} SOL`;
    $("you-bag").textContent = `holding ${pct(bag / supplyUnits(s.config), 2)} of supply, ${sol(value)} SOL if sold now`;
    const pnl = cash + value - YOU_CASH;
    const p = $("you-pnl");
    p.textContent = `${signed(pnl)} SOL`;
    p.className = `num ${pnl > 0.0005 ? "pos" : pnl < -0.0005 ? "neg" : ""}`;
    document.querySelectorAll<HTMLButtonElement>("[data-buy]").forEach((b) => (b.disabled = Number(b.dataset.buy) > cash + 1e-9 || u >= 1));
    document.querySelectorAll<HTMLButtonElement>("[data-sell]").forEach((b) => (b.disabled = bag <= 0 || u >= 1));
    if (u >= 1 && mine.length) $("stick-note").textContent = `Tape over. You finished ${signed(pnl)} SOL on ${s.label}. The ledger shows how everyone else did on the same tape.`;
  };

  const render = () => {
    draw();
    renderReadouts();
    renderLedger();
    renderStick();
    const play = $("btn-play");
    play.textContent = playing ? "❚❚" : "▶";
    play.setAttribute("aria-label", playing ? "Pause" : "Play");
  };

  // ---- transport ----
  let last = 0;
  const tick = (now: number) => {
    if (!playing) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const speed = Number($<HTMLSelectElement>("speed").value);
    const next = Math.min(1, u + (dt * speed) / 45);
    seek(next);
    if (next >= 1) {
      playing = false;
      if (blind) {
        blind = false; // the tape is over: say what it was
        renderShelf();
      }
      render();
      return;
    }
    requestAnimationFrame(tick);
  };
  const play = (on: boolean) => {
    playing = on;
    if (on) {
      if (u >= 1) seek(0);
      last = performance.now();
      requestAnimationFrame(tick);
    }
    render();
  };
  $("btn-play").onclick = () => play(!playing);
  $("btn-rewind").onclick = () => {
    play(false);
    seek(0);
  };
  $("btn-end").onclick = () => {
    play(false);
    seek(1);
  };
  $<HTMLInputElement>("scrub").oninput = (e) => {
    // Read the slider first: stopping playback re-renders, and rendering writes the old position back to it.
    const wanted = Number((e.target as HTMLInputElement).value) / 1000;
    play(false);
    seek(wanted);
  };
  const scrubTo = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    seek(Math.max(0, Math.min(1, (e.clientX - r.left - 50) / (r.width - 60))));
  };
  canvas.onpointerdown = (e) => {
    if (rec) return; // no peeking ahead while flying
    play(false);
    canvas.setPointerCapture(e.pointerId);
    scrubTo(e);
    canvas.onpointermove = scrubTo;
  };
  canvas.onpointerup = () => (canvas.onpointermove = null);

  // ---- the stick ----
  $("btn-rec").onclick = () => {
    rec = !rec;
    play(false);
    mine = [];
    $("stick-note").textContent = "Your orders go onto both sides at the moment you press, after everything the tape had done by then. The rest of the tape then trades against the price you left behind.";
    [A, B].forEach(restart);
    u = rec ? 0 : 1;
    [A, B].forEach((s) => advance(s, toT(u)));
    render();
    if (rec) play(true);
  };
  const order = (m: Omit<Mine, "t">) => {
    const t = toT(u);
    mine.push({ ...m, t });
    [A, B].forEach((s) => advance(s, t));
    render();
  };
  document.querySelectorAll<HTMLButtonElement>("[data-buy]").forEach((b) => (b.onclick = () => order({ buy: true, quote: BigInt(Math.round(Number(b.dataset.buy) * 1e9)) })));
  document.querySelectorAll<HTMLButtonElement>("[data-sell]").forEach((b) => (b.onclick = () => order({ buy: false, fraction: Number(b.dataset.sell) })));
  $<HTMLSelectElement>("you-side").onchange = (e) => {
    monitor = (e.target as HTMLSelectElement).value as "A" | "B";
    render();
  };

  // ---- shelf and config wiring ----
  $("btn-random").onclick = () => {
    const pool = lib.tapes.filter((t) => t !== packed);
    loadTape(pool[Math.floor(Math.random() * pool.length)] ?? packed, true);
    if (!rec) $("btn-rec").click();
  };
  presetSelect.replaceChildren(
    ...Object.entries(BUILT_IN).map(([k, v]) => el("option", { value: k }, v.label)),
    el("option", { value: "custom" }, "Custom"),
    ...(presets.length ? [el("optgroup", { label: "Live on mainnet" }, ...presets.map((p) => el("option", { value: `real:${p.hash}` }, `${p.name ?? (p.suffix ? `…${p.suffix} mints` : p.hash.slice(0, 6))} · ${p.fee} · ${p.threshold} SOL · ${pct(p.completed / p.pools, 0)} completed`)))] : []),
  );
  presetSelect.onchange = () => choosePreset(presetSelect.value);
  for (const id of [...fields.map(([, id]) => id), "f-mode", "c-shape", "f-dyn", "f-first"]) {
    $(id).addEventListener("change", () => {
      readForm();
      loaded = null;
      presetSelect.value = "custom";
      $("preset-note").textContent = "Your own settings.";
      applySideB();
    });
  }
  $("btn-export").onclick = async () => {
    const status = $("export-status");
    const text = loaded
      ? JSON.stringify({ note: "This design is already on mainnet; launch on the existing config.", config: (presets.find((p) => `real:${p.hash}` === presetSelect.value) ?? { address: $<HTMLInputElement>("load-address").value }).address }, null, 2)
      : JSON.stringify(inventConfig(specOf(custom)), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = loaded ? "Copied the address of the mainnet config." : "Copied a dbc_config file for Meteora's Invent CLI: dry run on, devnet. Fill in the keypair, fee claimer and leftover receiver.";
    } catch {
      status.textContent = "Could not reach the clipboard here. inventConfig() in the repo writes the same file.";
    }
  };
  $("btn-load").onclick = async () => {
    const status = $("load-status");
    const address = $<HTMLInputElement>("load-address").value.trim();
    status.textContent = "Fetching…";
    try {
      // Keyless endpoints that answer a browser; the first that responds decides.
      let data: string | undefined;
      let problem = "no endpoint answered";
      for (const url of ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"]) {
        try {
          const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64" }] }) });
          const body = await res.json();
          if (body?.error) {
            problem = `the endpoint refused (${body.error.message})`;
            continue;
          }
          data = body?.result?.value?.data?.[0];
          problem = "no account at that address";
          break;
        } catch {
          problem = "the endpoint could not be reached from this page";
        }
      }
      if (!data) throw new Error(problem);
      const config = configFromBytes(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
      loaded = { config, label: `config ${address.slice(0, 6)}…`, note: "" };
      $("preset-note").textContent = `Loaded ${address.slice(0, 6)}… from mainnet.`;
      status.textContent = "Loaded.";
      fillForm();
      applySideB();
    } catch (e) {
      status.textContent = `Could not load it: ${e instanceof Error ? e.message : String(e)}. Check the address is a DBC PoolConfig account.`;
    }
  };
  $("btn-pool").onclick = async () => {
    const status = $("pool-status");
    const button = $<HTMLButtonElement>("btn-pool");
    const address = $<HTMLInputElement>("pool-address").value.trim();
    if (!address) {
      status.textContent = "Paste a DBC pool address first.";
      return;
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      status.textContent = "That is not a Solana address. Paste the pool's address: 32 to 44 letters and digits.";
      return;
    }
    button.disabled = true;
    try {
      const loaded = await loadPoolFromChain(address, $<HTMLInputElement>("pool-rpc").value.trim(), (text) => (status.textContent = text));
      status.textContent = loaded.summary;
      if (loaded.tape) {
        const at = lib.tapes.findIndex((t) => t.id === loaded.tape!.id);
        if (at >= 0) lib.tapes.splice(at, 1);
        lib.tapes.unshift(loaded.tape);
        filter = null;
        play(false);
        loadTape(loaded.tape, false);
      }
    } catch (e) {
      status.textContent = `Could not load it: ${e instanceof Error ? e.message : String(e)}.`;
    } finally {
      button.disabled = false;
    }
  };
  window.addEventListener("resize", draw);
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (e.code !== "Space" || ["INPUT", "SELECT", "BUTTON", "TEXTAREA", "SUMMARY"].includes(t.tagName) || $("view-deck").hidden) return;
    e.preventDefault();
    play(!playing);
  });

  // ---- open on a real tape, at rest, both sides played through ----
  presetSelect.value = "guard30";
  $("preset-note").textContent = BUILT_IN.guard30.note;
  fillForm();
  // The DBC tape with the most traders if there is one: a real pool, replayed exactly. Otherwise a contested pump.fun launch.
  const busiest = (xs: PackedTape[]) => [...xs].sort((a, b) => b.wallets - a.wallets)[0];
  const first = busiest(lib.tapes.filter((t) => t.config)) ?? busiest(lib.tapes.filter((t) => t.kind === "contested graduation")) ?? lib.tapes[0];
  loadTape(first, false);
}
