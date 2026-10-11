// Does a completed curve hand the migrated pool what the engine says it does?
//
//   node src/migration.ts run [pools]       find and read the migration transaction of completed pools in the store
//   node src/migration.ts check [--file data/migrations.jsonl]
//
// A replay does not stop when the curve completes: Side B goes on trading in the migrated pool, and the cost of faking
// a graduation depends on what that pool holds. engine/amm.ts says what migrates: the quote threshold less the
// migration fee and the config's migration base amount, both less the 0.2% protocol liquidity fee, at the curve's
// last price, into a full-range pool with one flat fee taken in quote. This holds each of those against the chain:
// the tokens that moved into the new pool's vaults in the migration transaction, and the price, range and fee that
// DAMM v2 itself recorded when it initialised the pool.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createDammV2Program, deriveDammV2PoolAuthority, deriveDbcPoolAuthority, MAX_SQRT_PRICE, MIN_SQRT_PRICE } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { MigratedPool } from "./engine/amm.ts";
import { configFromBytes } from "./engine/bytes.ts";
import { openTapes } from "./flows/chain.ts";
import { off, POOL } from "./layout.ts";
import { Rpc, RPC_URL } from "./rpc.ts";

/** What DAMM v2 recorded in its own EvtInitializePool, integers as decimal strings. */
export type DammInit = { pool: string; sqrtPrice: string; sqrtMinPrice: string; sqrtMaxPrice: string; liquidity: string; tokenAAmount: string; tokenBAmount: string; collectFeeMode: number; cliffFeeNumerator: string; scheduled: boolean; dynamicFee: boolean; positions: number };
export type Migration = {
  pool: string;
  config: string;
  /** The config account, base64: it cannot change after creation. */
  configData: string;
  /** The pool account as it is now, base64: it keeps the protocol's fee rate and what the protocol took at migration. */
  poolData?: string;
  baseMint: string;
  /** null: no migration among the transactions after the curve completed (it has not been migrated yet). */
  target: "DAMM v2" | "DAMM v1" | null;
  sig?: string;
  slot?: number;
  /** Tokens that left the curve's vaults and tokens that arrived in the new pool's, in the migration transaction. */
  out?: { base: string; quote: string };
  into?: { base: string; quote: string };
  damm?: DammInit | null;
};

// ---------------------------------------------------------------- the check, offline

const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, "base64"));

/** What the pool account records about its migration: the protocol's fee rate and the amounts it took. */
export function protocolCut(m: Migration): { bps: number; base: string; quote: string } | null {
  if (!m.poolData) return null;
  const d = Buffer.from(m.poolData, "base64");
  const at = (field: string) => off(POOL, `pool_state.${field}`);
  return { bps: d.readUInt16LE(at("protocol_liquidity_migration_fee_bps")), base: d.readBigUInt64LE(at("protocol_migration_base_fee_amount")).toString(), quote: d.readBigUInt64LE(at("protocol_migration_quote_fee_amount")).toString() };
}

/** The engine's migrated pool for a row, at the protocol fee rate its pool account carries. */
export function enginePool(m: Migration): MigratedPool {
  const cut = protocolCut(m);
  return cut ? new MigratedPool(configFromBytes(bytes(m.configData)), cut.bps) : new MigratedPool(configFromBytes(bytes(m.configData)));
}

/** Where a migration on chain is not what the engine says migrates. Empty = the same. */
export function migrationDifferences(m: Migration): string[] {
  if (!m.target || !m.into) return [];
  const config = configFromBytes(bytes(m.configData));
  const engine = enginePool(m);
  const cut = protocolCut(m);
  const out: string[] = [];
  const same = (label: string, mine: unknown, theirs: unknown) => {
    if (String(mine) !== String(theirs)) out.push(`${label}: engine ${String(mine)}, chain ${String(theirs)}`);
  };
  same("quote into the pool", engine.quote, m.into.quote);
  same("base into the pool", engine.base, m.into.base);
  // The pool account keeps what the protocol took until the protocol claims it; a zero there says nothing.
  if (cut && cut.quote !== "0") same("protocol's quote", engine.protocolFee.quote, cut.quote);
  if (cut && cut.base !== "0") same("protocol's base", engine.protocolFee.base, cut.base);
  if (m.damm) {
    const c = config as unknown as { migrationSqrtPrice: { toString(): string }; migratedCollectFeeMode: number };
    // A compounding pool takes its price from the two amounts (rounded up); any other starts at the curve's last price.
    const fromAmounts = () => {
      const [b, q] = [BigInt(engine.base.toString()), BigInt(engine.quote.toString()) << 128n];
      const x = (q + b - 1n) / b;
      let r = BigInt(Math.floor(Math.sqrt(Number(x))));
      while (r * r > x) r--;
      while ((r + 1n) * (r + 1n) <= x) r++;
      return r;
    };
    same("pool price", c.migratedCollectFeeMode === 2 ? fromAmounts() : c.migrationSqrtPrice, m.damm.sqrtPrice);
    // DAMM v2's EvtInitializePool carries the amounts of the position that opened the pool
    if (m.damm.positions === 1) same("DAMM v2's own amounts", `${m.into.base} / ${m.into.quote}`, `${m.damm.tokenAAmount} / ${m.damm.tokenBAmount}`);
  }
  return out;
}

