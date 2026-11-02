import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGenerator } from '../dist/level-generator.js';
import { createDuplicateCheck, findDuplicateWords, prepareGeneration } from '../dist/level-rules.js';
import { defaultGenerationConfig } from '../dist/level-config.js';
import { createBatchRunner } from '../dist/batch-runner.js';
import { analyzeTargetPaths } from '../dist/target-path-analysis.js';
import { createGameExport } from '../dist/level-export.js';

const read = async file => JSON.parse(await readFile(new URL(`../dist/data/${file}`, import.meta.url)));
const real = createGenerator([...await read('required-words.json'), ...await read('guide-words.json')], await read('extra-words.json'));
const randomFrom = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

test('historical longest words are excluded before placement while valid shorter targets still generate', () => {
  const duplicateCheck = createDuplicateCheck([{ id: 1, level: { targetWords: [{ word: 'FROLIC' }], extraWords: [] } }], { target: 20, extra: 0 });
  for (let seed = 1; seed <= 8; seed++) {
    const level = real.generate({ rows: 2, columns: 3, minimumWordLength: 3,
      filters: { scope: [4], emotion: [2], rarityLevel: [4] }, duplicateCheck, random: randomFrom(seed) });
    assert.deepEqual(new Set(level.targetWords.map(entry => entry.word)), new Set(['AWED', 'AAH']));
    assert.deepEqual(findDuplicateWords(level, duplicateCheck), { target: [], extra: [] });
    assert.ok(analyzeTargetPaths(level).allChoicesComplete);
  }
});

test('fixed-word search backtracks to a harder ATOM placement so MAP can fit', () => {
  const config = { rows: 2, columns: 3, disabledCells: [5], fixedWords: ['ATOM', 'MAP'], minimumWordLength: 3 };
  const before = structuredClone(config);
  for (let seed = 1; seed <= 8; seed++) {
    const level = real.generate({ ...config, random: randomFrom(seed) });
    assert.deepEqual(level.disabledCells, [5]);
    assert.deepEqual(new Set(level.targetWords.map(entry => entry.word)), new Set(config.fixedWords));
    assert.ok(level.targetWords.find(entry => entry.word === 'ATOM').pathAnalysis.assigned.difficultyScore > 2);
    assert.ok(analyzeTargetPaths(level).allChoicesComplete);
    assert.ok(createGameExport([{ level }]));
  }
  assert.deepEqual(config, before);
});

test('automatic filling can abandon a longer dead end and cover the board with shorter words', () => {
  const generator = createGenerator(['ABCDE', 'FGH', 'IJK'].map(word => ({ word })));
  for (let seed = 1; seed <= 8; seed++) {
    const level = generator.generate({ rows: 2, columns: 3, random: randomFrom(seed) });
    assert.deepEqual(new Set(level.targetWords.map(entry => entry.word)), new Set(['FGH', 'IJK']));
    assert.ok(level.cells.every(cell => cell.count === 1));
  }
});

test('fresh real-vocabulary generations cannot accept the STOP/RAT deadlock, including optional targets', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const level = real.generate({ rows: 2, columns: 4, fixedWords: ['STOP', 'RAT'], minimumWordLength: 3,
      desiredTargetCount: 8, random: randomFrom(seed) });
    assert.ok(analyzeTargetPaths(level).allChoicesComplete, `seed ${seed}`);
    assert.ok(['STOP', 'RAT'].every(word => level.targetWords.some(entry => entry.word === word)));
  }
});

test('ATE/LATER rejects deadlocked partial placements before searching fillers', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const level = real.generate({ rows: 3, columns: 4, fixedWords: ['ATE', 'LATER'], minimumWordLength: 3,
      filters: { scope: [1, 2, 3, 4], emotion: [-2, -1, 0, 1, 2], rarityLevel: [1, 2, 3, 4] },
      desiredTargetCount: 14, random: randomFrom(seed) });
    assert.ok(analyzeTargetPaths(level).allChoicesComplete, `seed ${seed}`);
    assert.ok(['ATE', 'LATER'].every(word => level.targetWords.some(entry => entry.word === word)));
    assert.ok(createGameExport([{ level }]));
  }
});

