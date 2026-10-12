# Studies on the pump.fun tapes

Two questions asked of the wallet-level tapes this repository collects (`src/flows/pumpfun.ts`): every trade of a
launch's first 45 minutes, for every launch the recorder saw, the dead ones included.

1. **Does copying wallets with a good record pay?** `wallet_follow.py`
2. **Does a creator's record say anything about their next launch?** `creator_follow.py`

Each design was fixed before any result was looked at and is written at the top of its script: who counts as a
leader, when the follower buys, the three ways out, the costs (pump.fun's 1.25% each way, the follower's own price
impact, 0.002 SOL fixed per round trip) and the baselines.

## What came out

`reports/` holds the output as printed.

**Wallets** (`wallet_follow_2026-10-11.txt`: 5,579 launches over 20 hours, wallets ranked on the first 11 hours and
followed in the last 7). Wallets with a winning record kept winning: the 303 with five or more launches and +10% or
better made +11% on what they spent in the later launches. Copying them lost: -7% per copy [95% interval -10, -4]
two slots (about 0.4 s) behind and selling when they sell, the same at 10 and 45 slots, -10% to -13% selling at 2x or
after ten minutes, -31% to -35% holding. They hold for about ten seconds. `wallet_follow_fit_only_2026-10-11.txt` is
the same on the 94% of tapes where the rebuilt curve explains every trade to 0.1% (`fit_check.py`).
`wallet_follow_2026-10-12.txt` is a later run on 8,296 launches over 30 hours: the leaders +15%, a copy -8% [-10, -5].

**Creators** (`creator_follow_2026-10-11.txt`: 5,772 launches with the creator's history). Bought 10 seconds after
the first trade and sold at 2x or after ten minutes: first-time creators -6.5% [-8.0, -4.9]; a creator with a graduate
among ten or more earlier coins -15.5% [-17.8, -13.1]. The more experienced the creator, the worse the buy.

Both are about a day of one market. Nothing here says what to buy.

## Running them

Python 3.11 or later; `stream.py` needs the `websockets` package, the rest only the standard library.

```
python studies/stream.py                           # records every launch as it happens; leave it running
node src/flows/pumpfun.ts run studies/stream.db    # tapes each recorded launch 45 minutes after it started
python studies/wallet_follow.py                    # prints the report
python studies/creator_follow.py fetch             # each creator's earlier coins, from pump.fun
python studies/creator_follow.py report
```

The tapes go to `data/tapes.db` (`TAPES_DB` points the studies somewhere else). Everything is read-only against
public endpoints: no keys, no wallet, nothing sent to the chain.
