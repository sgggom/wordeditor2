import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createGenerator, generateUntilComplete } from "../dist/level-generator.js";
import { createPathSafetyChecker, assertSafeTargetPaths } from "../dist/path-safety.js";
import { setTargetWord } from "../dist/level-rules.js";
import { importGameLevels } from "../dist/level-import.js";
import { createGameExport } from "../dist/level-export.js";

const records = ["CATOTO", "CAT", "COT", "TOT"].map(word => ({ word, rarityLevel: 1, emotion: 0 }));
const generator = createGenerator(records);
const board = { rows: 2, columns: 3, letters: [..."CATOTO"],
  initialWords: [{ ...records[0], path: [0, 1, 2, 5, 4, 3] }] };
const legacyTrap = () => importGameLevels({ books: [{ levels: [{ g: "CAT,OTO", t: "CAT COT TOT", e: "", n: "212121" }] }], daily: [] }, records)[0];

// Independent game simulation: enumerate every word/path a player can submit,
// subtract its counts, and require every reachable state to finish successfully.
function pathsFor(level, word, counts) {
  const paths = [];
  function visit(path) {
    if (path.length === word.length) { paths.push(path); return; }
    for (let cell = 0; cell < level.cells.length; cell++) {
      if (counts[cell] < 1 || path.includes(cell) || level.cells[cell].letter !== word[path.length]) continue;
      const last = path.at(-1), columns = level.columns;
      if (last !== undefined && Math.abs(Math.floor(last / columns) - Math.floor(cell / columns)) + Math.abs(last % columns - cell % columns) !== 1) continue;
      visit([...path, cell]);
    }
  }
  visit([]);
  return paths;
}
function everyChoiceCompletes(level) {
  const memo = new Map();
  function visit(words, counts) {
    if (!words.length) return counts.every(count => count === 0);
    const key = words.join(" ") + ":" + counts.join(",");
    if (memo.has(key)) return memo.get(key);
    let moves = 0;
    for (const word of words) {
      const seen = new Set();
      for (const path of pathsFor(level, word, counts)) {
        const signature = [...path].sort((a, b) => a - b).join(",");
        if (seen.has(signature)) continue;
        seen.add(signature); moves++;
        const next = counts.map((count, cell) => count - (path.includes(cell) ? 1 : 0));
        if (!visit(words.filter(other => other !== word), next)) { memo.set(key, false); return false; }
      }
    }
    memo.set(key, moves > 0);
    return moves > 0;
  }
  return visit(level.targetWords.map(entry => entry.word), level.cells.map(cell => cell.count));
}

test("different-cell alternatives are unsafe; different order over identical cells stays safe", () => {
  const found = generator.findWords(board);
  const check = createPathSafetyChecker(board);
  for (const [word, expected] of [["CAT", false], ["COT", true], ["TOT", true], ["CATOTO", true]]) {
    assert.equal(check(word), expected);
    assert.equal(found.find(entry => entry.word === word).pathAnalysis.safe, expected);
  }
  assert.equal(found.find(entry => entry.word === "TOT").pathAnalysis.legalPathCount, 2);
  assert.equal(found.find(entry => entry.word === "CAT").pathAnalysis.legalPathCount, 2);
  assert.equal(check("XYZ"), false);
  assert.equal(check("CATO".repeat(10)), false);
});

test("placement allows ambiguity without mutating the supplied board", () => {
  const letters = ["", "", "", "A", "B", "C"];
  const before = [...letters];
  const placement = createGenerator([{ word: "ABC" }]).findPlacement({ rows: 2, columns: 3, letters, random: () => 0 });
  assert.equal(placement.word, "ABC");
  assert.deepEqual(placement.path, [0, 1, 2]);
  assert.deepEqual(letters, before);
});

test("new placements may introduce ambiguity in earlier words on shaped boards", () => {
  const options = { rows: 2, columns: 3, disabledCells: [5], letters: ["C", "A", "T", "", "", ""],
    usedWords: ["CAT"], fixedWord: "COT", random: () => 0 };
  const placement = createGenerator([{ word: "COT" }]).findPlacement(options);
  assert.deepEqual(placement.path, [0, 3, 4]);
  const letters = [...options.letters];
  placement.path.forEach((cell, step) => { letters[cell] = placement.word[step]; });
  assert.equal(createPathSafetyChecker({ ...options, letters }, { allowEmpty: true })("CAT"), false);
});

test("ambiguous candidates remain selectable and carry accurate analysis", () => {
  const options = { ...board, foundWords: generator.findWords(board) };
  const level = generator.selectTargets(options);
  assert.ok(level.candidateWords.some(entry => entry.word === "CAT"));
  const edited = setTargetWord(level, "CAT", true);
  assert.equal(edited.targetWords.find(entry => entry.word === "CAT").pathAnalysis.safe, false);
  assert.equal(createPathSafetyChecker(edited)("CAT"), false);
  assert.ok(createGameExport([{ level: edited }]));
});

