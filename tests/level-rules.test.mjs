import assert from "node:assert/strict";
import test from "node:test";
import { createGenerator, generateUntilComplete } from "../dist/level-generator.js";
import { createDuplicateCheck, findDuplicateWords, setTargetWord } from "../dist/level-rules.js";

const records = [
  { word: "ABCDEF", emotion: 1, rarityLevel: 2, scope: 1 },
  { word: "ABC", emotion: 2, rarityLevel: 1, scope: 1 },
  { word: "DEF", emotion: -1, rarityLevel: 2, scope: 1 },
  { word: "AFE", emotion: 0, rarityLevel: 1, scope: 1 },
  { word: "CBE", emotion: -2, rarityLevel: 3, scope: 2 },
];
const generator = createGenerator(records, [{ word: "FED", emotion: -2, rarityLevel: 4 }]);
const board = { rows: 2, columns: 3, letters: [..."ABCFED"],
  initialWords: [{ ...records[0], onlyExtra: false, path: [0, 1, 2, 5, 4, 3] }] };
const makeLevel = () => generator.selectTargets({ ...board, targetCount: 2, filters: { scope: [1] },
  foundWords: generator.findWords(board), random: () => 0 });
const historyEntry = (id, targets, extras = []) => ({ id, level: {
  targetWords: targets.map(word => ({ word })), extraWords: extras.map(word => ({ word })),
} });

test("target and extra duplicate windows use independent last-N ranges and can be disabled separately", () => {
  const history = [historyEntry(1, ["OLD"]), historyEntry(7, ["ABC"], ["FED"]), historyEntry(12, ["DEF"], ["ABC"])];
  const check = createDuplicateCheck(history, { target: 2, extra: 1 });
  assert.deepEqual(check.target.levelIds, [7, 12]);
  assert.deepEqual(check.target.words, ["ABC", "DEF"]);
  assert.deepEqual(check.extra.levelIds, [12]);
  assert.deepEqual(check.extra.words, ["ABC"]);
  for (const kind of ["target", "extra"]) {
    const disabled = createDuplicateCheck(history, { target: 2, extra: 2, [kind]: 0 });
    assert.deepEqual(disabled[kind], { range: 0, words: [], levelIds: [] });
    assert.ok(disabled[kind === "target" ? "extra" : "target"].words.length > 0);
    assert.deepEqual(createDuplicateCheck(history, { target: 20, extra: 20 })[kind].levelIds, [1, 7, 12]);
    assert.deepEqual(createDuplicateCheck([], { target: 20, extra: 20 })[kind].words, []);
    for (const range of [-1, 1.2, NaN, Infinity]) {
      assert.throws(() => createDuplicateCheck(history, { target: 2, extra: 2, [kind]: range }), /查重范围/);
    }
  }
});

test("checking ignores letter case but compares only the same word category", () => {
  const level = makeLevel();
  const duplicateCheck = createDuplicateCheck([historyEntry(1, ["abcdef", "ABC", "FED"], ["fed", "FED", "ABC"])],
    { target: 20, extra: 20 });
  assert.deepEqual(findDuplicateWords(level, duplicateCheck), { target: ["ABCDEF", "ABC"], extra: ["FED"] });
  const oppositeRoles = createDuplicateCheck([historyEntry(1, ["FED"], ["ABCDEF", "ABC"])], { target: 20, extra: 20 });
  assert.deepEqual(findDuplicateWords(level, oppositeRoles), { target: [], extra: [] });
});

test("generated boards with repeat initial or extra words fail and continue retrying", async () => {
  const simple = createGenerator([{ word: "ABCDEF" }], [{ word: "ABC" }]);
  for (const kind of ["target", "extra"]) {
    const duplicateCheck = createDuplicateCheck([historyEntry(1, ["ABCDEF"], ["ABC"])],
      { target: 0, extra: 0, [kind]: 20 });
    const options = { rows: 2, columns: 3, targetCount: 1, duplicateCheck, random: () => 0 };
    assert.throws(() => simple.generate(options), error => error.code === "GENERATION_RETRY" && /重复单词/.test(error.message));
    let current = true;
    const attempts = [];
    const result = await generateUntilComplete(simple, options, {
      isCurrent: () => current,
      onProgress: progress => { attempts.push(progress.attempts); if (attempts.length === 2) current = false; },
    });
    assert.equal(result, null);
    assert.deepEqual(attempts, [80, 160]);
  }
});

