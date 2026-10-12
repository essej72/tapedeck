"""Wallet-following on pump.fun launches: does copying wallets with a good record pay?

Data: the wallet-level trade tapes the Tapedeck collector takes of every launch it can, 45 minutes after launch
(data/tapes.db: pf_tape, pf_trades; TAPES_DB points somewhere else). Launch tapes only: graduate tapes are picked by
outcome.

Design, fixed before looking at any result:
  discovery  launches in the first part of the period. Each wallet's record there: mints bought, SOL in, SOL out.
             Tokens still held at the end of a tape count as zero.
  leaders    G1: 5+ mints and realised return of +10% or more on all SOL spent
             G2: 10+ mints and +10% or more
             G3: the 100 wallets with the most realised profit in SOL, 5+ mints
  test       launches after the split. One follow per mint: at the first buy by any leader (never the creator),
             the follower buys 0.2 SOL at the curve state `delay` slots later and leaves by one of three rules:
               mirror   when that leader first sells (plus the delay); at the end of the tape if it never does
               2x/10m   at twice the entry price, or 10 minutes after entry, whichever comes first
               hold     at the end of the 45-minute tape
  costs      pump.fun's 1.25% each way, the follower's own price impact, and 0.002 SOL per round trip for fees/tips
  baselines  the same follow on (a) every wallet's first buy in any test mint, one draw per mint,
             and (b) every other wallet's first buy in the mints the leaders chose

    python studies/wallet_follow.py [split_fraction]
    FIT_ONLY=1 python studies/wallet_follow.py      # only tapes whose every curve trade the rebuilt curve explains
                                                    # (the list comes from studies/fit_check.py)
"""
from __future__ import annotations

import bisect
import os
import random
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
DB = Path(os.environ.get("TAPES_DB") or HERE.parent / "data" / "tapes.db")
VS0, VT0 = 30e9, 1_073_000_000e6          # pump.fun's virtual reserves at launch: lamports, token units
K = VS0 * VT0
CURVE_TOKENS = 793_100_000e6               # tokens the curve sells before it graduates
FEE = 0.0125
AMM_HAIRCUT = 0.0175                       # fee plus impact for a small sale after graduation
BUDGET = 0.2e9                             # what the follower sends, lamports
FIXED = 0.002e9                            # network fees and tips for the round trip
DELAYS = (2, 10, 45)                       # slots after the leader's buy (about 0.4 s, 2 s, 10 s)
random.seed(7)


class Tape:
    __slots__ = ("mint", "creator", "launch", "slot", "ts", "wallet", "buy", "amm", "lam", "tok", "vs", "price")

    def __init__(self, mint, creator, launch, rows):
        self.mint, self.creator, self.launch = mint, creator, launch
        self.slot, self.ts, self.wallet, self.buy, self.amm, self.lam, self.tok = [], [], [], [], [], [], []
        self.vs, self.price = [], []       # curve SOL reserve after each trade (None once graduated), price after it
        vs = VS0
        for slot, ts, wallet, buy, amm, lam, tok in rows:
            if lam <= 0 or tok <= 0:
                continue
            self.slot.append(slot); self.ts.append(ts); self.wallet.append(wallet); self.buy.append(buy)
            self.amm.append(amm); self.lam.append(lam); self.tok.append(tok)
            if amm:
                self.vs.append(None)
                self.price.append(lam / tok)
            else:
                vs = vs + lam if buy else vs - lam
                self.vs.append(vs)
                self.price.append(vs * vs / K)      # marginal lamports per token unit: vs / vt, vt = K / vs

    def at_slot(self, slot: int, floor: int) -> int:
        """Index of the last trade at or before `slot`, never before index `floor`."""
        return max(floor, bisect.bisect_right(self.slot, slot) - 1)

    def at_time(self, ts: float, floor: int) -> int:
        return max(floor, bisect.bisect_right(self.ts, ts) - 1)


