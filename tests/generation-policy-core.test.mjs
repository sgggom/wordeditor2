import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerator, generateUntilComplete } from '../dist/level-generator.js';
import { placementQualityCost, scoreGenerationQuality } from '../dist/generation-quality.js';
import { analyzeTargetPaths } from '../dist/target-path-analysis.js';

const records = words => words.map(word => ({ word, rarityLevel: 1, emotion: 1 }));
const randomFrom = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

test('retries preserve random masks and cancellation without rectangle substitution', async () => {
  const options = { rows: 2, columns: 3, disabledCells: [5], randomBoardShape: true };
  const seen = [];
  const generator = { generate(config) {
    seen.push(structuredClone(config));
    const error = new Error('original mask has no placement');
    error.code = 'GENERATION_RETRY'; error.attempts = 80; throw error;
  } };
  assert.equal(await generateUntilComplete(generator, options, { isCurrent: () => seen.length < 3 }), null);
  assert.equal(seen.length, 3);
  assert.ok(seen.every(config => JSON.stringify(config) === JSON.stringify(options)));
});

test('fixed CAT/CATS pair is explicitly rejected', () => {
  const generator = createGenerator(records(['CAT', 'CATS', 'DOG']));
  assert.throws(() => generator.generate({ rows: 2, columns: 3, fixedWords: ['CAT', 'CATS'] }), /加 S/);
});

test('S variant stays extra when optional target augmentation runs', () => {
  const generator = createGenerator(records(['CAT', 'CATS', 'DOG']));
  const level = generator.generate({ rows: 2, columns: 4, disabledCells: [4], fixedWords: ['CATS', 'DOG'], desiredTargetCount: 8,
    fixedLayout: { rows: 2, columns: 4, placements: [{ word: 'CATS', path: [0, 1, 2, 3] }, { word: 'DOG', path: [5, 6, 7] }] } });
  assert.ok(level.targetWords.some(entry => entry.word === 'CATS'));
  assert.ok(!level.targetWords.some(entry => entry.word === 'CAT'));
  assert.ok(level.extraWords.some(entry => entry.word === 'CAT'));
  assert.ok(analyzeTargetPaths(level).allChoicesComplete);
});

test('whitelist restricts targets while ordinary dictionary extras retain their role', () => {
  const generator = createGenerator(records(['CATOTO', 'CAT', 'COT', 'TOT', 'OTOTAC']), records(['OTO', 'ATOTOC']), { targetWordWhitelist: ['CATOTO'] });
  const level = generator.generate({ rows: 2, columns: 3, fixedWords: ['CATOTO'], desiredTargetCount: 8,
    fixedLayout: { rows: 2, columns: 3, placements: [{ word: 'CATOTO', path: [0, 1, 2, 5, 4, 3] }] } });
  assert.deepEqual(level.targetWords.map(entry => entry.word), ['CATOTO']);
  assert.ok(level.extraWords.some(entry => entry.word === 'OTOTAC' && !entry.onlyExtra));
  assert.ok(level.extraWords.some(entry => entry.word === 'ATOTOC' && entry.onlyExtra));
  assert.ok(!level.extraWords.some(entry => entry.word === 'COT' || entry.word === 'OTO'));
  assert.ok(analyzeTargetPaths(level).allChoicesComplete);
});

test('natural placement score prefers a turned lower entrance over top horizontal answer', () => {
  const rules = { turnsPerWord: 1, reversalsPerWord: 0, targetWordLengths: [3] };
  assert.ok(placementQualityCost({ word: 'CAT', path: [4, 1, 2] }, 3, rules)
    < placementQualityCost({ word: 'CAT', path: [0, 1, 2] }, 3, rules));
});

