import { SHAPE_LIBRARY } from './shape-library.js';

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

// Width × height; retain each supplied shape exactly, including full rectangles.
export const RANDOM_BOARD_SHAPES = Object.fromEntries(
  [...new Set(SHAPE_LIBRARY.map(shape=>`${shape.columns}x${shape.rows}`))].map(size=>[
    size,SHAPE_LIBRARY.filter(shape=>`${shape.columns}x${shape.rows}`===size)
      .sort((a,b)=>Number(b.activeCells===b.rows*b.columns)-Number(a.activeCells===a.rows*a.columns)||a.id-b.id)
      .map(shape=>[...shape.boardMask]),
  ]),
);

export function randomizeBoardShape(config, random = Math.random) {
  const shapes = RANDOM_BOARD_SHAPES[`${config.columns}x${config.rows}`];
  if (!config.randomBoardShape || !shapes || config.fixedLayout || config.generationRules) return config;
  const matrix = shapes[Math.floor(random() * shapes.length)];
  return { ...config, disabledCells: matrix.join('').split('').flatMap((cell, index) => cell === '0' ? [index] : []) };
}
