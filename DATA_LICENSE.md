# Лицензия данных

Замеры (`data/measurements/`), разметка и признаки (`data/tables/`), образцы (`data/examples/`) и
результаты (`results/`) распространяются по лицензии
[Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/deed.ru):
их можно использовать и изменять при условии ссылки на источник.

При использовании ссылайтесь на репозиторий и на диссертацию: Кудрявцев А. Система прогнозирования
регрессий производительности фронтенд-коммитов по метрикам Core Web Vitals методами машинного обучения :
магистерская диссертация. – Йошкар-Ола : МарГУ, 2027.

## Исходный код исследованных проектов

`data/text/*.diffs.jsonl`, поле `mutation.snippet` в замерах мутантов и списки файлов содержат
фрагменты исходного кода и пути файлов исследованных проектов. Эти фрагменты остаются под
лицензиями своих проектов:

| Проект | Лицензия |
|---|---|
| [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) | MIT |
| [mermaid-js/mermaid-live-editor](https://github.com/mermaid-js/mermaid-live-editor) | MIT |
| [vuejs/docs](https://github.com/vuejs/docs) | CC BY 4.0 (кроме изображений) |
| [monkeytypegame/monkeytype](https://github.com/monkeytypegame/monkeytype) | GPL-3.0 |

Фрагменты включены только для исследования изменений кода (признаки, текстовые модели).