/** How the migrated pool is set up, next to what the engine assumes about trading in it. */
export function poolShape(m: Migration) {
  if (!m.damm) return null;
  const engine = enginePool(m);
  return {
    fullRange: m.damm.sqrtMinPrice === MIN_SQRT_PRICE.toString() && m.damm.sqrtMaxPrice === MAX_SQRT_PRICE.toString(),
    // DAMM v2 counts fees in parts per billion, the engine in parts per million
    feeAsEngine: (BigInt(m.damm.cliffFeeNumerator) / 1000n).toString() === engine.feePpm.toString(),
    flatFee: !m.damm.scheduled && !m.damm.dynamicFee,
    // DAMM v2: 1 = the fee always in the quote token, 0 = from whatever the trade pays out
    feeSideAsEngine: m.damm.collectFeeMode === (engine.feeOnOutput ? 0 : 1),
    feeInQuote: m.damm.collectFeeMode === 1,
  };
}

export const readMigrations = (file: string | URL): Migration[] => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const fixedTier = (r: Migration) => (configFromBytes(bytes(r.configData)) as unknown as { migrationFeeOption: number }).migrationFeeOption < 6;

export function summarize(rows: Migration[]) {
  const migrated = rows.filter((r) => r.target);
  const v2 = migrated.filter((r) => r.target === "DAMM v2");
  const differing = migrated.map((r) => ({ pool: r.pool, differences: migrationDifferences(r) })).filter((r) => r.differences.length);
  const shapes = v2.map((r) => poolShape(r)!);
  return {
    completed: rows.length,
    migrated: migrated.length,
    notMigrated: rows.length - migrated.length,
    dammV2: v2.length,
    dammV1: migrated.length - v2.length,
    configs: new Set(migrated.map((r) => r.config)).size,
    agree: migrated.length - differing.length,
    differing,
    fullRange: shapes.filter((s) => s.fullRange).length,
    feeAsEngine: shapes.filter((s) => s.feeAsEngine).length,
    flatFee: shapes.filter((s) => s.flatFee).length,
    feeInQuote: shapes.filter((s) => s.feeInQuote).length,
    feeSideAsEngine: shapes.filter((s) => s.feeSideAsEngine).length,
    // the whole of what the engine models after migration: full range, the config's fee rate, flat, on the side the config says
    asModelled: shapes.filter((s) => s.fullRange && s.feeAsEngine && s.flatFee && s.feeSideAsEngine).length,
    withProtocolFee: migrated.filter((r) => (protocolCut(r)?.bps ?? 0) > 0).length,
    // pools whose account still shows what the protocol took (it is cleared when the protocol claims it)
    protocolCutShown: migrated.filter((r) => (protocolCut(r)?.quote ?? "0") !== "0").length,
    twoPositions: v2.filter((r) => (r.damm?.positions ?? 0) > 1).length,
    dynamicFee: v2.filter((r) => r.damm?.dynamicFee).length,
    scheduledFee: v2.filter((r) => r.damm?.scheduled).length,
    compounding: v2.filter((r) => r.damm?.collectFeeMode === 2).length,
    // a fixed fee tier migrates into one of DAMM v2's public configs, whatever the DBC config says about a dynamic fee
    fixedTier: v2.filter((r) => fixedTier(r)).length,
    fixedTierDynamic: v2.filter((r) => fixedTier(r) && r.damm?.dynamicFee).length,
  };
}

