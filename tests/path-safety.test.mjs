import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createGenerator, generateUntilComplete } from "../dist/level-generator.js";
import { createPathSafetyChecker } from "../dist/path-safety.js";
import { setTargetWord } from "../dist/level-rules.js";
import { importGameLevels } from "../dist/level-import.js";
import { createGameExport } from "../dist/level-export.js";

const records = ["CATOTO", "CAT", "COT", "TOT"].map(word => ({ word, rarityLevel: 1, emotion: 0 }));
const generator = createGenerator(records);
const board = { rows: 2, columns: 3, letters: [..."CATOTO"],
  initialWords: [{ ...records[0], path: [0, 1, 2, 5, 4, 3] }] };
const safeLevel = () => generator.selectTargets({ ...board, foundWords: generator.findWords(board), targetCount: 3 });
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

test("unsafe low-score words remain extras and cannot enter candidate promotion or length quotas", () => {
  const level = safeLevel();
  assert.deepEqual(new Set(level.targetWords.map(entry => entry.word)), new Set(["CATOTO", "COT", "TOT"]));
  assert.deepEqual(level.extraWords.map(entry => entry.word), ["CAT"]);
  assert.ok(!level.candidateWords.some(entry => entry.word === "CAT"));
  assert.equal(level.extraWords[0].pathAnalysis.representative.difficultyScore, 0);
  assert.equal(everyChoiceCompletes(level), true);
  const counted = generator.selectTargets({ ...board, foundWords: generator.findWords(board), targetCount: 3,
    targetLengthPlan: ["short", "long", "short"] });
  assert.equal(counted.targetWords[1].word, "CATOTO");
  assert.deepEqual(new Set([counted.targetWords[0].word, counted.targetWords[2].word]), new Set(["COT", "TOT"]));
  assert.throws(() => generator.selectTargets({ ...board, foundWords: generator.findWords(board), targetCount: 4 }), /少于/);
});

test("unsafe initial words, including fixed words, trigger board retries without being dropped", async () => {
  const bad = legacyTrap();
  const options = { ...board, initialWords: bad.targetWords };
  assert.throws(() => generator.selectTargets({ ...options, foundWords: generator.findWords(options), targetCount: 3 }),
    error => error.code === "UNSAFE_INITIAL_PATH" && /CAT/.test(error.message));
  const repeated = createGenerator(["AAA", "AAAA"].map(word => ({ word })));
  for (const fixedWords of [[], ["AAA"]]) {
    let active = true;
    const progress = [];
    const settings = { rows: 2, columns: 3, targetCount: 2, fixedWords };
    assert.throws(() => repeated.generate(settings), error => error.code === "GENERATION_RETRY" && /不同格子/.test(error.message));
    assert.equal(await generateUntilComplete(repeated, settings, { isCurrent: () => active,
      onProgress: ({ attempts }) => { progress.push(attempts); active = false; } }), null);
    assert.deepEqual(progress, [80]);
  }
});

test("legacy and forged metadata cannot bypass manual target selection or export checks", () => {
  const level = safeLevel();
  const extra = level.extraWords[0];
  const legacy = structuredClone(level);
  delete legacy.extraWords[0].pathAnalysis.safe;
  legacy.candidateWords.push(legacy.extraWords[0]);
  assert.throws(() => setTargetWord(legacy, "CAT", true), /CAT.*不同格子/);
  legacy.extraWords[0].pathAnalysis.safe = true;
  assert.throws(() => setTargetWord(legacy, "CAT", true), /CAT.*不同格子/);
  const bad = legacyTrap();
  assert.equal(everyChoiceCompletes(bad), false, "The original reported failure remains a genuine trap in our independent simulation");
  for (const entry of bad.targetWords) entry.pathAnalysis.safe = true;
  assert.throws(() => createGameExport([{ level }, { level: bad }]), /第 2 关.*CAT.*不同格子/);
  assert.equal(createGameExport([{ level }]).books[0].levels[0].e, extra.word);
  // Old non-initial targets can still be removed even after they lose candidate eligibility.
  const imported = importGameLevels({ books: [{ levels: [{ g: "CAT,OTO", t: "CATOTO COT TOT CAT", e: "", n: "323232" }] }], daily: [] }, records)[0];
  assert.ok(!imported.candidateWords.some(entry => entry.word === "CAT"));
  const repaired = setTargetWord(imported, "CAT", false);
  assert.equal(everyChoiceCompletes(repaired), true);
  assert.ok(createGameExport([{ level: repaired }]).books[0].levels[0].e.includes("CAT"));
});

test("all same-cell routes are accepted even when their number exceeds the legacy path cap", () => {
  const repeated = createGenerator([{ word: "AAAAAA" }]);
  const level = repeated.generate({ rows: 2, columns: 3, targetCount: 1 });
  assert.ok(level.targetWords[0].pathAnalysis.legalPathCount > 14);
  assert.equal(createPathSafetyChecker(level)("AAAAAA"), true);
  assert.equal(everyChoiceCompletes(level), true);
});

test("real vocabulary across all six board sizes remains completable after every legal choice", async () => {
  const normal = JSON.parse(await readFile(new URL("../dist/data/required-words.json", import.meta.url)));
  const extras = JSON.parse(await readFile(new URL("../dist/data/extra-words.json", import.meta.url)));
  const real = createGenerator(normal, extras);
  let seed = 83;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (const rows of [2, 3]) for (const columns of [3, 4, 5]) {
    const level = real.generate({ rows, columns, targetCount: 6, random });
    for (const entry of level.targetWords) {
      const paths = pathsFor(level, entry.word, level.cells.map(cell => cell.count));
      const cellSets = new Set(paths.map(path => [...path].sort((a, b) => a - b).join(",")));
      assert.equal(cellSets.size, 1, `${entry.word} on ${rows} × ${columns}`);
    }
    assert.equal(everyChoiceCompletes(level), true, `${rows} × ${columns}`);
  }
});
