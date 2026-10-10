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
  confKinds: int(conf?.kinds.length ?? 0),
  confMismatches: int(conf?.total.mismatches ?? 0),
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
  tapeDate: (lib?.generatedAt ?? new Date().toISOString()).slice(0, 10),
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
  `- **pump.fun, recorded ${figures.tapeDate}:** ${figures.soloGrads} of ${figures.grads} graduations were one party buying the curve in the launch slot.`,
  `- **Engine against chain:** ${figures.confSwaps} real swaps replayed across ${figures.confPools} pools and ${figures.confKinds} kinds of config, ${figures.confMismatches} mismatches.`,
  `- **Shelf:** ${figures.tapes} tapes: ${figures.dbcTapes} DBC pools read from the chain, ${figures.pumpTapes} pump.fun launches (${figures.pumpRejected} of ${figures.pumpConsidered} recorded were left out by the fit check or for being too short).`,
].join("\n");
// And the findings that carry figures.
const found = [
  `- **A filter in the SDK looks at the wrong field.** \`StateService.getPoolConfigsByOwner(owner)\` ("Fetch all pool configs owned by a wallet") filters \`PoolConfig\` accounts at byte offset 72. That is \`leftover_receiver\`; \`fee_claimer\` is at offset 40. On ${figures.date}, ${figures.splitConfigs} of ${figures.configs} configs on mainnet (${figures.splitShare}) had a fee claimer different from their leftover receiver, and the call does not return those for their fee claimer. Reproduced on mainnet: fee claimer \`7AdYv1gs9xhmg87Xyh84ryHrfht4khVvBLSbDqkMTwrm\` owns three configs and the call returns none; called with their leftover receiver it returns them. The fix is one number. (SDK 1.5.13.)`,
  `- **Slot-based fee schedules run faster than the Invent config says.** Its comments size them at 0.4 s a slot. Block times sampled 100,000 slots apart on ${figures.date} give ${figures.slotSeconds} s a slot, so a schedule written as "60 seconds" in slots lasts about 33. Designs made here count in seconds (timestamp activation).`,
  `- **The SDK (1.5.12 and later) no longer builds rate-limiter configs**, so the deck does not offer them for new designs. Configs that already use one still load and play: ${int(limiter.pools)} rate-limiter pools (${int(limiter.swaps)} swaps) are in the conformance run, without a mismatch.`,
].join("\n");
const readme = join(root, "README.md");
writeFileSync(
  readme,
  readFileSync(readme, "utf8")
    .replace(/<!-- figures:start -->[\s\S]*<!-- figures:end -->/, `<!-- figures:start -->\n${block}\n<!-- figures:end -->`)
    .replace(/<!-- found:start -->[\s\S]*<!-- found:end -->/, `<!-- found:start -->\n${found}\n<!-- found:end -->`),
);
console.log("site written to docs/", figures);
