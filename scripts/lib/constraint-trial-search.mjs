import { describePath } from '../../dist/level-statistics.js';
import { placementQualityCost } from '../../dist/generation-quality.js';
import { selectExtraWords } from '../../dist/level-rules.js';
import { closestSpecialShapes } from '../../dist/generation-policy.js';
import { referenceLengthQuota, targetLengthDistance } from '../../dist/target-length-alignment.js';

export const METRIC_FIELDS = ['words', 'positive', 'rare', 'letters', 'turns', 'longFive', 'straight', 'twoPlus'];
export const emptyMetrics = () => Object.fromEntries(METRIC_FIELDS.map(field => [field, 0]));
export const addMetrics = (a, b) => Object.fromEntries(METRIC_FIELDS.map(field => [field, a[field] + b[field]]));

// A palindrome can use its assigned route in either direction without changing
// letters, target words or any cell count. Offer every achievable positive total.
export function palindromeDirectionVariants(entry) {
  const delta = path => {
    const start = path[0], end = path.at(-1), columns = entry.level.columns;
    return end % columns - start % columns + Math.floor(end / columns) - Math.floor(start / columns);
  };
  const indices = entry.level.targetWords.flatMap((target, index) =>
    target.word === [...target.word].reverse().join('') && delta(target.path) !== 0 ? [index] : []);
  if (!indices.length) return [entry];
  const variants = [entry], seen = new Set([entry.level.targetWords.map(row => row.path.join(',')).join('|')]);
  for (let positive = 0; positive <= indices.length; positive++) {
    const variant = { ...entry, id: entry.id + '-pal-' + positive,
      level: { ...entry.level, targetWords: entry.level.targetWords.map(row => ({ ...row, path: [...row.path] })) } };
    indices.forEach((index, order) => {
      const target = variant.level.targetWords[index];
      if ((delta(target.path) > 0) !== (order < positive)) target.path.reverse();
    });
    const key = variant.level.targetWords.map(row => row.path.join(',')).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    variant.metrics = { ...entry.metrics, positive: variant.level.targetWords.filter(row => delta(row.path) > 0).length };
    variant.palindromeDirectionsAdjusted = true;
    variants.push(variant);
  }
  return variants;
}
export function stageProgressDeltas({ ranges, plannedWords, frozen, placed, futureFixed, candidate }) {
  const adjustableWords = plannedWords - frozen.words - futureFixed.words;
  const words = placed.words + candidate.words;
  return Object.fromEntries(Object.keys(ranges).map(field => {
    const target = (ranges[field].target * plannedWords - frozen[field] - futureFixed[field]) / adjustableWords;
    return [field, placed[field] + candidate[field] - target * words];
  }));
}
export function stageProgressDeviation(settings) {
  const deltas = stageProgressDeltas(settings);
  return Math.abs(deltas.positive) + Math.abs(deltas.rare);
}
export function stageProgressBounds({ ranges, plannedWords, frozen, placed, futureFixed, count, positiveRareLimit, toleranceShare }) {
  const words = placed.words + count;
  const adjustableWords = plannedWords - frozen.words - futureFixed.words;
  return Object.fromEntries(Object.entries(ranges).map(([field, range]) => {
    const target = (range.target * plannedWords - frozen[field] - futureFixed[field]) / adjustableWords;
    const desired = target * words - placed[field];
    const limit = field === 'positive' || field === 'rare' ? positiveRareLimit :
      Math.max(field === 'letters' || field === 'turns' ? 15 : 4, range.tolerance * plannedWords * toleranceShare);
    return [field, [Math.ceil(desired - limit - 1e-8), Math.floor(desired + limit + 1e-8)]];
  }));
}
export function stageRollbackBurden(metrics, totals, ranges) {
  return Object.entries(ranges).reduce((sum, [field, range]) => {
    const direction = Math.sign(totals[field] - range.target * totals.words);
    const contribution = Math.max(0, direction * (metrics[field] - range.target * metrics.words));
    return sum + contribution / Math.max(0.5, range.tolerance * metrics.words) *
      (field === 'positive' || field === 'rare' ? 2 : 0.25);
  }, 0);
}
const lowerInteger = value => Math.ceil(value - 1e-8);
const upperInteger = value => Math.floor(value + 1e-8);

