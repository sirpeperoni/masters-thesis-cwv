"""
Извлечение признаков из diff «база → коммит» для каждой измеренной пары.

    python ml/features.py --repo excalidraw

Вход:
  data/<repo>.labels.csv  — пары (sha, base_sha) и целевые переменные (npm run label)
  data/<repo>/<sha>.json  — размеры бандла коммита и базы
  work/repos/<repo>       — git-репозиторий (только чтение: diff/show/log между коммитами,
                            рабочую копию не трогаем — сбор данных может идти параллельно)
Выход:
  data/<repo>.features.csv — признаки + целевые переменные, по строке на пару
  data/<repo>.diffs.jsonl  — добавленные/удалённые строки кода (для текстовых моделей)

Группы признаков (префиксы колонок):
  k_    — классические JIT-метрики изменения (Kamei et al.): размер, разброс, энтропия, опыт автора
  cat_  — что затронуто: код, стили, картинки, шрифты, тесты, документация, конфиги
  dep_  — изменения зависимостей в package.json (отдельно dependencies и devDependencies)
  pat_  — frontend-паттерны в добавленных (_add) и удалённых (_del) строках кода
  msg_  — сообщение коммита (тип по Conventional Commits, бот, revert)
  bnd_  — изменение размера сборки (требует сборки, но не замеров — «дешёвый» признак)
  y_    — целевые переменные: Δ медиан и метки по метрикам
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ─── категории файлов ─────────────────────────────────────────────────────────

CODE_EXT = {".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".vue", ".svelte"}
STYLE_EXT = {".css", ".scss", ".sass", ".less", ".styl"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico"}
FONT_EXT = {".woff", ".woff2", ".ttf", ".otf", ".eot"}
DOC_EXT = {".md", ".mdx", ".txt", ".rst"}
LOCKFILES = {"yarn.lock", "package-lock.json", "pnpm-lock.yaml", "bun.lockb", "npm-shrinkwrap.json"}
TEST_RE = re.compile(r"(^|/)(__tests__|__mocks__|tests?|e2e|spec)(/|$)|\.(test|spec)\.[a-z]+$", re.I)
CONFIG_RE = re.compile(
    r"(^|/)(vite|webpack|rollup|babel|tsconfig|svelte|vitepress|postcss|tailwind|eslint|\.eslintrc|prettier)"
    r"[^/]*\.(js|mjs|cjs|ts|json)$",
    re.I,
)


def categorize(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    if name in LOCKFILES:
        return "lock"
    if name == "package.json":
        return "pkg"
    if TEST_RE.search(path):
        return "test"
    if CONFIG_RE.search(path):
        return "config"
    if ext in CODE_EXT:
        return "code"
    if ext in STYLE_EXT:
        return "style"
    if ext == ".html":
        return "html"
    if ext in IMAGE_EXT:
        return "image"
    if ext in FONT_EXT:
        return "font"
    if ext in DOC_EXT:
        return "doc"
    if ext == ".json":
        return "json"
    return "other"


CATEGORIES = ["code", "style", "html", "image", "font", "test", "doc", "config", "json", "pkg", "lock", "other"]
BINARY_CATS = {"image", "font"}  # svg — текстовый, но его строки для нас не информативны

# ─── frontend-паттерны в строках кода и стилей ────────────────────────────────
# Считаются отдельно в добавленных и удалённых строках: «добавил useEffect» ≠ «удалил useEffect».

PATTERNS: dict[str, re.Pattern[str]] = {
    "import_static": re.compile(r"^\s*import\s[^(]"),
    "import_dynamic": re.compile(r"\bimport\s*\("),
    "lazy": re.compile(r"\blazy\s*\(|defineAsyncComponent|\bSuspense\b"),
    "effect": re.compile(r"\buse(Layout|Insertion)?Effect\s*\(|\bonMounted\s*\(|\bwatchEffect\s*\(|\$effect\b"),
    "memo": re.compile(r"\buse(Memo|Callback)\s*\(|\bmemo\s*\(|\bcomputed\s*\("),
    "state": re.compile(r"\buse(State|Reducer|Ref)\s*\(|\bref\s*\(|\breactive\s*\(|\$state\b|\bwritable\s*\("),
    "listener": re.compile(r"addEventListener\s*\(|\bon[A-Z]\w+=\{|@(click|input|keydown|scroll|resize)\b"),
    "timer": re.compile(r"\bset(Timeout|Interval)\s*\("),
    "raf": re.compile(r"requestAnimationFrame|requestIdleCallback"),
    "loop": re.compile(r"\b(for|while)\s*\("),
    "array_iter": re.compile(r"\.(map|forEach|filter|reduce|find|some|every|sort)\s*\("),
    "layout_read": re.compile(r"getBoundingClientRect|offset(Width|Height|Top|Left)|client(Width|Height)|getComputedStyle|scroll(Top|Height)"),
    "dom_query": re.compile(r"querySelector(All)?|getElementById|getElementsBy"),
    "dom_write": re.compile(r"innerHTML|appendChild|insertBefore|\.style\.\w+\s*="),
    "canvas": re.compile(r"getContext\s*\(|\bctx\.\w+|OffscreenCanvas|drawImage"),
    "worker": re.compile(r"new\s+(Shared)?Worker\s*\(|\bwasm\b"),
    "async": re.compile(r"\bawait\b|\.then\s*\("),
    "json": re.compile(r"JSON\.(parse|stringify)"),
    "font": re.compile(r"@font-face|font-display|\.(woff2?|ttf|otf)\b|FontFace\s*\("),
    "image": re.compile(r"<img\b|new\s+Image\s*\(|background(-image)?\s*:\s*url\(|\.(png|jpe?g|webp|avif|gif)\b"),
    "img_dims": re.compile(r"\b(width|height)\s*=\s*[\"'{\d]|aspect-ratio"),
    "loading_hint": re.compile(r"loading=[\"']lazy|fetchpriority|rel=[\"'](preload|prefetch|preconnect|modulepreload)"),
    "css_layout": re.compile(r"^\s*(position|display|flex[\w-]*|grid[\w-]*|width|height|min-\w+|max-\w+|margin[\w-]*|padding[\w-]*|top|left|right|bottom)\s*:"),
    "css_anim": re.compile(r"^\s*(animation[\w-]*|transition[\w-]*|transform|will-change|filter|backdrop-filter|box-shadow)\s*:"),
    "css_selector_heavy": re.compile(r":has\(|:not\(|\*\s*\{|\[\w+[~|^$*]?="),
}
PATTERN_CATS = {"code", "style", "html", "test"}  # test — чтобы отличать «код тестов» (см. pat_* ниже)

CONVENTIONAL_TYPES = ["feat", "fix", "perf", "refactor", "chore", "build", "deps", "style", "docs", "test", "ci", "impr", "revert"]
BOT_RE = re.compile(r"renovate|dependabot|github-actions|\[bot\]", re.I)
CONV_RE = re.compile(r"^(\w+)(\([^)]*\))?!?:")


# ─── git ──────────────────────────────────────────────────────────────────────

def git(repo: Path, *args: str, check: bool = True) -> str:
    r = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()[:500]}")
    return r.stdout


def numstat(repo: Path, base: str, head: str) -> list[tuple[int | None, int | None, str]]:
    """(добавлено, удалено, путь); для бинарных файлов числа — None."""
    out = git(repo, "diff", "--numstat", "-M", "--no-color", base, head)
    rows = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        a, d, path = parts[0], parts[1], parts[-1]
        # переименование в виде "dir/{old => new}.ts" или "old => new"
        if "=>" in path:
            path = re.sub(r"\{[^}]*=> ([^}]*)\}", r"\1", path)
            path = path.split(" => ")[-1]
        rows.append((None if a == "-" else int(a), None if d == "-" else int(d), path.replace("//", "/")))
    return rows


def changed_lines(repo: Path, base: str, head: str, paths: list[str]) -> dict[str, tuple[list[str], list[str]]]:
    """Для каждого файла — (добавленные строки, удалённые строки)."""
    if not paths:
        return {}
    out = git(repo, "diff", "-U0", "--no-color", "-M", base, head, "--", *paths)
    result: dict[str, tuple[list[str], list[str]]] = {}
    current: tuple[list[str], list[str]] | None = None
    for line in out.splitlines():
        if line.startswith("+++ "):
            p = line[4:]
            p = p[2:] if p.startswith("b/") else p
            current = result.setdefault(p, ([], []))
        elif line.startswith("--- ") or line.startswith("@@") or line.startswith("diff "):
            continue
        elif current is not None and line.startswith("+"):
            current[0].append(line[1:])
        elif current is not None and line.startswith("-"):
            current[1].append(line[1:])
    return result


def show_json(repo: Path, rev: str, path: str) -> dict | None:
    out = git(repo, "show", f"{rev}:{path}", check=False)
    try:
        return json.loads(out) if out else None
    except json.JSONDecodeError:
        return None


# ─── группы признаков ─────────────────────────────────────────────────────────

def major(version: str) -> int | None:
    m = re.search(r"(\d+)(?:\.(\d+))?", version or "")
    if not m:
        return None
    # 0.x — мажорной версией считаем минорную (семвер для 0.x)
    return int(m.group(1)) * 1000 + int(m.group(2) or 0) if m.group(1) == "0" else int(m.group(1)) * 1000


def dependency_features(repo: Path, base: str, head: str, pkg_paths: list[str]) -> dict[str, float]:
    f = Counter()
    for path in pkg_paths:
        old, new = show_json(repo, base, path) or {}, show_json(repo, head, path) or {}
        for section, prefix in (("dependencies", "dep_rt"), ("devDependencies", "dep_dev"), ("peerDependencies", "dep_rt")):
            a, b = old.get(section) or {}, new.get(section) or {}
            f[f"{prefix}_added"] += len(b.keys() - a.keys())
            f[f"{prefix}_removed"] += len(a.keys() - b.keys())
            for name in a.keys() & b.keys():
                if a[name] != b[name]:
                    f[f"{prefix}_updated"] += 1
                    ma, mb = major(a[name]), major(b[name])
                    if ma is not None and mb is not None and ma != mb:
                        f[f"{prefix}_major"] += 1
    return {k: f.get(k, 0) for k in (
        "dep_rt_added", "dep_rt_removed", "dep_rt_updated", "dep_rt_major",
        "dep_dev_added", "dep_dev_removed", "dep_dev_updated", "dep_dev_major",
    )}


def entropy(changes: list[int]) -> float:
    """Энтропия распределения изменённых строк по файлам, нормированная на log2(n) (Kamei)."""
    total = sum(changes)
    n = len([c for c in changes if c > 0])
    if total == 0 or n <= 1:
        return 0.0
    h = -sum((c / total) * math.log2(c / total) for c in changes if c > 0)
    return h / math.log2(n)


def message_features(repo: Path, base: str, head: str) -> dict[str, float]:
    subjects = git(repo, "log", "--format=%s", f"{base}..{head}").splitlines()
    authors = git(repo, "log", "--format=%an <%ae>", f"{base}..{head}").splitlines()
    head_subject = subjects[0] if subjects else ""
    m = CONV_RE.match(head_subject.lower())
    ctype = m.group(1) if m else ""
    if "deps" in head_subject.lower() and ctype in ("chore", "build", "fix"):
        ctype = "deps"
    f = {f"msg_type_{t}": float(ctype == t) for t in CONVENTIONAL_TYPES}
    f["msg_type_other"] = float(ctype not in CONVENTIONAL_TYPES)
    f["msg_revert"] = float(head_subject.lower().startswith("revert"))
    f["msg_bot"] = float(any(BOT_RE.search(a) for a in authors))
    f["msg_len"] = float(len(head_subject))
    f["msg_perf_word"] = float(bool(re.search(r"perf|performance|speed|slow|fast|lag|optimi", head_subject, re.I)))
    f["k_commits"] = float(len(subjects))  # коммитов между базой и головой (обычно 1)
    return f


def author_experience(repo: Path, head: str) -> float:
    author = git(repo, "log", "-1", "--format=%ae", head).strip()
    if not author:
        return 0.0
    # --fixed-strings: email ищем как строку, а не как регулярное выражение
    out = git(repo, "rev-list", "--count", "--fixed-strings", f"--author={author}", f"{head}~1", check=False).strip()
    return float(out or 0)


def file_history(repo: Path, head: str, paths: list[str], limit: int = 30) -> dict[str, float]:
    """AGE — средний возраст последнего изменения файлов (дни), NDEV — число разных авторов."""
    head_time = int(git(repo, "log", "-1", "--format=%ct", head).strip())
    ages, devs = [], set()
    for p in paths[:limit]:
        out = git(repo, "log", "--format=%ct %ae", "-n", "20", f"{head}~1", "--", p, check=False).splitlines()
        if out:
            ages.append((head_time - int(out[0].split()[0])) / 86400)
            devs.update(line.split(" ", 1)[1] for line in out if " " in line)
    return {"k_age_days": sum(ages) / len(ages) if ages else 0.0, "k_ndev": float(len(devs))}


def bundle_features(results: dict[str, dict], sha: str, base: str) -> dict[str, float]:
    head_b = (results.get(sha) or {}).get("bundle")
    base_b = (results.get(base) or {}).get("bundle")
    keys = ["bnd_total_gzip", "bnd_js_gzip", "bnd_css_gzip", "bnd_files", "bnd_total_gzip_rel", "bnd_js_gzip_rel"]
    if not head_b or not base_b:
        return {k: float("nan") for k in keys}

    def ext(b: dict, e: str) -> float:
        return float((b.get("byExt", {}).get(e) or {}).get("gzip", 0))

    js_a, js_b = ext(base_b, ".js"), ext(head_b, ".js")
    return {
        "bnd_total_gzip": head_b["totalGzip"] - base_b["totalGzip"],
        "bnd_js_gzip": js_b - js_a,
        "bnd_css_gzip": ext(head_b, ".css") - ext(base_b, ".css"),
        "bnd_files": head_b["files"] - base_b["files"],
        "bnd_total_gzip_rel": (head_b["totalGzip"] - base_b["totalGzip"]) / base_b["totalGzip"] if base_b["totalGzip"] else 0.0,
        "bnd_js_gzip_rel": (js_b - js_a) / js_a if js_a else 0.0,
    }


def extract(repo: Path, sha: str, base: str, results: dict[str, dict]) -> tuple[dict[str, float], dict]:
    files = numstat(repo, base, sha)
    f: dict[str, float] = {}

    # Kamei: размер и разброс изменения
    added = [a or 0 for a, _, _ in files]
    deleted = [d or 0 for _, d, _ in files]
    paths = [p for _, _, p in files]
    f["k_nf"] = float(len(files))
    f["k_la"] = float(sum(added))
    f["k_ld"] = float(sum(deleted))
    f["k_nd"] = float(len({p.rsplit("/", 1)[0] if "/" in p else "." for p in paths}))
    f["k_ns"] = float(len({"/".join(p.split("/")[:2]) for p in paths}))  # подсистема: 2 первых сегмента
    f["k_entropy"] = entropy([a + d for a, d in zip(added, deleted)])
    f["k_binary"] = float(sum(1 for a, _, _ in files if a is None))

    # что затронуто
    cats = [categorize(p) for p in paths]
    for c in CATEGORIES:
        idx = [i for i, x in enumerate(cats) if x == c]
        f[f"cat_{c}_files"] = float(len(idx))
        if c not in BINARY_CATS:  # у двоичных файлов строк нет — признак был бы всегда 0
            f[f"cat_{c}_lines"] = float(sum(added[i] + deleted[i] for i in idx))
    f["cat_only_nonruntime"] = float(all(c in {"test", "doc"} for c in cats)) if cats else 1.0

    # зависимости
    f.update(dependency_features(repo, base, sha, [p for p, c in zip(paths, cats) if c == "pkg"]))

    # паттерны в строках кода/стилей (тесты — отдельно, чтобы не путать с кодом приложения)
    pattern_paths = [p for p, c in zip(paths, cats) if c in PATTERN_CATS]
    lines = changed_lines(repo, base, sha, pattern_paths)
    add_lines, del_lines, test_add = [], [], 0
    for p, (plus, minus) in lines.items():
        if categorize(p) == "test":
            test_add += len(plus)
            continue
        add_lines += plus
        del_lines += minus
    for name, rx in PATTERNS.items():
        a = sum(1 for line in add_lines if rx.search(line))
        d = sum(1 for line in del_lines if rx.search(line))
        f[f"pat_{name}_add"] = float(a)
        f[f"pat_{name}_del"] = float(d)

    f.update(message_features(repo, base, sha))
    f["k_exp"] = author_experience(repo, sha)
    f.update(file_history(repo, sha, [p for p, c in zip(paths, cats) if c not in {"lock", "doc", "test"}]))
    f.update(bundle_features(results, sha, base))

    diff_record = {
        "sha": sha,
        "base": base,
        "files": paths,
        # текст для bag-of-words / CodeBERT; ограничиваем размер, чтобы не тащить мегабайты
        "added": "\n".join(add_lines)[:200_000],
        "removed": "\n".join(del_lines)[:200_000],
    }
    return f, diff_record


# ─── main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="excalidraw")
    args = ap.parse_args()

    repo = ROOT / "work" / "repos" / args.repo
    data_dir = ROOT / "data" / args.repo
    labels_file = ROOT / "data" / f"{args.repo}.labels.csv"
    if not labels_file.exists():
        sys.exit(f"нет {labels_file} — сначала npm run label -- --repo {args.repo}")

    with labels_file.open(encoding="utf-8") as fh:
        labels = [r for r in csv.DictReader(fh) if r["aa"] == "0" and r["base_sha"]]

    results = {}
    for p in data_dir.glob("*.json"):
        if not p.name.endswith(".aa.json"):
            r = json.loads(p.read_text(encoding="utf-8"))
            results[r["sha"]] = r

    rows, diffs = [], []
    for i, lab in enumerate(labels, 1):
        sha, base = lab["sha"], lab["base_sha"]
        try:
            feats, diff = extract(repo, sha, base, results)
        except RuntimeError as e:
            print(f"[{i}/{len(labels)}] {sha[:8]} пропущен: {e}", file=sys.stderr)
            continue
        targets = {f"y_{k}": v for k, v in lab.items() if k.endswith(("_delta", "_rel", "_label", "_q")) or k == "label"}
        rows.append({"sha": sha, "base_sha": base, "date": lab["date"], "status": lab["status"], **feats, **targets})
        diffs.append(diff)
        if i % 25 == 0:
            print(f"[{i}/{len(labels)}]", file=sys.stderr)

    out_csv = ROOT / "data" / f"{args.repo}.features.csv"
    columns = list(rows[0].keys())
    with out_csv.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=columns)
        w.writeheader()
        w.writerows(rows)
    with (ROOT / "data" / f"{args.repo}.diffs.jsonl").open("w", encoding="utf-8") as fh:
        for d in diffs:
            fh.write(json.dumps(d, ensure_ascii=False) + "\n")

    n_feat = sum(1 for c in columns if c.split("_", 1)[0] in {"k", "cat", "dep", "pat", "msg", "bnd"})
    print(f"{args.repo}: {len(rows)} пар, {n_feat} признаков → {out_csv}")


if __name__ == "__main__":
    main()
