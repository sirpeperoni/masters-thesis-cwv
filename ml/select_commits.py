"""
Выборочный сбор: модель отбирает коммиты нового репозитория для замеров (эксперимент «система на новом проекте»).

    python ml/select_commits.py --repo drawdb [--top 0.2] [--random 0.1] [--split]

1. Коммиты — как у стенда: first-parent история ветки с даты since и по pathsFilter конфига
   bench/repos/<repo>.ts; база коммита — предыдущий коммит этого списка (у первого — git-родитель).
2. Признаки — из diff база → коммит (ml/features.py) БЕЗ сборки: признаки размера сборки (bnd_*) до замеров
   неизвестны, поэтому модель для отбора обучается без них (RQ3: потеря незначима).
3. Модель — случайный лес на перцентилях признаков внутри проекта (вариант _rank из models.py — лучший при
   переносе), обучение на всех размеченных проектах.
4. Список: доля --top коммитов с наибольшим прогнозом («risk») + доля --random случайных из остальных
   («random» — контроль: по нему оценивается, сколько регрессий модель пропустила).
   → data/<repo>.selection.csv (порядок истории); все прогнозы — data/<repo>.scores.csv.
   С --split случайный контроль пишется отдельно — data/<repo>.selection-random.csv: сначала собирают
   «risk», контроль — когда есть время.

Сбор: npm run bench -- --repo <repo> --shas-file data/<repo>.selection.csv
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import models as M  # noqa: E402
from features import extract, git  # noqa: E402

ROOT = M.ROOT
TRAIN_REPOS = ["excalidraw", "mermaid-live-editor", "vuejs-docs", "monkeytype"]


def repo_config(repo: str) -> tuple[str, str, str | None, list[str]]:
    """branch, since, until и pathsFilter из TS-конфига стенда (простые строковые литералы)."""
    src = (ROOT / "bench" / "repos" / f"{repo}.ts").read_text(encoding="utf-8")
    branch = re.search(r"branch:\s*'([^']+)'", src).group(1)
    since = re.search(r"since:\s*'([^']+)'", src).group(1)
    until = re.search(r"until:\s*'([^']+)'", src)
    paths = re.findall(r"'([^']+)'", re.search(r"pathsFilter:\s*\[([^\]]*)\]", src, re.S).group(1))
    return branch, since, until.group(1) if until else None, paths


def commits(repo: str) -> list[dict]:
    branch, since, until, paths = repo_config(repo)
    repo_dir = ROOT / "work" / "repos" / repo
    since = since if " " in since else f"{since} 00:00:00"  # как git.ts: дата без времени — начало суток
    rng = [f"--since={since}"]
    if until:
        rng.append(f"--until={until if ' ' in until else until + ' 23:59:59'}")  # как git.ts — конец суток
    out = git(repo_dir, "log", "--first-parent", "--reverse", *rng,
              "--format=%H%x1f%P%x1f%cI%x1f%s", f"origin/{branch}", "--", *paths)
    rows = []
    for line in out.splitlines():
        sha, parents, date, subject = line.split("\x1f")
        rows.append({"sha": sha, "parent": parents.split(" ")[0], "date": date, "subject": subject})
    for i, r in enumerate(rows):
        r["base"] = rows[i - 1]["sha"] if i else r["parent"]
    # корневой коммит репозитория (диапазон с самого начала) сравнивать не с чем — стенд даст no_base
    return [r for r in rows if r["base"]]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--top", type=float, default=0.2)
    ap.add_argument("--random", type=float, default=0.1)
    ap.add_argument("--split", action="store_true", help="случайный контроль — в отдельный файл")
    args = ap.parse_args()

    # обучение: все размеченные проекты, без признаков сборки
    train = M.load(TRAIN_REPOS)
    feats = [c for c in M.feature_columns(train) if not c.startswith("bnd_")]
    y = M.target(train, "any")
    Xr = M.repo_rank(train, train[feats])
    model = M.classifiers()["forest"]()
    model.fit(Xr, y)
    print(f"модель: случайный лес на перцентилях, {len(feats)} признаков без bnd_, обучение — {len(train)} пар, {int(y.sum())} регрессий")

    # признаки нового репозитория — только по diff
    repo_dir = ROOT / "work" / "repos" / args.repo
    rows = commits(args.repo)
    print(f"{args.repo}: {len(rows)} коммитов в диапазоне; считаю признаки по diff…")
    feat_rows = []
    for i, r in enumerate(rows, start=1):
        f, _ = extract(repo_dir, r["sha"], r["base"], {})
        feat_rows.append({**r, **f})
        if i % 50 == 0:
            print(f"  [{i}/{len(rows)}]")
    df = pd.DataFrame(feat_rows)
    df["repo"] = args.repo
    for c in feats:
        if c not in df:
            df[c] = 0.0
    Xn = M.repo_rank(df, df[feats])  # перцентили — внутри нового проекта
    df["score"] = model.predict_proba(Xn)[:, 1]
    df["rank_pct"] = df["score"].rank(pct=True, ascending=False)

    n = len(df)
    n_top, n_rand = round(args.top * n), round(args.random * n)
    top = df.nlargest(n_top, "score").index
    rest = df.index.difference(top)
    rand = pd.Index(np.random.default_rng(M.SEED).choice(rest, size=min(n_rand, len(rest)), replace=False))
    df["selection"] = ""
    df.loc[top, "selection"] = "risk"
    df.loc[rand, "selection"] = "random"
    cols = ["sha", "base", "date", "selection", "score", "rank_pct", "k_la", "k_ld", "subject"]
    df[cols].to_csv(ROOT / "data" / f"{args.repo}.scores.csv", index=False)
    if args.split:
        df[df.selection == "risk"][cols].to_csv(ROOT / "data" / f"{args.repo}.selection.csv", index=False)
        df[df.selection == "random"][cols].to_csv(ROOT / "data" / f"{args.repo}.selection-random.csv", index=False)
        print(f"→ data/{args.repo}.selection.csv: {n_top} по риску; data/{args.repo}.selection-random.csv: {len(rand)} случайных; из {n}")
    else:
        sel = df[df.selection != ""][cols]
        sel.to_csv(ROOT / "data" / f"{args.repo}.selection.csv", index=False)
        print(f"→ data/{args.repo}.selection.csv: {len(sel)} коммитов ({n_top} по риску + {len(rand)} случайных) из {n}")
    print("  самые рискованные:")
    for _, r in df.nlargest(8, "score").iterrows():
        print(f"    {r.sha[:8]} {r.date[:10]} p={r.score:.2f} +{int(r.k_la)}/-{int(r.k_ld)}  {r.subject[:70]}")


if __name__ == "__main__":
    main()
