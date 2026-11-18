import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildLevelConstraintPlan, checkLevelConstraint, checkConstraintSequence } from '../dist/level-constraints.js';
import { closestSpecialShapes } from '../dist/generation-policy.js';
import { createGenerator } from '../dist/level-generator.js';
import { importSingleGameLevel, gameLevelData, gameLevelLocations } from '../dist/level-import.js';

const read = name => JSON.parse(fs.readFileSync(new URL('../dist/data/' + name, import.meta.url), 'utf8'));
const configs = read('current-rule-configs.json').records;
const ordinary = [...read('required-words.json'), ...read('guide-words.json')];
const extra = read('extra-words.json');
const dictionaryRows = [...ordinary, ...extra.map(entry => ({ ...entry, onlyExtra: true }))];
const dictionary = new Map(dictionaryRows.map(entry => [entry.word, entry]));
const whitelist = new Map(read('candidate-words.json').words);
const generator = createGenerator(ordinary, extra, { targetWordWhitelist: [...whitelist.keys()] });
const sequencePolicy = { maxTopRun: 3, maxNoTopRun: 6, maxAlternatingRun: 6 };
function build() {
  return buildLevelConstraintPlan({ configs,
    shapePlan: configs.map(({ position, config }) => ({ position, shapeId: config.generationRules.shapeId,
      referencePosition: config.generationRules.referencePosition,
      referenceCells: config.generationRules.referenceCells,
      referenceRows: config.generationRules.referenceRows ?? config.rows,
      referenceColumns: config.generationRules.referenceColumns ?? config.columns })),
    limits: configs.map(() => ({ countError: 0, extraMaximum: 100, previousRareCount: 100, rareRate: 1 })),
    stages: [{ from: 1, to: 2000, limits: { positive: [0.5, 0.5] } }], sequence: sequencePolicy, sources: {} });
}
const plan = build();
const source = gameLevelData(gameLevelLocations(read('presets/our-levels-one-in-five-special-2000-2026-11-11.json'))[5].original);
const sample = importSingleGameLevel(JSON.stringify(source), dictionaryRows);
const foundWords = generator.findWords({ rows: sample.rows, columns: sample.columns,
  disabledCells: sample.disabledCells, letters: sample.cells.map(cell => cell.letter), minimumWordLength: 3 });
const context = { dictionary, whitelist, foundWords };
const sampleConstraint = structuredClone(plan.records[5]);
sampleConstraint.hard.targetCount.minimum = sample.targetWords.length;
sampleConstraint.hard.targetCount.maximum = sample.targetWords.length;
sampleConstraint.hard.rareWordMaximumByTargetCount = [[sample.targetWords.length, sample.targetWords.length]];

test('all positions remain numbered, with the first five excluded without frozen content', () => {
  assert.equal(plan.records.length, 2000);
  assert.equal(plan.scope.automaticPositions, 1995);
  assert.deepEqual(plan.scope.excludedPositions, [1, 2, 3, 4, 5]);
  for (const record of plan.records.slice(0, 5)) {
    assert.equal(record.mode, 'manual');
    assert.equal(record.hard, undefined);
    assert.equal(record.preferences, undefined);
  }
  assert.equal(plan.records[5].position, 6);
  assert.equal(plan.records[1500].reference.position, 1001);
  assert.equal(plan.records.at(-1).reference.position, 1500);
  assert.equal(plan.records.filter(record => record.mode === 'automatic' &&
    record.hard.board.selection === 'nearest-excluding-previous-special').length, 399);
  assert.deepEqual(plan.records[5].hard.requiredWords, []);
  assert.deepEqual(plan.records[5].hard.targetRarityLevels, [1, 2, 3, 4]);
  assert.deepEqual(plan.records[5].preferences.suggestedInitialWords, configs[5].config.fixedWords);
});

test('the small allowance of length-distance-three levels has a hard sequence-wide count limit', () => {
  const capped = structuredClone(plan);
  capped.wordLengthPolicy = { maximumLetterDistance: 2, exceptionEligiblePositions: [6, 7], maximumExceptions: 1 };
  for (const position of [6, 7]) capped.records[position - 1].preferences.targetWordLengths = [3];
  const entry = (position, word) => ({ position, game: { a: word }, shapeId: 9,
    level: { targetWords: [{ word }], extraWords: [] },
    metrics: { words: 1, positive: 1, rare: 0, letters: 6, turns: 0, longFive: 1, straight: 1, twoPlus: 0, topVisible: false } });
  assert.equal(checkConstraintSequence(capped, [entry(6, 'AAAAAA')]).violations.some(row => row.code === 'targetLengthExceptionCount'), false);
  const result = checkConstraintSequence(capped, [entry(6, 'AAAAAA'), entry(7, 'BBBBBB')]);
  assert.deepEqual(result.violations.filter(row => row.code === 'targetLengthExceptionCount').map(row => row.detail.positions), [[6, 7]]);
});

