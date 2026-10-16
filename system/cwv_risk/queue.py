"""Очередь замеров: связка прогноза (GitHub Action) со стендом (bench/).

Action ставит на pull request с высоким риском метку `cwv-risk: measure`. Агент на машине со стендом опрашивает
GitHub (входящих подключений нет — чужой код из PR не запускается автоматически по событию из интернета):

  1. открытые PR с меткой measure и без метки measured;
  2. коммиты PR и его базовой ветки → в клон стенда work/repos/<проект> (refs/cwv-risk/pr-<N>/…);
  3. стенд измеряет пару «точка ветвления → PR» (`npm run bench -- --repo <проект> --pair <база>:<коммит>`,
     результат — data/<проект>-pr/<sha>.json), разметка — `npm run label -- --repo <проект>-pr`;
  4. раздел «Замер на стенде» дописывается в комментарий cwv-risk, метки: measure → measured + regression | ok.

    python -m cwv_risk queue --github sirpeperoni/bentopdf --bench bentopdf [--once] [--interval 600]

Пока идёт замер, машина должна простаивать (как при обычном сборе).
"""

from __future__ import annotations

import csv
import json
import subprocess
import sys
import time
from pathlib import Path

from ._ml import ROOT

LABEL_MEASURE = "cwv-risk: measure"
LABEL_MEASURED = "cwv-risk: measured"
LABEL_REGRESSION = "cwv-risk: regression"
LABEL_OK = "cwv-risk: ok"
LABELS = {
    LABEL_MEASURE: ("FBCA04", "cwv-risk: поставлен в очередь замеров на стенде"),
    LABEL_MEASURED: ("C5DEF5", "cwv-risk: измерен на стенде"),
    LABEL_REGRESSION: ("D73A4A", "cwv-risk: замер подтвердил регрессию Core Web Vitals"),
    LABEL_OK: ("0E8A16", "cwv-risk: замер регрессии не показал"),
}
MARK_COMMENT = "<!-- cwv-risk -->"
MARK_MEASURED = "<!-- cwv-risk:measured -->"

# метрики итоговой метки стенда (PRIMARY_TARGETS в bench/src/stats.ts) и их подписи
METRICS = [
    ("lcp", "LCP — отрисовка основного содержимого", "мс"),
    ("inp", "INP — отклик на действие", "мс"),
    ("cls", "CLS — сдвиг вёрстки", ""),
    ("tbt", "TBT загрузки — блокировка главного потока", "мс"),
    ("tbtFlow", "TBT сценария взаимодействия", "мс"),
]


def run(cmd: list[str] | str, cwd: Path | None = None, check: bool = True, shell: bool = False) -> str:
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", shell=shell)
    if check and r.returncode != 0:
        raise RuntimeError(f"{cmd if isinstance(cmd, str) else ' '.join(cmd)}: {(r.stderr or r.stdout).strip()[-800:]}")
    return r.stdout


def gh(*args: str, check: bool = True) -> str:
    return run(["gh", *args], check=check)


# ─── GitHub ───────────────────────────────────────────────────────────────────

def pending(repo: str) -> list[dict]:
    out = gh("pr", "list", "--repo", repo, "--state", "open", "--label", LABEL_MEASURE, "--limit", "50",
             "--json", "number,title,headRefOid,baseRefName,labels")
    prs = json.loads(out or "[]")
    return [p for p in prs if LABEL_MEASURED not in {l["name"] for l in p["labels"]}]


def ensure_labels(repo: str) -> None:
    for name, (color, desc) in LABELS.items():
        gh("label", "create", name, "--repo", repo, "--color", color, "--description", desc, "--force", check=False)


def set_labels(repo: str, number: int, add: list[str], remove: list[str]) -> None:
    args = ["pr", "edit", str(number), "--repo", repo]
    for l in add:
        args += ["--add-label", l]
    for l in remove:
        args += ["--remove-label", l]
    gh(*args)


def update_comment(repo: str, number: int, section: str) -> None:
    """Дописать (заменить) раздел замера в комментарии cwv-risk; если комментария нет — создать."""
    comments = json.loads(gh("api", f"repos/{repo}/issues/{number}/comments", "--paginate") or "[]")
    own = next((c for c in comments if c["body"].startswith(MARK_COMMENT)), None)
    if own is None:
        gh("pr", "comment", str(number), "--repo", repo, "--body", MARK_COMMENT + "\n" + section)
        return
    body = own["body"].split(MARK_MEASURED)[0].rstrip() + "\n\n" + section
    tmp = ROOT / "work" / f"cwv-risk-comment-{number}.md"
    tmp.write_text(body, encoding="utf-8")
    gh("api", "-X", "PATCH", f"repos/{repo}/issues/comments/{own['id']}", "-F", f"body=@{tmp}")
    tmp.unlink(missing_ok=True)


# ─── стенд ────────────────────────────────────────────────────────────────────

def fetch(bench: str, repo: str, pr: dict) -> tuple[str, str]:
    """Коммиты PR и базовой ветки → клон стенда; возвращает (точка ветвления, коммит PR)."""
    clone = ROOT / "work" / "repos" / bench
    n = pr["number"]
    run(["git", "-C", str(clone), "fetch", "--no-tags", f"https://github.com/{repo}.git",
         f"+refs/pull/{n}/head:refs/cwv-risk/pr-{n}/head", f"+refs/heads/{pr['baseRefName']}:refs/cwv-risk/pr-{n}/base"])
    head = run(["git", "-C", str(clone), "rev-parse", f"refs/cwv-risk/pr-{n}/head"]).strip()
    if head != pr["headRefOid"]:
        raise RuntimeError(f"PR #{n}: ветка изменилась во время забора ({head[:8]} ≠ {pr['headRefOid'][:8]})")
    base = run(["git", "-C", str(clone), "merge-base", f"refs/cwv-risk/pr-{n}/base", head]).strip()
    return base, head


