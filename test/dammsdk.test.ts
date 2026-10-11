// Meteora's DAMM v2 SDK held to what DAMM v2 did (src/dammsdk.ts), offline.
//
// The fixture rows are the real first swaps of migrated pools (test/fixtures/afterwards.jsonl) and the accounts of
// those pools. Before each swap the published SDK is asked for its answer, from the pool as it stood then.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as published from "@meteora-ag/cp-amm-sdk";
import { readAfterwards } from "../src/afterwards.ts";
import { decoder, readAccounts, sdkAgainstPool, summarize, type DammSdk } from "../src/dammsdk.ts";

const sdk = published as unknown as DammSdk;
const rows = readAfterwards(new URL("fixtures/afterwards.jsonl", import.meta.url));
const accounts = readAccounts(new URL("fixtures/damm-pools.jsonl", import.meta.url));

test("the published DAMM v2 SDK gives every recorded swap as the program did", () => {
  const s = summarize(sdk, rows, accounts);
  assert.deepEqual(s.differing, []);
  assert.ok(s.pools >= 6 && s.swaps >= 100, `${s.swaps} swaps in ${s.pools} pools`);
  assert.ok(s.exactOut > 0 && s.dynamicSwaps > 0 && s.scheduledSwaps > 0 && s.compoundingSwaps > 0, "a kind of swap or pool is missing from the fixture");
});

test("the check notices an SDK that takes the fee from the wrong side", () => {
  const wrong: DammSdk = { ...sdk, getFeeMode: (mode, direction, referral) => ({ ...(sdk.getFeeMode(mode, direction, referral) as object), feesOnInput: !(sdk.getFeeMode(mode, direction, referral) as { feesOnInput: boolean }).feesOnInput }) };
  const decode = decoder(sdk);
  const caught = rows.filter((r) => r.damm && accounts.has(r.damm.pool)).map((r) => sdkAgainstPool(wrong, decode, r, accounts.get(r.damm!.pool)!)).filter((v) => v.mismatches.length);
  assert.ok(caught.length >= 6, `${caught.length} pools caught`);
});

test("and one that forgets the volatility the pool remembers", () => {
  const forgetful: DammSdk = {
    ...sdk,
    getSwapResultFromExactInput: (pool, ...rest) => sdk.getSwapResultFromExactInput({ ...pool, poolFees: { ...pool.poolFees, dynamicFee: { ...pool.poolFees.dynamicFee, initialized: 0 } } }, ...rest),
  };
  const decode = decoder(sdk);
  const dynamic = rows.filter((r) => r.damm?.dynamicFee && accounts.has(r.damm.pool));
  assert.ok(dynamic.length >= 2);
  assert.ok(dynamic.some((r) => sdkAgainstPool(forgetful, decode, r, accounts.get(r.damm!.pool)!).mismatches.length > 0));
});
