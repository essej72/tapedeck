// Bundle the swap math of any checkout of Meteora's DBC SDK into one module the conformance run can replay
// mainnet history through.
//
//   node scripts/bundle-sdk-math.mjs <path to dynamic-bonding-curve-sdk/packages/dynamic-bonding-curve> [out.mjs]
//   node src/conformance.ts rerun --corpus corpus.jsonl.gz --math data/sdk-math.mjs
//
// It takes the first of src/math/index.ts (SDK 2.0 layout) or src/index.ts that exists. bn.js and friends are left
// external, so the output must sit inside this project (the default, data/sdk-math.mjs, does).
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const [pkg, outArg] = process.argv.slice(2);
if (!pkg) {
  console.log("usage: node scripts/bundle-sdk-math.mjs <path to the SDK package> [out.mjs]");
  process.exit(1);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const entry = [join(pkg, "src/math/index.ts"), join(pkg, "src/index.ts")].find((p) => existsSync(p));
if (!entry) throw new Error(`no src/math/index.ts or src/index.ts under ${pkg}`);
const outfile = resolve(outArg ?? join(root, "data/sdk-math.mjs"));
mkdirSync(dirname(outfile), { recursive: true });
await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  outfile,
  external: ["bn.js", "decimal.js", "@solana/web3.js", "@solana/spl-token", "@coral-xyz/anchor"],
  logLevel: "warning",
});
const mod = await import(new URL(`file://${outfile.replace(/\\/g, "/")}`).href);
const need = ["getFeeMode", "getSwapResultFromExactInput", "getSwapResultFromPartialInput", "getSwapResultFromExactOutput"];
const missing = need.filter((n) => typeof mod[n] !== "function");
if (missing.length) throw new Error(`${entry} does not export ${missing.join(", ")}`);
console.log(`bundled ${entry} -> ${outfile}`);
