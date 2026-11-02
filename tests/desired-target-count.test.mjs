import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerator, generateUntilComplete } from '../dist/level-generator.js';
import { createDuplicateCheck, findDuplicateWords } from '../dist/level-rules.js';
import { createGameExport } from '../dist/level-export.js';
import { validateLevelConfig, patchLevelConfigs } from '../dist/level-config.js';
import { configXlsxTemplate, parseConfigXlsx, serializeConfigXlsx } from '../dist/config-table-xlsx.js';
import * as XLSX from '../dist/vendor/sheetjs/xlsx.js';

const records = ['ABCDEF', 'ABC', 'DEF', 'CBA', 'FED', 'ABCF', 'CFED'].map(word => ({ word, scope: 1, emotion: 0, rarityLevel: 1 }));
const generator = createGenerator(records, [{ word: 'FEDCBA', scope: 1, emotion: 0, rarityLevel: 1 }]);
const board = { rows: 2, columns: 3, letters: [...'ABCDEF'], initialWords: [{ ...records[0], path: [0,1,2,5,4,3] }] };
// Use a snake-aligned board for a consistent covering initial word.
board.letters = [...'ABCFED'];
const config = { rows: 2, columns: 3, disabledCells: [], initialForwardProbability: 50,
  targetDuplicateRange: 50, extraDuplicateRange: 0, filters: {}, fixedWords: ['ABCDEF'],
  fixedLayout: { rows: 2, columns: 3, placements: [{ word: 'ABCDEF', path: [0,1,2,5,4,3] }] } };

test('soft goal promotes the simplest eligible candidates and updates counts, extras and statistics', () => {
  const level = generator.selectTargets({ ...board, foundWords: generator.findWords(board), desiredTargetCount: 4 });
  assert.equal(level.targetWords.length, 4);
  assert.equal(level.targetWords[0].word, 'ABCDEF');
  const added = level.targetWords.slice(1);
  assert.ok(added.every(entry => !entry.onlyExtra));
  assert.ok(added.every((entry, index) => index === 0 || entry.pathAnalysis.assigned.difficultyScore >= added[index-1].pathAnalysis.assigned.difficultyScore));
  assert.equal(level.targetCount, 4);
  assert.equal(level.statistics.workload.targetCount, 4);
  const counts = Array(6).fill(0);
  for (const word of level.targetWords) {
    assert.ok(!level.extraWords.some(extra => extra.word === word.word));
    word.path.forEach(cell => counts[cell]++);
  }
  assert.deepEqual(level.cells.map(cell => cell.count), counts);
  assert.ok(createGameExport([{ level }]));
});

test('a shortage never forces retries and a small goal never removes initial targets', async () => {
  let retries = 0;
  const level = await generateUntilComplete(generator, { ...config, desiredTargetCount: 100 }, { onProgress() { retries++; } });
  assert.ok(level.targetCount < 100);
  assert.equal(retries, 0);
  const original = generator.generate(config);
  const small = generator.generate({ ...config, desiredTargetCount: 1 });
  assert.deepEqual(small.targetWords, original.targetWords);
  assert.deepEqual(generator.generate({ ...config, desiredTargetCount: 0 }).targetWords, original.targetWords);
});

test('automatic promotion respects filters, recent targets, future fixed words and minimum length', () => {
  const duplicateCheck = createDuplicateCheck([{ id: 1, level: { targetWords: [{ word: 'ABC' }], extraWords: [] } }], { target: 50, extra: 0 });
  const result = generator.generate({ ...config, desiredTargetCount: 100, duplicateCheck, reservedTargetWords: ['DEF'], minimumWordLength: 3, filters: { scope: [1], rarityLevel: [1] } });
  assert.ok(!result.targetWords.some(entry => ['ABC', 'DEF', 'FEDCBA'].includes(entry.word)));
  assert.deepEqual(findDuplicateWords(result, duplicateCheck).target, []);
  assert.ok(result.candidateWords.some(entry => entry.word === 'ABC'), 'recent words remain available as ordinary candidates');
  assert.ok(result.targetWords.every(entry => entry.word.length >= 3));
  const filtered = createGenerator([...records, { word: 'AB', scope: 2, emotion: 1, rarityLevel: 5 }]);
  const level = filtered.generate({ ...config, desiredTargetCount: 100, filters: { scope: [1] } });
  assert.ok(!level.targetWords.some(entry => entry.word === 'AB'));
});