test('quality reports actual count and proportion gaps without claiming exact match', () => {
  const generator = createGenerator(records(['CAT', 'DOG']));
  const level = generator.generate({ rows: 2, columns: 3, fixedWords: ['CAT', 'DOG'], random: randomFrom(1) });
  level.desiredTargetCount = 7;
  const quality = scoreGenerationQuality(level, { targetWordLengths: [4, 5], lengthShares: [0, 0.5, 0.5], rarityShares: [0, 0, 0, 1] });
  assert.equal(quality.targetCountDifference, -5);
  assert.equal(quality.lengthShareDifference, 2);
  assert.equal(quality.rarityShareDifference, 2);
  assert.equal(quality.softTargetsMatched, false);
});

test('initial automatic filling never selects a direct S pair', () => {
  const generator = createGenerator(records(['CAT', 'CATS', 'DOG', 'GOD', 'ACT', 'TAC']));
  for (let seed = 1; seed <= 8; seed++) {
    const level = generator.generate({ rows: 2, columns: 3, desiredTargetCount: 8, random: randomFrom(seed) });
    const names = new Set(level.targetWords.map(entry => entry.word));
    assert.ok([...names].every(word => !names.has(`${word}S`)));
    assert.ok(analyzeTargetPaths(level).allChoicesComplete);
  }
});

test('rule placement search actually changes initial routes toward turns', () => {
  const generator = createGenerator(records(['CAT', 'DOG', 'ACT', 'GOD']), [], { targetWordWhitelist: ['CAT', 'DOG', 'ACT', 'GOD'] });
  let oldTurns = 0, naturalTurns = 0;
  for (let seed = 1; seed <= 16; seed++) {
    const options = { rows: 2, columns: 3, letters: Array(6).fill(''), minimumWordLength: 3 };
    const old = generator.findPlacement({ ...options, random: randomFrom(seed) });
    const natural = generator.findPlacement({ ...options, random: randomFrom(seed), generationRules: {
      targetWordLengths: [3, 3], turnsPerWord: 1, reversalsPerWord: 0,
    } });
    const turns = entry => entry.path.slice(2).filter((cell, index) => cell - entry.path[index + 1] !== entry.path[index + 1] - entry.path[index]).length;
    oldTurns += turns(old); naturalTurns += turns(natural);
  }
  assert.equal(oldTurns, 0);
  assert.ok(naturalTurns >= 8, `natural ${naturalTurns}, old ${oldTurns}`);
});

test('a fixed board with a known legal-path deadlock cannot generate', () => {
  const generator = createGenerator(records(['CAT', 'COT', 'TOT']));
  assert.throws(() => generator.generate({ rows: 2, columns: 3, fixedWords: ['CAT', 'COT', 'TOT'],
    fixedLayout: { rows: 2, columns: 3, placements: [
      { word: 'CAT', path: [0, 1, 2] }, { word: 'COT', path: [0, 3, 4] }, { word: 'TOT', path: [2, 5, 4] },
    ] } }), /安全完成/);
});

test('real rule configuration generates bounded safe candidates and retains its policy', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = async file => JSON.parse(await readFile(new URL(`../dist/data/${file}`, import.meta.url)));
  const [required, guide, extra, whitelist, preset] = await Promise.all([
    read('required-words.json'), read('guide-words.json'), read('extra-words.json'), read('candidate-words.json'), read('current-rule-configs.json'),
  ]);
  const words = [...required, ...guide];
  const config = structuredClone(preset.records[1].config);
  config.generationRules.candidateSamples = 3;
  const whitelistWords = whitelist.words.map(([word]) => word);
  const generator = createGenerator(words, extra, { targetWordWhitelist: whitelistWords });
  const level = generator.generate({ ...config, random: randomFrom(17) });
  assert.deepEqual(level.generationRules, config.generationRules);
  assert.deepEqual(level.disabledCells, config.disabledCells);
  assert.ok(level.targetWords.every(entry => whitelistWords.includes(entry.word) && entry.word.length >= 3 && entry.rarityLevel <= 4));
  assert.ok(level.cells.every(cell => cell.disabled || cell.count >= 1 && cell.count <= 35));
  assert.ok(analyzeTargetPaths(level).allChoicesComplete);
  assert.ok(Number.isFinite(level.generationQuality.score));
  assert.equal(level.generationQuality.searchLimits.candidateSamples, 3);
  assert.throws(() => createGenerator(words, extra).generate(config), /白名单/);
  assert.throws(() => generator.generate({ ...config, disabledCells: [0] }), /禁用格/);
});