export function capacityFor(records) {
  const capacity = { minimumWords: 0, maximumWords: 0, maximumLetters: 0, maximumTurns: 0,
    maximumRares: 0, maximumLongFive: 0, maximumTwoPlus: 0 };
  for (const record of records) {
    const { minimum, maximum } = record.hard.targetCount;
    const cells = Math.max(...record.hard.board.options.map(option => option.activeCells));
    capacity.minimumWords += minimum;
    capacity.maximumWords += maximum;
    capacity.maximumLetters += maximum * cells;
    capacity.maximumTurns += maximum * Math.max(0, cells - 2);
    capacity.maximumRares += Math.max(0, ...record.hard.rareWordMaximumByTargetCount.map(pair => pair[1]));
    capacity.maximumLongFive += cells >= 5 ? maximum : 0;
    capacity.maximumTwoPlus += cells >= 4 ? maximum : 0;
  }
  return capacity;
}

export function buildIntegerStageBudget(stage, records) {
  if (records.some(record => record.mode !== 'automatic' || record.hard.targetCount.minimum !== record.hard.targetCount.maximum)) return null;
  const words = records.reduce((sum, record) => sum + record.hard.targetCount.minimum, 0);
  return { stageId: stage.id, from: stage.from, to: stage.to, words,
    ranges: Object.fromEntries(Object.entries(stage.ranges).map(([field, range]) => [field,
      { minimum: lowerInteger(range.minimum * words), maximum: upperInteger(range.maximum * words), target: range.target }])) };
}

// Keep every legal denominator when a destination allows a target-count range.
// A stage with one flexible level must not silently lose its hard stage checks.
export function buildStageSearchBudget(stage, records) {
  if (records.some(record => record.mode !== 'automatic')) return null;
  const fixed = buildIntegerStageBudget(stage, records);
  if (fixed) return fixed;
  const minimumWords = records.reduce((sum, record) => sum + record.hard.targetCount.minimum, 0);
  const maximumWords = records.reduce((sum, record) => sum + record.hard.targetCount.maximum, 0);
  return { stageId: stage.id, from: stage.from, to: stage.to, minimumWords, maximumWords,
    alternatives: Array.from({ length: maximumWords - minimumWords + 1 }, (_, i) => {
      const words = minimumWords + i;
      return { stageId: stage.id, from: stage.from, to: stage.to, words,
        ranges: Object.fromEntries(Object.entries(stage.ranges).map(([field, range]) => [field,
          { minimum: lowerInteger(range.minimum * words), maximum: upperInteger(range.maximum * words), target: range.target }])) };
    }) };
}

// Independent count bounds are insufficient: words with two turns need at
// least four letters, and five-letter words need two letters above the floor.
export function stageBudgetPossible(budget, totals, capacity) {
  if (!budget) return true;
  if (budget.alternatives) return budget.alternatives.some(alternative => stageBudgetPossible(alternative, totals, capacity));
  const count = budget.words - totals.words;
  if (count < capacity.minimumWords || count > capacity.maximumWords) return false;
  const availableLetters = Math.min(capacity.maximumLetters, budget.ranges.letters.maximum - totals.letters);
  const extraLetters = availableLetters - 3 * count;
  if (extraLetters < 0) return false;
  const maxima = { positive: count, rare: Math.min(count, capacity.maximumRares), letters: availableLetters,
    turns: Math.min(capacity.maximumTurns, availableLetters - 2 * count),
    longFive: Math.min(count, capacity.maximumLongFive, Math.floor(extraLetters / 2)),
    straight: count, twoPlus: Math.min(count, capacity.maximumTwoPlus, extraLetters) };
  for (const [field, range] of Object.entries(budget.ranges)) {
    const minimum = field === 'letters' ? 3 * count : 0;
    if (totals[field] + minimum > range.maximum || totals[field] + maxima[field] < range.minimum) return false;
  }
  const neededStraight = Math.max(0, budget.ranges.straight.minimum - totals.straight);
  const neededTwoPlus = Math.max(0, budget.ranges.twoPlus.minimum - totals.twoPlus);
  if (neededStraight + neededTwoPlus > count) return false;
  const neededLong = Math.max(0, budget.ranges.longFive.minimum - totals.longFive);
  if (Math.max(neededTwoPlus, 2 * neededLong) > extraLetters) return false;
  if (totals.turns + 2 * neededTwoPlus > budget.ranges.turns.maximum) return false;
  return true;
}

