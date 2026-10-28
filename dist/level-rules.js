import { calculateLevelStatistics } from "./level-statistics.js";
import { createPathSafetyChecker } from "./path-safety.js";

export function createDuplicateCheck(records, ranges) {
  return Object.fromEntries(["target", "extra"].map(kind => {
    const range = ranges[kind];
    if (!Number.isSafeInteger(range) || range < 0) {
      throw new Error(`${kind === "target" ? "目标词" : "额外词"}查重范围需为大于或等于 0 的整数。`);
    }
    const recent = range === 0 ? [] : records.slice(-range);
    return [kind, {
      range,
      levelIds: recent.map(record => record.id),
      words: [...new Set(recent.flatMap(({ level }) => level[`${kind}Words`])
        .map(entry => entry.word.toUpperCase()))],
    }];
  }));
}

export function findDuplicateWords(level, duplicateCheck) {
  return Object.fromEntries(["target", "extra"].map(kind => {
    const previous = new Set(duplicateCheck[kind].range > 0
      ? duplicateCheck[kind].words.map(word => word.toUpperCase()) : []);
    return [kind, [...new Set(level[`${kind}Words`].map(entry => entry.word.toUpperCase()))]
      .filter(word => previous.has(word))];
  }));
}

export function setTargetWord(level, word, selected) {
  if (typeof selected !== "boolean") throw new Error("目标词选择无效。");
  const candidate = level.candidateWords.find(entry => entry.word === word);
  const wasSelected = level.targetWords.some(entry => entry.word === word);
  if ((!candidate || candidate.onlyExtra) && (selected || !wasSelected)) throw new Error("只能从候选词中选择目标词。");
  if (selected && !createPathSafetyChecker(level)(word)) throw new Error(`${word} 存在使用不同格子的连接路径，不能设为目标词。`);
  if (!selected && level.initialWords.some(entry => entry.word === word)) {
    throw new Error("初始词不能移出关卡目标。");
  }
  if (wasSelected === selected) return level;
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
  // Generation settings remain the template for the next generation. Statistics
  // and the word arrays describe the actual, manually edited target selection.
  const edited = { ...level, cells, targetWords, extraWords, targetsEdited: true };
  return { ...edited, statistics: calculateLevelStatistics(edited) };
}
