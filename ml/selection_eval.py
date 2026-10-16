"""
Оценка выборочного сбора на новых проектах («система на новом проекте»): насколько чаще регрессии среди
коммитов, отобранных моделью, чем среди случайных.

    python ml/selection_eval.py [--top 0.05] [repo ...]

По умолчанию — все проекты, у которых есть data/<repo>.scores.csv и data/<repo>.labels.csv.
«risk» — коммиты с местом в прогнозе ≤ top·N (у drawdb отбирались верхние 20 %, здесь берётся их начало),
«random» — случайный контроль из остальных (selection = random / random2). Учитываются только измеренные
пары (ok, identical_build), без A/A.

Для каждого проекта и в сумме: доля регрессий [95 % Клоппер – Пирсон], во сколько раз доля в «risk» выше,
точный тест Фишера (односторонний) и, для суммы, тест Кохрана – Мантеля – Хензеля (проекты — страты,
у проектов разная базовая доля регрессий). Оценка полноты при бюджете top: регрессии в «risk» против
регрессий в остальной части проекта, экстраполированных по случайному контролю.
→ ml/results/selection-eval.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import beta, fisher_exact
from statsmodels.stats.contingency_tables import StratifiedTable

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"


def cp(k: int, n: int) -> tuple[float, float]:
    """95 % интервал Клоппера – Пирсона для доли k/n."""
    if n == 0:
        return (float("nan"), float("nan"))
    lo = beta.ppf(0.025, k, n - k + 1) if k else 0.0
    hi = beta.ppf(0.975, k + 1, n - k) if k < n else 1.0
    return (float(lo), float(hi))


def load(repo: str, top: float) -> pd.DataFrame:
    s = pd.read_csv(DATA / f"{repo}.scores.csv")
    l = pd.read_csv(DATA / f"{repo}.labels.csv")
    l = l[(l.aa == 0) & (l.self_aa == 0) & l.status.isin(["ok", "identical_build"])]
    m = s.merge(l[["sha", "label"]], on="sha", how="left")
    m["measured"] = m.label.notna()
    m["reg"] = m.label == "regression"
    m["place"] = m.score.rank(ascending=False, method="first").astype(int)
    n_top = round(top * len(m))
    m["group"] = np.where(m.place <= n_top, "risk", np.where(m.selection.fillna("").str.startswith("random"), "random", ""))
    return m


def summary(m: pd.DataFrame, top: float) -> dict:
    out: dict = {"commits": len(m)}
    for g in ("risk", "random"):
        d = m[(m.group == g) & m.measured]
        k, n = int(d.reg.sum()), len(d)
        out[g] = {"measured": n, "regressions": k, "rate": k / n if n else None, "ci": cp(k, n),
                  "planned": int((m.group == g).sum())}
    r, c = out["risk"], out["random"]
    if r["measured"] and c["measured"]:
        table = [[r["regressions"], r["measured"] - r["regressions"]], [c["regressions"], c["measured"] - c["regressions"]]]
        out["fisher_p"] = float(fisher_exact(table, alternative="greater")[1])
        # полнота при бюджете top: регрессии в верхних top·N против оценки регрессий в остальной части
        n_rest = len(m) - round(top * len(m))
        est_risk = r["rate"] * round(top * len(m))
        est_rest = c["rate"] * n_rest
        out["recall_est"] = est_risk / (est_risk + est_rest) if est_risk + est_rest else None
        out["recall_low"] = est_risk / (est_risk + c["ci"][1] * n_rest) if est_risk else 0.0
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("repos", nargs="*")
    ap.add_argument("--top", type=float, default=0.05)
    args = ap.parse_args()
    repos = args.repos or sorted(
        p.name.removesuffix(".scores.csv") for p in DATA.glob("*.scores.csv") if (DATA / p.name.replace(".scores.", ".labels.")).exists()
    )

    res, tables = {}, []
    print(f"{'проект':<14} {'коммитов':>8}  {'risk: рег/изм':>14} {'доля [95 %]':>20}  {'random: рег/изм':>16} {'доля [95 %]':>20}  {'p':>6}")
    for repo in repos:
        m = load(repo, args.top)
        s = summary(m, args.top)
        res[repo] = s
        r, c = s["risk"], s["random"]
        fmt = lambda g: f"{g['rate']:.1%} [{g['ci'][0]:.1%}; {g['ci'][1]:.1%}]" if g["measured"] else "—"
        p = f"{s['fisher_p']:.3f}" if "fisher_p" in s else "—"
        print(f"{repo:<14} {s['commits']:>8}  {r['regressions']:>6}/{r['measured']:<3} ({r['planned']:>3}) {fmt(r):>20}  "
              f"{c['regressions']:>6}/{c['measured']:<3} ({c['planned']:>3}) {fmt(c):>20}  {p:>6}")
        if r["measured"] and c["measured"]:
            tables.append(np.array([[r["regressions"], r["measured"] - r["regressions"]],
                                    [c["regressions"], c["measured"] - c["regressions"]]]))

    # сумма по проектам
    tot = {g: [sum(res[x][g]["regressions"] for x in res), sum(res[x][g]["measured"] for x in res)] for g in ("risk", "random")}
    pooled = {}
    for g, (k, n) in tot.items():
        pooled[g] = {"regressions": k, "measured": n, "rate": k / n if n else None, "ci": cp(k, n)}
    print(f"\nвсего: risk {tot['risk'][0]}/{tot['risk'][1]}"
          + (f" = {pooled['risk']['rate']:.1%} [{pooled['risk']['ci'][0]:.1%}; {pooled['risk']['ci'][1]:.1%}]" if tot['risk'][1] else "")
          + f";  random {tot['random'][0]}/{tot['random'][1]}"
          + (f" = {pooled['random']['rate']:.1%} [{pooled['random']['ci'][0]:.1%}; {pooled['random']['ci'][1]:.1%}]" if tot['random'][1] else ""))
    if tot["risk"][1] and tot["random"][1] and pooled["random"]["rate"]:
        print(f"  доля регрессий среди отобранных выше в {pooled['risk']['rate'] / pooled['random']['rate']:.1f} раза")
    if len(tables) >= 2:
        # Кохран – Мантель – Хензель: общее отношение шансов с поправкой на проект (страты с нулевыми строками
        # информации не несут — исключаем их, иначе оценка не определена)
        t = [x + 0.0 for x in tables if x.sum(axis=1).min() > 0 and x.sum(axis=0).min() > 0]
        if len(t) >= 1:
            st = StratifiedTable(t)
            pooled["cmh"] = {"odds_ratio": float(st.oddsratio_pooled), "p": float(st.test_null_odds().pvalue), "strata": len(t)}
            print(f"  ОШ Мантеля – Хензеля {st.oddsratio_pooled:.2f}, p = {st.test_null_odds().pvalue:.3f} (страт {len(t)})")
    res["_pooled"] = pooled
    res["_top"] = args.top
    (ROOT / "ml" / "results").mkdir(exist_ok=True)
    (ROOT / "ml" / "results" / "selection-eval.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    print("→ ml/results/selection-eval.json")


if __name__ == "__main__":
    main()