export function boundsForCurrent(budget, totals, future, count, rareMaximum, activeCells) {
  const bounds = { positive: [0, count], rare: [0, rareMaximum], letters: [3 * count, count * activeCells],
    turns: [0, count * Math.max(0, activeCells - 2)], longFive: [0, activeCells >= 5 ? count : 0],
    straight: [0, count], twoPlus: [0, activeCells >= 4 ? count : 0] };
  if (!budget) return bounds;
  if (budget.alternatives) {
    const viable = budget.alternatives.filter(alternative => alternative.words - totals.words - count >= future.minimumWords &&
      alternative.words - totals.words - count <= future.maximumWords).map(alternative =>
      boundsForCurrent(alternative, totals, future, count, rareMaximum, activeCells));
    if (!viable.length) return Object.fromEntries(Object.keys(bounds).map(field => [field, [Infinity, -Infinity]]));
    return Object.fromEntries(Object.keys(bounds).map(field => [field,
      [Math.min(...viable.map(option => option[field][0])), Math.max(...viable.map(option => option[field][1]))]]));
  }
  const futureWords = budget.words - totals.words - count;
  if (futureWords < future.minimumWords || futureWords > future.maximumWords) {
    return Object.fromEntries(Object.keys(bounds).map(field => [field, [Infinity, -Infinity]]));
  }
  const futureMaximums = { positive: futureWords, rare: Math.min(futureWords, future.maximumRares), letters: future.maximumLetters,
    turns: future.maximumTurns, longFive: Math.min(futureWords, future.maximumLongFive), straight: futureWords,
    twoPlus: Math.min(futureWords, future.maximumTwoPlus) };
  for (const [field, range] of Object.entries(budget.ranges)) {
    bounds[field][0] = Math.max(bounds[field][0], range.minimum - totals[field] - futureMaximums[field]);
    bounds[field][1] = Math.min(bounds[field][1], range.maximum - totals[field] - (field === 'letters' ? 3 * futureWords : 0));
  }
  return bounds;
}

export class BoardSearchIndex {
  constructor() { this.byMask = new Map(); this.revision = 0; }
  add(base, variants, targetWords) {
    base.searchProfile = { targetWords: [...targetWords], maximumTargets: targetWords.length };
    for (const mask of new Set(variants.map(variant => variant.grid.replace(/[A-Z]/g, '1').replaceAll('-', '0')))) {
      if (!this.byMask.has(mask)) this.byMask.set(mask, new Map());
      const buckets = this.byMask.get(mask), count = targetWords.length;
      if (!buckets.has(count)) buckets.set(count, []);
      buckets.get(count).push(base);
    }
    this.revision++;
  }
  query({ masks, minimumCount, preferredCount, allowed, rarity, rareMaximum, used, desiredRares = 0, referenceLengths }) {
    const candidates = new Map();
    const quota = referenceLengths ? referenceLengthQuota(referenceLengths, preferredCount) : null;
    let indexed = 0;
    for (const mask of masks) for (const [count, bases] of this.byMask.get(mask) ?? []) {
      if (count < minimumCount) continue;
      for (const base of bases) {
        indexed++;
        if (used.has(base.id) || candidates.has(base.id)) continue;
        const words = base.searchProfile.targetWords.filter(word => allowed.has(word));
        const rares = words.filter(word => rarity.get(word) >= 3).length;
        const available = Math.min(words.length, words.length - rares + rareMaximum);
        if (available < minimumCount) continue;
        const lengthShortfall = quota ? [...new Set(quota)].reduce((sum, length) => sum +
          Math.max(0, quota.filter(n => n === length).length - words.filter(word => word.length === length).length), 0) : 0;
        candidates.set(base.id, { base, lengthShortfall, score: Math.abs(words.length - preferredCount) +
          Math.abs(Math.min(rares, rareMaximum) - desiredRares) * 2 });
      }
    }
    return { indexed, bases: [...candidates.values()].sort((a, b) => a.lengthShortfall - b.lengthShortfall ||
      a.score - b.score || a.base.id.localeCompare(b.base.id)).map(item => item.base) };
  }
}

