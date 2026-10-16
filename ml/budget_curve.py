"""
Кривая «бюджет проверки → доля найденных регрессий» на новых проектах (выборочный сбор).

    python ml/budget_curve.py [repo ...]

Для каждого проекта измерены верхние 20 % списка модели (M20: selection, selection-band20, у drawdb — risk) и
случайный контроль из остальной части (random, random2). Оценка числа регрессий в любом множестве коммитов S —
по двум стратам: измеренные коммиты из M20 (вес |M20| / измерено в M20) и измеренные случайные коммиты за пределами
M20 (вес |вне M20| / измерено случайных вне M20). Случайные коммиты — равномерная выборка мест > 5 %, значит,
их часть за пределами M20 — равномерная выборка мест > 20 %.

Полнота при бюджете b: оценка регрессий в S / оценка регрессий во всём проекте; суммируется по проектам.
S — верхние b·N по модели (лежат в M20, считаются по измерениям) или верхние b·N по эвристике «большой коммит»
(строк добавлено + удалено; часть — в M20, часть — по случайному контролю). Случайный выбор — полнота = b.
Интервалы — бутстрэп коммитов внутри каждой страты каждого проекта.
→ ml/results/budget-curve.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
REPOS = ["chartdb", "bentopdf", "omni-tools", "shadcn-admin", "react-bits", "cobalt", "lexical", "jsoncrack", "pdfjs", "dashy", "drawdb"]
BUDGETS = [0.05, 0.10, 0.15, 0.20]
B = 5000


def load(repo: str) -> dict:
    s = pd.read_csv(DATA / f"{repo}.scores.csv")
    l = pd.read_csv(DATA / f"{repo}.labels.csv")
    l = l[(l.aa == 0) & (l.self_aa == 0) & l.status.isin(["ok", "identical_build"])]
    m = s.merge(l[["sha", "label"]], on="sha", how="left")
    rng = np.random.default_rng(7)
    m["place"] = m.score.rank(ascending=False, method="first").astype(int)
    # «большой коммит»: строк добавлено + удалено; равные — в случайном порядке
    m["size_place"] = (m.k_la + m.k_ld + rng.random(len(m)) * 1e-6).rank(ascending=False, method="first").astype(int)
    N = len(m)
    n20 = round(0.2 * N)
    in20 = m.place <= n20
    rand = m.selection.fillna("").str.startswith("random")
    # страта A: измеренные коммиты M20; страта B: измеренные случайные вне M20
    A = m[in20 & m.label.notna()].copy()
    Bs = m[~in20 & rand & m.label.notna()].copy()
    A["w"] = in20.sum() / len(A)
    Bs["w"] = (~in20).sum() / max(len(Bs), 1)
    return {"repo": repo, "N": N, "A": A, "B": Bs, "n20_measured": len(A), "n20": int(in20.sum()),
            "nB": len(Bs), "nB_total": int((~in20).sum())}


def estimate(parts: list[dict], idx: list[tuple[np.ndarray, np.ndarray]] | None = None) -> dict:
    """Полнота модели и эвристики при каждом бюджете, суммарно по проектам."""
    tot = 0.0
    model = {b: 0.0 for b in BUDGETS}
    size = {b: 0.0 for b in BUDGETS}
    for k, p in enumerate(parts):
        A, Bs = p["A"], p["B"]
        if idx is not None:
            A, Bs = A.iloc[idx[k][0]], Bs.iloc[idx[k][1]]
        ra = (A.label == "regression").to_numpy() * A.w.to_numpy()
        rb = (Bs.label == "regression").to_numpy() * Bs.w.to_numpy()
        tot += ra.sum() + rb.sum()
        for b in BUDGETS:
            nb = round(b * p["N"])
            model[b] += ra[(A.place <= nb).to_numpy()].sum()
            size[b] += ra[(A.size_place <= nb).to_numpy()].sum() + rb[(Bs.size_place <= nb).to_numpy()].sum()
    return {"total": tot, "model": {b: model[b] / tot for b in BUDGETS}, "size": {b: size[b] / tot for b in BUDGETS}}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("repos", nargs="*")
    args = ap.parse_args()
    parts = [load(r) for r in (args.repos or REPOS)]
    for p in parts:
        print(f"{p['repo']:<13} N={p['N']:>5}  верхние 20 %: измерено {p['n20_measured']}/{p['n20']}, регрессий "
              f"{int((p['A'].label == 'regression').sum())};  случайных вне 20 %: {p['nB']} (регрессий {int((p['B'].label == 'regression').sum())})")
    point = estimate(parts)
    rng = np.random.default_rng(2026)
    boots = []
    for _ in range(B):
        idx = [(rng.integers(0, len(p["A"]), len(p["A"])), rng.integers(0, max(len(p["B"]), 1), len(p["B"]))) for p in parts]
        boots.append(estimate(parts, idx))
    ci = lambda key, b: np.quantile([x[key][b] for x in boots], [0.025, 0.975])
    diff = lambda b: np.quantile([x["model"][b] - x["size"][b] for x in boots], [0.025, 0.975])
    print(f"\nоценка регрессий во всех проектах: {point['total']:.0f}")
    print(f"{'бюджет':>7} {'модель':>22} {'«большой коммит»':>22} {'модель − размер':>20} {'случайно':>9}")
    out = {"total": point["total"], "budgets": {}}
    for b in BUDGETS:
        lo, hi = ci("model", b); slo, shi = ci("size", b); dlo, dhi = diff(b)
        print(f"{b:>6.0%} {point['model'][b]:>8.0%} [{lo:.0%}; {hi:.0%}] {point['size'][b]:>9.0%} [{slo:.0%}; {shi:.0%}]"
              f" {point['model'][b] - point['size'][b]:>+8.0%} [{dlo:+.0%}; {dhi:+.0%}] {b:>8.0%}")
        out["budgets"][f"{b:.2f}"] = {"model": point["model"][b], "model_ci": [lo, hi], "size": point["size"][b],
                                      "size_ci": [slo, shi], "diff_ci": [dlo, dhi], "random": b}
    (ROOT / "ml" / "results" / "budget-curve.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print("→ ml/results/budget-curve.json")


if __name__ == "__main__":
    main()
