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

test("placement skips an ambiguous word and tries another word on the same route without changing the board", () => {
  const letters = ["", "", "", "A", "B", "C"];
  const before = [...letters];
  const options = { rows: 2, columns: 3, letters, random: () => 0 };
  assert.equal(createGenerator([{ word: "ABC" }]).findPlacement(options), null);
  const placement = createGenerator([{ word: "ABC" }, { word: "XYZ" }]).findPlacement(options);
  assert.equal(placement.word, "XYZ");
  assert.deepEqual(placement.path, [0, 1, 2]);
  assert.deepEqual(letters, before, "Rejected trial letters must not leak into the next candidate");
});

test("a new word cannot create another cell set for an earlier word on a shaped board", () => {
  const options = { rows: 2, columns: 3, disabledCells: [5], letters: ["C", "A", "T", "", "", ""],
    usedWords: ["CAT"], random: () => 0 };
  const fill = createGenerator([{ word: "COT" }, { word: "COW" }]);
  assert.equal(fill.findPlacement({ ...options, fixedWord: "COT" }), null);
  const placement = fill.findPlacement(options);
  assert.equal(placement.word, "COW");
  assert.deepEqual(placement.path, [0, 3, 4]);
  const letters = [...options.letters];
  placement.path.forEach((cell, step) => { letters[cell] = placement.word[step]; });
  const partial = { ...options, cells: letters.map(letter => ({ letter, count: letter ? 1 : 0 })) };
  for (const word of ["CAT", "COW"]) {
    const masks = pathsFor(partial, word, partial.cells.map(cell => cell.count))
      .map(path => [...path].sort((a, b) => a - b).join(","));
    assert.equal(new Set(masks).size, 1);
  }
  assert.equal(letters[5], "");
  assert.deepEqual(options.letters, ["C", "A", "T", "", "", ""]);
});

test("level 41's unsafe BANK placement is avoided while THAN is still on a partial board", () => {
  const letters = Array(12).fill("");
  [1, 2, 6, 7].forEach((cell, step) => { letters[cell] = "THAN"[step]; });
  const placement = createGenerator([{ word: "BANK" }]).findPlacement({ rows: 3, columns: 4,
    disabledCells: [0, 11], letters, usedWords: ["THAN"], fixedWord: "BANK", random: () => 0 });
  assert.ok(placement);
  assert.notDeepEqual(placement.path, [8, 9, 5, 4]);
  const next = [...letters];
  placement.path.forEach((cell, step) => { next[cell] = placement.word[step]; });
  const partial = { rows: 3, columns: 4, cells: next.map(letter => ({ letter, count: letter ? 1 : 0 })) };
  for (const word of ["THAN", "BANK"]) {
    const masks = pathsFor(partial, word, partial.cells.map(cell => cell.count))
      .map(path => [...path].sort((a, b) => a - b).join(","));
    assert.equal(new Set(masks).size, 1);
  }
  assert.ok(next.some((letter, cell) => !letter && ![0, 11].includes(cell)), "The check runs before the board is full");
});

test("an already ambiguous fixed layout is rejected before any random filling starts", () => {
  const config = { rows: 3, columns: 3, targetCount: 4, fixedWords: ["CAT", "COT"],
    fixedLayout: { rows: 3, columns: 3, placements: [
      { word: "CAT", path: [0, 1, 2] }, { word: "COT", path: [0, 3, 4] },
    ] }, random: () => { throw new Error("Filling must not start"); } };
  assert.throws(() => createGenerator(["CAT", "COT", "DOG", "HEN"].map(word => ({ word }))).generate(config),
    error => error.code !== "GENERATION_RETRY" && /固定布局.*用格歧义/.test(error.message));
});

test("different-cell alternatives remain extras while all safe candidates can be selected", () => {
  const options = { ...board, foundWords: generator.findWords(board) };
  let level = generator.selectTargets({ ...options, targetCount: 999, targetLengthPlan: [] });
  assert.ok(!level.candidateWords.some(entry => entry.word === "CAT"));
  assert.ok(level.extraWords.some(entry => entry.word === "CAT"));
  for (const word of ["COT", "TOT"]) level = setTargetWord(level, word, true);
  assert.equal(level.targetWords.length, 3);
  assert.ok(everyChoiceCompletes(level));
});

