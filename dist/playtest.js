export function createPlaytestState(level) {
  const { rows, columns, cells, targetWords, extraWords = [] } = level ?? {};
  if (![2, 3, 4, 5].includes(rows) || ![2, 3, 4, 5].includes(columns) ||
      !Array.isArray(cells) || cells.length !== rows * columns || !Array.isArray(targetWords) || !targetWords.length || !Array.isArray(extraWords)) {
    throw new Error("请先生成或选择一个完整关卡，再开始试玩。");
  }
  const disabled = new Set(level.disabledCells ?? []);
  const board = cells.map((cell, index) => {
    const blocked = disabled.has(index) || Boolean(cell?.disabled);
    if (!Number.isSafeInteger(cell?.count) || cell.count < 0 || cell.count > 35 ||
        (blocked && cell.count !== 0) || (!blocked && !/^[A-Z]$/.test(cell.letter))) {
      throw new Error("当前关卡的字母或格子次数无效，请检查关卡后再试玩。");
    }
    return { letter: cell.letter, count: cell.count, disabled: blocked };
  });
  const targets = targetWords.map(entry => entry?.word);
  const extras = extraWords.map(entry => entry?.word);
  if (new Set(targets).size !== targets.length || [...targets, ...extras].some(word => !/^[A-Z]+$/.test(word))) {
    throw new Error("当前关卡的单词数据无效。");
  }
  return { rows, columns, cells: board, targets, extras, foundTargets: [], foundExtras: [] };
}

export function playtestComplete(state) {
  return state.foundTargets.length === state.targets.length && state.cells.every(cell => cell.count === 0);
}

function available(state, cell) {
  return Number.isInteger(cell) && cell >= 0 && cell < state.cells.length &&
    !state.cells[cell].disabled && state.cells[cell].count > 0;
}

function adjacent(state, first, second) {
  return Math.abs(Math.floor(first / state.columns) - Math.floor(second / state.columns)) +
    Math.abs(first % state.columns - second % state.columns) === 1;
}

export function extendPlaytestPath(state, path, cell) {
  if (!available(state, cell) || path.at(-1) === cell) return path;
  if (path.length > 1 && path.at(-2) === cell) return path.slice(0, -1);
  if (path.includes(cell) || (path.length && !adjacent(state, path.at(-1), cell))) return path;
  return [...path, cell];
}

// Consume the submitted route, including valid alternatives to the editor's
// assigned route. Every transition leaves the editor and previous state intact.
export function submitPlaytestPath(state, path) {
  const reply = (kind, message, next = state, word = "") => ({ state: next, kind, message, word });
  if (playtestComplete(state)) return reply("complete", "本关已完成，点击“重玩”再试一次。");
  if (!Array.isArray(path) || !path.length || new Set(path).size !== path.length || path.some((cell, step) =>
    !available(state, cell) || (step > 0 && !adjacent(state, path[step - 1], cell)))) {
    return reply("invalid", "请连接上下左右相邻的可用字母，同一格不能重复使用。");
  }
  const word = path.map(cell => state.cells[cell].letter).join("");
  if (state.foundTargets.includes(word) || state.foundExtras.includes(word)) {
    return reply("repeat", `${word} 已经找到了。`, state, word);
  }
  if (state.targets.includes(word)) {
    const used = new Set(path);
    const next = { ...state, foundTargets: [...state.foundTargets, word],
      cells: state.cells.map((cell, index) => ({ ...cell, count: cell.count - Number(used.has(index)) })) };
    const complete = playtestComplete(next);
    return reply(complete ? "complete" : "target", complete ? "全部目标词已找到，本关完成！" :
      next.foundTargets.length === next.targets.length ? "目标词已找齐，但格子还有剩余次数，请返回检查关卡。" : `找到目标词 ${word}`, next, word);
  }
  if (state.extras.includes(word)) {
    return reply("extra", `发现额外词 ${word}，格子次数不变。`,
      { ...state, foundExtras: [...state.foundExtras, word] }, word);
  }
  return reply("invalid", `${word} 不是本关单词，再试试。`, state, word);
}
