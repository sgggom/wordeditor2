import test from 'node:test';
import assert from 'node:assert/strict';
import { palindromeDirectionVariants, BoardSearchIndex, IndexedQueryCursor, buildIntegerStageBudget, buildStageSearchBudget, capacityFor,
  stageBudgetPossible, boundsForCurrent, selectBudgetedTargets, stageRollbackBurden, matchStageCandidates, stageProgressDeviation, stageProgressDeltas, stageProgressBounds } from '../scripts/lib/constraint-trial-search.mjs';
import { createGameExport } from '../dist/level-export.js';

test('palindrome route alternatives preserve the exported board and leave other words unchanged', () => {
  const entry = { id: 'eye', metrics: { positive: 1 }, level: { rows: 2, columns: 4, disabledCells: [4, 5, 6, 7],
    cells: [...'EYES', '', '', '', ''].map((letter, index) => ({ letter, count: [1, 2, 2, 1, 0, 0, 0, 0][index] })),
    targetWords: [{ word: 'EYE', path: [2, 1, 0] }, { word: 'YES', path: [1, 2, 3] }], extraWords: [] } };
  const before = structuredClone(entry), game = createGameExport([{ level: entry.level }]);
  const variants = palindromeDirectionVariants(entry);
  assert.deepEqual(variants.map(row => row.metrics.positive).sort(), [1, 2]);
  for (const variant of variants) {
    assert.deepEqual(createGameExport([{ level: variant.level }]), game);
    assert.deepEqual(variant.level.targetWords[1].path, [1, 2, 3]);
  }
  assert.deepEqual(entry, before);
});

test('a frozen partial stage repays its quota over remaining words without changing the frozen levels', () => {
  const frozen = { words: 985, positive: 651, rare: 65 };
  const result = stageProgressDeviation({ ranges: { positive: { target: .75 }, rare: { target: .16 } },
    plannedWords: 4000, frozen, placed: { words: 0, positive: 0, rare: 0 },
    futureFixed: { words: 0, positive: 0, rare: 0 }, candidate: { words: 10, positive: 8, rare: 2 } });
  assert.ok(result < .4);
  assert.deepEqual(frozen, { words: 985, positive: 651, rare: 65 });
});

test('length and multi-turn progress also subtract frozen levels and future reservations', () => {
  const deltas = stageProgressDeltas({ ranges: { letters: { target: 3.9 }, twoPlus: { target: .35 } },
    plannedWords: 400, frozen: { words: 100, letters: 400, twoPlus: 40 },
    futureFixed: { words: 20, letters: 80, twoPlus: 7 }, placed: { words: 10, letters: 41, twoPlus: 4 },
    candidate: { words: 10, letters: 37, twoPlus: 2 } });
  assert.ok(Math.abs(deltas.letters - 6 / 7) < 1e-9);
  assert.ok(Math.abs(deltas.twoPlus + 9 / 14) < 1e-9);
});

test('progress limits prune multi-turn selections at the same integer boundary as final candidate review', () => {
  const settings = { ranges: { twoPlus: { target: .34, tolerance: .02 } }, plannedWords: 1000,
    frozen: { words: 100, twoPlus: 45 }, placed: { words: 600, twoPlus: 215 },
    futureFixed: { words: 0, twoPlus: 0 }, count: 10, positiveRareLimit: 4, toleranceShare: .98 };
  const bounds = stageProgressBounds(settings);
  assert.equal(bounds.twoPlus[1], 4);
  for (let twoPlus = 0; twoPlus <= 10; twoPlus++) {
    const delta = stageProgressDeltas({ ...settings, candidate: { words: 10, twoPlus } }).twoPlus;
    assert.equal(twoPlus >= bounds.twoPlus[0] && twoPlus <= bounds.twoPlus[1], Math.abs(delta) <= 19.6 + 1e-8);
  }
});