test("ambiguous initial and fixed words retry; a fully fixed ambiguous board fails immediately", async () => {
  const bad = legacyTrap();
  const options = { ...board, initialWords: bad.targetWords };
  assert.throws(() => generator.selectTargets({ ...options, foundWords: generator.findWords(options), targetCount: 3 }), /用格歧义/);
  const repeated = createGenerator(["AAA", "AAAA"].map(word => ({ word })));
  for (const fixedWords of [[], ["AAA"]]) {
    const settings = { rows: 2, columns: 3, targetCount: 2, fixedWords, random: () => 0.5 };
    assert.throws(() => repeated.generate(settings), error => error.code === "GENERATION_RETRY" && /填满棋盘/.test(error.message));
    let current = true;
    const generated = await generateUntilComplete(repeated, settings, { isCurrent: () => current, onProgress: () => { current = false; } });
    assert.equal(generated, null);
  }
  assert.throws(() => generator.generate({ rows: 2, columns: 3, targetCount: 3,
    fixedWords: ["CAT", "COT", "TOT"], fixedLayout: { rows: 2, columns: 3,
      placements: bad.targetWords.map(({ word, path }) => ({ word, path })) } }), /用格歧义/);
});

test("legacy metadata cannot bypass manual promotion or save/export safety checks", () => {
  const level = generator.selectTargets({ ...board, foundWords: generator.findWords(board), targetCount: 2, random: () => 0 });
  const legacy = structuredClone(level);
  const extra = legacy.extraWords.find(entry => entry.word === "CAT");
  assert.ok(extra);
  extra.pathAnalysis.safe = true;
  legacy.candidateWords.push(extra);
  assert.throws(() => setTargetWord(legacy, "CAT", true), /不同格子/);
  const bad = legacyTrap();
  assert.equal(everyChoiceCompletes(bad), false);
  bad.targetWords.forEach(entry => { entry.pathAnalysis.safe = true; });
  assert.throws(() => assertSafeTargetPaths(bad), /CAT/);
  assert.throws(() => createGameExport([{ level: bad }]), /第 1 关.*CAT/);
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

test("Edge level 41 reproduces the shaped-board deadlock and is rejected even with stale safety flags", async () => {
  const data = JSON.parse(await readFile(new URL('./fixtures/shaped-level-41.json', import.meta.url), 'utf8'));
  const [level] = importGameLevels({ books: [{ levels: [data] }], daily: [] });
  const check = createPathSafetyChecker(level);
  assert.deepEqual(level.disabledCells, [0, 11]);
  assert.deepEqual(level.targetWords.filter(entry => !check(entry.word)).map(entry => entry.word), ['NAP', 'PAN', 'THAN']);
  assert.equal(everyChoiceCompletes(level), false);
  for (const entry of level.targetWords) entry.pathAnalysis.safe = true;
  assert.throws(() => createGameExport([{ level }]), /NAP.*PAN.*THAN/);
  const { saveLevel, importSavedLevels } = await import('../dist/level-store.js');
  await assert.rejects(saveLevel(level), /不同格子/);
  assert.throws(() => importSavedLevels([level]), /第 1 关.*不同格子/);
  const fixedWords = ['THAN', 'BANK', 'SNAP'];
  const fixedLayout = { rows: 3, columns: 4, placements: [
    { word: 'THAN', path: [1, 2, 6, 7] }, { word: 'BANK', path: [8, 9, 5, 4] }, { word: 'SNAP', path: [3, 7, 6, 10] },
  ] };
  assert.throws(() => createGenerator(level.targetWords).generate({ rows: 3, columns: 4, disabledCells: [0, 11],
    targetCount: 9, fixedWords, fixedLayout }), /用格歧义/);
});

test("regenerated level-41 shape ignores retired slots and every legal play order can finish", async () => {
  const normal = JSON.parse(await readFile(new URL('../dist/data/required-words.json', import.meta.url)));
  const extras = JSON.parse(await readFile(new URL('../dist/data/extra-words.json', import.meta.url)));
  const real = createGenerator(normal, extras);
  let seed = 41;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const plan = ['short', 'short', 'short', 'short', 'medium', 'medium', 'medium', 'long', 'long'];
  for (let iteration = 0; iteration < 3; iteration++) {
    const level = await generateUntilComplete(real, { rows: 3, columns: 4, disabledCells: [0, 11], targetCount: 9,
      targetLengthPlan: plan, initialMaxWordLength: 4, maxWordLength: 5, initialForwardProbability: 80,
      initialRarityLevel: 1, minimumEmotionScore: 0, filters: { scope: [1, 2] }, random });
    const check = createPathSafetyChecker(level);
    assert.ok(level.targetWords.every(entry => check(entry.word)));
    assert.equal(level.targetLengthPlan, undefined);
    assert.equal(level.targetCount, level.targetWords.length);
    assert.equal(level.cells[0].count, 0); assert.equal(level.cells[11].count, 0);
    assert.ok(everyChoiceCompletes(level));
    assert.ok(createGameExport([{ level }]));
  }
});