test('the optional quantity validates independently of the retired targetCount field', () => {
  const old = { ...config, targetCount: -1 };
  assert.equal(validateLevelConfig(old), old);
  const goal = { ...config, desiredTargetCount: 5 };
  assert.equal(validateLevelConfig(goal), goal);
  assert.equal(generator.generate(goal).desiredTargetCount, 5);
});

test('a large soft goal keeps cell usage within the game export limit', () => {
  const letters = [...'ABCDEFGHI'], words = new Set(['ABCFIHGDE']);
  function visit(path) {
    if (path.length >= 3) words.add(path.map(cell => letters[cell]).join(''));
    if (path.length === 5) return;
    for (let cell = 0; cell < 9; cell++) {
      const last = path.at(-1);
      if (!path.includes(cell) && (last === undefined || Math.abs(Math.floor(last/3)-Math.floor(cell/3)) + Math.abs(last%3-cell%3) === 1)) visit([...path, cell]);
    }
  }
  visit([]);
  const many = createGenerator([...words].map(word => ({ word })));
  const level = many.generate({ rows: 3, columns: 3, desiredTargetCount: 10000, fixedWords: ['ABCFIHGDE'],
    fixedLayout: { rows: 3, columns: 3, placements: [{ word: 'ABCFIHGDE', path: [0,1,2,5,8,7,6,3,4] }] } });
  assert.ok(level.targetCount < level.candidateWords.length);
  assert.equal(Math.max(...level.cells.map(cell => cell.count)), 35);
  assert.ok(createGameExport([{ level }]));
});

test('XLSX quantity roundtrips; blank and zero disable promotion; old seven/eight-column files still load', () => {
  for (const value of [0, 6, '', 1000]) {
    const book = XLSX.read(configXlsxTemplate(), { type: 'array' });
    const sheet = book.Sheets[book.SheetNames[0]];
    sheet.I2 = { t: typeof value === 'number' ? 'n' : 's', v: value };
    const file = XLSX.write(book, { type: 'array', bookType: 'xlsx' });
    const parsed = parseConfigXlsx(file, config);
    assert.equal(parsed[0].config.desiredTargetCount, value === '' ? 0 : value);
    assert.equal(parseConfigXlsx(serializeConfigXlsx(parsed), config)[0].config.desiredTargetCount, value === '' ? 0 : value);
  }
  for (const columns of [7, 8]) {
    const book = XLSX.read(configXlsxTemplate(), { type: 'array' });
    const sheet = book.Sheets[book.SheetNames[0]];
    delete sheet.I1; delete sheet.I2;
    if (columns === 7) { delete sheet.H1; delete sheet.H2; }
    sheet['!ref'] = `A1:${columns === 7 ? 'G' : 'H'}2`;
    assert.equal(parseConfigXlsx(XLSX.write(book, { type: 'array', bookType: 'xlsx' }), config)[0].config.desiredTargetCount, 0);
  }
  for (const value of [-1, 1.5, 'bad', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateLevelConfig({ ...config, desiredTargetCount: value }), /目标数量/);
    assert.throws(() => generator.generate({ ...config, desiredTargetCount: value }), /目标数量/);
  }
  assert.equal(patchLevelConfigs([{ id: 'one', config }], ['one'], { desiredTargetCount: 8 })[0].config.desiredTargetCount, 8);
});
