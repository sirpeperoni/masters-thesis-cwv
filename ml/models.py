"""
Модели предсказания регрессий CWV по признакам коммита и их оценка.

    python ml/models.py --repo excalidraw [--repo other ...] [--folds 5]
    python ml/models.py --repo a --repo b --repo c --cross     # RQ4: перенос между проектами

Постановки (для каждой целевой метрики и для «регрессия хотя бы по одной»):
  • классификация: регрессия / нет (y_<m>_label == regression);
  • регрессия: величина изменения y_<m>_delta (для неё годится каждый измеренный коммит,
    а не только ~2% положительных).

Оценка — строго по времени (expanding window): коммиты сортируются по дате и делятся на
folds+1 блоков; модель обучается на всех блоках до k-го и предсказывает k-й. Предсказания
всех проверочных блоков объединяются, метрики считаются один раз по объединению — при
единицах положительных примеров в отдельных блоках их может не быть вовсе.

Модели:
  random     — случайный порядок (нижняя граница),
  bundle     — эвристика «вырос JS-бандл → риск» (score = Δ gzip JS),
  size       — эвристика «большое изменение → риск» (score = добавлено + удалено строк),
  logreg     — логистическая регрессия (log-масштаб признаков, стандартизация, веса классов),
  forest     — случайный лес (веса классов),
  lightgbm   — градиентный бустинг (веса классов, неглубокие деревья).

Метрики классификации: PR-AUC (average precision — главная при дисбалансе), ROC-AUC,
Recall@20% (доля регрессий в 20% коммитов с наибольшим риском),
Recall@20%LOC (то же, но бюджет — 20% изменённых строк: effort-aware, как в JIT-литературе).
Метрики регрессии: Spearman ρ между прогнозом и фактическим Δ, MAE против прогноза «0».

--cross (RQ4): leave-one-repo-out — обучение на всех коммитах остальных репозиториев, проверка
на отложенном целиком. Варианты моделей с суффиксом _rank обучаются на перцентилях признаков
внутри своего репозитория (снимает разницу масштабов между проектами) → ml/results/cross-<repos>.json.

--boot B (по умолчанию 1000): 95% интервалы PR-AUC, ROC-AUC, Recall@20% и парных разностей
«модель − эвристика» стратифицированным бутстрэпом по проверочным коммитам (см. bootstrap()).
Считаются для «any» и для метрик с ≥ 10 регрессиями в проверке.

Результат печатается и сохраняется в ml/results/<repos>.json.
"""

from __future__ import annotations

import argparse
import json
import warnings
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import FunctionTransformer, StandardScaler

ROOT = Path(__file__).resolve().parent.parent
FEATURE_PREFIXES = {"k", "cat", "dep", "pat", "msg", "bnd"}
# lcpObs — дополнительная метка (наблюдаемый LCP); в «any» не входит, как и в label.ts
TARGETS = ["any", "lcp", "inp", "cls", "tbt", "tbtFlow", "lcpObs"]
SEED = 42

warnings.filterwarnings("ignore", category=UserWarning)


# ─── данные ───────────────────────────────────────────────────────────────────

def load(repos: list[str]) -> pd.DataFrame:
    frames = []
    for repo in repos:
        df = pd.read_csv(ROOT / "data" / f"{repo}.features.csv")
        df["repo"] = repo
        frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    df["date"] = pd.to_datetime(df["date"], utc=True)
    return df.sort_values("date").reset_index(drop=True)


def feature_columns(df: pd.DataFrame) -> list[str]:
    cols = [c for c in df.columns if c.split("_", 1)[0] in FEATURE_PREFIXES]
    return [c for c in cols if df[c].nunique(dropna=True) > 1]  # константы бесполезны


def target(df: pd.DataFrame, name: str) -> np.ndarray | None:
    if name == "any":
        return (df["y_label"] == "regression").to_numpy(int)
    col = f"y_{name}_label"
    if col not in df:  # метки нет в этой таблице признаков (например, собрана до её появления)
        return None
    return (df[col] == "regression").to_numpy(int)


def signed_log(x):
    return np.sign(x) * np.log1p(np.abs(x))