test('special constraints keep alternatives until the preceding actual shape is known', () => {
  const tenth = plan.records[9];
  assert.equal(tenth.hard.board.previousSpecialPosition, 5);
  for (const previous of [null, 12, 25, 28, 29, 33]) for (const shape of closestSpecialShapes(tenth.reference.cells, previous)) {
    assert.ok(tenth.hard.board.options.some(option => option.shapeId === shape.id));
  }
});

test('a valid candidate can miss a destination count while retaining its intrinsic eligibility', () => {
  const constraint = structuredClone(sampleConstraint);
  constraint.preferences.targetLengthCounts = [0, 0, 0, 0, 0, sample.targetWords.length];
  const valid = checkLevelConstraint(sample, constraint, context);
  assert.equal(valid.matchesPosition, true);
  assert.equal(valid.exactReferenceLengthCounts, false);
  constraint.hard.targetCount.minimum++;
  constraint.hard.targetCount.maximum++;
  const result = checkLevelConstraint(sample, constraint, context);
  assert.equal(result.intrinsicValid, true);
  assert.equal(result.matchesPosition, false);
  assert.deepEqual(result.violations.map(issue => issue.code), ['targetCount']);
});

test('omitting a legitimate extra cannot make a candidate pass an extra cap', () => {
  assert.ok(sample.extraWords.length > 0);
  const modified = structuredClone(sample);
  modified.extraWords.pop();
  const result = checkLevelConstraint(modified, sampleConstraint, context);
  assert.equal(result.intrinsicValid, false);
  assert.ok(result.violations.some(issue => issue.code === 'extraCompleteness'));
});

test('optional per-level length limits reject long words and excess quota deviations without discarding the board', () => {
  const constraint = structuredClone(sampleConstraint);
  const maximum = Math.max(...sample.targetWords.map(entry => entry.word.length));
  constraint.preferences.targetWordLengths = sample.targetWords.map(entry => entry.word.length);
  constraint.hard.targetWordLength = { minimum: 3, maximum, maximumLetterDistance: 0 };
  assert.equal(checkLevelConstraint(sample, constraint, context).matchesPosition, true);
  constraint.hard.targetWordLength.maximum = maximum - 1;
  const long = checkLevelConstraint(sample, constraint, context);
  assert.equal(long.intrinsicValid, true);
  assert.ok(long.violations.some(issue => issue.code === 'targetWordLength'));
  constraint.hard.targetWordLength.maximum = maximum;
  constraint.preferences.targetWordLengths = Array(sample.targetWords.length).fill(maximum + 1);
  assert.ok(checkLevelConstraint(sample, constraint, context).violations.some(issue => issue.code === 'targetLengthDistance'));
});

test('cell counts and the current dictionary remain mandatory regardless of destination', () => {
  const modified = structuredClone(sample);
  modified.cells[modified.targetWords[0].path[0]].count++;
  assert.ok(checkLevelConstraint(modified, sampleConstraint, context).violations.some(issue => issue.code === 'cellCounts'));
  const smaller = new Map(dictionary);
  smaller.delete(sample.targetWords[0].word);
  const result = checkLevelConstraint(sample, sampleConstraint, { ...context, dictionary: smaller });
  assert.equal(result.intrinsicValid, false);
  assert.ok(result.violations.some(issue => issue.code === 'targetDictionary'));
  assert.throws(() => checkLevelConstraint(sample, sampleConstraint, { dictionary, whitelist }), /完整搜词/);
});

test('per-level rarity eligibility is a hard destination constraint, separate from preference shares', () => {
  const constraint = structuredClone(sampleConstraint);
  const actual = dictionary.get(sample.targetWords[0].word).rarityLevel;
  constraint.hard.targetRarityLevels = [1, 2, 3, 4].filter(level => level !== actual);
  const result = checkLevelConstraint(sample, constraint, context);
  assert.equal(result.intrinsicValid, true);
  assert.equal(result.matchesPosition, false);
  assert.ok(result.violations.some(issue => issue.code === 'targetRarityLevel'));
  constraint.hard.targetRarityLevels = [1, 2, 3, 4];
  constraint.preferences.rarityShares = [0, 0, 0, 1];
  assert.equal(checkLevelConstraint(sample, constraint, context).matchesPosition, true);
});

