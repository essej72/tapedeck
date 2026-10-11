// The evidence page: the census, the conformance run and the tape library, as they stood when the site was built.

import { $, css, el, fit, int, pct, sol, span, type Library } from "./util.ts";

export type DesignRow = {
  hash: string;
  example: string;
  quote: string;
  name: string | null;
  suffix: { suffix: string; share: number } | null;
  claimers: number;
  configs: number;
  creators: number;
  pools: number;
  completed: number;
  fees: number;
  medianSecs: number | null;
  within10s: number | null;
  threshold: number;
  fee: string;
  feeInTokens: boolean;
  creatorFeePct: number;
  costCreator: number | null;
  costOperator: number | null;
  costCheapest: number | null;
  lpNow: number | null;
  lastTs: number;
};
export type Evidence = {
  totals: { generatedAt: string; configs: number; designs: number; pools: number; poolsUnderUnknownConfigs: number; completed: number; traded: number };
  headline: Record<"cheap" | "dear", { designs: number; pools: number; completed: number }>;
  lookalikes?: { designs: number; pools: number; completedShare: number };
  designs: DesignRow[];
};
/** `total.pools` and `total.swaps` count the pools that agree on every swap; `disagree` lists the ones that do not. */
/** src/migration.ts: completed pools followed across their migration. */
export type MigrationSummary = { migrated: number; agree: number; dammV2: number; dammV1: number; asModelled: number; dynamicFee: number };
/** src/afterwards.ts: the first swaps in each migrated DAMM v2 pool, replayed from the DBC accounts alone. */
export type AfterwardsSummary = { swaps: number; withSwaps: number; exactOut: number; replayed: number; agree: number };
/** src/dammsdk.ts: the same swaps, put to Meteora's DAMM v2 SDK. */
export type DammSdkSummary = { sdk: string; swaps: number; pools: number; agree: number };
export type Conformance = { generatedAt: string; total: { pools: number; swaps: number; older?: number; mismatches: number; finals: number; disagreeing?: number }; kinds: { kind: string; pools: number; swaps: number; mismatches: number }[]; disagree?: { pool: string; kind: string; swaps: number; first: string }[] };

/** A design has no name on chain. Say what can be said: a registered partner name, or how its mints present themselves. */
const label = (d: DesignRow): string => d.name ?? (d.suffix ? `mints ending “${d.suffix.suffix}” (${pct(d.suffix.share, 0)})` : `design ${d.hash.slice(0, 6)}`);

/** A raise in whole quote tokens; some designs set it to a few lamports so the first buy completes the curve. */
const raise = (d: DesignRow): string => `${d.threshold > 0 && d.threshold < 0.01 ? "under 0.01" : sol(d.threshold)} ${d.quote}`;

const X_MIN = 0.001;
const X_MAX = 2;

/** src/probe.ts: swaps simulated against the live program, because nobody has made them on mainnet. */
export type ProbeSummary = { generatedAt: string; simulations: number; pools: number; kinds: number; swaps: number; exactOut: number; refusals: number; vaults: number; timed?: number; disagreements: number };

type BuilderRun = { name: string; designs: number; refusedBySdk: number; refusedByProgram: number; stored: number; storedAsDerived: number; migrationCapOff: number; worstMigrationCapError: number };
/** src/builders.ts: random inputs through the SDK's curve builders, and what the live program did with the results. */
export type BuildersSummary = { generatedAt: string; installed: BuilderRun; other: BuilderRun };

