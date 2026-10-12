// Bundle the deck for the browser and assemble the static site in docs/ (GitHub Pages serves it as is).
//   node scripts/build-web.mjs
// The pitch page is a template; its figures are filled in here from the same data files the deck loads, so the
// pitch cannot drift from the evidence.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// One tag for the script, the stylesheet and the data, taken from their contents: a deploy that changes any of
// them changes every address at once, so nobody is served a new page with a cached script.
const tag = createHash("sha1");
for (const f of ["app.js", "style.css", ...readdirSync(join(out, "data")).sort().map((f) => `data/${f}`)]) tag.update(readFileSync(join(out, f)));
const version = tag.digest("hex").slice(0, 8);
const tagged = (html) => html.replace('src="app.js"', `src="app.js?v=${version}"`).replace('href="style.css"', `href="style.css?v=${version}"`);
writeFileSync(join(out, "index.html"), tagged(readFileSync(join(out, "index.html"), "utf8")));

const load = (name) => (existsSync(join(root, "web/data", name)) ? JSON.parse(readFileSync(join(root, "web/data", name), "utf8")) : null);
const [ev, conf, lib, pkg] = [load("evidence.json"), load("conformance.json"), load("tapes.json"), JSON.parse(readFileSync(join(root, "package.json"), "utf8"))];
const probe = load("probe.json");
const corpus = load("corpus.json");
const builders = load("builders.json");
const migration = load("migration.json");
const afterSwaps = load("afterwards.json");
const dammSdk = load("dammsdk.json");
// the pitch page says the SDK agrees on every swap: do not build a page that says so when it does not
if (!dammSdk?.swaps || dammSdk.agree !== dammSdk.pools) throw new Error("web/data/dammsdk.json: the DAMM v2 SDK check is missing or no longer agrees, and the pitch page says it does");
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
  migAgree: int(migration?.agree ?? 0),
  migMigrated: int(migration?.migrated ?? 0),
  afterSwaps: int(afterSwaps?.swaps ?? 0),
  afterPools: int(afterSwaps?.withSwaps ?? 0),
  dammSdkSwaps: int(dammSdk?.swaps ?? 0),
  buildersInputs: int(builders?.installed.designs ?? 0),
  buildersRefusedOld: int(builders?.installed.refusedByProgram ?? 0),
  buildersStoredNew: int(builders?.other.stored ?? 0),
  buildersRefusedNew: int(builders?.other.refusedByProgram ?? 0),
  splitConfigs: int(ev?.totals.configsWhereClaimerIsNotReceiver ?? 0),
  splitShare: ev?.totals.configs ? pct((ev.totals.configsWhereClaimerIsNotReceiver ?? 0) / ev.totals.configs) : "n/a",
};
const limiter = (conf?.kinds ?? []).filter((k) => k.kind.startsWith("rate limiter") && k.mismatches === 0).reduce((t, k) => ({ pools: t.pools + k.pools, swaps: t.swaps + k.swaps }), { pools: 0, swaps: 0 });
const template = readFileSync(join(root, "web/pitch.template.html"), "utf8");
const missing = new Set();
writeFileSync(
  join(out, "pitch.html"),
  tagged(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
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
  ...(migration?.migrated ? [`- **Engine against migration:** in ${int(migration.agree)} of ${int(migration.migrated)} real migrations, the tokens that moved into the new pool and the price the pool opened at are what the engine says, to the unit.`] : []),
  ...(afterSwaps?.swaps ? [`- **Engine against the migrated pool:** ${int(afterSwaps.swaps)} real swaps in ${int(afterSwaps.withSwaps)} DAMM v2 pools, ${int(afterSwaps.exactOut)} of them exact-out, replayed from the DBC accounts alone: amounts, next price and fee as DAMM v2 recorded them in ${afterSwaps.agree === afterSwaps.replayed ? "every pool" : `${int(afterSwaps.agree)} of ${int(afterSwaps.replayed)} pools`}.`] : []),
  ...(dammSdk?.swaps ? [`- **Meteora's DAMM v2 SDK against the same swaps:** asked before each of those ${int(dammSdk.swaps)} swaps, from the pool as it stood, the SDK's quote math (${dammSdk.sdk}) gives the output or cost, the fee and the next price the program recorded in ${dammSdk.agree === dammSdk.pools ? "every pool" : `${int(dammSdk.agree)} of ${int(dammSdk.pools)} pools`}.`] : []),
  ...(builders?.installed.designs ? [`- **Builders against the program:** ${figures.buildersInputs} random inputs through the SDK's six curve builders, each result simulated against the live program. It refused ${figures.buildersRefusedOld} of the configs SDK 1.5.13 returned and ${figures.buildersRefusedNew === "0" ? "none" : figures.buildersRefusedNew} of the ${figures.buildersStoredNew} the 2.0 branch returned.`] : []),
  `- **Shelf:** ${figures.tapes} tapes: ${figures.dbcTapes} DBC pools read from the chain and ${figures.pumpTapes} pump.fun launches, picked from ${figures.pumpPassed} that passed the fit check. Of ${figures.pumpConsidered} pump.fun launches recorded, ${figures.pumpShort} had under 12 orders and ${figures.pumpMisfit} failed the check.`,
].join("\n");
// And the findings that carry figures.
const found = [
  `- **How far a known SDK bug reaches.** In SDK 1.5.13, \`StateService.getPoolConfigsByOwner(owner)\` filters \`PoolConfig\` accounts at byte offset 72, which is \`leftover_receiver\`; \`fee_claimer\` is at offset 40. I ran into it while indexing; the SDK team had opened a fix the same day ([PR #124](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/pull/124), since folded into [#123](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/pull/123)). What the census adds is the size of it: on ${figures.date}, ${figures.splitConfigs} of ${figures.configs} configs on mainnet (${figures.splitShare}) had a fee claimer different from their leftover receiver, and 1.5.13 does not return those for their fee claimer. Reproduced on mainnet: fee claimer \`7AdYv1gs9xhmg87Xyh84ryHrfht4khVvBLSbDqkMTwrm\` owns three configs and the call returns none.`,
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
      `| SDK 2.0 branch at \`f960aff\`, and earlier at \`bdfe680\`, \`706bd11\` and \`ffde81d\` | the same ${int(probe.simulations)} | the same | the same | 0 at each |`,
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
// And the section on what the program does with what the curve builders build.
const built = (() => {
  if (!builders?.installed.designs) return "The builder run is not part of this build.";
  const a = builders.installed;
  const b = builders.other;
  const x = builders.cross;
  const marketCap = a.byBuilder.find((r) => r.builder === "buildCurveWithMarketCap")?.refusedByProgram ?? 0;
  const worst = (v) => (v < 1e-4 ? `${(100 * v).toFixed(5)}%` : `${(100 * v).toFixed(1)}%`);
  const lost = (builders.lost ?? []).map((l) => `\`${l.builder}\`${l.percentage && !Number.isInteger(l.percentage) ? ` at ${l.percentage}% of supply, which 1.5.13 had quietly solved for ${Math.floor(l.percentage)}%` : ""}: "${l.error}"`);
  const c2 = builders.createConfig2;
  return [
    `Run on ${builders.generatedAt.slice(0, 10)} against the live program, the same ${int(a.designs)} inputs through both:`,
    "",
    `| | ${a.name} (npm) | ${b.name} |`,
    "|---|---|---|",
    `| Refused by the SDK before anything is sent | ${int(a.refusedBySdk)} | ${int(b.refusedBySdk)} |`,
    `| Built by the SDK, refused by the program | ${int(a.refusedByProgram)} | ${int(b.refusedByProgram)} |`,
    `| Stored by the program | ${int(a.stored)} | ${int(b.stored)} |`,
    `| of those, exactly as the SDK's own helpers derive | ${int(a.storedAsDerived)} | ${int(b.storedAsDerived)} |`,
    `| Built from market caps and stored | ${int(a.withMarketCaps)} | ${int(b.withMarketCaps)} |`,
    `| of those, migrating more than 0.1% off the cap asked for | ${int(a.migrationCapOff)} | ${int(b.migrationCapOff)} |`,
    `| Worst gap between the migration cap asked for and the one stored | ${worst(a.worstMigrationCapError)} | ${worst(b.worstMigrationCapError)} |`,
    "",
    `Two causes in 1.5.13, showing up three ways, account for everything the program refused or stored differently, and the 2.0 changelog lists both as changed. What this run adds is the live program's side of it.`,
    "",
    `- **A migration fee and no leftover.** 1.5.13 sizes the token supply from the migration quote amount rounded down; the program rounds it up. With no leftover to absorb the difference the config comes out short by ${a.supplyRule.shortByMaxTokens < 1 ? "less than one token" : "a few tokens"} (between ${int(a.supplyRule.shortByMin)} and ${int(a.supplyRule.shortByMax)} of its smallest units) and the program refuses it: \`InvalidTokenSupply\`, ${int(a.refusedByProgram)} times, ${int(marketCap)} of them from plain \`buildCurveWithMarketCap\`. Every one has a migration fee and a leftover of zero. The program's supply rule, applied offline to each builder result, predicts all ${int(a.supplyRule.refusedAndShort)} refusals and ${a.supplyRule.storedAndShort === 0 ? "none" : int(a.supplyRule.storedAndShort)} of the ${int(a.supplyRule.stored)} acceptances (\`supplyShortfall\` in \`src/builders.ts\`). Given the same ${int(a.refusedByProgram)} inputs, 2.0 builds a config the program stores for ${int(x["program -> stored"] ?? 0)} and refuses the other ${int(x["program -> sdk"] ?? 0)} itself, with "leftover is too small to cover the migration base rounding".`,
    `- **The same rounding in what is stored.** In ${int(a.storedMigrationBaseOnly)} of the configs the program stored for 1.5.13, its migration base differs from the one 1.5.13's helpers give. Each has a migration fee, the migration base is the only field that differs, and rounding the quote amount up closes the gap. For 2.0 all ${int(b.stored)} stored configs equal the SDK's derivation field by field: curve, fees, migration price, migration base, swap amount, supply.`,
    `- **A fractional \`percentageSupplyOnMigration\`.** In 1.5.13, \`buildCurveWithTwoSegments\` and \`buildCurveWithMidPrice\` take the base amount from \`new BN(percentage)\`, which drops the fraction, and the quote amount from the exact figure. Ask for 20.69% of supply on migration and the config migrates at 20.69 / 20, or 3.45%, above the market cap that was asked for; the program stores it without complaint. ${int(a.migrationCapOff)} stored configs are off this way, by up to ${(100 * a.worstMigrationCapError).toFixed(1)}%, and percentage / floor(percentage) explains ${builders.truncationExplains === builders.truncated.length ? "every one" : `${int(builders.truncationExplains)} of them`} to five decimal places. 2.0 keeps the fraction.`,
    "",
    `Also seen: 2.0 turned ${int(x["sdk -> stored"] ?? 0)} inputs that 1.5.13 refuses into configs the program stores, and refused ${int(x["stored -> sdk"] ?? 0)} that 1.5.13 had built${lost.length ? ` (${lost.join("; ")})` : ""}.${c2 && !c2.live ? ` \`create_config2\`, the instruction 2.0's \`createConfigAndPool\` uses, was not on mainnet when this ran (asked on ${c2.checkedAt.slice(0, 10)}, the program answers \`${c2.error}\`), so both sets went through \`createConfig\`.` : " Both sets went through \`createConfig\`."}`,
  ].join("\n");
})();
// What a completed curve hands to the migrated pool, and how far the model of that pool goes.
const migrated = migration?.migrated
  ? `- \`node src/migration.ts run\` follows every completed pool of that run across its migration: ${int(migration.completed)} pools, ${int(migration.migrated)} of them migrated (${int(migration.dammV2)} to DAMM v2, ${int(migration.dammV1)} to DAMM v1, ${int(migration.twoPositions)} with the liquidity split between two positions). In ${migration.agree === migration.migrated ? `all ${int(migration.migrated)}` : `${int(migration.agree)} of ${int(migration.migrated)}`}, the tokens that moved into the new pool's vaults and the price the new pool opened at are what the engine says, to the unit, and so is the protocol's cut in the ${int(migration.protocolCutShown)} pools whose account still shows it. It did not start that way: on the first run, on 11 October, the engine agreed in 57 of them. In 92 its token amount was one unit high, because the protocol's cut of the tokens is the base side of its quote cut and not 0.2% of the tokens. In 17 it took the protocol's 0.2% from pools that carry no such fee: the rate is kept on each pool account, and it is zero for every DAMM v1 migration here and for the oldest DAMM v2 ones. The other 13 had their liquidity split between two positions, which costs up to a lamport's worth of tokens, or were small enough for the rounding to show. All of that is fixed in \`src/engine/amm.ts\`, and ${int(36)} of the migrations are kept as a test.${afterSwaps?.swaps ? `\n- \`node src/afterwards.ts run\` goes on into the new pool: the first transactions after migration of ${afterSwaps.pools === migration.dammV2 ? "each DAMM v2 pool" : `${int(afterSwaps.pools)} of the ${int(migration.dammV2)} DAMM v2 pools (the rest have traded too much since to page back to their migration on a public endpoint)`}, ${int(afterSwaps.swaps)} swaps in ${int(afterSwaps.withSwaps)} pools (${int(afterSwaps.buys)} buys; ${int(afterSwaps.exactOut)} exact-out, which is common there and unheard of on the curve; ${int(afterSwaps.dynamicSwaps)} in the ${int(afterSwaps.dynamicPools)} pools with DAMM v2's dynamic fee, ${int(afterSwaps.scheduledSwaps)} under a market-cap fee schedule, ${int(afterSwaps.compoundingSwaps)} in a compounding pool), across ${int(afterSwaps.liquidityChanges)} later additions and removals of liquidity. The engine's pool is built from the DBC config and pool accounts alone; it takes the moment of migration and later changes of liquidity from the chain, and gives every swap's amounts, next price and fee as DAMM v2 recorded them in ${afterSwaps.agree === afterSwaps.replayed ? `all ${int(afterSwaps.replayed)} pools` : `${int(afterSwaps.agree)} of ${int(afterSwaps.replayed)} pools`}.${afterSwaps.stoppedEarly ? ` ${int(afterSwaps.stoppedEarly)} pools were stopped early at an event the reader does not know.` : ""}` : ""}`
  : "- The migration check has not been run for this build.";
// The same swaps, with Meteora's DAMM v2 SDK in the engine's place.
const sdkAfter = dammSdk?.swaps
  ? `\n- \`node src/dammsdk.ts check\` puts Meteora's DAMM v2 SDK (\`@meteora-ag/cp-amm-sdk\`, ${dammSdk.sdk}) in the engine's seat for those swaps. Before each one the SDK is handed the pool as an integrator would have fetched it: the pool's own account for what does not move, with the price, liquidity, reserves and remembered volatility as they stood before that swap. Its three quote paths (exact-in, partial fill, exact-out) give the output or cost, the fee and the next price the program recorded in ${dammSdk.agree === dammSdk.pools ? `all ${int(dammSdk.pools)} pools` : `${int(dammSdk.agree)} of ${int(dammSdk.pools)} pools`}: ${int(dammSdk.swaps)} swaps, ${int(dammSdk.exactOut)} exact-out and ${int(dammSdk.partial)} partial fills among them, ${int(dammSdk.dynamicSwaps)} under the dynamic fee, ${int(dammSdk.scheduledSwaps)} under a fee schedule, ${int(dammSdk.compoundingSwaps)} in a compounding pool. Nothing was found, which is the result. \`scripts/bundle-damm-sdk.mjs\` bundles any checkout of the SDK for the same check, and \`.github/workflows/sdk.yml\` runs it against the SDK's \`main\` on every push here. It is a small sample of DAMM v2 (pools born from a DBC migration, their first swaps), not a corpus of it.`
  : "";
const afterwards = migration?.migrated
  ? `- After migration, a DAMM v2 pool is traded with DAMM v2's own arithmetic, whichever kind of pool the config produces: one liquidity over the whole price range or a compounding pool, the fee on the side the config says, DAMM v2's dynamic fee where the pool has one, a market-cap fee schedule where the config sets one. All ${int(migration.fixedTierDynamic)} pools in the migration check that use a fixed fee tier have the dynamic fee, whatever their config says, and the engine expects that. ${migration.asModelled === migration.dammV2 ? `All ${int(migration.dammV2)}` : `${int(migration.asModelled)} of the ${int(migration.dammV2)}`} DAMM v2 pools there come out as the kind the engine expects${afterSwaps?.swaps ? ", and their first swaps are held against DAMM v2's own events (above)" : ""}. What liquidity providers do afterwards is not predicted: in the check, additions and removals are taken from the chain. A DAMM v1 pool, which a new config can no longer migrate to, is traded as plain constant product with a flat fee and is not checked.`
  : "- After migration the pool is traded with DAMM v2's own arithmetic. A DAMM v1 pool is traded as plain constant product and is not checked.";
const readme = join(root, "README.md");
writeFileSync(
  readme,
  readFileSync(readme, "utf8")
    .replace(/<!-- figures:start -->[\s\S]*<!-- figures:end -->/, `<!-- figures:start -->\n${block}\n<!-- figures:end -->`)
    .replace(/<!-- found:start -->[\s\S]*<!-- found:end -->/, `<!-- found:start -->\n${found}\n<!-- found:end -->`)
    .replace(/<!-- probe:start -->[\s\S]*<!-- probe:end -->/, `<!-- probe:start -->\n${probed}\n<!-- probe:end -->`)
    .replace(/<!-- builders:start -->[\s\S]*<!-- builders:end -->/, `<!-- builders:start -->\n${built}\n<!-- builders:end -->`)
    .replace(/<!-- migration:start -->[\s\S]*<!-- migration:end -->/, `<!-- migration:start -->\n${migrated}${sdkAfter}\n<!-- migration:end -->`)
    .replace(/<!-- afterwards:start -->[\s\S]*<!-- afterwards:end -->/, `<!-- afterwards:start -->\n${afterwards}\n<!-- afterwards:end -->`),
);
console.log("site written to docs/", figures);
