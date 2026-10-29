import assert from 'node:assert/strict';
import test from 'node:test';
import { createGenerator } from '../dist/level-generator.js';
import { createPathSafetyChecker } from '../dist/path-safety.js';
import { setTargetWord, createDuplicateCheck } from '../dist/level-rules.js';
import { createGameExport } from '../dist/level-export.js';
import { validateLevelConfig, patchLevelConfigs, saveConfigList, readConfigList } from '../dist/level-config.js';

const dictionary = ['CAT', 'DOG', 'AT', 'DO'].map(word => ({ word, scope: 1, rarityLevel: 1, emotion: 1 }));
const shape = () => ({ rows: 3, columns: 3, disabledCells: [2, 5, 8], targetCount: 1,
  targetLengthPlan: ['long'], targetLimitsEnabled: false, initialMaxWordLength: 3, maxWordLength: 3,
  initialForwardProbability: 50, targetDuplicateRange: 0, extraDuplicateRange: 0, filters: { scope: [1] },
  fixedWords: ['CAT', 'DOG'], fixedLayout: { rows: 3, columns: 3, placements: [
    { word: 'CAT', path: [0, 3, 6] }, { word: 'DOG', path: [1, 4, 7] },
  ] } });

test('generation ignores all retired limits while preserving shaped fixed words', () => {
  const generator = createGenerator(dictionary);
  const options = shape();
  const before = structuredClone(options);
  const level = generator.generate(options);
  assert.equal(level.targetLimitsEnabled, false);
  assert.deepEqual(level.targetWords.map(entry => entry.word), ['CAT', 'DOG']);
  assert.deepEqual(level.targetWords, level.initialWords);
  for (const key of ['targetLengthPlan', 'targetLengthCounts', 'targetLengthRatios', 'initialMaxWordLength', 'maxWordLength']) {
    assert.equal(level[key], undefined);
  }
  assert.equal(level.targetCount, 2);
  assert.equal(level.statistics.workload.targetCount, 2);
  assert.equal(level.statistics.board.cellCount, 6);
  assert.deepEqual(level.disabledCells, [2, 5, 8]);
  assert.ok(level.candidateWords.some(entry => entry.word === 'AT'));
  assert.ok(level.extraWords.some(entry => entry.word === 'AT'));
  assert.ok(level.targetWords.every(entry => createPathSafetyChecker(level)(entry.word)));
  assert.equal(createGameExport([{ level }]).books[0].levels[0].g, 'CD-,AO-,TG-');
  assert.deepEqual(options, before);
  const many = generator.generate({ ...options, targetCount: 100, targetLengthPlan: Array(100).fill('long') });
  assert.equal(many.targetWords.length, 2);
  for (const value of [true, null, 0, 'false']) {
    assert.deepEqual(generator.generate({ ...options, targetLimitsEnabled: value, initialMaxWordLength: 1, maxWordLength: 1 }), level);
  }
});

test('automatic filling can exceed a legacy target count', () => {
  const level = createGenerator(dictionary).generate({ ...shape(), fixedWords: [], fixedLayout: null, random: () => 0.5 });
  assert.ok(level.initialWords.length > shape().targetCount);
  assert.equal(level.targetCount, level.initialWords.length);
  assert.deepEqual(level.targetWords, level.initialWords);
  assert.ok(level.cells.filter(cell => !cell.disabled).every(cell => cell.count > 0));
});

test('post-generation selection can replace an initial word only while every enabled cell stays covered', () => {
  const generator = createGenerator(['ABCFED', 'ABC', 'FED'].map(word => ({ word })));
  const level = generator.generate({ rows: 2, columns: 3, targetCount: 100, targetLimitsEnabled: false, random: () => 0 });
  assert.deepEqual(level.initialWords.map(entry => entry.word), ['ABCFED']);
  const partial = setTargetWord(level, 'ABC', true);
  assert.throws(() => setTargetWord(partial, 'ABCFED', false), /没有目标词覆盖/);
  const full = setTargetWord(partial, 'FED', true);
  const replaced = setTargetWord(full, 'ABCFED', false);
  assert.deepEqual(replaced.targetWords.map(entry => entry.word), ['ABC', 'FED']);
  assert.ok(replaced.cells.every(cell => cell.count === 1));
  assert.ok(replaced.extraWords.some(entry => entry.word === 'ABCFED'));
  assert.deepEqual(replaced.initialWords, level.initialWords);
  assert.equal(replaced.statistics.workload.targetCount, 2);
  assert.ok(createGameExport([{ level: replaced }]));
  assert.throws(() => setTargetWord(replaced, 'ABC', false), /没有目标词覆盖/);
  assert.deepEqual(level.targetWords.map(entry => entry.word), ['ABCFED']);
});