// A cursor survives time slices. Running out of time never proves that the
// inventory is empty; callers must keep reading until this query is exhausted.
export class IndexedQueryCursor {
  constructor() { this.seen = new Set(); this.queue = []; this.next = 0; }
  append(bases) {
    for (const base of bases) if (!this.seen.has(base.id)) { this.seen.add(base.id); this.queue.push(base); }
  }
  take(limit) { const values = this.queue.slice(this.next, this.next + limit); this.next += values.length; return values; }
  get exhausted() { return this.next >= this.queue.length; }
}

// Keep several compatible stage prefixes instead of repeatedly replacing one
// greedy prefix. The caller supplies fully verified single-level candidates.
export async function matchStageCandidates({ prefix, records, pools, stage, budget, sequence, width = 192,
  isCurrent = () => true, onLayer = () => {} }) {
  const bits = new Map();
  const bitFor = word => {
    if (!bits.has(word)) bits.set(word, 1n << BigInt(bits.size));
    return bits.get(word);
  };
  const wordMasks = new WeakMap();
  const maskFor = entry => {
    if (!wordMasks.has(entry)) wordMasks.set(entry, [...entry.level.targetWords, ...entry.level.extraWords]
      .reduce((mask, word) => mask | bitFor(word.word), 0n));
    return wordMasks.get(entry);
  };
  const cooldown = Math.max(sequence.cooldown?.target ?? 50, sequence.cooldown?.extra ?? 50);
  const prefixMasks = prefix.map(entry => ({ position: entry.position, mask: maskFor(entry) }));
  const prepared = new Map(records.map(record => [record.position, (pools.get(record.position) ?? []).map(entry => ({ entry, mask: maskFor(entry) }))]));
  const suffixBounds = Array(records.length + 1);
  suffixBounds[records.length] = Object.fromEntries(METRIC_FIELDS.map(field => [field, [0, 0]]));
  for (let index = records.length - 1; index >= 0; index--) {
    const candidates = prepared.get(records[index].position);
    suffixBounds[index] = Object.fromEntries(METRIC_FIELDS.map(field => [field,
      [Math.min(...candidates.map(({ entry }) => entry.metrics[field])) + suffixBounds[index + 1][field][0],
        Math.max(...candidates.map(({ entry }) => entry.metrics[field])) + suffixBounds[index + 1][field][1]]]));
  }
  const poolBudgetPossible = (totals, bounds) => !budget || (budget.alternatives ?? [budget]).some(option =>
    totals.words + bounds.words[0] <= option.words && totals.words + bounds.words[1] >= option.words &&
    Object.entries(option.ranges).every(([field, range]) =>
      totals[field] + bounds[field][0] <= range.maximum && totals[field] + bounds[field][1] >= range.minimum));
  // Small future pools are bottlenecks. Keep at least one of their candidates
  // available rather than discovering at the final slot that every word was used.
  const bottlenecks = records.map(record => {
    const candidates = [...new Map(prepared.get(record.position).map(candidate =>
      [[candidate.mask.toString(16), candidate.entry.boardId, candidate.entry.shapeId].join(':'), candidate])).values()];
    return { record, candidates, distinctWordSets: new Set(candidates.map(candidate => candidate.mask)).size,
      prefixMask: prefixMasks.filter(entry => record.position - entry.position <= cooldown)
        .reduce((mask, entry) => mask | entry.mask, 0n) };
  }).filter(row => row.distinctWordSets <= 32);
  const top = prefix.map(entry => entry.metrics.topVisible);
  let run = top.length ? 1 : 0, alternating = top.length ? 1 : 0;
  for (let i = top.length - 2; i >= 0 && top[i] === top.at(-1); i--) run++;
  for (let i = top.length - 2; i >= 0 && top[i] !== top[i + 1]; i--) alternating++;
  const initialMetrics = prefix.filter(entry => entry.position >= stage.from && entry.position <= stage.to)
    .reduce((total, entry) => addMetrics(total, entry.metrics), emptyMetrics());
  let states = [{ choices: [], metrics: initialMetrics, mask: 0n, boards: new Set(prefix.map(entry => entry.boardId)),
    lastTop: top.at(-1), run, alternating, lastSpecial: prefix.filter(entry => entry.position % 5 === 0).at(-1)?.shapeId ?? null,
    quality: 0, score: 0 }];
  let transitions = 0;
  for (const [index, record] of records.entries()) {
    if (!isCurrent()) return { completed: false, reason: 'stopped', transitions, choices: [] };
    const prefixMask = prefixMasks.filter(entry => record.position - entry.position <= cooldown)
      .reduce((mask, entry) => mask | entry.mask, 0n);
    const future = capacityFor(records.slice(index + 1));
    const prospects = [];
    for (const state of states) {
      const activeMask = state.choices.length && record.position - state.choices[0].position > cooldown ?
        state.choices.filter(entry => record.position - entry.position <= cooldown)
          .reduce((mask, entry) => mask | maskFor(entry), 0n) : state.mask;
      const allowedShapes = record.hard.board.selection === 'exact-mask' ? null :
        new Set(closestSpecialShapes(record.reference.cells, state.lastSpecial).map(shape => shape.id));
      for (const { entry, mask } of prepared.get(record.position)) {
        transitions++;
        if (((activeMask | prefixMask) & mask) !== 0n || state.boards.has(entry.boardId) || allowedShapes && !allowedShapes.has(entry.shapeId)) continue;
        const visible = entry.metrics.topVisible;
        const nextRun = state.lastTop === visible ? state.run + 1 : 1;
        const nextAlternating = state.lastTop !== undefined && state.lastTop !== visible ? state.alternating + 1 : 1;
        const limits = sequence.topRowRuns;
        if (nextRun > (visible ? limits.maximumVisible : limits.maximumInvisible) || nextAlternating > limits.maximumAlternating) continue;
        const metrics = addMetrics(state.metrics, entry.metrics);
        if (!stageBudgetPossible(budget, metrics, future)) continue;
        if (!poolBudgetPossible(metrics, suffixBounds[index + 1])) continue;
        const nextSpecial = allowedShapes ? entry.shapeId : state.lastSpecial;
        const losesBottleneck = bottlenecks.some(({ record: upcoming, candidates, prefixMask: upcomingPrefix }) => {
          if (upcoming.position <= record.position) return false;
          let unavailable = upcomingPrefix;
          if (upcoming.position - records[0].position <= cooldown) unavailable |= state.mask | mask;
          else {
            for (const prior of state.choices) if (upcoming.position - prior.position <= cooldown) unavailable |= maskFor(prior);
            if (upcoming.position - record.position <= cooldown) unavailable |= mask;
          }
          const nextShapes = upcoming.hard.board.selection !== 'exact-mask' && upcoming.hard.board.previousSpecialPosition <= record.position ?
            new Set(closestSpecialShapes(upcoming.reference.cells, nextSpecial).map(shape => shape.id)) : null;
          return !candidates.some(({ entry: candidate, mask: candidateMask }) =>
            (unavailable & candidateMask) === 0n && !state.boards.has(candidate.boardId) && candidate.boardId !== entry.boardId &&
            (!nextShapes || nextShapes.has(candidate.shapeId)));
        });
        if (losesBottleneck) continue;
        const quality = state.quality + (entry.qualityScore ?? 0) + entry.level.extraWords.length * 0.1 +
          Math.abs(entry.metrics.words - record.hard.targetCount.preferred) * 0.2;
        const score = Object.entries(stage.ranges).reduce((sum, [field, range]) => sum +
          Math.abs(metrics[field] - range.target * metrics.words) / Math.max(1, range.tolerance * metrics.words) *
          (field === 'positive' || field === 'rare' ? 2 : 0.25), 0) + quality * 0.02;
        prospects.push({ parent: state, entry, metrics, mask: activeMask | mask, quality, score,
          lastTop: visible, run: nextRun, alternating: nextAlternating,
          lastSpecial: allowedShapes ? entry.shapeId : state.lastSpecial });
      }
    }
    if (!prospects.length) return { completed: false, reason: 'no-compatible-prefix', position: record.position, transitions, choices: [] };
    prospects.sort((a, b) => a.score - b.score);
    const groups = new Map(), retained = [];
    for (const prospect of prospects) {
      const key = prospect.mask.toString(16);
      const count = groups.get(key) ?? 0;
      if (count >= 4) continue;
      groups.set(key, count + 1);
      const boards = new Set(prospect.parent.boards); boards.add(prospect.entry.boardId);
      retained.push({ ...prospect, parent: undefined, entry: undefined, boards,
        choices: [...prospect.parent.choices, prospect.entry] });
      if (retained.length >= width) break;
    }
    states = retained;
    onLayer({ position: record.position, states: states.length, candidates: prepared.get(record.position).length, transitions });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { completed: true, choices: states[0].choices, transitions, metrics: states[0].metrics };
}

function wordMetrics(entry, columns) {
  const turns = describePath(entry.path, columns).turns, start = entry.path[0], end = entry.path.at(-1);
  return { words: 1, positive: Number(end % columns - start % columns + Math.floor(end / columns) - Math.floor(start / columns) > 0),
    rare: Number(entry.rarityLevel >= 3), letters: entry.word.length, turns, longFive: Number(entry.word.length >= 5),
    straight: Number(turns === 0), twoPlus: Number(turns >= 2) };
}

// Select targets with the destination's integer stage budget inside the search,
// before allocating cell counts or running the final safety verifier.
export function selectBudgetedTargets({ config, letters, found, eligible, extraCap, rareLimit, forbiddenExtras,
  bounds, partialPossible, withinBudget, review, lengthPolicy, nodeLimit = 5000, acceptedLimit = 12 }) {
  const count = config.desiredTargetCount;
  const quota = lengthPolicy ? referenceLengthQuota(config.generationRules.targetWordLengths, count) : null;
  const forbiddenLengths = new Set(found.filter(entry => forbiddenExtras.has(entry.word)).map(entry => entry.word.length));
  const namesPerLength = new Map();
  for (const entry of found) namesPerLength.set(entry.word.length, (namesPerLength.get(entry.word.length) ?? 0) + 1);
  const maximumCoverage = letters.reduce((mask, letter, cell) => letter ? mask | (1 << cell) : mask, 0);
  const positiveTarget = config.generationRules.positiveWordShare ?? 0.8;
  const options = found.filter(entry => eligible.has(entry.word) && !forbiddenLengths.has(entry.word.length) &&
    (!lengthPolicy || entry.word.length >= lengthPolicy.minimum && entry.word.length <= lengthPolicy.maximum)).map(entry => {
    const metrics = wordMetrics(entry, config.columns);
    const cost = placementQualityCost(entry, config.columns, config.generationRules) +
      (metrics.positive ? 1 - positiveTarget : positiveTarget) * 6;
    return { entry, metrics, mask: entry.path.reduce((mask, cell) => mask | (1 << cell), 0), cost };
  }).sort((a, b) => a.cost - b.cost || a.entry.word.localeCompare(b.entry.word));
  if (options.length < count) return { approved: null, nodes: 0, accepted: 0, exhausted: true };
  const coverageSuffix = Array(options.length + 1).fill(0);
  for (let i = options.length - 1; i >= 0; i--) coverageSuffix[i] = coverageSuffix[i + 1] | options[i].mask;
  const minimums = {}, maximums = {};
  for (const field of Object.keys(bounds)) {
    const minimum = Array.from({ length: options.length + 1 }, () => Array(count + 1).fill(Infinity));
    const maximum = Array.from({ length: options.length + 1 }, () => Array(count + 1).fill(-Infinity));
    for (let i = 0; i <= options.length; i++) { minimum[i][0] = 0; maximum[i][0] = 0; }
    for (let i = options.length - 1; i >= 0; i--) for (let n = 1; n <= count; n++) {
      minimum[i][n] = Math.min(minimum[i + 1][n], options[i].metrics[field] + minimum[i + 1][n - 1]);
      maximum[i][n] = Math.max(maximum[i + 1][n], options[i].metrics[field] + maximum[i + 1][n - 1]);
    }
    minimums[field] = minimum; maximums[field] = maximum;
  }
  const chosen = [], chosenNames = new Set(), lengths = new Set();
  let nodes = 0, accepted = 0, approved = null, interrupted = false, pruned = 0;
  function search(index, coverage, recognized, metrics) {
    if (++nodes > nodeLimit || accepted >= acceptedLimit || !withinBudget()) { interrupted = true; return; }
    const needed = count - chosen.length;
    if (quota && targetLengthDistance(chosen.map(entry => entry.word.length), quota, needed) > lengthPolicy.maximumLetterDistance) {
      pruned++; return;
    }
    if (options.length - index < needed || (coverage | coverageSuffix[index]) !== maximumCoverage ||
      recognized > count + extraCap || metrics.rare > rareLimit) return;
    for (const [field, [minimum, maximum]] of Object.entries(bounds)) {
      if (metrics[field] + minimums[field][index][needed] > maximum || metrics[field] + maximums[field][index][needed] < minimum) { pruned++; return; }
    }
    if (partialPossible && !partialPossible(metrics, needed)) { pruned++; return; }
    if (!needed) {
      if (quota && targetLengthDistance(chosen.map(entry => entry.word.length), quota) < (lengthPolicy.minimumLetterDistance ?? 0)) return;
      if (coverage !== maximumCoverage) return;
      const cells = letters.map(letter => ({ letter, count: 0 }));
      for (const entry of chosen) for (const cell of entry.path) cells[cell].count++;
      if (cells.some(cell => cell.count > 35)) return;
      const level = { rows: config.rows, columns: config.columns, disabledCells: config.disabledCells,
        desiredTargetCount: count, cells, targetWords: [...chosen], extraWords: selectExtraWords(found, chosen) };
      const result = review(level);
      if (result.qualified) { accepted++; approved = level; }
      return;
    }
    const option = options[index], { word } = option.entry;
    const newLength = !lengths.has(word.length);
    if (!chosenNames.has(word + 'S') && !(word.endsWith('S') && chosenNames.has(word.slice(0, -1)))) {
      chosen.push(option.entry); chosenNames.add(word);
      if (newLength) lengths.add(word.length);
      search(index + 1, coverage | option.mask, recognized + (newLength ? namesPerLength.get(word.length) : 0), addMetrics(metrics, option.metrics));
      chosen.pop(); chosenNames.delete(word);
      if (newLength) lengths.delete(word.length);
    }
    search(index + 1, coverage, recognized, metrics);
  }
  search(0, 0, 0, emptyMetrics());
  return { approved, nodes, accepted, pruned, exhausted: !interrupted };
}
