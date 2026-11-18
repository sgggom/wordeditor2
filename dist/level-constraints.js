import { SHAPE_LIBRARY } from './shape-library.js';
import { SPECIAL_SHAPE_IDS, closestSpecialShapes } from './generation-policy.js';
import { describePath } from './level-statistics.js';
import { createGameExport } from './level-export.js';
import { selectExtraWords } from './level-rules.js';
import { analyzeTargetPaths } from './target-path-analysis.js';
import { measureTargetLengthAlignment } from './target-length-alignment.js';

const metricFields = ['words', 'positive', 'rare', 'letters', 'turns', 'longFive', 'straight', 'twoPlus'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lengthCounts = lengths => [3, 4, 5, 6, 7, 8].map(bin =>
  lengths.filter(length => Math.min(8, length) === bin).length);
const requireValue = (ok, message) => { if (!ok) throw new Error('关卡约束：' + message); };
const shapeOption = shape => ({ shapeId: shape.id, rows: shape.rows, columns: shape.columns,
  boardMask: [...shape.boardMask], activeCells: shape.activeCells });

// A constraint describes a destination, independently of where a candidate was generated.
// The five manual positions deliberately carry no frozen board, words or count limits.
export function buildLevelConstraintPlan({ configs, shapePlan, limits, stages, sequence, sources,
  excludedPositions = [1, 2, 3, 4, 5] }) {
  requireValue(configs.length === 2000 && shapePlan.length === 2000 && limits.length === 2000,
    '需要完整的2000关配置、造型参考和逐关上限。');
  requireValue(new Set(excludedPositions).size === excludedPositions.length && excludedPositions.every(position =>
    Number.isInteger(position) && position >= 1 && position <= 2000), '人工保留关号无效。');
  requireValue(['maxTopRun', 'maxNoTopRun', 'maxAlternatingRun'].every(key =>
    Number.isInteger(sequence[key]) && sequence[key] > 0), '首行节奏上限无效。');
  const excluded = new Set(excludedPositions);
  const phaseList = stages.map((stage, index) => {
    requireValue(stage.from === (index ? stages[index - 1].to + 1 : 1) && stage.to >= stage.from,
      '阶段必须连续且不能重叠。');
    const ranges = Object.fromEntries(Object.entries(stage.limits).map(([field, [target, tolerance]]) => {
      requireValue(metricFields.includes(field) && field !== 'words' && Number.isFinite(target) &&
        Number.isFinite(tolerance) && tolerance >= 0, '阶段范围无效。');
      return [field, { target, tolerance, minimum: Math.max(0, target - tolerance), maximum: target + tolerance }];
    }));
    return { id: index + 1, from: stage.from, to: stage.to, denominator: 'target-word-count', ranges,
      manualPositions: excludedPositions.filter(position => position >= stage.from && position <= stage.to) };
  });
  requireValue(phaseList.at(-1)?.to === 2000, '阶段需覆盖1～2000关。');
  const records = configs.map((row, index) => {
    const position = index + 1;
    requireValue(row.position === position && shapePlan[index].position === position, '来源关号不连续。');
    const stage = phaseList.find(phase => position >= phase.from && position <= phase.to);
    if (excluded.has(position)) return { position, mode: 'manual', stageId: stage.id,
      reason: '用户暂时排除，后续手动调整；不锁定棋盘、目标词或额外词。' };
    const config = row.config, rules = config.generationRules, planned = shapePlan[index], cap = limits[index];
    const targetRarityLevels = [...new Set(config.filters?.rarityLevel ?? [])].sort((a, b) => a - b);
    requireValue(targetRarityLevels.length > 0 && targetRarityLevels.every(level => [1, 2, 3, 4].includes(level)),
      '第' + position + '关需明确允许的目标词档位，且不能包含5档。');
    requireValue(Number.isInteger(cap.countError) && cap.countError >= 0 && Number.isInteger(cap.extraMaximum) &&
      cap.extraMaximum >= 0 && Number.isInteger(cap.previousRareCount) && cap.previousRareCount >= 0 &&
      Number.isFinite(cap.rareRate) && cap.rareRate >= 0 && cap.rareRate <= 1,
    '第' + position + '关上限无效。');
    const special = position % 5 === 0;
    const referencePosition = position <= 1500 ? position : position - 500;
    requireValue(rules.position === position && rules.referencePosition === referencePosition &&
      planned.referencePosition === referencePosition && planned.referenceCells === rules.referenceCells,
    '第' + position + '关参考配置不一致。');
    const referenceCells = planned.referenceRows * planned.referenceColumns;
    requireValue(referenceCells === planned.referenceCells, '参考尺寸无效。');
    let options;
    if (special) {
      // Keep all shapes that could be nearest for a legal preceding special shape.
      // Level 10 cannot assume the still-manual level 5 will retain its old shape.
      const possible = new Set([null, ...SPECIAL_SHAPE_IDS].flatMap(previous =>
        closestSpecialShapes(referenceCells, previous).map(shape => shape.id)));
      options = SHAPE_LIBRARY.filter(shape => possible.has(shape.id)).map(shapeOption);
    } else {
      const shape = SHAPE_LIBRARY.find(shape => shape.rows === planned.referenceRows &&
        shape.columns === planned.referenceColumns && shape.activeCells === referenceCells);
      requireValue(Boolean(shape), '缺少参考矩形造型。');
      options = [shapeOption(shape)];
      requireValue(config.rows === shape.rows && config.columns === shape.columns &&
        same(rules.boardMask, shape.boardMask), '普通关与参考尺寸不一致。');
    }
    const minimum = Math.max(1, config.desiredTargetCount - cap.countError);
    const maximum = config.desiredTargetCount + cap.countError;
    return { position, mode: 'automatic', stageId: stage.id, reference: { position: referencePosition,
      rows: planned.referenceRows, columns: planned.referenceColumns, cells: referenceCells },
    hard: {
      board: { selection: special ? 'nearest-excluding-previous-special' : 'exact-mask', options,
        ...(special ? { previousSpecialPosition: position - 5 } : {}) },
      targetCount: { preferred: config.desiredTargetCount, allowedError: cap.countError, minimum, maximum },
      targetRarityLevels,
      extraCount: { minimum: 0, maximum: cap.extraMaximum },
      rareWordMaximumByTargetCount: Array.from({ length: maximum - minimum + 1 }, (_, offset) => {
        const count = minimum + offset;
        return [count, Math.min(count, Math.max(cap.previousRareCount, Math.ceil(count * cap.rareRate)))];
      }),
      requiredWords: [],
    },
    preferences: { targetWordLengths: [...rules.targetWordLengths],
      lengthBins: ['3', '4', '5', '6', '7', '8+'], targetLengthCounts: lengthCounts(rules.targetWordLengths),
      lengthShares: [...rules.lengthShares], rarityShares: [...rules.rarityShares],
      turnShares: rules.turnShares ? [...rules.turnShares] : null,
      turnsPerWord: rules.turnsPerWord, reversalsPerWord: rules.reversalsPerWord,
      positiveWordShare: rules.positiveWordShare,
      suggestedInitialWords: [...config.fixedWords], suggestedShapeId: planned.shapeId },
    };
  });
  return { schemaVersion: 1, id: 'level-constraints-2000-20261111',
    scope: { totalPositions: 2000, excludedPositions: [...excludedPositions], automaticPositions: records.length - excluded.size },
    common: {
      intrinsic: { minimumWordLength: 3, targetRarityLevels: [1, 2, 3, 4],
        targetWhitelist: 'current-dist-data-candidate-words', extraDictionary: 'current-dist-data-dictionaries',
        forbidTargetPlusSPairs: true, extraWordLengths: 'actual-target-length-set', enumerateAllExtras: true,
        paths: 'orthogonal-no-repeated-cell', coverAllEnabledCells: true, cellCountRange: [1, 35],
        requireAllChoicesComplete: true },
      sequence: { cooldown: { target: 50, extra: 50, crossType: true, advanceOn: 'accepted-position',
        minimumRepeatDistance: 51 }, uniqueBoards: true,
      specialShapes: { every: 5, slot: 5, allowedIds: [...SPECIAL_SHAPE_IDS],
        avoidPreviousSpecial: true, preferNearestActiveCellCount: true },
      topRowRuns: { maximumVisible: sequence.maxTopRun, maximumInvisible: sequence.maxNoTopRun,
        maximumAlternating: sequence.maxAlternatingRun } },
    },
    preferencePolicy: '用于候选排序，不把参考词长、拐弯和生僻比例误作逐关硬门槛；阶段范围单独硬检查。',
    metricDefinitions: { positive: '终点相对起点的行差加列差大于0', rare: '当前词库生僻档位≥3',
      longFive: '目标词长度≥5', straight: '实际目标路径0拐', twoPlus: '实际目标路径至少2拐',
      topVisible: '首行字母正读或反读连续出现完整目标词',
      stageWeighting: '各项目总量除以阶段目标词总数，不取逐关均值的平均数' },
    stages: phaseList, records, sources,
  };
}

export function measureConstraintLevel(level, dictionary) {
  const words = level.targetWords;
  const turns = words.map(entry => describePath(entry.path, level.columns).turns);
  const top = level.cells.slice(0, level.columns).map(cell => cell.letter || '-').join('');
  const reverse = [...top].reverse().join('');
  return { words: words.length,
    positive: words.filter(({ path }) => {
      const start = path[0], end = path.at(-1);
      return end % level.columns - start % level.columns +
        Math.floor(end / level.columns) - Math.floor(start / level.columns) > 0;
    }).length,
    rare: words.filter(entry => dictionary.get(entry.word)?.rarityLevel >= 3).length,
    letters: words.reduce((sum, entry) => sum + entry.word.length, 0),
    turns: turns.reduce((sum, count) => sum + count, 0),
    longFive: words.filter(entry => entry.word.length >= 5).length,
    straight: turns.filter(count => count === 0).length, twoPlus: turns.filter(count => count >= 2).length,
    topVisible: words.some(({ word }) => top.includes(word) || reverse.includes(word)),
    lengthCounts: lengthCounts(words.map(entry => entry.word.length)) };
}

// Full current-dictionary search is required; an incomplete candidate extra list
// must not silently become its own proof of completeness.
export function checkLevelConstraint(level, constraint, { dictionary, whitelist, foundWords }) {
  requireValue(constraint.mode === 'automatic', '人工保留关不参与自动约束检查。');
  requireValue(dictionary instanceof Map && whitelist instanceof Map && Array.isArray(foundWords),
    '需要当前词库、白名单及完整搜词结果。');
  const violations = [];
  const fail = (kind, code, detail) => violations.push({ kind, code, detail });
  let game;
  try {
    game = createGameExport([{ level }]).level[0];
    if (level.cells.map(cell => cell.count.toString(36)).join('') !== game.b) {
      fail('intrinsic', 'cellCounts', '格子次数与目标路径不一致。');
    }
  } catch (error) {
    fail('intrinsic', 'pathsOrCoverage', error.message);
    return { intrinsicValid: false, matchesPosition: false, violations, game: null, metrics: null };
  }
  const names = new Set(level.targetWords.map(entry => entry.word));
  requireValue(Array.isArray(constraint.hard.targetRarityLevels) && constraint.hard.targetRarityLevels.length > 0 &&
    constraint.hard.targetRarityLevels.every(level => [1, 2, 3, 4].includes(level)), '缺少有效的逐关目标档位硬约束。');
  for (const entry of level.targetWords) {
    const known = dictionary.get(entry.word);
    if (!known || known.onlyExtra || !whitelist.has(entry.word) || ![1, 2, 3, 4].includes(whitelist.get(entry.word)) ||
      ![1, 2, 3, 4].includes(known.rarityLevel) || entry.word.length < 3) {
      fail('intrinsic', 'targetDictionary', entry.word);
    }
    if (known && !constraint.hard.targetRarityLevels.includes(known.rarityLevel)) {
      fail('position', 'targetRarityLevel', entry.word + '（' + known.rarityLevel + '档）');
    }
    if (names.has(entry.word + 'S')) fail('intrinsic', 'pluralPair', entry.word + '/' + entry.word + 'S');
  }
  const allowedLengths = new Set([...names].map(word => word.length));
  for (const { word } of level.extraWords) {
    if (!dictionary.has(word) || word.length < 3) fail('intrinsic', 'extraDictionary', word);
    if (!allowedLengths.has(word.length)) fail('intrinsic', 'extraLength', word);
  }
  const expectedExtras = selectExtraWords(foundWords, level.targetWords).map(entry => entry.word).sort();
  if (!same(expectedExtras, level.extraWords.map(entry => entry.word).sort())) {
    fail('intrinsic', 'extraCompleteness', '额外词未按实际目标词长度完整收录。');
  }
  const mask = game.a.split(',').map(row => row.replace(/[A-Z]/g, '1').replaceAll('-', '0'));
  const shape = constraint.hard.board.options.find(option => same(option.boardMask, mask));
  if (!shape) fail('position', 'boardShape', '尺寸或造型不适合此关。');
  const count = level.targetWords.length, range = constraint.hard.targetCount;
  if (count < range.minimum || count > range.maximum) fail('position', 'targetCount', String(count));
  if (level.extraWords.length > constraint.hard.extraCount.maximum) fail('position', 'extraCount', String(level.extraWords.length));
  for (const word of constraint.hard.requiredWords) if (!names.has(word)) fail('position', 'requiredWord', word);
  const metrics = measureConstraintLevel(level, dictionary);
  const lengthAlignment = measureTargetLengthAlignment(level.targetWords, constraint.preferences.targetWordLengths);
  const lengthRule = constraint.hard.targetWordLength;
  if (lengthRule) {
    if (lengthAlignment.actual.some(length => length < lengthRule.minimum || length > lengthRule.maximum)) {
      fail('position', 'targetWordLength', { actual: lengthAlignment.actual, minimum: lengthRule.minimum, maximum: lengthRule.maximum });
    }
    if (lengthAlignment.letterDistance > lengthRule.maximumLetterDistance) {
      fail('position', 'targetLengthDistance', { actual: lengthAlignment.letterDistance, maximum: lengthRule.maximumLetterDistance });
    }
  }
  const rareLimit = new Map(constraint.hard.rareWordMaximumByTargetCount).get(count);
  if (rareLimit !== undefined && metrics.rare > rareLimit) fail('position', 'rareCount', String(metrics.rare));
  if (!violations.some(issue => issue.kind === 'intrinsic')) {
    const safety = analyzeTargetPaths(level);
    if (!safety.solvable || !safety.allChoicesComplete) fail('intrinsic', 'pathSafety', '存在不能完成的合法消词选择。');
  }
  return { intrinsicValid: !violations.some(issue => issue.kind === 'intrinsic'), matchesPosition: !violations.length,
    sequenceChecksRequired: true, violations, game, metrics, shapeId: shape?.shapeId ?? null,
    lengthAlignment, exactReferenceLengthCounts: same(metrics.lengthCounts, constraint.preferences.targetLengthCounts) };
}

// Audit a positional sequence, keeping unknown/manual positions as gaps. They
// neither compress the numbering nor count as known empty history.
export function checkConstraintSequence(plan, entries) {
  const byPosition = new Map(entries.map(entry => [entry.position, entry]));
  requireValue(byPosition.size === entries.length && entries.every(entry =>
    Number.isInteger(entry.position) && entry.position >= 1 && entry.position <= plan.records.length), '序列关号无效或重复。');
  const violations = [], lastSeen = new Map(), boards = new Map();
  const pending = { cooldownPositions: [], specialShapePositions: [], topRowPositions: [],
    unknownPositions: [], stages: [], boardUniquenessAgainstUnknownPositions: [] };
  const unknown = plan.records.filter(record => !byPosition.has(record.position)).map(record => record.position);
  pending.unknownPositions = unknown;
  pending.boardUniquenessAgainstUnknownPositions = unknown;
  const add = (position, code, detail) => violations.push({ position, code, detail });
  const lengthPolicy = plan.wordLengthPolicy;
  if (Number.isInteger(lengthPolicy?.maximumExceptions)) {
    const [from, to] = lengthPolicy.exceptionEligiblePositions;
    const positions = entries.filter(entry => entry.position >= from && entry.position <= to &&
      measureTargetLengthAlignment(entry.level.targetWords, plan.records[entry.position - 1].preferences.targetWordLengths)
        .letterDistance > lengthPolicy.maximumLetterDistance).map(entry => entry.position);
    if (positions.length > lengthPolicy.maximumExceptions) add(to, 'targetLengthExceptionCount',
      { positions, actual: positions.length, maximum: lengthPolicy.maximumExceptions });
  }
  const runs = plan.common.sequence.topRowRuns;
  let previous = null, run = 0, alternating = 1, openRun = false, openAlternating = false;
  for (const record of plan.records) {
    const position = record.position, entry = byPosition.get(position);
    if (!entry) { previous = null; run = 0; alternating = 1; openRun = true; openAlternating = true; continue; }
    const { level, game, metrics } = entry;
    if (boards.has(game.a)) add(position, 'duplicateBoard', { previousPosition: boards.get(game.a) });
    boards.set(game.a, position);
    const ranges = plan.common.sequence.cooldown;
    if (unknown.some(missing => missing < position && position - missing <= Math.max(ranges.target, ranges.extra))) {
      pending.cooldownPositions.push(position);
    }
    for (const kind of ['target', 'extra']) for (const { word } of level[kind + 'Words']) {
      const prior = lastSeen.get(word);
      if (prior !== undefined && position - prior <= ranges[kind]) add(position, kind + 'Cooldown', { word, previousPosition: prior });
    }
    for (const { word } of [...level.targetWords, ...level.extraWords]) lastSeen.set(word, position);
    if (previous !== null) {
      const equal = previous === metrics.topVisible;
      run = equal ? run + 1 : 1;
      alternating = equal ? 1 : alternating + 1;
      if (!equal) openRun = false;
      if (equal) openAlternating = false;
    } else { run = 1; alternating = 1; }
    if (openRun || openAlternating) pending.topRowPositions.push(position);
    if (run > (metrics.topVisible ? runs.maximumVisible : runs.maximumInvisible)) add(position, 'topRowRun', run);
    if (alternating > runs.maximumAlternating) add(position, 'topRowAlternating', alternating);
    previous = metrics.topVisible;
    if (record.mode !== 'automatic' || record.hard.board.selection !== 'nearest-excluding-previous-special') continue;
    const priorPosition = record.hard.board.previousSpecialPosition;
    const prior = byPosition.get(priorPosition);
    if (priorPosition >= 1 && !prior) pending.specialShapePositions.push(position);
    else {
      const eligible = closestSpecialShapes(record.reference.cells, prior?.shapeId ?? null).map(shape => shape.id);
      if (!eligible.includes(entry.shapeId)) add(position, 'specialShapeSelection', { actual: entry.shapeId, eligible, previousPosition: priorPosition });
    }
  }
  const stages = plan.stages.map(stage => {
    const missing = unknown.filter(position => position >= stage.from && position <= stage.to);
    if (missing.length) { pending.stages.push(stage.id); return { id: stage.id, status: 'pending', unknownPositions: missing }; }
    const rows = entries.filter(entry => entry.position >= stage.from && entry.position <= stage.to);
    const totals = Object.fromEntries(metricFields.map(field => [field, rows.reduce((sum, row) => sum + row.metrics[field], 0)]));
    const actual = Object.fromEntries(Object.keys(stage.ranges).map(field => [field, totals[field] / totals.words]));
    let passed = totals.words > 0;
    for (const [field, range] of Object.entries(stage.ranges)) {
      if (!Number.isFinite(actual[field]) || actual[field] < range.minimum - 1e-9 || actual[field] > range.maximum + 1e-9) {
        passed = false; add(stage.to, 'stageRange', { stageId: stage.id, field, actual: actual[field], range });
      }
    }
    return { id: stage.id, status: passed ? 'passed' : 'failed', totals, actual };
  });
  return { knownChecksPassed: violations.length === 0, complete: unknown.length === 0,
    checkedPositions: entries.length, violations, pending, stages };
}
