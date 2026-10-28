import { createPathSafetyChecker } from "./path-safety.js";

export function normalizeFixedWords(value = []) {
  const entries = typeof value === "string" ? value.split(/[\s,，、;；]+/) : value;
  if (!Array.isArray(entries)) throw new Error("固定单词需为单词列表。");
  const words = [];
  for (const entry of entries) {
    if (typeof entry !== "string") throw new Error("固定单词只能包含英文字母。");
    const word = entry.trim().toUpperCase();
    if (!word) continue;
    if (!/^[A-Z]+$/.test(word)) throw new Error(`固定单词「${entry}」只能包含英文字母。`);
    if (!words.includes(word)) words.push(word);
  }
  return words;
}

export function normalizeFixedWordExemptions(config) {
  if (config.fixedWordExemptions !== undefined && !Array.isArray(config.fixedWordExemptions)) throw new Error("固定词豁免需为单词列表。");
  const exemptions = normalizeFixedWords(config.fixedWordExemptions);
  const fixed = new Set(normalizeFixedWords(config.fixedWords));
  if (exemptions.some(word => !fixed.has(word))) throw new Error("豁免只适用于已指定的初始固定词。");
  return exemptions;
}

export function fixedLayoutLetters(rows, columns, placements) {
  const letters = Array(rows * columns).fill("");
  for (const { word, path } of placements) {
    path.forEach((cell, index) => {
      if (letters[cell] && letters[cell] !== word[index]) throw new Error(`固定单词 ${word} 与已有字母冲突。`);
      letters[cell] = word[index];
    });
  }
  return letters;
}

export function normalizeFixedLayout(config) {
  const layout = config.fixedLayout;
  if (layout === null || layout === undefined) return null;
  if (!layout || typeof layout !== "object" || !Array.isArray(layout.placements) ||
      ![2, 3].includes(layout.rows) || ![3, 4, 5].includes(layout.columns)) throw new Error("固定单词棋盘格式无效。");
  if (layout.rows !== config.rows || layout.columns !== config.columns) throw new Error("棋盘尺寸已变化，请打开固定单词重新确认摆放位置。");
  const words = new Set(normalizeFixedWords(config.fixedWords));
  const seen = new Set();
  const placements = layout.placements.map(entry => {
    const word = normalizeFixedWords([entry?.word])[0];
    if (!words.has(word) || seen.has(word)) throw new Error("固定位置中的单词缺失或重复。");
    seen.add(word);
    const path = entry.path;
    if (!Array.isArray(path) || path.length !== word.length || new Set(path).size !== path.length || path.some((cell, index) => {
      if (!Number.isInteger(cell) || cell < 0 || cell >= config.rows * config.columns) return true;
      if (!index) return false;
      const previous = path[index - 1];
      return Math.abs(Math.floor(cell / config.columns) - Math.floor(previous / config.columns)) + Math.abs(cell % config.columns - previous % config.columns) !== 1;
    })) throw new Error(`固定单词 ${word} 的路径必须连续、不能重复用格。`);
    return { word, path: [...path] };
  });
  if (!placements.length) return null;
  const letters = fixedLayoutLetters(config.rows, config.columns, placements);
  const check = createPathSafetyChecker({ rows: config.rows, columns: config.columns, letters }, { allowEmpty: true });
  for (const { word } of placements) if (!check(word)) throw new Error(`固定单词 ${word} 已存在使用不同格子的路径，请调整摆放位置。`);
  return { rows: config.rows, columns: config.columns, placements };
}

export function validateFixedWords(config, targetLengthCounts = null) {
  const words = normalizeFixedWords(config.fixedWords);
  if (words.length > config.targetCount) throw new Error("固定单词数量不能超过目标数量。");
  const remaining = targetLengthCounts ? { ...targetLengthCounts } : null;
  const requiredLetters = new Map();
  for (const word of words) {
    if (word.length > config.rows * config.columns) throw new Error(`固定单词 ${word} 的长度超过棋盘格子数。`);
    if (word.length > config.initialMaxWordLength) throw new Error(`固定单词 ${word} 超过初始词最长限制。`);
    if (word.length > config.maxWordLength) throw new Error(`固定单词 ${word} 超过最长单词限制。`);
    const group = word.length === 3 ? "short" : word.length === 4 ? "medium" : word.length >= 5 ? "long" : null;
    if (remaining && !(remaining[group]-- > 0)) throw new Error(`固定单词 ${word} 超出目标词长名额，请调整目标词长配置。`);
    const letters = new Map();
    for (const letter of word) letters.set(letter, (letters.get(letter) ?? 0) + 1);
    for (const [letter, count] of letters) requiredLetters.set(letter, Math.max(requiredLetters.get(letter) ?? 0, count));
  }
  if ([...requiredLetters.values()].reduce((sum, count) => sum + count, 0) > config.rows * config.columns) {
    throw new Error("固定单词所需的字母格子超过棋盘容量。");
  }
  return words;
}
