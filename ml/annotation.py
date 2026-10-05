"""
Аннотационная схема набора данных (лабораторная «Проектирование аннотационной схемы»): описание —
docs/annotation-schema.md, файлы — annotations/.

    python ml/annotation.py auto                 # автоматические слои: прогоны, LCP-элементы, шаблоны в строках
    python ml/annotation.py sample               # пилотная выборка (50 пар) и пустые листы для аннотаторов
    python ml/annotation.py agree A B            # согласованность двух аннотаторов (каппа Коэна) и сравнение
                                                 # слепой оценки «повлияет ли» с измеренной меткой

Пилот размечен аннотатором B — языковой моделью (Claude) по инструкции схемы; второй аннотатор
размечает те же листы при расширении разметки (agree считает согласие любых двух разметок).
"""

from __future__ import annotations

import csv
import hashlib
import json
import random
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import cohen_kappa_score

sys.path.insert(0, str(Path(__file__).parent))
from features import PATTERNS, categorize, git  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
ANN = ROOT / "annotations"
REPOS = ["excalidraw", "mermaid-live-editor", "vuejs-docs", "monkeytype"]
# адреса для ссылок «сравнить база…коммит» на GitHub — аннотатор смотрит diff в браузере
GITHUB = {
    "excalidraw": "excalidraw/excalidraw",
    "mermaid-live-editor": "mermaid-js/mermaid-live-editor",
    "vuejs-docs": "vuejs/docs",
    "monkeytype": "monkeytypegame/monkeytype",
}
METRICS = ["lcp", "inp", "tbt", "tbtFlow", "cls", "lcpObs"]
SEED = 42

# ─── словари категорий (единые для всех модальностей; описание — в схеме) ───────

PERF_CATEGORIES = [
    "dependency", "bundle", "render_blocking", "main_thread", "event_handler", "timer_animation",
    "dom_layout", "css", "media", "font", "code_splitting", "framework", "content", "third_party", "none",
]
CHANGE_TYPES = ["feature", "fix", "refactor", "dependency", "build", "style", "content", "test_docs", "perf"]
LCP_CATEGORIES = [
    "main_text", "main_image", "logo", "navigation", "footer_hint", "banner", "consent_modal",
    "error_message", "placeholder", "other",
]


def load_results(repo: str) -> dict[str, dict]:
    out = {}
    for f in (DATA / repo).glob("*.json"):
        if f.name.endswith(".aa.json"):
            continue
        j = json.loads(f.read_text(encoding="utf-8"))
        out[j["sha"]] = j
    return out


def write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    print(f"  → {path.relative_to(ROOT)} ({len(rows)} строк)")


# ─── автоматические слои ──────────────────────────────────────────────────────

# практические пороги метрик — как в разметке (bench/src/stats.ts, TARGETS): (абсолютный, относительный)
THRESHOLDS = {"lcp": (50, 0.05), "lcpObs": (50, 0.05), "inp": (20, 0.10), "tbt": (30, 0.10), "tbtFlow": (30, 0.10), "cls": (0.01, 0)}


def outliers(values: list[float], metric: str) -> list[bool]:
    """Выброс — отклонение от медианы своей стороны пары больше 3 робастных σ (1,4826·MAD) И больше
    практического порога метрики: на 5 прогонах MAD мала, и одно правило «3σ» отмечало почти половину прогонов."""
    a = np.array([np.nan if v is None else v for v in values], float)
    if np.isnan(a).all():
        return [False] * len(a)
    med = np.nanmedian(a)
    mad = 1.4826 * np.nanmedian(np.abs(a - med))
    absolute, rel = THRESHOLDS[metric]
    limit = max(3 * mad, absolute, rel * abs(med))
    return list(np.abs(a - med) > limit)


def lcp_element_id(el: dict | None) -> str:
    if not el:
        return ""
    return hashlib.sha1(f"{el.get('selector')}|{el.get('label')}".encode()).hexdigest()[:10]


def lcp_auto_category(el: dict) -> str:
    """Предварительная категория LCP-элемента по правилам — аннотатор её подтверждает или исправляет."""
    sel, label, snip = el.get("selector", ""), el.get("label", "").lower(), el.get("snippet", "").lower()
    if "cookie" in label:
        return "consent_modal"
    if re.search(r"server|offline|error|down time", label):
        return "error_message"
    if re.search(r"banner|psa|notification|announcement", sel + snip) or "merch" in label:
        return "banner"
    if re.search(r"loading|spinner|skeleton", sel + snip + label):
        return "placeholder"
    if "<img" in snip or "<image" in snip or "<video" in snip or "background-image" in snip:
        return "main_image"
    if "footer" in sel or re.search(r"\b(tab|esc|ctrl)\b.*(restart|command)", label):
        return "footer_hint"
    if "header" in sel and len(label) < 30:
        return "logo"
    if re.search(r"\bnav\b|navbar|sidebar|aside", sel):
        return "navigation"
    return "main_text" if label else "other"


