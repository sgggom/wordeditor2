import assert from "node:assert/strict";
import test from "node:test";
import { importGameLevels, importSingleGameLevel } from "../dist/level-import.js";
import { createGameExport } from "../dist/level-export.js";

const fixture = () => ({ books: [{ levels: [{ name: "测试", g: "ABC,DEF", t: "ABC DEF", e: "FED", n: "111111" }] }], daily: [] });

test("game import restores paths, dictionary metadata, statistics and export counts", () => {
  const data = fixture();
  const before = structuredClone(data);
  const [level] = importGameLevels(data, [{ word: "ABC", emotion: 1, rarityLevel: 2 }]);
  assert.equal(level.targetWords[0].emotion, 1);
  assert.equal(level.statistics.workload.targetCount, 2);
  assert.equal(level.initialWords.length, 0);
  assert.equal(level.candidateWords.length, 3);
  const exported = createGameExport([{ level }]).books[0].levels[0];
  for (const key of ["name", "g", "t", "e", "n"]) assert.equal(exported[key], data.books[0].levels[0][key]);
  assert.deepEqual(data, before);
});

test("ambiguous target paths respect the file's per-cell counts", () => {
  const data = { books: [{ levels: [{ g: "AAA,BBB", t: "AB ABBA", e: "", n: "111111" }] }], daily: [] };
  const [level] = importGameLevels(data);
  const counts = Array(6).fill(0);
  for (const entry of level.targetWords) for (const cell of entry.path) counts[cell]++;
  assert.deepEqual(counts, [...data.books[0].levels[0].n].map(Number));
});

test("invalid files, words, paths and inconsistent counts fail before saving", () => {
  for (const data of [null, {}, { books: [], daily: [] }]) assert.throws(() => importGameLevels(data));
  for (const patch of [{ g: "AB,CD" }, { t: "ABC ABC" }, { e: "ACE" }, { n: "111112" }]) {
    const data = fixture();
    Object.assign(data.books[0].levels[0], patch);
    assert.throws(() => importGameLevels(data), /第 1 关/);
  }
});

test("single-level JSON reads an object or one-level pack and preserves disabled cells", () => {
  const single = { name: "造型测试", g: "CD-,AO-,TG-", t: "CAT DOG", e: "", n: "110110110" };
  const level = importSingleGameLevel("\uFEFF" + JSON.stringify(single), [{ word: "CAT", rarityLevel: 1 }]);
  assert.deepEqual(level.disabledCells, [2, 5, 8]);
  assert.equal(level.targetWords[0].rarityLevel, 1);
  const exported = createGameExport([{ level }]).books[0].levels[0];
  for (const key of Object.keys(single)) assert.equal(exported[key], single[key]);
  assert.deepEqual(importSingleGameLevel(JSON.stringify(fixture())).cells,
    importGameLevels(fixture())[0].cells);
});

test("single-level reading rejects malformed JSON, multiple levels and invalid paths", () => {
  assert.throws(() => importSingleGameLevel("{"), /JSON 格式/);
  assert.throws(() => importSingleGameLevel("null"), /单关/);
  const pack = fixture();
  pack.books[0].levels.push(structuredClone(pack.books[0].levels[0]));
  assert.throws(() => importSingleGameLevel(JSON.stringify(pack)), /只能读取一关/);
  assert.throws(() => importSingleGameLevel(JSON.stringify({ ...fixture().books[0].levels[0], n: "111112" })), /不一致/);
});
