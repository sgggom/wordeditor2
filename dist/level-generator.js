import { calculateLevelStatistics, compareRepresentativePaths, describePath } from "./level-statistics.js";
import { createDuplicateCheck, findDuplicateWords } from "./level-rules.js";
import { validateFixedWords, normalizeFixedLayout, fixedLayoutLetters } from "./fixed-words.js";
import { createPathSafetyChecker } from "./path-safety.js";

function shuffled(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function validateSize(rows, columns) {
  if (!Number.isInteger(rows) || rows < 2 || rows > 3 ||
      !Number.isInteger(columns) || columns < 3 || columns > 5) {
    throw new Error("棋盘尺寸需为 2–3 行、3–5 列。");
  }
}

function validateTargetCount(targetCount) {
  if (!Number.isSafeInteger(targetCount) || targetCount < 1) {
    throw new Error("目标数量需为大于 0 的整数。");
  }
}

const TARGET_LENGTH_GROUPS = ["short", "medium", "long"];
const TARGET_LENGTH_LABELS = { short: "短词（3字母）", medium: "中词（4字母）", long: "长词（5字母及以上）" };
const GENERATION_BATCH_SIZE = 80;

export async function generateUntilComplete(generator, options, { onProgress = () => {}, isCurrent = () => true } = {}) {
  let attempts = 0;
  while (isCurrent()) {
    try {
      return generator.generate(options);
    } catch (error) {
      if (error.code !== "GENERATION_RETRY") throw error;
      attempts += error.attempts;
      if (!isCurrent()) return null;
      onProgress({ attempts });
    }
    // Yield between batches so a newer request can replace this search.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return null;
}

export function targetLengthGroup(length) {
  return length === 3 ? "short" : length === 4 ? "medium" : length >= 5 ? "long" : null;
}

export function countTargetLengthPlan(targetCount, plan) {
  validateTargetCount(targetCount);
  if (plan === null || plan === undefined) return null;
  if (!Array.isArray(plan) || plan.length !== targetCount) {
    throw new Error("逐个配置的词数需与目标数量一致。");
  }
  const counts = { short: 0, medium: 0, long: 0 };
  for (const group of plan) {
    if (!TARGET_LENGTH_GROUPS.includes(group)) throw new Error("每个目标词请选择短词、中词或长词。");
    counts[group] += 1;
  }
  return counts;
}

function resolveTargetLengths(targetCount, plan, legacyRatios) {
  const counts = countTargetLengthPlan(targetCount, plan);
  const ratios = counts ? null : normalizeTargetLengthRatios(legacyRatios);
  return { plan: counts ? [...plan] : null, ratios, counts: counts ?? allocateTargetLengths(targetCount, ratios) };
}

function normalizeTargetLengthRatios(ratios) {
  if (ratios === null || ratios === undefined) return null;
  if (typeof ratios !== "object" || Array.isArray(ratios) || Object.keys(ratios).length !== 3 ||
      TARGET_LENGTH_GROUPS.some(key => !Number.isInteger(ratios[key]) || ratios[key] < 0 || ratios[key] > 100)) {
    throw new Error("短、中、长词占比需为 0–100 的整数。");
  }
  if (TARGET_LENGTH_GROUPS.reduce((sum, key) => sum + ratios[key], 0) !== 100) {
    throw new Error("短、中、长词占比合计需为 100%。");
  }
  return Object.fromEntries(TARGET_LENGTH_GROUPS.map(key => [key, ratios[key]]));
}

export function allocateTargetLengths(targetCount, ratios) {
  validateTargetCount(targetCount);
  const normalized = normalizeTargetLengthRatios(ratios);
  if (!normalized) return null;
  const shares = TARGET_LENGTH_GROUPS.map((key, index) => ({
    key, index,
    count: Math.floor(targetCount / 100) * normalized[key] + Math.floor((targetCount % 100) * normalized[key] / 100),
    remainder: (targetCount % 100) * normalized[key] % 100,
  }));
  const remaining = targetCount - shares.reduce((sum, share) => sum + share.count, 0);
  const ranked = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remaining; index += 1) ranked[index].count += 1;
  return Object.fromEntries(shares.map(({ key, count }) => [key, count]));
}

function targetLengthQuotaError(message) {
  const error = new Error(message);
  error.code = "TARGET_LENGTH_QUOTA";
  return error;
}

function validateMaxWordLength(maxWordLength, label = "最长单词长度") {
  if (!Number.isSafeInteger(maxWordLength) || maxWordLength < 1) {
    throw new Error(`${label}需为大于 0 的整数。`);
  }
}

function validateInitialForwardProbability(probability) {
  if (!Number.isInteger(probability) || probability < 0 || probability > 100) {
    throw new Error("初始正向概率需为 0–100 的整数。");
  }
}

const FILTER_LABELS = Object.freeze({ scope: "范围库", emotion: "情绪类型", abbreviation: "是否缩写", rarityLevel: "生僻档位" });

function normalizeFilters(filters = {}) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters) ||
      Object.keys(filters).some(key => !Object.hasOwn(FILTER_LABELS, key))) {
    throw new Error("词库筛选配置无效。");
  }
  const result = {};
  for (const [key, label] of Object.entries(FILTER_LABELS)) {
    if (filters[key] === undefined || filters[key] === null) continue;
    if (!Array.isArray(filters[key]) || filters[key].some(value => !Number.isSafeInteger(value))) {
      throw new Error(`${label}筛选需为整数列表。`);
    }
    result[key] = [...new Set(filters[key])].sort((a, b) => a - b);
  }
  return result;
}

