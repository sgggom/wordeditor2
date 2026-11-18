import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createGzip, createGunzip, gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createGenerator } from '../dist/level-generator.js';
import { createGameExport } from '../dist/level-export.js';
import { gameLevelLocations, gameLevelData, importSingleGameLevel } from '../dist/level-import.js';
import { selectExtraWords } from '../dist/level-rules.js';
import { describePath } from '../dist/level-statistics.js';
import { closestSpecialShapes } from '../dist/generation-policy.js';
import { checkLevelConstraint, checkConstraintSequence, measureConstraintLevel } from '../dist/level-constraints.js';
import { scoreGenerationQuality } from '../dist/generation-quality.js';
import { measureTargetLengthAlignment } from '../dist/target-length-alignment.js';
import { loadTrialGenerator, selectExactTargets, placementRank, seededRandom, gridText } from '../../outputs/20261110-repeat-window-refined-2000/verify-search.mjs';
import { searchLetterBoards } from '../../outputs/20261111-one-in-five-special-2000/local-search.mjs';
import { BoardSearchIndex, IndexedQueryCursor, buildStageSearchBudget, capacityFor, stageBudgetPossible,
  boundsForCurrent, emptyMetrics, addMetrics, selectBudgetedTargets, stageRollbackBurden, matchStageCandidates, stageProgressDeltas, stageProgressBounds } from './lib/constraint-trial-search.mjs';

const root = new URL('../../', import.meta.url);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
if (args.includes('--help')) {
  console.log('node scripts/run-constraint-trial.mjs [--out DIR] [--seed INTEGER] [--to POSITION] [--constraints JSON] [--inventory-from DIR] [--continue-from DIR] [--resume] [--rewind N] [--reserve-levels JSON] [--stage-match] [--stage-from N] [--stage-pools JSON] [--refresh-positions LIST] [--harvest-batches N] [--harvest-only] [--harvest-family-target N] [--minimum-target-length N] [--allow-existing-families] [--include-existing-distance]');
  process.exit(0);
}
const from = 6, to = Number(option('--to', '25')), seed = Number(option('--seed', '2026111119'));
assert.ok(Number.isSafeInteger(seed));
assert.ok(Number.isInteger(to) && to >= from && to <= 2000, '结束关号需为6～2000');
const continueFrom = option('--continue-from', null);
const searchMinimumTargetLength = Number(option('--minimum-target-length', '3'));
assert.ok(Number.isInteger(searchMinimumTargetLength) && searchMinimumTargetLength >= 3);
const harvestFamilyTarget = Number(option('--harvest-family-target', '0'));
assert.ok(Number.isInteger(harvestFamilyTarget) && harvestFamilyTarget >= 0);
const inventoryFrom = option('--inventory-from', null);
assert.ok(!(continueFrom && args.includes('--resume')), '--resume 与 --continue-from 不能同时使用');
assert.ok(!inventoryFrom || !continueFrom && !args.includes('--resume'), '--inventory-from 单独载入棋盘库，不与续跑同时使用');
const destination = path.resolve(option('--out', fileURLToPath(new URL('outputs/20261111-optimized-pool-trial-20/', root))));
assert.ok(args.includes('--resume') || !fs.existsSync(path.join(destination, 'progress.json')), '输出目录已有试跑，请使用新目录或 --resume。');
fs.mkdirSync(destination, { recursive: true });
const sourceHashes = {};
const read = relative => {
  const buffer = fs.readFileSync(new URL(relative, root));
  sourceHashes[relative] = createHash('sha256').update(buffer).digest('hex');
  return JSON.parse(buffer);
};
let defaultConstraints = 'outputs/20261112-reference-length-aligned/constraints.json';
// A new selection uses the aligned table. Existing checkpoints retain the
// exact table they were validated against unless explicitly overridden.
if (continueFrom || args.includes('--resume')) {
  const checkpointDirectory = continueFrom ? path.resolve(continueFrom) : destination;
  const checkpoint = JSON.parse(fs.readFileSync(path.join(checkpointDirectory, 'progress.json')));
  const constraintPaths = Object.keys(checkpoint.sourceHashes).filter(name => name.endsWith('/constraints.json'));
  assert.equal(constraintPaths.length, 1, '检查点必须记录唯一的约束配表');
  defaultConstraints = constraintPaths[0];
}
const plan = read(option('--constraints', defaultConstraints));
assert.deepEqual(plan.scope.excludedPositions, [1, 2, 3, 4, 5]);
const ordinary = [...read('level-editor/dist/data/required-words.json'), ...read('level-editor/dist/data/guide-words.json')];
const extra = read('level-editor/dist/data/extra-words.json');
const dictionaryRows = [...ordinary, ...extra.map(entry => ({ ...entry, onlyExtra: true }))];
const dictionary = new Map(dictionaryRows.map(entry => [entry.word, entry]));
const whitelist = new Map(read('level-editor/dist/data/candidate-words.json').words);
const excluded = read('level-editor/data/source/excluded-words.json');
assert.ok(excluded.words.every(word => !dictionary.has(word)));
const currentPack = read('level-editor/dist/data/presets/our-levels-one-in-five-special-2000-2026-11-11.json');
const currentGames = gameLevelLocations(currentPack).map(location => gameLevelData(location.original));
const sourceGenerator = createGenerator(ordinary, extra, { targetWordWhitelist: [...whitelist.keys()] });
const hooks = {}, makeGenerator = await loadTrialGenerator();
const generator = makeGenerator(ordinary, extra, { targetWordWhitelist: [...whitelist.keys()], trial: hooks });
const searchDictionary = new Set([...dictionary.keys()].filter(word => word.length >= 3));
const prefixes = new Set();
for (const word of searchDictionary) for (let n = 1; n <= word.length; n++) prefixes.add(word.slice(0, n));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
const fields = ['words', 'positive', 'rare', 'letters', 'turns', 'longFive', 'straight', 'twoPlus'];
const compareCandidates = (a, b) => (a.lengthAlignment?.letterDistance ?? 0) - (b.lengthAlignment?.letterDistance ?? 0) || a.score - b.score;
const cleanLevel = level => ({ rows: level.rows, columns: level.columns, disabledCells: [...level.disabledCells],
  cells: level.cells.map(({ letter, count }) => ({ letter, count })),
  targetWords: level.targetWords.map(({ word, path }) => ({ word, path: [...path] })),
  extraWords: level.extraWords.map(({ word, path }) => ({ word, path: [...path] })) });
const started = performance.now();
const bank = [], byFamily = new Map(), selected = [], events = [], failures = new Map(), bans = new Map();
const positionFailures = new Map();
const reservationFile = option('--reserve-levels', null);
const reservedLevels = new Map((reservationFile ? JSON.parse(fs.readFileSync(path.resolve(reservationFile))) : [])
  .map(entry => [entry.position, entry]));
const poolIndex = new BoardSearchIndex(), queryCache = new Map();
const rarity = new Map(dictionaryRows.map(entry => [entry.word, entry.rarityLevel]));
const integerBudgets = new Map(plan.stages.filter(stage => stage.from >= from && stage.to <= to).map(stage =>
  [stage.id, buildStageSearchBudget(stage, plan.records.slice(stage.from - 1, stage.to))]));
const stageWordTotals = new Map(plan.stages.map(stage => [stage.id,
  plan.records.slice(stage.from - 1, stage.to).reduce((sum, record) => sum + (record.hard?.targetCount?.preferred ?? 0), 0)]));
const searchPolicy = { revision: 3, initialInventory: continueFrom ? 'continued-library' : 'empty', indexedInventory: true,
  minimumTargetLengthForSearch: searchMinimumTargetLength,
  wordLengthPolicy: plan.wordLengthPolicy ?? null,
  selectionPreference: 'frozen-prefix-remainder-budget',
  stagePrefixSearchDeviationLimit: 3,
  stagePrefixSearchDeviationShare: 0.004,
  stageMetricSearchToleranceShare: 0.98,
  generationBatchLimit: 100, localSearchBatchLimit: 50, emptyBatchesBeforeBacktrack: 2,
  integerBudgets: [...integerBudgets.values()].filter(Boolean) };
const stats = { generationCalls: 0, completedBoards: 0, baseBoardsStored: 0, intrinsicRejected: 0,
  poolQueries: 0, boardsTriedForReuse: 0, targetSelectionsTried: 0, backtracks: 0, localSearches: 0,
  indexedCandidates: 0, coarseCandidates: 0, selectorNodes: 0, selectorSelectionsPruned: 0,
  generationBatches: 0, largestGenerationBatch: 0, earlyStageRejections: 0, poolSlicesContinued: 0 };
