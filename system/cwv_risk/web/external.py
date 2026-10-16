"""Сторонние проекты: любой репозиторий GitHub — клон, история, прогноз для каждого коммита, pull request'ы.

Добавление (панель «+ Добавить проект» или POST /api/external) ставит задание в фоновую очередь (по одному):
  1. клон без содержимого файлов (`--filter=blob:none`) → work/external/<владелец>--<имя>;
  2. признаки последних N коммитов основной ветки (history.features, прогресс — в базе);
  3. прогноз для каждого коммита относительно истории проекта (как у `cwv-risk score`), уровень риска;
  4. проект появляется в списке (группа «external»).
Замер на стенде для стороннего проекта недоступен: стенду нужна конфигурация сборки и сценарий (bench/repos/).
"""

from __future__ import annotations

import datetime as dt
import json
import queue
import re
import subprocess
import threading
from pathlib import Path

import pandas as pd

from .. import history, model
from .._ml import ROOT
from . import db

EXT = ROOT / "work" / "external"
_jobs: "queue.Queue[str]" = queue.Queue()
_worker: threading.Thread | None = None


def connect():
    return db.connect()  # таблица external — в общей схеме (db.SCHEMA)


def parse(url: str) -> tuple[str, str]:
    """«https://github.com/owner/repo(.git)(/…)» или «owner/repo» → (owner/repo, slug)."""
    m = re.match(r"^\s*(?:https?://github\.com/)?([\w.-]+)/([\w.-]+?)(?:\.git)?(?:[/#?].*)?\s*$", url)
    if not m:
        raise ValueError("ожидается ссылка вида https://github.com/владелец/репозиторий или владелец/репозиторий")
    name = f"{m.group(1)}/{m.group(2)}"
    return name, name.replace("/", "--").lower()


def clone_path(slug: str) -> Path:
    """Клон проекта: сторонний — work/external/<slug>, проекты эксперимента — клоны стенда work/repos/<имя>."""
    p = EXT / slug
    return p if p.exists() else ROOT / "work" / "repos" / slug


def history_n(slug: str) -> int:
    """Длина шкалы проекта: у стороннего — выбранная при добавлении, у проектов эксперимента — 300."""
    r = connect().execute("select history from external where slug = ?", (slug,)).fetchone()
    return int(r["history"]) if r and r["history"] else 300


def github_name(slug: str) -> str | None:
    """owner/repo проекта на GitHub — для pull request'ов."""
    con = connect()
    r = con.execute("select name from external where slug = ?", (slug,)).fetchone()
    if r:
        return r["name"]
    p = con.execute("select url from projects where name = ?", (slug,)).fetchone()
    m = re.match(r"https://github\.com/([^/]+/[^/]+)", (p["url"] or "") if p else "")
    return m.group(1) if m else None


def git(repo: Path, *args: str, check: bool = True) -> str:
    r = subprocess.run(["git", "-c", "core.longPaths=true", *(["-C", str(repo)] if repo else []), *args],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args[:3])}: {(r.stderr or r.stdout).strip()[-400:]}")
    return r.stdout


# ─── задания ──────────────────────────────────────────────────────────────────

def add(url: str, n_history: int = 200, paths: list[str] | None = None) -> str:
    name, slug = parse(url)
    con = connect()
    con.execute("""insert into external (slug, name, url, branch, status, done, total, message, history, paths, added)
                   values (?,?,?,?, 'queued', 0, 0, 'в очереди', ?,?,?)
                   on conflict(slug) do update set status = 'queued', message = 'в очереди', history = excluded.history,
                   paths = excluded.paths, done = 0, total = 0""",
                (slug, name, f"https://github.com/{name}", None, n_history, json.dumps(paths or []),
                 dt.datetime.now().isoformat(timespec="seconds")))
    con.commit()
    _start()
    _jobs.put(slug)
    return slug