test('post-selection keeps explicit fixed words and permits ambiguous candidate paths', () => {
  const fixed = createGenerator(dictionary).generate(shape());
  assert.throws(() => setTargetWord(fixed, 'CAT', false), /固定单词/);
  const generator = createGenerator(['CATOTO', 'CAT', 'COT', 'TOT'].map(word => ({ word })));
  const board = { rows: 2, columns: 3, letters: [...'CATOTO'], initialWords: [{ word: 'CATOTO', path: [0, 1, 2, 5, 4, 3] }] };
  const level = generator.selectTargets({ ...board, foundWords: generator.findWords(board), targetCount: 100, targetLimitsEnabled: false });
  assert.equal(level.candidateWords.some(entry => entry.word === 'CAT'), true);
  const edited = setTargetWord(level, 'CAT', true);
  assert.equal(edited.targetWords.find(entry => entry.word === 'CAT').pathAnalysis.safe, false);
});

test('removing limits retains filters, duplicate checks and fixed-board safety', () => {
  const generator = createGenerator(dictionary);
  assert.throws(() => generator.generate({ ...shape(), filters: { scope: [2] } }), /词库筛选/);
  const duplicates = createDuplicateCheck([{ id: 1, level: { targetWords: [{ word: 'CAT' }], extraWords: [] } }], { target: 1, extra: 0 });
  assert.throws(() => generator.generate({ ...shape(), duplicateCheck: duplicates }), /重复/);
});

test('old saved quantity and length values do not block reading, editing or generation', () => {
  const config = { ...shape(), targetCount: 0, targetLengthPlan: ['invalid'], targetLengthRatios: {},
    initialMaxWordLength: 0, maxWordLength: 'invalid', targetLimitsEnabled: true };
  assert.equal(validateLevelConfig(config), config);
  const values = new Map(); const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const records = [{ id: 'one', config }, { id: 'two', config: { ...config, fixedWords: [], fixedLayout: null } }];
  saveConfigList(records, storage);
  assert.deepEqual(readConfigList(storage), records);
  const updated = patchLevelConfigs(readConfigList(storage), ['one'], { initialForwardProbability: 100 });
  const level = createGenerator(dictionary).generate(updated[0].config);
  assert.equal(level.initialForwardProbability, 100);
  assert.equal(level.targetCount, 2);
  assert.deepEqual(level.targetWords.map(entry => entry.word), ['CAT', 'DOG']);
});

test('unrestricted words can span a 5 by 5 board and every enabled cell of a shaped board', () => {
  for (const [rows, columns, disabledCells, word] of [
    [3, 4, [], 'ABCDEFGHIJKL'],
    [5, 5, [], 'ABCDEFGHIJKLMNOPQRSTUVWXY'],
    [5, 5, [4, 9, 14, 19, 24], 'ABCDEFGHIJKLMNOPQRST'],
  ]) {
    const generator = createGenerator([{ word }]);
    for (const targetCount of [0, -1, NaN, 10000, null]) {
      const options = { rows, columns, disabledCells, targetCount, targetLimitsEnabled: true,
        targetLengthPlan: ['short'], targetLengthRatios: { short: 100 }, initialMaxWordLength: 1, maxWordLength: 1,
        random: () => 0.5 };
      const level = generator.generate(options);
      assert.equal(level.targetCount, 1);
      assert.deepEqual(level.targetWords.map(entry => entry.word), [word]);
      assert.equal(level.initialWords[0].path.length, rows * columns - disabledCells.length);
      assert.equal(new Set(level.initialWords[0].path).size, word.length);
      assert.equal(level.initialWords[0].path.map(cell => level.cells[cell].letter).join(''), word);
      assert.ok(level.cells.every((cell, index) => disabledCells.includes(index) ? cell.count === 0 : cell.count === 1));
      assert.ok(createPathSafetyChecker(level)(word));
      assert.ok(createGameExport([{ level }]));
    }
  }
});

test('long candidates remain selectable with stale limits and only-extra words stay excluded', () => {
  const generator = createGenerator(['ABCDE', 'FGHIJ', 'ABCDEJIHGF'].map(word => ({ word })), [{ word: 'EDCBA' }]);
  const board = { rows: 2, columns: 5, letters: [...'ABCDEFGHIJ'], initialWords: [
    { word: 'ABCDE', path: [0, 1, 2, 3, 4] }, { word: 'FGHIJ', path: [5, 6, 7, 8, 9] },
  ] };
  const level = generator.selectTargets({ ...board, foundWords: generator.findWords(board),
    targetCount: 1, maxWordLength: 3, targetLengthPlan: ['short'], targetLimitsEnabled: true });
  assert.equal(level.candidateWords.find(entry => entry.word === 'ABCDEJIHGF').word.length, 10);
  const edited = setTargetWord(level, 'ABCDEJIHGF', true);
  assert.equal(edited.targetCount, 3);
  assert.ok(edited.cells.every(cell => cell.count === 2));
  assert.throws(() => setTargetWord(edited, 'EDCBA', true), /候选词/);
});
