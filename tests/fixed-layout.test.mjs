import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFixedLayout, fixedLayoutLetters } from "../dist/fixed-words.js";
import { createGenerator } from "../dist/level-generator.js";
import { patchLevelConfigs, saveConfigList, readConfigList } from "../dist/level-config.js";

const records = words => words.map(word => ({ word, rarityLevel: 1, emotion: 0, scope: 1 }));
const settings = () => ({ rows: 3, columns: 3, targetCount: 3, targetLengthPlan: ["short", "short", "short"],
  initialMaxWordLength: 3, maxWordLength: 8, initialForwardProbability: 0, initialRarityLevel: 1,
  minimumEmotionScore: 0, filters: {}, targetDuplicateRange: 0, extraDuplicateRange: 0, fixedWords: ["CAT", "DOG"],
  fixedLayout: { rows: 3, columns: 3, placements: [{ word: "CAT", path: [0, 1, 2] }, { word: "DOG", path: [3, 4, 5] }] } });
const randomFrom = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

test("pinned words keep their exact cells and direction while the generator fills remaining cells", () => {
  const generator = createGenerator(records(["CAT", "DOG", "HEN"]));
  const config = settings(), before = structuredClone(config);
  for (let seed = 1; seed <= 8; seed++) {
    const level = generator.generate({ ...config, random: randomFrom(seed) });
    assert.deepEqual(level.fixedLayout, config.fixedLayout);
    assert.equal(level.cells.slice(0, 6).map(cell => cell.letter).join(""), "CATDOG");
    for (const placement of config.fixedLayout.placements) {
      assert.deepEqual(level.initialWords.find(entry => entry.word === placement.word).path, placement.path);
      assert.deepEqual(level.targetWords.find(entry => entry.word === placement.word).path, placement.path);
    }
    assert.ok(level.cells.every(cell => cell.count > 0));
    assert.equal(level.targetWords.length, 3);
    level.fixedLayout.placements[0].path[0] = 8;
    assert.deepEqual(config, before);
  }
});

test("overlapping presets share matching letters and all remain targets on a full preset board", () => {
  const generator = createGenerator(records(["CAT", "CAR", "ORE"]));
  const config = { ...settings(), rows: 2, fixedWords: ["CAT", "CAR", "ORE"],
    fixedLayout: { rows: 2, columns: 3, placements: [
      { word: "CAT", path: [0, 1, 2] }, { word: "CAR", path: [0, 1, 4] }, { word: "ORE", path: [3, 4, 5] },
    ] } };
  const level = generator.generate(config);
  assert.deepEqual(level.cells.map(cell => cell.letter), [..."CATORE"]);
  assert.deepEqual(level.cells.map(cell => cell.count), [2, 2, 1, 1, 2, 1]);
  assert.deepEqual(level.initialWords.map(({ word, path }) => ({ word, path })), config.fixedLayout.placements);
  const remaining = config.fixedLayout.placements.filter(entry => entry.word !== "CAR");
  assert.deepEqual(fixedLayoutLetters(2, 3, remaining), [..."CATORE"], "Removing a word must preserve letters shared by other words");
});

test("malformed, conflicting, stale-size and permanently ambiguous layouts fail before generation", () => {
  const base = settings();
  for (const patch of [
    { rows: 2 },
    { placements: [{ word: "CAT", path: [0, 0, 1] }] },
    { placements: [{ word: "CAT", path: [0, 1, 9] }] },
    { placements: [{ word: "CAT", path: [1, 2, 3] }] },
    { placements: [{ word: "CAT", path: [0, 4, 5] }] },
    { placements: [{ word: "MISSING", path: [0] }] },
    { placements: [{ word: "CAT", path: [0, 1, 2] }, { word: "CAT", path: [3, 4, 5] }] },
    { placements: [{ word: "CAT", path: [0, 1, 2] }, { word: "DOG", path: [0, 3, 6] }] },
  ]) assert.throws(() => normalizeFixedLayout({ ...base, fixedLayout: { ...base.fixedLayout, ...patch } }));
  const unsafe = { ...base, fixedWords: ["CAT", "COT"], fixedLayout: { rows: 3, columns: 3,
    placements: [{ word: "CAT", path: [0, 1, 2] }, { word: "COT", path: [0, 3, 4] }] } };
  assert.throws(() => createGenerator(records(["CAT", "COT", "HEN"])).generate(unsafe),
    error => error.code !== "GENERATION_RETRY" && /CAT.*不同格子/.test(error.message));
});

test("pinned overlap counts as covered cells rather than summed word lengths in coverage checks", () => {
  const config = { ...settings(), fixedWords: ["CAT", "CAR"], fixedLayout: { rows: 3, columns: 3,
    placements: [{ word: "CAT", path: [0, 1, 2] }, { word: "CAR", path: [0, 1, 4] }] } };
  const generator = createGenerator(records(["CAT", "CAR", "HEN"]));
  assert.throws(() => generator.generate(config), error => error.code !== "GENERATION_RETRY" && /无法填满/.test(error.message));
});

