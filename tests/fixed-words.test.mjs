import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFixedWords, validateFixedWords } from "../dist/fixed-words.js";
import { createGenerator } from "../dist/level-generator.js";
import { createDuplicateCheck, setTargetWord } from "../dist/level-rules.js";
import { patchLevelConfigs, readConfigList, saveConfigList } from "../dist/level-config.js";
import { createGameExport } from "../dist/level-export.js";

const config = () => ({ rows: 3, columns: 3, targetCount: 3, targetLengthPlan: ["short", "short", "short"],
  initialMaxWordLength: 3, maxWordLength: 8, initialForwardProbability: 50, initialRarityLevel: 1,
  minimumEmotionScore: 0, filters: {}, targetDuplicateRange: 20, extraDuplicateRange: 0 });
const entries = words => words.map(word => ({ word, rarityLevel: 1, emotion: 0, scope: 1 }));
const randomFrom = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
function verify(level, expected) {
  assert.deepEqual(level.fixedWords, expected);
  const counts = Array(level.cells.length).fill(0);
  for (const word of expected) {
    assert.ok(level.initialWords.some(entry => entry.word === word));
    assert.ok(level.targetWords.some(entry => entry.word === word));
    assert.ok(!level.extraWords.some(entry => entry.word === word));
    assert.throws(() => setTargetWord(level, word, false), /初始词不能移出/);
  }
  for (const entry of level.targetWords) {
    assert.equal(new Set(entry.path).size, entry.word.length);
    assert.equal(entry.path.map(cell => level.cells[cell].letter).join(""), entry.word);
    for (const cell of entry.path) counts[cell] += 1;
  }
  assert.ok(counts.every(count => count > 0));
  assert.deepEqual(level.cells.map(cell => cell.count), counts);
  assert.equal(level.targetWords.length, level.targetCount);
}

test("preset input accepts common separators, uppercases and deduplicates words", () => {
  assert.deepEqual(normalizeFixedWords(" cat, DOG\ncat，Hen、sun; ant；ant "), ["CAT", "DOG", "HEN", "SUN", "ANT"]);
  assert.deepEqual(normalizeFixedWords(["cat", " CAT ", "dog"]), ["CAT", "DOG"]);
  assert.deepEqual(normalizeFixedWords(" \n, "), []);
  for (const invalid of [null, {}, [123], "ice-cream", "CAT1", "猫", "<script>"]) assert.throws(() => normalizeFixedWords(invalid));
});

test("single and multiple presets are placed first, preserved as targets, and consume quotas", () => {
  const generator = createGenerator(entries(["CAT", "DOG", "HEN"]));
  for (const fixedWords of [["CAT"], ["CAT", "DOG"], ["CAT", "DOG", "HEN"]]) {
    for (let seed = 1; seed <= 4; seed++) {
      const level = generator.generate({ ...config(), fixedWords, random: randomFrom(seed) });
      verify(level, fixedWords);
      assert.ok(level.initialWords.slice(0, fixedWords.length).every(entry => fixedWords.includes(entry.word)));
      assert.deepEqual(level.targetLengthCounts, { short: 3, medium: 0, long: 0 });
    }
  }
});

test("presets can fully share existing letters and remain mandatory when the board is already full", () => {
  const generator = createGenerator(entries(["ABCDEF", "ABC"]));
  const level = generator.generate({ ...config(), rows: 2, columns: 3, targetCount: 2,
    targetLengthPlan: ["short", "long"], initialMaxWordLength: 6, fixedWords: ["ABC", "ABCDEF"], random: randomFrom(42) });
  verify(level, ["ABC", "ABCDEF"]);
  assert.deepEqual(level.initialWords.map(entry => entry.word), ["ABCDEF", "ABC"]);
  assert.deepEqual(level.targetWords.map(entry => entry.word), ["ABC", "ABCDEF"]);
  assert.ok(level.cells.some(cell => cell.count === 2));
  const exported = createGameExport([{ level }]).books[0].levels[0];
  assert.equal(exported.t, "ABC ABCDEF");
  assert.equal(exported.n, level.cells.map(cell => cell.count.toString(36)).join(""));
});

