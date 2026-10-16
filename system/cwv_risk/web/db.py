"""База панели (SQLite) и импорт данных диссертации.

Источники (только чтение):
  data/<проект>.scores.csv      — прогноз модели для ВСЕХ коммитов нового проекта (риск, место в списке);
  data/<проект>.labels.csv      — измеренные пары «база → коммит»: медианы метрик, изменения, q, метки;
  data/<проект>-pr.labels.csv   — замеры pull request'ов очередью (`cwv_risk queue`);
  work/repos/<проект>           — git: заголовки коммитов, номера PR (refs/cwv-risk/pr-<N>/head);
  ml/results/*.json             — кривая «бюджет → найдено», отобранные против случайных.

    python -m cwv_risk web ingest
"""

from __future__ import annotations

import csv
import datetime as dt
import json
import re
import sqlite3
import subprocess
from pathlib import Path

from .. import model
from .._ml import ROOT

DB = Path(__file__).resolve().parents[2] / "cwv-risk.db"
CONFIG = Path(__file__).resolve().parents[2] / "web-config.json"
METRICS = ["lcp", "inp", "cls", "tbt", "tbtFlow", "lcpObs"]
STUDY = {"excalidraw", "mermaid-live-editor", "vuejs-docs", "monkeytype"}  # обучение модели, полная разметка

SCHEMA = """
create table if not exists projects (
  name text primary key, url text, group_name text, commits integer, scored integer,
  measured integer, regressions integer, prs integer, first_date text, last_date text
);
create table if not exists changes (
  project text, sha text, kind text,           -- kind: commit | pr
  pr integer, base text, date text, subject text, selection text,
  risk real, place real, level text,           -- place: доля коммитов проекта с более высоким риском (0 — самый рискованный)
  measured integer, status text, label text, metrics text, k_la real, k_ld real, reasons text,
  primary key (project, sha, kind)
);
create table if not exists meta (key text primary key, value text);
create table if not exists assessments (id integer primary key, project text, base text, head text, created text, result text);
create table if not exists external (           -- сторонние проекты (web/external.py)
  slug text primary key, name text, url text, branch text, status text, done integer, total integer,
  message text, history integer, paths text, added text, finished text
);
"""


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB, timeout=30, check_same_thread=False)  # пишет и фоновое задание сторонних проектов
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def config() -> dict:
    """Очереди замеров: какие репозитории GitHub опрашивать и каким конфигом стенда мерить."""
    if CONFIG.exists():
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    return {"queues": [{"github": "sirpeperoni/bentopdf", "bench": "bentopdf"}]}


