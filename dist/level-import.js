import { calculateLevelStatistics, compareRepresentativePaths, describePath } from "./level-statistics.js";
import { pathCellMask } from "./path-safety.js";

export function gameLevelLocations(data) {
  if (!data || !Array.isArray(data.daily)) throw new Error("需要包含 level 和 daily 的关卡 JSON（也支持旧版 books / daily）。");
  let locations;
  if (Object.hasOwn(data, "level")) {
    if (!Array.isArray(data.level)) throw new Error("level 必须为关卡数组。");
    locations = data.level.map(original => ({ group: "level", original }));
  } else {
    if (!Array.isArray(data.books) || data.books.some(book => !Array.isArray(book?.levels))) {
      throw new Error("需要包含 level 和 daily 的关卡 JSON（也支持旧版 books / daily）。");
    }
    locations = data.books.flatMap((book, group) => book.levels.map(original => ({ group, original })));
  }
  return [...locations, ...data.daily.map(original => ({ group: "daily", original }))];
}

export function gameLevelData(source) {
  return source && Object.hasOwn(source, "a") ? source
    : { a: source?.g, b: source?.n, c: source?.t, d: source?.e };
}

export function singleGamePack(data) {
  return data && typeof data === "object" && !Array.isArray(data) && (Object.hasOwn(data, "a") || Object.hasOwn(data, "g"))
    ? { level: [data], daily: [] } : data;
}

export function importGameLevels(data, records = []) {
  const sources = gameLevelLocations(data).map(location => location.original);
  if (!sources.length) throw new Error("文件中没有关卡。");
  const dictionary = new Map(records.map(record => [record.word, record]));
  return sources.map((original, index) => {
    const source = gameLevelData(original);
    const fail = message => { throw new Error(`第 ${index + 1} 关：${message}`); };
    const grid = typeof source.a === "string" ? source.a.split(",") : [];
    const rows = grid.length, columns = grid[0]?.length;
    if (![2, 3, 4, 5].includes(rows) || ![2, 3, 4, 5].includes(columns) || grid.some(row => row.length !== columns || !/^[A-Z-]+$/.test(row))) fail("棋盘尺寸或字母无效。");
    const letters = [...grid.join("")].map(letter => letter === "-" ? "" : letter);
    const disabledCells = letters.flatMap((letter, index) => letter ? [] : [index]);
    if (disabledCells.length === letters.length) fail("棋盘没有启用格子。");
    const words = value => {
      if (typeof value !== "string") fail("单词字段无效。");
      const result = value.trim() ? value.trim().split(/\s+/) : [];
      if (result.some(word => !/^[A-Z]+$/.test(word))) fail("单词必须为大写英文字母。");
      return result;
    };
    const targets = words(source.c), extras = words(source.d);
    if (!targets.length || new Set([...targets, ...extras]).size !== targets.length + extras.length) fail("目标词为空或单词重复。");
    const neighbors = letters.map((_, cell) => [cell - columns, cell + columns,
      ...(cell % columns ? [cell - 1] : []), ...(cell % columns < columns - 1 ? [cell + 1] : [])]
      .filter(next => next >= 0 && next < letters.length));
    const entries = [...targets, ...extras].map(word => {
      if (word.length > letters.length) fail(`${word} 超出棋盘长度。`);
      const paths = [];
      function visit(cell, path, used) {
        if (letters[cell] !== word[path.length]) return;
        const nextPath = [...path, cell];
        if (nextPath.length === word.length) { paths.push(nextPath); return; }
        for (const next of neighbors[cell]) if (!(used & (1 << next))) visit(next, nextPath, used | (1 << next));
      }
      for (let cell = 0; cell < letters.length; cell++) visit(cell, [], 1 << cell);
      if (!paths.length) fail(`${word} 无法在棋盘中连接。`);
      return { ...dictionary.get(word), id: dictionary.get(word)?.id ?? word, word, paths,
        onlyExtra: !targets.includes(word) && dictionary.get(word)?.onlyExtra === true };
    });
    if (typeof source.b !== "string" || source.b.length !== letters.length || !/^[0-9a-z]+$/i.test(source.b)) fail("格子使用次数无效。");
    const remaining = [...source.b].map(char => parseInt(char, 36));
    const targetEntries = entries.slice(0, targets.length);
    const ordered = [...targetEntries].sort((a, b) => a.paths.length - b.paths.length);
    let attempts = 0;
    function assign(position) {
      if (++attempts > 200000) fail("连接路径组合过多，无法还原格子计数。");
      if (position === ordered.length) return remaining.every(count => count === 0);
      const entry = ordered[position];
      for (const path of entry.paths) {
        if (path.some(cell => remaining[cell] < 1)) continue;
        path.forEach(cell => remaining[cell]--);
        entry.path = path;
        if (assign(position + 1)) return true;
        path.forEach(cell => remaining[cell]++);
      }
      return false;
    }
    if (!assign(0)) fail("目标词路径与格子使用次数不一致。");
    for (const entry of entries) {
      const descriptions = entry.paths.map(path => describePath(path, columns)).sort(compareRepresentativePaths);
      entry.path ??= descriptions[0].path;
      const mask = pathCellMask(entry.path);
      entry.pathAnalysis = { legalPathCount: entry.paths.length, safe: entry.paths.every(path => pathCellMask(path) === mask),
        assigned: describePath(entry.path, columns), representative: descriptions[0] };
      delete entry.paths;
    }
    const level = { rows, columns, disabledCells, name: original.name ?? "", targetCount: targets.length,
      initialForwardProbability: 50, filters: {}, initialWords: [],
      candidateWords: entries.filter(entry => !entry.onlyExtra), targetWords: targetEntries,
      extraWords: entries.slice(targets.length),
      cells: letters.map((letter, cell) => ({ letter, count: parseInt(source.b[cell], 36), ...(disabledCells.includes(cell) ? { disabled: true } : {}) })),
    };
    return { ...level, statistics: calculateLevelStatistics(level) };
  });
}

export function importSingleGameLevel(text, records = []) {
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { throw new Error("JSON 格式无效，请粘贴完整的单关数据。"); }
  const pack = singleGamePack(data);
  let locations;
  try { locations = gameLevelLocations(pack); }
  catch { throw new Error("请粘贴包含 a、b、c、d 的单关 JSON 对象（也支持旧版 g、t、n、e）。"); }
  if (locations.length !== 1) {
    throw new Error("每次只能读取一关数据。");
  }
  return importGameLevels(pack, records)[0];
}