const stage = { id: 2, from: 11, to: 20, ranges: {
  positive: { minimum: 0.842457627118644, maximum: 0.852457627118644, target: 50 / 59 },
  rare: { minimum: 0.16449152542372883, maximum: 0.17449152542372884, target: 10 / 59 },
  letters: { minimum: 3.546271186440678, maximum: 3.8096610169491525, target: 3.6779661016949152 },
  turns: { minimum: 1.0108474576271187, maximum: 1.15864406779661, target: 1.0847457627118644 },
  longFive: { minimum: 0.05279661016949154, maximum: 0.18449152542372882, target: 0.11864406779661017 },
  straight: { minimum: 0.18338983050847457, maximum: 0.3928813559322034, target: 0.288135593220339 },
  twoPlus: { minimum: 0.268135593220339, maximum: 0.3420338983050848, target: 0.3050847457627118644 },
} };
const record = count => ({ mode: 'automatic', hard: { targetCount: { minimum: count, maximum: count },
  board: { options: [{ activeCells: 9 }] }, rareWordMaximumByTargetCount: [[count, 2]] } });
const records = [7, 5, 8, 5, 7, 5, 4, 6, 8, 4].map(record);
const budget = buildIntegerStageBudget(stage, records);

test('stage proportions become exact integer quotas for the actual word total', () => {
  assert.equal(budget.words, 59);
  assert.deepEqual(budget.ranges.positive, { minimum: 50, maximum: 50, target: 50 / 59 });
  assert.equal(budget.ranges.rare.minimum, 10);
  assert.equal(budget.ranges.rare.maximum, 10);
  assert.equal(budget.ranges.letters.maximum, 224);
  assert.equal(budget.ranges.twoPlus.minimum, 16);
  const manual = [...records]; manual[0] = { mode: 'manual' };
  assert.equal(buildIntegerStageBudget(stage, manual), null);
});

test('a remaining all-three-letter budget cannot supply two-turn words', () => {
  const totals = { words: 55, positive: 46, rare: 8, letters: 212, turns: 61, longFive: 5, straight: 11, twoPlus: 14 };
  const capacity = capacityFor([record(4)]);
  assert.equal(stageBudgetPossible(budget, totals, capacity), false);
  assert.equal(stageBudgetPossible(budget, { ...totals, letters: 210 }, capacity), true);
  const bounds = boundsForCurrent(budget, totals, capacityFor([]), 4, 2, 9);
  assert.deepEqual(bounds.positive, [4, 4]);
  assert.deepEqual(bounds.rare, [2, 2]);
  assert.deepEqual(bounds.letters, [12, 12]);
});

test('a flexible target count retains every legal stage denominator', () => {
  const flexibleRecords = structuredClone(records);
  flexibleRecords.at(-1).hard.targetCount = { minimum: 3, maximum: 5, preferred: 4 };
  flexibleRecords.at(-1).hard.rareWordMaximumByTargetCount = [[3, 2], [4, 2], [5, 2]];
  const flexible = buildStageSearchBudget(stage, flexibleRecords);
  assert.deepEqual(flexible.alternatives.map(option => option.words), [58, 59, 60]);
  const complete = { words: 60, positive: 51, rare: 10, letters: 222, turns: 66, longFive: 6, straight: 18, twoPlus: 18 };
  assert.equal(stageBudgetPossible(flexible, complete, capacityFor([])), true);
  assert.equal(stageBudgetPossible(budget, complete, capacityFor([])), false);
  assert.equal(stageBudgetPossible(flexible, { ...complete, positive: 49 }, capacityFor([])), false);
  const before = { words: 55, positive: 46, rare: 8, letters: 200, turns: 60, longFive: 5, straight: 15, twoPlus: 16 };
  const bound = boundsForCurrent(flexible, before, capacityFor([]), 5, 2, 9);
  assert.deepEqual(bound.positive, [5, 5]);
  assert.ok(bound.letters[0] <= bound.letters[1]);
});

test('rollback preserves levels that repair a stage deficit instead of penalizing their absolute deviation', () => {
  const ranges = { positive: { target: 0.8, tolerance: 0.005 }, rare: { target: 0.15, tolerance: 0.005 } };
  const totals = { words: 100, positive: 60, rare: 5 };
  const repairing = { words: 10, positive: 10, rare: 3 };
  const worsening = { words: 10, positive: 3, rare: 0 };
  assert.equal(stageRollbackBurden(repairing, totals, ranges), 0);
  assert.ok(stageRollbackBurden(worsening, totals, ranges) > 0);
  assert.ok(stageRollbackBurden(repairing, { words: 100, positive: 95, rare: 25 }, ranges) > 0);
});