def git(repo: Path, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout if r.returncode == 0 else ""


def subjects(repo: str) -> dict[str, str]:
    out = git(ROOT / "work" / "repos" / repo, "log", "--all", "--format=%H%x1f%s")
    return dict(line.split("\x1f", 1) for line in out.splitlines() if "\x1f" in line)


def repo_url(repo: str) -> str | None:
    f = ROOT / "bench" / "repos" / f"{repo}.ts"
    m = re.search(r"url:\s*'([^']+)'", f.read_text(encoding="utf-8")) if f.exists() else None
    return m.group(1).removesuffix(".git") if m else None


def read_labels(path: Path) -> dict[str, dict]:
    """Измеренные пары без контрольных A/A; ключ — sha коммита."""
    out = {}
    if not path.exists():
        return out
    with path.open(encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if r.get("aa") not in ("0", "False", "") or r.get("self_aa") not in ("0", "False", ""):
                continue
            out[r["sha"]] = r
    return out


def metrics(r: dict) -> dict:
    num = lambda v: None if v in (None, "") else float(v)
    m = {}
    for k in METRICS:
        if f"{k}_label" in r and r.get(f"{k}_base") not in (None, ""):
            m[k] = {f: num(r.get(f"{k}_{f}")) for f in ("base", "head", "delta", "rel", "q")} | {"label": r[f"{k}_label"]}
    return m


def ingest(assess_prs: bool = True) -> dict:
    con = connect()
    # сторонние проекты (web/external.py) — свои данные, импорт эксперимента их не трогает
    con.execute("delete from changes where project not in (select slug from external)")
    con.execute("delete from projects where group_name != 'external'")
    repos = sorted({p.name.removesuffix(".labels.csv") for p in (ROOT / "data").glob("*.labels.csv")}
                   | {p.name.removesuffix(".scores.csv") for p in (ROOT / "data").glob("*.scores.csv")})
    repos = [r for r in repos if not r.endswith(("-mutants", "-pr")) and (ROOT / "bench" / "repos" / f"{r}.ts").exists()]
    total = 0
    for repo in repos:
        subj = subjects(repo)
        labels = read_labels(ROOT / "data" / f"{repo}.labels.csv")
        rows: dict[str, dict] = {}
        scores = ROOT / "data" / f"{repo}.scores.csv"
        if scores.exists():
            with scores.open(encoding="utf-8") as fh:
                sc = list(csv.DictReader(fh))
            order = sorted(range(len(sc)), key=lambda i: -float(sc[i]["score"]))
            n = len(sc)
            for rank, i in enumerate(order):
                r = sc[i]
                place = rank / n
                rows[r["sha"]] = {
                    "sha": r["sha"], "base": r["base"], "date": r["date"], "subject": r["subject"],
                    "selection": r["selection"] or "", "risk": float(r["score"]), "place": place,
                    "level": model.level(place)[0], "k_la": float(r["k_la"]), "k_ld": float(r["k_ld"]),
                }
        for sha, r in labels.items():
            row = rows.setdefault(sha, {"sha": sha, "base": r["base_sha"], "date": r["date"], "subject": subj.get(sha, ""),
                                        "selection": "", "risk": None, "place": None, "level": None,
                                        "k_la": None, "k_ld": None})
            row.update({"measured": 1, "status": r["status"], "label": r["label"], "metrics": json.dumps(metrics(r))})
        for row in rows.values():
            con.execute(
                "insert into changes values (?,?, 'commit', null, ?,?,?,?, ?,?,?, ?,?,?,?, ?,?, null)",
                (repo, row["sha"], row["base"], row["date"], row["subject"], row["selection"], row["risk"], row["place"],
                 row["level"], row.get("measured", 0), row.get("status"), row.get("label"), row.get("metrics"),
                 row["k_la"], row["k_ld"]),
            )
        total += len(rows)

    prs = ingest_prs(con, assess_prs)
    for repo in repos:
        s = con.execute("""select count(*) n, sum(risk is not null) scored, sum(measured) measured,
                           sum(label = 'regression') regressions, min(date) first, max(date) last
                           from changes where project = ? and kind = 'commit'""", (repo,)).fetchone()
        n_pr = con.execute("select count(*) from changes where project = ? and kind = 'pr'", (repo,)).fetchone()[0]
        con.execute("insert into projects values (?,?,?,?,?,?,?,?,?,?)",
                    (repo, repo_url(repo), "study" if repo in STUDY else "new", s["n"], s["scored"] or 0, s["measured"] or 0,
                     s["regressions"] or 0, n_pr, (s["first"] or "")[:10], (s["last"] or "")[:10]))

    results = ROOT / "ml" / "results"
    for key, file in (("budget_curve", "budget-curve.json"), ("selection_eval", "selection-eval.json")):
        if (results / file).exists():
            con.execute("insert or replace into meta values (?, ?)", (key, (results / file).read_text(encoding="utf-8")))
    art = model.load()
    con.execute("insert or replace into meta values ('model', ?)", (json.dumps(
        {k: art[k] for k in ("kind", "trained_on", "pairs", "regressions", "created")}, ensure_ascii=False),))
    con.execute("insert or replace into meta values ('levels', ?)", (json.dumps(
        [{"top": t, "level": k, "name": n, "rate": r} for t, k, n, r in model.LEVELS], ensure_ascii=False),))
    con.execute("insert or replace into meta values ('ingested', ?)", (dt.datetime.now().isoformat(timespec="seconds"),))
    con.commit()
    return {"projects": len(repos), "changes": total, "prs": prs}


def ingest_prs(con: sqlite3.Connection, assess_prs: bool) -> int:
    """Замеры PR из очереди: data/<проект>-pr.labels.csv; номер PR — по ссылкам refs/cwv-risk/pr-<N>/head клона."""
    from ..score import assess

    n = 0
    for path in (ROOT / "data").glob("*-pr.labels.csv"):
        repo = path.name.removesuffix("-pr.labels.csv")
        clone = ROOT / "work" / "repos" / repo
        refs = {}
        for line in git(clone, "for-each-ref", "refs/cwv-risk", "--format=%(objectname) %(refname)").splitlines():
            sha, ref = line.split(" ", 1)
            m = re.match(r"refs/cwv-risk/pr-(\d+)/head$", ref)
            if m:
                refs[sha] = int(m.group(1))
        subj = subjects(repo)
        for sha, r in read_labels(path).items():
            risk = place = level = None
            reasons = None
            if assess_prs:
                try:
                    a = assess(clone, r["base_sha"], sha, quiet=True)
                    risk, place, level = a.risk, a.place, a.level
                    reasons = json.dumps([x.__dict__ for x in a.reasons], ensure_ascii=False)
                except (Exception, SystemExit):  # noqa: BLE001 — без оценки строка всё равно нужна
                    pass
            con.execute(
                "insert or replace into changes values (?,?, 'pr', ?, ?,?,?, '', ?,?,?, 1,?,?,?, null, null, ?)",
                (repo, sha, refs.get(sha), r["base_sha"], r["date"], subj.get(sha, ""), risk, place, level,
                 r["status"], r["label"], json.dumps(metrics(r)), reasons),
            )
            n += 1
    return n