test("preset conflicts with quantity, length, quotas or letter capacity fail before searching", () => {
  for (const patch of [
    { fixedWords: ["CAT", "DOG"], targetCount: 1 },
    { fixedWords: ["CATS"] },
    { fixedWords: ["CAT"], maxWordLength: 2 },
    { fixedWords: ["ABCDEFGHIJ"], initialMaxWordLength: 10, maxWordLength: 10 },
    { fixedWords: ["CAT"], targetLengthPlan: ["long", "long", "long"] },
    { fixedWords: ["CAT", "DOG", "HEN"], rows: 2 },
  ]) {
    const settings = { ...config(), ...patch };
    const counts = settings.targetLengthPlan.reduce((result, group) => { result[group]++; return result; }, { short: 0, medium: 0, long: 0 });
    assert.throws(() => validateFixedWords(settings, counts), /固定单词/);
  }
  const generator = createGenerator(entries(["ABC", "ABCDEF"]));
  assert.throws(() => generator.generate({ rows: 2, columns: 3, targetCount: 1, fixedWords: ["ABC"] }), /无法填满棋盘/);
});

test("presets cannot bypass dictionary roles, filters, initial rarity or target duplicate history", () => {
  const generator = createGenerator([...entries(["CAT", "DOG", "HEN"]), { word: "ANT", rarityLevel: 2, scope: 1 }], entries(["TAC"]));
  for (const [patch, message] of [
    [{ fixedWords: ["XYZ"] }, /XYZ.*不在词库/],
    [{ fixedWords: ["TAC"] }, /TAC.*仅额外/],
    [{ fixedWords: ["CAT"], filters: { scope: [2] } }, /CAT.*词库筛选/],
    [{ fixedWords: ["ANT"] }, /ANT.*生僻档位 1/],
    [{ fixedWords: ["CAT"], duplicateCheck: createDuplicateCheck([{ id: 9, level: { targetWords: [{ word: "cat" }], extraWords: [] } }], { target: 20, extra: 0 }) }, /CAT.*目标词重复/],
  ]) {
    assert.throws(() => generator.generate({ ...config(), ...patch }), error => error.code !== "GENERATION_RETRY" && message.test(error.message));
  }
  const crossCategory = createDuplicateCheck([{ id: 9, level: { targetWords: [], extraWords: [{ word: "CAT" }] } }], { target: 20, extra: 0 });
  verify(generator.generate({ ...config(), fixedWords: ["CAT"], duplicateCheck: crossCategory, random: randomFrom(7) }), ["CAT"]);
});

test("preset words do not bypass the minimum emotion rule", () => {
  const generator = createGenerator([{ word: "ABCDEF", rarityLevel: 1, emotion: -1 }]);
  assert.throws(() => generator.generate({ rows: 2, columns: 3, targetCount: 1, initialRarityLevel: 1,
    minimumEmotionScore: 0, fixedWords: ["ABCDEF"] }), error => error.code === "GENERATION_RETRY" && /情绪总分/.test(error.message));
});

test("preset bulk editing and storage are atomic, independent, clearable and compatible with old rows", () => {
  const original = ["a", "b", "c"].map(id => ({ id, config: config() }));
  const updated = patchLevelConfigs(original, ["a", "c"], { fixedWords: "cat, DOG, cat" });
  assert.deepEqual(updated[0].config.fixedWords, ["CAT", "DOG"]);
  assert.equal(updated[1], original[1]);
  assert.notEqual(updated[0].config.fixedWords, updated[2].config.fixedWords);
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  saveConfigList(updated, storage);
  assert.deepEqual(readConfigList(storage), updated);
  assert.equal(original[0].config.fixedWords, undefined);
  const before = structuredClone(updated);
  assert.throws(() => patchLevelConfigs(updated, ["a", "c"], { targetCount: 1 }), /固定单词/);
  assert.deepEqual(updated, before);
  const cleared = patchLevelConfigs(updated, ["a"], { fixedWords: "" });
  assert.deepEqual(cleared[0].config.fixedWords, []);
  assert.deepEqual(cleared[2].config.fixedWords, ["CAT", "DOG"]);
});