def run_auto() -> None:
    print("Уровень 3 замеров: прогоны (выбросы, ошибки, LCP-элемент)")
    elements: dict[str, dict] = {}
    for repo in REPOS:
        rows = []
        for sha, j in sorted(load_results(repo).items(), key=lambda kv: kv[1]["date"]):
            if j["status"] != "ok":
                continue
            for side, runs_by_page in (("base", j.get("baseRuns", {})), ("head", j.get("runs", {}))):
                for page, runs in runs_by_page.items():
                    vals = {m: [] for m in ("lcp", "tbt", "cls", "inp", "tbtFlow", "lcpObs")}
                    for r in runs:
                        nav, it = r.get("navigation") or {}, r.get("interaction") or {}
                        vals["lcp"].append(nav.get("lcp"))
                        vals["tbt"].append(nav.get("tbt"))
                        vals["cls"].append(nav.get("cls"))
                        vals["lcpObs"].append(nav.get("observedLargestContentfulPaint"))
                        vals["inp"].append(it.get("inp"))
                        vals["tbtFlow"].append(it.get("tbt"))
                    flags = {m: outliers(v, m) for m, v in vals.items()}
                    for i, r in enumerate(runs):
                        el = r.get("lcpElement")
                        eid = lcp_element_id(el)
                        if el:
                            e = elements.setdefault(eid, {"element_id": eid, "repo": repo, "selector": el.get("selector", ""),
                                                          "label": el.get("label", "").replace("\n", " ⏎ "),
                                                          "snippet": el.get("snippet", ""), "runs": 0, "commits": set()})
                            e["runs"] += 1
                            e["commits"].add(sha)
                        out = [m for m in vals if flags[m][i]]
                        rows.append({
                            "sha": sha, "side": side, "page": page, "run": i, "seq": r.get("seq", ""),
                            **{m: "" if vals[m][i] is None else round(vals[m][i], 4) for m in vals},
                            "status": "error" if r.get("error") else ("outlier" if out else "ok"),
                            "outlier_metrics": ";".join(out), "lcp_element_id": eid,
                        })
        write_csv(ANN / "measurements" / f"{repo}.runs.csv", rows,
                  ["sha", "side", "page", "run", "seq", "lcp", "tbt", "cls", "inp", "tbtFlow", "lcpObs", "status",
                   "outlier_metrics", "lcp_element_id"])

    print("Уровень 2 текста страницы: LCP-элементы (категория по правилам, для проверки аннотатором)")
    els = []
    for e in sorted(elements.values(), key=lambda e: (e["repo"], -e["runs"])):
        els.append({**e, "commits": len(e["commits"]), "auto_category": lcp_auto_category(e)})
    write_csv(ANN / "text-page" / "lcp-elements.csv", els,
              ["element_id", "repo", "runs", "commits", "selector", "label", "snippet", "auto_category"])


# ─── пилотная выборка ─────────────────────────────────────────────────────────

def labels() -> pd.DataFrame:
    frames = []
    for repo in REPOS:
        d = pd.read_csv(DATA / f"{repo}.labels.csv")
        d["repo"] = repo
        frames.append(d)
    d = pd.concat(frames, ignore_index=True)
    return d[(d.status == "ok") & (d.aa == 0) & (d.self_aa == 0)]


def runtime_files(repo: str, base: str, sha: str) -> list[tuple[str, int, int, str]]:
    """Изменённые файлы без тестов, документации и lock-файлов: (путь, +строк, −строк, категория)."""
    out = []
    for line in git(ROOT / "work" / "repos" / repo, "diff", "--numstat", base, sha).splitlines():
        a, d, path = line.split("\t", 2)
        cat = categorize(path)
        if cat in {"test", "doc", "lock"}:
            continue
        out.append((path, int(a) if a != "-" else 0, int(d) if d != "-" else 0, cat))
    return sorted(out, key=lambda f: -(f[1] + f[2]))