let priorElapsedMilliseconds = 0;
let lockedPrefixCount = 0, continuation = null;
let stopped = false, activeDeadline = 0, currentChoices = null;
let cachedFitKey = null, cachedFitSettings = null;
let harvesting = false;
const harvestAvoidWords = new Set();
let harvestMinimumLengthDistance = 0;
let selectionRevision = 0, savedLibraryBoards = -1;
const contextKeys = new Map(), frozenStageMetrics = new Map();
const harvestShapes = new Map();
process.once('SIGINT', () => { stopped = true; });

// All eight square/rectangle symmetries retain four-neighbour connectivity.
function variants(grid) {
  const source = grid.split(','), rows = source.length, columns = source[0].length;
  const result = [], seen = new Set();
  for (let rotation = 0; rotation < 4; rotation++) for (const mirror of [false, true]) {
    const outRows = rotation % 2 ? columns : rows, outColumns = rotation % 2 ? rows : columns;
    const letters = Array(rows * columns), mapping = [];
    for (let cell = 0; cell < rows * columns; cell++) {
      let r = Math.floor(cell / columns), c = cell % columns, nr, nc;
      if (rotation === 0) [nr, nc] = [r, c];
      if (rotation === 1) [nr, nc] = [c, rows - 1 - r];
      if (rotation === 2) [nr, nc] = [rows - 1 - r, columns - 1 - c];
      if (rotation === 3) [nr, nc] = [columns - 1 - c, r];
      if (mirror) nc = outColumns - 1 - nc;
      const mapped = nr * outColumns + nc;
      mapping[cell] = mapped;
      letters[mapped] = source[r][c];
    }
    const transformed = gridText(letters, outColumns);
    if (seen.has(transformed)) continue;
    seen.add(transformed);
    result.push({ grid: transformed, rows: outRows, columns: outColumns, mapping,
      label: ['原样', '旋转90度', '旋转180度', '旋转270度'][rotation] + (mirror ? '后左右翻转' : '') });
  }
  return result;
}
const family = grid => variants(grid).map(variant => variant.grid).sort()[0];
const existingFamilies = new Set(currentGames.map(game => family(game.a)));
function blockedWords(position) {
  return new Set([...selected.filter(entry => position - entry.position <= 50),
    ...[...reservedLevels.values()].filter(entry => entry.position !== position && Math.abs(position - entry.position) <= 50)].flatMap(entry =>
    [...entry.level.targetWords, ...entry.level.extraWords].map(({ word }) => word)).concat(harvesting ? [...harvestAvoidWords] : []));
}
function reservedFuture(record) {
  return [...reservedLevels.values()].filter(entry => entry.position > record.position &&
    plan.records[entry.position - 1].stageId === record.stageId);
}
function futureRecords(record, includeCurrent = false) {
  const stage = plan.stages.find(stage => stage.id === record.stageId);
  return plan.records.slice(record.position - Number(includeCurrent), stage.to)
    .filter(row => row.position === record.position || !reservedLevels.has(row.position));
}
function eligibleShapes(record) {
  if (harvesting && harvestShapes.has(record.position)) return harvestShapes.get(record.position);
  if (record.hard.board.selection === 'exact-mask') return record.hard.board.options;
  const prior = selected.find(entry => entry.position === record.hard.board.previousSpecialPosition) ??
    reservedLevels.get(record.hard.board.previousSpecialPosition);
  if (!prior) return record.hard.board.options;
  const allowed = new Set(closestSpecialShapes(record.reference.cells, prior.shapeId).map(shape => shape.id));
  return record.hard.board.options.filter(option => allowed.has(option.shapeId));
}
function phaseStatus(record, metrics) {
  const phase = plan.stages.find(stage => stage.id === record.stageId);
  const settings = fitSettings(record);
  const totals = addMetrics(harvesting ? emptyMetrics() : settings.stagePrefix, metrics);
  const fullStage = phase.from >= from && phase.to <= to;
  if (!harvesting && fullStage && !stageBudgetPossible(integerBudgets.get(phase.id), totals,
    settings.futureCapacity)) return Infinity;
  return Object.entries(phase.ranges).reduce((sum, [field, range]) => sum +
    Math.abs(totals[field] / totals.words - range.target) / Math.max(range.tolerance, 0.025) *
    (field === 'positive' || field === 'rare' ? 2 : 0.25), 0);
}
function sequenceAllowed(record, level, game, metrics) {
  if (selected.some(entry => entry.game.a === game.a)) return false;
  if ([...reservedLevels.values()].some(entry => entry.position !== record.position && entry.game.a === game.a)) return false;
  const blocked = blockedWords(record.position);
  if ([...level.targetWords, ...level.extraWords].some(entry => blocked.has(entry.word))) return false;
  if (harvesting) return true;
  const sequence = [...selected.map(entry => entry.metrics.topVisible), metrics.topVisible];
  let run = 1, alternating = 1;
  for (let i = sequence.length - 2; i >= 0 && sequence[i] === metrics.topVisible; i--) run++;
  for (let i = sequence.length - 2; i >= 0 && sequence[i] !== sequence[i + 1]; i--) alternating++;
  const policy = plan.common.sequence.topRowRuns;
  return run <= (metrics.topVisible ? policy.maximumVisible : policy.maximumInvisible) && alternating <= policy.maximumAlternating;
}
function contextKey(position) {
  const cached = contextKeys.get(position);
  if (cached?.revision === selectionRevision) return cached.key;
  const key = hash([position, selected.map(entry => entry.id)]);
  contextKeys.set(position, { revision: selectionRevision, key });
  return key;
}
function stageDeviationLimit(record) {
  return Math.max(searchPolicy.stagePrefixSearchDeviationLimit,
    stageWordTotals.get(record.stageId) * searchPolicy.stagePrefixSearchDeviationShare);
}
const intersectBounds = (bounds, extra) => extra ? Object.fromEntries(Object.entries(bounds).map(([field, range]) =>
  [field, [Math.max(range[0], extra[field][0]), Math.min(range[1], extra[field][1])]])) : bounds;
