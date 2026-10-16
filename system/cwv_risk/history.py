"""История проекта: признаки последних N коммитов основной ветки — шкала, относительно которой оценивается изменение.

Признаки модели — перцентили внутри проекта («насколько изменение необычно для этого проекта»), поэтому нужна
история. Коммиты — first-parent история ветки до базы изменения (как у стенда: слияние PR — одно изменение),
каждый сравнивается со своим первым родителем. Признаки кешируются в <репозиторий>/.cwv-risk/history.csv по sha.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Callable

import pandas as pd

from ._ml import extract


def git(repo: Path, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(repo), "-c", "core.longPaths=true", *args],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise SystemExit(f"git {' '.join(args)}: {r.stderr.strip()[:300]}")
    return r.stdout


def commits(repo: Path, base: str, n: int, paths: list[str]) -> list[tuple[str, str]]:
    """(sha, первый родитель) последних n коммитов first-parent истории до base включительно."""
    out = git(repo, "log", "--first-parent", f"-n{n}", "--format=%H %P", base, "--", *paths)
    rows = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2:  # корневой коммит сравнить не с чем
            rows.append((parts[0], parts[1]))
    return rows


def features(repo: Path, base: str, n: int = 300, paths: list[str] | None = None, quiet: bool = False,
             progress: Callable[[int, int], None] | None = None) -> pd.DataFrame:
    """Признаки последних n коммитов; progress(i, всего) — для панели (клон стороннего проекта считается минутами)."""
    cache_dir = repo / ".cwv-risk"
    cache_dir.mkdir(exist_ok=True)
    cache = cache_dir / "history.csv"
    old = pd.read_csv(cache) if cache.exists() else pd.DataFrame(columns=["sha"])
    known = set(old.sha)
    todo = [(s, p) for s, p in commits(repo, base, n, paths or []) if s not in known]
    rows = []

    def save() -> None:
        nonlocal old, rows
        if rows:
            old = pd.concat([old, pd.DataFrame(rows)], ignore_index=True)
            old.to_csv(cache, index=False)
            rows = []

    for i, (sha, parent) in enumerate(todo, 1):
        f, _ = extract(repo, sha, parent, {})
        rows.append({"sha": sha, "parent": parent, **f})
        if progress:
            progress(i, len(todo))
        if i % 25 == 0 or i == len(todo):
            save()  # кеш по ходу: прерванный расчёт продолжится с места остановки
            if not quiet:
                print(f"  история: признаки {i}/{len(todo)}", file=sys.stderr, flush=True)
    save()
    wanted = [s for s, _ in commits(repo, base, n, paths or [])]
    return old.set_index("sha").loc[[s for s in wanted if s in set(old.sha)]].reset_index()