def load() -> list[Tape]:
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    metas = db.execute("SELECT mint, creator, launch_ts FROM pf_tape WHERE kind='launch' AND complete=1 AND n > 0 AND COALESCE(mayhem,0)=0").fetchall()
    tapes = []
    # FIT_ONLY=1 leaves out tapes where the rebuilt curve does not explain every trade to 0.1% (fit_check_tmp.py)
    misfit = set((HERE / "misfit_mints.txt").read_text().split()) if os.environ.get("FIT_ONLY") and (HERE / "misfit_mints.txt").exists() else set()
    for mint, creator, launch in metas:
        if mint in misfit:
            continue
        rows = db.execute("SELECT slot, ts, wallet, buy, amm, lamports, tokens FROM pf_trades WHERE mint=? ORDER BY slot, seq", (mint,)).fetchall()
        t = Tape(mint, creator, launch, rows)
        if t.slot:
            tapes.append(t)
    return sorted(tapes, key=lambda t: t.launch)


def follow(t: Tape, j: int, exit_rule: str, leader_sell: int | None, delay: int) -> float | None:
    """Return of a follower who buys at the state after trade j and leaves by the rule. None if it cannot buy."""
    vs = t.vs[j]
    if vs is None:
        return None                         # already graduated: nothing to follow on the curve
    x = BUDGET / (1 + FEE)
    vt = K / vs
    q = vt - K / (vs + x)
    if q <= 0 or (VT0 - vt) + q > CURVE_TOKENS:
        return None
    entry_price = (vs + x) ** 2 / K
    last = len(t.slot) - 1
    if exit_rule == "mirror":
        e = last if leader_sell is None else t.at_slot(t.slot[leader_sell] + delay, leader_sell)
    elif exit_rule == "hold":
        e = last
    else:                                   # 2x or 10 minutes
        e = t.at_time(t.ts[j] + 600, j)
        for i in range(j + 1, e + 1):
            if t.price[i] >= 2 * entry_price:
                e = t.at_slot(t.slot[i] + delay, i)
                break
    if t.vs[e] is None:
        out = q * t.price[e] * (1 - AMM_HAIRCUT)
    else:
        vs_e = t.vs[e] + x                  # the curve with the follower's SOL still in it
        out = (vs_e - K / (K / vs_e + q)) * (1 - FEE)
    return (out - BUDGET - FIXED) / (BUDGET + FIXED)


def records(tapes: list[Tape]) -> dict[str, dict]:
    rec: dict[str, dict] = defaultdict(lambda: {"mints": 0, "spent": 0.0, "got": 0.0, "wins": 0})
    for t in tapes:
        per: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
        for w, buy, lam in zip(t.wallet, t.buy, t.lam):
            if w == t.creator:
                continue
            if buy:
                per[w][0] += lam * (1 + FEE)
            else:
                per[w][1] += lam * (1 - FEE)
        for w, (spent, got) in per.items():
            if spent <= 0:
                continue                    # sold tokens it was sent: not a record of buying
            r = rec[w]
            r["mints"] += 1; r["spent"] += spent; r["got"] += got; r["wins"] += got > spent
    return rec


def first_buys(t: Tape) -> list[tuple[int, str, int | None]]:
    """(index of first curve buy, wallet, index of its first sell after that) for every wallet but the creator."""
    seen: dict[str, int] = {}
    sells: dict[str, int] = {}
    for i, (w, buy, amm) in enumerate(zip(t.wallet, t.buy, t.amm)):
        if w == t.creator:
            continue
        if buy and not amm and w not in seen:
            seen[w] = i
        elif not buy and w in seen and w not in sells:
            sells[w] = i
    return [(i, w, sells.get(w)) for w, i in seen.items()]


def summarise(name: str, by_mint: dict[str, list[float]]) -> str:
    vals = [sum(v) / len(v) for v in by_mint.values() if v]
    if len(vals) < 5:
        return f"    {name:<34} n={len(vals)} (too few)"
    mean = sum(vals) / len(vals)
    srt = sorted(vals)
    boots = sorted(sum(random.choices(vals, k=len(vals))) / len(vals) for _ in range(2000))
    return (f"    {name:<34} n={len(vals):>4} mints  mean {mean:+7.1%}  [95% {boots[50]:+.1%}, {boots[1949]:+.1%}]  "
            f"median {srt[len(srt) // 2]:+7.1%}  positive {sum(v > 0 for v in vals) / len(vals):4.0%}")