def measure(bench: str, base: str, head: str) -> dict:
    """Стенд: пара база → коммит, затем разметка датасета <проект>-pr; результат — строка разметки и JSON."""
    print(f"  стенд: {bench} {base[:8]} → {head[:8]} (несколько минут; машина должна простаивать)", flush=True)
    r = subprocess.run(f"npm run bench -- --repo {bench} --pair {base}:{head} --force", cwd=ROOT, shell=True)
    if r.returncode != 0:
        raise RuntimeError(f"стенд завершился с кодом {r.returncode}")
    run(f"npm run label -- --repo {bench}-pr", cwd=ROOT, shell=True)
    result = json.loads((ROOT / "data" / f"{bench}-pr" / f"{head}.json").read_text(encoding="utf-8"))
    row = None
    with (ROOT / "data" / f"{bench}-pr.labels.csv").open(encoding="utf-8") as fh:
        for x in csv.DictReader(fh):
            if x["sha"] == head and x.get("aa", "0") in ("0", "", "False"):
                row = x
    return {"result": result, "row": row}


def fmt(v: str, unit: str) -> str:
    if v in (None, ""):
        return "—"
    x = float(v)
    s = f"{x:.3f}" if unit == "" else f"{x:.0f}"
    return s.replace(".", ",") + (f" {unit}" if unit else "")


def change(row: dict, key: str, unit: str) -> str:
    """Изменение медианы со знаком (типографский минус) и в процентах — если база не нулевая."""
    d = row.get(f"{key}_delta", "")
    if d in ("", None):
        return "—"
    x = float(d)
    out = ("+" if x > 0 else "−" if x < 0 else "") + fmt(str(abs(x)), unit)
    base, rel = row.get(f"{key}_base", ""), row.get(f"{key}_rel", "")
    if rel not in ("", None) and base not in ("", None) and abs(float(base)) > 1e-9 and abs(float(rel)) < 10:
        r = float(rel) * 100
        out += f" ({'+' if r > 0 else '−' if r < 0 else ''}{abs(r):.0f} %)"
    return out


def fmt_q(q: str) -> str:
    if q in ("", None):
        return "—"
    return "< 0,001" if float(q) < 0.001 else f"{float(q):.3f}".replace(".", ",")


def section(m: dict, head: str) -> tuple[str, bool | None]:
    res, row = m["result"], m["row"]
    if res["status"] not in ("ok", "identical_build") or row is None:
        return (f"{MARK_MEASURED}\n#### ⚠️ Замер на стенде не удался\n\nКоммит {head[:8]}: `{res['status']}`"
                f"{' — ' + res.get('error', '')[:300] if res.get('error') else ''}"), None
    if res["status"] == "identical_build":
        return (f"{MARK_MEASURED}\n#### 🟢 Замер на стенде: сборка не изменилась\n\nКоммит {head[:8]}: сборка побайтно "
                "совпадает с базой — изменений производительности нет по построению."), False
    regression = row["label"] == "regression"
    lines = [
        MARK_MEASURED,
        f"#### {'🔴 Замер на стенде: регрессия подтверждена' if regression else '🟢 Замер на стенде: регрессии нет'}",
        "",
        "| Метрика | База | PR | Изменение | q | Итог |",
        "|---|---|---|---|---|---|",
    ]
    names = {"regression": "**регрессия**", "improvement": "улучшение", "none": "—"}
    for key, title, unit in METRICS:
        if f"{key}_label" not in row or row.get(f"{key}_base") in (None, ""):
            continue
        lines.append(f"| {title} | {fmt(row[f'{key}_base'], unit)} | {fmt(row[f'{key}_head'], unit)} | "
                     f"{change(row, key, unit)} | {fmt_q(row.get(f'{key}_q', ''))} | {names.get(row[f'{key}_label'], row[f'{key}_label'])} |")
    pairs = res.get("method", {})
    lines += ["", f"<sub>Коммит {head[:8]} против точки ветвления {res['base']['sha'][:8]}: Lighthouse, база и PR вперемешку "
              f"(AB BA…), {pairs.get('pairs', 5)}{' + ' + str(pairs.get('extra', 10)) if res.get('extended') else ''} пар; "
              "регрессия — значимо (BH q < 0,05) и больше порога метрики.</sub>"]
    return "\n".join(lines), regression


# ─── цикл ─────────────────────────────────────────────────────────────────────

def process(repo: str, bench: str) -> int:
    prs = pending(repo)
    if not prs:
        print("очередь пуста", flush=True)
        return 0
    ensure_labels(repo)
    for pr in prs:
        n = pr["number"]
        print(f"PR #{n}: {pr['title'][:70]}", flush=True)
        try:
            base, head = fetch(bench, repo, pr)
            text, regression = section(measure(bench, base, head), head)
        except Exception as e:  # noqa: BLE001 — сбой одного PR не останавливает очередь
            print(f"  ошибка: {e}", file=sys.stderr, flush=True)
            text, regression = f"{MARK_MEASURED}\n#### ⚠️ Замер на стенде не удался\n\n`{str(e)[:400]}`", None
        update_comment(repo, n, text)
        add = [LABEL_MEASURED] + ([LABEL_REGRESSION] if regression else [LABEL_OK] if regression is False else [])
        set_labels(repo, n, add=add, remove=[LABEL_MEASURE])
        print(f"  → {'регрессия' if regression else 'регрессии нет' if regression is False else 'не измерен'}", flush=True)
    return len(prs)


def loop(repo: str, bench: str, once: bool, interval: int) -> None:
    while True:
        process(repo, bench)
        if once:
            return
        time.sleep(interval)
