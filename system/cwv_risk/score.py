"""Оценка риска изменения base..head относительно истории проекта."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from . import history, model
from ._ml import extract
from .labels import label


@dataclass
class Reason:
    feature: str
    label: str
    value: float
    percentile: float  # доля коммитов истории с меньшим или равным значением
    weight: float      # важность признака в модели


@dataclass
class Result:
    base: str
    head: str
    merge_base: str
    risk: float                 # вероятность по модели (по смыслу — ранг; абсолютно не калибрована)
    place: float                # доля коммитов истории, у которых риск выше (0 — самый рискованный)
    level: str
    level_name: str
    expected_rate: float        # доля регрессий среди коммитов этого уровня в эксперименте
    history: int
    lines_added: int
    lines_deleted: int
    files: int
    reasons: list[Reason] = field(default_factory=list)
    model: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def percentile_against(values: np.ndarray, x: float) -> float:
    """Перцентиль x среди values так же, как rank(pct=True, method='average') при добавлении x в набор."""
    n = len(values)
    less, equal = float(np.sum(values < x)), float(np.sum(values == x))
    return (less + (equal + 1) / 2) / (n + 1)


def assess(repo: Path, base: str, head: str, n_history: int = 300, paths: list[str] | None = None,
           model_path: Path = model.DEFAULT, top_reasons: int = 5, quiet: bool = False) -> Result:
    art = model.load(model_path)
    feats: list[str] = art["features"]
    clf = art["model"]

    mb = history.git(repo, "merge-base", base, head).strip()
    head_sha = history.git(repo, "rev-parse", head).strip()
    hist = history.features(repo, mb, n_history, paths, quiet=quiet)
    hist = hist[hist.sha != head_sha]
    if len(hist) < 30:
        raise SystemExit(f"в истории {len(hist)} коммитов — мало для шкалы (нужно хотя бы 30; увеличьте --history)")
    for c in feats:
        if c not in hist:
            hist[c] = 0.0
    H = hist[feats].fillna(0).astype(float)

    f, _ = extract(repo, head_sha, mb, {})
    x = pd.Series({c: float(f.get(c, 0.0)) for c in feats})

    # перцентили изменения относительно истории и истории относительно самой себя
    x_rank = pd.DataFrame([{c: percentile_against(H[c].to_numpy(), x[c]) for c in feats}])
    H_rank = H.rank(pct=True)
    risk = float(clf.predict_proba(x_rank)[:, 1][0])
    hist_risk = clf.predict_proba(H_rank)[:, 1]
    place = float(np.mean(hist_risk > risk)) if len(hist_risk) else 0.0
    key, name, rate = model.level(place)

    # объяснение: признаки, по которым изменение необычно велико для проекта, по убыванию «важность × необычность»
    reasons = []
    for c in feats:
        p = float(x_rank[c].iloc[0])
        if x[c] > 0 and p >= 0.8 and art["importance"].get(c, 0) > 0:
            reasons.append(Reason(c, label(c), float(x[c]), p, art["importance"][c]))
    reasons.sort(key=lambda r: r.weight * (r.percentile - 0.5), reverse=True)

    return Result(
        base=base, head=head, merge_base=mb, risk=risk, place=place, level=key, level_name=name, expected_rate=rate,
        history=len(hist), lines_added=int(x.get("k_la", 0)), lines_deleted=int(x.get("k_ld", 0)),
        files=int(x.get("k_nf", 0)), reasons=reasons[:top_reasons],
        model={k: art[k] for k in ("kind", "trained_on", "pairs", "regressions", "created")},
    )
