import { importGameLevels } from "./level-import.js";
import { createGameExport } from "./level-export.js";
import { calculateLevelStatistics, describePath } from "./level-statistics.js";
import { validateLevelConfig } from "./level-config.js";
import { normalizeFixedWords, normalizeFixedLayout, normalizeFixedWordExemptions } from "./fixed-words.js";

const copy = value => structuredClone(value);
const LEVEL_FIELDS = new Set(["rows", "columns", "cells", "disabledCells", "name", "targetCount", "initialWords", "candidateWords",
  "targetWords", "extraWords", "statistics", "filters", "fixedWords", "fixedLayout", "fixedWordExemptions", "initialForwardProbability",
  "initialRarityLevel", "minimumEmotionScore", "duplicateCheck", "targetsEdited", "sourceConfig", "targetLimitsEnabled",
  "targetLengthPlan", "targetLengthRatios", "targetLengthCounts", "initialMaxWordLength", "maxWordLength"]);

function snapshotLevel(record) {
  if (!record.changed && record.original) return copy(record.original.level);
  // Preserve extension fields without restoring an old board's fixed layout or
  // generation settings after a replacement from single-level JSON.
  const extensions = Object.fromEntries(Object.entries(record.original?.level ?? {}).filter(([key]) => !LEVEL_FIELDS.has(key)));
  return copy({ ...extensions, ...record.level });
}

function editorLevel(raw, dictionary) {
  // Ambiguity is advisory; validate the assigned paths and game format.
  const game = createGameExport([{ level: raw }]);
  const parsed = importGameLevels(game, dictionary)[0];
  const found = new Map([...parsed.targetWords, ...parsed.extraWords].map(entry => [entry.word, entry]));
  function restore(entries, fallback) {
    if (entries === undefined) return fallback;
    if (!Array.isArray(entries)) throw new Error("单词列表无效。");
    return entries.map(entry => {
      const match = found.get(entry?.word);
      if (!match) throw new Error("单词列表包含不在棋盘中的词。");
      const path = entry.path;
      const valid = Array.isArray(path) && path.length === entry.word.length && new Set(path).size === path.length &&
        path.every((cell, index) => Number.isInteger(cell) && parsed.cells[cell]?.letter === entry.word[index] &&
          (!index || Math.abs(Math.floor(cell / raw.columns) - Math.floor(path[index - 1] / raw.columns)) + Math.abs(cell % raw.columns - path[index - 1] % raw.columns) === 1));
      if (!valid) throw new Error(`${entry.word} 的路径无效。`);
      return { ...match, ...entry, pathAnalysis: { ...match.pathAnalysis, assigned: describePath(path, raw.columns) } };
    });
  }
  const level = { ...parsed, ...copy(raw), disabledCells: parsed.disabledCells, cells: parsed.cells,
    initialWords: restore(raw.initialWords, []), candidateWords: restore(raw.candidateWords, parsed.candidateWords),
    targetWords: restore(raw.targetWords, parsed.targetWords), extraWords: restore(raw.extraWords, parsed.extraWords) };
  level.fixedWords = normalizeFixedWords(level.fixedWords ?? []);
  level.fixedLayout = normalizeFixedLayout(level);
  level.fixedWordExemptions = normalizeFixedWordExemptions(level);
  validateLevelConfig({ ...level,
    targetDuplicateRange: level.duplicateCheck?.target?.range ?? level.duplicateCheck?.range ?? 0,
    extraDuplicateRange: level.duplicateCheck?.extra?.range ?? level.duplicateCheck?.range ?? 0 });
  level.targetCount = level.targetWords.length;
  level.statistics = calculateLevelStatistics(level);
  return level;
}