test('inventory index uses full target capability instead of original target count', () => {
  const index = new BoardSearchIndex();
  const base = { id: 'expandable', originalTargets: ['CAT'] };
  const words = ['CAT', 'CAR', 'ARC', 'ART', 'RAT'];
  index.add(base, [{ grid: 'CAT,ARR' }], words);
  index.add({ id: 'wrong-mask' }, [{ grid: 'CAT-,ARRR' }], words);
  const query = index.query({ masks: ['111,111'], minimumCount: 4, preferredCount: 4,
    allowed: new Set(words), rarity: new Map(words.map(word => [word, 1])), rareMaximum: 1, used: new Set() });
  assert.deepEqual(query.bases.map(base => base.id), ['expandable']);
  const blocked = index.query({ masks: ['111,111'], minimumCount: 4, preferredCount: 4,
    allowed: new Set(words.slice(0, 3)), rarity: new Map(), rareMaximum: 1, used: new Set() });
  assert.equal(blocked.bases.length, 0);
});

test('an interrupted inventory slice preserves the unvisited tail without replaying the head', () => {
  const cursor = new IndexedQueryCursor();
  cursor.append(Array.from({ length: 5 }, (_, i) => ({ id: String(i) })));
  assert.deepEqual(cursor.take(2).map(base => base.id), ['0', '1']);
  assert.equal(cursor.exhausted, false);
  cursor.append([{ id: '1' }, { id: 'last-good-board' }]);
  assert.deepEqual(cursor.take(3).map(base => base.id), ['2', '3', '4']);
  assert.equal(cursor.exhausted, false);
  assert.deepEqual(cursor.take(2).map(base => base.id), ['last-good-board']);
  assert.equal(cursor.exhausted, true);
});

test('inventory ordering can reserve rare supply for a stage deficit', () => {
  const index = new BoardSearchIndex();
  index.add({ id: 'common' }, [{ grid: 'CAT,ARR' }], ['CAT', 'CAR', 'ARC', 'ART']);
  index.add({ id: 'rare' }, [{ grid: 'CAT,ARR' }], ['BAR', 'BAT', 'BAG', 'FAR']);
  const allowed = new Set(['CAT', 'CAR', 'ARC', 'ART', 'BAR', 'BAT', 'BAG', 'FAR']);
  const rarity = new Map([...allowed].map(word => [word, word === 'FAR' ? 3 : 1]));
  const settings = { masks: ['111,111'], minimumCount: 4, preferredCount: 4, allowed, rarity, rareMaximum: 2, used: new Set() };
  assert.equal(index.query({ ...settings, desiredRares: 1 }).bases[0].id, 'rare');
  assert.equal(index.query({ ...settings, desiredRares: 0 }).bases[0].id, 'common');
});

test('inventory prefers boards that can supply the reference length quota before count-only matches', () => {
  const index = new BoardSearchIndex();
  index.add({ id: 'count-match' }, [{ grid: 'CAT,ARR' }], ['CAT', 'CAR', 'ART', 'ARC']);
  index.add({ id: 'length-match' }, [{ grid: 'CAT,ARR' }], ['DOG', 'LOG', 'LOAD', 'CLOUD', 'CLOTH']);
  const words = ['CAT', 'CAR', 'ART', 'ARC', 'DOG', 'LOG', 'LOAD', 'CLOUD', 'CLOTH'];
  const query = { masks: ['111,111'], minimumCount: 4, preferredCount: 4, allowed: new Set(words),
    rarity: new Map(words.map(word => [word, 1])), rareMaximum: 0, used: new Set() };
  assert.equal(index.query(query).bases[0].id, 'count-match');
  assert.equal(index.query({ ...query, referenceLengths: [3, 3, 4, 5] }).bases[0].id, 'length-match');
});