function rankLevel(level, record, base, orientation, found) {
  stats.targetSelectionsTried++;
  const metrics = measureConstraintLevel(level, dictionary);
  const game = createGameExport([{ level }]).level[0];
  if (!sequenceAllowed(record, level, game, metrics)) return null;
  const phaseCost = phaseStatus(record, metrics);
  if (!Number.isFinite(phaseCost)) { stats.earlyStageRejections++; return null; }
  const id = hash([game, level.targetWords.map(entry => [entry.word, entry.path]).sort((a, b) => a[0].localeCompare(b[0]))]);
  if (bans.get(contextKey(record.position))?.has(id)) return null;
  const result = checkLevelConstraint(level, record, { dictionary, whitelist, foundWords: found });
  if (!result.matchesPosition) return null;
  if (!fitSettings(record).shapes.some(shape => shape.shapeId === result.shapeId)) return null;
  const nextSpecial = record.position % 5 === 0 ? reservedLevels.get(record.position + 5) : null;
  if (nextSpecial && !closestSpecialShapes(plan.records[nextSpecial.position-1].reference.cells, result.shapeId)
    .some(shape => shape.id === nextSpecial.shapeId)) return null;
  if (Number.isInteger(plan.wordLengthPolicy?.maximumExceptions)) {
    const [begin, end] = plan.wordLengthPolicy.exceptionEligiblePositions;
    const isException = entry => entry.position >= begin && entry.position <= end &&
      measureTargetLengthAlignment(entry.level.targetWords, plan.records[entry.position-1].preferences.targetWordLengths).letterDistance > 2;
    const remainingReserved = [...reservedLevels.values()].filter(entry => entry.position > record.position);
    if ([...selected, ...remainingReserved, { position: record.position, level }].filter(isException).length > plan.wordLengthPolicy.maximumExceptions) return null;
  }
  const quality = scoreGenerationQuality({ ...level, desiredTargetCount: record.hard.targetCount.preferred,
    targetWords: level.targetWords.map(entry => ({ ...entry, rarityLevel: dictionary.get(entry.word).rarityLevel })) }, record.preferences);
  const shape = record.hard.board.options.find(shape => shape.shapeId === result.shapeId);
  const difference = Math.abs(shape.activeCells - record.reference.cells);
  const phase = plan.stages.find(stage => stage.id === record.stageId);
  const settings = fitSettings(record);
  const deltas = !harvesting && integerBudgets.has(phase.id) ? stageProgressDeltas({ ranges: phase.ranges,
    plannedWords: stageWordTotals.get(phase.id), frozen: settings.frozenMetrics, placed: settings.mutableMetrics,
    futureFixed: settings.futureMetrics, candidate: metrics }) : null;
  const stageDeviation = deltas ? Math.abs(deltas.positive) + Math.abs(deltas.rare) : 0;
  if (!harvesting && integerBudgets.has(phase.id) && stageDeviation > stageDeviationLimit(record)) return null;
  let metricDeviation = 0;
  if (deltas) for (const [field, range] of Object.entries(phase.ranges)) {
    if (field === 'positive' || field === 'rare') continue;
    const limit = Math.max(field === 'letters' || field === 'turns' ? 15 : 4,
      range.tolerance * stageWordTotals.get(phase.id) * searchPolicy.stageMetricSearchToleranceShare);
    if (Math.abs(deltas[field]) > limit) return null;
    metricDeviation += Math.abs(deltas[field]) / limit;
  }
  const lengthAlignment = record.hard.targetWordLength ? measureTargetLengthAlignment(level.targetWords, record.preferences.targetWordLengths) : null;
  const score = (lengthAlignment?.letterDistance ?? 0) * 100000 + stageDeviation * 100 + metricDeviation * 2000 + phaseCost * 3 + quality.score * 0.35 + level.extraWords.length * 0.08 + difference * 0.05;
  return { id, position: record.position, boardId: base.id, bornPosition: base.bornPosition, orientation,
    mode: base.bornPosition < record.position ? 'reuse' : 'new', level, game: result.game,
    metrics: result.metrics, shapeId: result.shapeId, score, stageDeviation, qualityScore: quality.score, lengthAlignment,
    originalTargets: base.originalTargets, targetChanges: {
      added: level.targetWords.filter(entry => !base.originalTargets.includes(entry.word)).map(entry => entry.word),
      removed: base.originalTargets.filter(word => !level.targetWords.some(entry => entry.word === word)) },
  };
}
function transformFound(base, variant) {
  return base.found.map(entry => {
    const path = entry.path.map(cell => variant.mapping[cell]);
    return { ...entry, path, pathAnalysis: { ...entry.pathAnalysis, assigned: describePath(path, variant.columns) } };
  });
}
function fitSettings(record) {
  const key = contextKey(record.position) + (harvesting ? ':harvest' : '');
  if (cachedFitKey === key) return cachedFitSettings;
  const shapes = eligibleShapes(record), blocked = blockedWords(record.position);
  const phase = plan.stages.find(stage => stage.id === record.stageId);
  const integerBudget = harvesting ? null : integerBudgets.get(phase.id) ?? null;
  const stagePrefix = [...selected.filter(entry => entry.position >= phase.from && entry.position <= phase.to), ...reservedFuture(record)]
    .reduce((total, entry) => addMetrics(total, entry.metrics), emptyMetrics());
  if (!frozenStageMetrics.has(phase.id)) frozenStageMetrics.set(phase.id,
    selected.slice(0, lockedPrefixCount).filter(entry => entry.position >= phase.from && entry.position <= phase.to)
      .reduce((total, entry) => addMetrics(total, entry.metrics), emptyMetrics()));
  const frozenMetrics = frozenStageMetrics.get(phase.id);
  const futureMetrics = reservedFuture(record).reduce((total, entry) => addMetrics(total, entry.metrics), emptyMetrics());
  const mutableMetrics = Object.fromEntries(fields.map(field => [field, stagePrefix[field] - frozenMetrics[field] - futureMetrics[field]]));
  const futureCapacity = capacityFor(integerBudget ? futureRecords(record) : []);
  const progressBounds = new Map();
  let maximumWordLength = Infinity, minimumPositive = 0, maximumPositive = Infinity, maximumRare = Infinity, progressPossible = true;
  if (integerBudget) {
    const options = [];
    for (let count = record.hard.targetCount.minimum; count <= record.hard.targetCount.maximum; count++) {
      const progress = stageProgressBounds({ ranges: phase.ranges, plannedWords: stageWordTotals.get(phase.id),
        frozen: frozenMetrics, placed: mutableMetrics, futureFixed: futureMetrics, count,
        positiveRareLimit: stageDeviationLimit(record), toleranceShare: searchPolicy.stageMetricSearchToleranceShare });
      progressBounds.set(count, progress);
      const bound = intersectBounds(boundsForCurrent(integerBudget, stagePrefix, futureCapacity, count,
        new Map(record.hard.rareWordMaximumByTargetCount).get(count), Math.max(...shapes.map(shape => shape.activeCells))), progress);
      if (Object.values(bound).every(([minimum, maximum]) => minimum <= maximum)) options.push({ count, bound });
    }
    if (options.length) {
      maximumWordLength = Math.max(...options.map(({ count, bound }) => bound.letters[1] - (count - 1) * 3));
      minimumPositive = Math.min(...options.map(({ bound }) => bound.positive[0]));
      maximumPositive = Math.max(...options.map(({ bound }) => bound.positive[1]));
      maximumRare = Math.max(...options.map(({ bound }) => bound.rare[1]));
    } else { maximumWordLength = 0; maximumRare = 0; progressPossible = false; }
  }
  maximumWordLength = Math.min(maximumWordLength, record.hard.targetWordLength?.maximum ?? Infinity);
  const allowed = new Set([...dictionary.values()].filter(entry => !entry.onlyExtra && whitelist.has(entry.word) &&
    entry.word.length >= searchMinimumTargetLength && entry.word.length <= maximumWordLength &&
    record.hard.targetRarityLevels.includes(entry.rarityLevel) && !blocked.has(entry.word) &&
    (maximumRare > 0 || entry.rarityLevel <= 2)).map(entry => entry.word));
  cachedFitKey = key;
  const budgetPossible = stageBudgetPossible(integerBudget, stagePrefix, capacityFor(integerBudget ? futureRecords(record, true) : []));
  return cachedFitSettings = { shapes, blocked, allowed, minimumPositive, maximumPositive, maximumRare, maximumWordLength,
    integerBudget, stagePrefix, futureCapacity, frozenMetrics, futureMetrics, mutableMetrics,
    targetBounds: new Map(), progressBounds,
    possible: progressPossible && budgetPossible, budgetPossible,
    masks: new Map(shapes.map(shape => [shape.boardMask.join(','), shape])) };
}
function fitBoard(base, record, withinBudget) {
  if (selected.some(entry => entry.boardId === base.id)) return;
  if ([...reservedLevels.values()].some(entry => entry.position !== record.position && entry.boardId === base.id)) return;
  const { masks, blocked, allowed, minimumPositive, maximumPositive, maximumRare } = fitSettings(record);
  if (base.recognizedWords && base.recognizedWords.filter(word => allowed.has(word)).length < record.hard.targetCount.minimum) return;
  if (!base.variants) base.variants = variants(base.grid);
  if (!base.variants.some(variant => masks.has(variant.grid.replace(/[A-Z]/g, '1').replaceAll('-', '0')))) return;
  if (!base.found) {
    const rows = base.grid.split(','), letters = [...rows.join('')].map(letter => letter === '-' ? '' : letter);
    base.found = sourceGenerator.findWords({ rows: rows.length, columns: rows[0].length,
      disabledCells: letters.flatMap((letter, cell) => letter ? [] : [cell]), letters, minimumWordLength: 3 });
  }
  for (const variant of base.variants) {
    if (!withinBudget()) return;
    const mask = variant.grid.replace(/[A-Z]/g, '1').replaceAll('-', '0');
    const shape = masks.get(mask);
    if (!shape) continue;
    const found = transformFound(base, variant);
    if (found.filter(entry => allowed.has(entry.word)).length < record.hard.targetCount.minimum) continue;
    const letters = [...variant.grid.replaceAll(',', '')].map(letter => letter === '-' ? '' : letter);
    const disabledCells = letters.flatMap((letter, cell) => letter ? [] : [cell]);
    const counts = [];
    for (let delta = 0; delta <= record.hard.targetCount.allowedError; delta++) {
      for (const count of delta ? [record.hard.targetCount.preferred - delta, record.hard.targetCount.preferred + delta] : [record.hard.targetCount.preferred]) {
        if (count >= record.hard.targetCount.minimum && count <= record.hard.targetCount.maximum) counts.push(count);
      }
    }
    for (const count of counts) {
      if (!withinBudget()) return;
      const config = { rows: variant.rows, columns: variant.columns, disabledCells, desiredTargetCount: count,
        generationRules: record.preferences };
      const eligible = new Set(found.filter(entry => allowed.has(entry.word) &&
        (minimumPositive < count || (() => { const start = entry.path[0], end = entry.path.at(-1);
          return end % variant.columns - start % variant.columns + Math.floor(end / variant.columns) - Math.floor(start / variant.columns) > 0; })()) &&
        (maximumPositive > 0 || (() => { const start = entry.path[0], end = entry.path.at(-1);
          return end % variant.columns - start % variant.columns + Math.floor(end / variant.columns) - Math.floor(start / variant.columns) <= 0; })())
      ).map(entry => entry.word));
      const settings = fitSettings(record), rareLimit = Math.min(maximumRare, new Map(record.hard.rareWordMaximumByTargetCount).get(count));
      const boundKey = count + ':' + rareLimit + ':' + shape.activeCells;
      if (!settings.targetBounds.has(boundKey)) settings.targetBounds.set(boundKey,
        intersectBounds(boundsForCurrent(settings.integerBudget, settings.stagePrefix, settings.futureCapacity, count, rareLimit, shape.activeCells),
          settings.progressBounds.get(count)));
      const bounds = settings.targetBounds.get(boundKey);
      const select = (targetBounds, lengthPolicy) => selectBudgetedTargets({ config, letters, found, eligible, extraCap: record.hard.extraCount.maximum,
        rareLimit, withinBudget, bounds: targetBounds, acceptedLimit: harvesting ? 3 : 12,
        lengthPolicy,
        partialPossible: (partial, needed) => {
          const capacity = { ...settings.futureCapacity };
          capacity.minimumWords += needed; capacity.maximumWords += needed;
          capacity.maximumLetters += needed * shape.activeCells;
          capacity.maximumTurns += needed * Math.max(0, shape.activeCells - 2);
          capacity.maximumRares += Math.min(needed, Math.max(0, rareLimit - partial.rare));
          capacity.maximumLongFive += shape.activeCells >= 5 ? needed : 0;
          capacity.maximumTwoPlus += shape.activeCells >= 4 ? needed : 0;
          return stageBudgetPossible(settings.integerBudget, addMetrics(settings.stagePrefix, partial), capacity);
        },
        forbiddenExtras: blocked, review: level => {
          const candidate = rankLevel(level, record, base, variant.label, found);
          if (candidate) currentChoices.set(candidate.id, candidate);
          return { qualified: Boolean(candidate) };
        } });
      const preference = stageSelectionPreference(record, count);
      const preferredBounds = preference ? { ...bounds,
        rare: [Math.max(bounds.rare[0], Math.min(bounds.rare[1], preference.rare)), Math.max(bounds.rare[0], Math.min(bounds.rare[1], preference.rare))],
        positive: [Math.max(bounds.positive[0], Math.min(bounds.positive[1], preference.positive)),
          Math.min(bounds.positive[1], Math.max(bounds.positive[0], preference.positive + 1))] } : bounds;
      const attempts = [];
      const lengthRules = harvesting && harvestMinimumLengthDistance > 0 ?
        [{ ...record.hard.targetWordLength, minimumLetterDistance: harvestMinimumLengthDistance }] : record.hard.targetWordLength ?
        Array.from({ length: record.hard.targetWordLength.maximumLetterDistance + 1 }, (_, maximumLetterDistance) =>
          ({ ...record.hard.targetWordLength, maximumLetterDistance })) : [undefined];
      for (const lengthPolicy of lengthRules) {
        const tier = harvesting ? Array.from({ length: rareLimit + 1 }, (_, count) =>
          select({ ...bounds, rare: [count, count] }, lengthPolicy)) : [select(preferredBounds, lengthPolicy)];
        if (!harvesting && preference && !tier.some(result => result.accepted)) tier.push(select(bounds, lengthPolicy));
        attempts.push(...tier);
        if (tier.some(result => result.accepted) && !(harvesting && record.hard.targetWordLength?.maximumLetterDistance > 2)) break;
      }
      for (const selection of attempts) {
        stats.selectorNodes += selection.nodes;
        stats.selectorSelectionsPruned += selection.pruned ?? 0;
      }
    }
  }
}
function stageSelectionPreference(record, count) {
  const settings = fitSettings(record);
  if (harvesting) {
    const stage = plan.stages.find(stage => stage.id === record.stageId);
    return { rare: Math.round(stage.ranges.rare.target * count), positive: Math.round(stage.ranges.positive.target * count) };
  }
  if (!settings.integerBudget) return null;
  const phase = plan.stages.find(stage => stage.id === record.stageId);
  const projected = settings.stagePrefix.words + count + futureRecords(record)
    .reduce((sum, row) => sum + row.hard.targetCount.preferred, 0);
  const options = (settings.integerBudget.alternatives ?? [settings.integerBudget])
    .filter(budget => budget.words - settings.stagePrefix.words - count >= settings.futureCapacity.minimumWords &&
      budget.words - settings.stagePrefix.words - count <= settings.futureCapacity.maximumWords)
    .sort((a, b) => Math.abs(a.words - projected) - Math.abs(b.words - projected));
  if (!options.length) return null;
  const budget = options[0], remaining = budget.words - settings.stagePrefix.words;
  return Object.fromEntries(['rare', 'positive'].map(field => [field, Math.round(
    Math.max(0, (budget.ranges[field].minimum + budget.ranges[field].maximum) / 2 - settings.stagePrefix[field]) * count / remaining)]));
}
function storeBoard(grid, found, coveringWords, record, origin) {
  const key = family(grid);
  const identifier = hash(key);
  if (existingFamilies.has(key)) return null;
  if (byFamily.has(identifier)) return byFamily.get(identifier);
  const rows = grid.split(','), columns = rows[0].length;
  const letters = [...rows.join('')].map(letter => letter === '-' ? '' : letter);
  const disabledCells = letters.flatMap((letter, cell) => letter ? [] : [cell]);
  const baseLevel = { rows: rows.length, columns, disabledCells,
    cells: letters.map(letter => ({ letter, count: 0 })), targetWords: coveringWords,
    extraWords: selectExtraWords(found, coveringWords) };
  for (const entry of coveringWords) for (const cell of entry.path) baseLevel.cells[cell].count++;
  const checked = checkLevelConstraint(baseLevel, record, { dictionary, whitelist, foundWords: found });
  if (!checked.intrinsicValid) { stats.intrinsicRejected++; return null; }
  const base = { id: identifier, bornPosition: record.position, grid, origin, found, variants: variants(grid),
    recognizedWords: found.map(entry => entry.word),
    originalTargets: coveringWords.map(entry => entry.word), originalGame: checked.game,
    initialMismatch: checked.violations.filter(issue => issue.kind === 'position').map(issue => issue.code) };
  bank.push(base); byFamily.set(identifier, base); stats.baseBoardsStored++;
  indexBoard(base);
  return base;
}
function indexBoard(base) {
  if (!base.variants) base.variants = variants(base.grid);
  const targets = base.recognizedWords.filter(word => whitelist.has(word) && !dictionary.get(word)?.onlyExtra &&
    [1, 2, 3, 4].includes(dictionary.get(word)?.rarityLevel));
  poolIndex.add(base, base.variants, targets);
}
function searchPool(record, milliseconds) {
  stats.poolQueries++;
  currentChoices = new Map();
  const settings = fitSettings(record), key = contextKey(record.position);
  if (!queryCache.has(key)) {
    queryCache.set(key, { cursor: new IndexedQueryCursor(), choices: new Map(), revision: -1 });
    if (queryCache.size > 16) queryCache.delete(queryCache.keys().next().value);
  }
  const state = queryCache.get(key);
  if (state.revision !== poolIndex.revision) {
    const query = poolIndex.query({ masks: settings.masks.keys(), minimumCount: record.hard.targetCount.minimum,
      preferredCount: record.hard.targetCount.preferred, allowed: settings.allowed, rarity,
      referenceLengths: record.hard.targetWordLength ? record.preferences.targetWordLengths : undefined,
      desiredRares: stageSelectionPreference(record, record.hard.targetCount.preferred)?.rare ?? 0,
      rareMaximum: Math.min(settings.maximumRare, Math.max(...record.hard.rareWordMaximumByTargetCount.map(pair => pair[1]))),
      used: new Set(selected.map(entry => entry.boardId)) });
    stats.indexedCandidates += query.indexed; stats.coarseCandidates += query.bases.length;
    state.cursor.append(query.bases); state.revision = poolIndex.revision;
  }
  for (const choice of state.choices.values()) if (!bans.get(key)?.has(choice.id)) currentChoices.set(choice.id, choice);
  const deadline = performance.now() + milliseconds;
  let inspected = 0;
  while (!state.cursor.exhausted && inspected < 80 &&
    new Set([...currentChoices.values()].map(choice => choice.boardId)).size < (record.hard.targetWordLength ? 12 : settings.integerBudget ? 6 : 1) &&
    performance.now() < deadline && !stopped) {
    const base = state.cursor.take(1)[0];
    stats.boardsTriedForReuse++;
    // A board is an atomic query unit; the deadline never drops an unvisited tail.
    fitBoard(base, record, () => !stopped);
    inspected++;
  }
  for (const choice of currentChoices.values()) state.choices.set(choice.id, choice);
  if (!state.cursor.exhausted && !currentChoices.size) stats.poolSlicesContinued++;
  searchPool.exhausted = state.cursor.exhausted;
  return [...currentChoices.values()].sort(compareCandidates);
}
function generateBoards(record, milliseconds, retry) {
  const deadline = performance.now() + milliseconds;
  currentChoices = new Map();
  const random = seededRandom(seed + record.position * 8191 + retry * 65537 + parseInt(contextKey(record.position).slice(0, 8), 16));
  const blocked = blockedWords(record.position);
  const { allowed: eligible, maximumWordLength } = fitSettings(record);
  const initialBoards = stats.baseBoardsStored;
  let calls = 0, completed = 0;
  stats.generationBatches++;
  while (performance.now() < deadline && completed < searchPolicy.generationBatchLimit && calls < 24 && !stopped) {
    calls++; stats.generationCalls++;
    const shapes = eligibleShapes(record);
    const shape = shapes[(calls - 1) % shapes.length];
    const disabledCells = shape.boardMask.join('').split('').flatMap((bit, cell) => bit === '0' ? [cell] : []);
    activeDeadline = Math.min(deadline, performance.now() + 180);
    hooks.withinBudget = () => performance.now() < activeDeadline && completed < searchPolicy.generationBatchLimit && !stopped;
    hooks.placementPenalty = placementRank({ dictionary: searchDictionary, prefixes, requiredLengths: new Set(), eligible,
      nearTargets: blocked, nearExtras: blocked, count: record.hard.targetCount.preferred,
      extraCap: record.hard.extraCount.maximum, withinBudget: hooks.withinBudget, forbiddenExtras: blocked });
    hooks.observeBoard = () => { stats.completedBoards++; completed++; return hooks.withinBudget(); };
    hooks.selectExactTargets = (filled, found) => {
      const grid = gridText(filled.letters, shape.columns);
      const base = storeBoard(grid, found, filled.initialWords, record, 'fresh placement');
      if (!base) return null;
      fitBoard(base, record, hooks.withinBudget);
      return [...currentChoices.values()].sort(compareCandidates)[0]?.level ?? null;
    };
    try {
      generator.generate({ rows: shape.rows, columns: shape.columns, disabledCells, minimumWordLength: 3,
        desiredTargetCount: record.hard.targetCount.preferred, filters: { rarityLevel: record.hard.targetRarityLevels },
        fixedWords: [], fixedLayout: null, generationRules: null,
        reservedTargetWords: [...whitelist.keys()].filter(word => word.length < searchMinimumTargetLength || word.length > maximumWordLength),
        duplicateCheck: { target: { range: 50, words: [...blocked], levelIds: selected.map(entry => entry.position) },
          extra: { range: 0, words: [], levelIds: [] } },
        initialForwardProbability: [85, 70, 55, 95][calls % 4], random });
    } catch (error) {
      if (error.code !== 'GENERATION_RETRY' && !error.message.includes('没有可安全完成的摆法')) throw error;
    }
    if (currentChoices.size >= 12 && stats.baseBoardsStored - initialBoards >= 3) break;
  }
  stats.largestGenerationBatch = Math.max(stats.largestGenerationBatch, stats.baseBoardsStored - initialBoards);
  return [...currentChoices.values()].sort(compareCandidates);
}
function localSearch(record, milliseconds, retry) {
  stats.localSearches++;
  const deadline = performance.now() + milliseconds;
  currentChoices = new Map();
  const random = seededRandom(seed + record.position * 65537 + retry * 16381 + parseInt(contextKey(record.position).slice(0, 8), 16));
  const blocked = blockedWords(record.position);
  const { allowed: eligible, maximumRare } = fitSettings(record);
  let reviewed = 0;
  const initialBoards = stats.baseBoardsStored;
  for (const shape of eligibleShapes(record)) {
    if (performance.now() >= deadline) break;
    const disabledCells = shape.boardMask.join('').split('').flatMap((bit, cell) => bit === '0' ? [cell] : []);
    const alphabet = 'EEEEAAAARRRIIOONNSSTTLLDDUCMHGPBYFW';
    const randomGrid = () => shape.boardMask.map(row => [...row].map(bit => bit === '0' ? '-' : alphabet[Math.floor(random() * alphabet.length)]).join('')).join(',');
    const targetMask = shape.boardMask.join(',');
    const seeds = [...bank.filter(base => base.grid.replace(/[A-Z]/g, '1').replaceAll('-', '0') === targetMask).slice(-20).map(base => base.grid)];
    const current = currentGames[record.position - 1].a;
    if (current.replace(/[A-Z]/g, '1').replaceAll('-', '0') === targetMask) seeds.push(current);
    seeds.push(...Array.from({ length: 5 }, randomGrid));
    searchLetterBoards({ rows: shape.rows, columns: shape.columns, disabledCells, seeds,
      targetCounts: [record.hard.targetCount.preferred], extraCap: record.hard.extraCount.maximum,
      rareLimit: count => Math.min(maximumRare, new Map(record.hard.rareWordMaximumByTargetCount).get(count)),
      dictionary: searchDictionary, prefixes, eligible,
      rareWords: new Set([...eligible].filter(word => dictionary.get(word).rarityLevel >= 3)),
      forbiddenExtras: blocked, random, withinBudget: () => performance.now() < deadline && reviewed < searchPolicy.localSearchBatchLimit && !stopped,
      review: grid => {
        reviewed++;
        if (existingFamilies.has(family(grid))) return;
        const letters = [...grid.replaceAll(',', '')].map(letter => letter === '-' ? '' : letter);
        const found = sourceGenerator.findWords({ rows: shape.rows, columns: shape.columns, disabledCells, letters, minimumWordLength: 3 });
        selectExactTargets({ config: { rows: shape.rows, columns: shape.columns, disabledCells,
          desiredTargetCount: record.hard.targetCount.preferred, generationRules: record.preferences },
        letters, found, eligible, fixed: new Set(), nearTargets: new Set(), nearExtras: new Set(),
        extraCap: record.hard.extraCount.maximum,
        rareLimit: new Map(record.hard.rareWordMaximumByTargetCount).get(record.hard.targetCount.preferred),
        forbiddenExtras: blocked, withinBudget: () => performance.now() < deadline && !stopped,
        review: level => {
          const base = storeBoard(grid, found, level.targetWords, record, 'local letter search');
          if (base) fitBoard(base, record, () => performance.now() < deadline && !stopped);
          return { qualified: Boolean(currentChoices.size) };
        } });
      } });
  }
  stats.largestGenerationBatch = Math.max(stats.largestGenerationBatch, stats.baseBoardsStored - initialBoards);
  return [...currentChoices.values()].sort(compareCandidates);
}
function write(name, data) {
  const temporary = path.join(destination, name + '.tmp');
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(temporary, path.join(destination, name));
}
function save(final = false) {
  const selectedPositions = new Map(selected.map(entry => [entry.boardId, entry.position]));
  write('progress.json', { from, to, seed, completed: selected.length, elapsedMilliseconds: Math.round(performance.now() - started),
    totalElapsedMilliseconds: priorElapsedMilliseconds + Math.round(performance.now() - started),
    stats, searchPolicy, lockedPrefixCount, continuation, reservedLevels: [...reservedLevels.values()],
    selected: selected.map(({ level, ...entry }) => ({ ...entry, level: cleanLevel(level) })), events, sourceHashes,
    failures: [...failures], positionFailures: [...positionFailures], bans: [...bans].map(([key, values]) => [key, [...values]]) });
  if (final || savedLibraryBoards !== bank.length) write('library.json', { schemaVersion: 1, unit: 'board-with-full-current-dictionary-search', sourceHashes,
    boards: bank.map(base => ({ id: base.id, grid: base.grid, bornPosition: base.bornPosition, origin: base.origin,
      originalTargets: base.originalTargets, originalGame: base.originalGame, initialMismatch: base.initialMismatch,
      recognizedWords: base.recognizedWords ?? base.found.map(entry => entry.word),
      selectedAt: selectedPositions.get(base.id) ?? null })) });
  savedLibraryBoards = bank.length;
}

