# Tapedeck

[![test](https://github.com/essej72/tapedeck/actions/workflows/test.yml/badge.svg)](https://github.com/essej72/tapedeck/actions/workflows/test.yml)

Play back any Meteora DBC launch. Fly it again under a different config. Or take the stick and trade it yourself. On an engine that is checked against the chain.

A **tape** is a real launch, order by order: who bought, who sold, when, how much. The deck plays it on two sides.

- **Side A** plays the launch on the curve it happened on.
- **Side B** flies the same orders through any config: one you design (through the SDK's own curve builders) or any config on mainnet, loaded by address. Every buyer spends the same amount at the same moment, every seller sells the same share of what they hold by then. A ledger shows who paid and who collected under each.
- **Any pool.** Paste a DBC pool address and the deck fetches its transactions in your browser, replays every swap against the events the program emitted, tells you whether they match, and puts the pool on the deck with its own config as Side A.
- **REC** hands you a paper wallet. Your orders go onto the tape at the moment you press, and the rest of the launch trades against the price you left behind.
- A config you like leaves as a file for Meteora's [Invent CLI](https://github.com/MeteoraAg/meteora-invent), or goes **straight to mainnet**: the deck asks the live program whether it takes the design (a simulation, no wallet needed), then creates the config from your own wallet.

Entry for the Meteora track, "Best use of Meteora's Dynamic Bonding Curve", Crypto World's Fair 2026.

**[Open the deck](https://essej72.github.io/tapedeck/)** · **[Pitch](https://essej72.github.io/tapedeck/pitch.html)** · **[Evidence](https://essej72.github.io/tapedeck/#evidence)**

![Tapedeck playing a real DBC pool, switching Side B's config, asking the live program whether it takes the design, a pump.fun buyout, paper trading, and the evidence chart](web/img/demo.gif)

## What it found

<!-- figures:start -->
- **Census:** 1,768,464 pools under 543,738 configs, read from program accounts on 2026-10-10.
- **Where faking a graduation costs under 2% of the raise:** 84% of 1,131,326 pools completed their curve.
- **Where it costs 10% or more:** 2.7% of 438,317 pools did.
- **pump.fun, recorded 2026-10-10 to 2026-10-11:** 78 of 121 graduations that passed the check were one party buying the curve in the launch slot.
- **Engine against chain:** 186,352 real swaps in 666 pools and 77 kinds of config replay to the lamport. 7 more pools were traded under older builds of the program and differ exactly where the program has since changed; they are counted as mismatches and explained under "Found on the way".
- **Engine against the program itself:** 5,169 swaps simulated against the live program on 521 open pools, 3,969 of them exact-out (a swap nobody makes on mainnet, so no history can check it), 0 disagreements.
- **Engine against migration:** in 179 of 179 real migrations, the tokens that moved into the new pool and the price the pool opened at are what the engine says, to the unit.
- **Builders against the program:** 600 random inputs through the SDK's six curve builders, each result simulated against the live program. It refused 12 of the configs SDK 1.5.13 returned and none of the 303 the 2.0 branch returned.
- **Shelf:** 84 tapes: 24 DBC pools read from the chain and 60 pump.fun launches, picked from 561 that passed the fit check. Of 1,206 pump.fun launches recorded, 584 had under 12 orders and 61 failed the check.
<!-- figures:end -->

![Completion rate against the cost of faking a graduation, one bubble per design](web/img/evidence.jpg)

The cheapest way onto every "just migrated" feed is for a creator to buy their own curve in the launch transaction. Whether that is expensive or free is decided by the config: the fee at second zero, who the fee goes back to, who owns the liquidity after migration. `src/engine/buyout.ts` prices that round trip for any config. `src/census/` reads every config and pool on mainnet and puts the two side by side. The split is not subtle: where faking is nearly free, nearly everything "graduates".

## Why believe the engine

Prices and fees come from the quote functions of `@meteora-ag/dynamic-bonding-curve-sdk`. Around them, `src/engine/pool.ts` does what the on-chain program does and the SDK leaves to it (`process_swap.rs`, `virtual_pool.rs`, `fee.rs`): refresh the volatility tracker before the quote, apply the result to reserves and fee buckets, split the trading fee between partner and creator, update the tracker after, honour the minimum-fee first swap, complete the curve at the threshold.

Then it is held to the chain:

- `node src/validate.ts <pool>` fetches a pool's whole history, replays every swap from the pool's own events (the current `EvtSwap2`, and the older `EvtSwap` for swaps from before August 2025) and compares each field of each result with what the program emitted, to the lamport, then the final state with the live account. A transaction no endpoint can return with its events leaves a hole, and a history with a hole is reported as one, not replayed. A swap the engine refuses is a mismatch.
- `node src/conformance.ts pick && node src/conformance.ts run` does that for pools spread over every combination of fee mode, fee token, activation type, first-swap setting and quote token in use on mainnet.
<!-- migration:start -->
- `node src/migration.ts run` follows every completed pool of that run across its migration: 183 pools, 179 of them migrated (167 to DAMM v2, 12 to DAMM v1, 5 with the liquidity split between two positions). In all 179, the tokens that moved into the new pool's vaults and the price the new pool opened at are what the engine says, to the unit, and so is the protocol's cut in the 156 pools whose account still shows it. It did not start that way: on the first run, on 11 October, the engine agreed in 57 of them. In 92 its token amount was one unit high, because the protocol's cut of the tokens is the base side of its quote cut and not 0.2% of the tokens. In 17 it took the protocol's 0.2% from pools that carry no such fee: the rate is kept on each pool account, and it is zero for every DAMM v1 migration here and for the oldest DAMM v2 ones. The other 13 had their liquidity split between two positions, which costs up to a lamport's worth of tokens, or were small enough for the rounding to show. All of that is fixed in `src/engine/amm.ts`, and 36 of the migrations are kept as a test.
<!-- migration:end -->
- A pump.fun tape goes on the shelf only if a DBC config equal to pump.fun's curve returns the recorded number of tokens on every curve buy.
- The deck does the same check live, in the browser, for any pool you paste. The browser build reads accounts and events from the IDL alone (no Anchor); it is tested against the SDK's Anchor coder on 160 real config accounts and 470 real events.
- `node src/dryrun.ts` builds the `create_config` transaction for the deck's built-in designs and for 150 random settings of its form, and has a node simulate each against the live program. 126 were accepted, and every one was stored field for field as the deck derives it (start price, migration price and base threshold included); the other 27 the SDK's own validation had already refused (under 10% of liquidity locked), which the deck shows as an error. The program refused none.
- `node src/probe.ts run` asks the live program about swaps nobody has made (exact-out), by simulation, and compares its answers with the engine's. See below.
- `node src/builders.ts run` puts random inputs through the SDK's six curve builders and asks the live program what it makes of each result. See below.
- `npm test` runs the same checks offline on frozen mainnet data: pool histories of different config kinds, 160 real config accounts, 470 events, three pump.fun tapes, a spread of the simulated swaps, 24 designs with the account the program stored for each, the program's answers to 37 builder results, 36 migrations with what moved into the new pool, and the awkward histories: swaps recorded with the older event, pools from older builds of the program, a history with a hole.

## Check an SDK build against mainnet

The verified histories ship as one file, [`corpus.jsonl.gz`](https://github.com/essej72/tapedeck/releases/latest) (666 pools, 186,352 swaps, 77 kinds of config, events only, 31 MB). Any build of the SDK's swap math can be replayed through it, offline, in about a second:

```bash
node scripts/bundle-sdk-math.mjs ../dynamic-bonding-curve-sdk/packages/dynamic-bonding-curve
node src/conformance.ts rerun --corpus corpus.jsonl.gz --math data/sdk-math.mjs
```

Run on 11 October 2026:

| Math | Swaps replayed | Mismatches |
|---|---|---|
| SDK 1.5.13 (npm) | 186,352 | 0 |
| SDK 2.0 branch: [PR #123](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/pull/123) at `f960aff` (11 October, after the four-PR stack was folded into it) | 186,352 | 0 |
| The same branch as first posted: #123 at `bdfe680`, #125 at `706bd11`, #126 at `ffde81d` | 186,352 each | 0 |
| The 2.0 math with one lamport added to every exact-in output (a check that the check works) | stops early | flagged in 602 of 666 pools |

What the corpus covers: 89,651 buys and 96,701 sells; 172,304 exact-in swaps, 14,047 partial fills (39 of them cut short at the migration price) and a single exact-out swap; 9,028 swaps with a referral; 312 swaps inside the pool-creation transaction; 183 curve completions; 3,022 swaps from before August 2025, recorded with the older event; rate limiters, linear and exponential schedulers, the dynamic fee, fees in quote and in the output token, slot and timestamp activation. What it leaves out: seven pools traded under older builds of the program, which today's math should not reproduce (they are in `test/fixtures/old-program/` and under "Found on the way"). What it barely covers: exact-out swaps, which almost nobody makes (next section), and transfer-fee or transfer-hook tokens, not at all.

The first cut of this file, on 10 October, had 355 pools and 116,724 swaps; it is still attached to the earlier release.

### Swaps nobody has made

Exact-out swaps are in the program and in the SDK, but there is one among the 186,352 in those histories and none among 6,376 swaps in a sample of the program's most recent transactions (11 October, `src/hunt.ts`). History cannot check a swap nobody makes, so `src/probe.ts` asks the program itself. It builds the swap for a real open pool and has a public RPC node simulate it against the live program (`simulateTransaction` with signature checks off: nothing is signed, nothing is sent, there is no key). The trader in the simulation is a large exchange wallet standing in as payer, which any funded address can when signatures are not checked; nothing touches it. The program's own `EvtSwap2`, the pool account it leaves behind and the two vault balances are then compared with what the engine predicts from the pool account before.

<!-- probe:start -->
Run on 2026-10-11: 521 open pools (334 quoted in SOL, 187 in USDC), 84 kinds of config, 266 of them pools nobody had traded yet.

| Math | Simulated transactions | Swaps the program answered | Refusals | Disagreements |
|---|---|---|---|---|
| SDK 1.5.13 (npm) | 3,735 | 5,169, of them 3,969 exact-out | 555 | 0 |
| SDK 2.0 branch at `f960aff`, and earlier at `bdfe680`, `706bd11` and `ffde81d` | the same 3,735 | the same | the same | 0 at each |
| An exact-out quote one lamport too high (a check that the check works) | 2,378 with an exact-out swap | | | flagged in 2,378 |

398 of the pools were asked nine things: a control (an exact-in buy and sell, which history already proves, so a mismatch there would be the harness); exact-out buys of 0.2%, 15%, 60% and 85% of what is left on the curve, each followed by an exact-out sell, half of them with a referral (1,590 swaps); one token unit; one unit of the quote token; the last token on the curve; and one token more than the curve holds. A tenth question was added later and put to 157 pools: an exact-in buy of one unit of quote more than it takes to reach the migration price. Today's program refuses it whole in 151 of them and lets rounding absorb it in the other 6, and the engine gives the same answer each time. Older builds let such a buy run on past the migration price (see "Found on the way").

- **Every field agrees**: amount in, amount out, next price, trading, protocol and referral fee, and afterwards the pool account itself: reserves, every fee bucket, the volatility tracker.
- **Refusals agree.** One token past the end of the curve is `InsufficientLiquidity` or `AmountLeftIsNotZero` in the program and an error in the SDK (396 cases). Buying exactly what is left completes the curve in 382 pools; in the 8 where the program refuses it, the SDK refuses it too.
- **The books match the vaults.** In all 3,180 transactions the program accepted, each vault's balance moved by exactly the change in the pool's reserve plus its fee buckets.
- **Dust rounds toward the pool.** No swap was free of fee. One unit of the quote token buys nothing in 327 of 398 pools and is kept as fee.
- **Fee schedules mid-run.** An old pool's schedule has run out, so 90 of the transactions went to 10 pools whose schedule was still running. No pool with a live rate limiter was found to ask.
<!-- probe:end -->

The simulations are saved as [`probes.jsonl.gz`](https://github.com/essej72/tapedeck/releases/latest) and check offline against any build of the SDK:

```bash
node src/probe.ts check --file probes.jsonl.gz --math data/sdk-math.mjs
```

Limits: pools quoted in SOL or USDC only, no transfer-fee or transfer-hook tokens, and a simulation is one node's run of the program at one slot, not a landed transaction.

### Configs the builders build

A launchpad does not write a config by hand. It calls one of the SDK's six curve builders and sends what comes back, so a builder that returns something the program will not store, or stores as something else, is a failed launch. `src/builders.ts` gives the builders random inputs (both token programs, 6 to 9 decimals, SOL and USDC quotes, flat and scheduled fees, migration fees, liquidity splits, vesting, leftover), sends each result through `createConfig`, and has a public node simulate the transaction against the live program. Nothing is signed or sent. It works with the installed SDK or with any checkout of it:

```bash
node scripts/bundle-sdk.mjs <path to the SDK package> data/sdk.mjs
node src/builders.ts run 600 --out data/builders-1513.jsonl
node src/builders.ts run 600 --sdk data/sdk.mjs --out data/builders-2.jsonl
node src/builders.ts compare data/builders-1513.jsonl data/builders-2.jsonl data/sdk.mjs "SDK 2.0 branch"
```

<!-- builders:start -->
Run on 2026-10-11 against the live program, the same 600 inputs through both:

| | SDK 1.5.13 (npm) | SDK 2.0 branch at f960aff |
|---|---|---|
| Refused by the SDK before anything is sent | 304 | 297 |
| Built by the SDK, refused by the program | 12 | 0 |
| Stored by the program | 284 | 303 |
| of those, exactly as the SDK's own helpers derive | 156 | 303 |
| Built from market caps and stored | 174 | 185 |
| of those, migrating more than 0.1% off the cap asked for | 72 | 0 |
| Worst gap between the migration cap asked for and the one stored | 12.8% | 0.00006% |

Two causes in 1.5.13, showing up three ways, account for everything the program refused or stored differently, and the 2.0 changelog lists both as changed. What this run adds is the live program's side of it.

- **A migration fee and no leftover.** 1.5.13 sizes the token supply from the migration quote amount rounded down; the program rounds it up. With no leftover to absorb the difference the config comes out short by less than one token (between 2 and 614,971 of its smallest units) and the program refuses it: `InvalidTokenSupply`, 12 times, 6 of them from plain `buildCurveWithMarketCap`. Every one has a migration fee and a leftover of zero. The program's supply rule, applied offline to each builder result, predicts all 12 refusals and none of the 284 acceptances (`supplyShortfall` in `src/builders.ts`). Given the same 12 inputs, 2.0 builds a config the program stores for 6 and refuses the other 6 itself, with "leftover is too small to cover the migration base rounding".
- **The same rounding in what is stored.** In 128 of the configs the program stored for 1.5.13, its migration base differs from the one 1.5.13's helpers give. Each has a migration fee, the migration base is the only field that differs, and rounding the quote amount up closes the gap. For 2.0 all 303 stored configs equal the SDK's derivation field by field: curve, fees, migration price, migration base, swap amount, supply.
- **A fractional `percentageSupplyOnMigration`.** In 1.5.13, `buildCurveWithTwoSegments` and `buildCurveWithMidPrice` take the base amount from `new BN(percentage)`, which drops the fraction, and the quote amount from the exact figure. Ask for 20.69% of supply on migration and the config migrates at 20.69 / 20, or 3.45%, above the market cap that was asked for; the program stores it without complaint. 72 stored configs are off this way, by up to 12.8%, and percentage / floor(percentage) explains every one to five decimal places. 2.0 keeps the fraction.

Also seen: 2.0 turned 14 inputs that 1.5.13 refuses into configs the program stores, and refused 1 that 1.5.13 had built (`buildCurveWithTwoSegments` at 45.56% of supply, which 1.5.13 had quietly solved for 45%: "no mid price gives a two-segment curve with positive liquidity"). `create_config2`, the instruction 2.0's `createConfigAndPool` uses, was not on mainnet when this ran (asked on 2026-10-11, the program answers `InstructionFallbackNotFound`), so both sets went through `createConfig`.
<!-- builders:end -->

Limits: 600 inputs is a sample, not a proof; half of them are turned away by the SDK's own validation before they reach the program (the generator is deliberately loose); SOL and USDC quotes only, no transfer-fee or transfer-hook configs, and DAMM v2 migration only, since the SDK no longer builds the others.

## From the deck to mainnet

Under Side B's settings, "Put this config on mainnet" has two steps.

1. **Ask the program.** The deck builds the SDK's `createConfig` transaction for the design on Side B and has a public RPC node simulate it against the live program with signature checks off. It reports whether the program accepts it, the rent, and whether the account it would store equals the config Side B has been flying. No wallet, nothing signed, nothing sent.
2. **Create it with your wallet** (Phantom, Solflare or Backpack). Your wallet is the payer, the fee claimer and the leftover receiver. The deck rehearses the transaction with your wallet as payer first, then hands it to the wallet to approve: one account, about 0.006 SOL of rent. Once the network confirms, the new config is read back from the chain and loaded onto Side B like any other mainnet config.

The page never holds a wallet key. The only key it makes is the new account's own, which has to co-sign its creation and is discarded. Step 1 and the rehearsal are what `src/dryrun.ts` runs in bulk; step 2 has been exercised up to the wallet's approval prompt with a stand-in wallet (the transaction that reaches the wallet carries a live blockhash and the new account's signature), and a declined prompt sends nothing.

## Run it

Node 24 or newer. No API keys, no build step for the scripts (Node runs the TypeScript directly).

```bash
npm install
npm test
npm run build
npm run serve
```

The site is static (`docs/`). It works from GitHub Pages or any file host.

## Rebuild the data

Everything comes from public sources: the public mainnet RPC, a second keyless RPC for transaction history, and pump.fun's public trade feed. All reads, nothing signed, nothing sent. (The one thing in the project that can send a transaction is the deck's "create it with my wallet" step, and only the visitor's wallet can sign it.)

```bash
node src/census/pull.ts pools       # every VirtualPool account (about 15 minutes, paced)
node src/census/pull.ts configs     # every PoolConfig account (about an hour)
node src/census/designs.ts          # designs, outcomes, cost of faking a graduation
node src/census/export.ts           # the trimmed file the site ships

node src/conformance.ts pick        # pools of every kind of config
node src/conformance.ts busy 250    # plus the busiest pools of the last day
node src/conformance.ts run
node src/conformance.ts report

node src/flows/dbc.ts pick 40       # recent busy DBC pools for the shelf
node src/flows/dbc.ts fetch
node src/flows/pumpfun.ts enqueue-listing 10
node src/flows/pumpfun.ts run       # pump.fun tapes, about 18 requests a minute
node src/flows/library.ts           # check, classify and pack the shelf
npm run build
```

## Where things are

| Path | What it is |
|---|---|
| `src/engine/pool.ts` | One virtual pool, advanced swap by swap the way the program does it, on the SDK's math |
| `src/engine/replay.ts` | A session: fly a tape through a config, on the curve and then in the migrated pool; take orders that are not on the tape |
| `src/engine/buyout.ts` | The cost of faking a graduation under a config |
| `src/engine/design.ts`, `presets.ts` | A design as SDK builder input, as stored config, and as an Invent CLI file; the deck's own designs |
| `src/deploy.ts`, `src/dryrun.ts` | The `create_config` transaction for a design, a dry run against the live program, and the comparison of what it would store |
| `src/engine/bytes.ts`, `src/events.ts`, `src/layout.ts` | Accounts and events read from the IDL alone, for the browser |
| `src/engine/verify.ts` | Replay a pool's history against its own events and report every difference |
| `src/engine/amm.ts`, `src/migration.ts` | The migrated pool: what moves into it (held against each migration transaction), then constant-product trading |
| `src/census/` | The whole-chain census and the design table |
| `src/flows/history.ts`, `chain.ts`, `chaintape.ts`, `dbc.ts` | Pool histories from the chain, verified and turned into tapes |
| `src/flows/pumpfun.ts`, `tapes.ts`, `pack.ts`, `library.ts` | pump.fun tapes: collect, turn trades into orders, check, pack |
| `src/validate.ts`, `src/conformance.ts`, `src/probe.ts` | Engine against chain: one pool, every kind of config, and swaps nobody has made (by simulation) |
| `src/builders.ts`, `scripts/bundle-sdk.mjs` | The SDK's curve builders against the program: random inputs, any SDK checkout, what the program refuses and what it stores |
| `web/` | The deck, the evidence page, the pitch page |
| `test/` | Offline tests on frozen mainnet data |

## How it uses Meteora

- **SDK math** for every curve trade: `getSwapResultFromExactInput`, `getSwapResultFromPartialInput`, `getSwapResultFromExactOutput`, `getFeeMode`, `getBaseFeeHandler`.
- **SDK builders and validators** for every designed config: `buildCurve`, `buildCurveWithMarketCap`, `buildCurveWithLiquidityWeights`, `getMigrationThresholdPrice`, `getMigrationBaseToken`. A config that plays on Side B is one `create_config` would accept.
- **The IDL** shipped with the SDK for account layouts and event decoding. Offsets are derived, not typed in.
- **Program accounts** read directly: every `PoolConfig` and `VirtualPool` on mainnet.
- **Program events** (`EvtInitializePool`, `EvtSwap2`, `EvtCurveComplete`) as the ground truth for replays.
- **Invent CLI** as one way out: Side B exports a `dbc_config` file, dry run on.
- **`createConfig`** as the other: the SDK's own transaction, simulated against the program and then signed by the visitor's wallet.
- **`swap2`** in simulation, to get the program's own answer for swaps no history contains.

## Limits

- A replay is a stress test, not a forecast. It prices the play on the tape under another config; it does not predict how traders would adapt. Under a 50% launch fee nobody sane buys in the launch slot. REC is the honest way to see how a launch trades differently.
<!-- afterwards:start -->
- After migration the pool is modelled as full-range constant product with the config's fee rate, taken in quote or from the output token as the config says. Of the 167 DAMM v2 pools in the migration check, 153 opened as exactly that. The other 14 did not: 13 have DAMM v2's dynamic fee on (all 11 of the 11 that use a fixed fee tier get it whatever their config says), 2 have a market-cap fee schedule and 1 is a compounding pool. The deck applies none of those. Trading after migration is not replayed against DAMM v2's own swap events.
<!-- afterwards:end -->
- The trade feed shows trades, not transfers. A wallet that sells tokens it never bought on the tape is merged with the wallet that most plausibly gave them to it. Bundles come out as one trader; an unrelated pair is occasionally merged by mistake.
- Completion rates by design are confounded by who uses each design. The claim is narrow: where faking is nearly free, nearly everything completes, and that is not demand.
- The tapes cover days, not seasons. Paper trading has no latency, failed transactions or priority fees.

## Found on the way

<!-- found:start -->
- **How far a known SDK bug reaches.** In SDK 1.5.13, `StateService.getPoolConfigsByOwner(owner)` filters `PoolConfig` accounts at byte offset 72, which is `leftover_receiver`; `fee_claimer` is at offset 40. I ran into it while indexing; the SDK team had opened a fix the same day ([PR #124](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/pull/124), since folded into [#123](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/pull/123)). What the census adds is the size of it: on 2026-10-10, 200,278 of 543,738 configs on mainnet (37%) had a fee claimer different from their leftover receiver, and 1.5.13 does not return those for their fee claimer. Reproduced on mainnet: fee claimer `7AdYv1gs9xhmg87Xyh84ryHrfht4khVvBLSbDqkMTwrm` owns three configs and the call returns none.
- **Slot-based fee schedules run faster than the Invent config says.** Its comments size them at 0.4 s a slot. Block times sampled 100,000 slots apart on 2026-10-10 give 0.219 s a slot, so a schedule written as "60 seconds" in slots lasts about 33. Designs made here count in seconds (timestamp activation).
- **Old histories remember old programs.** A longer run over 673 pools first turned up 13 that did not replay. None was a fault in today's SDK math; they came down to three things, and the replay now deals with each.
  - *An older swap event.* Before program release 0.1.6 (19 August 2025) a swap emitted only `EvtSwap`. The replay used to skip those, so every later swap drifted. It now reads them: 3,022 swaps recorded that way replay to the lamport.
  - *Holes in the fetched history.* The public RPC reported one transaction as missing and kept another without its inner instructions, and the collector dropped both without a word. A transaction a node cannot give whole is now asked of a second archive, and a pool with a hole left in it is reported as such instead of being replayed.
  - *Older builds of the program.* 7 pools disagree with today's math, and should. Six were completed between 20 October and 3 November 2025 by one exact-in buy of the threshold plus one lamport, which ran past the migration price onto the curve's thin tail (config `2CY1F7f3…`). Release 0.1.7 (4 November 2025) stops an exact-in buy at the migration price; asked by simulation, the live program refuses that buy today. The seventh, from May 2025, paid exactly 50% where today's math adds the dynamic fee on top: the maximum fee was 50% until release 0.1.3. They are counted as mismatches, not left out.
- **The SDK (1.5.12 and later) no longer builds rate-limiter configs**, so the deck does not offer them for new designs. Configs that already use one still load and play: 55 rate-limiter pools (873 swaps) are in the conformance run, without a mismatch.
<!-- found:end -->

## Credits

Built with Claude Code during the hackathon window. MIT licence.
