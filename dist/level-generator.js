import { createPathSafetyChecker } from "./path-safety.js";
import { normalizeDisabledCells } from "./board-shape.js";
import { calculateLevelStatistics, compareRepresentativePaths, describePath } from "./level-statistics.js";
import { createDuplicateCheck, findDuplicateWords } from "./level-rules.js";
import { validateFixedWords, normalizeFixedLayout, fixedLayoutLetters, normalizeFixedWordExemptions } from "./fixed-words.js";

function shuffled(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function validateSize(rows, columns) {
  if (!Number.isInteger(rows) || rows < 2 || rows > 5 ||
      !Number.isInteger(columns) || columns < 2 || columns > 5) {
    throw new Error("棋盘尺寸需为 2–5 行、2–5 列。");
  }
}

function validateTargetCount(targetCount) {
  if (!Number.isSafeInteger(targetCount) || targetCount < 1) {
    throw new Error("目标数量需为大于 0 的整数。");
  }
}

// Historical reference presets retain their original length annotations.
// These helpers do not constrain generation.
const TARGET_LENGTH_GROUPS = ["short", "medium", "long"];
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

function matchesFilters(entry, filters, exempt = false) {
  return Object.entries(filters).every(([key, values]) => (exempt && (key === "scope" || key === "rarityLevel")) || values.includes(entry[key]));
}

function initialWordFilters(filters, rarityLevel) {
  const normalized = normalizeFilters(filters);
  if (rarityLevel === null) return normalized;
  if (!Number.isInteger(rarityLevel) || rarityLevel < 1 || rarityLevel > 5) throw new Error("初始词生僻档位需为 1–5 的整数。");
  return { ...normalized, rarityLevel: normalized.rarityLevel?.filter(value => value === rarityLevel) ?? [rarityLevel] };
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
  let cachedPool;

  function getPool(filters, exemptions = new Set()) {
    const normalized = normalizeFilters(filters);
    const key = JSON.stringify([normalized, [...exemptions].sort()]);
    if (cachedPool?.key === key) return cachedPool;
    const entries = eligible.filter(entry => matchesFilters(entry, normalized, exemptions.has(entry.word)));
    cachedPool = { key, entries, filters: normalized };
    return cachedPool;
  }
  const prefixes = new Set();
  for (const word of dictionary.keys()) for (let length = 1; length <= word.length; length++) prefixes.add(word.slice(0, length));

  function boardGeometry(rows, columns, disabledCells) {
    validateSize(rows, columns);
    const disabled = new Set(disabledCells);
    const cells = Array.from({ length: rows * columns }, (_, cell) => cell).filter(cell => !disabled.has(cell));
    const neighbors = Array.from({ length: rows * columns }, (_, cell) => {
      if (disabled.has(cell)) return [];
      const row = Math.floor(cell / columns), column = cell % columns;
      return [row > 0 ? cell - columns : -1, row < rows - 1 ? cell + columns : -1,
        column > 0 ? cell - 1 : -1, column < columns - 1 ? cell + 1 : -1]
        .filter(next => next >= 0 && !disabled.has(next));
    });
    return { cells, neighbors };
  }

  function shapeSupportsWords(rows, columns, disabledCells, minimumLength) {
    const { cells, neighbors } = boardGeometry(rows, columns, disabledCells);
    const all = cells.reduce((mask, cell) => mask | (1 << cell), 0);
    let covered = 0;
    function visit(cell, mask, length) {
      mask |= 1 << cell;
      if (length === minimumLength) { covered |= mask; return; }
      for (const next of neighbors[cell]) {
        if (covered === all) return;
        if (!(mask & (1 << next))) visit(next, mask, length + 1);
      }
    }
    for (const cell of cells) {
      visit(cell, 0, 1);
      if (covered === all) return true;
    }
    return false;
  }

  // Search candidate words and routes lazily. Long words can use the whole
  // enabled board without materializing every possible 5 × 5 route first.
  function findPlacement({ rows, columns, disabledCells = [], letters, usedWords = [], initialForwardProbability = 50,
    initialRarityLevel = null, filters = {}, fixedWord = null, fixedWordExemptions = [], random = Math.random }) {
    validateInitialForwardProbability(initialForwardProbability);
    const { cells, neighbors } = boardGeometry(rows, columns, disabledCells);
    const used = new Set(usedWords);
    const pool = getPool(initialWordFilters(filters, initialRarityLevel), new Set(fixedWordExemptions));
    const options = pool.entries.filter(entry => !used.has(entry.word) && entry.word.length <= cells.length && (!fixedWord || entry.word === fixedWord));
    if (!options.length) return null;
    const emptyCount = cells.filter(cell => !letters[cell]).length;
    if (!emptyCount && !fixedWord) return null;
    const knownCount = cells.length - emptyCount;
    const directions = random() < initialForwardProbability / 100 ? ["forward", "reverse"] : ["reverse", "forward"];
    const candidates = shuffled(options, random);
    const starts = shuffled(cells, random);
    const nextCells = neighbors.map(items => shuffled(items, random));
    const maximumAdded = Math.min(emptyCount, Math.max(...options.map(entry => entry.word.length)));
    const minimumAdded = fixedWord ? 0 : 1;
    function acceptsPlacement(word, path) {
      const nextLetters = [...letters];
      path.forEach((cell, index) => { nextLetters[cell] = word[index]; });
      const isSafe = createPathSafetyChecker({ rows, columns, disabledCells, letters: nextLetters }, { allowEmpty: true });
      return isSafe(word) && usedWords.every(existing => isSafe(existing));
    }
    for (let added = maximumAdded; added >= minimumAdded; added--) {
      for (const direction of directions) {
        for (const entry of candidates) {
          const { word } = entry;
          if (word.length < added || word.length > knownCount + added) continue;
          const path = [];
          function visit(cell, mask, filled) {
            if (letters[cell] && letters[cell] !== word[path.length]) return null;
            filled += letters[cell] ? 0 : 1;
            const remaining = word.length - path.length - 1;
            if (filled > added || filled + remaining < added) return null;
            path.push(cell); mask |= 1 << cell;
            let result = null;
            if (!remaining) {
              if (acceptsPlacement(word, path)) result = { ...entry, path: [...path] };
            } else {
              for (const next of nextCells[cell]) {
                if (mask & (1 << next)) continue;
                if (path.length === 1 && (next > cell ? "forward" : "reverse") !== direction) continue;
                result = visit(next, mask, filled);
                if (result) break;
              }
            }
            path.pop();
            return result;
          }
          for (const cell of starts) {
            const placement = visit(cell, 0, 0);
            if (placement) return placement;
          }
        }
      }
    }
    return null;
  }

  function fillBoard({ rows, columns, disabledCells, initialForwardProbability, initialRarityLevel, filters, fixedWords, fixedLayout, fixedWordExemptions, random }) {
    const placements = fixedLayout?.placements ?? [];
    const letters = fixedLayoutLetters(rows, columns, placements);
    const initialWords = placements.map(({ word, path }) => ({ ...dictionary.get(word), path: [...path] }));
    const pinned = new Set(initialWords.map(entry => entry.word));
    const place = fixedWord => {
      const placement = findPlacement({ rows, columns, disabledCells, letters, usedWords: initialWords.map(entry => entry.word),
        initialForwardProbability, initialRarityLevel, filters, fixedWord, fixedWordExemptions, random });
      if (!placement) return false;
      placement.path.forEach((cell, index) => { letters[cell] = placement.word[index]; });
      initialWords.push(placement);
      return true;
    };
    for (const word of shuffled(fixedWords.filter(word => !pinned.has(word)), random).sort((a, b) => b.length - a.length)) {
      if (!place(word)) return null;
    }
    while (letters.some((letter, index) => !letter && !disabledCells.includes(index))) {
      if (!place(null)) return null;
    }
    return { letters, initialWords };
  }

  // Stage 2: retain the assigned route and analyze all legal routes, with no cell counters.
  function findWords({ rows, columns, letters, initialWords = [], disabledCells = [] }) {
    const disabled = new Set(disabledCells);
    if (letters.length !== rows * columns || letters.some((letter, cell) => !disabled.has(cell) && !/^[A-Z]$/.test(letter))) {
      throw new Error("请先填满棋盘，再查找候选词。");
    }
    const placed = new Map(initialWords.map(entry => [entry.word, entry]));
    const found = new Map();
    const cellMasks = new Map();
    // Walk dictionary prefixes to avoid enumerating every route on a 5 × 5 board.
    const routes = [];
    function visit(cell, word, path, mask) {
      if (disabled.has(cell) || (mask & (1 << cell))) return;
      word += letters[cell];
      if (!prefixes.has(word)) return;
      path = [...path, cell]; mask |= 1 << cell;
      if (dictionary.has(word)) routes.push({ path, mask });
      const row = Math.floor(cell / columns), column = cell % columns;
      for (const next of [row > 0 ? cell - columns : -1, row < rows - 1 ? cell + columns : -1,
        column > 0 ? cell - 1 : -1, column < columns - 1 ? cell + 1 : -1]) {
        if (next >= 0) visit(next, word, path, mask);
      }
    }
    for (let cell = 0; cell < letters.length; cell++) visit(cell, "", [], 0);
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

  // Keep the covering initial words selected; expose all safe, eligible
  // candidates for manual selection without quantity or length quotas.
  function selectTargets({ rows, columns, disabledCells = [], letters, initialWords, foundWords,
    filters = {}, fixedWords = [], fixedWordExemptions = [] }) {
    const normalized = normalizeFilters(filters);
    const initialNames = new Set(initialWords.map(entry => entry.word));
    const exemptions = new Set(normalizeFixedWordExemptions({ fixedWords, fixedWordExemptions }));
    if ([...exemptions].some(word => !initialNames.has(word))) throw new Error("豁免词必须是已摆入的初始固定词。");
    const foundByWord = new Map(foundWords.map(entry => [entry.word, entry]));
    const safePath = createPathSafetyChecker({ rows, columns, letters, disabledCells });
    const canTarget = entry => {
      const record = dictionary.get(entry.word);
      return record?.onlyExtra === false && safePath(entry.word) && matchesFilters(record, normalized, exemptions.has(record.word));
    };
    const unsafeInitial = initialWords.filter(entry => !safePath(entry.word));
    if (unsafeInitial.length) throw new Error(`初始词 ${unsafeInitial.map(entry => entry.word).join("、")} 存在用格歧义，可能导致关卡无法完成，请重新生成棋盘。`);
    if (initialNames.size !== initialWords.length || initialWords.some(entry => !canTarget(entry))) {
      throw new Error("初始词不能重复、包含仅额外词或不符合词库筛选。");
    }
    initialWords = initialWords.map(entry => ({ ...foundByWord.get(entry.word), ...entry,
      pathAnalysis: foundByWord.get(entry.word).pathAnalysis }));
    const candidateWords = foundWords.filter(canTarget);
    const targetWords = [...initialWords];
    const extraWords = foundWords.filter(entry => !initialNames.has(entry.word));
    const cells = letters.map((letter, index) => ({ letter, count: 0, ...(disabledCells.includes(index) ? { disabled: true } : {}) }));
    for (const entry of targetWords) for (const cell of entry.path) cells[cell].count++;
    const level = { rows, columns, disabledCells: [...disabledCells], targetCount: targetWords.length, targetLimitsEnabled: false,
      filters: normalized, fixedWords: [...fixedWords], fixedWordExemptions: [...exemptions], cells, initialWords, candidateWords, targetWords, extraWords };
    return { ...level, statistics: calculateLevelStatistics(level) };
  }

  function generate({ rows, columns, disabledCells = [], initialForwardProbability = 50, initialRarityLevel = null,
    minimumEmotionScore = null, filters = {}, fixedWords = [], fixedLayout = null, fixedWordExemptions = [],
    duplicateCheck = createDuplicateCheck([], { target: 0, extra: 0 }), random = Math.random }) {
    validateSize(rows, columns);
    disabledCells = normalizeDisabledCells({ rows, columns, disabledCells });
    const capacity = rows * columns - disabledCells.length;
    validateInitialForwardProbability(initialForwardProbability);
    if (minimumEmotionScore !== null && !Number.isFinite(minimumEmotionScore)) throw new Error("情绪总分下限需为有效数字。");
    fixedWords = validateFixedWords({ rows, columns, disabledCells, fixedWords });
    fixedWordExemptions = normalizeFixedWordExemptions({ fixedWords, fixedWordExemptions });
    const exemptions = new Set(fixedWordExemptions);
    fixedLayout = normalizeFixedLayout({ rows, columns, disabledCells, fixedWords, fixedLayout });
    const pinned = new Set(fixedLayout?.placements.map(entry => entry.word) ?? []);
    const pinnedLetters = fixedLayoutLetters(rows, columns, fixedLayout?.placements ?? []);
    const fullyPinned = pinnedLetters.every((letter, index) => letter || disabledCells.includes(index));
    const pool = getPool(filters, exemptions);
    const initialPool = getPool(initialWordFilters(filters, initialRarityLevel), exemptions);
    const duplicateTargets = new Set(duplicateCheck.target.range > 0 ? duplicateCheck.target.words.map(word => word.toUpperCase()) : []);
    for (const word of fixedWords) {
      const entry = dictionary.get(word);
      if (!entry) throw new Error(`固定单词 ${word} 不在词库中。`);
      if (entry.onlyExtra) throw new Error(`固定单词 ${word} 属于仅额外词，不能作为初始词。`);
      if (!matchesFilters(entry, pool.filters, exemptions.has(word))) throw new Error(`固定单词 ${word} 不符合当前词库筛选。`);
      if (!exemptions.has(word) && initialRarityLevel !== null && entry.rarityLevel !== initialRarityLevel) throw new Error(`固定单词 ${word} 不符合初始词生僻档位 ${initialRarityLevel}。`);
      if (!exemptions.has(word) && duplicateTargets.has(word)) throw new Error(`固定单词 ${word} 与最近 ${duplicateCheck.target.range} 关的目标词重复，请调整固定词或查重范围。`);
    }
    if (pinned.size) {
      const isSafe = createPathSafetyChecker({ rows, columns, disabledCells, letters: pinnedLetters }, { allowEmpty: true });
      const unsafePinned = [...pinned].filter(word => !isSafe(word));
      if (unsafePinned.length) throw new Error(`固定布局的 ${unsafePinned.join("、")} 已存在用格歧义，继续填词也无法消除，请调整固定位置。`);
    }
    if (!pool.entries.length) throw new Error("筛选后没有可用的初始词，请调整词库筛选。");
    if (!initialPool.entries.length) throw new Error("当前词库筛选与初始词生僻档位下没有可用的初始词。");
    const usable = initialPool.entries.filter(entry => entry.word.length <= capacity);
    if (!usable.length) throw new Error("当前棋盘尺寸与词库筛选下没有可用的初始词。");
    if (disabledCells.length && !shapeSupportsWords(rows, columns, disabledCells, Math.min(...usable.map(entry => entry.word.length)))) {
      throw new Error("当前棋盘造型存在无法连接初始词的格子，请调整造型或词库筛选。");
    }
    const maximumCoverage = pinnedLetters.filter(Boolean).length + usable.filter(entry => !pinned.has(entry.word))
      .reduce((sum, entry) => sum + entry.word.length, 0);
    if (maximumCoverage < capacity) throw new Error("当前可用的初始词无法填满棋盘，请调整造型或词库筛选。");
    let duplicateFailure = false, emotionFailure = false;
    for (let attempt = 0; attempt < GENERATION_BATCH_SIZE; attempt++) {
      const filled = fillBoard({ rows, columns, disabledCells, initialForwardProbability, initialRarityLevel,
        filters: pool.filters, fixedWords, fixedLayout, fixedWordExemptions, random });
      if (!filled) continue;
      const foundWords = findWords({ rows, columns, disabledCells, ...filled });
      const result = selectTargets({ rows, columns, disabledCells, ...filled, foundWords, filters: pool.filters, fixedWords, fixedWordExemptions });
      if (minimumEmotionScore !== null && (!Number.isFinite(result.statistics.emotion.total) || result.statistics.emotion.total < minimumEmotionScore)) {
        if (fullyPinned) throw new Error(`固定棋盘的初始词已确定，情绪总分未达到 ${minimumEmotionScore}，请调整布局。`);
        emotionFailure = true; continue;
      }
      const duplicates = findDuplicateWords(result, duplicateCheck);
      if (duplicates.target.length || duplicates.extra.length) { duplicateFailure = true; continue; }
      return { ...result, initialForwardProbability, initialRarityLevel, minimumEmotionScore, fixedLayout: structuredClone(fixedLayout),
        duplicateCheck: Object.fromEntries(["target", "extra"].map(kind => [kind, {
          range: duplicateCheck[kind].range, levelIds: [...duplicateCheck[kind].levelIds],
        }])) };
    }
    const reason = duplicateFailure ? "本轮生成的关卡与查重范围内的关卡存在重复单词。"
      : emotionFailure ? `本轮生成的关卡情绪总分未达到 ${minimumEmotionScore}。` : "本轮未能用初始词填满棋盘。";
    const error = new Error(reason);
    error.code = "GENERATION_RETRY"; error.attempts = GENERATION_BATCH_SIZE;
    throw error;
  }

  return { generate, findPlacement, findWords, selectTargets };
}
