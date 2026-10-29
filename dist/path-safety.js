export const pathCellMask = path => path.reduce((mask, cell) => mask | (1 << cell), 0);

// Check the actual board, including legacy files without safety metadata. No path
// limit: stopping is only safe after finding a conflict, or a full-board path.
export function createPathSafetyChecker(level, { allowEmpty = false } = {}) {
  const { rows, columns } = level ?? {};
  const letters = level?.letters ?? level?.cells?.map(cell => cell.letter) ?? [];
  const validBoard = [2, 3, 4, 5].includes(rows) && [2, 3, 4, 5].includes(columns) &&
    letters.length === rows * columns && letters.every((letter, cell) => /^[A-Z]$/.test(letter) || (letter === "" && (allowEmpty || level.disabledCells?.includes(cell) || level.cells?.[cell]?.disabled)));
  const neighbors = letters.map((_, cell) => [
    ...(cell >= columns ? [cell - columns] : []),
    ...(cell + columns < letters.length ? [cell + columns] : []),
    ...(cell % columns > 0 ? [cell - 1] : []),
    ...(cell % columns < columns - 1 ? [cell + 1] : []),
  ]);
  const results = new Map();
  return word => {
    if (results.has(word)) return results.get(word);
    if (!validBoard || typeof word !== "string" || !/^[A-Z]+$/.test(word) || word.length > letters.length) return false;
    let firstMask = null;
    let safe = true;
    const complete = () => !safe || (firstMask !== null && word.length === letters.length);
    function visit(cell, step, mask) {
      if (complete() || level.disabledCells?.includes(cell) || level.cells?.[cell]?.disabled || letters[cell] !== word[step]) return;
      mask |= 1 << cell;
      if (step === word.length - 1) {
        firstMask ??= mask;
        if (mask !== firstMask) safe = false;
        return;
      }
      for (const next of neighbors[cell]) if (!(mask & (1 << next))) visit(next, step + 1, mask);
    }
    for (let cell = 0; cell < letters.length && !complete(); cell++) visit(cell, 0, 0);
    const result = safe && firstMask !== null;
    results.set(word, result);
    return result;
  };
}

export function assertSafeTargetPaths(level) {
  const check = createPathSafetyChecker(level);
  const unsafe = (level.targetWords ?? []).filter(entry => !check(entry.word)).map(entry => entry.word);
  if (unsafe.length) throw new Error(`目标词 ${unsafe.join("、")} 存在使用不同格子的路径，可能导致关卡无法完成，请重新生成或调整目标词。`);
}