test("legacy unpositioned words remain supported, and unsafe completions retry without moving pins", () => {
  const generator = createGenerator(records(["CAT", "DOG", "HEN"]));
  const config = settings();
  config.fixedLayout.placements.pop();
  const level = generator.generate({ ...config, random: randomFrom(3) });
  assert.deepEqual(level.initialWords.find(entry => entry.word === "CAT").path, [0, 1, 2]);
  assert.ok(level.targetWords.some(entry => entry.word === "DOG"));
  const unsafe = { ...settings(), rows: 2, targetLengthPlan: null, fixedWords: ["CAT", "CO"], fixedLayout: { rows: 2, columns: 3,
    placements: [{ word: "CAT", path: [0, 1, 2] }, { word: "CO", path: [0, 3] }] } };
  assert.throws(() => createGenerator(records(["CAT", "CO", "COT", "TOT"])).generate(unsafe),
    error => error.code === "GENERATION_RETRY" && /不同格子/.test(error.message));
  assert.deepEqual(unsafe.fixedLayout.placements[0].path, [0, 1, 2]);
});

test("bulk saved layouts remain independent and cannot silently shift after a board-size change", () => {
  const base = settings();
  const original = ["a", "b"].map(id => ({ id, config: { ...base, fixedWords: [], fixedLayout: null } }));
  const updated = patchLevelConfigs(original, ["a", "b"], { fixedWords: base.fixedWords, fixedLayout: base.fixedLayout });
  assert.notEqual(updated[0].config.fixedLayout.placements[0].path, updated[1].config.fixedLayout.placements[0].path);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  saveConfigList(updated, storage);
  assert.deepEqual(readConfigList(storage), updated);
  assert.throws(() => patchLevelConfigs(updated, ["a"], { columns: 4 }), /尺寸已变化/);
  const cleared = patchLevelConfigs(updated, ["a"], { fixedWords: [] });
  assert.equal(cleared[0].config.fixedLayout, null);
  assert.deepEqual(cleared[1].config.fixedLayout, base.fixedLayout);
});

test("a fully pinned board reports impossible target settings instead of retrying an unchanged board", () => {
  const config = { ...settings(), rows: 2, fixedLayout: { ...settings().fixedLayout, rows: 2 } };
  assert.throws(() => createGenerator(records(["CAT", "DOG", "XYZ"])).generate(config),
    error => error.code !== "GENERATION_RETRY" && /固定棋盘只有 2 个/.test(error.message));
  assert.throws(() => createGenerator(records(["CAT", "DOG", "CDO", "ZZZZZ"])).generate({ ...config,
    targetLengthPlan: ["short", "short", "long"] }),
    error => error.code !== "GENERATION_RETRY" && /固定棋盘无法满足目标词长/.test(error.message));
  assert.throws(() => createGenerator([...records(["CAT", "DOG"]), { word: "CDO", rarityLevel: 1, emotion: -2 }]).generate({ ...config,
    targetCount: 2, targetLengthPlan: ["short", "short"] }),
    error => error.code !== "GENERATION_RETRY" && /情绪总分/.test(error.message));
});

test("automatic-only preset words follow the initial direction preference without pinning their paths", () => {
  const generator = createGenerator(records(["CAT", "DOG", "HEN"]));
  for (const initialForwardProbability of [0, 100]) {
    const level = generator.generate({ ...settings(), fixedLayout: null, initialForwardProbability, random: randomFrom(31) });
    assert.equal(level.fixedLayout, null);
    assert.deepEqual(level.fixedWords, ["CAT", "DOG"]);
    assert.ok(level.fixedWords.every(word => level.initialWords.some(entry => entry.word === word)));
    const first = level.initialWords[0].path;
    assert.equal(first[1] > first[0], initialForwardProbability === 100);
    assert.ok(level.targetWords.every(entry => entry.pathAnalysis.safe));
  }
});

test("switching presets to automatic keeps the words and can be applied across different board sizes", () => {
  const original = [{ id: "large", config: settings() }, { id: "small", config: { ...settings(), rows: 2,
    targetCount: 2, targetLengthPlan: ["short", "short"], fixedLayout: null } }];
  const updated = patchLevelConfigs(original, ["large", "small"], { fixedWords: ["CAT", "DOG"], fixedLayout: null });
  assert.notEqual(original[0].config.fixedLayout, null);
  const generator = createGenerator(records(["CAT", "DOG", "HEN"]));
  for (const { config } of updated) {
    const level = generator.generate({ ...config, random: randomFrom(17) });
    assert.equal(level.fixedLayout, null);
    assert.deepEqual(level.fixedWords, ["CAT", "DOG"]);
    assert.ok(level.fixedWords.every(word => level.targetWords.some(entry => entry.word === word)));
    assert.ok(level.cells.every(cell => cell.letter && cell.count > 0));
  }
});