# ─── модели ───────────────────────────────────────────────────────────────────

def classifiers() -> dict:
    return {
        "logreg": lambda: make_pipeline(
            FunctionTransformer(signed_log),
            StandardScaler(),
            LogisticRegression(C=0.1, class_weight="balanced", max_iter=2000),
        ),
        "forest": lambda: RandomForestClassifier(
            n_estimators=300, min_samples_leaf=2, class_weight="balanced_subsample", random_state=SEED, n_jobs=2
        ),
        "lightgbm": lambda: lgb.LGBMClassifier(
            n_estimators=200, learning_rate=0.05, num_leaves=7, min_child_samples=5,
            subsample=0.8, subsample_freq=1, colsample_bytree=0.7,
            class_weight="balanced", random_state=SEED, verbose=-1, n_jobs=2,
        ),
    }


def time_folds(n: int, folds: int) -> list[tuple[np.ndarray, np.ndarray]]:
    """Expanding window: блок 0 — только обучение, блоки 1..folds — по очереди проверка."""
    edges = np.linspace(0, n, folds + 2).astype(int)
    return [(np.arange(0, edges[k]), np.arange(edges[k], edges[k + 1])) for k in range(1, folds + 1)]


def predict_classification(df: pd.DataFrame, X: pd.DataFrame, y: np.ndarray, folds: int) -> dict[str, np.ndarray]:
    """Прогнозы на всех проверочных блоках; NaN — для строк первого (обучающего) блока."""
    n = len(df)
    rng = np.random.default_rng(SEED)
    scores = {name: np.full(n, np.nan) for name in ["random", "bundle", "size", *classifiers()]}
    for train, test in time_folds(n, folds):
        scores["random"][test] = rng.random(len(test))
        scores["bundle"][test] = df["bnd_js_gzip"].fillna(0).to_numpy()[test]
        scores["size"][test] = (df["k_la"] + df["k_ld"]).to_numpy()[test]
        for name, make in classifiers().items():
            if y[train].sum() == 0:  # в прошлом ещё нет ни одной регрессии — модели не на чем учиться
                scores[name][test] = 0.0
                continue
            model = make()
            model.fit(X.iloc[train].fillna(0), y[train])
            scores[name][test] = model.predict_proba(X.iloc[test].fillna(0))[:, 1]
    return scores


# ─── метрики ──────────────────────────────────────────────────────────────────

def recall_at(scores: np.ndarray, y: np.ndarray, effort: np.ndarray, budget: float = 0.2) -> float:
    """Доля найденных регрессий, если проверить коммиты с наибольшим риском в пределах бюджета усилий."""
    if y.sum() == 0:
        return float("nan")
    order = np.argsort(-scores, kind="stable")
    spent = np.cumsum(effort[order]) / effort.sum()
    chosen = order[spent <= budget + 1e-12]
    return float(y[chosen].sum() / y.sum())


def classification_metrics(scores: np.ndarray, y: np.ndarray, loc: np.ndarray) -> dict[str, float]:
    mask = ~np.isnan(scores)
    s, t, l = scores[mask], y[mask], np.maximum(loc[mask], 1)
    if t.sum() == 0 or t.sum() == len(t):
        return {"pr_auc": float("nan"), "roc_auc": float("nan"), "recall@20%": float("nan"), "recall@20%LOC": float("nan")}
    return {
        "pr_auc": float(average_precision_score(t, s)),
        "roc_auc": float(roc_auc_score(t, s)),
        "recall@20%": recall_at(s, t, np.ones_like(s)),
        "recall@20%LOC": recall_at(s, t, l.astype(float)),
    }


