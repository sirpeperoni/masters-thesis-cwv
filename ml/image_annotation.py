"""
Разметка изображений (лабораторная «Разметка изображений»): скриншоты первого экрана страниц версий из
пилотной выборки, разметка областей страницы в CVAT. Схема — docs/annotation-schema.md, раздел «Изображения».

    # 1. скриншоты и предразметка — стенд (после сбора, машина свободна):
    #    npm run trial -- --repo <проект> --pilot --shots      → annotations/images/raw/<проект>/<sha>.png + .json
    python ml/image_annotation.py prepare    # → annotations/images/cvat/: изображения, labels.json, предразметка XML
    # 2. CVAT: задача с labels.json, загрузка изображений, импорт предразметки, проверка и правка, экспорт
    #    «CVAT for images 1.1» → annotations/images/cvat-export/annotations.xml
    python ml/image_annotation.py analyze    # сравнение с предразметкой, классы LCP-элемента, связь с регрессией
"""

from __future__ import annotations

import json
import shutil
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "annotations" / "images"
KEY = ROOT / "annotations" / "text-diff" / "pilot-key.csv"

LABELS = {  # класс → цвет в CVAT и описание (одинаковые с bench/src/shots.ts)
    "main_content": ("#2f6e9e", "основное содержимое: текст руководства, слова теста, диаграмма"),
    "workarea": ("#3fa37a", "рабочая область приложения: холст, редактор кода"),
    "banner": ("#c8611d", "промо, баннер, объявление"),
    "modal": ("#8e44ad", "модальное окно, окно согласия на cookies"),
    "navigation": ("#7f8c8d", "шапка, логотип, меню, боковая панель, панель инструментов"),
    "footer": ("#b0a48a", "подвал, подсказки горячих клавиш"),
    "error_message": ("#b3261e", "сообщение об ошибке"),
}
ATTRIBUTES = [  # признаки рамки (шаг 2.2)
    ("is_lcp", "элемент, по которому браузер посчитал LCP"),
    ("shifts_layout", "область участвовала в сдвиге вёрстки (layout-shift)"),
    ("appears_late", "появляется после основного содержимого (определяет аннотатор)"),
]


def image_name(repo: str, sha: str) -> str:
    return f"{repo}__{sha[:12]}.png"


def run_prepare() -> None:
    out = IMG / "cvat"
    upload = out / "images"
    upload.mkdir(parents=True, exist_ok=True)
    labels = [{"name": n, "color": c, "type": "rectangle",
               "attributes": [{"name": a, "input_type": "checkbox", "mutable": False, "values": ["false"], "default_value": "false"}
                              for a, _ in ATTRIBUTES]} for n, (c, _) in LABELS.items()]
    (out / "labels.json").write_text(json.dumps(labels, indent=1, ensure_ascii=False), encoding="utf-8")

    root = ET.Element("annotations")
    ET.SubElement(root, "version").text = "1.1"
    index = []
    metas = sorted((IMG / "raw").glob("*/*.json"))
    for i, mpath in enumerate(metas):
        m = json.loads(mpath.read_text(encoding="utf-8"))
        name = image_name(m["repo"], m["sha"])
        shutil.copyfile(mpath.with_suffix(".png"), upload / name)
        img = ET.SubElement(root, "image", id=str(i), name=name, width=str(m["width"]), height=str(m["height"]))
        screen = m["width"] * m["height"]
        # область на весь экран, кроме рабочей — фоновый контейнер, а не объект (excalidraw: .welcome-screen-decor)
        m["boxes"] = [b for b in m["boxes"] if b["label"] == "workarea" or b["is_lcp"] or b["w"] * b["h"] < 0.6 * screen]
        for b in m["boxes"]:  # рамка на весь экран пересекается с любым сдвигом — признак ей ничего не говорит
            if b["w"] * b["h"] >= 0.6 * screen:
                b["shifts_layout"] = False
        for b in m["boxes"]:
            box = ET.SubElement(img, "box", label=b["label"], source="auto", occluded="0", z_order="1" if b["is_lcp"] else "0",
                                xtl=f"{b['x']:.1f}", ytl=f"{b['y']:.1f}", xbr=f"{b['x'] + b['w']:.1f}", ybr=f"{b['y'] + b['h']:.1f}")
            for a, _ in ATTRIBUTES:
                ET.SubElement(box, "attribute", name=a).text = "true" if b.get(a) else "false"
        index.append({"image": name, "repo": m["repo"], "sha": m["sha"], "boxes": len(m["boxes"]),
                      "lcp_text": (m["lcp"] or {}).get("text", ""), "layout_shifts": len(m["layoutShifts"])})
    ET.indent(root)
    ET.ElementTree(root).write(out / "preannotation.xml", encoding="utf-8", xml_declaration=True)
    pd.DataFrame(index).to_csv(out / "images.csv", index=False)
    # архивы для загрузки в CVAT: изображения одним файлом, предразметка — annotations.xml внутри zip
    import zipfile
    with zipfile.ZipFile(out / "images.zip", "w", zipfile.ZIP_STORED) as z:
        for p in sorted(upload.glob("*.png")):
            z.write(p, p.name)
    with zipfile.ZipFile(out / "preannotation.zip", "w", zipfile.ZIP_DEFLATED) as z:
        z.write(out / "preannotation.xml", "annotations.xml")
    print(f"→ {out.relative_to(ROOT)}: {len(metas)} изображений, {sum(x['boxes'] for x in index)} рамок предразметки")


