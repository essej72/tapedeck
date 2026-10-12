"""Creator-following on pump.fun launches: does a creator's record say anything about their next launch?

The claim from the videos: check the dev's earlier coins; buy a "good dev's" next launch early. Tested on every launch
the Tapedeck collector taped (all trades for the first 45 minutes, data/tapes.db), not on survivors.

    python studies/creator_follow.py fetch      # each creator's launch history from pump.fun (about 55 a minute), resumable
    python studies/creator_follow.py report

Design, fixed before looking at any result:
  record     the creator's earlier coins, counting only those created 2+ hours before this launch (the history is read
             today, so a coin from minutes earlier would leak its outcome): how many, how many graduated, best peak.
  groups     first coin | 1-4 earlier, none graduated | 5+ earlier, none graduated |
             a graduate among fewer than 10 | a graduate among 10+ | best earlier peak of $100k or more (overlaps)
  the buy    0.2 SOL at the curve state 10 s and 60 s after the launch's first trade; out at 2x or after 10 minutes,
             or held to the end of the 45-minute tape. pump.fun's 1.25% each way, own impact, 0.002 SOL fixed.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from wallet_follow import Tape, follow, load, summarise

F3 = "https://frontend-api-v3.pump.fun"
H = {"User-Agent": "Mozilla/5.0", "Accept": "application/json", "Origin": "https://pump.fun", "Referer": "https://pump.fun/"}


def get(url: str, tries: int = 8):
    """One paced request (pump.fun allows this endpoint 60 a minute); None for a creator it does not know."""
    for attempt in range(tries):
        time.sleep(1.1)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=30) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(float(e.headers.get("retry-after") or 60) + 2)
                continue
            if e.code in (400, 404):
                return None
            time.sleep(2.0 * (attempt + 1))
        except Exception:  # noqa: BLE001 - network hiccup
            time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"gave up on {url[:90]}")

HERE = Path(__file__).resolve().parent
DB = HERE / "creators.db"
SETTLED_S = 2 * 3600


def conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB)
    c.execute("CREATE TABLE IF NOT EXISTS creators (creator TEXT PRIMARY KEY, n_coins INTEGER, coins TEXT, fetched REAL)")
    return c


def fetch() -> None:
    c = conn()
    have = {r[0] for r in c.execute("SELECT creator FROM creators")}
    todo = sorted({t.creator for t in load() if t.creator} - have)
    print(f"{len(todo)} creators to read, {len(have)} already stored", flush=True)
    for i, creator in enumerate(todo):
        body = get(f"{F3}/coins-v2/user-created-coins/{creator}?offset=0&limit=100&includeNsfw=true")
        coins = [{"mint": x.get("mint"), "created": int(x.get("created_timestamp") or 0) // 1000, "complete": bool(x.get("complete")),
                  "ath": x.get("ath_market_cap")} for x in (body or {}).get("coins") or []]
        n = int((body or {}).get("count") or len(coins)) if body else -1
        c.execute("INSERT OR REPLACE INTO creators VALUES (?,?,?,?)", (creator, n, json.dumps(coins), time.time()))
        if i % 50 == 49:
            c.commit()
            print(f"{time.strftime('%H:%M:%S')} {i + 1}/{len(todo)}", flush=True)
    c.commit()


def group_of(prior: list[dict], total: int) -> list[str]:
    n = len(prior)
    grads = sum(p["complete"] for p in prior)
    best = max((p["ath"] or 0 for p in prior), default=0)
    out = []
    if n == 0:
        out.append("first coin")
    elif grads == 0:
        out.append("1-4 earlier, none graduated" if n < 5 else "5+ earlier, none graduated")
    else:
        out.append("a graduate among fewer than 10" if n < 10 else "a graduate among 10 or more")
    if best >= 100_000:
        out.append("best earlier peak $100k+")
    return out


def report() -> None:
    hist = {r[0]: (r[1], json.loads(r[2])) for r in conn().execute("SELECT creator, n_coins, coins FROM creators WHERE n_coins >= 0")}
    tapes = [t for t in load() if t.creator in hist]
    stamp = lambda s: time.strftime("%m-%d %H:%M", time.gmtime(s))
    print(f"CREATOR-FOLLOWING   {len(tapes)} launch tapes with the creator's history, {stamp(tapes[0].launch)} to {stamp(tapes[-1].launch)} UTC")
    counts: dict[str, int] = {}
    capped = 0
    for wait in (10, 60):
        for rule in ("2x/10m", "hold"):
            cells: dict[str, dict[str, list[float]]] = {}
            for t in tapes:
                total, coins = hist[t.creator]
                capped += total > len(coins)
                prior = [c for c in coins if c["mint"] != t.mint and 0 < c["created"] <= t.launch - SETTLED_S]
                j = t.at_time(t.ts[0] + wait, 0)
                r = follow(t, j, rule, None, 2)
                if r is None:
                    continue
                for g in group_of(prior, total) + ["all launches"]:
                    cells.setdefault(g, {})[t.mint] = [r]
            print(f"\nbuy {wait} s after the first trade, exit: {rule}")
            for g in ("all launches", "first coin", "1-4 earlier, none graduated", "5+ earlier, none graduated", "a graduate among fewer than 10", "a graduate among 10 or more", "best earlier peak $100k+"):
                print(summarise(g, cells.get(g, {})))
    print(f"\n(creators with more coins than the 100 the history returns: counted on their most recent 100)")


if __name__ == "__main__":
    {"fetch": fetch, "report": report}[sys.argv[1] if len(sys.argv) > 1 else "report"]()