def _start() -> None:
    global _worker
    if _worker is None or not _worker.is_alive():
        _worker = threading.Thread(target=_loop, daemon=True, name="cwv-risk-external")
        _worker.start()


def _loop() -> None:
    while True:
        run(_jobs.get())


def resume_pending() -> None:
    """После перезапуска сервера — продолжить незаконченные задания."""
    for r in connect().execute("select slug from external where status not in ('ready', 'error')"):
        _start()
        _jobs.put(r["slug"])


def _status(slug: str, **kw) -> None:
    con = connect()
    sets = ", ".join(f"{k} = ?" for k in kw)
    con.execute(f"update external set {sets} where slug = ?", (*kw.values(), slug))
    con.commit()


def run(slug: str) -> None:
    con = connect()
    e = con.execute("select * from external where slug = ?", (slug,)).fetchone()
    if not e:
        return
    path = EXT / slug
    try:
        EXT.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            _status(slug, status="clone", message="клонирование репозитория (только история, без файлов)")
            git(None, "clone", "--filter=blob:none", "--no-checkout", e["url"] + ".git", str(path))
        else:
            _status(slug, status="clone", message="получение новых коммитов")
            git(path, "fetch", "--quiet", "origin")
        git(path, "remote", "set-head", "origin", "--auto", check=False)
        branch = git(path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").strip().removeprefix("origin/")
        _status(slug, branch=branch, status="features", message="признаки изменений по истории", done=0)

        last = [0]

        def progress(i: int, total: int) -> None:
            if i - last[0] >= 5 or i == total:
                last[0] = i
                _status(slug, done=i, total=total)

        H = history.features(path, f"origin/{branch}", e["history"], json.loads(e["paths"] or "[]"), quiet=True,
                             progress=progress)
        if len(H) < 30:
            raise RuntimeError(f"в истории ветки {branch} всего {len(H)} коммитов — мало для шкалы проекта (нужно ≥ 30)")
        _status(slug, status="scoring", message="прогноз для каждого коммита")
        score_history(slug, e["name"], e["url"], path, branch, H)
        _status(slug, status="ready", message="готово", finished=dt.datetime.now().isoformat(timespec="seconds"))
    except (Exception, SystemExit) as ex:  # noqa: BLE001
        _status(slug, status="error", message=str(ex)[:500])


def score_history(slug: str, name: str, url: str, path: Path, branch: str, H: pd.DataFrame) -> None:
    """Прогноз для каждого коммита истории относительно самой истории — как место коммита в `cwv-risk score`."""
    art = model.load()
    feats = art["features"]
    for c in feats:
        if c not in H:
            H[c] = 0.0
    X = H[feats].fillna(0).astype(float)
    risk = art["model"].predict_proba(X.rank(pct=True))[:, 1]
    order = (-risk).argsort(kind="stable")
    place = [0.0] * len(H)
    for rank, i in enumerate(order):
        place[i] = rank / len(H)
    info = {}
    for line in git(path, "log", "--first-parent", f"-n{len(H) + 50}", "--format=%H%x1f%cI%x1f%s", f"origin/{branch}").splitlines():
        sha, date, subj = line.split("\x1f", 2)
        info[sha] = (date, subj)
    con = connect()
    con.execute("delete from changes where project = ? and kind = 'commit'", (slug,))
    for i, r in H.reset_index(drop=True).iterrows():
        date, subj = info.get(r["sha"], ("", ""))
        con.execute(
            "insert or replace into changes values (?,?, 'commit', null, ?,?,?, '', ?,?,?, 0, null, null, null, ?,?, null)",
            (slug, r["sha"], r["parent"], date, subj, float(risk[i]), place[i], model.level(place[i])[0],
             float(r.get("k_la", 0)), float(r.get("k_ld", 0))),
        )
    dates = sorted(d for d, _ in (info.get(s, ("", "")) for s in H.sha) if d)
    con.execute("insert or replace into projects values (?,?, 'external', ?,?, 0, 0, ?, ?, ?)",
                (slug, url, len(H), len(H),
                 con.execute("select count(*) from changes where project = ? and kind = 'pr'", (slug,)).fetchone()[0],
                 dates[0][:10] if dates else "", dates[-1][:10] if dates else ""))
    con.commit()


def remove(slug: str) -> None:
    import shutil

    con = connect()
    con.execute("delete from external where slug = ?", (slug,))
    con.execute("delete from changes where project = ?", (slug,))
    con.execute("delete from projects where name = ? and group_name = 'external'", (slug,))
    con.commit()
    shutil.rmtree(EXT / slug, ignore_errors=True)


def listing() -> list[dict]:
    return [dict(r) for r in connect().execute("select * from external order by added desc")]


# ─── pull request'ы и ссылки для выпадающих списков ──────────────────────────

def prs(slug: str) -> list[dict]:
    from ..queue import gh

    name = github_name(slug)
    if not name:
        return []
    out = json.loads(gh("pr", "list", "--repo", name, "--state", "open", "--limit", "30", "--json",
                        "number,title,headRefOid,baseRefName,author,updatedAt,url,additions,deletions,isDraft") or "[]")
    con = connect()
    known = {(r["pr"], r["sha"]): dict(r) for r in con.execute(
        "select pr, sha, level, place, risk from changes where project = ? and kind = 'pr'", (slug,))}
    for p in out:
        a = known.get((p["number"], p["headRefOid"]))
        p["assessed"] = {"level": a["level"], "place": a["place"]} if a else None
        p["author"] = (p.get("author") or {}).get("login")
    return out


def assess_pr(slug: str, number: int) -> dict:
    from ..score import assess

    name = github_name(slug)
    path = clone_path(slug)
    pr = next((p for p in prs(slug) if p["number"] == number), None)
    if not pr or not name:
        raise RuntimeError(f"нет открытого PR #{number}")
    git(path, "fetch", "--no-tags", "--quiet", f"https://github.com/{name}.git",
        f"+refs/pull/{number}/head:refs/cwv-risk/pr-{number}/head",
        f"+refs/heads/{pr['baseRefName']}:refs/cwv-risk/pr-{number}/base")
    r = assess(path, f"refs/cwv-risk/pr-{number}/base", pr["headRefOid"], history_n(slug), quiet=True)
    con = connect()
    con.execute(
        "insert or replace into changes values (?,?, 'pr', ?, ?,?,?, '', ?,?,?, 0, null, null, null, ?,?, ?)",
        (slug, pr["headRefOid"], number, r.merge_base, pr["updatedAt"], pr["title"], r.risk, r.place, r.level,
         r.lines_added, r.lines_deleted, json.dumps([x.__dict__ for x in r.reasons], ensure_ascii=False)),
    )
    con.execute("update projects set prs = (select count(*) from changes where project = ? and kind = 'pr') where name = ?",
                (slug, slug))
    con.commit()
    return r.to_dict() | {"pr": number, "title": pr["title"], "url": pr["url"]}


def refs(slug: str) -> dict:
    """Ветки и последние коммиты основной ветки — для выпадающих списков «Проверить изменение»."""
    path = clone_path(slug)
    if not path.exists():
        raise RuntimeError(f"нет клона {path}")
    branches = [b for b in git(path, "for-each-ref", "refs/remotes/origin", "--format=%(refname:short)").split()
                if not b.endswith("/HEAD")]
    head = git(path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD", check=False).strip() or \
        (branches[0] if branches else "HEAD")
    commits = []
    for line in git(path, "log", "--first-parent", "-n60", "--format=%H%x1f%cI%x1f%s", head).splitlines():
        sha, date, subj = line.split("\x1f", 2)
        commits.append({"sha": sha, "date": date, "subject": subj})
    return {"default": head, "branches": branches[:200], "commits": commits}
