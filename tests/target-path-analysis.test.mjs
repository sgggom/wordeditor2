import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { analyzeTargetPaths } from "../dist/target-path-analysis.js";
import { createPathSafetyChecker } from "../dist/path-safety.js";
import { importGameLevels } from "../dist/level-import.js";

// Independent oracle enumerates moves afresh at every state, without the
// production analyzer's precomputed effects or solvable-assignment search.
function pathsFor(level, word, counts) {
  const paths = [];
  function visit(path) {
    if (path.length === word.length) { paths.push(path); return; }
    for (let cell = 0; cell < level.cells.length; cell++) {
      if (!counts[cell] || path.includes(cell) || level.cells[cell].letter !== word[path.length] || level.disabledCells?.includes(cell)) continue;
      const previous = path.at(-1);
      if (previous !== undefined && Math.abs(Math.floor(previous / level.columns) - Math.floor(cell / level.columns)) +
          Math.abs(previous % level.columns - cell % level.columns) !== 1) continue;
      visit([...path, cell]);
    }
  }
  visit([]);
  return paths;
}
function outcomes(level, words = level.targetWords.map(entry => entry.word), counts = level.cells.map(cell => cell.count)) {
  if (!words.length) return [counts.every(count => count === 0)];
  const results = [];
  for (const word of words) for (const path of pathsFor(level, word, counts)) {
    results.push(...outcomes(level, words.filter(other => other !== word), counts.map((count, cell) => count - Number(path.includes(cell)))));
  }
  return results.length ? results : [false];
}
const levelFor = (letters, entries) => {
  const cells = [...letters].map(letter => ({ letter, count: 0 }));
  for (const entry of entries) for (const cell of entry.path) cells[cell].count++;
  return { rows: 2, columns: letters.length / 2, cells, targetWords: entries };
};

test("different-cell alternatives can all finish and must not be reported as deadlocks", () => {
  const level = levelFor("ABAB", [{ word: "AB", path: [0, 1] }, { word: "BA", path: [3, 2] }]);
  assert.equal(createPathSafetyChecker(level)("AB"), false);
  assert.deepEqual(analyzeTargetPaths(level), { solvable: true, allChoicesComplete: true, counterexample: null,
    legalPathCount: 4, distinctPathCount: 4, pathsExhausted: true });
  assert.ok(outcomes(level).every(Boolean));
});

test("a bad target path returns a playable counterexample whose remaining targets have no solution", () => {
  const [level] = importGameLevels({ books: [{ levels: [{ g: "CAT,OTO", t: "CAT COT TOT", e: "", n: "212121" }] }], daily: [] });
  const result = analyzeTargetPaths(level);
  assert.equal(result.solvable, true); assert.equal(result.allChoicesComplete, false);
  assert.equal(result.pathsExhausted, false, "stop at the first deadlock without enumerating all remaining paths");
  let counts = level.cells.map(cell => cell.count), words = level.targetWords.map(entry => entry.word);
  for (const move of result.counterexample.moves) {
    assert.ok(words.includes(move.word));
    assert.ok(pathsFor(level, move.word, counts).some(path => path.join() === move.path.join()));
    counts = counts.map((count, cell) => count - Number(move.path.includes(cell)));
    words = words.filter(word => word !== move.word);
  }
  assert.deepEqual(result.counterexample.counts, counts);
  assert.deepEqual(result.counterexample.remainingWords, words);
  assert.ok(outcomes(level, words, counts).every(result => !result));
});

test("extra words and their assigned paths or metadata never change target analysis", () => {
  const level = levelFor("ABAB", [{ word: "AB", path: [0, 1] }, { word: "BA", path: [3, 2] }]);
  const expected = analyzeTargetPaths(level);
  for (const extraWords of [[], [{ word: "MISSING", path: [99] }], [{ word: "ABAB", path: [0, 1, 3, 2] }]]) {
    assert.deepEqual(analyzeTargetPaths({ ...level, extraWords }), expected);
  }
  assert.deepEqual(level.cells.map(cell => cell.count), [1, 1, 1, 1]);
});

