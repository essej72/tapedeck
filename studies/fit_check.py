"""Sanity check for wallet_follow.py: does the rebuilt curve state explain every recorded curve trade?

Writes misfit_mints.txt next to this file: the tapes with any trade off by more than 0.1%, which FIT_ONLY=1 leaves out.

    python studies/fit_check.py
"""
import statistics
from pathlib import Path

from wallet_follow import VS0, K, load

tapes = load()
bad = []
worst_all = []
for t in tapes:
    vs = VS0
    worst = 0.0
    for buy, amm, lam, tok in zip(t.buy, t.amm, t.lam, t.tok):
        if amm:
            break
        if buy:
            model = K / vs - K / (vs + lam)
            worst = max(worst, abs(model / tok - 1))
            vs += lam
        else:
            model = vs - K / (K / vs + tok)
            worst = max(worst, abs(model / lam - 1))
            vs -= lam
    worst_all.append(worst)
    if worst > 0.001:
        bad.append((t.mint, worst, len(t.slot)))
print(f"{len(tapes)} tapes; worst per-trade error: median {statistics.median(worst_all):.2e}, 95th pct {sorted(worst_all)[int(.95*len(worst_all))]:.2e}")
print(f"tapes with any trade off by more than 0.1%: {len(bad)} ({len(bad)/len(tapes):.1%}); of those with 50+ trades: {sum(1 for b in bad if b[2] >= 50)}")
(Path(__file__).resolve().parent / "misfit_mints.txt").write_text("\n".join(b[0] for b in bad))
