import assert from "node:assert/strict";
import test from "node:test";
import { createGenerator } from "../dist/level-generator.js";
import { compareRepresentativePaths, describePath } from "../dist/level-statistics.js";

test("turns and same-axis reversals are independent, including multiple reversals", () => {
  assert.deepEqual(describePath([0, 1, 4, 5], 3), { path: [0, 1, 4, 5], firstDirection: "R", turns: 2, reversals: 0, directionScore: 0, difficultyScore: 2 });
  assert.deepEqual(describePath([0, 1, 4, 3], 3), { path: [0, 1, 4, 3], firstDirection: "R", turns: 2, reversals: 1, directionScore: 0, difficultyScore: 3 });
  const multiple = describePath([4, 5, 2, 1, 0, 3, 6, 7, 8], 3);
  assert.equal(multiple.turns, 4);
  assert.equal(multiple.reversals, 3);
  assert.equal(describePath([2, 1, 0], 3).firstDirection, "L");
  assert.equal(describePath([6, 3, 0], 3).firstDirection, "U");
  assert.equal(describePath([0, 3, 6], 3).firstDirection, "D");
  assert.equal(describePath([0], 3).firstDirection, null);
});

test("path difficulty adds the first direction, every turn and every reversal", () => {
  for (const [path, expected] of [
    [[0, 1, 2], 0], [[0, 3, 6], 0],
    [[2, 1, 0], 1], [[6, 3, 0], 1],
    [[0, 1, 4], 1], [[3, 0, 1], 2],
    [[0, 1, 4, 5], 2], [[0, 1, 4, 3], 3],
    [[4, 5, 2, 1, 0, 3, 6, 7, 8], 7],
  ]) {
    assert.equal(describePath(path, 3).difficultyScore, expected, path.join(" → "));
  }
});

test("representative ordering prioritizes turns, then reversals, direction and coordinates", () => {
  const base = { turns: 2, reversals: 1, firstDirection: "R", path: [0, 1, 4, 3] };
  assert.ok(compareRepresentativePaths({ ...base, turns: 1, firstDirection: "U" }, base) < 0);
  assert.ok(compareRepresentativePaths({ ...base, reversals: 0, firstDirection: "U" }, base) < 0);
  for (const [a, b] of [["R", "D"], ["D", "L"], ["L", "U"]]) {
    assert.ok(compareRepresentativePaths({ ...base, firstDirection: a }, { ...base, firstDirection: b }) < 0);
  }
  assert.ok(compareRepresentativePaths(base, { ...base, path: [3, 4, 1, 0] }) < 0);
});

test("statistics use all final targets once and separate extras from structure and usage", () => {
  const generator = createGenerator([
    { word: "ABC", rarityLevel: 1, emotion: 2 },
    { word: "DEF", rarityLevel: 3, emotion: -1 },
    { word: "ABCDEF", rarityLevel: 5, emotion: 0 },
  ], [{ word: "FED", rarityLevel: 2, emotion: -2 }]);
  const options = {
    rows: 2, columns: 3, letters: ["A", "B", "C", "F", "E", "D"],
    initialWords: [{ word: "ABC", path: [0, 1, 2] }, { word: "DEF", path: [5, 4, 3] }],
  };
  const level = generator.selectTargets({ ...options, foundWords: generator.findWords(options), targetCount: 3 });
  const stats = level.statistics;
  assert.deepEqual(stats.workload, { targetCount: 3, totalLetters: 12 });
  assert.deepEqual(stats.vocabulary, { rarityDistribution: { 1: 1, 2: 0, 3: 1, 4: 0, 5: 1 }, unknownRarityCount: 0, rarityTotal: 9 });
  assert.deepEqual(stats.lengths.distribution, { 3: 2, 6: 1 });
  assert.equal(stats.lengths.longest, 6);
  assert.equal(stats.lengths.fivePlusRatio, 1 / 3);
  assert.equal(stats.lengths.sevenPlusCount, 0);
  assert.deepEqual(stats.paths.firstDirectionDistribution, { R: 2, D: 0, L: 1, U: 0 });
  assert.deepEqual(stats.paths.turnDistribution, { 0: 2, 1: 0, 2: 1, "3+": 0 });
  assert.equal(stats.paths.averageTurns, 2 / 3);
  assert.equal(stats.paths.straightRatio, 2 / 3);
  assert.equal(stats.paths.rightStraightCount, 1);
  assert.equal(stats.paths.downStraightCount, 0);
  assert.equal(stats.paths.reversalWordCount, 1);
  assert.equal(stats.paths.reversalWordRatio, 1 / 3);
  assert.equal(stats.paths.totalReversals, 1);
  assert.equal(stats.board.duplicateLetterCellCount, 0);
  assert.deepEqual(stats.usage, { basis: "assignedPaths", distribution: { 2: 6 }, maximum: 2, density: 2 });
  assert.deepEqual(stats.words, { total: 4, eligibleCandidateCount: 3, targetCount: 3, targetRatio: 0.75, extraCount: 1, extraRatio: 0.25, onlyExtraCount: 1 });
  assert.deepEqual(stats.emotion, { targetSum: 1, extraSum: -2, targetWeight: 1, extraWeight: 0.3, total: 0.4 });
  assert.deepEqual(level.initialWords.map(entry => entry.path), options.initialWords.map(entry => entry.path));
  assert.equal(JSON.parse(JSON.stringify(level)).statistics.emotion.total, 0.4);
});