const entries = [
  ['ABC', [0, 1, 2]], ['CBA', [2, 1, 0]], ['DEF', [3, 4, 5]], ['FED', [5, 4, 3]],
  ['ABE', [0, 1, 4]], ['BEF', [1, 4, 5]], ['CFE', [2, 5, 4]], ['EBA', [4, 1, 0]],
].map(([word, path]) => ({ word, path, rarityLevel: 1 }));
const bounds = { positive: [0, 4], rare: [0, 0], letters: [12, 12], turns: [0, 8], longFive: [0, 0], straight: [0, 4], twoPlus: [0, 4] };
const settings = { config: { rows: 2, columns: 3, disabledCells: [], desiredTargetCount: 4,
  generationRules: { targetWordLengths: [3, 3, 3, 3], lengthShares: [1, 0, 0], rarityShares: [1, 0, 0, 0], turnsPerWord: 1 } },
letters: [...'ABCDEF'], found: entries, eligible: new Set(entries.map(entry => entry.word)),
extraCap: 4, rareLimit: 0, forbiddenExtras: new Set(), bounds, withinBudget: () => true };

test('selection continues beyond twelve rejected sets until it finds a budget-qualified set', () => {
  let reviews = 0;
  const result = selectBudgetedTargets({ ...settings, acceptedLimit: 1, review: level => ({ qualified: ++reviews === 13 }) });
  assert.equal(reviews, 13);
  assert.equal(result.accepted, 1);
  assert.equal(result.approved.targetWords.length, 4);
  assert.equal(result.approved.extraWords.length, 4);
});

test('impossible metric bounds prune before expensive review', () => {
  let reviews = 0;
  const result = selectBudgetedTargets({ ...settings, bounds: { ...bounds, letters: [13, 13] }, review: () => { reviews++; return { qualified: true }; } });
  assert.equal(reviews, 0);
  assert.equal(result.accepted, 0);
  assert.ok(result.pruned > 0);
});

test('length matching tries exact quotas and permits only the configured small fallback', () => {
  const trial = { ...settings, config: { ...settings.config, generationRules: {
    ...settings.config.generationRules, targetWordLengths: [3, 3, 3, 4] } },
    lengthPolicy: { minimum: 3, maximum: 4, maximumLetterDistance: 0 }, review: () => ({ qualified: true }) };
  assert.equal(selectBudgetedTargets(trial).accepted, 0);
  assert.ok(selectBudgetedTargets({ ...trial, lengthPolicy: { ...trial.lengthPolicy, maximumLetterDistance: 1 } }).accepted > 0);
  assert.equal(selectBudgetedTargets({ ...trial, lengthPolicy: { ...trial.lengthPolicy, minimumLetterDistance: 2, maximumLetterDistance: 2 } }).accepted, 0);
  assert.equal(selectBudgetedTargets({ ...trial, lengthPolicy: { ...trial.lengthPolicy, maximumLetterDistance: 1 },
    bounds: { ...bounds, letters: [13, 13] } }).accepted, 0);
});

test('stage matching retains a compatible alternative when the greedy choice consumes a later required word', async () => {
  const makeEntry = (position, id, word, qualityScore = 0) => ({ position, id, boardId: id, shapeId: 9, qualityScore,
    level: { targetWords: [{ word }], extraWords: [] },
    metrics: { words: 1, positive: 1, rare: 0, letters: word.length, turns: 0, longFive: 0, straight: 1, twoPlus: 0, topVisible: false } });
  const prefix = [makeEntry(25, 'locked', 'LOCK')];
  const rows = [26, 27].map(position => ({ ...record(1), position,
    hard: { ...record(1).hard, targetCount: { minimum: 1, maximum: 1, preferred: 1 }, board: { selection: 'exact-mask', options: [{ activeCells: 9 }] } } }));
  const pools = new Map([[26, [makeEntry(26, 'greedy', 'CAT'), makeEntry(26, 'alternative', 'DOG', 1)]],
    [27, Array.from({ length: 40 }, (_, index) => makeEntry(27, 'required-' + index, 'CAT'))]]);
  const result = await matchStageCandidates({ prefix, records: rows, pools,
    stage: { from: 26, to: 27, ranges: { positive: { target: 1, tolerance: 0 } } }, budget: null,
    sequence: { topRowRuns: { maximumVisible: 3, maximumInvisible: 6, maximumAlternating: 6 } }, width: 1 });
  assert.equal(result.completed, true);
  assert.deepEqual(result.choices.map(entry => entry.id), ['alternative', 'required-0']);
  assert.equal(prefix.length, 1);
  assert.equal(prefix[0].id, 'locked');
});

