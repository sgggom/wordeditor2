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

test('turning target limits off ignores count and per-word length quotas while retaining shaped fixed words', () => {
  const generator = createGenerator(dictionary);
  const options = shape();
  const before = structuredClone(options);
  const level = generator.generate(options);
  assert.equal(level.targetLimitsEnabled, false);
  assert.deepEqual(level.targetWords.map(entry => entry.word), ['CAT', 'DOG']);
  assert.deepEqual(level.targetWords, level.initialWords);
  assert.equal(level.targetLengthCounts, null);
  assert.deepEqual(level.targetLengthPlan, ['long'], 'Keep the configured plan for re-enabling later');
  assert.equal(level.targetCount, 1);
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
  assert.throws(() => generator.generate({ ...options, targetLimitsEnabled: true }), /固定单词数量/);
});

test('automatic filling can use more initial words than the disabled target count', () => {
  const level = createGenerator(dictionary).generate({ ...shape(), fixedWords: [], fixedLayout: null, random: () => 0.5 });
  assert.ok(level.initialWords.length > level.targetCount);
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

test('post-selection keeps explicit fixed words and rejects ambiguous candidate paths', () => {
  const fixed = createGenerator(dictionary).generate(shape());
  assert.throws(() => setTargetWord(fixed, 'CAT', false), /固定单词/);
  const generator = createGenerator(['CATOTO', 'CAT', 'COT', 'TOT'].map(word => ({ word })));
  const board = { rows: 2, columns: 3, letters: [...'CATOTO'], initialWords: [{ word: 'CATOTO', path: [0, 1, 2, 5, 4, 3] }] };
  const level = generator.selectTargets({ ...board, foundWords: generator.findWords(board), targetCount: 100, targetLimitsEnabled: false });
  assert.equal(level.candidateWords.some(entry => entry.word === 'CAT'), false);
  level.candidateWords.push(level.extraWords.find(entry => entry.word === 'CAT'));
  assert.throws(() => setTargetWord(level, 'CAT', true), /不同格子/);
});

test('disabling target count and quota does not bypass word lengths, filters, duplicate checks or fixed-board safety', () => {
  const generator = createGenerator(dictionary);
  assert.throws(() => generator.generate({ ...shape(), initialMaxWordLength: 2 }), /初始词最长/);
  assert.throws(() => generator.generate({ ...shape(), maxWordLength: 2 }), /最长单词/);
  assert.throws(() => generator.generate({ ...shape(), filters: { scope: [2] } }), /词库筛选/);
  const duplicates = createDuplicateCheck([{ id: 1, level: { targetWords: [{ word: 'CAT' }], extraWords: [] } }], { target: 1, extra: 0 });
  assert.throws(() => generator.generate({ ...shape(), duplicateCheck: duplicates }), /重复/);
  for (const targetLimitsEnabled of [null, 0, 'false']) assert.throws(() => generator.generate({ ...shape(), targetLimitsEnabled }), /开关/);
});

test('configuration storage and bulk edits preserve the switch and the previous quantity and length settings', () => {
  const config = shape(); assert.equal(validateLevelConfig(config), config);
  const values = new Map(); const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const records = [{ id: 'one', config }, { id: 'two', config: { ...config, fixedWords: [], fixedLayout: null } }];
  saveConfigList(records, storage);
  assert.deepEqual(readConfigList(storage), records);
  assert.throws(() => patchLevelConfigs(records, ['one'], { targetLimitsEnabled: true }), /固定单词数量/);
  const enabled = patchLevelConfigs(records, ['two'], { targetLimitsEnabled: true });
  assert.equal(enabled[0].config.targetLimitsEnabled, false);
  assert.equal(enabled[1].config.targetLimitsEnabled, true);
  assert.deepEqual(enabled[1].config.targetLengthPlan, ['long']);
  assert.throws(() => validateLevelConfig({ ...config, targetLimitsEnabled: 'false' }), /开关/);
});

test('batch disabling preserves each row\'s own count and length plan for later re-enabling', () => {
  const a = { ...shape(), targetCount: 2, targetLengthPlan: ['short', 'short'], targetLimitsEnabled: true };
  const b = { ...shape(), targetCount: 50, targetLengthPlan: Array(50).fill('long'), targetLimitsEnabled: false };
  const records = [{ id: 'a', config: a }, { id: 'b', config: b }];
  const updated = patchLevelConfigs(records, ['a', 'b'], { targetLimitsEnabled: false });
  assert.equal(updated[0].config.targetCount, 2);
  assert.deepEqual(updated[0].config.targetLengthPlan, ['short', 'short']);
  assert.equal(updated[1].config.targetCount, 50);
  assert.deepEqual(updated[1].config.targetLengthPlan, Array(50).fill('long'));
});
