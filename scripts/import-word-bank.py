"""Convert the supplied word workbook to static JSON without changing the XLSX."""

import argparse
import hashlib
import json
import posixpath
import re
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "source" / "四游戏词库_精简版.xlsx"
GUIDE_SOURCE = ROOT / "data" / "source" / "guide-words.json"
GAME_SOURCES = ROOT / "data" / "source" / "word-game-sources.json"
DESTINATION = ROOT / "dist" / "data"
NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
RELATIONSHIP_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
GROUPS = (("required", "必答词"), ("extra", "额外词"))
GROUP_LABELS = {"required": "普通词库", "extra": "仅额外词库"}
FIELDS = (
    ("word", "单词"),
    ("scope", "范围库"),
    ("phonetic", "音标"),
    ("emotion", "情绪类型"),
    ("abbreviation", "是否缩写"),
    ("rarityLevel", "生僻档位"),
    ("definitionEn", "英文注释"),
    ("definitionZh", "中文注释"),
)


def text_value(node):
    if node is None:
        return ""
    # Read text and rich-text runs, excluding optional phonetic annotations.
    value = (node.findtext("s:t", default="", namespaces=NS)
             + "".join(run.findtext("s:t", default="", namespaces=NS)
                       for run in node.findall("s:r", NS)))
    return re.sub(r"_x([0-9A-Fa-f]{4})_", lambda match: chr(int(match[1], 16)), value)


def cell_value(cell, shared_strings):
    if cell.find("s:f", NS) is not None:
        raise ValueError(f"单元格 {cell.get('r')} 包含公式，请先在词库中转为确定的值。")
    kind = cell.get("t", "n")
    if kind == "inlineStr":
        return text_value(cell.find("s:is", NS))
    value = cell.findtext("s:v", namespaces=NS)
    if value is None:
        return None
    if kind == "s":
        return shared_strings[int(value)]
    if kind == "b":
        return value == "1"
    if kind == "e":
        raise ValueError(f"单元格 {cell.get('r')} 包含 Excel 错误：{value}")
    if kind == "n":
        number = float(value)
        return int(number) if number.is_integer() else number
    return value


def read_records(archive, sheet_path, shared_strings, group):
    sheet = ET.fromstring(archive.read(sheet_path))
    records = []
    header_found = False
    for row in sheet.findall("s:sheetData/s:row", NS):
        row_number = int(row.attrib["r"])
        cells = {re.sub(r"\d", "", cell.attrib["r"]): cell_value(cell, shared_strings)
                 for cell in row.findall("s:c", NS)}
        if not any(value is not None and value != "" for value in cells.values()):
            continue
        if any(key not in set("ABCDEFGH") and value is not None for key, value in cells.items()):
            raise ValueError(f"{group} 第 {row_number} 行有未识别的额外字段。")
        values = [cells.get(column) for column in "ABCDEFGH"]
        if not header_found:
            if values != [label for _, label in FIELDS]:
                raise ValueError(f"{group} 的表头与预期字段不一致：{values}")
            header_found = True
            continue
        if not isinstance(values[0], str) or not values[0].strip():
            raise ValueError(f"{group} 第 {row_number} 行缺少有效单词。")
        record = {"id": f"{group}:{row_number}", "sourceRow": row_number}
        record.update((key, value) for (key, _), value in zip(FIELDS, values))
        records.append(record)
    if not header_found:
        raise ValueError(f"{group} 缺少表头。")
    return records


def write_atomic(path, content):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temporary.write(content)
        temp_path = Path(temporary.name)
    try:
        temp_path.chmod(0o644)
        temp_path.replace(path)
    finally:
        temp_path.unlink(missing_ok=True)


