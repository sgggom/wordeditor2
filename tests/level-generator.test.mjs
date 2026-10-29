import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createGenerator } from "../dist/level-generator.js";
import { setTargetWord } from "../dist/level-rules.js";
import { createPathSafetyChecker } from "../dist/path-safety.js";
import { describePath } from "../dist/level-statistics.js";

const normal = JSON.parse(await readFile(new URL("../dist/data/required-words.json", import.meta.url), "utf8"));
const onlyExtra = JSON.parse(await readFile(new URL("../dist/data/extra-words.json", import.meta.url), "utf8"));
const normalNames = new Set(normal.map(entry => entry.word));
const onlyExtraNames = new Set(onlyExtra.map(entry => entry.word));
const generator = createGenerator(normal, onlyExtra);
const entries = words => words.map(word => ({ word }));

function seededRandom(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function verifyPath(entry, level) {
  assert.equal(entry.path.length, entry.word.length);
  assert.equal(new Set(entry.path).size, entry.path.length);
  entry.path.forEach((cell, step) => {
    assert.ok(Number.isInteger(cell) && cell >= 0 && cell < level.cells.length);
    assert.equal(level.cells[cell].letter, entry.word[step]);
    if (step) {
      const previous = entry.path[step - 1];
      assert.equal(Math.abs(Math.floor(cell / level.columns) - Math.floor(previous / level.columns))
        + Math.abs(cell % level.columns - previous % level.columns), 1);
    }
  });
}

function verifyLevel(level) {
  const targetCount = level.targetWords.length;
  assert.equal(level.targetCount, targetCount);
  assert.ok(targetCount > 0);
  assert.deepEqual(level.targetWords, level.initialWords);
  assert.ok(level.targetWords.every(entry => createPathSafetyChecker(level)(entry.word)));
  const targets = new Set(level.targetWords.map(entry => entry.word));
  const candidates = new Set(level.candidateWords.map(entry => entry.word));
  const extras = new Set(level.extraWords.map(entry => entry.word));
  assert.equal(targets.size, level.targetWords.length);
  assert.equal(candidates.size, level.candidateWords.length);
  assert.equal(extras.size, level.extraWords.length);
  for (const entry of [...level.candidateWords, ...level.extraWords]) verifyPath(entry, level);
  const replay = Array(level.cells.length).fill("");
  for (const entry of level.initialWords) {
    assert.ok(targets.has(entry.word));
    assert.ok(normalNames.has(entry.word) && !onlyExtraNames.has(entry.word));
    assert.ok(entry.path.some(cell => !replay[cell]), "An initial word did not fill an empty cell");
    entry.path.forEach((cell, index) => {
      assert.ok(!replay[cell] || replay[cell] === entry.word[index]);
      replay[cell] = entry.word[index];
    });
    assert.deepEqual(level.targetWords.find(target => target.word === entry.word).path, entry.path);
  }
  assert.deepEqual(replay, level.cells.map(cell => cell.letter));
  assert.ok(replay.every(Boolean));
  const counts = Array(level.cells.length).fill(0);
  for (const entry of level.targetWords) {
    assert.ok(candidates.has(entry.word) && !extras.has(entry.word));
    assert.ok(!onlyExtraNames.has(entry.word));
    verifyPath(entry, level);
    for (const cell of entry.path) counts[cell] += 1;
  }
  for (const entry of level.candidateWords) {
    assert.ok(!entry.onlyExtra && !onlyExtraNames.has(entry.word));
    assert.ok(targets.has(entry.word) || extras.has(entry.word));
  }
  assert.deepEqual(level.cells.map(cell => cell.count), counts);
  assert.equal(level.statistics.workload.targetCount, targetCount);
  assert.equal(level.statistics.workload.totalLetters, counts.reduce((sum, count) => sum + count, 0));
  assert.equal(level.statistics.words.total, targets.size + extras.size);
  assert.equal(Object.values(level.statistics.paths.turnDistribution).reduce((sum, count) => sum + count, 0), targetCount);
  for (const entry of [...level.targetWords, ...level.extraWords]) {
    assert.ok(entry.pathAnalysis.legalPathCount >= 1);
    assert.deepEqual(entry.pathAnalysis.assigned.path, entry.path);
    assert.ok(Number.isInteger(entry.pathAnalysis.assigned.difficultyScore));
    verifyPath({ ...entry, path: entry.pathAnalysis.representative.path }, level);
  }
}

// An independent, word-by-word solver checks that the board scan omits no dictionary words.
function canSpell(word, letters, rows, columns) {
  if (word.length > letters.length) return false;
  function search(row, column, offset, used) {
    const cell = row * columns + column;
    if (letters[cell] !== word[offset] || used.has(cell)) return false;
    if (offset === word.length - 1) return true;
    const nextUsed = new Set([...used, cell]);
    return [[row - 1, column], [row + 1, column], [row, column - 1], [row, column + 1]]
      .some(([r, c]) => r >= 0 && r < rows && c >= 0 && c < columns && search(r, c, offset + 1, nextUsed));
  }
  return letters.some((_, index) => search(Math.floor(index / columns), index % columns, 0, new Set()));
}

test("all 16 sizes fill every cell, preserve initial words and count only selected targets", () => {
  for (const rows of [2, 3, 4, 5]) for (const columns of [2, 3, 4, 5]) {
    for (let seed = 1; seed <= 3; seed++) verifyLevel(generator.generate({ rows, columns, random: seededRandom(seed) }));
  }
});





test("placement prefers empty cells and allows multiple existing letters anywhere in a word", () => {
  const priority = createGenerator(entries(["ABC"]));
  const letters = ["A", "", "", "D", "B", "C"];
  const placement = priority.findPlacement({ rows: 2, columns: 3, letters, random: seededRandom(1) });
  assert.equal(placement.path.filter(cell => !letters[cell]).length, 2);

  const overlap = createGenerator(entries(["ABCDEF"]));
  const partial = ["A", "", "C", "F", "E", "D"];
  const shared = overlap.findPlacement({ rows: 2, columns: 3, letters: partial });
  assert.deepEqual(shared.path, [0, 1, 2, 5, 4, 3]);
  assert.equal(shared.path.filter(cell => partial[cell]).length, 5);
  assert.equal(overlap.findPlacement({ rows: 2, columns: 3, letters: ["A", "B", "C", "F", "E", "D"] }), null);
});

test("initial forward probability controls direction preference when both directions fit", () => {
  const simple = createGenerator(entries(["ABC"]));
  for (const initialForwardProbability of [0, 25, 50, 75, 100]) {
    let forwardCount = 0;
    for (let sample = 0; sample < 100; sample += 1) {
      const remainingRandom = seededRandom(sample + 10);
      let firstDraw = true;
      const random = () => {
        if (!firstDraw) return remainingRandom();
        firstDraw = false;
        return (sample + 0.5) / 100;
      };
      const placement = simple.findPlacement({ rows: 2, columns: 3, letters: Array(6).fill(""), initialForwardProbability, random });
      if (["R", "D"].includes(describePath(placement.path, 3).firstDirection)) forwardCount += 1;
    }
    assert.equal(forwardCount, initialForwardProbability);
  }
});

test("direction preference preserves empty-cell priority and falls back when its direction cannot fit", () => {
  const simple = createGenerator(entries(["ABC"]));
  const options = { rows: 2, columns: 3, random: seededRandom(4) };
  const letters = ["Z", "C", "Z", "B", "", ""];
  const placement = simple.findPlacement({ ...options, letters, initialForwardProbability: 100 });
  assert.deepEqual(placement.path, [5, 4, 1]);
  assert.equal(placement.path.filter(cell => !letters[cell]).length, 2);
  assert.deepEqual(simple.findPlacement({ ...options, letters: ["", "B", "A", "Z", "Z", "Z"], initialForwardProbability: 100 }).path, [2, 1, 0]);
  assert.deepEqual(simple.findPlacement({ ...options, letters: ["A", "B", "", "Z", "Z", "Z"], initialForwardProbability: 0 }).path, [0, 1, 2]);
});

test("probability reaches initial placement and is retained in generated level data across all sizes", () => {
  for (const rows of [2, 3]) {
    for (const columns of [3, 4, 5]) {
      for (const initialForwardProbability of [0, 100]) {
        const level = generator.generate({ rows, columns, targetCount: 6, initialForwardProbability, random: seededRandom(42) });
        verifyLevel(level);
        assert.equal(level.initialForwardProbability, initialForwardProbability);
        assert.equal(["R", "D"].includes(level.initialWords[0].pathAnalysis.assigned.firstDirection), initialForwardProbability === 100);
      }
    }
  }
  assert.equal(generator.generate({ rows: 3, columns: 4, random: seededRandom(3) }).initialForwardProbability, 50);
});

test("invalid probabilities are rejected instead of clamped or silently reset", () => {
  for (const initialForwardProbability of [-1, 101, 1.5, NaN, Infinity, "50", null]) {
    assert.throws(() => generator.generate({ rows: 2, columns: 3, initialForwardProbability }), /初始正向概率/);
    assert.throws(() => generator.findPlacement({ rows: 2, columns: 3, letters: Array(6).fill(""), initialForwardProbability }), /初始正向概率/);
  }
});

test("candidate enumeration is exhaustive across both banks and does not calculate letter counts", () => {
  const level = generator.generate({ rows: 3, columns: 4, targetCount: 6, random: seededRandom(7) });
  const letters = Object.freeze(level.cells.map(cell => cell.letter));
  const found = generator.findWords({ rows: 3, columns: 4, letters, initialWords: level.initialWords });
  const expected = new Set([...normal, ...onlyExtra].filter(entry => canSpell(entry.word, letters, 3, 4)).map(entry => entry.word));
  assert.deepEqual(new Set(found.map(entry => entry.word)), expected);
  assert.deepEqual(new Set([...level.targetWords, ...level.extraWords].map(entry => entry.word)), expected);
  assert.deepEqual(new Set(level.candidateWords.map(entry => entry.word)), new Set(found.filter(entry => !entry.onlyExtra && entry.pathAnalysis.safe).map(entry => entry.word)));
  assert.ok(found.every(entry => !("count" in entry)));
});

test("only-extra wins duplicate classification and cannot be placed or promoted", () => {
  const restricted = createGenerator(entries(["ABC", "DEF", "ABCDEF"]), entries(["ABCDEF"]));
  const letters = ["A", "B", "C", "F", "E", "D"];
  const initialWords = [{ word: "ABC", path: [0, 1, 2], onlyExtra: false }, { word: "DEF", path: [5, 4, 3], onlyExtra: false }];
  const foundWords = restricted.findWords({ rows: 2, columns: 3, letters, initialWords });
  const options = { rows: 2, columns: 3, letters, initialWords, foundWords, random: seededRandom(1) };
  const level = restricted.selectTargets({ ...options, targetCount: 2 });
  assert.deepEqual(new Set(level.targetWords.map(entry => entry.word)), new Set(["ABC", "DEF"]));
  assert.deepEqual(level.extraWords.map(entry => entry.word), ["ABCDEF"]);
  assert.equal(level.extraWords[0].onlyExtra, true);
  assert.equal(level.candidateWords.length, 2);
  assert.deepEqual(level.cells.map(cell => cell.count), [1, 1, 1, 1, 1, 1]);
  assert.throws(() => setTargetWord(level, "ABCDEF", true), /候选词/);
  const placed = restricted.findPlacement({ rows: 2, columns: 3, letters: Array(6).fill("") });
  assert.equal(placed.word.length, 3);
  assert.equal(restricted.generate({ rows: 2, columns: 3, targetCount: 1 }).targetWords.length, 2);
});

test("all eligible candidates remain available for manual selection with no automatic promotion", () => {
  const rankedGenerator = createGenerator([
    ...entries(["ABCFEDGHI", "ABC", "DEF", "ABE", "CBA", "ABEF", "ADG"]).map(entry => ({ ...entry, scope: 1 })),
    { word: "GHI", scope: 2 },
  ], [{ word: "ADG", scope: 1 }]);
  const options = { rows: 3, columns: 3, letters: [..."ABCDEFGHI"],
    initialWords: [{ word: "ABCFEDGHI", path: [0, 1, 2, 5, 4, 3, 6, 7, 8] }] };
  const level = rankedGenerator.selectTargets({ ...options, foundWords: rankedGenerator.findWords(options), filters: { scope: [1] }, targetCount: 99 });
  assert.deepEqual(level.targetWords.map(entry => entry.word), ["ABCFEDGHI"]);
  assert.deepEqual(new Set(level.candidateWords.map(entry => entry.word)), new Set(["ABCFEDGHI", "ABC", "DEF", "ABE", "CBA", "ABEF"]));
  assert.ok(["ADG", "GHI"].every(word => level.extraWords.some(entry => entry.word === word)));
  for (const word of ["ADG", "GHI"]) assert.throws(() => setTargetWord(level, word, true), /候选词/);
  const edited = setTargetWord(level, "ABEF", true);
  assert.deepEqual(edited.targetWords.map(entry => entry.word), ["ABCFEDGHI", "ABEF"]);
  assert.equal(edited.targetCount, 2);
  assert.deepEqual(edited.targetWords[0].path, options.initialWords[0].path);
});

test("repeated-letter paths are deduplicated by word and extras never inflate usage", () => {
  const repeated = createGenerator(entries(["AAA", "AAAA", "AAAAA", "AAAAAA", "AAAAAAA"]));
  const level = repeated.generate({ rows: 2, columns: 3, targetCount: 1, random: seededRandom(12) });
  assert.equal(level.initialWords.length, 1);
  assert.deepEqual(level.targetWords.map(entry => entry.word), ["AAAAAA"]);
  assert.equal(level.candidateWords.length, 1);
  assert.ok(level.targetWords[0].pathAnalysis.legalPathCount > 1);
  assert.ok(level.extraWords.every(entry => entry.pathAnalysis.safe === false));
  assert.equal(level.extraWords.length, 3);
  assert.deepEqual(level.cells.map(cell => cell.count), [1, 1, 1, 1, 1, 1]);
  for (const entry of [...level.targetWords, ...level.extraWords]) verifyPath(entry, level);
});

test("invalid boards and empty dictionaries still fail without target quota checks", () => {
  assert.throws(() => createGenerator([]));
  assert.throws(() => generator.generate({ rows: 1, columns: 3 }), /棋盘尺寸/);
  assert.throws(() => generator.findWords({ rows: 2, columns: 3, letters: Array(6).fill("") }), /填满/);
  const sparse = createGenerator(entries(["ABCDEF", "ZZZ"]));
  const level = sparse.generate({ rows: 2, columns: 3, targetCount: 100, random: seededRandom(1) });
  assert.deepEqual(level.targetWords.map(entry => entry.word), ["ABCDEF"]);
});

test("generation remains reproducible with a seed", () => {
  const options = { rows: 3, columns: 4, targetCount: 6 };
  assert.deepEqual(generator.generate({ ...options, random: seededRandom(31) }), generator.generate({ ...options, random: seededRandom(31) }));
});









test("all four metadata filters constrain placed words and promoted targets", () => {
  const filters = { scope: [1, 2], emotion: [0, 1], abbreviation: [0], rarityLevel: [1, 2, 3] };
  const level = generator.generate({ rows: 3, columns: 4, targetCount: 6, maxWordLength: 5, filters, random: seededRandom(8) });
  verifyLevel(level);
  assert.deepEqual(level.filters, filters);
  for (const entry of [...level.initialWords, ...level.candidateWords, ...level.targetWords]) {
    for (const [key, values] of Object.entries(filters)) assert.ok(values.includes(entry[key]), `${entry.word}: ${key}`);
    const source = normal.find(record => record.word === entry.word);
    assert.equal(entry.definitionZh, source.definitionZh);
    assert.equal(entry.phonetic, source.phonetic);
  }
});

test("multi-select uses OR within a field and AND across fields, retaining excluded matches as extras", () => {
  const scoped = createGenerator([
    { word: "ABC", scope: 1, emotion: 0, abbreviation: 0, rarityLevel: 1 },
    { word: "DEF", scope: 2, emotion: 0, abbreviation: 0, rarityLevel: 2 },
    { word: "ABCDEF", scope: 4, emotion: -1, abbreviation: 1, rarityLevel: 5 },
  ], [{ word: "FED", scope: 1, emotion: 0, abbreviation: 0, rarityLevel: 1 }]);
  const filters = { scope: [1, 2], emotion: [0], abbreviation: [0], rarityLevel: [1, 2] };
  const letters = ["A", "B", "C", "F", "E", "D"];
  const initialWords = [{ word: "ABC", path: [0, 1, 2] }, { word: "DEF", path: [5, 4, 3] }];
  const foundWords = scoped.findWords({ rows: 2, columns: 3, letters, initialWords });
  const options = { rows: 2, columns: 3, letters, initialWords, foundWords, filters, targetCount: 2 };
  const level = scoped.selectTargets(options);
  assert.deepEqual(new Set(level.candidateWords.map(entry => entry.word)), new Set(["ABC", "DEF"]));
  assert.deepEqual(new Set(level.extraWords.map(entry => entry.word)), new Set(["ABCDEF", "FED"]));
  assert.equal(level.extraWords.find(entry => entry.word === "FED").onlyExtra, true);
  assert.deepEqual(level.cells.map(cell => cell.count), [1, 1, 1, 1, 1, 1]);
  assert.throws(() => setTargetWord(level, "ABCDEF", true), /候选词/);

  const emptyBoard = { rows: 2, columns: 3, letters: Array(6).fill("") };
  assert.equal(scoped.findPlacement({ ...emptyBoard, filters: { scope: [4], emotion: [-1], abbreviation: [1], rarityLevel: [5] } }).word, "ABCDEF");
  assert.equal(scoped.findPlacement({ ...emptyBoard, filters }).word.length, 3);
  assert.equal(scoped.findPlacement({ ...emptyBoard, filters: {} }).word, "ABCDEF");
});

test("empty selections and invalid filters fail without broadening the word pool", () => {
  for (const filters of [{ scope: [] }, { scope: [99] }]) {
    assert.throws(() => generator.generate({ rows: 2, columns: 3, filters }), /筛选后没有可用/);
  }
  for (const filters of [null, [], { scope: "1" }, { emotion: ["0"] }, { rarityLevel: [1.5] }, { unknown: [1] }]) {
    assert.throws(() => generator.generate({ rows: 2, columns: 3, filters }), /筛选/);
  }
  const missing = createGenerator([{ word: "ABCDEF", emotion: null, abbreviation: null }]);
  assert.throws(() => missing.generate({ rows: 2, columns: 3, targetCount: 1, filters: { emotion: [0], abbreviation: [0] } }), /筛选后没有可用/);
});
