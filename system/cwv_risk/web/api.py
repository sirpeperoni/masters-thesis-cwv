"""HTTP API панели (FastAPI) и раздача собранного фронтенда.

Чтение — файлами *.json (`/api/summary.json`, `/api/projects/<имя>.json`…): статическая копия панели
(`python -m cwv_risk web export`) — те же файлы на диске, фронтенду всё равно, откуда их брать.
Действия (оценить изменение, объяснить прогноз) — только у работающего сервера (`meta.json`: live = true).

    python -m cwv_risk web serve [--port 8000]
"""

from __future__ import annotations

import datetime as dt
from contextlib import asynccontextmanager
import json
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .._ml import ROOT
from . import db, external

DIST = Path(__file__).resolve().parents[2] / "web" / "dist"
PKG = Path(__file__).resolve().parents[1]  # cwv_risk/
STARTED = time.time()


def stale() -> bool:
    """Код сервера изменился после запуска — новые адреса API ему неизвестны, нужен перезапуск (панель покажет плашку)."""
    return any(p.stat().st_mtime > STARTED for p in PKG.rglob("*.py"))
@asynccontextmanager
async def lifespan(_app: FastAPI):
    external.resume_pending()  # незаконченные задания сторонних проектов после перезапуска
    yield


app = FastAPI(title="cwv-risk", docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=lifespan)
_queue_cache: dict = {"at": 0.0, "data": None}


def row(r) -> dict:
    d = dict(r)
    for k in ("metrics", "reasons"):
        d[k] = json.loads(d[k]) if d.get(k) else None
    return d


def meta_dict(con, live: bool) -> dict:
    m = {r["key"]: r["value"] for r in con.execute("select key, value from meta")}
    out = {"live": live, "stale": live and stale(), "ingested": m.get("ingested"), "queues": db.config()["queues"]}
    for k in ("model", "levels", "budget_curve", "selection_eval"):
        if k in m:
            out[k] = json.loads(m[k])
    return out


def summary(con) -> dict:
    t = con.execute("""select count(*) n, sum(risk is not null) scored, sum(measured) measured,
                       sum(label = 'regression') regressions from changes where kind = 'commit'""").fetchone()
    # доля регрессий по уровням прогноза — измеренные коммиты новых проектов (оценка смещена отбором: верхние
    # 20 % измерены почти полностью, остальные — случайной выборкой; несмещённые оценки — в meta.levels)
    by_level = [dict(r) for r in con.execute("""select level, count(*) n, sum(label = 'regression') regressions
        from changes where kind = 'commit' and measured = 1 and level is not null group by level""")]
    return {"projects": con.execute("select count(*) from projects").fetchone()[0], **dict(t), "by_level": by_level,
            "prs": con.execute("select count(*) from changes where kind = 'pr'").fetchone()[0]}


def projects(con) -> list[dict]:
    ext = {e["slug"]: e for e in external.listing()}
    out = [dict(r) | {"external": ext.get(r["name"])} for r in con.execute(
        "select * from projects order by case group_name when 'external' then 0 when 'new' then 1 else 2 end, name")]
    # сторонние проекты, которые ещё считаются (в projects их ещё нет)
    have = {p["name"] for p in out}
    pending = [{"name": s, "url": e["url"], "group_name": "external", "commits": 0, "scored": 0, "measured": 0,
                "regressions": 0, "prs": 0, "first_date": "", "last_date": "", "external": e}
               for s, e in ext.items() if s not in have]
    return pending + out


def project(con, name: str) -> dict:
    p = con.execute("select * from projects where name = ?", (name,)).fetchone()
    ext = next((e for e in external.listing() if e["slug"] == name), None)
    if not p and not ext:
        raise HTTPException(404, f"нет проекта {name}")
    if not p:  # сторонний проект ещё считается
        return {"project": {"name": name, "url": ext["url"], "group_name": "external", "commits": 0, "scored": 0,
                            "measured": 0, "regressions": 0, "prs": 0, "first_date": "", "last_date": "", "external": ext},
                "changes": []}
    ch = [row(r) for r in con.execute("select * from changes where project = ? order by date", (name,))]
    return {"project": dict(p) | {"external": ext}, "changes": ch}


def queue_items() -> list[dict]:
    """Pull request'ы с метками cwv-risk в очередях из web-config.json — живой опрос GitHub (кеш 60 с)."""
    from ..queue import gh

    if _queue_cache["data"] is not None and time.time() - _queue_cache["at"] < 60:
        return _queue_cache["data"]
    items = []
    for q in db.config()["queues"]:
        try:
            prs = json.loads(gh("pr", "list", "--repo", q["github"], "--state", "all", "--limit", "100",
                                "--json", "number,title,url,state,labels,updatedAt,headRefOid"))
        except Exception as e:  # noqa: BLE001
            items.append({"github": q["github"], "error": str(e)[:300]})
            continue
        for pr in prs:
            labels = [l["name"] for l in pr["labels"] if l["name"].startswith("cwv-risk")]
            if not labels:
                continue
            state = ("measured" if "cwv-risk: measured" in labels else "queued" if "cwv-risk: measure" in labels else "other")
            result = "regression" if "cwv-risk: regression" in labels else "ok" if "cwv-risk: ok" in labels else None
            items.append({"github": q["github"], "bench": q["bench"], "number": pr["number"], "title": pr["title"],
                          "url": pr["url"], "pr_state": pr["state"], "state": state, "result": result,
                          "updated": pr["updatedAt"], "head": pr["headRefOid"]})
    _queue_cache.update(at=time.time(), data=items)
    return items


