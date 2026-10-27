import assert from "node:assert/strict";
import test from "node:test";
import { allocateTargetLengths, countTargetLengthPlan, createGenerator, targetLengthGroup } from "../dist/level-generator.js";

test("numbered targets count exact categories without percentage rounding", () => {
  assert.deepEqual(countTargetLengthPlan(6, ["short", "medium", "long", "short", "short", "medium"]),
    { short: 3, medium: 2, long: 1 });
  const plan = Array(101).fill("short");
  plan[100] = "long";
  assert.deepEqual(countTargetLengthPlan(101, plan), { short: 100, medium: 0, long: 1 });
  assert.equal(countTargetLengthPlan(6, null), null);
  for (const invalid of [[], ["short"], "short", { short: 3 }, ["short", "medium", "unknown"], Array(3)]) {
    assert.throws(() => countTargetLengthPlan(3, invalid), /配置|请选择/);
  }
  assert.throws(() => countTargetLengthPlan(0, []), /目标数量/);
});

test("ratios round to exact word counts using largest remainders and stable short/medium/long ties", () => {
  assert.deepEqual(allocateTargetLengths(6, { short: 34, medium: 33, long: 33 }), { short: 2, medium: 2, long: 2 });
  assert.deepEqual(allocateTargetLengths(7, { short: 50, medium: 30, long: 20 }), { short: 4, medium: 2, long: 1 });
  assert.deepEqual(allocateTargetLengths(5, { short: 0, medium: 50, long: 50 }), { short: 0, medium: 3, long: 2 });
  assert.deepEqual(allocateTargetLengths(1, { short: 34, medium: 33, long: 33 }), { short: 1, medium: 0, long: 0 });
  const large = allocateTargetLengths(Number.MAX_SAFE_INTEGER, { short: 34, medium: 33, long: 33 });
  assert.equal(Object.values(large).reduce((sum, count) => sum + count, 0), Number.MAX_SAFE_INTEGER);
  assert.equal(allocateTargetLengths(6, null), null);
  assert.deepEqual([2, 3, 4, 5, 8].map(targetLengthGroup), [null, "short", "medium", "long", "long"]);
});

test("invalid ratios fail rather than being normalized or silently relaxed", () => {
  for (const ratios of [[], "50/30/20", {}, { short: 50, medium: 50 },
    { short: 50, medium: 30, long: 10 }, { short: 50, medium: 30, long: 21 },
    { short: -1, medium: 51, long: 50 }, { short: 0.5, medium: 49.5, long: 50 },
    { short: "50", medium: 30, long: 20 }, { short: 50, medium: 30, long: 20, other: 0 }]) {
    assert.throws(() => allocateTargetLengths(6, ratios), /占比/);
  }
  assert.throws(() => allocateTargetLengths(0, { short: 34, medium: 33, long: 33 }), /目标数量/);
});

function selectionFixture() {
  const generator = createGenerator([
    ...["ABCFEDGHI", "ABC", "DEF", "ABE", "CBA", "ABEF", "ABED", "ADGH", "GHEB", "ADGHE"]
      .map(word => ({ word, scope: 1 })),
    { word: "GHI", scope: 2 },
  ], [{ word: "ADG", scope: 1 }, { word: "ABCF", scope: 1 }]);
  const options = { rows: 3, columns: 3, letters: [..."ABCDEFGHI"], maxWordLength: 9,
    initialWords: [{ word: "ABCFEDGHI", path: [0, 1, 2, 5, 4, 3, 6, 7, 8] }], filters: { scope: [1] }, targetCount: 6 };
  return { generator, options: { ...options, foundWords: generator.findWords(options) } };
}

test("numbered plans preserve slot order, initial coverage and low-score promotion within each category", () => {
  const { generator, options } = selectionFixture();
  const targetLengthPlan = Object.freeze(["short", "medium", "long", "short", "medium", "short"]);
  const level = generator.selectTargets({ ...options, targetLengthPlan, random: () => 0 });
  assert.deepEqual(level.targetWords.map(entry => targetLengthGroup(entry.word.length)), targetLengthPlan);
  assert.deepEqual(level.targetLengthPlan, targetLengthPlan);
  assert.notEqual(level.targetLengthPlan, targetLengthPlan);
  assert.equal(level.targetLengthRatios, null);
  assert.deepEqual(level.targetLengthCounts, { short: 3, medium: 2, long: 1 });
  assert.equal(level.targetWords[2].word, "ABCFEDGHI");
  assert.deepEqual(level.targetWords[2].path, options.initialWords[0].path);
  assert.deepEqual(new Set([level.targetWords[1].word, level.targetWords[4].word]), new Set(["ADGH", "GHEB"]));
  assert.ok(level.targetWords.some(entry => entry.word === "ABC") && level.targetWords.some(entry => entry.word === "DEF"));
  assert.ok(["ADG", "ABCF", "GHI", "ADGHE"].every(word => level.extraWords.some(entry => entry.word === word)));
  const counts = Array(9).fill(0);
  for (const entry of level.targetWords) for (const cell of entry.path) counts[cell] += 1;
  assert.deepEqual(level.cells.map(cell => cell.count), counts);
});