export function mountEvidence(ev: Evidence | null, conf: Conformance | null, lib: Library | null, probe: ProbeSummary | null = null, builders: BuildersSummary | null = null, migration: MigrationSummary | null = null, afterwards: AfterwardsSummary | null = null, dammSdk: DammSdkSummary | null = null): void {
  if (ev) {
    const t = ev.totals;
    const covered = t.pools - t.poolsUnderUnknownConfigs;
    const { cheap, dear } = ev.headline;
    $("ev-lede").replaceChildren(
      `Every DBC config and pool on mainnet was read from program accounts on ${t.generatedAt.slice(0, 10)}: ${int(t.pools)} pools under ${int(t.configs)} configs. `,
      `Each config was then priced for one thing: what it costs its creator to buy the whole curve in the launch transaction, graduate, and sell out, with nobody else trading. `,
      el("b", {}, `Where that costs under 2% of the raise, ${pct(cheap.completed / cheap.pools, 0)} of ${int(cheap.pools)} pools completed their curve. Where it costs 10% or more, ${pct(dear.completed / dear.pools, 1)} of ${int(dear.pools)} did.`),
      ` A graduation says something about demand only where it was expensive to fake.`,
      ev.lookalikes?.pools ? ` Some of the cheap designs go further: ${int(ev.lookalikes.pools)} pools sit under designs whose mint addresses mostly end in “pump” or “bonk”, the vanity suffixes of other launchpads, and ${pct(ev.lookalikes.completedShare, 1)} of the pools under those designs completed.` : "",
      covered < t.pools ? ` (${int(covered)} pools are covered here; the rest sit under configs still being read.)` : "",
    );
    const canvas = $<HTMLCanvasElement>("scatter");
    const rows = ev.designs.filter((d) => d.costCheapest !== null);
    let hits: { x: number; y: number; r: number; d: DesignRow }[] = [];
    const draw = () => {
      const { ctx, w, h } = fit(canvas);
      const m = { l: 58, r: 14, t: 10, b: 46 };
      const pw = w - m.l - m.r;
      const ph = h - m.t - m.b;
      const dim = css("--glass-dim");
      const X = (c: number) => m.l + ((Math.log10(Math.min(X_MAX, Math.max(X_MIN, c))) - Math.log10(X_MIN)) / (Math.log10(X_MAX) - Math.log10(X_MIN))) * pw;
      const Y = (share: number) => m.t + (1 - share) * ph;
      ctx.clearRect(0, 0, w, h);
      ctx.font = `11px ${css("--mono")}`;
      ctx.strokeStyle = css("--glass-2");
      ctx.fillStyle = dim;
      ctx.lineWidth = 1;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (const s of [0, 0.25, 0.5, 0.75, 1]) {
        ctx.beginPath();
        ctx.moveTo(m.l, Y(s) + 0.5);
        ctx.lineTo(m.l + pw, Y(s) + 0.5);
        ctx.stroke();
        ctx.fillText(pct(s, 0), m.l - 6, Y(s));
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const c of [0.001, 0.01, 0.1, 1]) {
        ctx.beginPath();
        ctx.moveTo(X(c) + 0.5, m.t);
        ctx.lineTo(X(c) + 0.5, m.t + ph);
        ctx.stroke();
        ctx.fillText(pct(c, c < 0.01 ? 1 : 0), X(c), m.t + ph + 6);
      }
      ctx.fillText("cost of faking a graduation, share of the raise", m.l + pw / 2, m.t + ph + 26);
      ctx.save();
      ctx.translate(10, m.t + ph / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText("pools that completed their curve", 0, 0);
      ctx.restore();
      ctx.fillStyle = css("--glass-ink");
      ctx.textAlign = "left";
      ctx.fillText("nearly free to fake: nearly every pool “graduates”", X(0.0012), Y(0.9));
      ctx.textAlign = "right";
      ctx.fillText("costly to fake: a few percent do", X(1.6), Y(0.16));
      ctx.fillStyle = dim;
      ctx.textAlign = "center";
      hits = [];
      const biggest = Math.max(...rows.map((d) => d.pools));
      for (const d of [...rows].sort((a, b) => b.pools - a.pools)) {
        const x = X(d.costCheapest!);
        const y = Y(d.completed / d.pools);
        const r = Math.max(2, 26 * Math.sqrt(d.pools / biggest));
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = (d.lpNow ?? 0) >= 0.5 ? css("--side-a") : css("--side-b");
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        hits.push({ x, y, r, d });
      }
      ctx.globalAlpha = 1;
    };
    draw();
    window.addEventListener("resize", draw);
    const tip = $("scatter-tip");
    canvas.onpointermove = (e) => {
      const box = canvas.getBoundingClientRect();
      const px = e.clientX - box.left;
      const py = e.clientY - box.top;
      const hit = [...hits].reverse().find((p) => Math.hypot(p.x - px, p.y - py) <= Math.max(p.r, 6));
      if (!hit) {
        tip.hidden = true;
        return;
      }
      const d = hit.d;
      tip.replaceChildren(
        el("b", {}, label(d)),
        el("br"),
        `${int(d.pools)} pools, ${pct(d.completed / d.pools)} completed`,
        el("br"),
        `fake for ${pct(d.costCheapest!, 1)} of a ${raise(d)} raise`,
        el("br"),
        `fee ${d.fee}${d.feeInTokens ? ", taken in tokens" : ""}`,
      );
      tip.hidden = false;
      tip.style.left = `${Math.min(px + 14, box.width - 300)}px`;
      tip.style.top = `${py + 14}px`;
    };
    canvas.onpointerleave = () => (tip.hidden = true);
    $("scatter-caption").textContent = `One bubble per design with 100 or more pools (${int(rows.length)} designs); area is the number of pools. Amber: the launcher can withdraw most of the migrated liquidity. Teal: most of it is locked or belongs to someone else. Costs above 200% are drawn at the right edge.`;

    const top = [...ev.designs].sort((a, b) => b.pools - a.pools).slice(0, 24);
    $("design-table").replaceChildren(
      el("thead", {}, el("tr", {}, ...["Design", "Pools", "Completed", "Median time to complete", "Fake it as a creator", "As the config's owner"].map((x) => el("th", {}, x)))),
      el("tbody", {}, ...top.map((d) =>
        el("tr", {},
          el("td", {}, `${label(d)}: ${raise(d)} raise, fee ${d.fee}${d.feeInTokens ? " in tokens" : ""}, ${int(d.configs)} config${d.configs === 1 ? "" : "s"}`),
          el("td", {}, int(d.pools)),
          el("td", {}, pct(d.completed / d.pools)),
          el("td", {}, d.medianSecs === null ? "–" : span(d.medianSecs)),
          el("td", {}, d.costCreator === null ? "–" : pct(d.costCreator)),
          el("td", {}, d.costOperator === null ? "–" : pct(d.costOperator)),
        ),
      )),
    );
  } else $("ev-lede").textContent = "The census file is not part of this build. Run npm run census, then npm run build.";

  if (conf?.total?.pools) {
    const c = conf.total;
    const old = c.disagreeing ?? 0;
    $("conf-lede").textContent =
      `The engine replayed the full swap history of ${int(c.pools + old)} real pools, chosen to cover every combination of fee mode, fee token, activation type and quote token in use. Each swap was compared with the program's own event, field by field, to the last lamport: amount in, amount out, next price, trading fee, protocol fee, referral fee, reserve. ${int(c.pools)} pools agree on every one of their ${int(c.swaps)} swaps` +
      (c.older ? `, ${int(c.older)} of them from before August 2025, when the program recorded swaps with an older event. ` : ". ") +
      (old
        ? `The other ${int(old)} were traded under older builds of the program and differ exactly where the program has since changed: an exact-in buy could once run past the migration price, and the maximum fee was once 50%. They are counted here as mismatches, not left out.`
        : "Mismatches: 0.");
    $("conf-table").replaceChildren(
      el("thead", {}, el("tr", {}, ...["Kind of config", "Pools", "Swaps", "Mismatches"].map((x) => el("th", {}, x)))),
      el("tbody", {}, ...conf.kinds.map((k) => el("tr", {}, el("td", {}, k.kind), el("td", {}, int(k.pools)), el("td", {}, int(k.swaps)), el("td", {}, int(k.mismatches))))),
    );
  } else $("conf-lede").textContent = "The conformance run is not part of this build. Run node src/conformance.ts pick, run and report.";

  if (probe?.simulations) {
    $("probe-lede").textContent = `History can only check the swaps people have made, and nobody makes exact-out swaps on mainnet. So the deck's engine was also checked against the program itself: ${int(probe.simulations)} transactions were built for ${int(probe.pools)} open pools (${int(probe.kinds)} kinds of config) and simulated by a public RPC node against the live program, with nothing signed or sent. The program answered ${int(probe.swaps)} swaps, ${int(probe.exactOut)} of them exact-out, with and without a referral, from one token unit up to the last token on the curve, and refused ${int(probe.refusals)} (one token more than the curve holds, or a buy of one unit more than the curve takes). The engine gave the same answer every time: every field of every swap, the pool account left behind, and the same refusals. In ${int(probe.vaults)} of them the two vaults' balances were read too, and they moved by exactly what the pool's books say.${probe.timed ? ` ${int(probe.timed)} were asked while the pool's fee schedule was still running.` : ""} Disagreements: ${int(probe.disagreements)}.`;
  } else $("probe-block").hidden = true;

  if (migration?.migrated) {
    $("migration-lede").textContent = `The check does not stop where the curve does. ${int(migration.migrated)} of those pools have migrated (${int(migration.dammV2)} to DAMM v2, ${int(migration.dammV1)} to DAMM v1), and in ${migration.agree === migration.migrated ? "every one" : int(migration.agree)} the tokens that moved into the new pool's vaults and the price the pool opened at are what the engine says, to the unit. After that the deck trades in the new pool with DAMM v2's own arithmetic, whichever kind of pool the config produces: a flat or a dynamic fee, a fee schedule, a compounding pool.` + (afterwards?.swaps ? ` Their first swaps were replayed as well, from the DBC accounts alone: ${int(afterwards.swaps)} swaps in ${int(afterwards.withSwaps)} pools, ${int(afterwards.exactOut)} of them exact-out, with amounts, next price and fee as DAMM v2 recorded them in ${afterwards.agree === afterwards.replayed ? "every pool" : `${int(afterwards.agree)} of ${int(afterwards.replayed)} pools`}.` : "") + (dammSdk?.swaps ? ` Meteora's DAMM v2 SDK, asked the same ${int(dammSdk.swaps)} swaps from the pool as it stood before each, agrees with the program in ${dammSdk.agree === dammSdk.pools ? "every pool" : `${int(dammSdk.agree)} of ${int(dammSdk.pools)} pools`} too.` : "");
  } else $("migration-lede").hidden = true;

  if (builders?.installed.designs) {
    const a = builders.installed;
    const b = builders.other;
    $("builders-lede").textContent =
      `A launchpad does not write a config by hand: it calls one of the SDK's curve builders and sends what comes back. So the builders were put before the live program as well. ${int(a.designs)} random inputs went through all six of them and on through createConfig, and a public node simulated each transaction (${builders.generatedAt.slice(0, 10)}; nothing signed or sent). ` +
      `With ${a.name}, the program refused ${int(a.refusedByProgram)} of the ${int(a.refusedByProgram + a.stored)} configs the builders returned, each short on supply by less than one token because of one rounding, and ${int(a.migrationCapOff)} of the configs it stored migrate at up to ${(100 * a.worstMigrationCapError).toFixed(0)}% above the market cap that was asked for, because two builders drop the fraction of a percentage. ` +
      `With the ${b.name}, the program refused ${b.refusedByProgram === 0 ? "none" : int(b.refusedByProgram)} of ${int(b.refusedByProgram + b.stored)} and stored ${b.storedAsDerived === b.stored ? "every one" : int(b.storedAsDerived)} exactly as the SDK derives it. The README has the detail and the commands.`;
  } else $("builders-block").hidden = true;

  if (lib) {
    const pf = lib.pumpfun;
    const k = pf.kinds;
    const grads = (k["one-party buyout"] ?? 0) + (k["contested graduation"] ?? 0);
    const worst = Math.max(...lib.tapes.filter((t) => !t.config).map((t) => t.fit[1]), 0.0001);
    $("tape-lede").replaceChildren(
      `pump.fun: ${int(pf.considered)} launches were recorded wallet by wallet from pump.fun's public trade feed (${pf.recordedFrom === pf.recordedTo ? pf.recordedTo : `${pf.recordedFrom} to ${pf.recordedTo}`}). ${int(pf.tooShort)} had under 12 orders and are not worth playing. The rest are kept only if the engine reproduces them: flown through a DBC config equal to pump.fun's curve, each curve buy must return the recorded number of tokens. ${int(pf.passed)} passed and ${int(pf.misfit)} did not; on the worst tape on the shelf nine buys in ten are within ${pct(worst, 2)}. `,
      el("b", {}, grads ? `Of the ${int(grads)} graduations that passed, ${int(k["one-party buyout"] ?? 0)} were one-party buyouts: at least 90% of the curve bought inside the launch slot.` : ""),
      lib.dbc.passed ? ` Meteora DBC: ${int(lib.dbc.passed)} pools were recorded from the chain and kept only because their whole history, ${int(lib.dbc.swaps)} swaps, replays without a mismatch. Side A for those tapes is the pool's own config.` : "",
    );
  }
}

export const METHOD = `
<h1>How it works, and where it stops</h1>
<h2>Exact</h2>
<ul>
<li><b>Curve trades.</b> Prices and fees come from the quote functions of Meteora's own SDK. Around them the engine does what the on-chain program does and the SDK leaves out: refresh the volatility tracker before the quote, apply the result to reserves and fee buckets, update the tracker after, complete the curve at the threshold. The conformance run on the Evidence page holds it to the chain.</li>
<li><b>Decoding.</b> Account offsets and event layouts are derived from the IDL that ships with the SDK. The readers used in the browser are tested against the SDK's Anchor coder on real accounts and real events.</li>
<li><b>Designed configs.</b> Side B's settings go through the SDK's curve builders and validators, so a config that plays here is one <code>create_config</code> would accept. The rate limiter is not offered because the SDK no longer builds it.</li>
</ul>
<h2>Modelled</h2>
<ul>
<li><b>After migration.</b> The migrated pool starts with the exact migration amounts and trades as a full-range constant-product pool with the config's flat pool fee. DAMM v2's own fee scheduler and dynamic fee after migration are not applied.</li>
<li><b>Cost of faking a graduation.</b> The curve leg is exact. The exit assumes the same constant-product pool and that nobody else trades. Liquidity that vests is counted as not recovered.</li>
<li><b>Side A of a pump.fun tape.</b> It is pump.fun's curve rebuilt as a DBC config, checked against the recorded fills. pump.fun's AMM fee tiers are not modelled, so Side A after graduation is close to, not equal to, what happened. Side A of a DBC tape is the pool's own config, and its whole history has replayed against the chain without a mismatch.</li>
</ul>
<h2>What a replay says</h2>
<p>Every buyer spends the same amount at the same moment, and every seller sells the same share of what they hold by then. That answers one question: what would this exact flow have paid and received under this config. It does not predict behaviour. Under a launch fee of 50% nobody sane buys in the launch slot, so read Side B as a stress test: this is what the play on the tape would have cost its author. To see how you would have traded it, press REC.</p>
<p>The trade feed shows trades, not transfers. A wallet that sells tokens it never bought on the tape is merged with the wallet that most plausibly gave them to it, the largest idle holder at that moment. Bundles come out as the single trader they are; an occasional unrelated pair will be merged by mistake.</p>
<h2>Data</h2>
<ul>
<li><b>Census:</b> <code>getProgramAccounts</code> on the DBC program through the public mainnet RPC, no key, sliced by one byte so each response stays small.</li>
<li><b>Pool histories:</b> <code>getSignaturesForAddress</code> and <code>getTransaction</code>, events decoded with the SDK's coder. A pool you paste into the deck is read the same way from your browser, through keyless public endpoints or one you type in; nothing is sent anywhere else.</li>
<li><b>Tapes:</b> pump.fun's public trade feed, read only, about 18 requests a minute. Launches seen by a recorder running since 10 October 2026; a graduate is read within minutes of graduating.</li>
</ul>
<h2>Limits</h2>
<ul>
<li>The tapes cover days, not seasons, and one venue. They are a sample of how launches are traded now, not of how they will be.</li>
<li>Completion rates by design are confounded by who uses each design. The claim is narrow: where faking is nearly free, nearly everything completes, and that is not demand.</li>
<li>Paper trading here has no latency, no failed transactions and no priority fees. Real fills are worse.</li>
</ul>
<h2>Run it yourself</h2>
<p>Node 24, no API keys. <code>npm run census</code> reads the chain, <code>node src/validate.ts &lt;pool&gt;</code> replays any pool against its own history, <code>npm test</code> runs the fixtures, <code>npm run build</code> makes this site. Built with Claude Code.</p>
`;
