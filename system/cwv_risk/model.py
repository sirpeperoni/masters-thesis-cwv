"""Модель прогноза: обучение и загрузка.

Модель — случайный лес на перцентилях признаков изменения внутри проекта, без признаков сборки (bnd_): до сборки
и замеров они неизвестны. Это та же модель, что отбирала коммиты в эксперименте на 11 новых проектах
(ml/select_commits.py; docs/results.md): обучение на 4 проектах с полной разметкой — 1329 пар, 39 регрессий.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import joblib
import numpy as np

from ._ml import ROOT

MODELS = Path(__file__).resolve().parents[1] / "models"
DEFAULT = MODELS / "forest-v1.joblib"
TRAIN_REPOS = ["excalidraw", "mermaid-live-editor", "vuejs-docs", "monkeytype"]

# Доля регрессий по месту коммита в списке риска — эксперимент на 11 новых проектах (docs/results.md, 13–16.10.2026):
# верхние 5 % — 25 из 291, места 5–20 % — 24 из 869, ниже 20 % — 2 из 279 (случайный контроль).
LEVELS = [
    (0.05, "high", "высокий", 25 / 291),
    (0.20, "elevated", "повышенный", 24 / 869),
    (1.00, "low", "низкий", 2 / 279),
]


def train(out: Path = DEFAULT) -> dict:
    import models as M  # ml/models.py

    df = M.load(TRAIN_REPOS)
    feats = [c for c in M.feature_columns(df) if not c.startswith("bnd_")]
    X = M.repo_rank(df, df[feats])
    y = M.target(df, "any")
    clf = M.classifiers()["forest"]()
    clf.fit(X, y)
    art = {
        "model": clf,
        "features": feats,
        "importance": dict(zip(feats, map(float, clf.feature_importances_))),
        "trained_on": TRAIN_REPOS,
        "pairs": int(len(y)),
        "regressions": int(np.sum(y)),
        "created": dt.date.today().isoformat(),
        "kind": "forest-rank-v1",
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(art, out)
    return art


def load(path: Path = DEFAULT) -> dict:
    if not path.exists():
        raise SystemExit(f"нет модели {path} — сначала: cwv-risk train")
    return joblib.load(path)


def level(place_pct: float) -> tuple[str, str, float]:
    """Уровень риска по месту среди истории (0 — самый рискованный)."""
    for top, key, name, rate in LEVELS:
        if place_pct <= top:
            return key, name, rate
    return LEVELS[-1][1:]


__all__ = ["train", "load", "level", "DEFAULT", "ROOT"]
