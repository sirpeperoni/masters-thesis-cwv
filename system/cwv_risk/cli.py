"""Консольная утилита cwv-risk.

    cwv-risk train                                   # обучить модель (на данных диссертации) → system/models/
    cwv-risk score --repo . --base main --head HEAD  # оценить изменение (коммит или ветку PR)
    cwv-risk score --base origin/main --head HEAD --format markdown > comment.md
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

import typer

from . import model, report
from .score import assess

app = typer.Typer(add_completion=False, help="Оценка риска регрессии Core Web Vitals по изменению фронтенд-кода.")


@app.command()
def train(out: Path = typer.Option(model.DEFAULT, help="куда сохранить модель")):
    """Обучить модель на размеченных проектах диссертации (нужны data/<repo>.features.csv)."""
    art = model.train(out)
    typer.echo(f"модель → {out}: {art['pairs']} изменений, {art['regressions']} регрессий, {len(art['features'])} признаков")


@app.command()
def score(
    repo: Path = typer.Option(Path("."), help="путь к git-репозиторию проекта"),
    base: str = typer.Option("origin/main", help="ветка или коммит, с которым сравнивать (основная ветка)"),
    head: str = typer.Option("HEAD", help="оцениваемый коммит или ветка pull request"),
    history: int = typer.Option(300, help="сколько последних коммитов основной ветки брать за шкалу"),
    path: Optional[list[str]] = typer.Option(None, help="учитывать только эти пути истории (фронтенд), можно несколько"),
    fmt: str = typer.Option("text", "--format", help="text | markdown | json"),
    reasons: int = typer.Option(5, help="сколько причин показать"),
    model_path: Path = typer.Option(model.DEFAULT, "--model", help="файл модели"),
    fail_on: Optional[str] = typer.Option(None, help="завершиться с кодом 1 при уровне: high | elevated"),
):
    """Оценить риск регрессии изменения base..head."""
    r = assess(repo.resolve(), base, head, history, path, model_path, reasons, quiet=fmt != "text")
    out = {"text": report.text, "markdown": report.markdown, "json": report.as_json}[fmt](r)
    sys.stdout.reconfigure(encoding="utf-8")
    typer.echo(out)
    order = ["low", "elevated", "high"]
    if fail_on and order.index(r.level) >= order.index(fail_on):
        raise typer.Exit(1)


@app.command()
def queue(
    github: str = typer.Option(..., help="репозиторий GitHub с pull request'ами: владелец/имя"),
    bench: str = typer.Option(..., help="конфигурация стенда bench/repos/<имя>.ts"),
    once: bool = typer.Option(False, help="обработать очередь один раз и выйти"),
    interval: int = typer.Option(600, help="пауза между опросами GitHub, секунд"),
):
    """Очередь замеров: PR с меткой «cwv-risk: measure» → стенд → результат в комментарий и метки."""
    from .queue import loop

    sys.stdout.reconfigure(encoding="utf-8")
    loop(github, bench, once, interval)


web = typer.Typer(help="Веб-панель: импорт данных, сервер, статическая копия.")
app.add_typer(web, name="web")


@web.command("ingest")
def web_ingest(no_assess: bool = typer.Option(False, help="не оценивать PR по истории (быстрее)")):
    """Собрать базу панели из данных диссертации и замеров очереди → system/cwv-risk.db."""
    from .web import db

    typer.echo(db.ingest(assess_prs=not no_assess))


@web.command("serve")
def web_serve(port: int = typer.Option(8000), host: str = typer.Option("127.0.0.1")):
    """Запустить панель: http://127.0.0.1:8000 (API — /api/docs)."""
    import uvicorn

    from .web.api import app as api_app

    uvicorn.run(api_app, host=host, port=port)


@web.command("export")
def web_export(out: Path = typer.Option(Path("web/static"), help="папка статической копии")):
    """Статическая копия панели (для GitHub Pages и защиты): фронтенд + JSON, без действий."""
    from .web.api import export

    typer.echo(export(out.resolve()))


def main() -> None:
    app()


if __name__ == "__main__":
    main()
