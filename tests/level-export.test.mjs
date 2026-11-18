import assert from "node:assert/strict";
import test from "node:test";
import { createGameExport, gameExportText } from "../dist/level-export.js";

const fixture = () => ({ id: 42, position: 9, level: { rows: 2, columns: 3,
  cells: [..."ABCDEF"].map(letter => ({ letter, count: 99 })),
  targetWords: [{ word: "DEF", path: [3, 4, 5] }, { word: "ABC", path: [0, 1, 2] }],
  extraWords: [{ word: "FED", path: [5, 4, 3] }],
} });

test("export matches level/daily with exactly four fields and recalculates target-only counts", () => {
  const record = fixture();
  const before = structuredClone(record);
  const result = createGameExport([record]);
  assert.deepEqual(result, { level: [
    { a: "ABC,DEF", b: "111111", c: "ABC DEF", d: "FED" },
  ], daily: [] });
  assert.deepEqual(record, before);
  assert.equal(gameExportText([record]), JSON.stringify(result, null, 2) + "\n");
});

test("array order determines level order and editor IDs and names are omitted", () => {
  const first = fixture(), second = fixture();
  first.id = 800; first.level.name = "先导出";
  second.id = 2; second.level.name = "后导出";
  second.level.cells = [..."GHIJKL"].map(letter => ({ letter, count: 99 }));
  second.level.targetWords = [{ word: "JKL", path: [3, 4, 5] }, { word: "GHI", path: [0, 1, 2] }];
  second.level.extraWords = [];
  assert.deepEqual(createGameExport([first, second]).level, [
    { a: "ABC,DEF", b: "111111", c: "ABC DEF", d: "FED" },
    { a: "GHI,JKL", b: "111111", c: "GHI JKL", d: "" },
  ]);
});

test("counts of ten or more use one base-36 character per cell", () => {
  const cells = [..."ABCDHGFEIJKL"].map(letter => ({ letter, count: 0 }));
  const path = [0, 1, 2, 3, 7, 6, 5, 4, 8, 9, 10, 11];
  const targetWords = Array.from({ length: 10 }, (_, index) => {
    const steps = path.slice(0, index + 3);
    return { word: steps.map(cell => cells[cell].letter).join(""), path: steps };
  });
  const { b } = createGameExport([{ level: { rows: 3, columns: 4, cells, targetWords, extraWords: [] } }]).level[0];
  assert.equal(b.length, 12);
  assert.equal(b.slice(0, 3), "aaa");
  assert.equal(b.at(-1), "1");
});

test("explicit daily records use the daily array without duplicating regular levels", () => {
  const record = fixture();
  const entry = { a: "ABC,DEF", b: "111111", c: "ABC DEF", d: "FED" };
  assert.deepEqual(createGameExport([{ ...record, group: "daily" }, record]), { level: [entry], daily: [entry] });
  assert.deepEqual(createGameExport([{ ...record, group: "daily" }]), { level: [], daily: [entry] });
});

test("invalid data aborts export with the displayed level number instead of skipping levels", () => {
  assert.throws(() => createGameExport([]), /列表为空/);
  for (const corrupt of [
    record => { record.level.cells[0].letter = ""; },
    record => { record.level.targetWords[0].path = [3, 5, 4]; },
    record => { record.level.targetWords.pop(); },
    record => { record.level.extraWords.push(record.level.targetWords[0]); },
  ]) {
    const record = fixture(); corrupt(record);
    assert.throws(() => createGameExport([fixture(), record]), /第 2 关/);
  }
});
