// Bundle a checkout of Meteora's DAMM v2 SDK (github.com/MeteoraAg/damm-v2-sdk) into one module, so any commit of
// it can be held to what DAMM v2 did on mainnet.
//
//   node scripts/bundle-damm-sdk.mjs <path to damm-v2-sdk> [out.cjs]
//   node src/dammsdk.ts check --sdk data/damm-sdk.cjs
//
// web3.js, anchor and friends are left external, so the output must sit inside this project (the default,
// data/damm-sdk.cjs, does). It is a CommonJS module because the SDK imports names from bn.js that only exist that way.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const [pkg, outArg] = process.argv.slice(2);
if (!pkg) {
  console.log("usage: node scripts/bundle-damm-sdk.mjs <path to damm-v2-sdk> [out.cjs]");
  process.exit(1);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const entry = join(pkg, "src/index.ts");
if (!existsSync(entry)) throw new Error(`no src/index.ts under ${pkg}`);
const outfile = resolve(outArg ?? join(root, "data/damm-sdk.cjs"));
mkdirSync(dirname(outfile), { recursive: true });
// `invariant` is the SDK's one dependency this project does not carry, and one line does its whole job.
const invariant = {
  name: "invariant",
  setup(b) {
    b.onResolve({ filter: /^invariant$/ }, () => ({ path: "invariant", namespace: "inline" }));
    b.onLoad({ filter: /.*/, namespace: "inline" }, () => ({ contents: "export default function invariant(ok, message) { if (!ok) throw new Error(message); }", loader: "js" }));
  },
};
await build({
  entryPoints: [entry],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  outfile,
  external: ["bn.js", "decimal.js", "@solana/web3.js", "@solana/spl-token", "@coral-xyz/anchor"],
  plugins: [invariant],
  logLevel: "warning",
});
const mod = await import(new URL(`file://${outfile.replace(/\\/g, "/")}`).href);
const need = ["CpAmm", "getSwapResultFromExactInput", "getSwapResultFromPartialInput", "getSwapResultFromExactOutput", "getFeeMode"];
const missing = need.filter((n) => typeof mod[n] !== "function");
if (missing.length) throw new Error(`${entry} does not export ${missing.join(", ")}`);
console.log(`bundled ${entry} -> ${outfile}`);
