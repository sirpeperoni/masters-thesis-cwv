"""
Разметка текстовых данных (лабораторная «Разметка текстовых данных»): описания изменений —
сообщения коммитов и описания pull request'ов — для пар пилотной выборки (annotations/text-diff/pilot-key.csv).
Схема — docs/annotation-schema.md, раздел «Текст: описание изменения».

    python ml/text_annotation.py fetch      # тексты с GitHub → annotations/text-desc/documents.jsonl
    python ml/text_annotation.py annotate   # автоматическая разметка (разделы, токены, части речи, сущности)
                                            # + ручные правки из manual-fixes.json → spans.jsonl, tokens.tsv
    python ml/text_annotation.py export     # WebAnno TSV 3.3 для INCEpTION и HTML-визуализация
    python ml/text_annotation.py analyze    # связи между уровнями и с измеренной регрессией → analysis.json
"""

from __future__ import annotations

import html
import json
import re
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from annotation import GITHUB  # noqa: E402
from features import git  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "annotations" / "text-desc"
KEY = ROOT / "annotations" / "text-diff" / "pilot-key.csv"
MAX_CHARS = 3000  # ≈ одна страница; длиннее — обрезаем (шаг 1.3: от половины до одной страницы)
MIN_CHARS = 500   # короче — однострочные сообщения без PR: в корпус разметки не входят (шаг 1.2: сопоставимый объём)
PR_RE = re.compile(r"(?:Merge pull request #|\(#)(\d+)")


# ─── шаг 1: подготовка данных ─────────────────────────────────────────────────

def gh_pr(repo: str, number: str) -> dict | None:
    r = subprocess.run(["gh", "api", f"repos/{GITHUB[repo]}/pulls/{number}", "--jq", "{title: .title, body: .body}"],
                       capture_output=True, text=True, encoding="utf-8")
    return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None


