"""Вывод оценки: текст для терминала, Markdown для комментария в pull request, JSON для других программ."""

from __future__ import annotations

import json

from .score import Result

ICON = {"high": "🔴", "elevated": "🟠", "low": "🟢"}
ADVICE = {
    "high": "измерить на стенде до слияния",
    "elevated": "измерить, если есть время на замеры",
    "low": "замеры можно пропустить",
}
NBSP = " "


def fmt_value(v: float) -> str:
    return f"{v:.0f}" if abs(v - round(v)) < 1e-9 else f"{v:.2f}".replace(".", ",")


def pct(v: float, digits: int = 0) -> str:
    """Доля по-русски: десятичная запятая, неразрывный пробел перед знаком процента."""
    return f"{v * 100:.{digits}f}".replace(".", ",") + NBSP + "%"


def short(ref: str) -> str:
    return ref[:8] if len(ref) == 40 and all(c in "0123456789abcdef" for c in ref) else ref


def text(r: Result) -> str:
    top = max(1, round(r.place * 100))
    lines = [
        f"Риск регрессии CWV: {r.level_name.upper()} — {ADVICE[r.level]}",
        f"  место среди {r.history} {'коммитов обучающих проектов' if r.scale == 'pooled' else 'последних коммитов проекта'}: риск выше, чем у {100 - top}{NBSP}% (верхние {top}{NBSP}%)",
        f"  среди коммитов этого уровня регрессий в проверке было {pct(r.expected_rate, 1)}",
        f"  изменение: {r.files} файлов, +{r.lines_added} / −{r.lines_deleted} строк ({short(r.merge_base)}..{short(r.head)})",
    ]
    if r.scale == "pooled":
        lines.append(f"  ⚠ в истории проекта меньше {30} коммитов — шкала по коммитам проектов, на которых обучена модель (менее точно)")
    if r.reasons and r.level != "low":  # при низком риске «необычные» признаки — не причины, а шум
        lines.append("  почему (необычно для проекта):")
        for x in r.reasons:
            lines.append(f"    • {x.label}: {fmt_value(x.value)} — больше, чем у {pct(x.percentile)} коммитов")
    m = r.model
    lines.append(f"  модель: {m['kind']}, обучена на {m['pairs']} изменениях ({m['regressions']} регрессий), {m['created']}")
    return "\n".join(lines)


def markdown(r: Result) -> str:
    top = max(1, round(r.place * 100))
    out = [
        "<!-- cwv-risk -->",  # метка: GitHub Action находит и обновляет свой комментарий
        f"### {ICON[r.level]} Риск регрессии Core Web Vitals: **{r.level_name}**",
        "",
        f"**Рекомендация:** {ADVICE[r.level]}.",
        "",
        "| | |",
        "|---|---|",
        f"| Место среди {r.history} последних коммитов | верхние **{top}{NBSP}%** |",
        f"| Доля регрессий на этом уровне (проверка на 11 проектах) | {pct(r.expected_rate, 1)} |",
        f"| Изменение | {r.files} файлов, +{r.lines_added} / −{r.lines_deleted} строк |",
    ]
    if r.scale == "pooled":
        out += ["", "> ⚠ В истории проекта меньше 30 коммитов — изменение сравнивается с коммитами проектов, на которых "
                "обучена модель (менее точно)."]
    if r.reasons and r.level != "low":
        out += ["", "**Почему** — признаки, необычные для этого проекта:", ""]
        out += [f"- {x.label}: {fmt_value(x.value)} — больше, чем у {pct(x.percentile)} коммитов" for x in r.reasons]
    m = r.model
    out += ["", f"<sub>cwv-risk · модель {m['kind']} · обучена на {m['pairs']} изменениях ({m['regressions']} регрессий) · "
            "прогноз по изменению кода, без сборки и замеров</sub>"]
    return "\n".join(out)


def as_json(r: Result) -> str:
    return json.dumps(r.to_dict(), ensure_ascii=False, indent=2)