def regression_eval(df: pd.DataFrame, X: pd.DataFrame, metric: str, folds: int) -> dict[str, dict[str, float]]:
    """Предсказание величины Δ: LightGBM и Ridge против прогноза «0» (изменений нет)."""
    y = df[f"y_{metric}_delta"].to_numpy(float)
    ok = ~np.isnan(y)
    n = len(df)
    preds = {"zero": np.full(n, np.nan), "ridge": np.full(n, np.nan), "lightgbm": np.full(n, np.nan)}
    for train, test in time_folds(n, folds):
        tr = train[ok[train]]
        preds["zero"][test] = 0.0
        ridge = make_pipeline(FunctionTransformer(signed_log), StandardScaler(), Ridge(alpha=10.0))
        ridge.fit(X.iloc[tr].fillna(0), y[tr])
        preds["ridge"][test] = ridge.predict(X.iloc[test].fillna(0))
        gbm = lgb.LGBMRegressor(
            n_estimators=200, learning_rate=0.05, num_leaves=7, min_child_samples=10,
            objective="huber", random_state=SEED, verbose=-1, n_jobs=2,
        )
        gbm.fit(X.iloc[tr], y[tr])
        preds["lightgbm"][test] = gbm.predict(X.iloc[test])
    out = {}
    for name, p in preds.items():
        m = ~np.isnan(p) & ok
        rho = spearmanr(p[m], y[m]).statistic if name != "zero" else float("nan")
        out[name] = {"spearman": float(rho), "mae": float(np.mean(np.abs(p[m] - y[m])))}
    return out


BASELINES = ("random", "bundle", "size")
CI_KEYS = ("pr_auc", "roc_auc", "recall@20%")


def bootstrap(scores: dict[str, np.ndarray], y: np.ndarray, loc: np.ndarray, B: int) -> dict:
    """95% интервалы метрик и разностей «модель − эвристика» стратифицированным бутстрэпом.

    Проверочные коммиты перевыбираются с возвращением отдельно среди регрессий и среди остальных:
    число регрессий в каждой выборке как в исходной (при 3–11 положительных простой бутстрэп часто
    давал бы выборки без них). Интервалы поэтому отражают неопределённость «какие именно коммиты
    попали в проверку», но не неопределённость доли регрессий. Все модели оцениваются на одних и тех же
    выборках — разности парные. p_not_better — доля выборок, где модель не лучше эвристики.
    """
    mask = ~np.isnan(next(iter(scores.values())))
    yy, ll = y[mask], loc[mask]
    S = {n: s[mask] for n, s in scores.items()}
    pos, neg = np.flatnonzero(yy == 1), np.flatnonzero(yy == 0)
    rng = np.random.default_rng(SEED)
    vals = {n: {k: np.empty(B) for k in CI_KEYS} for n in S}
    for b in range(B):
        # перемешиваем: при равных оценках (эвристика без вариации) порядок решает позиция в выборке,
        # и без перемешивания все регрессии стояли бы первыми — интервал Recall@20% уезжал к 1
        idx = rng.permutation(np.concatenate([rng.choice(pos, len(pos)), rng.choice(neg, len(neg))]))
        for n, s in S.items():
            m = classification_metrics(s[idx], yy[idx], ll[idx])
            for k in CI_KEYS:
                vals[n][k][b] = m[k]
    q = lambda a: [float(np.nanpercentile(a, 2.5)), float(np.nanpercentile(a, 97.5))]
    ci = {n: {k: q(v[k]) for k in CI_KEYS} for n, v in vals.items()}
    vs = {}
    for n in S:
        if n in BASELINES:
            continue
        for base in ("bundle", "size"):
            d = {k: vals[n][k] - vals[base][k] for k in CI_KEYS}
            vs[f"{n} − {base}"] = {k: {"ci": q(d[k]), "p_not_better": float(np.mean(d[k] <= 0))} for k in CI_KEYS}
    return {"ci": ci, "vs": vs, "B": B}


