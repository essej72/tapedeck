"""Forward record: every pump.fun launch (creator, opening buy, mayhem flag) and every migration, as they happen.

Why: the public history endpoints only list tokens that already graduated, which hides every token that died first.
Rules about what to buy BEFORE graduation can only be tested fairly on a record that includes the dead ones, and
only a live recording has them. Listen-only on PumpPortal's free public stream; one connection, as they ask.
The tape collector (src/flows/pumpfun.ts run studies/stream.db) then reads every trade of each launch it recorded.

    python studies/stream.py            # runs until stopped; writes stream.db next to this file
    python studies/stream.py status

Needs the `websockets` package.
"""
from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DB = HERE / "stream.db"
# Launches and migrations are free. Per-token TRADES need a PumpPortal API key funded with 0.02 SOL (their rule,
# checked 2026-10-10); set PUMPPORTAL_API_KEY in the environment to record them, otherwise they are simply skipped.
API_KEY = os.environ.get("PUMPPORTAL_API_KEY", "").strip()
URL = "wss://pumpportal.fun/api/data" + (f"?api-key={API_KEY}" if API_KEY else "")
IDLE_DROP_S = 1800              # stop following a token after 30 minutes without a trade
POST_MIGRATION_S = 6 * 3600     # ...but keep a migrated token for up to 6 hours
SWEEP_S = 60
COMMIT_S = 2.0
REPORT_S = 300

SCHEMA = """
CREATE TABLE IF NOT EXISTS launches (
  id INTEGER PRIMARY KEY, mint TEXT UNIQUE, ts REAL, creator TEXT, name TEXT, symbol TEXT, uri TEXT,
  initial_buy REAL, sol REAL, mcap_sol REAL, mayhem INTEGER, pool TEXT, sig TEXT);
CREATE TABLE IF NOT EXISTS trades (
  launch INTEGER, ts REAL, trader TEXT, buy INTEGER, tokens REAL, sol REAL, bal REAL,
  v_sol REAL, v_tokens REAL, mcap_sol REAL, pool TEXT);
CREATE INDEX IF NOT EXISTS trades_launch ON trades(launch, ts);
CREATE TABLE IF NOT EXISTS migrations (mint TEXT, ts REAL, pool TEXT, sig TEXT);
CREATE TABLE IF NOT EXISTS sessions (started REAL, ended REAL, note TEXT);
"""


def connect_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB, timeout=60)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)
    return conn


def num(x) -> float | None:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


class Recorder:
    def __init__(self) -> None:
        self.conn = connect_db()
        self.follow: dict[str, list] = {}          # mint -> [launch id, last activity, migrated_at or None]
        self.pending_sub: list[str] = []
        self.n = {"create": 0, "trade": 0, "migrate": 0, "other": 0}
        self.last_commit = self.last_sweep = self.last_report = time.time()
        self.last_beat = 0.0

    def launch_id(self, mint: str) -> int | None:
        row = self.conn.execute("SELECT id FROM launches WHERE mint=?", (mint,)).fetchone()
        return row[0] if row else None

    def on_message(self, m: dict, now: float) -> None:
        kind = m.get("txType")
        mint = m.get("mint")
        if kind == "create" and mint:
            self.n["create"] += 1
            cur = self.conn.execute(
                "INSERT OR IGNORE INTO launches (mint,ts,creator,name,symbol,uri,initial_buy,sol,mcap_sol,mayhem,pool,sig) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (mint, now, m.get("traderPublicKey"), m.get("name"), m.get("symbol"), m.get("uri"), num(m.get("initialBuy")),
                 num(m.get("solAmount")), num(m.get("marketCapSol")), 1 if m.get("is_mayhem_mode") else 0, m.get("pool"),
                 m.get("signature")))
            lid = cur.lastrowid if cur.rowcount else self.launch_id(mint)
            if API_KEY and lid and mint not in self.follow:
                self.follow[mint] = [lid, now, None]
                self.pending_sub.append(mint)
        elif kind in ("buy", "sell") and mint:
            self.n["trade"] += 1
            f = self.follow.get(mint)
            if f is None:
                return                                  # a token we stopped following; ignore the straggler
            f[1] = now
            self.conn.execute(
                "INSERT INTO trades VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (f[0], now, m.get("traderPublicKey"), 1 if kind == "buy" else 0, num(m.get("tokenAmount")),
                 num(m.get("solAmount")), num(m.get("newTokenBalance")), num(m.get("vSolInBondingCurve")),
                 num(m.get("vTokensInBondingCurve")), num(m.get("marketCapSol")), m.get("pool")))
        elif kind == "migrate" and mint:
            self.n["migrate"] += 1
            self.conn.execute("INSERT INTO migrations VALUES (?,?,?,?)", (mint, now, m.get("pool"), m.get("signature")))
            f = self.follow.get(mint)
            if f is not None:
                f[1], f[2] = now, now
        elif "message" not in m and "errors" not in m:
            self.n["other"] += 1

    def sweep(self, now: float) -> list[str]:
        drop = [mint for mint, (_, last, mig) in self.follow.items()
                if now - last > IDLE_DROP_S or (mig is not None and now - mig > POST_MIGRATION_S)]
        for mint in drop:
            del self.follow[mint]
        return drop

    def report(self, now: float) -> None:
        print(f"{time.strftime('%m-%d %H:%M:%S', time.gmtime(now))} UTC  launches {self.n['create']}  trades {self.n['trade']}"
              f"  migrations {self.n['migrate']}  following {len(self.follow)}  other {self.n['other']}", flush=True)


