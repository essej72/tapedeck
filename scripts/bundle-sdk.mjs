// Bundle a whole checkout of Meteora's DBC SDK (client, curve builders, helpers) into one module, so its builders
// can be put in front of the live program before the package is on npm.
//
//   node scripts/bundle-sdk.mjs <path to dynamic-bonding-curve-sdk/packages/dynamic-bonding-curve> [out.mjs]
//   node src/builders.ts run 300 --sdk data/sdk.mjs
//
// web3.js, anchor and friends are left external, so the output must sit inside this project (the default,
// data/sdk.mjs, does). For the swap math alone, see bundle-sdk-math.mjs.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const [pkg, outArg] = process.argv.slice(2);
if (!pkg) {
  console.log("usage: node scripts/bundle-sdk.mjs <path to the SDK package> [out.mjs]");
  process.exit(1);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const entry = join(pkg, "src/index.ts");
if (!existsSync(entry)) throw new Error(`no src/index.ts under ${pkg}`);
const outfile = resolve(outArg ?? join(root, "data/sdk.mjs"));
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
const need = ["DynamicBondingCurveClient", "buildCurve", "buildCurveWithMarketCap", "getMigrationThresholdPrice"];
const missing = need.filter((n) => typeof mod[n] !== "function");
if (missing.length) throw new Error(`${entry} does not export ${missing.join(", ")}`);
console.log(`bundled ${entry} -> ${outfile}`);
