"""Понятные названия признаков для объяснения оценки."""

from __future__ import annotations

K = {
    "k_nf": "файлов изменено",
    "k_la": "строк добавлено",
    "k_ld": "строк удалено",
    "k_nd": "каталогов затронуто",
    "k_ns": "подсистем затронуто",
    "k_entropy": "разброс изменений по файлам",
    "k_binary": "бинарных файлов",
    "k_commits": "коммитов в изменении",
    "k_exp": "опыт автора (коммитов в проекте)",
    "k_age_days": "давность изменения затронутых файлов, дней",
    "k_ndev": "разработчиков у затронутых файлов",
}
CAT = {
    "code": "кода", "style": "стилей", "html": "HTML", "image": "изображений", "font": "шрифтов", "test": "тестов",
    "doc": "документации", "config": "конфигураций", "json": "JSON", "pkg": "package.json", "lock": "lock-файлов",
    "other": "прочих",
}
DEP = {"rt": "зависимостей", "dev": "dev-зависимостей"}
DEP_KIND = {"added": "добавлено", "removed": "удалено", "major": "мажорных обновлений"}
PAT = {
    "import_static": "статических import", "import_dynamic": "динамических import()", "lazy": "ленивой загрузки (lazy)",
    "effect": "эффектов (useEffect и т. п.)", "memo": "мемоизации", "state": "состояния компонентов",
    "listener": "обработчиков событий", "timer": "таймеров", "raf": "requestAnimationFrame", "loop": "циклов",
    "array_iter": "проходов по массивам (map/filter/forEach)", "layout_read": "чтений геометрии (getBoundingClientRect…)",
    "dom_query": "поисков в DOM (querySelector…)", "dom_write": "записей в DOM", "canvas": "работы с canvas",
    "worker": "Web Worker", "async": "асинхронного кода", "json": "JSON.parse/stringify", "font": "подключений шрифтов",
    "image": "изображений", "img_dims": "размеров у изображений", "loading_hint": "подсказок загрузки (preload, loading)",
    "css_layout": "CSS-свойств раскладки", "css_anim": "CSS-анимаций", "css_selector_heavy": "тяжёлых CSS-селекторов",
}
MSG = {
    "msg_len": "длина сообщения коммита", "msg_bot": "коммит бота", "msg_revert": "откат (revert)",
    "msg_perf_word": "в сообщении упомянута производительность",
}


def label(name: str) -> str:
    if name in K:
        return K[name]
    if name in MSG:
        return MSG[name]
    parts = name.split("_")
    if parts[0] == "cat":
        if name == "cat_only_nonruntime":
            return "только файлы, не влияющие на работу приложения"
        kind, unit = "_".join(parts[1:-1]), parts[-1]
        return f"{'файлов' if unit == 'files' else 'строк'} {CAT.get(kind, kind)}"
    if parts[0] == "dep" and len(parts) == 3:
        return f"{DEP.get(parts[1], parts[1])}: {DEP_KIND.get(parts[2], parts[2])}"
    if parts[0] == "pat":
        kind, side = "_".join(parts[1:-1]), parts[-1]
        return f"{PAT.get(kind, kind)}: {'добавлено' if side == 'add' else 'удалено'}"
    if name.startswith("msg_type_"):
        return f"тип коммита «{name.removeprefix('msg_type_')}»"
    return name
