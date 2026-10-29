import { assertSafeTargetPaths } from "./path-safety.js";
import { normalizeDisabledCells } from "./board-shape.js";

// Compatible with word关卡/index.html: assemblePack / freshLevel.
export function createGameExport(records) {
  if (!Array.isArray(records) || !records.length) throw new Error("关卡列表为空。");
  const levels = records.map(({ level }, index) => {
    const number = index + 1;
    const fail = message => { throw new Error(`第 ${number} 关：${message}`); };
    if (!level || ![2, 3, 4, 5].includes(level.rows) || ![2, 3, 4, 5].includes(level.columns)) fail("棋盘尺寸无效。");
    const { rows, columns, cells, targetWords, extraWords } = level;
    const disabled = new Set(normalizeDisabledCells({ ...level, disabledCells: level.disabledCells ?? cells?.flatMap((cell, index) => cell.disabled ? [index] : []) }));
    if (!Array.isArray(cells) || cells.length !== rows * columns || cells.some((cell, index) => !disabled.has(index) && !/^[A-Z]$/.test(cell?.letter ?? ""))) {
      fail("棋盘未填满或字母无效。");
    }
    if (!Array.isArray(targetWords) || !targetWords.length || !Array.isArray(extraWords)) fail("单词数据不完整。");
    const counts = Array(cells.length).fill(0);
    const names = new Set();
    for (const [entries, isTarget] of [[targetWords, true], [extraWords, false]]) {
      for (const entry of entries) {
        const word = entry?.word;
        const path = entry?.path;
        if (!/^[A-Z]+$/.test(word ?? "") || names.has(word)) fail("单词无效或重复。");
        names.add(word);
        if (!Array.isArray(path) || path.length !== word.length || new Set(path).size !== path.length || path.some((cell, step) => {
          if (!Number.isInteger(cell) || cell < 0 || cell >= cells.length || disabled.has(cell) || cells[cell].letter !== word[step]) return true;
          if (!step) return false;
          const previous = path[step - 1];
          return Math.abs(Math.floor(cell / columns) - Math.floor(previous / columns)) + Math.abs(cell % columns - previous % columns) !== 1;
        })) fail(`${word} 的连接路径无效。`);
        if (isTarget) for (const cell of path) counts[cell] += 1;
      }
    }
    try { assertSafeTargetPaths({ ...level, disabledCells: [...disabled] }); } catch (error) { fail(error.message); }
    if (counts.some((count, index) => disabled.has(index) ? count !== 0 : count < 1 || count > 35)) fail("格子使用次数须为 1～35，才能写入游戏格式。");
    return {
      id: String(number),
      name: String(level.name ?? ""),
      g: Array.from({ length: rows }, (_, row) => cells.slice(row * columns, (row + 1) * columns).map((cell, column) => disabled.has(row * columns + column) ? "-" : cell.letter).join("")).join(","),
      t: targetWords.map(entry => entry.word).sort((a, b) => a.length - b.length || a.localeCompare(b)).join(" "),
      n: counts.map(count => count.toString(36)).join(""),
      e: extraWords.map(entry => entry.word).sort().join(" "),
      lv: "",
      ty: "",
      curtains: [],
    };
  });
  return { books: [{ name: "第一册", sub: "入门", mix: [100, 0, 0, 0, 0], levels }], daily: [] };
}

export function gameExportText(records) {
  return JSON.stringify(createGameExport(records), null, 2) + "\n";
}
