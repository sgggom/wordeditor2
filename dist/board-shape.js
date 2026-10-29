export function normalizeDisabledCells({ rows, columns, disabledCells = [] }) {
  if (!Array.isArray(disabledCells) || disabledCells.some(cell => !Number.isInteger(cell) || cell < 0 || cell >= rows * columns)) {
    throw new Error("禁用格子配置无效。");
  }
  const result = [...new Set(disabledCells)].sort((a, b) => a - b);
  if (result.length >= rows * columns) throw new Error("棋盘至少需要保留一个启用格子。");
  return result;
}

export function resizeDisabledCells(size, next) {
  return (size.disabledCells ?? []).flatMap(cell => {
    const row = Math.floor(cell / size.columns), column = cell % size.columns;
    return row < next.rows && column < next.columns ? [row * next.columns + column] : [];
  });
}
