import assert from 'node:assert/strict';
import test from 'node:test';
import { createGenerator } from '../dist/level-generator.js';
import { normalizeDisabledCells, resizeDisabledCells } from '../dist/board-shape.js';
import { createGameExport } from '../dist/level-export.js';
import { importGameLevels } from '../dist/level-import.js';
import { createPathSafetyChecker } from '../dist/path-safety.js';
import { saveConfigList, readConfigList } from '../dist/level-config.js';

const dictionary = ['CAT', 'DOG'].map(word => ({ word }));

test('all sixteen sizes generate valid boards and round-trip through export/import', () => {
  for (let rows = 2; rows <= 5; rows++) for (let columns = 2; columns <= 5; columns++) {
    const words = Array.from({ length: rows }, (_, row) => String.fromCharCode(65 + row).repeat(columns));
    const records = words.map(word => ({ word }));
    const level = createGenerator(records).generate({ rows, columns, targetCount: rows, fixedWords: words,
      fixedLayout: { rows, columns, placements: words.map((word, row) => ({ word, path: Array.from({ length: columns }, (_, column) => row * columns + column) })) } });
    assert.equal(level.cells.length, rows * columns);
    const restored = importGameLevels(createGameExport([{ level }]), records)[0];
    assert.deepEqual(restored.cells, level.cells);
    assert.equal(createPathSafetyChecker(level)(words[0]), true);
  }
});

test('disabled cells stay empty, are excluded from paths and statistics, and survive export/import', () => {
  const disabledCells = [2, 5, 8];
  const level = createGenerator(dictionary).generate({ rows: 3, columns: 3, targetCount: 2, disabledCells,
    fixedWords: ['CAT', 'DOG'], fixedLayout: { rows: 3, columns: 3, placements: [
      { word: 'CAT', path: [0, 3, 6] }, { word: 'DOG', path: [1, 4, 7] },
    ] } });
  for (const cell of disabledCells) assert.deepEqual(level.cells[cell], { letter: '', count: 0, disabled: true });
  assert.equal(level.statistics.board.cellCount, 6);
  assert.equal(level.statistics.usage.density, 1);
  assert.ok(level.targetWords.every(entry => entry.path.every(cell => !disabledCells.includes(cell))));
  assert.ok(createPathSafetyChecker(level)('CAT'));
  const exported = createGameExport([{ level }]);
  assert.equal(exported.books[0].levels[0].g, 'CD-,AO-,TG-');
  assert.deepEqual(importGameLevels(exported, dictionary)[0].cells, level.cells);
});

test('automatic placement fills only enabled cells and cannot bridge disabled cells', () => {
  const level = createGenerator(dictionary).generate({ rows: 3, columns: 3, targetCount: 2,
    disabledCells: [2, 5, 8], random: () => 0.5 });
  assert.ok(level.cells.filter(cell => !cell.disabled).every(cell => cell.letter && cell.count > 0));
  const found = createGenerator(dictionary).findWords({ rows: 2, columns: 3,
    letters: ['C', '', 'T', 'D', 'O', 'G'], disabledCells: [1] });
  assert.deepEqual(found.map(entry => entry.word), ['DOG']);
});

test('shape validation, resizing and saved configurations preserve coordinates', () => {
  assert.throws(() => normalizeDisabledCells({ rows: 2, columns: 2, disabledCells: [0, 1, 2, 3] }), /至少/);
  assert.throws(() => normalizeDisabledCells({ rows: 2, columns: 2, disabledCells: [4] }), /无效/);
  assert.deepEqual(resizeDisabledCells({ rows: 3, columns: 3, disabledCells: [0, 4, 8] }, { rows: 2, columns: 5 }), [0, 6]);
  const config = { rows: 5, columns: 2, disabledCells: [0, 9], targetCount: 2, targetLengthPlan: null,
    initialMaxWordLength: 8, maxWordLength: 8, initialForwardProbability: 50,
    targetDuplicateRange: 0, extraDuplicateRange: 0, filters: {} };
  let raw;
  const storage = { getItem: () => raw ?? null, setItem: (_, value) => { raw = value; } };
  saveConfigList([{ id: 'shape', config }], storage);
  assert.deepEqual(readConfigList(storage)[0].config, config);
});

test('isolated enabled cells report an impossible shape before retrying', () => {
  assert.throws(() => createGenerator(dictionary).generate({ rows: 2, columns: 2,
    disabledCells: [1, 2, 3], targetCount: 1 }), /没有可用的初始词|造型/);
  assert.throws(() => createGenerator(dictionary).generate({ rows: 3, columns: 3,
    disabledCells: [1, 3], targetCount: 2 }), /造型/);
});
