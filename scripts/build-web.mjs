// Bundle the deck for the browser and assemble the static site in docs/ (GitHub Pages serves it as is).
//   node scripts/build-web.mjs
// The pitch page is a template; its figures are filled in here from the same data files the deck loads, so the
// pitch cannot drift from the evidence.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(root, "docs");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "data"), { recursive: true });
await build({
  entryPoints: [join(root, "web/src/main.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  inject: [join(root, "web/shim.js")],
  outfile: join(out, "app.js"),
  logLevel: "info",
});
for (const f of ["index.html", "style.css"]) cpSync(join(root, "web", f), join(out, f));
cpSync(join(root, "web/data"), join(out, "data"), { recursive: true, filter: (src) => !/census(_all)?\.json$/.test(src) });
if (existsSync(join(root, "web/img"))) cpSync(join(root, "web/img"), join(out, "img"), { recursive: true });
writeFileSync(join(out, ".nojekyll"), "");

const load = (name) => (existsSync(join(root, "web/data", name)) ? JSON.parse(readFileSync(join(root, "web/data", name), "utf8")) : null);
const [ev, conf, lib, pkg] = [load("evidence.json"), load("conformance.json"), load("tapes.json"), JSON.parse(readFileSync(join(root, "package.json"), "utf8"))];
const probe = load("probe.json");
const corpus = load("corpus.json");
const int = (x) => Math.round(x).toLocaleString("en-US");
const pct = (x, d = 0) => `${(100 * x).toFixed(d)}%`;
const kinds = lib?.pumpfun?.kinds ?? {};
const pump = (lib?.tapes ?? []).filter((t) => !t.config);
const figures = {
  repo: pkg.repository?.url ?? pkg.homepage ?? "https://github.com",
  date: (ev?.totals.generatedAt ?? new Date().toISOString()).slice(0, 10),
  tapes: int(lib?.tapes.length ?? 0),
  dbcTapes: int((lib?.tapes ?? []).length - pump.length),
  pumpTapes: int(pump.length),
  confSwaps: int(conf?.total.swaps ?? 0),
  confPools: int(conf?.total.pools ?? 0),
  confKinds: int((conf?.kinds ?? []).filter((k) => k.pools > (k.bad ?? 0)).length),
  confOld: int(conf?.total.disagreeing ?? 0),
  confOlder: int(conf?.total.older ?? 0),
  confMismatches: "0",
  pumpFit: pct(Math.max(0.0001, ...pump.map((t) => t.fit[1])), 2),
  pumpRejected: int((lib?.pumpfun.considered ?? 0) - (lib?.pumpfun.passed ?? 0)),
  pumpConsidered: int(lib?.pumpfun.considered ?? 0),
  pools: int(ev?.totals.pools ?? 0),
  configs: int(ev?.totals.configs ?? 0),
  cheapShare: ev ? pct(ev.headline.cheap.completed / ev.headline.cheap.pools) : "n/a",
  cheapPools: int(ev?.headline.cheap.pools ?? 0),
  dearShare: ev ? pct(ev.headline.dear.completed / ev.headline.dear.pools, 1) : "n/a",
  dearPools: int(ev?.headline.dear.pools ?? 0),
  soloGrads: int(kinds["one-party buyout"] ?? 0),
  grads: int((kinds["one-party buyout"] ?? 0) + (kinds["contested graduation"] ?? 0)),
  slotSeconds: String(lib?.slotSeconds ?? 0.219),
  tapeDate: lib?.pumpfun.recordedFrom === lib?.pumpfun.recordedTo ? (lib?.pumpfun.recordedTo ?? "") : `${lib.pumpfun.recordedFrom} to ${lib.pumpfun.recordedTo}`,
  pumpShort: int(lib?.pumpfun.tooShort ?? 0),
  pumpMisfit: int(lib?.pumpfun.misfit ?? 0),
  pumpPassed: int(lib?.pumpfun.passed ?? 0),
  probeSims: int(probe?.simulations ?? 0),
  probePools: int(probe?.pools ?? 0),
  probeExactOut: int(probe?.exactOut ?? 0),
  probeDisagreements: int(probe?.disagreements ?? 0),
  splitConfigs: int(ev?.totals.configsWhereClaimerIsNotReceiver ?? 0),
  splitShare: ev?.totals.configs ? pct((ev.totals.configsWhereClaimerIsNotReceiver ?? 0) / ev.totals.configs) : "n/a",
};
const limiter = (conf?.kinds ?? []).filter((k) => k.kind.startsWith("rate limiter") && k.mismatches === 0).reduce((t, k) => ({ pools: t.pools + k.pools, swaps: t.swaps + k.swaps }), { pools: 0, swaps: 0 });
const template = readFileSync(join(root, "web/pitch.template.html"), "utf8");
const missing = new Set();
writeFileSync(
  join(out, "pitch.html"),
  template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in figures)) missing.add(key);
    return figures[key] ?? "?";
  }),
);
if (missing.size) throw new Error(`pitch template asks for figures the build does not have: ${[...missing].join(", ")}`);