# ─── чтение ───────────────────────────────────────────────────────────────────

@app.get("/api/meta.json")
def get_meta():
    return meta_dict(db.connect(), live=True)


@app.get("/api/summary.json")
def get_summary():
    return summary(db.connect())


@app.get("/api/projects.json")
def get_projects():
    return projects(db.connect())


@app.get("/api/projects/{name}.json")
def get_project(name: str):
    return project(db.connect(), name)


@app.get("/api/queue.json")
def get_queue():
    return queue_items()


# ─── действия (только живой сервер) ──────────────────────────────────────────

class AssessIn(BaseModel):
    project: str
    base: str
    head: str


@app.post("/api/assess")
def post_assess(body: AssessIn):
    """Оценить произвольное изменение base..head в клоне проекта work/repos/<проект>."""
    from ..score import assess

    clone = external.clone_path(body.project)
    if not clone.exists():
        raise HTTPException(404, f"нет клона {clone}")
    try:
        r = assess(clone, body.base, body.head, external.history_n(body.project), quiet=True)
    except SystemExit as e:
        raise HTTPException(400, str(e)) from None
    out = r.to_dict()
    con = db.connect()
    con.execute("insert into assessments (project, base, head, created, result) values (?,?,?,?,?)",
                (body.project, body.base, body.head, dt.datetime.now().isoformat(timespec="seconds"),
                 json.dumps(out, ensure_ascii=False)))
    con.commit()
    return out


@app.post("/api/explain/{name}/{sha}")
def post_explain(name: str, sha: str):
    """Объяснение прогноза для коммита из базы: признаки, по которым он необычен для проекта (сохраняется)."""
    from ..score import assess

    con = db.connect()
    c = con.execute("select * from changes where project = ? and sha = ?", (name, sha)).fetchone()
    if not c:
        raise HTTPException(404, "нет такого изменения")
    try:
        r = assess(external.clone_path(name), c["base"], sha, external.history_n(name), quiet=True)
    except SystemExit as e:
        raise HTTPException(400, str(e)) from None
    reasons = [x.__dict__ for x in r.reasons]
    con.execute("update changes set reasons = ? where project = ? and sha = ?", (json.dumps(reasons, ensure_ascii=False), name, sha))
    con.commit()
    return {"reasons": reasons, "history_place": r.place, "history_level": r.level, "history": r.history}


class ExternalIn(BaseModel):
    url: str
    history: int = 200
    paths: list[str] = []


@app.post("/api/external")
def post_external(body: ExternalIn):
    """Добавить сторонний проект: клон и прогноз — фоновым заданием (прогресс — в projects.json)."""
    try:
        return {"slug": external.add(body.url, max(50, min(body.history, 1000)), body.paths)}
    except ValueError as e:
        raise HTTPException(400, str(e)) from None


@app.post("/api/external/{slug}/refresh")
def post_refresh(slug: str):
    e = next((x for x in external.listing() if x["slug"] == slug), None)
    if not e:
        raise HTTPException(404, "нет такого стороннего проекта")
    return {"slug": external.add(e["url"], e["history"], json.loads(e["paths"] or "[]"))}


@app.delete("/api/external/{slug}")
def delete_external(slug: str):
    external.remove(slug)
    return {"ok": True}


@app.get("/api/projects/{name}/prs.json")
def get_prs(name: str):
    try:
        return external.prs(name)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"GitHub: {str(e)[:300]}") from None


@app.post("/api/projects/{name}/prs/{number}/assess")
def post_pr_assess(name: str, number: int):
    try:
        return external.assess_pr(name, number)
    except (Exception, SystemExit) as e:  # noqa: BLE001
        raise HTTPException(400, str(e)[:400]) from None


@app.get("/api/projects/{name}/refs.json")
def get_refs(name: str):
    try:
        return external.refs(name)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(404, str(e)[:300]) from None


# ─── фронтенд ─────────────────────────────────────────────────────────────────

if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")


def export(out: Path) -> dict:
    """Статическая копия: собранный фронтенд + те же JSON, что отдаёт API (без действий)."""
    import shutil

    if not DIST.exists():
        raise SystemExit("нет system/web/dist — сначала собрать фронтенд: cd system/web && npm run build")
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(DIST, out)
    api = out / "api"
    (api / "projects").mkdir(parents=True)
    con = db.connect()
    w = lambda p, d: (api / p).write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    w("meta.json", meta_dict(con, live=False))
    w("summary.json", summary(con))
    ps = projects(con)
    w("projects.json", ps)
    for p in ps:
        w(f"projects/{p['name']}.json", project(con, p["name"]))
    try:
        w("queue.json", queue_items())
    except Exception:  # noqa: BLE001 — без GitHub очередь в копии пустая
        w("queue.json", [])
    return {"projects": len(ps), "out": str(out)}