test('stage matching expires frozen-prefix words at distance 51 while still rejecting distance 50', async () => {
  const makeEntry = (position, id, targetWords, extraWords = []) => ({ position, id, boardId: id, shapeId: 9,
    level: { targetWords: targetWords.map(word => ({ word })), extraWords: extraWords.map(word => ({ word })) },
    metrics: { words: 1, positive: 1, rare: 0, letters: 3, turns: 0, longFive: 0, straight: 1, twoPlus: 0, topVisible: false } });
  const prefix = [makeEntry(6, 'prefix', ['DOG'], ['CAT'])];
  for (const position of [56, 57]) {
    const row = { ...record(1), position, hard: { ...record(1).hard,
      targetCount: { minimum: 1, maximum: 1, preferred: 1 }, board: { selection: 'exact-mask', options: [{ activeCells: 9 }] } } };
    const result = await matchStageCandidates({ prefix, records: [row],
      pools: new Map([[position, [makeEntry(position, 'candidate', ['CAT'])]]]),
      stage: { from: position, to: position, ranges: {} }, budget: null,
      sequence: { cooldown: { target: 50, extra: 50 }, topRowRuns: { maximumVisible: 3, maximumInvisible: 6, maximumAlternating: 6 } } });
    assert.equal(result.completed, position === 57);
  }
});

test('stage matching budgets against actual remaining candidates before dropping a feasible prefix', async () => {
  const makeEntry = (position, id, positive, qualityScore = 0) => ({ position, id, boardId: id, shapeId: 9, qualityScore,
    level: { targetWords: [{ word: id }], extraWords: [] },
    metrics: { words: 1, positive, rare: 0, letters: 3, turns: 0, longFive: 0, straight: 1, twoPlus: 0, topVisible: false } });
  const rows = [21, 22].map(position => ({ ...record(1), position, hard: { ...record(1).hard,
    targetCount: { minimum: 1, maximum: 1, preferred: 1 }, board: { selection: 'exact-mask', options: [{ activeCells: 9 }] } } }));
  const targets = { positive: .5, rare: 0, letters: 3, turns: 0, longFive: 0, straight: 1, twoPlus: 0 };
  const stage = { id: 1, from: 21, to: 22, ranges: Object.fromEntries(Object.entries(targets).map(([field, target]) =>
    [field, { target, minimum: target, maximum: target, tolerance: 0 }])) };
  const result = await matchStageCandidates({ prefix: [], records: rows,
    pools: new Map([[21, [makeEntry(21, 'greedy', 1), makeEntry(21, 'feasible', 0, 10)]],
      [22, [makeEntry(22, 'forced', 1)]]]), stage, budget: buildStageSearchBudget(stage, rows),
    sequence: { cooldown: { target: 50, extra: 50 }, topRowRuns: { maximumVisible: 3, maximumInvisible: 6, maximumAlternating: 6 } }, width: 1 });
  assert.equal(result.completed, true);
  assert.deepEqual(result.choices.map(entry => entry.id), ['feasible', 'forced']);
});

test('future sparse-pool checks expire words selected earlier in a long stage at distance 51', async () => {
  const entry = (position, id) => ({ position, id, boardId: id, shapeId: 9,
    level: { targetWords: [{ word: 'CAT' }], extraWords: [] },
    metrics: { words: 1, positive: 1, rare: 0, letters: 3, turns: 0, longFive: 0, straight: 1, twoPlus: 0, topVisible: false } });
  for (const last of [71, 72]) {
    const rows = [21, last].map(position => ({ ...record(1), position, hard: { ...record(1).hard,
      targetCount: { minimum: 1, maximum: 1, preferred: 1 }, board: { selection: 'exact-mask', options: [{ activeCells: 9 }] } } }));
    const result = await matchStageCandidates({ prefix: [], records: rows,
      pools: new Map([[21, [entry(21, 'first')]], [last, [entry(last, 'last')]]]),
      stage: { from: 21, to: last, ranges: {} }, budget: null,
      sequence: { cooldown: { target: 50, extra: 50 }, topRowRuns: { maximumVisible: 3, maximumInvisible: 6, maximumAlternating: 6 } }, width: 1 });
    assert.equal(result.completed, last === 72);
  }
});