test("generation allows cross-category repeats and repeats in the independently disabled category", () => {
  const simple = createGenerator([{ word: "ABCDEF" }], [{ word: "ABC" }]);
  const options = { rows: 2, columns: 3, targetCount: 1, random: () => 0 };
  const cases = [
    { history: historyEntry(1, ["ABC"], ["ABCDEF"]), ranges: { target: 20, extra: 20 } },
    { history: historyEntry(1, ["ABCDEF"], []), ranges: { target: 0, extra: 20 } },
    { history: historyEntry(1, [], ["ABC"]), ranges: { target: 20, extra: 0 } },
  ];
  for (const { history, ranges } of cases) {
    const duplicateCheck = createDuplicateCheck([history], ranges);
    const level = simple.generate({ ...options, duplicateCheck });
    assert.equal(level.targetWords[0].word, "ABCDEF");
    assert.deepEqual(findDuplicateWords(level, duplicateCheck), { target: [], extra: [] });
  }
});

test("out-of-window duplicates do not reject generation, and audit data omits history word payloads", () => {
  const simple = createGenerator([{ word: "ABCDEF" }], [{ word: "ABC" }]);
  const history = [historyEntry(1, ["ABCDEF"]), historyEntry(2, ["GHI"])];
  const duplicateCheck = createDuplicateCheck(history, { target: 1, extra: 2 });
  const options = { rows: 2, columns: 3, targetCount: 1, random: () => 0 };
  const level = simple.generate({ ...options, duplicateCheck });
  assert.deepEqual(level.duplicateCheck, { target: { range: 1, levelIds: [2] }, extra: { range: 2, levelIds: [1, 2] } });
  assert.deepEqual(findDuplicateWords(level, duplicateCheck), { target: [], extra: [] });
  assert.equal(simple.generate({ ...options, duplicateCheck: createDuplicateCheck(history, { target: 0, extra: 0 }) }).targetWords.length, 1);
});

test("manual promotion and removal update counts, membership, emotion and all target statistics without changing the board", () => {
  const original = makeLevel();
  const untouched = structuredClone(original);
  assert.deepEqual(original.targetWords.map(entry => entry.word), ["ABCDEF", "ABC"]);
  const promoted = setTargetWord(original, "DEF", true);
  assert.equal(promoted.targetWords.length, 3);
  assert.equal(promoted.extraWords.length, original.extraWords.length - 1);
  assert.deepEqual(promoted.cells.map(cell => cell.count), [2, 2, 2, 2, 2, 2]);
  assert.equal(promoted.statistics.workload.targetCount, 3);
  assert.equal(original.statistics.vocabulary.rarityTotal, 3);
  assert.equal(promoted.statistics.vocabulary.rarityTotal, 5);
  assert.equal(promoted.statistics.workload.totalLetters, 12);
  assert.equal(promoted.statistics.words.total, original.statistics.words.total);
  assert.equal(promoted.statistics.emotion.total, original.statistics.emotion.total - 0.7);
  assert.deepEqual(promoted.statistics.vocabulary.rarityDistribution, { 1: 1, 2: 2, 3: 0, 4: 0, 5: 0 });
  const removed = setTargetWord(promoted, "ABC", false);
  assert.equal(removed.statistics.vocabulary.rarityTotal, 4);
  assert.deepEqual(removed.cells.map(cell => cell.count), [1, 1, 1, 2, 2, 2]);
  assert.ok(removed.extraWords.some(entry => entry.word === "ABC"));
  assert.deepEqual(removed.cells.map(cell => cell.letter), original.cells.map(cell => cell.letter));
  assert.deepEqual(removed.initialWords, original.initialWords);
  assert.deepEqual(removed.candidateWords, original.candidateWords);
  assert.deepEqual(original, untouched, "Editing must not mutate the original saved snapshot");
  assert.equal(promoted.targetCount, original.targetCount, "Generation settings remain unchanged by manual selection");
});

test("initial words are locked and excluded or unknown words cannot be promoted", () => {
  const level = makeLevel();
  assert.throws(() => setTargetWord(level, "ABCDEF", false), /初始词/);
  for (const word of ["FED", "CBE", "MISSING"]) assert.throws(() => setTargetWord(level, word, true), /候选词/);
  const onlyInitial = setTargetWord(level, "ABC", false);
  assert.ok(onlyInitial.cells.every(cell => cell.count === 1));
  assert.deepEqual(onlyInitial.targetWords, level.initialWords);
  assert.equal(setTargetWord(level, "ABC", true), level);
  assert.equal(setTargetWord(level, "DEF", false), level);
});
