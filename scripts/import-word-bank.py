"""Convert the supplied word workbook to static JSON without changing the XLSX."""

import argparse
import gzip
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
EXCLUDED_SOURCE = ROOT / "data" / "source" / "excluded-words.json"
LEVEL_SOURCE_DIR = ROOT / "data" / "source" / "word-level-sources"
SOURCE_ROLES = ("target", "extra", "onlyExtra", "bonus")
DETAIL_GAMES = ("06_Zen_Word", "07_Word_Tiles")
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
    path.parent.mkdir(parents=True, exist_ok=True)
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
        index_bytes = GAME_SOURCES.read_bytes()
        index = json.loads(index_bytes)
        files = {}
        for item in index.get("provenance", {}).get("files", {}).values():
            payload = (LEVEL_SOURCE_DIR / item["file"]).read_bytes()
            if hashlib.sha256(payload).hexdigest() != item["sha256"]:
                raise ValueError(f"来源关卡文件校验失败：{item['file']}")
            files[item["file"]] = payload
        return index_bytes, files
    raw = Path(catalog_path).read_bytes()
    catalog = json.loads(raw)
    games = [{key: game[key] for key in ("id", "name", "color")} for game in catalog["games"]]
    entries = {}
    for index, game in enumerate(catalog["games"]):
        for word in game["words"]["all"]:
            entries[word] = entries.get(word, 0) | (1 << index)
    zen = next(game for game in catalog["games"] if game["id"] == "06_Zen_Word")
    shards = {}
    source_files = []
    for game_index, game in enumerate(catalog["games"]):
        if game["id"] not in DETAIL_GAMES:
            continue
        source_path = Path(catalog_path).parent / Path(game["provenance"]).name
        source_bytes = source_path.read_bytes()
        detail = json.loads(gzip.decompress(source_bytes))
        if detail["id"] != game["id"] or [item["id"] for item in detail["configs"]] != [item["id"] for item in game["configs"]]:
            raise ValueError(f"来源关卡与游戏目录不一致：{game['name']}")
        source_files.append({"file": source_path.name, "sha256": hashlib.sha256(source_bytes).hexdigest()})
        games[game_index]["configs"] = []
        for config_index, config in enumerate(detail["configs"]):
            games[game_index]["configs"].append({key: config[key] for key in ("id", "label", "levelKind", "sourceAliases") if key in config})
            word_refs = {}
            for role_index, role in enumerate(SOURCE_ROLES):
                if len(config["words"][role]) != len(config["wordLevels"][role]):
                    raise ValueError("来源单词和关卡索引数量不一致。")
                for word, refs in zip(config["words"][role], config["wordLevels"][role]):
                    locations = word_refs.setdefault(word, {})
                    for ref in refs:
                        if type(ref) is not int or not 0 <= ref < len(config["levelCatalog"]):
                            raise ValueError("来源关卡索引无效。")
                        locations[ref] = locations.get(ref, 0) | (1 << role_index)
            for word, refs in word_refs.items():
                letter = word[0].lower() if re.match(r"^[A-Z]", word) else "other"
                locations = []
                for ref, role_mask in sorted(refs.items()):
                    number, source_id, *rest = config["levelCatalog"][ref]
                    locations.append([number, source_id, role_mask, *rest])
                shards.setdefault(letter, {}).setdefault(word, []).append([game_index, config_index, locations])
    files, file_index = {}, {}
    for letter, words in sorted(shards.items()):
        shard = {"schemaVersion": 1, "datasetHash": catalog["datasetHash"], "entries": dict(sorted(words.items()))}
        compressed = gzip.compress(json.dumps(shard, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), mtime=0)
        filename = f"{letter}.json.gz"
        files[filename] = compressed
        file_index[letter] = {"file": filename, "sha256": hashlib.sha256(compressed).hexdigest(), "wordCount": len(words)}
    for word, mask in entries.items():
        letter = word[0].lower() if re.match(r"^[A-Z]", word) else "other"
        actual = 0
        for game_index, _, _ in shards.get(letter, {}).get(word, []):
            actual |= 1 << game_index
        detail_mask = sum(1 << index for index, game in enumerate(games) if game["id"] in DETAIL_GAMES)
        if actual != mask & detail_mask:
            raise ValueError(f"单词来源游戏与关卡明细不一致：{word}")
    payload = {
        "schemaVersion": 1,
        "source": {"project": "字页关卡台", "file": "data/game_vocab/catalog.json",
                   "sha256": hashlib.sha256(raw).hexdigest(), "datasetHash": catalog["datasetHash"],
                   "sourceDate": catalog["sourceDate"]},
        "games": games,
        "zenTwoLetterWords": sorted(word for word in zen["words"]["all"] if re.fullmatch(r"[A-Z]{2}", word)),
        "entries": dict(sorted(entries.items())),
        "provenance": {"directory": "word-level-sources", "gameIds": DETAIL_GAMES, "roles": SOURCE_ROLES, "files": file_index, "sources": source_files},
    }
    return (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"), files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game-catalog", help="从参考项目的 data/game_vocab/catalog.json 更新来源游戏快照")
    args = parser.parse_args()
    source_bytes = SOURCE.read_bytes()
    excluded_bytes = EXCLUDED_SOURCE.read_bytes()
    excluded_data = json.loads(excluded_bytes)
    excluded_list = excluded_data.get("words")
    if (not isinstance(excluded_list, list)
            or any(not isinstance(word, str) or not re.fullmatch(r"[A-Z]+", word)
                   for word in excluded_list)
            or len(set(excluded_list)) != len(excluded_list)):
        raise ValueError("删除词列表需包含不重复的大写单词。")
    excluded_words = set(excluded_list)
    guide_bytes = GUIDE_SOURCE.read_bytes()
    game_source_bytes, provenance_files = game_sources(args.game_catalog)
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
        "exclusions": {
            "fileName": EXCLUDED_SOURCE.name,
            "sha256": hashlib.sha256(excluded_bytes).hexdigest(),
            "count": len(excluded_words),
        },
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
            records = [record for record in records
                       if record["word"].strip().upper() not in excluded_words]
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
    outputs.update((f"word-level-sources/{name}", content) for name, content in provenance_files.items())
    manifest["gameSources"] = {
        "file": "word-game-sources.json", "sha256": hashlib.sha256(game_source_bytes).hexdigest(),
        "gameCount": len(game_source_data["games"]), "wordCount": len(game_source_data["entries"]),
        "source": game_source_data["source"],
        "levelSourceFiles": len(provenance_files),
    }
    outputs["word-bank.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    DESTINATION.mkdir(parents=True, exist_ok=True)
    for filename, content in outputs.items():
        write_atomic(DESTINATION / filename, content)
    if args.game_catalog:
        write_atomic(GAME_SOURCES, game_source_bytes)
        for name, content in provenance_files.items():
            write_atomic(LEVEL_SOURCE_DIR / name, content)
    for group in manifest["groups"]:
        print(f"{group['label']}：{group['count']:,} 条")
    print(f"共 {manifest['totalCount']:,} 条，已导入 {DESTINATION}")


if __name__ == "__main__":
    main()