def clean(text: str) -> str:
    """Убираем разметку, которая не несёт смысла для чтения: HTML-комментарии шаблонов PR, картинки, теги,
    адреса ссылок (остаётся текст ссылки), HTML-сущности и невидимые символы."""
    text = re.sub(r"<!--.*?-->", "", text or "", flags=re.S)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "[изображение]", text)
    text = re.sub(r"<img[^>]*>", "[изображение]", text)
    text = re.sub(r"\[([^\]]*)\]\((?:https?://|/)[^)\s]*\)", r"\1", text)  # [текст](url) → текст
    text = re.sub(r"</?(details|summary|br|p|div|sub|sup|kbd|b|i|a)\b[^>]*>", "", text)
    text = html.unescape(text).replace("​", "")
    text = re.sub(r"\r\n?", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def run_fetch() -> None:
    key = pd.read_csv(KEY)
    OUT.mkdir(parents=True, exist_ok=True)
    docs = []
    for _, k in key.iterrows():
        repo_dir = ROOT / "work" / "repos" / k.repo
        log = git(repo_dir, "log", "--first-parent", "--format=%H%x1f%s%x1f%b%x1e", f"{k.base_sha}..{k.sha}")
        commits = []
        for rec in log.split("\x1e"):
            if rec.strip():
                sha, subject, body = (rec.strip("\n").split("\x1f") + ["", ""])[:3]
                commits.append({"sha": sha, "subject": subject, "body": clean(body)})
        prs = []
        for n in dict.fromkeys(m for c in commits for m in PR_RE.findall(c["subject"])):
            pr = gh_pr(k.repo, n)
            if pr:
                prs.append({"number": int(n), "title": pr["title"], "body": clean(pr["body"] or "")})
        # документ: по части на коммит (сообщение) и на PR (заголовок + описание); тело merge-коммита
        # повторяет заголовок PR — его не дублируем
        pr_titles = {p["title"].strip() for p in prs}
        parts = []
        for c in commits:
            body = "" if c["body"].strip() in pr_titles else c["body"]
            parts.append(("commit", f"{c['subject']}\n{body}".strip()))
        for p in prs:
            parts.append(("pr", f"{p['title']}\n\n{p['body']}".strip()))
        text, spans = "", []
        for kind, t in parts:
            if text:
                text += "\n\n"
            spans.append({"kind": kind, "start": len(text), "end": len(text) + len(t)})
            text += t
        truncated = len(text) > MAX_CHARS
        if truncated:
            text = text[:MAX_CHARS].rsplit("\n", 1)[0] + "\n[…]"
            spans = [{**s, "end": min(s["end"], len(text))} for s in spans if s["start"] < len(text)]
        docs.append({"id": k.id, "repo": k.repo, "sha": k.sha, "base": k.base_sha, "commits": len(commits),
                     "prs": [p["number"] for p in prs], "chars": len(text), "truncated": truncated,
                     "in_corpus": len(text) >= MIN_CHARS, "parts": spans, "text": text})
        print(f"  {k.id} {k.repo:<20} коммитов {len(commits):>2}, PR {len(prs)}, символов {len(text):>5}{' (обрезан)' if truncated else ''}")
    path = OUT / "documents.jsonl"
    path.write_text("".join(json.dumps(d, ensure_ascii=False) + "\n" for d in docs), encoding="utf-8")
    print(f"→ {path.relative_to(ROOT)}")


def load_docs(corpus_only: bool = True) -> list[dict]:
    docs = [json.loads(l) for l in (OUT / "documents.jsonl").read_text(encoding="utf-8").splitlines()]
    return [d for d in docs if d["in_corpus"]] if corpus_only else docs


# ─── шаги 3–4: наборы тегов ───────────────────────────────────────────────────

# Уровень 2: тип раздела (абзаца). Первая строка части документа — TITLE.
# Схема v2 (после анализа разметки v1): добавлен SQUASH_LOG — склеенные сообщения подкоммитов в теле
# squash-коммита (не авторский текст, а журнал); разделители «-----» разделами не считаются.
# Тоже v2: TEMPLATE — незаполненный текст шаблона PR; AI_NOTE — отметка об ИИ-помощнике
# («Made with Cursor», «Generated with Claude Code», соавтор Claude в трейлере).
SECTION_TYPES = ["TITLE", "HEADING", "DESCRIPTION", "MOTIVATION", "CHANGE_LIST", "SQUASH_LOG", "TESTING", "CHECKLIST",
                 "DEP_TABLE", "RELEASE_NOTES", "BOT_BOILERPLATE", "TEMPLATE", "REFERENCE", "TRAILER", "AI_NOTE"]
TEMPLATE_RE = re.compile(r"brief description about the content of your pr|your issue id here|describe the way your "
                         r"implementation works|^\s*make sure you\s*$", re.I | re.M)
AI_RE = re.compile(r"made with cursor|generated with claude|co-authored-by:\s*(claude|copilot|cursor)", re.I)

# Именованные сущности: тип → подтип (шаг 4.2 — разбиение крупных типов на более конкретные)
FRAMEWORKS = {"react", "react-dom", "svelte", "sveltekit", "@sveltejs/kit", "solid", "solid-js", "solidjs", "vue",
              "vitepress", "preact", "jquery"}
BUILD_TOOLS = {"vite", "vitest", "rollup", "rolldown", "esbuild", "webpack", "turbo", "turborepo", "pnpm", "yarn",
               "npm", "typescript", "eslint", "prettier", "oxlint", "playwright", "jest", "babel", "postcss",
               "node", "nodejs", "corepack", "renovate", "husky", "knip", "vercel", "netlify", "docker"}
STYLE_LIBS = {"tailwind", "tailwindcss", "sass", "scss", "shadcn", "shadcn-svelte", "daisyui", "bits-ui",
              "fontawesome", "font awesome", "font-awesome", "css"}
EXTRA_LIBS = {"mermaid", "firebase", "monaco", "monaco-editor", "tanstack", "howler", "katex", "lodash", "zod",
              "chart.js", "panzoom", "pako", "crowdin", "sentry", "mode-watcher", "uuid", "roughjs", "elkjs",
              "zenuml", "cytoscape", "dagre", "d3", "perfect-freehand", "jotai", "workbox", "comlink"}
# имена пакетов, совпадающие с обычными словами, — не размечаем по словарю
COMMON_WORDS = {"open", "path", "color", "events", "buffer", "util", "process", "assert", "debug", "image", "canvas",
                "random", "ms", "idb", "nanoid", "clsx", "diff", "glob", "lint", "test", "build", "types", "core",
                "sharp", "dotenv", "cross-env", "concurrently", "plugin", "tests", "font", "fonts", "icons", "app",
                "which", "once", "mime", "ws", "semver", "commander", "chalk", "picocolors", "minimist"}
UI_WORDS = {"editor", "modal", "dialog", "toolbar", "navbar", "sidebar", "button", "banner", "menu", "panel",
            "popover", "tooltip", "header", "footer", "page", "tab", "tabs", "dropdown", "picker",
            "slider", "input", "theme", "icon", "icons", "layout", "toast", "card", "popup", "searchbar",
            "screen", "view", "preview", "library", "properties panel", "command palette", "settings"}
# Схема v2: объекты предметной области приложения (что пользователь создаёт и редактирует), а не элементы
# интерфейса — в v1 «frame», «canvas», «theme» диаграммы ошибочно попадали в UI_COMPONENT
DOMAIN_WORDS = {"frame", "diagram", "flowchart", "node", "element", "arrow", "shape", "text element", "canvas",
                "chart", "sequence diagram", "scene", "drawing", "word", "quote", "test result"}
PERF_WORDS = {"performance", "perf", "faster", "fast", "slow", "slower", "speed", "speedup", "lazy", "lazily",
              "lazy-load", "lazy load", "bundle size", "bundle", "load time", "loading", "render", "rendering",
              "re-render", "rerender", "memory", "optimize", "optimise", "optimization", "optimisation", "cache",
              "caching", "lcp", "cls", "inp", "tbt", "fid", "lighthouse", "debounce", "throttle", "latency",
              "first load", "jank", "lag", "smooth", "heavy", "lightweight"}
ACTIONS = {
    "ADD": {"add", "adds", "added", "adding", "introduce", "introduces", "implement", "implements", "support", "allow"},
    "REMOVE": {"remove", "removes", "removed", "delete", "deleted", "drop", "drops", "hide", "hides", "disable"},
    "UPDATE": {"update", "updates", "updated", "bump", "bumps", "bumped", "upgrade", "upgrades", "upgraded"},
    "FIX": {"fix", "fixes", "fixed", "resolve", "resolves", "correct"},
    "REFACTOR": {"refactor", "refactors", "migrate", "migrates", "replace", "replaces", "rewrite", "move", "moves",
                 "simplify", "rename", "cleanup", "clean", "extract"},  # v2: «use» убрано — слишком общее
}
ENTITY_TYPES = {  # тип (шаг 4.1) → подтипы (шаг 4.2)
    "LIBRARY": ["FRAMEWORK", "BUILD_TOOL", "STYLE_LIB", "PACKAGE"],
    "VERSION": ["VERSION"],
    "UI_COMPONENT": ["UI_COMPONENT"],
    "DOMAIN_OBJECT": ["DOMAIN_OBJECT"],  # v2
    "PERF": ["PERF"],
    "ACTION": list(ACTIONS),
    "CODE": ["CODE"],
    "REFERENCE": ["ISSUE", "COMMIT"],  # v2: в v1 — ISSUE; хеши коммитов в обратных кавычках были «кодом»
    "PERSON": ["PERSON"],
}
SUBTYPE_TO_TYPE = {s: t for t, subs in ENTITY_TYPES.items() for s in subs}
TOKEN_RE = re.compile(r"[@#]?[\w][\w.\-/@#'^~]*[\w]|[@#]?\w|[^\w\s]")


def repo_packages(repo: str) -> set[str]:
    """Имена зависимостей из всех package.json проекта на последнем коммите (словарь для сущностей LIBRARY)."""
    repo_dir = ROOT / "work" / "repos" / repo
    names: set[str] = set()
    for path in git(repo_dir, "ls-tree", "-r", "--name-only", "HEAD").splitlines():
        if path.endswith("package.json") and "node_modules" not in path and path.count("/") <= 3:
            try:
                pkg = json.loads(git(repo_dir, "show", f"HEAD:{path}"))
            except Exception:  # noqa: BLE001
                continue
            for field in ("dependencies", "devDependencies", "peerDependencies"):
                names |= set((pkg.get(field) or {}).keys())
    return {n.lower() for n in names if len(n) >= 3 and n.lower() not in COMMON_WORDS}


def library_subtype(name: str) -> str:
    n = name.lower()
    base = n.split("/")[-1]
    if n in FRAMEWORKS or base in FRAMEWORKS:
        return "FRAMEWORK"
    if n in BUILD_TOOLS or base in BUILD_TOOLS:
        return "BUILD_TOOL"
    if n in STYLE_LIBS or base in STYLE_LIBS or "tailwind" in n:
        return "STYLE_LIB"
    return "PACKAGE"


def section_type(par: str, first: bool, part: str = "pr") -> str:
    """Тип абзаца по правилам (уровень 2); ручные правки — в manual-fixes.json."""
    lines = [l for l in par.splitlines() if l.strip()]
    low = par.lower()
    if first:
        return "TITLE"
    if AI_RE.search(par) and len(par) < 200:
        return "AI_NOTE"
    if TEMPLATE_RE.search(par) and len(par) < 300:
        return "TEMPLATE"
    bullets = sum(bool(re.match(r"\s*([-*•]|\d+\.)\s", l)) for l in lines)
    # v2: тело squash-коммита — пункты «* сообщение подкоммита», склеенные Git(Hub) автоматически
    if part == "commit" and all(l.lstrip().startswith("* ") for l in lines):
        return "SQUASH_LOG"
    if re.match(r"\s*(fix(es|ed)?|close[sd]?|resolve[sd]?|related|refs?|see)\b:?\s*(#\d+|https?://\S+/(issues|pull)/\d+)", par, re.I) \
            or all(re.fullmatch(r"\s*([-*]\s*)?(https?://\S+|#\d+[\w ,#]*|(fixes|closes|resolves):?)\s*", l, re.I) for l in lines):
        return "REFERENCE"
    if all(re.match(r"\s*(co-authored-by|signed-off-by)\b", l, re.I) for l in lines):
        return "TRAILER"
    if re.match(r"\s*#{1,6}\s", lines[0]) and len(lines) == 1:
        return "RELEASE_NOTES" if "release notes" in low else "HEADING"
    if sum(l.strip().startswith("|") for l in lines) >= 2:
        return "DEP_TABLE"
    if sum(bool(re.match(r"\s*[-*]\s\[[ xX]\]", l)) for l in lines) >= max(1, len(lines) // 2):
        return "CHECKLIST"
    if re.search(r"this pr (contains|was generated|has been generated|body was truncated)|mend renovate|📅|🚦|♻|🔕", low):
        return "BOT_BOILERPLATE"
    if re.search(r"compare source|patch changes|minor changes|major changes|release notes|changelog|^v?\d+\.\d+", low):
        return "RELEASE_NOTES"
    if bullets >= max(1, (len(lines) + 1) // 2):  # v2: одиночный пункт списка — тоже список изменений
        return "CHANGE_LIST"
    if re.search(r"\btest(ed|ing)?\b|\bscreenshot|\[изображение\]|before\b.*after\b|\bverified\b", low) and len(par) < 400:
        return "TESTING"
    if re.search(r"\b(because|why|motivation|problem|so that|in order to|caused by)\b", low):  # v2: без «issue»
        return "MOTIVATION"
    return "DESCRIPTION"


def find_entities(text: str, pkgs: set[str]) -> list[dict]:
    """Кандидаты сущностей по регулярным выражениям и словарям; пересечения — по приоритету и длине."""
    cands: list[tuple[int, int, str, int]] = []  # start, end, subtype, priority
    add = lambda m, sub, pr: cands.append((m.start(), m.end(), sub, pr))
    libs = pkgs | FRAMEWORKS | BUILD_TOOLS | STYLE_LIBS | EXTRA_LIBS
    for m in re.finditer(r"`([^`\n]{1,80})`", text):
        # v2: содержимое обратных кавычек классифицируется — в v1 всё было CODE
        inner = m.group(1).strip()
        if re.fullmatch(r"[\^~]?v?\d+\.\d+(\.\d+)?(-[\w.]+)?", inner):
            add(m, "VERSION", 0)
        elif re.fullmatch(r"[0-9a-f]{7,40}", inner) and re.search(r"\d", inner) and re.search(r"[a-f]", inner):
            add(m, "COMMIT", 0)
        elif inner.lower() in libs or re.fullmatch(r"@[\w-]+/[\w.*-]+", inner):
            add(m, library_subtype(inner), 0)
        else:
            add(m, "CODE", 0)
    for m in re.finditer(r"(?<![\w`])[0-9a-f]{7,12}(?![\w`])", text):
        if re.search(r"\d", m.group()) and re.search(r"[a-f]", m.group()):
            add(m, "COMMIT", 1)
    for m in re.finditer(r"\b[\w./-]+\.(?:tsx?|jsx?|mjs|cjs|svelte|vue|json|s?css|md|html|ya?ml)\b", text):
        add(m, "CODE", 0)
    for m in re.finditer(r"(?<![\w/])#\d+\b", text):
        add(m, "ISSUE", 1)
    for m in re.finditer(r"(?<![\w.])@[A-Za-z0-9][\w-]*(?![\w/])", text):
        add(m, "PERSON", 2)
    for m in re.finditer(r"(?<![\w.])[\^~]?v?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?(?:\.x)?\b|(?<![\w.])\d+\.x\b", text):
        add(m, "VERSION", 3)
    for name in sorted(libs, key=len, reverse=True):
        for m in re.finditer(rf"(?<![\w@/.-]){re.escape(name)}(?![\w/-])", text, re.I):
            add(m, library_subtype(name), 4)
    for word in PERF_WORDS:
        for m in re.finditer(rf"\b{re.escape(word)}\b", text, re.I):
            add(m, "PERF", 5)
    for word in DOMAIN_WORDS:
        for m in re.finditer(rf"\b{re.escape(word)}s?\b", text, re.I):
            add(m, "DOMAIN_OBJECT", 6)
    for word in UI_WORDS:
        for m in re.finditer(rf"\b{re.escape(word)}s?\b", text, re.I):
            add(m, "UI_COMPONENT", 6)
    for sub, words in ACTIONS.items():
        for m in re.finditer(r"(?:^|(?<=[\s:(*\-]))(" + "|".join(sorted(words, key=len, reverse=True)) + r")\b", text, re.I | re.M):
            # действие — только в начале строки/заголовка или после «type:» (повелительное наклонение коммитов)
            line_start = text.rfind("\n", 0, m.start(1)) + 1
            prefix = text[line_start:m.start(1)]
            if re.fullmatch(r"[\s*\-•\d.]*(\w+(\([^)]*\))?!?:\s*)?", prefix):
                cands.append((m.start(1), m.end(1), sub, 7))
    cands.sort(key=lambda c: (c[3], -(c[1] - c[0]), c[0]))
    taken: list[tuple[int, int]] = []
    out = []
    for s, e, sub, _ in cands:
        if any(s < te and ts < e for ts, te in taken):
            continue
        taken.append((s, e))
        out.append({"start": s, "end": e, "label": sub, "type": SUBTYPE_TO_TYPE[sub], "text": text[s:e], "source": "auto"})
    return sorted(out, key=lambda x: x["start"])


def paragraphs(doc: dict) -> list[dict]:
    """Абзацы с типом: части документа (коммит, PR) делятся по пустым строкам; первая строка части — заголовок."""
    text, out = doc["text"], []
    for part in doc["parts"]:
        chunk = text[part["start"]:part["end"]]
        first_nl = chunk.find("\n")
        title_end = part["start"] + (first_nl if first_nl >= 0 else len(chunk))
        out.append({"start": part["start"], "end": title_end, "label": "TITLE", "part": part["kind"]})
        in_notes = False
        for m in re.finditer(r"(?:[^\n]|\n(?!\s*\n))+", text[title_end:part["end"]]):
            s, e = title_end + m.start(), title_end + m.end()
            seg = text[s:e]
            if not seg.strip() or re.fullmatch(r"\s*[-=_*]{3,}\s*", seg):  # пусто или разделитель «-----»
                continue
            lead = len(seg) - len(seg.lstrip())
            label = section_type(seg.strip(), False, part["kind"])
            # заметки к релизу в PR ботов: всё от «Release Notes» до «Configuration» — один вид текста
            # (внутри — заголовки версий, списки изменений, HTML-таблицы спонсоров)
            if label == "RELEASE_NOTES" and re.match(r"\s*#+\s*release notes", seg, re.I):
                in_notes = True
            elif label == "HEADING" and re.match(r"\s*#+\s*configuration", seg, re.I):
                in_notes = False
            elif in_notes and label != "HEADING":
                label = "RELEASE_NOTES"
            prev = out[-1]
            # пункты одного списка, разделённые пустыми строками, — один раздел
            if label in ("SQUASH_LOG", "CHANGE_LIST", "RELEASE_NOTES", "BOT_BOILERPLATE", "TESTING") \
                    and prev["label"] == label and prev["part"] == part["kind"]:
                prev["end"] = e
                continue
            out.append({"start": s + lead, "end": e, "label": label, "part": part["kind"]})
    return out


def tokens(doc: dict) -> list[dict]:
    """Токены и части речи (универсальный набор тегов NLTK); предложение = строка текста."""
    import nltk
    out, text = [], doc["text"]
    for sent_no, line in enumerate(m for m in re.finditer(r"[^\n]+", text) if m.group().strip()):
        toks = [(t.start() + line.start(), t.end() + line.start(), t.group()) for t in TOKEN_RE.finditer(line.group())]
        if not toks:
            continue
        tags = nltk.pos_tag([t for _, _, t in toks], tagset="universal")
        for i, ((s, e, t), (_, pos)) in enumerate(zip(toks, tags)):
            out.append({"sent": sent_no + 1, "tok": i + 1, "start": s, "end": e, "text": t, "pos": pos})
    return out


def apply_fixes(doc_id: str, text: str, ents: list[dict], secs: list[dict], fixes: dict) -> tuple[list[dict], list[dict]]:
    """Ручные правки аннотатора: удалить/добавить/переименовать сущности, переопределить тип раздела.
    Селекторы — по тексту, а не по смещениям: правки переживают изменение предобработки."""
    applies = lambda f: f.get("doc", "*") in ("*", doc_id)
    for f in fixes.get("remove", []):
        if applies(f):
            ents = [e for e in ents if not (e["text"].lower() == f["text"].lower() and f.get("label", e["label"]) == e["label"])]
    for f in fixes.get("relabel", []):
        if applies(f):
            for e in ents:
                if e["text"].lower() == f["text"].lower() and f.get("from", e["label"]) == e["label"]:
                    e.update(label=f["to"], type=SUBTYPE_TO_TYPE[f["to"]], source="manual")
    for f in fixes.get("add", []):
        if applies(f):
            for m in re.finditer(rf"(?<![\w]){re.escape(f['text'])}(?![\w])", text):
                if not any(m.start() < e["end"] and e["start"] < m.end() for e in ents):
                    ents.append({"start": m.start(), "end": m.end(), "label": f["label"], "type": SUBTYPE_TO_TYPE[f["label"]],
                                 "text": m.group(), "source": "manual"})
    for f in fixes.get("sections", []):
        if applies(f):
            for s in secs:
                if text[s["start"]:s["end"]].lstrip().startswith(f["starts_with"]):
                    s.update(label=f["label"], source="manual")
    return sorted(ents, key=lambda e: e["start"]), secs


def run_annotate() -> None:
    fixes_path = OUT / "manual-fixes.json"
    fixes = json.loads(fixes_path.read_text(encoding="utf-8")) if fixes_path.exists() else {}
    pkgs = {r: repo_packages(r) for r in GITHUB}
    spans, toks_rows = [], []
    for d in load_docs():
        secs = [{**s, "source": "auto"} for s in paragraphs(d)]
        ents = find_entities(d["text"], pkgs[d["repo"]])
        ents, secs = apply_fixes(d["id"], d["text"], ents, secs, fixes)
        for s in secs:
            spans.append({"doc": d["id"], "layer": "section", **{k: s[k] for k in ("start", "end", "label", "source")},
                          "text": d["text"][s["start"]:s["end"]][:80]})
        for e in ents:
            spans.append({"doc": d["id"], "layer": "entity", **e})
        for t in tokens(d):
            toks_rows.append({"doc": d["id"], **t})
    (OUT / "spans.jsonl").write_text("".join(json.dumps(s, ensure_ascii=False) + "\n" for s in spans), encoding="utf-8")
    pd.DataFrame(toks_rows).to_csv(OUT / "tokens.tsv", sep="\t", index=False)
    ent = [s for s in spans if s["layer"] == "entity"]
    print(f"документов {len(load_docs())}, токенов {len(toks_rows)}, разделов {len(spans) - len(ent)}, сущностей {len(ent)} "
          f"(ручных {sum(s['source'] == 'manual' for s in spans)})")
    print("  сущности:", dict(Counter(e["label"] for e in ent).most_common()))
    print("  разделы:", dict(Counter(s["label"] for s in spans if s["layer"] == "section").most_common()))


# ─── экспорт: WebAnno TSV 3.3 (INCEpTION) и HTML-визуализация ─────────────────

def load_spans() -> tuple[dict, dict, dict]:
    spans = [json.loads(l) for l in (OUT / "spans.jsonl").read_text(encoding="utf-8").splitlines()]
    toks = pd.read_csv(OUT / "tokens.tsv", sep="\t", keep_default_na=False)
    ents, secs = defaultdict(list), defaultdict(list)
    for s in spans:
        (ents if s["layer"] == "entity" else secs)[s["doc"]].append(s)
    return ents, secs, {d: g.to_dict("records") for d, g in toks.groupby("doc")}


def webanno_tsv(doc: dict, ents: list[dict], toks: list[dict]) -> str:
    """Формат WebAnno TSV 3.3: слой частей речи (POS) и именованных сущностей (NamedEntity) — встроенные
    слои INCEpTION, файл импортируется без настройки проекта. Сущность из нескольких токенов — «LABEL[n]»."""
    lines = ["#FORMAT=WebAnno TSV 3.3",
             "#T_SP=de.tudarmstadt.ukp.dkpro.core.api.lexmorph.type.pos.POS|PosValue",
             "#T_SP=de.tudarmstadt.ukp.dkpro.core.api.ner.type.NamedEntity|value", "", ""]
    ent_of = {}
    for n, e in enumerate(ents, start=1):
        covered = [t for t in toks if t["start"] < e["end"] and e["start"] < t["end"]]
        for t in covered:
            ent_of.setdefault((t["sent"], t["tok"]), e["label"] + (f"[{n}]" if len(covered) > 1 else ""))
    text = doc["text"]
    for sent, group in pd.DataFrame(toks).groupby("sent", sort=True):
        rows = group.to_dict("records")
        sent_text = text[rows[0]["start"]:rows[-1]["end"]]
        lines.append("#Text=" + sent_text.replace("\\", "\\\\").replace("\t", "\\t"))
        for t in rows:
            tok = str(t["text"]).replace("\\", "\\\\")
            lines.append(f"{sent}-{t['tok']}\t{t['start']}-{t['end']}\t{tok}\t{t['pos']}\t{ent_of.get((sent, t['tok']), '_')}\t")
        lines.append("")
    return "\n".join(lines) + "\n"


ENTITY_RU = {"LIBRARY": "библиотека", "VERSION": "версия", "UI_COMPONENT": "интерфейс", "DOMAIN_OBJECT": "объект",
             "PERF": "производительность", "ACTION": "действие", "CODE": "код", "REFERENCE": "ссылка", "PERSON": "автор"}
SECTION_RU = {"TITLE": "заголовок", "HEADING": "подзаголовок", "DESCRIPTION": "описание", "MOTIVATION": "мотивация",
              "CHANGE_LIST": "список изменений", "SQUASH_LOG": "журнал squash", "TESTING": "проверка",
              "CHECKLIST": "чек-лист", "DEP_TABLE": "таблица версий", "RELEASE_NOTES": "заметки к релизу",
              "BOT_BOILERPLATE": "текст бота", "TEMPLATE": "шаблон PR", "REFERENCE": "ссылки", "TRAILER": "трейлер",
              "AI_NOTE": "ИИ-помощник"}


def render_text(text: str, start: int, end: int, ents: list[dict]) -> str:
    out, pos = [], start
    for e in ents:
        if e["start"] < start or e["end"] > end:
            continue
        out.append(html.escape(text[pos:e["start"]]))
        out.append(f'<mark class="e e-{e["type"].lower()}" title="{e["label"]}{" · вручную" if e["source"] == "manual" else ""}">'
                   f'{html.escape(text[e["start"]:e["end"]])}</mark>')
        pos = e["end"]
    out.append(html.escape(text[pos:end]))
    return "".join(out)


def run_export() -> None:
    docs = {d["id"]: d for d in load_docs()}
    ents, secs, toks = load_spans()
    key = pd.read_csv(KEY).set_index("id")
    tsv_dir = OUT / "webanno"
    tsv_dir.mkdir(exist_ok=True)
    for i, d in docs.items():
        (tsv_dir / f"{i}.tsv").write_text(webanno_tsv(d, ents[i], toks[i]), encoding="utf-8")
    print(f"  → {tsv_dir.relative_to(ROOT)}/ ({len(docs)} файлов WebAnno TSV 3.3)")

    type_counts = Counter(e["type"] for i in docs for e in ents[i])
    legend = "".join(
        f'<label class="chip"><input type="checkbox" id="f-{t.lower()}" data-type="{t.lower()}" checked>'
        f'<mark class="e e-{t.lower()}">{ENTITY_RU[t]}</mark><span class="n">{type_counts.get(t, 0)}</span></label>'
        for t in ENTITY_TYPES)
    cards = []
    for i, d in docs.items():
        label = key.loc[i, "label"]
        metrics = key.loc[i, "regressed_metrics"] if isinstance(key.loc[i, "regressed_metrics"], str) else ""
        verdict = (f'<span class="pill pill-reg">регрессия · {metrics.replace(";", ", ")}</span>' if label == "regression"
                   else '<span class="pill">без регрессии</span>')
        rows = "".join(
            f'<div class="sec"><div class="sec-label s-{s["label"].lower()}">{SECTION_RU[s["label"]]}'
            f'{" ✎" if s.get("source") == "manual" else ""}</div>'
            f'<pre class="sec-text">{render_text(d["text"], s["start"], s["end"], ents[i])}</pre></div>'
            for s in sorted(secs[i], key=lambda s: s["start"]))
        url = f"https://github.com/{GITHUB[d['repo']]}/compare/{d['base'][:12]}...{d['sha'][:12]}"
        cards.append(
            f'<article class="doc" id="{i}"><header class="doc-head"><h2>{i}</h2><span class="repo">{d["repo"]}</span>'
            f'{verdict}<span class="meta">{d["chars"]} симв. · {len(toks[i])} токенов · {len(ents[i])} сущностей</span>'
            f'<a href="{url}" target="_blank" rel="noopener">diff на GitHub</a></header>{rows}</article>')
    nav = "".join(f'<a href="#{i}" class="{"reg" if key.loc[i, "label"] == "regression" else ""}">{i}</a>' for i in docs)
    page = VIZ_TEMPLATE.replace("{{LEGEND}}", legend).replace("{{NAV}}", nav).replace("{{CARDS}}", "".join(cards)) \
        .replace("{{N_DOCS}}", str(len(docs))).replace("{{N_TOK}}", str(sum(len(t) for t in toks.values()))) \
        .replace("{{N_ENT}}", str(sum(type_counts.values()))) \
        .replace("{{N_SEC}}", str(sum(len(s) for s in secs.values())))
    (OUT / "visualization.html").write_text(page, encoding="utf-8")
    print(f"  → {(OUT / 'visualization.html').relative_to(ROOT)}")


VIZ_TEMPLATE = """<title>Разметка описаний коммитов</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
/* Вид: рабочий просмотрщик разметки — слева тип раздела, справа текст с подсвеченными сущностями. */
:root {
  --bg: #f4f5f2; --surface: #fcfcfa; --fg: #1d2433; --muted: #5b6475; --line: #d9dcd4; --accent: #c8611d;
  --reg: #b3261e; --reg-bg: #fbe3df;
  --e-library: #d6e4f7; --e-version: #e4dcf5; --e-ui_component: #d9efe0; --e-domain_object: #c9ece8;
  --e-perf: #fbd9b8; --e-action: #f2e5b3; --e-code: #e6e6e1; --e-reference: #e9d9e6; --e-person: #f3d6d6;
  --sans: 'IBM Plex Sans', 'Segoe UI', Arial, sans-serif; --mono: 'IBM Plex Mono', Consolas, 'Courier New', monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #14181f; --surface: #1b2029; --fg: #e6e8ec; --muted: #9aa3b2; --line: #2e3542; --accent: #e8935a;
  --reg: #ff8a80; --reg-bg: #4a1f1c;
  --e-library: #23395a; --e-version: #3a2f57; --e-ui_component: #1f4430; --e-domain_object: #1d4744;
  --e-perf: #5a3518; --e-action: #4d4320; --e-code: #33373d; --e-reference: #4a2b45; --e-person: #532828;
  color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #14181f; --surface: #1b2029; --fg: #e6e8ec; --muted: #9aa3b2; --line: #2e3542; --accent: #e8935a;
  --reg: #ff8a80; --reg-bg: #4a1f1c;
  --e-library: #23395a; --e-version: #3a2f57; --e-ui_component: #1f4430; --e-domain_object: #1d4744;
  --e-perf: #5a3518; --e-action: #4d4320; --e-code: #33373d; --e-reference: #4a2b45; --e-person: #532828;
  color-scheme: dark }
body { background: var(--bg); color: var(--fg); font-family: var(--sans); font-size: 15px; line-height: 1.5; }
.wrap { max-width: 1100px; margin: 0 auto; padding-inline: 16px; padding-block: 24px 64px; display: flex; flex-direction: column; gap: 20px; }
h1 { font-size: 26px; font-weight: 600; margin: 0; text-wrap: balance; }
.lead { color: var(--muted); max-width: 70ch; margin: 0; }
.stats { display: flex; flex-wrap: wrap; gap: 24px; font-variant-numeric: tabular-nums; }
.stats b { font-size: 22px; display: block; }
.stats span { color: var(--muted); font-size: 13px; }
.toolbar { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 2; background: var(--bg); padding-block: 10px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
.legend, .nav { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; cursor: pointer; }
.chip input { accent-color: var(--accent); }
.chip .n { color: var(--muted); font-variant-numeric: tabular-nums; }
.nav a { font-family: var(--mono); font-size: 12px; color: var(--muted); text-decoration: none; padding: 2px 6px; border: 1px solid var(--line); border-radius: 4px; }
.nav a.reg { color: var(--reg); border-color: var(--reg); }
.nav a:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.doc { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; scroll-margin-top: 120px; }
.doc-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.doc-head h2 { font-family: var(--mono); font-size: 16px; margin: 0; }
.repo { font-weight: 500; }
.meta { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.doc-head a { margin-left: auto; color: var(--accent); font-size: 13px; }
.pill { font-size: 12px; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--line); color: var(--muted); }
.pill-reg { color: var(--reg); background: var(--reg-bg); border-color: transparent; }
.sec { display: grid; grid-template-columns: 150px minmax(0, 1fr); border-top: 1px solid var(--line); }
.sec:first-of-type { border-top: none; }
.sec-label { font-size: 12px; color: var(--muted); padding: 8px 12px; border-right: 1px solid var(--line); letter-spacing: 0.02em; }
.s-template, .s-bot_boilerplate, .s-ai_note, .s-squash_log { color: var(--accent); }
.sec-text { margin: 0; padding: 8px 12px; font-family: var(--mono); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
mark.e { color: inherit; border-radius: 3px; padding: 0 2px; }
.e-library { background: var(--e-library); } .e-version { background: var(--e-version); }
.e-ui_component { background: var(--e-ui_component); } .e-domain_object { background: var(--e-domain_object); }
.e-perf { background: var(--e-perf); font-weight: 500; } .e-action { background: var(--e-action); }
.e-code { background: var(--e-code); } .e-reference { background: var(--e-reference); } .e-person { background: var(--e-person); }
body.off-library mark.e-library, body.off-version mark.e-version, body.off-ui_component mark.e-ui_component,
body.off-domain_object mark.e-domain_object, body.off-perf mark.e-perf, body.off-action mark.e-action,
body.off-code mark.e-code, body.off-reference mark.e-reference, body.off-person mark.e-person { background: none; font-weight: inherit; }
.legend mark.e { background-clip: padding-box; }
@media (max-width: 640px) { .sec { grid-template-columns: 1fr; } .sec-label { border-right: none; padding-bottom: 0; } .doc-head a { margin-left: 0; } }
</style>
<div class="wrap">
  <h1>Разметка описаний коммитов</h1>
  <p class="lead">Описания изменений (сообщения коммитов и pull request'ов) для пар «база → коммит» из набора данных Core Web Vitals.
  Слева — тип раздела (уровень 2), в тексте — именованные сущности; подсказка при наведении — подтип, «вручную» — правка аннотатора,
  ✎ у раздела — тип исправлен вручную. Красным отмечены пары, где замеры нашли регрессию.</p>
  <div class="stats"><div><b>{{N_DOCS}}</b><span>документов</span></div><div><b>{{N_TOK}}</b><span>токенов</span></div>
  <div><b>{{N_SEC}}</b><span>разделов</span></div><div><b>{{N_ENT}}</b><span>сущностей</span></div></div>
  <div class="toolbar"><div class="legend">{{LEGEND}}</div><nav class="nav">{{NAV}}</nav></div>
  {{CARDS}}
</div>
<script>
document.querySelectorAll('.legend input').forEach(function (box) {
  box.addEventListener('change', function () { document.body.classList.toggle('off-' + box.dataset.type, !box.checked); });
});
</script>
"""


# ─── шаг 5.2: автоматическое связывание сущностей (DBpedia Spotlight) ─────────

def run_spotlight() -> None:
    """Отправляет заголовки и описания корпуса в публичный DBpedia Spotlight и сравнивает найденное с
    размеченными вручную библиотеками. Ответы кешируются в spotlight.json."""
    import urllib.parse
    import urllib.request
    cache_path = OUT / "spotlight.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    ents, _, _ = load_spans()
    for d in load_docs():
        if d["id"] in cache:
            continue
        data = urllib.parse.urlencode({"text": d["text"][:3000], "confidence": 0.5}).encode()
        req = urllib.request.Request("https://api.dbpedia-spotlight.org/en/annotate", data=data,
                                     headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                res = json.loads(r.read().decode("utf-8"))
            cache[d["id"]] = [{"surface": x["@surfaceForm"], "uri": x["@URI"], "offset": int(x["@offset"]),
                               "types": x.get("@types", "")} for x in res.get("Resources", [])]
        except Exception as e:  # noqa: BLE001
            print(f"  {d['id']}: Spotlight недоступен ({e})")
            continue
    cache_path.write_text(json.dumps(cache, indent=1, ensure_ascii=False), encoding="utf-8")
    if not cache:
        print("DBpedia Spotlight недоступен (api.dbpedia-spotlight.org не отвечает) — связывание через Wikidata")
        return run_wikidata(ents)
    ours = {(i, e["text"].lower()) for i, es in ents.items() for e in es if e["type"] == "LIBRARY"}
    found = {(i, x["surface"].lower()) for i, xs in cache.items() for x in xs}
    hit = ours & found
    print(f"Spotlight: {sum(len(v) for v in cache.values())} ссылок на DBpedia в {len(cache)} документах")
    print(f"  наших LIBRARY: {len(ours)}, из них Spotlight нашёл {len(hit)} ({len(hit) / max(len(ours), 1):.0%})")
    print("  примеры ссылок:", ", ".join(sorted({f"{x['surface']}→{x['uri'].rsplit('/', 1)[-1]}" for xs in cache.values() for x in xs})[:25]))


SOFTWARE_RE = re.compile(r"software|librar|framework|javascript|typescript|package manager|bundler|build tool|"
                         r"runtime|linter|testing|test runner|css|web|front-end|frontend|programming|open-source|editor", re.I)


def run_wikidata(ents: dict) -> None:
    """Связывание сущностей LIBRARY с Wikidata: поиск по имени, из первых 7 кандидатов берётся первый,
    чьё описание указывает на программное обеспечение. Результат проверяется вручную (поле manual_ok)."""
    import time
    import urllib.error
    import urllib.parse
    import urllib.request
    names = sorted({e["text"].strip("`").lower() for es in ents.values() for e in es if e["type"] == "LIBRARY"})
    out_path = OUT / "wikidata-links.json"
    prev = {x["name"]: x for x in json.loads(out_path.read_text(encoding="utf-8"))} if out_path.exists() else {}
    links = []
    for name in names:
        if name in prev:
            links.append(prev[name])
            continue
        q = urllib.parse.urlencode({"action": "wbsearchentities", "search": name.lstrip("@").split("/")[-1],
                                    "language": "en", "format": "json", "limit": 7})
        req = urllib.request.Request(f"https://www.wikidata.org/w/api.php?{q}",
                                     headers={"User-Agent": "diplom-annotation/1.0 (student research)"})
        cands = None
        for attempt in range(5):  # Wikidata ограничивает частоту запросов (429) — ждём и повторяем
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    cands = json.loads(r.read().decode("utf-8")).get("search", [])
                break
            except urllib.error.HTTPError as e:
                if e.code != 429:
                    raise
                time.sleep(10 * (attempt + 1))
        if cands is None:
            print(f"  {name}: Wikidata не ответила — пропуск")
            continue
        best = next((c for c in cands if SOFTWARE_RE.search(c.get("description", ""))), None)
        links.append({"name": name, "qid": best["id"] if best else None, "label": best.get("label") if best else None,
                      "description": best.get("description") if best else None,
                      "first_candidate": (cands[0].get("label"), cands[0].get("description")) if cands else None,
                      "manual_ok": None})
        out_path.write_text(json.dumps(links, indent=1, ensure_ascii=False), encoding="utf-8")
        time.sleep(2)
    out_path.write_text(json.dumps(links, indent=1, ensure_ascii=False), encoding="utf-8")
    linked = [x for x in links if x["qid"]]
    print(f"Wikidata: {len(names)} уникальных библиотек, связано {len(linked)}")
    for x in links:
        print(f"  {x['name']:<32} → {x['qid'] or '—':<10} {x['label'] or ''} — {(x['description'] or '')[:60]}"
              f"   [первый кандидат: {(x['first_candidate'] or ('', ''))[0]}]")


# ─── шаг 6: анализ разметки ───────────────────────────────────────────────────

AUTHORED = {"TITLE", "DESCRIPTION", "MOTIVATION", "CHANGE_LIST", "TESTING", "REFERENCE"}


def run_analyze() -> None:
    from scipy.stats import fisher_exact
    docs = {d["id"]: d for d in load_docs()}
    ents, secs, toks = load_spans()
    key = pd.read_csv(KEY).set_index("id")
    b1 = pd.read_csv(ROOT / "annotations" / "text-diff" / "pilot-phase1.B-claude.csv").set_index("id")
    report: dict = {}

    # уровень 3: части речи; первое слово заголовка
    pos = Counter(t["pos"] for ts in toks.values() for t in ts)
    report["pos"] = dict(pos.most_common())
    titles = [s for ss in secs.values() for s in ss if s["label"] == "TITLE"]
    starts_action = sum(any(e["type"] == "ACTION" and abs(e["start"] - s["start"]) <= 20 and e["start"] >= s["start"]
                            for e in ents[s["doc"]]) for s in titles)
    report["titles"] = {"n": len(titles), "start_with_action": starts_action}

    # уровни 2 ↔ сущности: в каких разделах какие сущности
    cross = defaultdict(Counter)
    for i, es in ents.items():
        for e in es:
            sec = next((s["label"] for s in secs[i] if s["start"] <= e["start"] < s["end"]), "—")
            cross[sec][e["type"]] += 1
    report["section_x_entity"] = {s: dict(c) for s, c in cross.items()}

    # доля авторского текста против шаблонов, ботов, журналов
    authored, total = Counter(), Counter()
    for i, ss in secs.items():
        for s in ss:
            n = s["end"] - s["start"]
            total[i] += n
            if s["label"] in AUTHORED:
                authored[i] += n
    report["authored_share"] = {i: round(authored[i] / total[i], 3) for i in docs}

    # связь с другими модальностями: измеренная регрессия (замеры) и оценка аннотатора B (diff)
    rows = []
    for i, d in docs.items():
        types = Counter(e["type"] for e in ents[i])
        subs = Counter(e["label"] for e in ents[i])
        labels = Counter(s["label"] for s in secs[i])
        rows.append({
            "id": i, "regression": key.loc[i, "label"] == "regression",
            "dep_update": bool(subs["UPDATE"] and (types["LIBRARY"] or types["VERSION"])),
            "bot": bool(labels["BOT_BOILERPLATE"] or labels["RELEASE_NOTES"]),
            "perf_mention": bool(types["PERF"]), "template": bool(labels["TEMPLATE"]), "ai_note": bool(labels["AI_NOTE"]),
            "squash": bool(labels["SQUASH_LOG"]), "authored_share": authored[i] / total[i],
            "libraries": types["LIBRARY"], "b_expect": b1.loc[i, "expect_regression"],
        })
    df = pd.DataFrame(rows)
    report["by_doc"] = df.to_dict("records")
    print(f"Корпус: {len(docs)} документов, {sum(len(t) for t in toks.values())} токенов; "
          f"регрессий {int(df.regression.sum())}, без регрессии {int((~df.regression).sum())}")
    print(f"Части речи: {dict(pos.most_common(6))}")
    print(f"Заголовки: {starts_action} из {len(titles)} начинаются с действия (повелительное наклонение коммитов)")
    print("Разделы × сущности (где живут сущности):")
    for sec, c in sorted(cross.items(), key=lambda kv: -sum(kv[1].values()))[:8]:
        print(f"  {sec:<16} " + ", ".join(f"{t} {n}" for t, n in c.most_common(4)))
    print(f"Доля авторского текста: медиана {df.authored_share.median():.0%}; "
          f"в документах с шаблоном PR — {df[df.template].authored_share.median():.0%}, с ботом — {df[df.bot].authored_share.median():.0%}")
    print("Признак текста → доля регрессий (точный тест Фишера):")
    report["vs_regression"] = {}
    for feat in ("dep_update", "bot", "perf_mention", "template", "ai_note", "squash"):
        t = pd.crosstab(df[feat], df.regression).reindex(index=[True, False], columns=[True, False], fill_value=0)
        p = fisher_exact(t.values)[1]
        yes, no = t.loc[True], t.loc[False]
        report["vs_regression"][feat] = {"with": [int(yes[True]), int(yes.sum())], "without": [int(no[True]), int(no.sum())], "p": p}
        print(f"  {feat:<13} есть: {yes[True]}/{yes.sum()} регрессий   нет: {no[True]}/{no.sum()}   p = {p:.2f}")
    agree = pd.crosstab(df.b_expect, df.regression)
    print("Оценка аннотатора B по diff (лаб. 2) против регрессии на этих документах:\n" + agree.to_string())
    out = OUT / "analysis.json"
    out.write_text(json.dumps(report, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"→ {out.relative_to(ROOT)}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "fetch":
        run_fetch()
    elif cmd == "annotate":
        run_annotate()
    elif cmd == "export":
        run_export()
    elif cmd == "spotlight":
        run_spotlight()
    elif cmd == "analyze":
        run_analyze()
    else:
        print(__doc__)