def game_sources(catalog_path):
    if catalog_path is None:
        return GAME_SOURCES.read_bytes()
    raw = Path(catalog_path).read_bytes()
    catalog = json.loads(raw)
    games = [{key: game[key] for key in ("id", "name", "color")} for game in catalog["games"]]
    entries = {}
    for index, game in enumerate(catalog["games"]):
        for word in game["words"]["all"]:
            entries[word] = entries.get(word, 0) | (1 << index)
    zen = next(game for game in catalog["games"] if game["id"] == "06_Zen_Word")
    payload = {
        "schemaVersion": 1,
        "source": {"project": "字页关卡台", "file": "data/game_vocab/catalog.json",
                   "sha256": hashlib.sha256(raw).hexdigest(), "datasetHash": catalog["datasetHash"],
                   "sourceDate": catalog["sourceDate"]},
        "games": games,
        "zenTwoLetterWords": sorted(word for word in zen["words"]["all"] if re.fullmatch(r"[A-Z]{2}", word)),
        "entries": dict(sorted(entries.items())),
    }
    return (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-catalog", help="从参考项目的 data/game_vocab/catalog.json 更新来源游戏快照")
    args = parser.parse_args()
    source_bytes = SOURCE.read_bytes()
    guide_bytes = GUIDE_SOURCE.read_bytes()
    game_source_bytes = game_sources(args.game_catalog)
    game_source_data = json.loads(game_source_bytes)
    guide_records = json.loads(guide_bytes)
    if not isinstance(guide_records, list):
        raise ValueError("2词库需为列表。")
    guide_words = set()
    for record in guide_records:
        word = record.get("word") if isinstance(record, dict) else None
        if (not isinstance(word, str) or not re.fullmatch(r"[A-Z]{2}", word)
                or word in guide_words or record.get("id") != f"guide:{word.lower()}"
                or any(key not in record for key, _ in FIELDS)
                or type(record.get("scope")) is not int or record["scope"] != 0
                or type(record.get("emotion")) is not int or record["emotion"] not in (-2, -1, 0, 1, 2)
                or type(record.get("abbreviation")) is not int or record["abbreviation"] not in (0, 1)
                or type(record.get("rarityLevel")) is not int or record["rarityLevel"] not in (1, 2, 3, 4, 5)
                or any(not isinstance(record.get(key), str) or not record[key].strip()
                       for key in ("phonetic", "definitionEn", "definitionZh"))):
            raise ValueError("2词库含重复单词、缺失参数或无效记录。")
        guide_words.add(word)
    missing = set(game_source_data["zenTwoLetterWords"]) - guide_words
    if missing:
        raise ValueError(f"请先补齐 Zen 两字母词的参数：{', '.join(sorted(missing))}")
    manifest = {
        "schemaVersion": 1,
        "source": {
            "fileName": SOURCE.name,
            "sha256": hashlib.sha256(source_bytes).hexdigest(),
        },
        "fields": [{"key": key, "label": label} for key, label in FIELDS],
        "groups": [],
        "totalCount": 0,
    }
    outputs = {}
    with ZipFile(SOURCE) as archive:
        shared_strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared_strings = [text_value(item) for item in
                              ET.fromstring(archive.read("xl/sharedStrings.xml"))]
        relationships = {item.attrib["Id"]: item for item in
                         ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))}
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        sheets = {sheet.attrib["name"]: sheet for sheet in workbook.find("s:sheets", NS)}
        if set(sheets) != {label for _, label in GROUPS}:
            raise ValueError(f"工作表与预期不一致：{list(sheets)}")

        for key, label in GROUPS:
            relationship = relationships[sheets[label].attrib[RELATIONSHIP_ID]]
            if relationship.get("TargetMode") == "External":
                raise ValueError("词库工作表必须保存在当前文件中。")
            target = relationship.attrib["Target"]
            sheet_path = (target.lstrip("/") if target.startswith("/")
                          else posixpath.normpath(posixpath.join("xl", target)))
            records = read_records(archive, sheet_path, shared_strings, key)
            if guide_words.intersection(record["word"].strip().upper() for record in records):
                raise ValueError("2词库与原词库重复，请先确认词库分类。")
            # Preserve order, duplicates, original text, numbers, zeros and blanks.
            payload = ("[\n" + ",\n".join(json.dumps(record, ensure_ascii=False, allow_nan=False,
                         separators=(",", ":")) for record in records) + "\n]\n").encode("utf-8")
            filename = f"{key}-words.json"
            outputs[filename] = payload
            manifest["groups"].append({
                "key": key,
                "label": GROUP_LABELS[key],
                "count": len(records),
                "file": filename,
                "sha256": hashlib.sha256(payload).hexdigest(),
            })
            manifest["totalCount"] += len(records)

    guide_payload = ("[\n" + ",\n".join(json.dumps(record, ensure_ascii=False, allow_nan=False,
                     separators=(",", ":")) for record in guide_records) + "\n]\n").encode("utf-8")
    outputs["guide-words.json"] = guide_payload
    manifest["groups"].append({
        "key": "guide", "label": "2词库", "count": len(guide_records), "file": "guide-words.json",
        "sha256": hashlib.sha256(guide_payload).hexdigest(),
    })
    manifest["totalCount"] += len(guide_records)
    manifest["supplements"] = [{
        "fileName": GUIDE_SOURCE.name, "sha256": hashlib.sha256(guide_bytes).hexdigest(),
        "group": "guide", "count": len(guide_records),
    }]
    outputs["word-game-sources.json"] = game_source_bytes
    manifest["gameSources"] = {
        "file": "word-game-sources.json", "sha256": hashlib.sha256(game_source_bytes).hexdigest(),
        "gameCount": len(game_source_data["games"]), "wordCount": len(game_source_data["entries"]),
        "source": game_source_data["source"],
    }
    outputs["word-bank.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    DESTINATION.mkdir(parents=True, exist_ok=True)
    for filename, content in outputs.items():
        write_atomic(DESTINATION / filename, content)
    if args.game_catalog:
        write_atomic(GAME_SOURCES, game_source_bytes)
    for group in manifest["groups"]:
        print(f"{group['label']}：{group['count']:,} 条")
    print(f"共 {manifest['totalCount']:,} 条，已导入 {DESTINATION}")


if __name__ == "__main__":
    main()