def run_sample() -> None:
    d = labels()
    reg = d[d.label == "regression"]
    rng = random.Random(SEED)
    neg_parts = []
    for repo, n in reg.repo.value_counts().items():  # отрицательные — из тех же проектов в той же пропорции
        pool = d[(d.repo == repo) & (d.label != "regression")]
        neg_parts.append(pool.sample(n=n, random_state=SEED))
    items = pd.concat([reg, *neg_parts]).sample(frac=1, random_state=SEED).reset_index(drop=True)
    items["id"] = [f"P{i + 1:02d}" for i in range(len(items))]
    print(f"Пилотная выборка: {len(items)} пар ({len(reg)} регрессий + {len(items) - len(reg)} без регрессии), порядок перемешан")

    sheet, key, culprit = [], [], []
    for _, x in items.iterrows():
        repo_dir = ROOT / "work" / "repos" / x.repo
        subject = git(repo_dir, "log", "-1", "--format=%s", x.sha).strip()
        files = runtime_files(x.repo, x.base_sha, x.sha)
        url = f"https://github.com/{GITHUB[x.repo]}/compare/{x.base_sha[:12]}...{x.sha[:12]}"
        sheet.append({
            "id": x.id, "repo": x.repo, "subject": subject, "compare_url": url,
            "runtime_files": len(files), "lines_changed": sum(a + dl for _, a, dl, _ in files),
            "expect_regression": "", "expected_metrics": "", "change_type": "", "perf_category": "", "comment": "",
        })
        regressed = [m for m in METRICS if x[f"{m}_label"] == "regression"]
        key.append({"id": x.id, "repo": x.repo, "sha": x.sha, "base_sha": x.base_sha, "label": x.label,
                    "regressed_metrics": ";".join(regressed),
                    **{f"{m}_delta": x[f"{m}_delta"] for m in METRICS}})
        if x.label == "regression":
            for path, a, dl, cat in files[:10]:  # 10 крупнейших файлов — кандидаты в причину
                fmt = lambda m, v: f"{v:.3f}" if m == "cls" else f"{v:.0f}"
                culprit.append({"id": x.id, "repo": x.repo, "regressed": "; ".join(
                    f"{m} {fmt(m, x[f'{m}_base'])}→{fmt(m, x[f'{m}_head'])}" for m in regressed),
                    "compare_url": url, "file": path, "added": a, "deleted": dl, "file_category": cat,
                    "is_cause": "", "perf_category": "", "effect_metric": "", "comment": ""})

    base = ANN / "text-diff"
    write_csv(base / "pilot-phase1.template.csv", sheet, list(sheet[0]))
    write_csv(base / "pilot-phase2.template.csv", culprit, list(culprit[0]))
    write_csv(base / "pilot-key.csv", key, list(key[0]))

    print("Уровень 3 текста diff: строки с шаблонами кода (по регулярным выражениям features.py)")
    spans = []
    for k in key:
        for path, (plus, minus) in hunk_lines(k["repo"], k["base_sha"], k["sha"]).items():
            for sign, lines in (("+", plus), ("-", minus)):
                for lineno, text in lines:
                    for name, rx in PATTERNS.items():
                        if rx.search(text):
                            spans.append({"id": k["id"], "sha": k["sha"], "file": path, "side": sign, "line": lineno,
                                          "pattern": name, "text": text.strip()[:200]})
    out = base / "pilot-patterns.auto.jsonl"
    out.write_text("".join(json.dumps(s, ensure_ascii=False) + "\n" for s in spans), encoding="utf-8")
    print(f"  → {out.relative_to(ROOT)} ({len(spans)} строк-шаблонов)")


HUNK_RE = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def hunk_lines(repo: str, base: str, sha: str) -> dict[str, tuple[list, list]]:
    """Добавленные и удалённые строки с номерами (новая версия для «+», старая для «−»); только код/стили/HTML."""
    out: dict[str, tuple[list, list]] = {}
    diff = git(ROOT / "work" / "repos" / repo, "diff", "-U0", "--no-color", base, sha)
    path, old, new = None, 0, 0
    for line in diff.splitlines():
        if line.startswith("+++ "):
            p = line[6:] if line.startswith("+++ b/") else None
            path = p if p and categorize(p) in {"code", "style", "html"} else None
        elif m := HUNK_RE.match(line):
            old, new = int(m.group(1)), int(m.group(2))
        elif path and line.startswith("+") and not line.startswith("+++"):
            out.setdefault(path, ([], []))[0].append((new, line[1:]))
            new += 1
        elif path and line.startswith("-") and not line.startswith("---"):
            out.setdefault(path, ([], []))[1].append((old, line[1:]))
            old += 1
    return out


# ─── согласованность ──────────────────────────────────────────────────────────

def kappa(a: list[str], b: list[str]) -> tuple[float, float, int]:
    pairs = [(x, y) for x, y in zip(a, b) if x and y]
    if not pairs:
        return float("nan"), float("nan"), 0
    xa, xb = zip(*pairs)
    agree = sum(x == y for x, y in pairs) / len(pairs)
    k = cohen_kappa_score(xa, xb) if len(set(xa) | set(xb)) > 1 else 1.0
    return k, agree, len(pairs)


