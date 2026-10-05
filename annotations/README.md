# Аннотации

Схема, требования и инструкция для аннотаторов — [docs/annotation-schema.md](../docs/annotation-schema.md).
Пересоздание автоматических слоёв: `python ml/annotation.py auto` и `python ml/annotation.py sample`.

| Папка | Модальность | Файлы | Слой |
|---|---|---|---|
| `measurements/` | замеры | `<проект>.runs.csv` — прогоны: значения метрик, статус `ok`/`outlier`/`error`, LCP-элемент | автоматический (уровень 3; уровни 1–2 — `data/tables/labels/`) |
| `text-diff/` | текст изменения кода | `pilot-phase1.template.csv` — лист слепой разметки 50 пар (уровень 1) | шаблон |
| | | `pilot-phase2.template.csv` — файлы-кандидаты в причину для 25 регрессий (уровень 2) | шаблон |
| | | `pilot-phase{1,2}.B-claude.csv` — разметка аннотатора B | ручной |
| | | `pilot-patterns.auto.jsonl` — строки с шаблонами кода (уровень 3) | автоматический |
| | | `pilot-key.csv` — измеренные метки пар; **не открывать до конца фазы 1** | ключ |
| `text-page/` | текст страницы | `lcp-elements.csv` — уникальные LCP-элементы, категория по правилам | автоматический |
| | | `lcp-elements.B-claude.csv` — проверенная категория | ручной |
| `text-desc/` | текст описания изменения (лаб. № 3) | `documents.jsonl` — тексты коммитов и PR; `spans.jsonl` — разделы и сущности; `tokens.tsv` — токены и части речи | авто + ручной |
| | | `webanno/<id>.tsv` — разметка для INCEpTION (WebAnno TSV 3.3); `visualization.html` — просмотр разметки | экспорт |
| | | `manual-fixes.json` — ручные правки; `wikidata-links.json` — связывание библиотек; `analysis.json` — анализ | ручной / анализ |
| `agreement.json` | — | согласованность аннотаторов (появится после разметки второго аннотатора) | — |