def print_results(res: dict, indent: str) -> None:
    """Таблица метрик (с 95% интервалами, если считался бутстрэп) и сравнение моделей с эвристиками."""
    boot = res.get("_bootstrap")
    fmt = lambda v, ci, w: f"{v:.2f}" + (f" [{ci[0]:.2f}; {ci[1]:.2f}]" if ci else "")
    print(f"{indent}{'модель':<14} {'PR-AUC':<18} {'ROC-AUC':<18} {'R@20%':<18} {'R@20%LOC':>8}")
    for name, m in res.items():
        if name.startswith("_"):
            continue
        ci = boot["ci"][name] if boot else {}
        print(f"{indent}{name:<14} {fmt(m['pr_auc'], ci.get('pr_auc'), 18):<18} {fmt(m['roc_auc'], ci.get('roc_auc'), 18):<18} "
              f"{fmt(m['recall@20%'], ci.get('recall@20%'), 18):<18} {m['recall@20%LOC']:>8.2f}")
    if not boot:
        return
    # каждую модель — с более сильной (по PR-AUC) из двух эвристик
    strong = max(("bundle", "size"), key=lambda b: res[b]["pr_auc"])
    print(f"{indent}модель − «{strong}» (95% интервал разности; доля выборок, где модель не лучше), B={boot['B']}:")
    for key, d in boot["vs"].items():
        if not key.endswith(f"− {strong}"):
            continue
        parts = [f"{k} {d[k]['ci'][0]:+.2f}…{d[k]['ci'][1]:+.2f} ({d[k]['p_not_better']:.0%})" for k in ("pr_auc", "recall@20%")]
        print(f"{indent}  {key.split(' − ')[0]:<14} " + "   ".join(parts))


def repo_rank(df: pd.DataFrame, X: pd.DataFrame) -> pd.DataFrame:
    """Признаки → перцентили внутри своего репозитория: снимает разницу масштабов между проектами
    (размер бандла, типичный объём коммита), оставляя «насколько коммит необычен для своего проекта»."""
    return X.fillna(0).groupby(df["repo"].to_numpy()).rank(pct=True)


def predict_cross(df: pd.DataFrame, X: pd.DataFrame, y: np.ndarray, test: np.ndarray) -> dict[str, np.ndarray]:
    """Обучение на всех коммитах остальных репозиториев, прогноз для отложенного (test — маска)."""
    rng = np.random.default_rng(SEED)
    Xr = repo_rank(df, X)
    tr, te = ~test, test
    scores = {
        "random": rng.random(te.sum()),
        "bundle": df["bnd_js_gzip"].fillna(0).to_numpy()[te],
        "size": (df["k_la"] + df["k_ld"]).to_numpy()[te],
    }
    for name, make in classifiers().items():
        for suffix, data in (("", X.fillna(0)), ("_rank", Xr)):
            model = make()
            model.fit(data[tr], y[tr])
            scores[name + suffix] = model.predict_proba(data[te])[:, 1]
    return scores


def cross_project(df: pd.DataFrame, X: pd.DataFrame, repos: list[str], B: int) -> dict:
    """RQ4: leave-one-repo-out. Время не учитывается — проекты независимы, утечки между ними нет."""
    loc = (df["k_la"] + df["k_ld"]).to_numpy(float)
    report: dict = {}
    print("ПЕРЕНОС МЕЖДУ ПРОЕКТАМИ (обучение на остальных, проверка на отложенном; _rank — перцентили внутри репозитория)")
    for held in repos:
        test = (df["repo"] == held).to_numpy()
        report[held] = {}
        print(f"\n== проверка: {held} ({test.sum()} пар), обучение: {', '.join(r for r in repos if r != held)}")
        for t in TARGETS:
            col = "y_label" if t == "any" else f"y_{t}_label"
            if col not in df or df.loc[test, col].isna().all():
                continue  # метки нет у отложенного репозитория
            y = target(df, t)
            n_tr, n_te = int(y[~test].sum()), int(y[test].sum())
            if n_te == 0 or n_tr == 0:
                print(f"  [{t}] регрессий: обучение {n_tr}, проверка {n_te} — нечего оценивать")
                continue
            scores = predict_cross(df, X, y, test)
            res = {name: classification_metrics(s, y[test], loc[test]) for name, s in scores.items()}
            res["_prevalence"] = float(y[test].mean())
            res["_positives"] = {"train": n_tr, "test": n_te}
            if B and t == "any":  # по отдельным метрикам положительных единицы — интервалы бессмысленны
                res["_bootstrap"] = bootstrap(scores, y[test], loc[test], B)
            report[held][t] = res
            warn = "  ⚠ <10 в проверке" if n_te < 10 else ""
            print(f"  [{t}] регрессий: обучение {n_tr}, проверка {n_te}; PR-AUC случайного ≈ {res['_prevalence']:.3f}{warn}")
            print_results(res, "    ")
    return report


