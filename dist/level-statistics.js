const DIRECTION_ORDER = { R: 0, D: 1, L: 2, U: 3 };

export function describePath(path, columns) {
  let previous = null;
  let horizontal = null;
  let vertical = null;
  let firstDirection = null;
  let turns = 0;
  let reversals = 0;
  for (let index = 1; index < path.length; index += 1) {
    const dx = path[index] % columns - path[index - 1] % columns;
    const dy = Math.floor(path[index] / columns) - Math.floor(path[index - 1] / columns);
    const direction = dx > 0 ? "R" : dx < 0 ? "L" : dy > 0 ? "D" : "U";
    firstDirection ??= direction;
    if (previous !== null && previous !== direction) turns += 1;
    if (dx !== 0) {
      if (horizontal !== null && horizontal !== direction) reversals += 1;
      horizontal = direction;
    } else {
      if (vertical !== null && vertical !== direction) reversals += 1;
      vertical = direction;
    }
    previous = direction;
  }
  const directionScore = firstDirection === "U" || firstDirection === "L" ? 1 : 0;
  return { path: [...path], firstDirection, turns, reversals,
    directionScore, difficultyScore: directionScore + turns + reversals };
}

export function compareRepresentativePaths(a, b) {
  const difference = a.turns - b.turns || a.reversals - b.reversals ||
    (DIRECTION_ORDER[a.firstDirection] ?? 4) - (DIRECTION_ORDER[b.firstDirection] ?? 4);
  if (difference) return difference;
  for (let index = 0; index < a.path.length; index += 1) {
    if (a.path[index] !== b.path[index]) return a.path[index] - b.path[index];
  }
  return 0;
}

function histogram(values, bins = []) {
  const result = Object.fromEntries(bins.map(bin => [bin, 0]));
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

const sum = values => values.reduce((total, value) => total + value, 0);
const ratio = (count, total) => total ? count / total : null;
const emotionSum = words => words.every(entry => Number.isFinite(entry.emotion))
  ? sum(words.map(entry => entry.emotion)) : null;

export function calculateRarityTotal(words) {
  return words.every(entry => Number.isInteger(entry.rarityLevel) && entry.rarityLevel >= 1 && entry.rarityLevel <= 5)
    ? sum(words.map(entry => entry.rarityLevel)) : null;
}

export function calculateLevelStatistics(level) {
  const { rows, columns, cells, targetWords, extraWords, candidateWords } = level;
  const targetCount = targetWords.length;
  const allWordCount = targetCount + extraWords.length;
  const lengths = targetWords.map(entry => entry.word.length);
  const totalLetters = sum(lengths);
  const longWords = lengths.filter(length => length >= 5).length;
  const veryLongWords = lengths.filter(length => length >= 7).length;
  const knownRarities = targetWords.map(entry => entry.rarityLevel)
    .filter(value => Number.isInteger(value) && value >= 1 && value <= 5);
  const paths = targetWords.map(entry => entry.pathAnalysis.representative);
  const straightCount = paths.filter(path => path.turns === 0).length;
  const rightStraightCount = paths.filter(path => path.turns === 0 && path.firstDirection === "R").length;
  const downStraightCount = paths.filter(path => path.turns === 0 && path.firstDirection === "D").length;
  const reversalWordCount = paths.filter(path => path.reversals > 0).length;
  const letterCounts = histogram(cells.map(cell => cell.letter));
  const duplicateLetterCellCount = cells.length - Object.keys(letterCounts).length;
  const uses = cells.map(cell => cell.count);
  const targetEmotion = emotionSum(targetWords);
  const extraEmotion = emotionSum(extraWords);
  return {
    version: 1,
    wordBasis: "targetWords",
    vocabulary: {
      rarityDistribution: histogram(knownRarities, [1, 2, 3, 4, 5]),
      unknownRarityCount: targetCount - knownRarities.length,
      rarityTotal: calculateRarityTotal(targetWords),
    },
    workload: { targetCount, totalLetters },
    lengths: {
      distribution: histogram(lengths),
      longest: Math.max(0, ...lengths),
      fivePlusCount: longWords, fivePlusRatio: ratio(longWords, targetCount),
      sevenPlusCount: veryLongWords, sevenPlusRatio: ratio(veryLongWords, targetCount),
    },
    paths: {
      basis: "representative",
      selectionOrder: ["fewestTurns", "fewestReversals", "R>D>L>U", "coordinates"],
      firstDirectionDistribution: histogram(paths.map(path => path.firstDirection ?? "none"), ["R", "D", "L", "U"]),
      turnDistribution: histogram(paths.map(path => path.turns >= 3 ? "3+" : path.turns), [0, 1, 2, "3+"]),
      averageTurns: ratio(sum(paths.map(path => path.turns)), targetCount),
      straightCount, straightRatio: ratio(straightCount, targetCount),
      rightStraightCount, rightStraightRatio: ratio(rightStraightCount, targetCount),
      downStraightCount, downStraightRatio: ratio(downStraightCount, targetCount),
      reversalWordCount, reversalWordRatio: ratio(reversalWordCount, targetCount),
      totalReversals: sum(paths.map(path => path.reversals)),
      multiplePathWordCount: targetWords.filter(entry => entry.pathAnalysis.legalPathCount > 1).length,
    },
    board: {
      rows, columns, cellCount: cells.length,
      letterDistribution: letterCounts,
      distinctLetterCount: Object.keys(letterCounts).length,
      // Count additional copies after the first cell of each letter.
      duplicateLetterCellCount, duplicateLetterCellRatio: ratio(duplicateLetterCellCount, cells.length),
    },
    usage: {
      basis: "assignedPaths",
      distribution: histogram(uses),
      maximum: Math.max(0, ...uses),
      density: ratio(totalLetters, cells.length),
    },
    words: {
      total: allWordCount,
      eligibleCandidateCount: candidateWords.length,
      targetCount, targetRatio: ratio(targetCount, allWordCount),
      extraCount: extraWords.length, extraRatio: ratio(extraWords.length, allWordCount),
      onlyExtraCount: extraWords.filter(entry => entry.onlyExtra).length,
    },
    emotion: {
      targetSum: targetEmotion, extraSum: extraEmotion, targetWeight: 1, extraWeight: 0.3,
      total: targetEmotion === null || extraEmotion === null ? null : (targetEmotion * 10 + extraEmotion * 3) / 10,
    },
  };
}
