import { createPathSafetyChecker } from "./path-safety.js";
import { calculateLevelStatistics } from "./level-statistics.js";

export function createDuplicateCheck(records, ranges, beforePosition = null) {
  let history = records;
  if (beforePosition !== null) {
    if (!Number.isSafeInteger(beforePosition) || beforePosition < 1) throw new Error("当前关号需为正整数。");
    const latest = new Map();
    for (const [index, record] of records.entries()) {
      const sourcePosition = record.level.sourceConfig?.position;
      const position = Number.isSafeInteger(sourcePosition) && sourcePosition > 0 ? sourcePosition : index + 1;
      if (position >= beforePosition) continue;
      const previous = latest.get(position);
      // A rerun appends a new record. Use the newest version of each earlier
      // level, even if the saved list has since been reordered.
      if (!previous || !Number.isSafeInteger(previous.id) || !Number.isSafeInteger(record.id) || record.id > previous.id) latest.set(position, record);
    }
    history = [...latest.entries()].sort(([a], [b]) => a - b).map(([, record]) => record);
  }
  return Object.fromEntries(["target", "extra"].map(kind => {
    const range = ranges[kind];
    if (!Number.isSafeInteger(range) || range < 0) {
      throw new Error(`${kind === "target" ? "目标词" : "额外词"}查重范围需为大于或等于 0 的整数。`);
    }
    const recent = range === 0 ? [] : history.slice(-range);
    return [kind, {
      range,
      levelIds: recent.map(record => record.id),
      words: [...new Set(recent.flatMap(({ level }) => level[`${kind}Words`])
        .map(entry => entry.word.toUpperCase()))],
    }];
  }));
}

export function findDuplicateWords(level, duplicateCheck) {
  const fixed = new Set(level.fixedWords ?? []);
  const initial = new Set(level.initialWords?.map(entry => entry.word) ?? []);
  const exemptions = new Set((level.fixedWordExemptions ?? []).filter(word => fixed.has(word) && initial.has(word)));
  return Object.fromEntries(["target", "extra"].map(kind => {
    const previous = new Set(duplicateCheck[kind].range > 0
      ? duplicateCheck[kind].words.map(word => word.toUpperCase()) : []);
    return [kind, [...new Set(level[`${kind}Words`].map(entry => entry.word.toUpperCase()))]
      .filter(word => previous.has(word) && !(kind === "target" && exemptions.has(word)))];
  }));
}

export function setTargetWord(level, word, selected) {
  if (typeof selected !== "boolean") throw new Error("目标词选择无效。");
  const candidate = level.candidateWords.find(entry => entry.word === word);
  const wasSelected = level.targetWords.some(entry => entry.word === word);
  if ((!candidate || candidate.onlyExtra) && (selected || !wasSelected)) throw new Error("只能从候选词中选择目标词。");
  if (!selected && level.fixedWords?.includes(word)) throw new Error("固定单词不能移出关卡目标。");
  if (wasSelected === selected) return level;
  if (selected && !createPathSafetyChecker(level)(word)) throw new Error(`${word} 存在使用不同格子的路径，可能导致关卡无法完成，不能加入目标词。`);
  const allWords = [...level.targetWords, ...level.extraWords];
  const targetNames = new Set(level.targetWords.map(entry => entry.word));
  if (selected) targetNames.add(word);
  else targetNames.delete(word);
  const targetWords = selected ? [...level.targetWords, candidate] : level.targetWords.filter(entry => entry.word !== word);
  const extraWords = allWords.filter(entry => !targetNames.has(entry.word)).sort((a, b) => a.word.localeCompare(b.word));
  const cells = level.cells.map(cell => ({ ...cell, count: 0 }));
  for (const entry of targetWords) {
    for (const cell of entry.path) cells[cell].count += 1;
  }
  if (cells.some((cell, index) => !cell.disabled && !level.disabledCells?.includes(index) && cell.count < 1)) {
    throw new Error("移除后有格子没有目标词覆盖，请先勾选覆盖这些格子的其他目标词。");
  }
  // Counts and statistics always describe the current target selection.
  const edited = { ...level, cells, targetWords, extraWords, targetCount: targetWords.length, targetLimitsEnabled: false, targetsEdited: true };
  return { ...edited, statistics: calculateLevelStatistics(edited) };
}