test('rule generation skips an excluded board and finds another valid candidate', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = async file => JSON.parse(await readFile(new URL(`../dist/data/${file}`, import.meta.url)));
  const [required, guide, extra, whitelist, preset] = await Promise.all([
    read('required-words.json'), read('guide-words.json'), read('extra-words.json'), read('candidate-words.json'), read('current-rule-configs.json'),
  ]);
  const generator = createGenerator([...required, ...guide], extra, { targetWordWhitelist: whitelist.words.map(([word]) => word) });
  const config = structuredClone(preset.records[1].config);
  config.generationRules.candidateSamples = 1;
  const boardFor = level => Array.from({ length: level.rows }, (_, row) => level.cells.slice(row * level.columns, (row + 1) * level.columns)
    .map(cell => cell.disabled ? '-' : cell.letter).join('')).join(',');
  const original = generator.generate({ ...config, random: randomFrom(17) });
  const originalBoard = boardFor(original);
  const replacement = generator.generate({ ...config, random: randomFrom(17), excludedBoards: [originalBoard] });
  assert.notEqual(boardFor(replacement), originalBoard);
  assert.deepEqual(replacement.disabledCells, config.disabledCells);
  assert.ok(analyzeTargetPaths(replacement).allChoicesComplete);
});

test('excluding the sole fixed rule board retries without returning the forbidden board', async () => {
  const { readFile } = await import('node:fs/promises');
  const preset = JSON.parse(await readFile(new URL('../dist/data/current-rule-configs.json', import.meta.url)));
  const config = preset.records[0].config;
  const generator = createGenerator(records(['CAT', 'ALL']), [], { targetWordWhitelist: ['CAT', 'ALL'] });
  assert.throws(() => generator.generate({ ...config, excludedBoards: ['CAT,-L-,-L-'] }), error => {
    assert.equal(error.code, 'GENERATION_RETRY');
    assert.equal(error.attempts, 80);
    assert.equal(error.bestLevel, undefined);
    assert.match(error.message, /棋盘.*重复/);
    return true;
  });
});

test('natural placement respects initial first-step probability independently of whole-path positivity', () => {
  const generator = createGenerator(records(['CAT', 'DOG', 'ACT', 'GOD']), [], { targetWordWhitelist: ['CAT', 'DOG', 'ACT', 'GOD'] });
  for (let seed = 1; seed <= 16; seed++) {
    for (const probability of [0, 100]) {
      const placement = generator.findPlacement({ rows: 3, columns: 3, letters: Array(9).fill(''), minimumWordLength: 3,
        initialForwardProbability: probability, random: randomFrom(seed), generationRules: {
          targetWordLengths: [3], turnsPerWord: 1, reversalsPerWord: 0,
          // Deliberately oppose the initial-step preference: this remains a
          // separate soft target evaluated over every step in the whole path.
          positiveWordShare: probability === 100 ? 0 : 1,
        } });
      assert.equal(placement.path[1] > placement.path[0], probability === 100, `seed ${seed}, probability ${probability}`);
    }
  }
});

test('natural first-step preference still allows an opposite route when preferred placements fail', () => {
  const generator = createGenerator(records(['CAT']), [], { targetWordWhitelist: ['CAT'] });
  const placement = generator.findPlacement({ rows: 3, columns: 3, letters: Array(9).fill(''), minimumWordLength: 3,
    initialForwardProbability: 100, random: randomFrom(17), generationRules: { targetWordLengths: [3], turnsPerWord: 1 },
  }, candidate => candidate.path[1] < candidate.path[0]);
  assert.ok(placement);
  assert.ok(placement.path[1] < placement.path[0]);
});