async def run() -> None:
    import websockets

    rec = Recorder()
    rec.conn.execute("INSERT INTO sessions VALUES (?,?,?)", (time.time(), None, "start"))
    rec.conn.commit()
    backoff = 5.0
    while True:
        try:
            async with websockets.connect(URL, open_timeout=20, ping_interval=20, ping_timeout=20, max_size=2 ** 22) as ws:
                await ws.send(json.dumps({"method": "subscribeNewToken"}))
                await ws.send(json.dumps({"method": "subscribeMigration"}))
                held = list(rec.follow)
                for i in range(0, len(held), 200):      # after a reconnect, follow the same tokens again
                    await ws.send(json.dumps({"method": "subscribeTokenTrade", "keys": held[i:i + 200]}))
                print(f"connected; re-following {len(held)} tokens", flush=True)
                backoff = 5.0
                last_msg = time.time()
                while True:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        raw = None
                    now = time.time()
                    if raw is None and now - last_msg > 120:
                        # launches arrive every few seconds; two silent minutes means a dead socket, not a quiet market
                        raise ConnectionError("no messages for 120 s")
                    if raw is not None:
                        last_msg = now
                        try:
                            rec.on_message(json.loads(raw), now)
                        except (ValueError, sqlite3.Error) as e:
                            print(f"bad message skipped: {e!r}"[:160], flush=True)
                    if rec.pending_sub:
                        keys, rec.pending_sub = rec.pending_sub, []
                        await ws.send(json.dumps({"method": "subscribeTokenTrade", "keys": keys}))
                    if now - rec.last_commit >= COMMIT_S:
                        rec.conn.commit()
                        rec.last_commit = now
                    if now - rec.last_sweep >= SWEEP_S:
                        rec.last_sweep = now
                        drop = rec.sweep(now)
                        for i in range(0, len(drop), 200):
                            await ws.send(json.dumps({"method": "unsubscribeTokenTrade", "keys": drop[i:i + 200]}))
                    if now - rec.last_report >= REPORT_S:
                        rec.last_report = now
                        rec.report(now)
                    if now - rec.last_beat >= 20:
                        rec.last_beat = now
                        (HERE / "stream.alive").write_text(f"{now:.0f}", encoding="utf-8")   # heartbeat for outside checks
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - any drop: note the gap, wait, reconnect
            rec.conn.commit()
            rec.conn.execute("INSERT INTO sessions VALUES (?,?,?)", (time.time(), None, f"reconnect after {e!r}"[:200]))
            rec.conn.commit()
            print(f"disconnected ({e!r}); retrying in {backoff:.0f}s"[:200], flush=True)
            await asyncio.sleep(backoff)
            backoff = min(120.0, backoff * 2)


def status() -> None:
    conn = connect_db()
    a = conn.execute("SELECT COUNT(*), MIN(ts), MAX(ts) FROM launches").fetchone()
    t = conn.execute("SELECT COUNT(*), MAX(ts) FROM trades").fetchone()
    g = conn.execute("SELECT COUNT(*) FROM migrations").fetchone()[0]
    fmt = lambda s: time.strftime("%m-%d %H:%M:%S", time.gmtime(s)) if s else "-"  # noqa: E731
    print(f"launches {a[0]} ({fmt(a[1])} .. {fmt(a[2])} UTC)  trades {t[0]} (last {fmt(t[1])})  migrations {g}")
    print("pools seen in trades:", conn.execute("SELECT pool, COUNT(*) FROM trades GROUP BY pool").fetchall())
    print("reconnects:", conn.execute("SELECT COUNT(*) FROM sessions WHERE note LIKE 'reconnect%'").fetchone()[0],
          f"  file {DB.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "status":
        status()
    else:
        asyncio.run(run())