test("numbered plans reject quota conflicts and incompatible length limits", () => {
  const { generator, options } = selectionFixture();
  assert.throws(() => generator.selectTargets({ ...options, targetLengthPlan: ["short", "short", "short", "medium", "medium", "medium"] }), /超过配置/);
  assert.throws(() => generator.selectTargets({ ...options, targetLengthPlan: Array(6).fill("long") }), /长词.*只有/);
  const limited = createGenerator(["AAA", "AAAA", "AAAAA", "AAAAAA"].map(word => ({ word })));
  const settings = { rows: 2, columns: 3, targetCount: 2, targetLengthPlan: ["long", "short"] };
  assert.throws(() => limited.generate({ ...settings, initialMaxWordLength: 3 }), /无法填满棋盘/);
  assert.throws(() => limited.generate({ ...settings, maxWordLength: 4 }), /长词.*只有 0/);
  const restricted = createGenerator([{ word: "AAA" }, { word: "AAAA" }], [{ word: "AAAAA" }]);
  assert.throws(() => restricted.generate(settings), /长词.*只有 0/);
});

test("initial words consume quotas and each group promotes low scores without accepting extras or excluded words", () => {
  const { generator, options } = selectionFixture();
  const level = generator.selectTargets({ ...options, targetLengthRatios: { short: 50, medium: 33, long: 17 }, random: () => 0 });
  assert.deepEqual(level.targetLengthCounts, { short: 3, medium: 2, long: 1 });
  assert.equal(level.targetWords.length, 6);
  assert.equal(level.targetWords[0].word, "ABCFEDGHI");
  assert.deepEqual(level.targetWords[0].path, options.initialWords[0].path);
  const groups = Object.fromEntries(["short", "medium", "long"].map(key => [key,
    level.targetWords.filter(entry => targetLengthGroup(entry.word.length) === key)]));
  assert.equal(groups.short.length, 3);
  assert.ok(groups.short.some(entry => entry.word === "ABC") && groups.short.some(entry => entry.word === "DEF"));
  assert.deepEqual(new Set(groups.medium.map(entry => entry.word)), new Set(["ADGH", "GHEB"]));
  assert.deepEqual(groups.long.map(entry => entry.word), ["ABCFEDGHI"]);
  assert.ok(["ADG", "ABCF", "GHI", "ADGHE"].every(word => level.extraWords.some(entry => entry.word === word)));
  const counts = Array(9).fill(0);
  for (const entry of level.targetWords) for (const cell of entry.path) counts[cell] += 1;
  assert.deepEqual(level.cells.map(cell => cell.count), counts);
});

test("quota conflicts and missing groups fail explicitly", () => {
  const { generator, options } = selectionFixture();
  assert.throws(() => generator.selectTargets({ ...options, targetLengthRatios: { short: 50, medium: 50, long: 0 } }), /超过配置/);
  assert.throws(() => generator.selectTargets({ ...options, targetLengthRatios: { short: 33, medium: 17, long: 50 } }), /长词.*只有/);
});

test("initial filling reserves the requested groups and zero-share words remain extras", () => {
  const generator = createGenerator(["AAA", "AAAA", "AAAAA", "AAAAAA"].map(word => ({ word })));
  const level = generator.generate({ rows: 2, columns: 3, targetCount: 2, targetLengthRatios: { short: 0, medium: 0, long: 100 }, random: () => 0 });
  assert.ok(level.initialWords.every(entry => entry.word.length >= 5));
  assert.deepEqual(new Set(level.targetWords.map(entry => entry.word)), new Set(["AAAAA", "AAAAAA"]));
  assert.deepEqual(new Set(level.extraWords.map(entry => entry.word)), new Set(["AAA", "AAAA"]));
  assert.deepEqual(level.targetLengthCounts, { short: 0, medium: 0, long: 2 });
});

test("length caps, initial coverage and only-extra restrictions cannot be bypassed by ratios", () => {
  const generator = createGenerator(["AAA", "AAAA", "AAAAA", "AAAAAA"].map(word => ({ word })));
  const options = { rows: 2, columns: 3, targetCount: 2, targetLengthRatios: { short: 50, medium: 0, long: 50 } };
  assert.throws(() => generator.generate({ ...options, initialMaxWordLength: 3 }), /无法填满棋盘/);
  assert.throws(() => generator.generate({ ...options, maxWordLength: 4 }), /长词.*只有 0/);
  const restricted = createGenerator([{ word: "AAA" }, { word: "AAAA" }], [{ word: "AAAAA" }]);
  assert.throws(() => restricted.generate(options), /长词.*只有 0/);
});