// ---------------------------------------------------------------- commands

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
type RawTx = {
  slot: number;
  transaction: { message: { accountKeys: string[] } };
  meta: { err: unknown; logMessages: string[] | null; innerInstructions: { instructions: { programIdIndex: number; data: string }[] }[] | null; preTokenBalances: TokenBalance[] | null; postTokenBalances: TokenBalance[] | null; loadedAddresses?: { writable: string[]; readonly: string[] } } | null;
};

const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

if (args[0] === "run") {
  const out = flag("--out") ?? "data/migrations.jsonl";
  const limit = Number(args[1] && !args[1].startsWith("--") ? args[1] : 1e9);
  const db = openTapes();
  const rpc = new Rpc(RPC_URL, 350);
  const damm = createDammV2Program(new Connection(RPC_URL, "confirmed")) as unknown as { coder: { events: { decode(b64: string): { name: string; data: Record<string, any> } | null } } };
  const dbcAuthority = deriveDbcPoolAuthority().toBase58();
  const dammAuthority = deriveDammV2PoolAuthority().toBase58();
  const done = existsSync(out) ? new Set(readMigrations(out).map((r) => r.pool)) : new Set<string>();
  const configs = new Map<string, string>();
  // Pools whose whole history replayed and whose curve is finished: the engine's state at completion is the chain's.
  const pools = db.prepare("SELECT pool FROM conformance WHERE final_checked = 1 AND mismatches = 0 ORDER BY pool").all() as { pool: string }[];
  let n = 0;
  for (const { pool } of pools) {
    if (done.has(pool) || n >= limit) continue;
    n++;
    const txs = db.prepare("SELECT sig, events FROM chain_tx WHERE pool = ? ORDER BY seq").all(pool) as { sig: string; events: string }[];
    const events = txs.flatMap((t) => (JSON.parse(t.events) as { name: string; data: Record<string, string> }[]).map((e) => ({ ...e, sig: t.sig })));
    const init = events.find((e) => e.name === "evtInitializePool" && e.data.pool === pool)!;
    const completed = events.find((e) => e.name === "evtCurveComplete" && e.data.pool === pool)!;
    if (!configs.has(init.data.config)) configs.set(init.data.config, (await rpc.call<{ value: { data: [string, string] } }>("getAccountInfo", [init.data.config, { encoding: "base64" }])).value.data[0]);
    const poolData = (await rpc.call<{ value: { data: [string, string] } }>("getAccountInfo", [pool, { encoding: "base64" }])).value.data[0];
    const row: Migration = { pool, config: init.data.config, configData: configs.get(init.data.config)!, poolData, baseMint: init.data.baseMint, target: null };
    const quoteMint = configFromBytes(bytes(row.configData)).quoteMintAddress;
    // Everything that touched the pool after the transaction that completed it, oldest first.
    const later = (await rpc.call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [pool, { until: completed.sig, limit: 1000 }])).filter((s) => !s.err).reverse();
    for (const s of later.slice(0, 40)) {
      const tx = await rpc.call<RawTx | null>("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, encoding: "json" }]);
      const logs = tx?.meta?.logMessages ?? [];
      const v2 = logs.some((l) => l === "Program log: Instruction: MigrationDammV2");
      const v1 = logs.some((l) => l === "Program log: Instruction: MigrateMeteoraDamm");
      if (!tx?.meta || (!v1 && !v2)) continue;
      const pre = new Map((tx.meta.preTokenBalances ?? []).map((b) => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
      const moved = { out: { base: 0n, quote: 0n }, into: { base: 0n, quote: 0n } };
      for (const b of tx.meta.postTokenBalances ?? []) {
        const side = b.mint === row.baseMint ? "base" : b.mint === quoteMint ? "quote" : null;
        const delta = BigInt(b.uiTokenAmount.amount) - (pre.get(b.accountIndex) ?? 0n);
        if (!side || delta === 0n) continue;
        if (b.owner === dbcAuthority) moved.out[side] -= delta;
        // DAMM v2 keeps its vaults under one authority; DAMM v1 deposits into shared vaults, so there every other gain counts
        else if (v2 ? b.owner === dammAuthority : delta > 0n) moved.into[side] += delta;
      }
      const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      let initEvent: Record<string, any> | null = null;
      let positions = 0;
      for (const group of tx.meta.innerInstructions ?? []) {
        for (const ix of group.instructions) {
          const data = bs58.decode(ix.data);
          if (data.length < 16 || EVENT_IX_TAG.some((b, i) => data[i] !== b) || keys[ix.programIdIndex] === undefined) continue;
          let ev = null;
          try {
            ev = damm.coder.events.decode(Buffer.from(data.subarray(8)).toString("base64"));
          } catch {
            // an event of another program
          }
          if (ev?.name === "evtInitializePool") initEvent = ev.data;
          if (ev?.name === "evtCreatePosition") positions++;
        }
      }
      const fee = initEvent ? Buffer.from(initEvent.poolFees.baseFee.data as number[]) : null;
      Object.assign(row, {
        target: v2 ? "DAMM v2" : "DAMM v1",
        sig: s.signature,
        slot: tx.slot,
        out: { base: moved.out.base.toString(), quote: moved.out.quote.toString() },
        into: { base: moved.into.base.toString(), quote: moved.into.quote.toString() },
        damm:
          initEvent && fee
            ? {
                pool: initEvent.pool.toBase58(),
                sqrtPrice: initEvent.sqrtPrice.toString(10),
                sqrtMinPrice: initEvent.sqrtMinPrice.toString(10),
                sqrtMaxPrice: initEvent.sqrtMaxPrice.toString(10),
                liquidity: initEvent.liquidity.toString(10),
                tokenAAmount: initEvent.tokenAAmount.toString(10),
                tokenBAmount: initEvent.tokenBAmount.toString(10),
                collectFeeMode: initEvent.collectFeeMode,
                // BaseFeeInfo: cliff fee numerator (u64), mode (u8), then the three factors of a schedule
                cliffFeeNumerator: fee.readBigUInt64LE(0).toString(),
                scheduled: fee.subarray(9).some((b) => b !== 0),
                dynamicFee: initEvent.poolFees.dynamicFee != null,
                positions,
              }
            : null,
      } satisfies Partial<Migration>);
      break;
    }
    appendFileSync(out, JSON.stringify(row) + "\n");
    const diff = migrationDifferences(row);
    console.log(`${pool.slice(0, 8)} ${row.target ?? `not migrated (${later.length} later transactions)`} ${row.target ? (diff.length ? diff.join(" | ") : "as the engine says") : ""}`);
  }
  console.log(JSON.stringify({ ...summarize(readMigrations(out)), differing: undefined }));
} else if (args[0] === "accounts") {
  // Fill in the pool account for rows read before it was kept.
  const file = flag("--file") ?? "data/migrations.jsonl";
  const rows = readMigrations(file);
  const rpc = new Rpc(RPC_URL, 350);
  const missing = rows.filter((r) => !r.poolData);
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const got = await rpc.call<{ value: ({ data: [string, string] } | null)[] }>("getMultipleAccounts", [batch.map((r) => r.pool), { encoding: "base64" }]);
    batch.forEach((r, k) => (r.poolData = got.value[k]?.data[0]));
  }
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`${missing.length} pool accounts read`);
} else if (args[0] === "check") {
  const rows = readMigrations(flag("--file") ?? "data/migrations.jsonl");
  const s = summarize(rows);
  console.log(`${s.completed} completed pools: ${s.migrated} migrated (${s.dammV2} to DAMM v2, ${s.dammV1} to DAMM v1) under ${s.configs} configs, ${s.notMigrated} not yet`);
  console.log(`what moved into the new pool is what the engine says migrates, to the unit, at the price it says: ${s.agree} of ${s.migrated}`);
  for (const d of s.differing.slice(0, 12)) console.log(`  ${d.pool.slice(0, 8)} ${d.differences.join(" | ")}`);
  console.log(`of the ${s.dammV2} DAMM v2 pools: ${s.fullRange} full range, ${s.feeAsEngine} at the fee rate the engine uses, ${s.feeSideAsEngine} taking it on the side the engine does (${s.feeInQuote} in quote, ${s.dammV2 - s.feeInQuote} from the output token), ${s.flatFee} with a flat fee (no schedule, no dynamic fee); ${s.asModelled} are all four, which is the pool the deck trades in after migration`);
  if (flag("--json")) writeFileSync(flag("--json")!, JSON.stringify({ generatedAt: new Date().toISOString(), ...s, differing: s.differing.slice(0, 20) }, null, 1));
  process.exit(s.differing.length ? 1 : 0);
}