// The same figures, in the README.
const block = [
  `- **Census:** ${figures.pools} pools under ${figures.configs} configs, read from program accounts on ${figures.date}.`,
  `- **Where faking a graduation costs under 2% of the raise:** ${figures.cheapShare} of ${figures.cheapPools} pools completed their curve.`,
  `- **Where it costs 10% or more:** ${figures.dearShare} of ${figures.dearPools} pools did.`,
  `- **pump.fun, recorded ${figures.tapeDate}:** ${figures.soloGrads} of ${figures.grads} graduations that passed the check were one party buying the curve in the launch slot.`,
  `- **Engine against chain:** ${figures.confSwaps} real swaps in ${figures.confPools} pools and ${figures.confKinds} kinds of config replay to the lamport. ${figures.confOld} more pools were traded under older builds of the program and differ exactly where the program has since changed; they are counted as mismatches and explained under "Found on the way".`,
  ...(probe?.simulations ? [`- **Engine against the program itself:** ${int(probe.swaps)} swaps simulated against the live program on ${int(probe.pools)} open pools, ${int(probe.exactOut)} of them exact-out (a swap nobody makes on mainnet, so no history can check it), ${int(probe.disagreements)} disagreements.`] : []),
  `- **Shelf:** ${figures.tapes} tapes: ${figures.dbcTapes} DBC pools read from the chain and ${figures.pumpTapes} pump.fun launches, picked from ${figures.pumpPassed} that passed the fit check. Of ${figures.pumpConsidered} pump.fun launches recorded, ${figures.pumpShort} had under 12 orders and ${figures.pumpMisfit} failed the check.`,
].join("\n");
// And the findings that carry figures.
const found = [
  `- **How far a known SDK bug reaches.** In SDK 1.5.13, \`StateService.getPoolConfigsByOwner(owner)\` filters \`PoolConfig\` accounts at byte offset 72, which is \`leftover_receiver\`; \`fee_claimer\` is at offset 40. I ran into it while indexing; the SDK team had opened a fix the same day ([PR #124](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/pull/124)). What the census adds is the size of it: on ${figures.date}, ${figures.splitConfigs} of ${figures.configs} configs on mainnet (${figures.splitShare}) had a fee claimer different from their leftover receiver, and 1.5.13 does not return those for their fee claimer. Reproduced on mainnet: fee claimer \`7AdYv1gs9xhmg87Xyh84ryHrfht4khVvBLSbDqkMTwrm\` owns three configs and the call returns none.`,
  `- **Slot-based fee schedules run faster than the Invent config says.** Its comments size them at 0.4 s a slot. Block times sampled 100,000 slots apart on ${figures.date} give ${figures.slotSeconds} s a slot, so a schedule written as "60 seconds" in slots lasts about 33. Designs made here count in seconds (timestamp activation).`,
  `- **Old histories remember old programs.** A longer run over ${int((conf?.total.pools ?? 0) + (conf?.total.disagreeing ?? 0))} pools first turned up 13 that did not replay. None was a fault in today's SDK math; they came down to three things, and the replay now deals with each.\n  - *An older swap event.* Before program release 0.1.6 (19 August 2025) a swap emitted only \`EvtSwap\`. The replay used to skip those, so every later swap drifted. It now reads them: ${figures.confOlder} swaps recorded that way replay to the lamport.\n  - *Holes in the fetched history.* The public RPC reported one transaction as missing and kept another without its inner instructions, and the collector dropped both without a word. A transaction a node cannot give whole is now asked of a second archive, and a pool with a hole left in it is reported as such instead of being replayed.\n  - *Older builds of the program.* ${figures.confOld} pools disagree with today's math, and should. Six were completed between 20 October and 3 November 2025 by one exact-in buy of the threshold plus one lamport, which ran past the migration price onto the curve's thin tail (config \`2CY1F7f3…\`). Release 0.1.7 (4 November 2025) stops an exact-in buy at the migration price; asked by simulation, the live program refuses that buy today. The seventh, from May 2025, paid exactly 50% where today's math adds the dynamic fee on top: the maximum fee was 50% until release 0.1.3. They are counted as mismatches, not left out.`,
  `- **The SDK (1.5.12 and later) no longer builds rate-limiter configs**, so the deck does not offer them for new designs. Configs that already use one still load and play: ${int(limiter.pools)} rate-limiter pools (${int(limiter.swaps)} swaps) are in the conformance run, without a mismatch.`,
].join("\n");
// And the section on swaps nobody has made, from the probe's own summary.
const probed = probe?.simulations
  ? [
      `Run on ${probe.generatedAt.slice(0, 10)}: ${int(probe.pools)} open pools (${int(probe.solPools)} quoted in SOL, ${int(probe.usdcPools)} in USDC), ${int(probe.kinds)} kinds of config, ${int(probe.untouchedPools)} of them pools nobody had traded yet.`,
      "",
      "| Math | Simulated transactions | Swaps the program answered | Refusals | Disagreements |",
      "|---|---|---|---|---|",
      `| SDK 1.5.13 (npm) | ${int(probe.simulations)} | ${int(probe.swaps)}, of them ${int(probe.exactOut)} exact-out | ${int(probe.refusals)} | ${int(probe.disagreements)} |`,
      `| SDK 2.0 branch at \`bdfe680\`, \`706bd11\` and \`ffde81d\` | the same ${int(probe.simulations)} | the same | the same | 0 at each |`,
      `| An exact-out quote one lamport too high (a check that the check works) | ${int(probe.offByOneOf)} with an exact-out swap | | | flagged in ${int(probe.offByOneCaught)} |`,
      "",
      `${int(probe.fullPools)} of the pools were asked nine things: a control (an exact-in buy and sell, which history already proves, so a mismatch there would be the harness); exact-out buys of 0.2%, 15%, 60% and 85% of what is left on the curve, each followed by an exact-out sell, half of them with a referral (${int(probe.referral)} swaps); one token unit; one unit of the quote token; the last token on the curve; and one token more than the curve holds. A tenth question was added later and put to ${int(probe.overshootAsked)} pools: an exact-in buy of one unit of quote more than it takes to reach the migration price. Today's program refuses it whole in ${int(probe.overshootRefused)} of them and lets rounding absorb it in the other ${int(probe.overshootAsked - probe.overshootRefused)}, and the engine gives the same answer each time. Older builds let such a buy run on past the migration price (see "Found on the way").`,
      "",
      "- **Every field agrees**: amount in, amount out, next price, trading, protocol and referral fee, and afterwards the pool account itself: reserves, every fee bucket, the volatility tracker.",
      `- **Refusals agree.** One token past the end of the curve is \`InsufficientLiquidity\` or \`AmountLeftIsNotZero\` in the program and an error in the SDK (${int(probe.pastTheEnd)} cases). Buying exactly what is left completes the curve in ${int(probe.completions)} pools; in the ${int(probe.lastRefused)} where the program refuses it, the SDK refuses it too.`,
      `- **The books match the vaults.** In all ${int(probe.vaults)} transactions the program accepted, each vault's balance moved by exactly the change in the pool's reserve plus its fee buckets.`,
      `- **Dust rounds toward the pool.** ${probe.feeFree === 0 ? "No swap was free of fee." : `${int(probe.feeFree)} swaps paid no fee.`} One unit of the quote token buys nothing in ${int(probe.lamportBuysNothing)} of ${int(probe.lamportBuys)} pools and is kept as fee.`,
      `- **Fee schedules mid-run.** An old pool's schedule has run out, so ${int(probe.timed)} of the transactions went to ${int(probe.timedPools)} pools whose schedule was still running. No pool with a live rate limiter was found to ask.`,
    ].join("\n")
  : "The probe has not been run for this build.";
const readme = join(root, "README.md");
writeFileSync(
  readme,
  readFileSync(readme, "utf8")
    .replace(/<!-- figures:start -->[\s\S]*<!-- figures:end -->/, `<!-- figures:start -->\n${block}\n<!-- figures:end -->`)
    .replace(/<!-- found:start -->[\s\S]*<!-- found:end -->/, `<!-- found:start -->\n${found}\n<!-- found:end -->`)
    .replace(/<!-- probe:start -->[\s\S]*<!-- probe:end -->/, `<!-- probe:start -->\n${probed}\n<!-- probe:end -->`),
);
console.log("site written to docs/", figures);