def parse_cvat(path: Path) -> dict[str, list[dict]]:
    out = {}
    for img in ET.parse(path).getroot().iter("image"):
        out[img.get("name")] = [{
            "label": b.get("label"), "x": float(b.get("xtl")), "y": float(b.get("ytl")),
            "w": float(b.get("xbr")) - float(b.get("xtl")), "h": float(b.get("ybr")) - float(b.get("ytl")),
            "source": b.get("source"), **{a.get("name"): a.text == "true" for a in b.iter("attribute")}}
            for b in img.iter("box")]
    return out


def iou(a: dict, b: dict) -> float:
    ix = max(0.0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
    iy = max(0.0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
    inter = ix * iy
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union else 0.0


def run_analyze() -> None:
    pre = parse_cvat(IMG / "cvat" / "preannotation.xml")
    final_path = IMG / "cvat-export" / "annotations.xml"
    if not final_path.exists():
        raise SystemExit(f"нет {final_path.relative_to(ROOT)} — выгрузите разметку из CVAT («CVAT for images 1.1»)")
    final = parse_cvat(final_path)
    report: dict = {}
    # is_lcp — объективный признак (его даёт браузер). Если аннотатор удалил рамку LCP-элемента как дубликат
    # объемлющей области (промо-плашка mermaid) или заменил её, признак переносится на итоговую рамку,
    # которая сильнее всего накрывает LCP-элемент предразметки (доля площади LCP внутри рамки).
    restored = 0
    for name, boxes in pre.items():
        lcp = next((b for b in boxes if b.get("is_lcp")), None)
        fin = final.get(name, [])
        if not lcp or not fin or any(f.get("is_lcp") for f in fin):
            continue
        def cover(f: dict) -> float:
            ix = max(0.0, min(lcp["x"] + lcp["w"], f["x"] + f["w"]) - max(lcp["x"], f["x"]))
            iy = max(0.0, min(lcp["y"] + lcp["h"], f["y"] + f["h"]) - max(lcp["y"], f["y"]))
            return ix * iy / max(lcp["w"] * lcp["h"], 1) - 1e-9 * f["w"] * f["h"]  # при равном накрытии — меньшая рамка
        best = max(fin, key=cover)
        if cover(best) > 0.5:
            best["is_lcp"] = True
            restored += 1
    report["is_lcp_restored"] = restored
    print(f"is_lcp восстановлен по предразметке на {restored} изображениях")
    # 1) сколько предразметки пережило проверку: рамка «сохранена», если есть итоговая того же класса с IoU ≥ 0,7
    kept = moved = relabeled = deleted = 0
    for name, boxes in pre.items():
        fin = final.get(name, [])
        for b in boxes:
            best = max(fin, key=lambda f: iou(b, f), default=None)
            if best is None or iou(b, best) < 0.3:
                deleted += 1
            elif best["label"] != b["label"]:
                relabeled += 1
            elif iou(b, best) >= 0.7:
                kept += 1
            else:
                moved += 1
    added = sum(1 for boxes in final.values() for f in boxes if f.get("source") == "manual")
    total_pre = kept + moved + relabeled + deleted
    report["preannotation"] = {"total": total_pre, "kept": kept, "moved": moved, "relabeled": relabeled,
                               "deleted": deleted, "added_manually": added}
    print(f"Предразметка: {total_pre} рамок — сохранено {kept}, сдвинуто {moved}, класс изменён {relabeled}, "
          f"удалено {deleted}; добавлено вручную {added}")
    # 2) классы и LCP-элемент
    labels = Counter(f["label"] for boxes in final.values() for f in boxes)
    lcp = Counter(f["label"] for boxes in final.values() for f in boxes if f.get("is_lcp"))
    report["labels"], report["lcp_label"] = dict(labels), dict(lcp)
    n_lcp = sum(lcp.values())
    print("Рамки по классам:", dict(labels.most_common()))
    print(f"LCP-элемент по классам ({n_lcp} изображений):", dict(lcp.most_common()),
          f"— основное содержимое/рабочая область в {(lcp['main_content'] + lcp['workarea']) / max(n_lcp, 1):.0%}")
    # 3) связь с замерами: меняется ли класс LCP-элемента у пар с регрессией LCP
    key = pd.read_csv(KEY)
    rows = []
    for _, k in key[key.label == "regression"].iterrows():
        cls = lambda sha: next((f["label"] for f in final.get(image_name(k.repo, sha), []) if f.get("is_lcp")), None)
        before, after = cls(k.base_sha), cls(k.sha)
        if before or after:
            rows.append({"id": k.id, "repo": k.repo, "metrics": k.regressed_metrics, "lcp_before": before, "lcp_after": after,
                         "changed": before != after})
    report["regressions"] = rows
    lcp_reg = [r for r in rows if "lcp" in str(r["metrics"]).split(";")]
    print(f"Регрессии LCP: {len(lcp_reg)}; класс LCP-элемента сменился в {sum(r['changed'] for r in lcp_reg)}")
    for r in lcp_reg:
        print(f"  {r['id']} {r['repo']:<20} {r['lcp_before']} → {r['lcp_after']}")
    (IMG / "analysis.json").write_text(json.dumps(report, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"→ {(IMG / 'analysis.json').relative_to(ROOT)}")
    write_coco(final)


def write_coco(final: dict[str, list[dict]]) -> None:
    """Итоговая разметка в COCO JSON (стандартный формат датасета детекции); признаки — в поле attributes."""
    cats = {n: i + 1 for i, n in enumerate(LABELS)}
    index = pd.read_csv(IMG / "cvat" / "images.csv").set_index("image")
    images, anns = [], []
    for img_id, (name, boxes) in enumerate(sorted(final.items()), start=1):
        images.append({"id": img_id, "file_name": name, "width": 1350, "height": 940,
                       "repo": index.loc[name, "repo"], "sha": index.loc[name, "sha"]})
        for b in boxes:
            anns.append({"id": len(anns) + 1, "image_id": img_id, "category_id": cats[b["label"]],
                         "bbox": [round(b["x"], 1), round(b["y"], 1), round(b["w"], 1), round(b["h"], 1)],
                         "area": round(b["w"] * b["h"], 1), "iscrowd": 0,
                         "attributes": {a: bool(b.get(a)) for a, _ in ATTRIBUTES}})
    coco = {"info": {"description": "Скриншоты первого экрана версий фронтенд-приложений, области страницы и LCP-элемент"},
            "categories": [{"id": i, "name": n, "supercategory": "page_region"} for n, i in cats.items()],
            "images": images, "annotations": anns}
    out = IMG / "coco.json"
    out.write_text(json.dumps(coco, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {out.relative_to(ROOT)} ({len(images)} изображений, {len(anns)} рамок)")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    {"prepare": run_prepare, "analyze": run_analyze}.get(cmd, lambda: print(__doc__))()