export function parseLevelFile(text, dictionary = []) {
  let original;
  try { original = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { throw new Error("关卡文件不是有效的 JSON。"); }
  if ((Array.isArray(original?.records) && (original.records.some(record => record?.config && !record.level) ||
      (!original.records.length && original.version !== undefined && original.schemaVersion === undefined))) ||
      (original?.version === 2 && Array.isArray(original.lists))) {
    throw new Error("这是生成配置列表，不是关卡文件。请在“关卡配置列表”中使用生成配置。");
  }
  let format, records;
  if (Array.isArray(original?.records)) {
    format = "editor";
    records = original.records.map((record, index) => {
      try { return { id: index + 1, original: copy(record), level: editorLevel(record?.level, dictionary) }; }
      catch (error) { throw new Error(`第 ${index + 1} 关：${error.message}`); }
    });
  } else {
    format = original && typeof original.g === "string" ? "single" : "game";
    const pack = format === "single" ? { books: [{ levels: [original] }], daily: [] } : original;
    if (!pack || !Array.isArray(pack.books) || !Array.isArray(pack.daily) || pack.books.some(book => !Array.isArray(book?.levels))) {
      throw new Error("请选择游戏关卡文件（books / daily 或单关 g、t、n、e）或编辑器关卡文件（records / level）。");
    }
    const locations = [...pack.books.flatMap((book, index) => book.levels.map(source => ({ group: index, original: source }))),
      ...pack.daily.map(source => ({ group: "daily", original: source }))];
    const levels = locations.length ? importGameLevels(pack, dictionary) : [];
    records = levels.map((level, index) => ({ id: index + 1, ...copy(locations[index]), level }));
  }
  return { format, original, records, savedText: text, dirty: false, nextId: records.length + 1 };
}

export function updateFileLevel(document, id, level) {
  // Validate a complete replacement before changing the in-memory file.
  createGameExport([{ level }]);
  const current = document.records.find(record => record.id === id);
  if (current) {
    current.level = copy(level);
    current.changed = true;
  } else {
    if (document.format === "single" && document.records.length) throw new Error("单关文件只能保存一关。");
    id = document.nextId++;
    const group = document.records.at(-1)?.group ?? (document.original.books?.length ? 0 : "daily");
    document.records.push({ id, group, level: copy(level), changed: true });
    document.orderChanged = true;
  }
  document.dirty = true;
  return id;
}

export function changeFileOrder(document, id, action) {
  const index = document.records.findIndex(record => record.id === id);
  if (index < 0) throw new Error("关卡不存在。");
  if (action === "delete") {
    if (document.format === "single") throw new Error("单关文件不能删除唯一的关卡。");
    document.records.splice(index, 1);
  } else {
    const next = index + (action === "up" ? -1 : action === "down" ? 1 : 0);
    if (next === index) throw new Error("移动方向无效。");
    if (next < 0 || next >= document.records.length) return;
    const currentGroup = document.records[index].group, nextGroup = document.records[next].group;
    [document.records[index], document.records[next]] = [document.records[next], document.records[index]];
    // Preserve book boundaries and sizes when moving across two books.
    document.records[index].group = currentGroup;
    document.records[next].group = nextGroup;
  }
  document.dirty = true;
  document.orderChanged = true;
}

export function serializeLevelFile(document) {
  const { format, records } = document;
  if (format === "single" && records.length !== 1) throw new Error("单关文件必须保留一关。");
  const exported = records.length ? createGameExport(records).books[0].levels : [];
  let output = copy(document.original);
  if (format === "editor") {
    const usedIds = new Set(records.map(record => String(record.original?.id)));
    let nextId = Math.max(0, ...records.map(record => Number.isSafeInteger(record.original?.id) ? record.original.id : 0)) + 1;
    output.records = records.map((record, index) => {
      while (usedIds.has(String(nextId))) nextId++;
      return { ...(record.original ?? { id: nextId++, createdAt: Date.now(), position: index + 1 }),
        ...(document.orderChanged ? { position: index + 1 } : {}),
        level: snapshotLevel(record) };
    });
  } else {
    const usedIds = new Set(records.map(record => String(record.original?.id)));
    let nextId = 1;
    const levels = records.map((record, index) => {
      if (!record.changed && record.original) return copy(record.original);
      const generated = exported[index];
      if (!record.original) {
        while (usedIds.has(String(nextId))) nextId++;
        usedIds.add(String(nextId));
        return { ...generated, id: String(nextId++) };
      }
      // IDs, book metadata, lv/ty, curtains and unknown fields belong to the
      // original file. Only editor-owned board/word fields are replaced.
      return { ...copy(record.original), ...Object.fromEntries(["g", "t", "n", "e", "name"].map(key => [key, generated[key]])) };
    });
    if (format === "single") output = levels[0];
    else {
      output.books.forEach(book => { book.levels = []; });
      output.daily = [];
      records.forEach((record, index) => {
        const destination = record.group === "daily" ? output.daily : output.books[record.group]?.levels;
        if (!destination) throw new Error("关卡所属书册不存在。");
        destination.push(levels[index]);
      });
    }
  }
  return JSON.stringify(output, null, 2) + "\n";
}

export async function writeLevelFile(document, handle = document.handle) {
  if (!handle) throw new Error("此文件需要另存为后才能保存回原文件。");
  const text = serializeLevelFile(document);
  const sameFile = handle === document.handle || (document.handle && await handle.isSameEntry(document.handle));
  if (sameFile && await (await handle.getFile()).text() !== document.savedText) {
    throw new Error("原文件已被其他程序修改，未覆盖。请先另存为保留当前修改，再重新打开原文件。");
  }
  let stream;
  try {
    stream = await handle.createWritable();
    await stream.write(text);
    await stream.close();
  } catch (error) {
    try { await stream?.abort(); } catch { /* A failed close may already abort the stream. */ }
    throw error;
  }
  document.savedText = text;
  document.original = JSON.parse(text);
  const originals = document.format === "editor" ? document.original.records : document.format === "single" ? [document.original]
    : [...document.original.books.flatMap(book => book.levels), ...document.original.daily];
  document.records.forEach((record, index) => { record.original = copy(originals[index]); record.changed = false; });
  document.handle = handle;
  document.label = handle.name;
  document.dirty = false;
  document.orderChanged = false;
  return text;
}