test('unsafe optional targets stay extra without forcing retries or changing fixed paths', () => {
  const generator = createGenerator(['CATOTO', 'CAT', 'COT', 'TOT'].map(word => ({ word })));
  const fixedLayout = { rows: 2, columns: 3, placements: [{ word: 'CATOTO', path: [0, 1, 2, 5, 4, 3] }] };
  const level = generator.generate({ rows: 2, columns: 3, fixedWords: ['CATOTO'], fixedLayout, desiredTargetCount: 4 });
  assert.equal(level.targetWords.length, 3);
  assert.ok(!level.targetWords.some(entry => entry.word === 'CAT'));
  assert.ok(level.extraWords.some(entry => entry.word === 'CAT'));
  assert.ok(level.candidateWords.some(entry => entry.word === 'CAT'));
  assert.deepEqual(level.fixedLayout, fixedLayout);
  assert.ok(analyzeTargetPaths(level).allChoicesComplete);
});

test('different-cell paths remain allowed when every legal choice completes', () => {
  const generator = createGenerator(['AB', 'BA'].map(word => ({ word })));
  const level = generator.generate({ rows: 2, columns: 2, fixedWords: ['AB', 'BA'],
    fixedLayout: { rows: 2, columns: 2, placements: [{ word: 'AB', path: [0, 1] }, { word: 'BA', path: [3, 2] }] } });
  assert.ok(level.targetWords.every(entry => !entry.pathAnalysis.safe));
  assert.ok(analyzeTargetPaths(level).allChoicesComplete);
});

const configRows = () => Array.from({ length: 100 }, (_, index) => ({ id: `config-${index + 1}`, listId: 'test', position: index + 1,
  config: { ...defaultGenerationConfig(), rows: 2, columns: 3, extraDuplicateRange: 0, fixedWords: index === 99 ? ['PLANET'] : [] } }));
const sourceFor = row => ({ listId: row.listId, id: row.id, configId: row.id, position: row.position });

test('separate sparse runs reserve future fixed words using actual saved distances', async () => {
  const configs = configRows(), saved = [];
  const generator = createGenerator(['PLANET', 'CAT', 'DOG'].map(word => ({ word })));
  const runner = createBatchRunner({ getHistory: async () => saved,
    generate: async (config, duplicateCheck) => generator.generate({ ...config, duplicateCheck, random: randomFrom(12) }),
    save: async level => { const record = { id: saved.length + 1, level }; saved.push(record); return record; } });
  assert.equal((await runner.run([configs[0]], configs)).phase, 'complete');
  assert.ok(!saved[0].level.targetWords.some(entry => entry.word === 'PLANET'));
  assert.equal((await runner.run([configs[99]], configs)).phase, 'complete');
  assert.ok(saved[1].level.targetWords.some(entry => entry.word === 'PLANET'));
  assert.deepEqual(saved.map(record => record.level.sourceConfig.position), [1, 100]);
});

test('single and batch preparation count queued or saved levels, not missing config rows', () => {
  const configs = configRows(), first = configs[0];
  const prepare = (records, planned = []) => prepareGeneration(records, null, first.config, sourceFor(first), configs, planned);
  assert.deepEqual(prepare([]).config.reservedTargetWords, ['PLANET']);
  assert.deepEqual(prepare([], [configs[99]]).config.reservedTargetWords, ['PLANET']);
  assert.deepEqual(prepare([], configs.slice(1)).config.reservedTargetWords, []);
  const saved = configs.slice(0, 22).map((row, index) => ({ id: index + 1,
    level: { sourceConfig: sourceFor(row), targetWords: [], extraWords: [] } }));
  assert.deepEqual(prepare(saved).config.reservedTargetWords, []);
  const reversed = [{ ...saved[0], level: { ...saved[0].level, sourceConfig: sourceFor(configs[99]) } }, saved[0]];
  assert.deepEqual(prepare(reversed).config.reservedTargetWords, []);
  configs[99].config.fixedWordExemptions = ['PLANET'];
  assert.deepEqual(prepare([]).config.reservedTargetWords, []);
});