def main() -> None:
    frac = float(sys.argv[1]) if len(sys.argv) > 1 else 0.62
    tapes = load()
    t0, t1 = tapes[0].launch, tapes[-1].launch
    split = t0 + frac * (t1 - t0)
    disc = [t for t in tapes if t.launch < split]
    test = [t for t in tapes if t.launch >= split]
    import time
    stamp = lambda s: time.strftime("%m-%d %H:%M", time.gmtime(s))
    print(f"WALLET-FOLLOWING   {len(tapes)} launch tapes, {stamp(t0)} to {stamp(t1)} UTC, each 45 minutes long")
    print(f"discovery: {len(disc)} launches before {stamp(split)}; test: {len(test)} launches after")
    print(f"follower: {BUDGET / 1e9} SOL per follow, pump.fun fee {FEE:.2%} each way, own impact, {FIXED / 1e9} SOL fixed per round trip\n")

    rec = records(disc)
    active = {w: r for w, r in rec.items() if r["mints"] >= 5}
    roi = lambda r: r["got"] / r["spent"] - 1
    leaders = {
        "G1  5+ mints, +10% realised": {w for w, r in active.items() if roi(r) >= 0.10},
        "G2 10+ mints, +10% realised": {w for w, r in active.items() if r["mints"] >= 10 and roi(r) >= 0.10},
        "G3 top 100 by SOL profit": set(sorted(active, key=lambda w: active[w]["got"] - active[w]["spent"], reverse=True)[:100]),
    }
    print(f"wallets seen in discovery: {len(rec)}; with 5+ mints: {len(active)}")
    tot_spent = sum(r["spent"] for r in active.values()); tot_got = sum(r["got"] for r in active.values())
    print(f"  the 5+ group as a whole: spent {tot_spent / 1e9:,.0f} SOL, got back {tot_got / 1e9:,.0f} SOL ({tot_got / tot_spent - 1:+.1%} realised)")
    for name, g in leaders.items():
        s = sum(active[w]["spent"] for w in g); gt = sum(active[w]["got"] for w in g)
        print(f"  {name}: {len(g)} wallets, {s / 1e9:,.0f} SOL spent, {gt / s - 1 if s else 0:+.1%} realised in discovery")

    # Do the leaders keep their record? Their own realised return in the test launches.
    rec_test = records(test)
    print("\nthe leaders' own results in the test launches (tokens still held count as zero):")
    for name, g in leaders.items():
        seen = [rec_test[w] for w in g if w in rec_test]
        s = sum(r["spent"] for r in seen); gt = sum(r["got"] for r in seen)
        print(f"  {name}: {len(seen)} of {len(g)} wallets traded again, {s / 1e9:,.0f} SOL spent, {gt / s - 1 if s else 0:+.1%} realised")
    seen = [r for w, r in rec_test.items() if w in active]
    s = sum(r["spent"] for r in seen); gt = sum(r["got"] for r in seen)
    print(f"  every wallet with 5+ discovery mints: {len(seen)} traded again, {s / 1e9:,.0f} SOL spent, {gt / s - 1 if s else 0:+.1%} realised")

    events = {t.mint: first_buys(t) for t in test}
    for delay in DELAYS:
        print(f"\nfollow {delay} slots after the leader's buy:")
        for rule in ("mirror", "2x/10m", "hold"):
            print(f"  exit: {rule}")
            for name, g in leaders.items():
                by_mint: dict[str, list[float]] = {}
                same_mint: dict[str, list[float]] = {}
                for t in test:
                    ev = sorted(e for e in events[t.mint] if e[1] in g)
                    if not ev:
                        continue
                    i, w, sell = ev[0]
                    r = follow(t, t.at_slot(t.slot[i] + delay, i), rule, sell, delay)
                    if r is not None:
                        by_mint[t.mint] = [r]
                    others = [follow(t, t.at_slot(t.slot[i2] + delay, i2), rule, s2, delay) for i2, w2, s2 in events[t.mint] if w2 not in g]
                    others = [o for o in others if o is not None]
                    if others:
                        same_mint[t.mint] = others
                print(summarise(name, by_mint))
                if name.startswith("G1"):
                    print(summarise("   other wallets, same mints", same_mint))
            anyone: dict[str, list[float]] = {}
            for t in test:
                if not events[t.mint]:
                    continue
                i, w, sell = random.choice(events[t.mint])
                r = follow(t, t.at_slot(t.slot[i] + delay, i), rule, sell, delay)
                if r is not None:
                    anyone[t.mint] = [r]
            print(summarise("any wallet, any test mint", anyone))


if __name__ == "__main__":
    main()
