"""Мост к коду экспериментов (ml/): признаки изменения и перевод признаков в перцентили — тот же код, что
использовался при обучении и проверке модели, чтобы прогноз системы совпадал с проверенным в работе."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # корень проекта диссертации
if str(ROOT / "ml") not in sys.path:
    sys.path.insert(0, str(ROOT / "ml"))

from features import extract  # noqa: E402,F401