// Independently enumerate each word, rather than scanning the generator's geometry cache.
function legalPaths(word, letters, columns) {
  const result = [];
  function walk(path) {
    if (path.length === word.length) { result.push(path); return; }
    const last = path.at(-1);
    for (let cell = 0; cell < letters.length; cell += 1) {
      if (path.includes(cell) || letters[cell] !== word[path.length]) continue;
      if (last !== undefined && Math.abs(Math.floor(last / columns) - Math.floor(cell / columns)) + Math.abs(last % columns - cell % columns) !== 1) continue;
      walk([...path, cell]);
    }
  }
  walk([]);
  return result;
}

test("all legal paths are counted, but representatives never replace assigned paths or cell counts", () => {
  const generator = createGenerator([{ word: "AAA" }, { word: "AAAAAA" }]);
  const options = {
    rows: 2, columns: 3, letters: Array(6).fill("A"),
    initialWords: [{ word: "AAAAAA", path: [0, 3, 4, 1, 2, 5] }],
  };
  const foundWords = generator.findWords(options);
  for (const entry of foundWords) {
    const allPaths = legalPaths(entry.word, options.letters, 3);
    assert.equal(entry.pathAnalysis.legalPathCount, allPaths.length);
    assert.ok(allPaths.some(path => JSON.stringify(path) === JSON.stringify(entry.pathAnalysis.representative.path)));
  }
  assert.deepEqual(foundWords.find(entry => entry.word === "AAA").pathAnalysis.representative.path, [0, 1, 2]);
  assert.deepEqual(foundWords.find(entry => entry.word === "AAAAAA").pathAnalysis.representative.path, [0, 1, 2, 5, 4, 3]);
  const level = generator.selectTargets({ ...options, foundWords, targetCount: 2, random: () => 0 });
  assert.deepEqual(level.targetWords[0].path, options.initialWords[0].path);
  assert.deepEqual(level.targetWords[0].pathAnalysis.assigned.path, options.initialWords[0].path);
  assert.equal(level.targetWords[0].pathAnalysis.assigned.difficultyScore, 6);
  assert.equal(level.targetWords[0].pathAnalysis.representative.difficultyScore, 3);
  const counts = Array(6).fill(0);
  for (const entry of level.targetWords) for (const cell of entry.path) counts[cell] += 1;
  assert.deepEqual(level.cells.map(cell => cell.count), counts);
  assert.deepEqual(level.statistics.paths.turnDistribution, { 0: 1, 1: 0, 2: 1, "3+": 0 });
  assert.equal(level.statistics.paths.multiplePathWordCount, 2);
  assert.equal(level.statistics.board.duplicateLetterCellCount, 5);
  assert.equal(level.statistics.board.duplicateLetterCellRatio, 5 / 6);
  assert.equal(level.statistics.vocabulary.unknownRarityCount, 2);
  assert.equal(level.statistics.emotion.total, null);
  assert.equal(level.statistics.words.extraRatio, 0);
});

test("emotion totals preserve negative and zero values; absent metadata is not scored as zero", () => {
  for (const [emotion, expected] of [[-2, -2], [0, 0], [2, 2], [undefined, null], [null, null]]) {
    const generator = createGenerator([{ word: "ABCDEF", emotion }]);
    const level = generator.generate({ rows: 2, columns: 3, targetCount: 1, random: () => 0 });
    assert.equal(level.statistics.emotion.total, expected);
    assert.equal(level.statistics.emotion.extraSum, 0);
  }
});