if (inventoryFrom) {
  const directory = path.resolve(inventoryFrom);
  assert.notEqual(directory, destination, '棋盘库来源应与输出目录分开');
  const plain = path.join(directory, 'library.json');
  const library = JSON.parse(fs.existsSync(plain) ? fs.readFileSync(plain) : gunzipSync(fs.readFileSync(plain + '.gz')));
  for (const [name, digest] of Object.entries(sourceHashes)) if (name.startsWith('level-editor/')) {
    assert.equal(library.sourceHashes[name], digest, '棋盘库词库或参考输入已变化：' + name);
  }
  for (const stored of library.boards) {
    const base = { ...stored, variants: null, found: null };
    bank.push(base); byFamily.set(base.id, base); indexBoard(base);
  }
  searchPolicy.initialInventory = 'existing-library-new-selection';
  searchPolicy.wordLengthPolicy = plan.wordLengthPolicy ?? null;
  searchPolicy.warmInventory = { directory, boards: bank.length };
  console.log(JSON.stringify({ inventoryLoaded: bank.length, directory }));
}

if (args.includes('--resume') || continueFrom) {
  const sourceDirectory = continueFrom ? path.resolve(continueFrom) : destination;
  assert.ok(!continueFrom || sourceDirectory !== destination, '续跑应使用独立输出目录');
  const prior = JSON.parse(fs.readFileSync(path.join(sourceDirectory, 'progress.json')));
  if (args.includes('--resume') && !reservationFile) for (const entry of prior.reservedLevels ?? []) reservedLevels.set(entry.position, entry);
  const plainLibrary = path.join(sourceDirectory, 'library.json');
  const library = JSON.parse(fs.existsSync(plainLibrary) ? fs.readFileSync(plainLibrary) :
    gunzipSync(fs.readFileSync(plainLibrary + '.gz')));
  assert.deepEqual(prior.sourceHashes, sourceHashes, '续跑输入已变化');
  assert.ok(continueFrom ? [2, 3].includes(prior.searchPolicy?.revision) : prior.searchPolicy?.revision === searchPolicy.revision,
    '搜索版本不兼容');
  assert.deepEqual(library.sourceHashes, sourceHashes);
  selected.push(...prior.selected);
  selectionRevision++;
  events.push(...prior.events);
  Object.assign(stats, prior.stats);
  if (args.includes('--resume')) {
    searchPolicy.initialInventory = prior.searchPolicy.initialInventory;
    if (prior.searchPolicy.stageMatching) searchPolicy.stageMatching = prior.searchPolicy.stageMatching;
    if (prior.searchPolicy.stageRepairs) searchPolicy.stageRepairs = prior.searchPolicy.stageRepairs;
  }
  for (const key of ['indexedCandidates', 'coarseCandidates', 'selectorNodes', 'selectorSelectionsPruned', 'generationBatches',
    'largestGenerationBatch', 'earlyStageRejections', 'poolSlicesContinued']) stats[key] ??= 0;
  priorElapsedMilliseconds = prior.totalElapsedMilliseconds ?? prior.elapsedMilliseconds ?? 0;
  for (const [position, count] of prior.failures ?? []) failures.set(position, count);
  if (args.includes('--resume')) for (const [position, count] of prior.positionFailures ?? []) positionFailures.set(position, count);
  for (const [key, values] of prior.bans ?? []) bans.set(key, new Set(values));
  for (const stored of library.boards) {
    const base = { ...stored, variants: null, found: null };
    bank.push(base); byFamily.set(base.id, base); indexBoard(base);
  }
  lockedPrefixCount = continueFrom ? selected.length : prior.lockedPrefixCount ?? 0;
  continuation = continueFrom ? { fromDirectory: sourceDirectory, previousTo: prior.to, frozenThrough: selected.at(-1)?.position,
    inheritedBoards: bank.length, inheritedStats: { ...stats }, inheritedElapsedMilliseconds: priorElapsedMilliseconds,
    prefixGames: selected.map(entry => entry.game) } : prior.continuation ?? null;
  assert.ok(selected.length <= to - from + 1, '结束关号早于已完成范围');
  assert.ok(!continueFrom || selected.at(-1)?.position === prior.to, '前序范围尚未完成');
  const depth = Number(option('--rewind', '0'));
  for (let i = 0; i < depth && selected.length > lockedPrefixCount; i++) {
    const previous = selected.pop(); selectionRevision++;
    const key = contextKey(previous.position);
    if (!bans.has(key)) bans.set(key, new Set());
    bans.get(key).add(previous.id);
    stats.backtracks++;
  }
  console.log(JSON.stringify({ resumed: selected.length, libraryBoards: bank.length, rewind: depth }));
}