function matchesFilters(entry, filters) {
  return Object.entries(filters).every(([key, values]) => values.includes(entry[key]));
}

function initialWordFilters(filters, rarityLevel) {
  const normalized = normalizeFilters(filters);
  if (rarityLevel === null) return normalized;
  if (!Number.isInteger(rarityLevel) || rarityLevel < 1 || rarityLevel > 5) throw new Error("初始词生僻档位需为 1–5 的整数。");
  return { ...normalized, rarityLevel: normalized.rarityLevel?.filter(value => value === rarityLevel) ?? [rarityLevel] };
}

function countBits(mask) {
  let count = 0;
  while (mask) {
    mask &= mask - 1;
    count += 1;
  }
  return count;
}

export function createGenerator(records, onlyExtraRecords = []) {
  const dictionary = new Map();
  for (const [source, onlyExtra] of [[records, false], [onlyExtraRecords, true]]) {
    for (const record of source) {
      if (typeof record.word !== "string" || !/^[A-Z]+$/.test(record.word)) continue;
      const existing = dictionary.get(record.word);
      dictionary.set(record.word, {
        ...existing,
        ...record,
        id: record.id ?? existing?.id ?? record.word,
        word: record.word,
        onlyExtra: onlyExtra || record.onlyExtra === true || existing?.onlyExtra === true,
      });
    }
  }
  if (!dictionary.size) throw new Error("词库没有可用单词。");

  const eligible = [...dictionary.values()].filter(entry => !entry.onlyExtra);
  const lengths = new Set([...dictionary.keys()].map(word => word.length));
  let cachedPool;

  function getPool(filters) {
    const normalized = normalizeFilters(filters);
    const key = JSON.stringify(normalized);
    if (cachedPool?.key === key) return cachedPool;
    const entries = eligible.filter(entry => matchesFilters(entry, normalized));
    const byLength = new Map();
    const byPosition = new Map();
    for (const entry of entries) {
      const length = entry.word.length;
      if (!byLength.has(length)) byLength.set(length, []);
      byLength.get(length).push(entry);
      for (let index = 0; index < length; index += 1) {
        const positionKey = `${length}:${index}:${entry.word[index]}`;
        if (!byPosition.has(positionKey)) byPosition.set(positionKey, []);
        byPosition.get(positionKey).push(entry);
      }
    }
    cachedPool = { key, entries, byLength, byPosition, filters: normalized };
    return cachedPool;
  }
  const geometryCache = new Map();

  function geometry(rows, columns) {
    validateSize(rows, columns);
    const key = `${rows}:${columns}`;
    if (geometryCache.has(key)) return geometryCache.get(key);
    const total = rows * columns;
    const maximum = Math.min(total, Math.max(...lengths));
    const neighbors = Array.from({ length: total }, (_, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      return [row > 0 ? index - columns : -1, row < rows - 1 ? index + columns : -1,
        column > 0 ? index - 1 : -1, column < columns - 1 ? index + 1 : -1]
        .filter(cell => cell >= 0);
    });
    const routes = [];
    const path = [];
    function visit(index, mask) {
      mask |= 1 << index;
      path.push(index);
      if (lengths.has(path.length)) routes.push({ path: [...path], mask });
      if (path.length < maximum) {
        for (const next of neighbors[index]) {
          if (!(mask & (1 << next))) visit(next, mask);
        }
      }
      path.pop();
    }
    for (let index = 0; index < total; index += 1) visit(index, 0);
    geometryCache.set(key, routes);
    return routes;
  }

  function matchPlacement(path, letters, used, random, { byLength, byPosition }, fixedEntry = null) {
    let options = fixedEntry ? [fixedEntry] : byLength.get(path.length);
    if (!options) return null;
    for (let position = 0; position < path.length; position += 1) {
      const letter = letters[path[position]];
      if (!letter) continue;
      const matching = byPosition.get(`${path.length}:${position}:${letter}`);
      if (!matching) return null;
      if (matching.length < options.length) options = matching;
    }
    const start = Math.floor(random() * options.length);
    for (let offset = 0; offset < options.length; offset += 1) {
      const entry = options[(start + offset) % options.length];
      if (!used.has(entry.word) && path.every((cell, index) => !letters[cell] || letters[cell] === entry.word[index])) {
        return { ...entry, path: [...path] };
      }
    }
    return null;
  }

  // Stage 1: consider all legal routes, preferring the greatest number of empty cells.
  function findPlacement({ rows, columns, letters, usedWords = [], initialMaxWordLength = 8, maxWordLength = 8, initialForwardProbability = 50, initialRarityLevel = null, remainingTargetLengths = null, filters = {}, fixedWord = null, random = Math.random }) {
    validateMaxWordLength(initialMaxWordLength, "初始词最长");
    validateMaxWordLength(maxWordLength);
    validateInitialForwardProbability(initialForwardProbability);
    const pool = getPool(initialWordFilters(filters, initialRarityLevel));
    const fixedEntry = fixedWord ? pool.entries.find(entry => entry.word === fixedWord) : null;
    if (fixedWord && !fixedEntry) return null;
    const routes = geometry(rows, columns);
    const used = new Set(usedWords);
    const emptyMask = letters.reduce((mask, letter, index) => letter ? mask : mask | (1 << index), 0);
    if (!emptyMask && !fixedEntry) return null;
    const directions = random() < initialForwardProbability / 100 ? ["forward", "reverse"] : ["reverse", "forward"];
    const buckets = Array.from({ length: letters.length + 1 }, () => ({ forward: [], reverse: [] }));
    for (const route of routes) {
      if (fixedEntry && route.path.length !== fixedEntry.word.length) continue;
      if (route.path.length > Math.min(initialMaxWordLength, maxWordLength) || !pool.byLength.has(route.path.length)) continue;
      if (remainingTargetLengths && !(remainingTargetLengths[targetLengthGroup(route.path.length)] > 0)) continue;
      const emptyCount = countBits(route.mask & emptyMask);
      if (emptyCount > 0 || fixedEntry) {
        // On an orthogonal route, an increasing cell index starts right or down.
        const direction = route.path[1] > route.path[0] ? "forward" : "reverse";
        buckets[emptyCount][direction].push(route);
      }
    }
    for (let added = buckets.length - 1; added >= 0; added -= 1) {
      for (const direction of directions) {
        for (const route of shuffled(buckets[added][direction], random)) {
          const placement = matchPlacement(route.path, letters, used, random, pool, fixedEntry);
          if (placement) return placement;
        }
      }
    }
    return null;
  }

  function fillBoard({ rows, columns, initialMaxWordLength, maxWordLength, initialForwardProbability, initialRarityLevel, targetLengthCounts, filters, fixedWords, fixedLayout, random }) {
    const placements = fixedLayout?.placements ?? [];
    const letters = fixedLayoutLetters(rows, columns, placements);
    const initialWords = placements.map(({ word, path }) => ({ ...dictionary.get(word), path: [...path] }));
    const remainingTargetLengths = targetLengthCounts ? { ...targetLengthCounts } : null;
    const pinned = new Set(initialWords.map(entry => entry.word));
    if (remainingTargetLengths) for (const { word } of initialWords) remainingTargetLengths[targetLengthGroup(word.length)] -= 1;
    // Place every preset first, including words fully sharing letters with another preset.
    for (const word of shuffled(fixedWords.filter(word => !pinned.has(word)), random).sort((a, b) => b.length - a.length)) {
      const placement = findPlacement({ rows, columns, letters, usedWords: initialWords.map(entry => entry.word),
        initialMaxWordLength, maxWordLength, initialForwardProbability, initialRarityLevel, remainingTargetLengths,
        filters, fixedWord: word, random });
      if (!placement) return null;
      placement.path.forEach((cell, index) => { letters[cell] = placement.word[index]; });
      initialWords.push(placement);
      if (remainingTargetLengths) remainingTargetLengths[targetLengthGroup(word.length)] -= 1;
    }
    while (letters.includes("")) {
      const placement = findPlacement({ rows, columns, letters, usedWords: initialWords.map(entry => entry.word), initialMaxWordLength, maxWordLength, initialForwardProbability, initialRarityLevel, remainingTargetLengths, filters, random });
      if (!placement) return null;
      placement.path.forEach((cell, index) => { letters[cell] = placement.word[index]; });
      initialWords.push(placement);
      if (remainingTargetLengths) remainingTargetLengths[targetLengthGroup(placement.word.length)] -= 1;
    }
    return { letters, initialWords };
  }

  // Stage 2: retain the assigned route and analyze all legal routes, with no cell counters.
  function findWords({ rows, columns, letters, initialWords = [] }) {
    const routes = geometry(rows, columns);
    if (letters.length !== rows * columns || letters.some(letter => !/^[A-Z]$/.test(letter))) {
      throw new Error("请先填满棋盘，再查找候选词。");
    }
    const placed = new Map(initialWords.map(entry => [entry.word, entry]));
    const found = new Map();
    const cellMasks = new Map();
    for (const { path, mask } of routes) {
      const word = path.map(cell => letters[cell]).join("");
      const entry = dictionary.get(word);
      if (!entry) continue;
      if (!found.has(word)) {
        cellMasks.set(word, mask);
        const assignedPath = [...(placed.get(word)?.path ?? path)];
        found.set(word, {
          ...entry, path: assignedPath,
          pathAnalysis: { legalPathCount: 0, safe: true, assigned: describePath(assignedPath, columns), representative: null },
        });
      }
      const analysis = found.get(word).pathAnalysis;
      const description = describePath(path, columns);
      analysis.legalPathCount += 1;
      if (cellMasks.get(word) !== mask) analysis.safe = false;
      if (!analysis.representative || compareRepresentativePaths(description, analysis.representative) < 0) {
        analysis.representative = description;
      }
    }
    return [...found.values()].sort((a, b) => a.word.localeCompare(b.word));
  }

  // Stage 3: keep placed words and promote the lowest-scoring eligible paths, with random ties.
  function selectTargets({ rows, columns, letters, initialWords, foundWords, targetCount, targetLengthPlan = null, targetLengthRatios = null, maxWordLength = 8, filters = {}, random = Math.random }) {
    validateTargetCount(targetCount);
    validateMaxWordLength(maxWordLength);
    const { plan, ratios, counts: targetLengthCounts } = resolveTargetLengths(targetCount, targetLengthPlan, targetLengthRatios);
    const normalized = normalizeFilters(filters);
    const initialNames = new Set(initialWords.map(entry => entry.word));
    const foundByWord = new Map(foundWords.map(entry => [entry.word, entry]));
    const checkPath = createPathSafetyChecker({ rows, columns, letters });
    const isSafe = entry => entry?.pathAnalysis?.safe ?? (entry ? checkPath(entry.word) : false);
    const canTarget = entry => {
      const record = dictionary.get(entry.word);
      return record?.onlyExtra === false && record.word.length <= maxWordLength &&
        (!targetLengthCounts || targetLengthGroup(record.word.length) !== null) && matchesFilters(record, normalized);
    };
    if (initialNames.size !== initialWords.length || initialWords.some(entry => !canTarget(entry))) {
      throw new Error("初始词不能重复、包含仅额外词、超出最长单词长度或不符合词库筛选。");
    }
    const unsafeInitial = initialWords.find(entry => !isSafe(foundByWord.get(entry.word)));
    if (unsafeInitial) {
      const error = new Error(`初始词 ${unsafeInitial.word} 存在使用不同格子的连接路径，需重新生成棋盘。`);
      error.code = "UNSAFE_INITIAL_PATH";
      throw error;
    }
    initialWords = initialWords.map(entry => ({ ...foundByWord.get(entry.word), ...entry,
      pathAnalysis: foundByWord.get(entry.word).pathAnalysis }));
    const candidateWords = foundWords.filter(entry => canTarget(entry) && isSafe(entry));
    const additional = candidateWords.filter(entry => !initialNames.has(entry.word));
    const needed = targetCount - initialWords.length;
    if (needed < 0) throw new Error(`目标数量不能少于已填入的 ${initialWords.length} 个初始词。`);
    if (additional.length < needed) throw new Error(`可用目标词只有 ${candidateWords.length} 个，少于设置的 ${targetCount} 个。`);
    const ranked = shuffled(additional, random).sort((a, b) =>
      a.pathAnalysis.assigned.difficultyScore - b.pathAnalysis.assigned.difficultyScore
    );
    let promoted = ranked.slice(0, needed);
    if (targetLengthCounts) {
      const remaining = { ...targetLengthCounts };
      for (const entry of initialWords) remaining[targetLengthGroup(entry.word.length)] -= 1;
      for (const key of TARGET_LENGTH_GROUPS) {
        if (remaining[key] < 0) throw targetLengthQuotaError(`已填入的${TARGET_LENGTH_LABELS[key]}超过配置的 ${targetLengthCounts[key]} 个。`);
        const available = ranked.filter(entry => targetLengthGroup(entry.word.length) === key).length;
        if (available < remaining[key]) throw targetLengthQuotaError(`${TARGET_LENGTH_LABELS[key]}还需 ${remaining[key]} 个，棋盘上可补选的只有 ${available} 个。`);
      }
      promoted = ranked.filter(entry => {
        const key = targetLengthGroup(entry.word.length);
        if (remaining[key] <= 0) return false;
        remaining[key] -= 1;
        return true;
      });
    }
    let targetWords = [...initialWords, ...promoted];
    if (plan) {
      const groups = Object.fromEntries(TARGET_LENGTH_GROUPS.map(key => [key,
        targetWords.filter(entry => targetLengthGroup(entry.word.length) === key)]));
      targetWords = plan.map(key => groups[key].shift());
    }
    const targetNames = new Set(targetWords.map(entry => entry.word));
    const extraWords = foundWords.filter(entry => !targetNames.has(entry.word));
    const cells = letters.map(letter => ({ letter, count: 0 }));
    for (const entry of targetWords) {
      for (const cell of entry.path) cells[cell].count += 1;
    }
    const level = { rows, columns, targetCount, targetLengthPlan: plan, targetLengthRatios: ratios, targetLengthCounts, maxWordLength, filters: normalized, cells, initialWords, candidateWords, targetWords, extraWords };
    return { ...level, statistics: calculateLevelStatistics(level) };
  }

  function generate({ rows, columns, targetCount = 6, targetLengthPlan = null, targetLengthRatios = null, initialMaxWordLength = 8, maxWordLength = 8, initialForwardProbability = 50, initialRarityLevel = null, minimumEmotionScore = null, filters = {}, fixedWords = [], fixedLayout = null, duplicateCheck = createDuplicateCheck([], { target: 0, extra: 0 }), random = Math.random }) {
    validateSize(rows, columns);
    validateTargetCount(targetCount);
    validateMaxWordLength(initialMaxWordLength, "初始词最长");
    validateMaxWordLength(maxWordLength);
    validateInitialForwardProbability(initialForwardProbability);
    if (minimumEmotionScore !== null && !Number.isFinite(minimumEmotionScore)) throw new Error("情绪总分下限需为有效数字。");
    const { plan, ratios, counts: targetLengthCounts } = resolveTargetLengths(targetCount, targetLengthPlan, targetLengthRatios);
    fixedWords = validateFixedWords({ rows, columns, targetCount, initialMaxWordLength, maxWordLength, fixedWords }, targetLengthCounts);
    fixedLayout = normalizeFixedLayout({ rows, columns, fixedWords, fixedLayout });
    const pinned = new Set(fixedLayout?.placements.map(entry => entry.word) ?? []);
    const pinnedLetters = fixedLayoutLetters(rows, columns, fixedLayout?.placements ?? []);
    const fullyPinned = pinnedLetters.every(Boolean);
    const fixedCoverage = pinnedLetters.filter(Boolean).length +
      fixedWords.filter(word => !pinned.has(word)).reduce((sum, word) => sum + word.length, 0);
    const pool = getPool(filters);
    const initialPool = getPool(initialWordFilters(filters, initialRarityLevel));
    const fixedNames = new Set(fixedWords);
    const duplicateTargets = new Set(duplicateCheck.target.range > 0 ? duplicateCheck.target.words.map(word => word.toUpperCase()) : []);
    for (const word of fixedWords) {
      const entry = dictionary.get(word);
      if (!entry) throw new Error(`固定单词 ${word} 不在词库中。`);
      if (entry.onlyExtra) throw new Error(`固定单词 ${word} 属于仅额外词，不能作为初始词。`);
      if (!matchesFilters(entry, pool.filters)) throw new Error(`固定单词 ${word} 不符合当前词库筛选。`);
      if (initialRarityLevel !== null && entry.rarityLevel !== initialRarityLevel) throw new Error(`固定单词 ${word} 不符合初始词生僻档位 ${initialRarityLevel}。`);
      if (duplicateTargets.has(word)) throw new Error(`固定单词 ${word} 与最近 ${duplicateCheck.target.range} 关的目标词重复，请调整固定词或查重范围。`);
    }
    if (!pool.entries.length) throw new Error("筛选后没有可用的初始词，请调整词库筛选。");
    if (!initialPool.entries.length) throw new Error("当前词库筛选与初始词生僻档位下没有可用的初始词。");
    const placementLimit = Math.min(initialMaxWordLength, maxWordLength);
    const usableLengths = [...initialPool.byLength.keys()].filter(length => length <= rows * columns && length <= placementLimit &&
      (!targetLengthCounts || targetLengthCounts[targetLengthGroup(length)] > 0));
    if (!usableLengths.length) throw new Error(`当前筛选、目标词长配置、尺寸及长度限制（初始 ${initialMaxWordLength}，目标 ${maxWordLength}）下没有可用的初始词。`);
    const minimum = Math.ceil(rows * columns / Math.max(...usableLengths));
    if (targetCount < minimum) throw new Error(`覆盖棋盘至少需要 ${minimum} 个初始词，请增加目标数量。`);
    const eligibleTargetCount = pool.entries.filter(entry => entry.word.length <= Math.min(maxWordLength, rows * columns) &&
      (!targetLengthCounts || targetLengthGroup(entry.word.length) !== null)).length;
    if (targetCount > eligibleTargetCount) throw new Error(`筛选及最长单词长度限制后只有 ${eligibleTargetCount} 个可用目标词，少于设置的 ${targetCount} 个。`);
    if (!targetLengthCounts) {
      const maximumCoverage = fixedCoverage + initialPool.entries.filter(entry => !fixedNames.has(entry.word)).map(entry => entry.word.length)
        .filter(length => length <= Math.min(placementLimit, rows * columns))
        .sort((a, b) => b - a).slice(0, targetCount - fixedWords.length).reduce((sum, length) => sum + length, 0);
      if (maximumCoverage < rows * columns) throw new Error("当前可用的初始词无法填满棋盘，请调整目标数量、长度或词库筛选。");
    }
    if (targetLengthCounts) {
      let maximumCoverage = fixedCoverage;
      for (const key of TARGET_LENGTH_GROUPS) {
        const available = pool.entries.filter(entry => entry.word.length <= Math.min(maxWordLength, rows * columns) && targetLengthGroup(entry.word.length) === key);
        if (available.length < targetLengthCounts[key]) throw new Error(`${TARGET_LENGTH_LABELS[key]}需 ${targetLengthCounts[key]} 个，当前筛选和最长单词长度下只有 ${available.length} 个可用。`);
        const remaining = targetLengthCounts[key] - fixedWords.filter(word => targetLengthGroup(word.length) === key).length;
        const initialLengths = initialPool.entries.filter(entry => !fixedNames.has(entry.word) && entry.word.length <= Math.min(placementLimit, rows * columns) && targetLengthGroup(entry.word.length) === key)
          .map(entry => entry.word.length)
          .sort((a, b) => b - a).slice(0, remaining);
        maximumCoverage += initialLengths.reduce((sum, length) => sum + length, 0);
      }
      if (maximumCoverage < rows * columns) throw new Error("当前目标词长配置与初始词最长限制无法填满棋盘，请调整配置。");
    }

    let bestCandidateCount = 0;
    let fewestInitial = Infinity;
    let lengthFailure = "";
    let duplicateFailure = false;
    let emotionFailure = false;
    let unsafeInitialWord = "";
    for (let attempt = 0; attempt < GENERATION_BATCH_SIZE; attempt += 1) {
      const filled = fillBoard({ rows, columns, initialMaxWordLength, maxWordLength, initialForwardProbability, initialRarityLevel, targetLengthCounts, filters: pool.filters, fixedWords, fixedLayout, random });
      if (!filled) {
        if (fullyPinned) throw new Error("固定棋盘无法连接全部固定单词，请调整摆放位置。");
        continue;
      }
      fewestInitial = Math.min(fewestInitial, filled.initialWords.length);
      if (filled.initialWords.length > targetCount) continue;
      const foundWords = findWords({ rows, columns, ...filled });
      const unsafeInitial = foundWords.find(entry => !entry.pathAnalysis.safe && filled.initialWords.some(initial => initial.word === entry.word));
      if (unsafeInitial) {
        if (fullyPinned) throw new Error(`固定棋盘中的 ${unsafeInitial.word} 存在使用不同格子的路径，请调整摆放位置。`);
        unsafeInitialWord = unsafeInitial.word; continue;
      }
      const candidateCount = foundWords.filter(entry => entry.pathAnalysis.safe && !entry.onlyExtra && entry.word.length <= maxWordLength &&
        (!targetLengthCounts || targetLengthGroup(entry.word.length) !== null) && matchesFilters(entry, pool.filters)).length;
      bestCandidateCount = Math.max(bestCandidateCount, candidateCount);
      if (candidateCount < targetCount) {
        if (fullyPinned) throw new Error(`固定棋盘只有 ${candidateCount} 个可用目标词，少于设置的 ${targetCount} 个，请调整布局或目标数量。`);
        continue;
      }
      try {
        const result = selectTargets({ rows, columns, ...filled, foundWords, targetCount, targetLengthPlan: plan, targetLengthRatios: ratios, maxWordLength, filters: pool.filters, random });
        if (minimumEmotionScore !== null && (!Number.isFinite(result.statistics.emotion.total) || result.statistics.emotion.total < minimumEmotionScore)) {
          if (fullyPinned && fixedWords.length === targetCount) throw new Error(`固定棋盘的目标词已全部确定，情绪总分未达到 ${minimumEmotionScore}，请调整布局。`);
          emotionFailure = true;
          continue;
        }
        const duplicates = findDuplicateWords(result, duplicateCheck);
        if (duplicates.target.length || duplicates.extra.length) {
          duplicateFailure = true;
          continue;
        }
        return { ...result, initialMaxWordLength, initialForwardProbability, initialRarityLevel, minimumEmotionScore, fixedWords: [...fixedWords], fixedLayout: structuredClone(fixedLayout),
          duplicateCheck: Object.fromEntries(["target", "extra"].map(kind => [kind, {
            range: duplicateCheck[kind].range, levelIds: [...duplicateCheck[kind].levelIds],
          }])) };
      } catch (error) {
        if (error.code !== "TARGET_LENGTH_QUOTA") throw error;
        if (fullyPinned) throw new Error(`固定棋盘无法满足目标词长配置：${error.message}`);
        lengthFailure = error.message;
      }
    }
    let reason = "本轮未能用初始词填满棋盘。";
    if (duplicateFailure) reason = "本轮生成的关卡与查重范围内的关卡存在重复单词。";
    else if (emotionFailure) reason = `本轮生成的关卡情绪总分未达到 ${minimumEmotionScore}。`;
    else if (lengthFailure) reason = `本轮未满足目标词长配置：${lengthFailure}`;
    else if (unsafeInitialWord) reason = `本轮初始词 ${unsafeInitialWord} 存在使用不同格子的连接路径。`;
    else if (Number.isFinite(fewestInitial) && fewestInitial > targetCount) {
      reason = `本轮摆词最少用了 ${fewestInitial} 个初始词，多于设置的 ${targetCount} 个目标词。`;
    } else if (bestCandidateCount > 0) {
      reason = `本轮尝试最多找到 ${bestCandidateCount} 个可用目标词，少于设置的 ${targetCount} 个。`;
    }
    const error = new Error(reason);
    error.code = "GENERATION_RETRY";
    error.attempts = GENERATION_BATCH_SIZE;
    throw error;
  }

  return { generate, findPlacement, findWords, selectTargets };
}
