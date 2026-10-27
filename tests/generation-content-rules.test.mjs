import assert from "node:assert/strict";
import test from "node:test";
import { createGenerator, generateUntilComplete } from "../dist/level-generator.js";
import { calculateRarityTotal } from "../dist/level-statistics.js";

test("only initial words are restricted to rarity one; ordinary abbreviations and other target rarities remain eligible", () => {
  const generator = createGenerator([
    { word: "ABCDEF", rarityLevel: 1, emotion: 0, abbreviation: 0 },
    { word: "ABC", rarityLevel: 5, emotion: 0, abbreviation: 1 },
    { word: "GHIJKL", rarityLevel: 5, emotion: 0 },
  ], [{ word: "CBA", rarityLevel: 4, emotion: 1, abbreviation: 1 }]);
  const level = generator.generate({ rows: 2, columns: 3, targetCount: 2, initialRarityLevel: 1, minimumEmotionScore: 0, random: () => 0 });
  assert.deepEqual(level.initialWords.map(entry => [entry.word, entry.rarityLevel]), [["ABCDEF", 1]]);
  assert.ok(level.targetWords.some(entry => entry.word === "ABC" && entry.rarityLevel === 5 && entry.abbreviation === 1));
  assert.ok(level.extraWords.some(entry => entry.word === "CBA" && entry.onlyExtra && entry.abbreviation === 1));
  assert.ok(!level.candidateWords.some(entry => entry.word === "CBA"));
  assert.equal(level.statistics.vocabulary.rarityTotal, 6);
  assert.equal(level.initialRarityLevel, 1);
  assert.equal(level.minimumEmotionScore, 0);
});

test("initial rarity participates in placement and coverage checks without broadening other filters", () => {
  const generator = createGenerator([{ word: "ABC", rarityLevel: 1 }, { word: "ABCDEF", rarityLevel: 2 }]);
  const placement = generator.findPlacement({ rows: 2, columns: 3, letters: Array(6).fill(""), initialRarityLevel: 1 });
  assert.equal(placement.word, "ABC");
  assert.throws(() => generator.generate({ rows: 2, columns: 3, targetCount: 2, initialRarityLevel: 1 }), /无法填满棋盘/);
  assert.throws(() => generator.generate({ rows: 2, columns: 3, initialRarityLevel: 1, filters: { rarityLevel: [2] } }), /没有可用的初始词/);
  for (const initialRarityLevel of [0, 6, 1.5, "1", NaN]) {
    assert.throws(() => generator.generate({ rows: 2, columns: 3, initialRarityLevel }), /初始词生僻档位/);
  }
});

test("negative weighted emotion retries while zero and positive totals are accepted", async () => {
  const options = { rows: 2, columns: 3, targetCount: 1, minimumEmotionScore: 0, initialRarityLevel: 1, random: () => 0 };
  const generator = emotion => createGenerator([{ word: "ABCDEF", rarityLevel: 1, emotion }], [{ word: "ABC", emotion: -2 }]);
  const negative = generator(0);
  assert.equal(negative.generate({ ...options, minimumEmotionScore: null }).statistics.emotion.total, -0.6);
  assert.throws(() => negative.generate(options), error => error.code === "GENERATION_RETRY" && /情绪总分/.test(error.message));
  let active = true;
  const progress = [];
  const stopped = await generateUntilComplete(negative, options, {
    isCurrent: () => active,
    onProgress: value => { progress.push(value.attempts); active = false; },
  });
  assert.equal(stopped, null);
  assert.deepEqual(progress, [80]);
  assert.equal(generator(1).generate(options).statistics.emotion.total, 0.4);
  const zero = createGenerator([{ word: "ABCDEF", rarityLevel: 1, emotion: 0 }]);
  assert.equal(zero.generate(options).statistics.emotion.total, 0);
  assert.throws(() => zero.generate({ ...options, minimumEmotionScore: NaN }), /情绪总分下限/);
});

test("rarity totals add all targets and preserve unknown metadata as unknown", () => {
  assert.equal(calculateRarityTotal([{ rarityLevel: 1 }, { rarityLevel: 3 }, { rarityLevel: 5 }]), 9);
  assert.equal(calculateRarityTotal([{ rarityLevel: 1 }, {}]), null);
  assert.equal(calculateRarityTotal([{ rarityLevel: 0 }]), null);
});
