import assert from "node:assert/strict";
import test from "node:test";
import { createGameExport, gameExportText } from "../dist/level-export.js";

const fixture = () => ({ id: 42, position: 9, level: { rows: 2, columns: 3,
  cells: [..."ABCDEF"].map(letter => ({ letter, count: 99 })),
  targetWords: [{ word: "DEF", path: [3, 4, 5] }, { word: "ABC", path: [0, 1, 2] }],
  extraWords: [{ word: "FED", path: [5, 4, 3] }],
} });

test("export matches the legacy nine-field game format and recalculates target-only counts", () => {
  const record = fixture();
  const before = structuredClone(record);
  const result = createGameExport([record]);
  assert.deepEqual(result, { books: [{ name: "第一册", sub: "入门", mix: [100, 0, 0, 0, 0], levels: [
    { id: "1", name: "", g: "ABC,DEF", t: "ABC DEF", n: "111111", e: "FED", lv: "", ty: "", curtains: [] },
  ] }], daily: [] });
  assert.deepEqual(record, before);
  assert.equal(gameExportText([record]), JSON.stringify(result, null, 2) + "\n");
});

test("list order becomes consecutive string IDs instead of database IDs", () => {
  const first = fixture(), second = fixture();
  first.id = 800; first.level.name = "先导出";
  second.id = 2; second.level.name = "后导出";
  assert.deepEqual(createGameExport([first, second]).books[0].levels.map(({ id, name }) => ({ id, name })),
    [{ id: "1", name: "先导出" }, { id: "2", name: "后导出" }]);
});

test("counts of ten or more use one base-36 character per cell", () => {
  const cells = [..."ABCDHGFEIJKL"].map(letter => ({ letter, count: 0 }));
  const path = [0, 1, 2, 3, 7, 6, 5, 4, 8, 9, 10, 11];
  const targetWords = Array.from({ length: 10 }, (_, index) => {
    const steps = path.slice(0, index + 3);
    return { word: steps.map(cell => cells[cell].letter).join(""), path: steps };
  });
  const { n } = createGameExport([{ level: { rows: 3, columns: 4, cells, targetWords, extraWords: [] } }]).books[0].levels[0];
  assert.equal(n.length, 12);
  assert.equal(n.slice(0, 3), "aaa");
  assert.equal(n.at(-1), "1");
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