test('a level-five target is prohibited even if preference shares and total rare counts would permit it', () => {
  const word = sample.targetWords[0].word;
  const changed = new Map(dictionary), bank = new Map(whitelist);
  changed.set(word, { ...changed.get(word), rarityLevel: 5 });
  bank.set(word, 5);
  const result = checkLevelConstraint(sample, sampleConstraint, { ...context, dictionary: changed, whitelist: bank });
  assert.equal(result.intrinsicValid, false);
  assert.ok(result.violations.some(issue => issue.code === 'targetDictionary' && issue.detail === word));
});

test('the combined three-and-four-level quota is hard even with permissive rarity shares', () => {
  const constraint = structuredClone(sampleConstraint);
  const changed = new Map(dictionary), bank = new Map(whitelist);
  sample.targetWords.slice(0, 2).forEach((entry, index) => {
    changed.set(entry.word, { ...changed.get(entry.word), rarityLevel: index + 3 });
    bank.set(entry.word, index + 3);
  });
  const withRareWords = { ...context, dictionary: changed, whitelist: bank };
  const measured = checkLevelConstraint(sample, constraint, withRareWords);
  assert.equal(measured.metrics.rare, 2);
  constraint.hard.rareWordMaximumByTargetCount = [[sample.targetWords.length, measured.metrics.rare - 1]];
  constraint.preferences.rarityShares = [0, 0, 0.5, 0.5];
  const result = checkLevelConstraint(sample, constraint, withRareWords);
  assert.equal(result.intrinsicValid, true);
  assert.equal(result.matchesPosition, false);
  assert.ok(result.violations.some(issue => issue.code === 'rareCount'));
});

function sequenceFixture(last = 60) {
  const fixture = { records: Array.from({ length: last }, (_, index) => ({ position: index + 1,
    mode: index < 5 ? 'manual' : 'automatic', hard: { board: { selection: 'exact-mask' } } })),
  common: { sequence: plan.common.sequence }, stages: [{ id: 1, from: 1, to: last, ranges: {} }] };
  const entries = fixture.records.slice(5).map(({ position }) => ({ position, game: { a: 'board-' + position },
    level: { targetWords: [{ word: 'WORD' + String.fromCharCode(65 + Math.floor(position / 26), 65 + position % 26) }], extraWords: [] },
    metrics: { words: 1, positive: 1, rare: 0, letters: 6, turns: 1, longFive: 1, straight: 0, twoPlus: 0,
      topVisible: position % 4 < 2 } }));
  return { fixture, entries };
}

test('manual history remains unknown: no compressed numbering or false complete-stage result', () => {
  const { fixture, entries } = sequenceFixture();
  const result = checkConstraintSequence(fixture, entries);
  assert.equal(result.knownChecksPassed, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.pending.unknownPositions, [1, 2, 3, 4, 5]);
  assert.deepEqual(result.pending.cooldownPositions, Array.from({ length: 50 }, (_, i) => i + 6));
  assert.equal(result.stages[0].status, 'pending');
  assert.throws(() => checkConstraintSequence(fixture, [...entries, entries[0]]), /重复/);
});

test('cross-type cooldown rejects distance 50 and permits distance 51', () => {
  for (const [position, blocked] of [[56, true], [57, false]]) {
    const { fixture, entries } = sequenceFixture();
    entries[0].level.extraWords.push({ word: 'MARK' });
    entries.find(entry => entry.position === position).level.targetWords = [{ word: 'MARK' }];
    const issues = checkConstraintSequence(fixture, entries).violations.filter(issue => issue.code === 'targetCooldown');
    assert.equal(issues.length, blocked ? 1 : 0);
    if (blocked) assert.deepEqual(issues[0].detail, { word: 'MARK', previousPosition: 6 });
  }
});

test('level 10 waits for manual level 5; later specials use the actual preceding special', () => {
  const { fixture, entries } = sequenceFixture(20);
  for (const position of [10, 15, 20]) {
    const record = fixture.records[position - 1];
    record.hard.board = { selection: 'nearest-excluding-previous-special', previousSpecialPosition: position - 5 };
    record.reference = { cells: 9 };
    entries.find(entry => entry.position === position).shapeId = position === 20 ? 25 : 12;
  }
  const result = checkConstraintSequence(fixture, entries);
  assert.deepEqual(result.pending.specialShapePositions, [10]);
  assert.deepEqual(result.violations.filter(issue => issue.code === 'specialShapeSelection').map(issue => issue.position), [15]);
});