def top_features(X: pd.DataFrame, y: np.ndarray, k: int = 12) -> list[tuple[str, float]]:
    """Важность признаков (gain) LightGBM, обученного на всех данных."""
    if y.sum() == 0:
        return []
    model = classifiers()["lightgbm"]()
    model.fit(X, y)
    gain = model.booster_.feature_importance(importance_type="gain")
    order = np.argsort(-gain)[:k]
    return [(X.columns[i], float(gain[i])) for i in order if gain[i] > 0]


# ─── main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", action="append", default=None)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--cross", action="store_true", help="перенос между проектами (RQ4), нужно ≥ 2 --repo")
    ap.add_argument("--boot", type=int, default=1000, help="выборок бутстрэпа для 95%% интервалов (0 — не считать)")
    args = ap.parse_args()
    repos = args.repo or ["excalidraw"]

    df = load(repos)
    feats = feature_columns(df)
    X = df[feats]
    if args.cross:
        if len(repos) < 2:
            raise SystemExit("--cross: укажите хотя бы два --repo")
        print(f"{'+'.join(repos)}: {len(df)} пар, {len(feats)} признаков\n")
        report = {"repos": repos, "n": len(df), "features": len(feats), "cross": cross_project(df, X, repos, args.boot)}
        out = ROOT / "ml" / "results" / f"cross-{'+'.join(repos)}.json"
        out.parent.mkdir(exist_ok=True)
        out.write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"\n→ {out}")
        return
    loc = (df["k_la"] + df["k_ld"]).to_numpy(float)
    first_test = time_folds(len(df), args.folds)[0][1][0]
    print(f"{'+'.join(repos)}: {len(df)} пар, {len(feats)} признаков, "
          f"{args.folds} блоков по времени (проверка — с {df['date'].iloc[first_test]:%Y-%m-%d})\n")

    report: dict = {"repos": repos, "n": len(df), "features": len(feats), "classification": {}, "regression": {}}

    print("КЛАССИФИКАЦИЯ «регрессия / нет» (объединённые проверочные блоки)")
    for t in TARGETS:
        y = target(df, t)
        if y is None:
            print(f"\n[{t}] нет колонки y_{t}_label — пересчитайте label и features")
            continue
        n_pos, n_pos_test = int(y.sum()), int(y[first_test:].sum())
        print(f"\n[{t}] регрессий: {n_pos} (в проверочных блоках: {n_pos_test})")
        if n_pos_test == 0:
            print("  нечего оценивать — в проверочных блоках нет регрессий")
            continue
        if n_pos < 10:
            print("  ⚠ меньше 10 положительных примеров — цифры ниже демонстрационные, не выводы")
        scores = predict_classification(df, X, y, args.folds)
        res = {name: classification_metrics(s, y, loc) for name, s in scores.items()}
        res["_prevalence"] = float(y[first_test:].mean())
        if args.boot and n_pos_test >= 10:  # при единицах регрессий интервал шире самой шкалы — не считаем
            res["_bootstrap"] = bootstrap(scores, y, loc, args.boot)
        report["classification"][t] = res
        print(f"  PR-AUC случайного ≈ {res['_prevalence']:.3f}")
        print_results(res, "  ")
        imp = top_features(X, y)
        if imp:
            print("  важные признаки (LightGBM, gain):", ", ".join(f"{n}" for n, _ in imp[:8]))

    print("\nРЕГРЕССИЯ величины Δ (Spearman ρ прогноза с фактом; MAE против прогноза «0»)")
    for t in ["lcp", "inp", "tbt", "tbtFlow"]:
        res = regression_eval(df, X, t, args.folds)
        report["regression"][t] = res
        print(f"  {t:<8} " + "  ".join(f"{n}: ρ={m['spearman']:+.3f} MAE={m['mae']:.1f}" for n, m in res.items()))

    out = ROOT / "ml" / "results" / f"{'+'.join(repos)}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\n→ {out}")


if __name__ == "__main__":
    main()