searchPolicy.reservedPositions = [...reservedLevels.keys()];

if (args.includes('--stage-match')) {
  assert.ok(lockedPrefixCount && continuation, '--stage-match 需要已有的锁定前序范围');
  const discarded = selected.splice(lockedPrefixCount);
  selectionRevision++;
  const stageFrom = Number(option('--stage-from', String(from + lockedPrefixCount)));
  assert.ok(stageFrom === from + lockedPrefixCount || args.includes('--harvest-only'), '跳过中间位置只用于候选收集');
  const records = plan.records.slice(stageFrom - 1, to);
  const stage = plan.stages.find(stage => stage.id === records[0].stageId);
  assert.ok(records.every(record => record.stageId === stage.id) && to === stage.to, '阶段组合需运行到当前阶段末尾');
  let previousShapes = stageFrom === from + lockedPrefixCount ?
    new Set([selected.filter(entry => entry.position % 5 === 0).at(-1)?.shapeId ?? null]) :
    new Set([null, ...plan.common.sequence.specialShapes.allowedIds]);
  for (const record of records) if (record.hard.board.selection !== 'exact-mask') {
    const possible = new Set([...previousShapes].flatMap(previous => closestSpecialShapes(record.reference.cells, previous).map(shape => shape.id)));
    const options = record.hard.board.options.filter(option => possible.has(option.shapeId));
    harvestShapes.set(record.position, options); previousShapes = new Set(options.map(option => option.shapeId));
  }
  harvesting = true;
  const pools = new Map();
  const cachedFile = option('--stage-pools', null);
  const refresh = new Set(option('--refresh-positions', '').split(',').filter(Boolean).map(Number));
  const harvestBatches = Number(option('--harvest-batches', '3'));
  assert.ok(Number.isInteger(harvestBatches) && harvestBatches > 0 && harvestBatches <= 100);
  const cached = cachedFile ? JSON.parse(fs.readFileSync(path.resolve(cachedFile))) : null;
  if (cached) {
    assert.equal(cached.stage, stage.id, '候选缓存阶段不一致');
    const checkpoint = JSON.parse(fs.readFileSync(path.join(path.dirname(path.resolve(cachedFile)), 'progress.json')));
    assert.deepEqual(checkpoint.sourceHashes, sourceHashes, '候选缓存输入已变化');
    assert.deepEqual(checkpoint.selected.slice(0, lockedPrefixCount).map(entry => entry.game), selected.map(entry => entry.game), '候选缓存的前序关卡不同');
    assert.ok([...refresh].every(position => records.some(record => record.position === position)), '刷新关号超出阶段');
    const plain = path.join(path.dirname(path.resolve(cachedFile)), 'library.json');
    const cachedInventory = JSON.parse(fs.existsSync(plain) ? fs.readFileSync(plain) : gunzipSync(fs.readFileSync(plain + '.gz')));
    assert.deepEqual(cachedInventory.sourceHashes, sourceHashes, '候选缓存词库已变化');
    let imported = 0;
    for (const stored of cachedInventory.boards) if (!byFamily.has(stored.id)) {
      const base = { ...stored, variants: null, found: null };
      bank.push(base); byFamily.set(base.id, base); indexBoard(base); imported++;
    }
    searchPolicy.cachedInventoryAdded = imported;
  }
  for (const record of records) {
    if (cached && !refresh.has(record.position)) {
      const entries = cached.pools.find(row => row.position === record.position)?.entries;
      assert.ok(entries?.length, '候选缓存缺少关卡' + record.position);
      pools.set(record.position, entries);
      console.log(JSON.stringify({ stageCandidates: record.position, cached: true, candidates: entries.length }));
      continue;
    }
    harvestAvoidWords.clear();
    harvestMinimumLengthDistance = cached && refresh.has(record.position) && !args.includes('--include-existing-distance') && record.hard.targetWordLength?.maximumLetterDistance > 2 ? 3 : 0;
    if (cached && refresh.has(record.position) && !args.includes('--allow-existing-families')) {
      const previous = cached.pools.find(row => row.position === record.position)?.entries ?? [];
      const names = entry => [...entry.level.targetWords, ...entry.level.extraWords].map(row => row.word);
      let remaining = [...new Set(previous.map(entry => names(entry).sort().join(' ')))].map(row => row.split(' '));
      while (remaining.length && harvestAvoidWords.size < 8) {
        const frequency = new Map();
        for (const words of remaining) for (const word of words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
        const avoid = [...frequency].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))[0][0];
        harvestAvoidWords.add(avoid);
        remaining = remaining.filter(words => !words.includes(avoid));
      }
      cachedFitKey = null;
      console.log(JSON.stringify({ diversify: record.position, avoidInNewCandidates: [...harvestAvoidWords] }));
    }
    currentChoices = new Map();
    const settings = fitSettings(record);
    const query = poolIndex.query({ masks: settings.masks.keys(), minimumCount: record.hard.targetCount.minimum,
      preferredCount: record.hard.targetCount.preferred, allowed: settings.allowed, rarity,
      referenceLengths: record.hard.targetWordLength ? record.preferences.targetWordLengths : undefined,
      rareMaximum: Math.max(...record.hard.rareWordMaximumByTargetCount.map(pair => pair[1])),
      desiredRares: stageSelectionPreference(record, record.hard.targetCount.preferred).rare,
      used: new Set(selected.map(entry => entry.boardId)) });
    const retained = new Map();
    const wordFamilyKey = entry => [...entry.level.targetWords, ...entry.level.extraWords].map(row => row.word).sort().join(' ');
    const wordFamilyCount = () => new Set([...retained.values()].map(wordFamilyKey)).size;
    function collect() {
      for (const choice of currentChoices.values()) {
        if (cached && refresh.has(record.position) && !args.includes('--include-existing-distance') && record.hard.targetWordLength?.maximumLetterDistance > 2 &&
          choice.lengthAlignment?.letterDistance <= 2) continue;
        const key = [choice.shapeId, choice.game.c, choice.game.d, choice.metrics.positive, choice.metrics.turns,
          choice.metrics.straight, choice.metrics.twoPlus].join('|');
        if (!retained.has(key) || retained.get(key).score > choice.score) retained.set(key, choice);
      }
      currentChoices = new Map();
    }
    let inspected = 0;
    for (const base of query.bases) {
      if (stopped || inspected >= 1800) break;
      stats.boardsTriedForReuse++; inspected++;
      fitBoard(base, record, () => !stopped); collect();
      if (retained.size >= 600 && inspected >= 80 && wordFamilyCount() >= harvestFamilyTarget) break;
      if (inspected % 40 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    for (const old of discarded.filter(entry => entry.position === record.position)) {
      const base = byFamily.get(old.boardId);
      if (base) { fitBoard(base, record, () => !stopped); collect(); }
    }
    const needsMore = () => harvestFamilyTarget ? wordFamilyCount() < harvestFamilyTarget :
      cached && refresh.has(record.position) ? wordFamilyCount() < 5 : retained.size < 80;
    if ((retained.size < 40 || harvestFamilyTarget && needsMore() || cached && refresh.has(record.position) && needsMore()) && !stopped) {
      for (let batch = 0; batch < harvestBatches && needsMore(); batch++) {
        generateBoards(record, 1600, batch); collect();
        if (retained.size < 40 || cached && refresh.has(record.position) && needsMore()) { localSearch(record, 1600, batch); collect(); }
        console.log(JSON.stringify({ harvesting: record.position, batch: batch + 1, candidates: retained.size, wordFamilies: wordFamilyCount(), poolBoards: bank.length }));
      }
    }
    let candidates = [...retained.values()].sort(compareCandidates).slice(0, 1000);
    if (harvestFamilyTarget) {
      const families = new Map();
      for (const entry of [...retained.values()].sort(compareCandidates)) {
        const key = wordFamilyKey(entry);
        if (!families.has(key)) families.set(key, []);
        families.get(key).push(entry);
      }
      candidates = [];
      for (let depth = 0; candidates.length < 1000; depth++) {
        let added = false;
        for (const entries of families.values()) if (entries[depth] && candidates.length < 1000) {
          candidates.push(entries[depth]); added = true;
        }
        if (!added) break;
      }
    }
    pools.set(record.position, candidates);
    write('stage-candidates.json', { stage: stage.id, pools: [...pools].map(([position, entries]) => ({ position,
      entries: entries.map(({ level, ...entry }) => ({ ...entry, level: cleanLevel(level) })) })) });
    console.log(JSON.stringify({ stageCandidates: record.position, candidates: candidates.length, inspected, poolBoards: bank.length }));
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  harvesting = false; cachedFitKey = null;
  write('stage-candidates.json', { stage: stage.id, pools: [...pools].map(([position, entries]) => ({ position,
    entries: entries.map(({ level, ...entry }) => ({ ...entry, level: cleanLevel(level) })) })) });
  if (args.includes('--harvest-only')) {
    save(true);
    const library = await compactTrialLibrary(destination);
    write('harvest-report.json', { from: stageFrom, to, frozenThrough: selected.at(-1)?.position,
      pools: [...pools].map(([position, entries]) => ({ position, count: entries.length })), library, sourceHashes });
    process.exit(0);
  }
  let matched = null, matchedWidth = null;
  for (const width of [192, 768, 2048]) {
    matchedWidth = width;
    matched = await matchStageCandidates({ prefix: selected, records, pools, stage,
      budget: integerBudgets.get(stage.id), sequence: plan.common.sequence, width, isCurrent: () => !stopped,
      onLayer: progress => console.log(JSON.stringify({ stageMatch: stage.id, width, ...progress })) });
    console.log(JSON.stringify({ stageMatchResult: matched.completed, width, position: matched.position, transitions: matched.transitions }));
    if (matched.completed || stopped) break;
  }
  if (matched?.completed) {
    for (const choice of matched.choices) {
      choice.mode = 'reuse'; selected.push(choice); selectionRevision++;
      events.push({ position: choice.position, mode: 'reuse', stageMatch: true, boardId: choice.boardId,
        bornPosition: choice.bornPosition, orientation: choice.orientation, targetChanges: choice.targetChanges, newBoardsStored: 0, generationCalls: 0 });
    }
    searchPolicy.stageMatching = { width: matchedWidth,
      candidates: [...pools].map(([position, entries]) => [position, entries.length]), transitions: matched.transitions };
  } else if (!stopped) {
    save(); throw new Error('阶段候选暂不能组成完整序列：第' + matched.position + '关');
  }
}

while (!args.includes('--stage-match') && selected.length < to - from + 1 && !stopped) {
  const position = from + selected.length, record = plan.records[position - 1];
  const key = contextKey(position), retry = failures.get(key) ?? 0, beforeCount = bank.length;
  const beforeStats = { ...stats };
  const reservation = reservedLevels.get(position);
  let choices;
  if (reservation) {
    const level = reservation.level;
    const found = sourceGenerator.findWords({ rows: level.rows, columns: level.columns, disabledCells: level.disabledCells,
      letters: level.cells.map(cell => cell.letter), minimumWordLength: 3 });
    const choice = rankLevel(level, record, byFamily.get(reservation.boardId), reservation.orientation, found);
    choices = choice ? [choice] : [];
    searchPool.exhausted = true;
  } else choices = searchPool(record, Math.min(3500, 800 + bank.length * 2));
  let acquisition = 'reuse';
  const poolFits = choices.length;
  if (!choices.length && !searchPool.exhausted) { await new Promise(resolve => setTimeout(resolve, 0)); continue; }
  if (!choices.length && !reservation && fitSettings(record).possible) {
    choices = generateBoards(record, 1500, retry); acquisition = 'new';
    if (!choices.length) choices = localSearch(record, 1200, retry);
  }
  if (!choices.length) {
    failures.set(key, retry + 1);
    positionFailures.set(position, (positionFailures.get(position) ?? 0) + 1);
    console.log(JSON.stringify({ searching: position, retry: retry + 1, poolBoards: bank.length, stats, elapsedSeconds: Math.round((performance.now() - started) / 1000) }));
    if (selected.length === lockedPrefixCount && !fitSettings(record).budgetPossible) {
      throw new Error('保留的前序关卡使阶段预算不可达，停止续跑并保留原关卡。');
    }
    if (selected.length > lockedPrefixCount && (retry + 1 >= searchPolicy.emptyBatchesBeforeBacktrack || !fitSettings(record).possible)) {
      const stage = plan.stages.find(stage => stage.id === record.stageId);
      let target = selected.length - 1;
      const first = Math.max(lockedPrefixCount, integerBudgets.has(stage.id) ? Math.max(0, stage.from - from) : Math.max(0, selected.length - 3));
      const stageTotals = selected.filter(entry => entry.position >= stage.from && entry.position <= stage.to)
        .reduce((total, entry) => addMetrics(total, entry.metrics), emptyMetrics());
      let bestBurden = -Infinity;
      const repairStage = !fitSettings(record).budgetPossible;
      const localDepth = Math.min(24, 2 ** Math.floor(positionFailures.get(position) / 4));
      if (!repairStage) target = Math.max(lockedPrefixCount, Math.min(selected.length - 1, Math.max(first, selected.length - localDepth)));
      for (let index = repairStage ? first : selected.length; index < selected.length; index++) {
        const entry = selected[index];
        const burden = stageRollbackBurden(entry.metrics, stageTotals, stage.ranges);
        if (burden > bestBurden) { bestBurden = burden; target = index; }
      }
      const depth = selected.length - target;
      for (let i = 0; i < depth && selected.length > lockedPrefixCount; i++) {
        const previous = selected.pop(); selectionRevision++;
        const key = contextKey(previous.position);
        if (!bans.has(key)) bans.set(key, new Set());
        bans.get(key).add(previous.id);
        stats.backtracks++;
      }
    }
    save();
    await new Promise(resolve => setTimeout(resolve, 0));
    continue;
  }
  const choice = choices[0];
  positionFailures.delete(position);
  choice.mode = acquisition;
  selected.push(choice);
  selectionRevision++;
  events.push({ position, poolBoardsBefore: beforeCount, poolFittingSelections: poolFits, boardId: choice.boardId,
    bornPosition: choice.bornPosition, mode: choice.mode, orientation: choice.orientation, targetChanges: choice.targetChanges,
    newBoardsStored: bank.length - beforeCount, generationCalls: stats.generationCalls - beforeStats.generationCalls });
  console.log(JSON.stringify({ completed: selected.length, position, mode: choice.mode, bornPosition: choice.bornPosition,
    orientation: choice.orientation, targets: choice.level.targetWords.map(entry => entry.word), extras: choice.level.extraWords.length,
    metrics: choice.metrics, poolBoards: bank.length, elapsedSeconds: Math.round((performance.now() - started) / 1000) }));
  save();
  await new Promise(resolve => setTimeout(resolve, 0));
}
save(true);
const staticViolations = [];
const verified = selected.map(entry => {
  const restored = importSingleGameLevel(JSON.stringify(entry.game), dictionaryRows);
  const paths = new Map(entry.level.targetWords.map(target => [target.word, target.path]));
  restored.targetWords.forEach(target => { target.path = paths.get(target.word); });
  const found = sourceGenerator.findWords({ rows: restored.rows, columns: restored.columns, disabledCells: restored.disabledCells,
    letters: restored.cells.map(cell => cell.letter), minimumWordLength: 3 });
  const checked = checkLevelConstraint(restored, plan.records[entry.position - 1], { dictionary, whitelist, foundWords: found });
  staticViolations.push(...checked.violations.map(issue => ({ position: entry.position, ...issue })));
  assert.deepEqual(checked.game, entry.game);
  return { ...entry, level: restored, metrics: checked.metrics, shapeId: checked.shapeId };
});
const sequence = checkConstraintSequence(plan, verified);
const report = { from, to, seed, completed: selected.length, requested: to - from + 1,
  passed: selected.length === to - from + 1 && !staticViolations.length && !sequence.violations.length,
  lastSessionElapsedMilliseconds: Math.round(performance.now() - started),
  totalElapsedMilliseconds: priorElapsedMilliseconds + Math.round(performance.now() - started),
  continuedFromCheckpoint: Boolean(args.includes('--resume') || continueFrom), searchPolicy, stats,
  continuation: continuation ? { ...continuation, prefixGames: undefined,
    newPositions: [continuation.frozenThrough + 1, to], newCompleted: selected.length - lockedPrefixCount,
    additionalElapsedMilliseconds: priorElapsedMilliseconds + Math.round(performance.now() - started) - continuation.inheritedElapsedMilliseconds,
    addedStats: Object.fromEntries(Object.entries(stats).filter(([key]) => key !== 'largestGenerationBatch')
      .map(([key, value]) => [key, value - (continuation.inheritedStats[key] ?? 0)])) } : null,
  reuse: { fromLibrary: selected.filter(entry => entry.mode === 'reuse').length,
    fromEarlierPositions: selected.filter(entry => entry.bornPosition < entry.position).length,
    withTargetChanges: selected.filter(entry => entry.mode === 'reuse' && (entry.targetChanges.added.length || entry.targetChanges.removed.length)).length,
    withSymmetry: selected.filter(entry => entry.mode === 'reuse' && entry.orientation !== '原样').length,
    anySymmetry: selected.filter(entry => entry.orientation !== '原样').length,
    libraryRemaining: bank.filter(base => !selected.some(entry => entry.boardId === base.id)).length },
  staticViolations, sequenceViolations: sequence.violations,
  stages: sequence.stages.filter(stage => plan.stages.find(definition => definition.id === stage.id).from <= to),
  pending: { opening: [1, 2, 3, 4, 5], cooldownAgainstOpening: sequence.pending.cooldownPositions,
    specialShapeAgainstManual5: sequence.pending.specialShapePositions, topRowAgainstOpening: sequence.pending.topRowPositions,
    completeStageRanges: plan.stages.filter(stage => stage.from >= from && stage.to <= to).map(stage => [stage.from, stage.to]),
    nextStageMissing: (() => { const stage = plan.stages.find(stage => stage.from <= to && stage.to >= to);
      return stage.to > to ? [to + 1, stage.to] : null; })(),
    boardUniquenessAgainstOpening: true },
  sourceHashes, levels: selected.map(({ level, ...entry }) => ({ ...entry,
    targetWords: level.targetWords.map(target => ({ word: target.word, rarityLevel: dictionary.get(target.word).rarityLevel, path: target.path })),
    extraWords: level.extraWords.map(extra => extra.word) })) };
report.library = await compactTrialLibrary(destination);
write('report.json', report);
if (selected.length) {
  const game = createGameExport(selected.map(entry => ({ level: entry.level })));
  if (continuation) assert.deepEqual(game.level.slice(0, lockedPrefixCount), continuation.prefixGames, '前序关卡不能改变');
  write('game.json', game);
  if (continuation && selected.length > lockedPrefixCount) write('new-game.json', createGameExport(selected.slice(lockedPrefixCount).map(entry => ({ level: entry.level }))));
  write('editor.json', { schemaVersion: 1, label: '候选库自适应试跑 · 第' + from + '～' + to + '关', records: selected.map(entry => ({
    id: entry.position, position: entry.position, level: { ...entry.level,
      name: '试跑 · 第' + String(entry.position).padStart(3, '0') + '关', sourceConfig: { position: entry.position },
      constraintPosition: entry.position } })) });
}
console.log(JSON.stringify({ passed: report.passed, completed: report.completed, reuse: report.reuse, stats, destination }));
if (!report.passed) process.exitCode = 1;

async function compactTrialLibrary(directory) {
  const file = path.join(directory, 'library.json'), compressed = file + '.gz';
  const original = createHash('sha256');
  await pipeline(fs.createReadStream(file), original);
  const digest = original.digest('hex'), originalBytes = fs.statSync(file).size;
  await pipeline(fs.createReadStream(file), createGzip({ level: 6 }), fs.createWriteStream(compressed + '.tmp'));
  const restored = createHash('sha256');
  await pipeline(fs.createReadStream(compressed + '.tmp'), createGunzip(), restored);
  assert.equal(restored.digest('hex'), digest, '压缩后的候选库不能完整恢复');
  fs.renameSync(compressed + '.tmp', compressed);
  fs.unlinkSync(file);
  return { file: 'library.json.gz', originalBytes, compressedBytes: fs.statSync(compressed).size,
    sha256Uncompressed: digest, losslessVerified: true };
}