test("ambiguous automatic and fully pinned boards generate without retries", async () => {
  const repeated = createGenerator(["AAA", "AAAA"].map(word => ({ word })));
  for (const fixedWords of [[], ["AAA"]]) {
    let retries = 0;
    const level = await generateUntilComplete(repeated, { rows: 2, columns: 3, fixedWords, random: () => 0.5 },
      { onProgress: () => { retries++; } });
    assert.equal(retries, 0);
    assert.ok(level.targetWords.some(entry => !entry.pathAnalysis.safe));
    assert.ok(level.cells.every(cell => cell.count > 0));
    assert.ok(createGameExport([{ level }]));
  }
  const bad = legacyTrap();
  const fixedLayout = { rows: 2, columns: 3, placements: bad.targetWords.map(({ word, path }) => ({ word, path })) };
  const level = generator.generate({ rows: 2, columns: 3, fixedWords: ["CAT", "COT", "TOT"], fixedLayout });
  assert.deepEqual(level.fixedLayout, fixedLayout);
  assert.equal(level.targetWords.find(entry => entry.word === "CAT").pathAnalysis.safe, false);
});

test("legacy ambiguity remains detectable but does not prevent export", () => {
  const bad = legacyTrap();
  assert.equal(everyChoiceCompletes(bad), false);
  bad.targetWords.forEach(entry => { entry.pathAnalysis = { safe: true }; });
  assert.throws(() => assertSafeTargetPaths(bad), /CAT/);
  assert.ok(createGameExport([{ level: bad }]));
  assert.throws(() => setTargetWord(bad, "CAT", false), /没有目标词覆盖/);
});

test("all same-cell routes are accepted even when their number exceeds the legacy path cap", () => {
  const repeated = createGenerator([{ word: "AAAAAA" }]);
  const level = repeated.generate({ rows: 2, columns: 3, targetCount: 1 });
  assert.ok(level.targetWords[0].pathAnalysis.legalPathCount > 14);
  assert.equal(createPathSafetyChecker(level)("AAAAAA"), true);
  assert.equal(everyChoiceCompletes(level), true);
});

test("real vocabulary across all six board sizes keeps valid assigned paths and export counts", async () => {
  const normal = JSON.parse(await readFile(new URL("../dist/data/required-words.json", import.meta.url)));
  const extras = JSON.parse(await readFile(new URL("../dist/data/extra-words.json", import.meta.url)));
  const real = createGenerator(normal, extras);
  let seed = 83;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (const rows of [2, 3]) for (const columns of [3, 4, 5]) {
    const level = real.generate({ rows, columns, targetCount: 6, random });
    const counts = Array(level.cells.length).fill(0);
    for (const entry of level.targetWords) {
      const paths = pathsFor(level, entry.word, level.cells.map(cell => cell.count));
      assert.ok(paths.some(path => path.join(",") === entry.path.join(",")));
      for (const cell of entry.path) counts[cell] += 1;
    }
    assert.deepEqual(level.cells.map(cell => cell.count), counts);
    assert.ok(counts.every(count => count > 0));
    assert.ok(createGameExport([{ level }]).books[0].levels[0]);
  }
});

test("Edge level 41 keeps ambiguity diagnostics and its fixed layout can generate", async () => {
  const data = JSON.parse(await readFile(new URL('./fixtures/shaped-level-41.json', import.meta.url), 'utf8'));
  const [level] = importGameLevels({ books: [{ levels: [data] }], daily: [] });
  const check = createPathSafetyChecker(level);
  assert.deepEqual(level.targetWords.filter(entry => !check(entry.word)).map(entry => entry.word), ['NAP', 'PAN', 'THAN']);
  assert.equal(everyChoiceCompletes(level), false);
  assert.ok(createGameExport([{ level }]));
  const fixedWords = ['THAN', 'BANK', 'SNAP'];
  const fixedLayout = { rows: 3, columns: 4, placements: [
    { word: 'THAN', path: [1, 2, 6, 7] }, { word: 'BANK', path: [8, 9, 5, 4] }, { word: 'SNAP', path: [3, 7, 6, 10] },
  ] };
  const generated = createGenerator(level.targetWords).generate({ rows: 3, columns: 4, disabledCells: [0, 11], fixedWords, fixedLayout });
  assert.deepEqual(generated.fixedLayout, fixedLayout);
  assert.equal(createPathSafetyChecker(generated)('THAN'), false);
  assert.ok(createGameExport([{ level: generated }]));
});
