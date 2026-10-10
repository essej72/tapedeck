// Census of every DBC config and virtual pool on mainnet, read straight from program accounts.
//
//   node src/census/pull.ts pools      # every VirtualPool: where it got to and what it earned
//   node src/census/pull.ts configs    # every PoolConfig, whole account
//   node src/census/pull.ts partners   # every PartnerMetadata: the name a launchpad registered for its fee claimer
//   node src/census/pull.ts status
//
// getProgramAccounts cannot page, so the set is cut into slices with a one-byte memcmp on a field whose first byte
// is spread evenly (the base mint for pools). Configs have no such field, so their slices are counted first and
// split again on another byte when one is too large. Finished slices are recorded, so a stopped run resumes.

import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import bs58 from "bs58";
import { CONFIG, POOL, PROGRAM_ID, discriminator, off } from "../layout.ts";
import { Rpc } from "../rpc.ts";

type Account = { pubkey: string; account: { data: [string, string] } };
type Filter = { memcmp: { offset: number; bytes: string } };

const DATA_DIR = new URL("../../data/", import.meta.url);
mkdirSync(DATA_DIR, { recursive: true });
export const CENSUS_DB = new URL("census.db", DATA_DIR);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pools (
  address BLOB PRIMARY KEY, config BLOB, creator BLOB, base_mint BLOB,
  base_reserve REAL, quote_reserve REAL, sqrt_price REAL, activation_point REAL,
  pool_type INTEGER, is_migrated INTEGER, migration_progress INTEGER, has_swap INTEGER,
  protocol_quote_fee REAL, partner_quote_fee REAL, creator_quote_fee REAL,
  protocol_base_fee REAL, partner_base_fee REAL, creator_base_fee REAL,
  total_protocol_base_fee REAL, total_protocol_quote_fee REAL, total_trading_base_fee REAL, total_trading_quote_fee REAL,
  finish_curve_timestamp REAL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS configs (address BLOB PRIMARY KEY, data BLOB) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS partners (address BLOB PRIMARY KEY, data BLOB) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS slices (kind TEXT, key TEXT, n INTEGER, done_at REAL, PRIMARY KEY (kind, key));
`;

const memcmp = (offset: number, bytes: Uint8Array): Filter => ({ memcmp: { offset, bytes: bs58.encode(bytes) } });
const hex = (n: number) => n.toString(16).padStart(2, "0");

function open(): DatabaseSync {
  const db = new DatabaseSync(CENSUS_DB);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  db.exec(SCHEMA);
  return db;
}

async function fetchSlice(rpc: Rpc, filters: Filter[], slice?: { offset: number; length: number }): Promise<Account[]> {
  return rpc.call<Account[]>("getProgramAccounts", [PROGRAM_ID, { encoding: "base64", filters, ...(slice ? { dataSlice: slice } : {}) }], 300_000);
}

async function pullPools(): Promise<void> {
  const db = open();
  const rpc = new Rpc(undefined, 4000);
  const start = off(POOL, "pool_state.config");
  const end = off(POOL, "pool_state.has_swap") + 1;
  const at = (path: string) => off(POOL, `pool_state.${path}`) - start;
  const u64 = (b: Buffer, path: string) => Number(b.readBigUInt64LE(at(path)));
  const u128 = (b: Buffer, path: string) => Number(b.readBigUInt64LE(at(path))) + Number(b.readBigUInt64LE(at(path) + 8)) * 2 ** 64;
  const key = (b: Buffer, path: string) => b.subarray(at(path), at(path) + 32);
  const insert = db.prepare(`INSERT OR REPLACE INTO pools VALUES (${Array(23).fill("?").join(",")})`);
  const mark = db.prepare("INSERT OR REPLACE INTO slices VALUES ('pools', ?, ?, ?)");
  const done = new Set(db.prepare("SELECT key FROM slices WHERE kind='pools'").all().map((r) => r.key as string));
  let total = 0;
  for (let b = 0; b < 256; b++) {
    if (done.has(hex(b))) continue;
    const t0 = Date.now();
    const accounts = await fetchSlice(
      rpc,
      [memcmp(0, discriminator("VirtualPool")), memcmp(off(POOL, "pool_state.base_mint"), Uint8Array.of(b))],
      { offset: start, length: end - start },
    );
    db.exec("BEGIN");
    for (const a of accounts) {
      const d = Buffer.from(a.account.data[0], "base64");
      if (d.length < end - start) continue;
      insert.run(
        bs58.decode(a.pubkey), key(d, "config"), key(d, "creator"), key(d, "base_mint"),
        u64(d, "base_reserve"), u64(d, "quote_reserve"), u128(d, "sqrt_price"), u64(d, "activation_point"),
        d[at("pool_type")], d[at("is_migrated")], d[at("migration_progress")], d[at("has_swap")],
        u64(d, "protocol_quote_fee"), u64(d, "partner_quote_fee"), u64(d, "creator_quote_fee"),
        u64(d, "protocol_base_fee"), u64(d, "partner_base_fee"), u64(d, "creator_base_fee"),
        u64(d, "metrics.total_protocol_base_fee"), u64(d, "metrics.total_protocol_quote_fee"),
        u64(d, "metrics.total_trading_base_fee"), u64(d, "metrics.total_trading_quote_fee"),
        u64(d, "finish_curve_timestamp"),
      );
    }
    mark.run(hex(b), accounts.length, Date.now() / 1000);
    db.exec("COMMIT");
    total += accounts.length;
    console.log(`pools ${hex(b)}  ${accounts.length} accounts  ${((Date.now() - t0) / 1000).toFixed(1)}s  (run total ${total})`);
  }
  console.log("pools: done");
}

// Fields a config slice can be split on, in order. Each is a byte that differs between otherwise similar configs.
const CONFIG_SPLITS = ["fee_claimer", "leftover_receiver", "sqrt_start_price", "migration_quote_threshold", "pool_fees.base_fee.cliff_fee_numerator"];
const MAX_SLICE = 40_000; // about 56 MB a response; the endpoint allows roughly 100 MB per 30 s

async function pullConfigs(): Promise<void> {
  const db = open();
  const rpc = new Rpc(undefined, 1500);
  const insert = db.prepare("INSERT OR REPLACE INTO configs VALUES (?, ?)");
  const mark = db.prepare("INSERT OR REPLACE INTO slices VALUES ('configs', ?, ?, ?)");
  const done = new Set(db.prepare("SELECT key FROM slices WHERE kind='configs'").all().map((r) => r.key as string));
  const base = memcmp(0, discriminator("PoolConfig"));
  let total = 0;

  const take = async (filters: Filter[], key: string, depth: number): Promise<void> => {
    if (done.has(key)) return;
    const n = (await fetchSlice(rpc, [base, ...filters], { offset: 0, length: 0 })).length;
    if (n > MAX_SLICE && depth < CONFIG_SPLITS.length && filters.length < 3) {
      for (let b = 0; b < 256; b++) await take([...filters, memcmp(off(CONFIG, CONFIG_SPLITS[depth]), Uint8Array.of(b))], `${key}${hex(b)}`, depth + 1);
      mark.run(key, -1, Date.now() / 1000);
      return;
    }
    if (n > 0) {
      const accounts = await fetchSlice(rpc, [base, ...filters]);
      db.exec("BEGIN");
      for (const a of accounts) insert.run(bs58.decode(a.pubkey), Buffer.from(a.account.data[0], "base64"));
      db.exec("COMMIT");
      total += accounts.length;
    }
    mark.run(key, n, Date.now() / 1000);
    if (n > 0) console.log(`configs ${key}  ${n} accounts  (run total ${total})`);
  };

  for (let b = 0; b < 256; b++) await take([memcmp(off(CONFIG, CONFIG_SPLITS[0]), Uint8Array.of(b))], hex(b), 1);
  console.log("configs: done");
}

async function pullPartners(): Promise<void> {
  const db = open();
  const accounts = await fetchSlice(new Rpc(undefined, 4000), [memcmp(0, discriminator("PartnerMetadata"))]);
  const insert = db.prepare("INSERT OR REPLACE INTO partners VALUES (?, ?)");
  db.exec("BEGIN");
  for (const a of accounts) insert.run(bs58.decode(a.pubkey), Buffer.from(a.account.data[0], "base64"));
  db.exec("COMMIT");
  console.log(`partners: ${accounts.length} accounts`);
}

function status(): void {
  const db = open();
  for (const t of ["pools", "configs"]) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n;
    const s = db.prepare("SELECT COUNT(*) AS n FROM slices WHERE kind = ? AND n >= 0").get(t)!.n;
    console.log(`${t}: ${n} rows, ${s} slices finished`);
  }
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "pools") await pullPools();
  else if (cmd === "configs") await pullConfigs();
  else if (cmd === "partners") await pullPartners();
  else if (cmd === "status") status();
  else console.log("usage: node src/census/pull.ts pools|configs|partners|status");
}