def run_agree(a_name: str, b_name: str) -> None:
    base = ANN / "text-diff"
    key = pd.read_csv(base / "pilot-key.csv").set_index("id")
    report = {"annotators": [a_name, b_name], "phase1": {}, "phase2": {}, "vs_measured": {}}
    p1 = {n: pd.read_csv(base / f"pilot-phase1.{n}.csv", dtype=str).fillna("").set_index("id") for n in (a_name, b_name)}
    ids = p1[a_name].index.intersection(p1[b_name].index)
    print(f"Фаза 1 (слепая, {len(ids)} пар): каппа Коэна / доля совпадений")
    for field in ("expect_regression", "change_type", "perf_category"):
        k, ag, n = kappa(list(p1[a_name].loc[ids, field]), list(p1[b_name].loc[ids, field]))
        report["phase1"][field] = {"kappa": k, "agreement": ag, "n": n}
        print(f"  {field:<16} κ = {k:.2f}   совпадений {ag:.0%}   (n = {n})")
    for m in ("lcp", "inp", "cls", "tbt"):  # множественный выбор — по каждой метрике отдельно
        has = lambda n: ["yes" if m in v.split(";") else "no" for v in p1[n].loc[ids, "expected_metrics"]]
        k, ag, n = kappa(has(a_name), has(b_name))
        report["phase1"][f"expected_{m}"] = {"kappa": k, "agreement": ag, "n": n}
        print(f"  expected {m:<7} κ = {k:.2f}   совпадений {ag:.0%}")

    print("Слепая оценка «повлияет на производительность» против измеренной метки (регрессия)")
    truth = (key.loc[ids, "label"] == "regression").to_numpy()
    for n in (a_name, b_name):
        pred = (p1[n].loc[ids, "expect_regression"] == "yes").to_numpy()
        tp, fp = int((pred & truth).sum()), int((pred & ~truth).sum())
        rec = tp / truth.sum() if truth.sum() else float("nan")
        prec = tp / (tp + fp) if tp + fp else float("nan")
        report["vs_measured"][n] = {"recall": rec, "precision": prec, "flagged": int(pred.sum()), "regressions": int(truth.sum())}
        print(f"  {n:<14} отмечено {pred.sum():>2} из {len(ids)}; найдено регрессий {tp}/{truth.sum()} "
              f"(полнота {rec:.0%}, точность {prec:.0%})")
        # аннотатор, видевший измеренную метку пары до разметки, для неё не слепой — считаем и без таких пар
        if "label_seen_before" in p1[n]:
            blind = (p1[n].loc[ids, "label_seen_before"] != "yes").to_numpy()
            tp_b, fp_b, t_b = int((pred & truth & blind).sum()), int((pred & ~truth & blind).sum()), int((truth & blind).sum())
            report["vs_measured"][n]["blind_only"] = {"recall": tp_b / t_b if t_b else float("nan"),
                                                      "precision": tp_b / (tp_b + fp_b) if tp_b + fp_b else float("nan"),
                                                      "pairs": int(blind.sum()), "regressions": t_b}
            print(f"  {'':<14} только слепые пары ({blind.sum()}): найдено {tp_b}/{t_b} "
                  f"(полнота {tp_b / t_b:.0%}, точность {tp_b / max(tp_b + fp_b, 1):.0%})")

    f2 = {n: base / f"pilot-phase2.{n}.csv" for n in (a_name, b_name)}
    if all(f.exists() for f in f2.values()):
        p2 = {n: pd.read_csv(f, dtype=str).fillna("").set_index(["id", "file"]) for n, f in f2.items()}
        idx = p2[a_name].index.intersection(p2[b_name].index)
        print(f"Фаза 2 (причина регрессии, {len(idx)} файлов)")
        for field in ("is_cause", "perf_category"):
            k, ag, n = kappa(list(p2[a_name].loc[idx, field]), list(p2[b_name].loc[idx, field]))
            report["phase2"][field] = {"kappa": k, "agreement": ag, "n": n}
            print(f"  {field:<16} κ = {k:.2f}   совпадений {ag:.0%}   (n = {n})")
    out = ANN / "agreement.json"
    out.write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"→ {out.relative_to(ROOT)}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "auto":
        run_auto()
    elif cmd == "sample":
        run_sample()
    elif cmd == "agree" and len(sys.argv) == 4:
        run_agree(sys.argv[2], sys.argv[3])
    else:
        print(__doc__)
