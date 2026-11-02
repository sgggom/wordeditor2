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
export const RANDOM_BOARD_SHAPES = {
  '3x3': [
    ['111','111','111'], ['111','010','010'], ['111','111','101'],
    ['111','101','111'], ['011','111','110'],
  ],
  '4x3': [
    ['1111','1111','1111'], ['0111','1111','1110'], ['1110','1111','0111'],
    ['1111','1111','0110'], ['0110','1111','1111'], ['1011','1111','1101'],
    ['1110','0111','1110'], ['0111','1110','0111'],
  ],
  '5x3': [
    ['11111','11111','11111'], ['11111','11011','11111'], ['11011','11111','11011'],
    ['11111','11111','11011'], ['11011','11111','11111'], ['01110','11111','01110'],
    ['11111','11111','01110'], ['11111','01110','01110'], ['11111','01110','11111'],
    ['11100','01110','00111'], ['00111','01110','11100'], ['01111','11110','01111'],
    ['11110','01111','11110'], ['11111','10101','11111'], ['11011','11111','01110'],
    ['01110','11111','11011'], ['11111','10001','11111'], ['10111','11111','11101'],
    ['11101','11111','10111'],
  ],
};

export function randomizeBoardShape(config, random = Math.random) {
  const shapes = RANDOM_BOARD_SHAPES[`${config.columns}x${config.rows}`];
  if (!config.randomBoardShape || !shapes || config.fixedLayout) return config;
  const matrix = shapes[Math.floor(random() * shapes.length)];
  return { ...config, disabledCells: matrix.join('').split('').flatMap((cell, index) => cell === '0' ? [index] : []) };
}