test("same-cell routes are fully enumerated and equivalent consumption states are merged", () => {
  const level = levelFor("AAAAAA", [{ word: "AAAAAA", path: [0, 1, 2, 5, 4, 3] }]);
  const result = analyzeTargetPaths(level);
  assert.equal(result.legalPathCount, pathsFor(level, "AAAAAA", level.cells.map(cell => cell.count)).length);
  assert.ok(result.legalPathCount > 14);
  assert.equal(result.distinctPathCount, 1); assert.equal(result.allChoicesComplete, true);
});

test("count exhaustion, disabled cells and initially unsolvable target answers are respected", () => {
  const level = levelFor("ABAB", [{ word: "AB", path: [0, 1] }]);
  // The second AB is physically present but cannot consume any target counts.
  level.disabledCells = [2, 3];
  assert.equal(analyzeTargetPaths(level).legalPathCount, 1);
  assert.equal(analyzeTargetPaths(level).allChoicesComplete, true);
  const mismatch = structuredClone(level); mismatch.cells[0].count++;
  assert.equal(analyzeTargetPaths(mismatch).solvable, false);
  assert.equal(analyzeTargetPaths({ ...level, targetWords: [{ word: "ZZ" }] }).solvable, false);
  assert.throws(() => analyzeTargetPaths({ ...level, cells: [{ letter: "A", count: -1 }, ...level.cells.slice(1)] }), /次数/);
});

test("more than 32 target answers retain independent remaining-word identities", () => {
  // Build many distinct strings on a unique-letter board. Each target has one
  // path effect, allowing all orders to be proven without exploring 2^N states.
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXY";
  const entries = [];
  for (let cell = 0; cell < 25; cell++) {
    entries.push({ word: letters[cell], path: [cell] });
    if (cell % 5 < 4) entries.push({ word: letters[cell] + letters[cell + 1], path: [cell, cell + 1] });
  }
  const cells = [...letters].map(letter => ({ letter, count: 0 }));
  for (const entry of entries) for (const cell of entry.path) cells[cell].count++;
  const result = analyzeTargetPaths({ rows: 5, columns: 5, cells, targetWords: entries });
  assert.ok(entries.length > 32); assert.equal(result.allChoicesComplete, true);
});

test("exhaustive small-board answers agree with independent simulations of every play order", () => {
  let checked = 0;
  for (let board = 0; board < 16; board++) {
    const letters = Array.from({ length: 4 }, (_, cell) => board & (1 << cell) ? "A" : "B").join("");
    const empty = { rows: 2, columns: 2, cells: [...letters].map(letter => ({ letter, count: 1 })) };
    const choices = ["AA", "AB", "BA", "BB", "ABA", "BAB", "AAB", "BBA"].map(word => ({ word, paths: pathsFor(empty, word, [1, 1, 1, 1]) })).filter(entry => entry.paths.length);
    for (let first = 0; first < choices.length; first++) for (let second = first + 1; second < choices.length; second++) {
      for (const path of choices[first].paths) {
        const level = levelFor(letters, [{ word: choices[first].word, path }, { word: choices[second].word, path: choices[second].paths[0] }]);
        const expected = outcomes(level), actual = analyzeTargetPaths(level);
        assert.equal(actual.solvable, expected.some(Boolean));
        assert.equal(actual.allChoicesComplete, expected.every(Boolean));
        checked++;
      }
    }
  }
  assert.ok(checked > 100);
});

test("real shaped level 41 reproduces the deadlock while ignoring its extra answers", async () => {
  const source = JSON.parse(await readFile(new URL("./fixtures/shaped-level-41.json", import.meta.url)));
  const [level] = importGameLevels({ books: [{ levels: [source] }], daily: [] });
  const result = analyzeTargetPaths(level);
  assert.equal(result.solvable, true); assert.equal(result.allChoicesComplete, false);
  assert.ok(result.counterexample.moves.length);
  assert.deepEqual(analyzeTargetPaths({ ...level, extraWords: [] }), result);
});
