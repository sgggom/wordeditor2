import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseLevelFile, serializeLevelFile, updateFileLevel, changeFileOrder, writeLevelFile } from "../dist/level-file.js";
import { setTargetWord } from "../dist/level-rules.js";
import { normalizePresetLevels } from "../dist/preset-level-lists.js";

const gameLevel = id => ({ id, name: `Level ${id}`, g: "AB,DC", t: "ABCD", n: "1111", e: "AB CD",
  lv: "07", ty: "original", curtains: [0], custom: { keep: true } });
const pack = () => ({ edition: "custom", books: [
  { name: "First", mix: [10, 20], note: "keep", levels: [gameLevel("101")] },
  { name: "Second", levels: [gameLevel("205")] },
], daily: [gameLevel("daily-3")] });
const open = () => parseLevelFile(JSON.stringify(pack()));
const edit = document => updateFileLevel(document, document.records[0].id, setTargetWord(document.records[0].level, "AB", true));

function memoryHandle(initial, failure = null) {
  let contents = initial, creates = 0, aborted = false;
  const handle = { name: "levels.json", getFile: async () => ({ text: async () => contents }),
    isSameEntry: async other => other === handle,
    createWritable: async () => {
      creates++;
      if (failure === "permission") throw new DOMException("Denied", "NotAllowedError");
      let pending;
      return { write: async text => { pending = text; if (failure === "write") throw new Error("Write failed"); },
        close: async () => { if (failure === "close") throw new Error("Close failed"); contents = pending; },
        abort: async () => { aborted = true; } };
    } };
  return { handle, read: () => contents, change: text => { contents = text; }, creates: () => creates, aborted: () => aborted };
}

test("opening and editing a game file preserves books, daily levels, IDs and all unrelated metadata", () => {
  const document = open();
  assert.equal(document.format, "game");
  assert.equal(document.dirty, false);
  assert.deepEqual(JSON.parse(serializeLevelFile(document)), pack());
  edit(document);
  const saved = JSON.parse(serializeLevelFile(document));
  const expected = pack();
  expected.books[0].levels[0].t = "AB ABCD";
  expected.books[0].levels[0].n = "2211";
  expected.books[0].levels[0].e = "CD";
  assert.deepEqual(saved, expected);
  assert.deepEqual(document.original, pack());
  assert.equal(document.dirty, true);
});

test("reordering across books preserves their boundaries and deleting a daily level keeps its container", () => {
  const document = open();
  changeFileOrder(document, 2, "up");
  changeFileOrder(document, 3, "delete");
  const saved = JSON.parse(serializeLevelFile(document));
  assert.deepEqual(saved.books.map(book => book.levels.map(level => level.id)), [["205"], ["101"]]);
  assert.equal(saved.books[0].name, "First");
  assert.equal(saved.books[1].name, "Second");
  assert.deepEqual(saved.daily, []);
  assert.equal(saved.edition, "custom");
});

test("single-level files retain their format and shaped previews support every current board dimension", () => {
  const source = { ...gameLevel("shape"), g: "AB,-C", t: "ABC", e: "AB", n: "1101" };
  const document = parseLevelFile(JSON.stringify(source));
  assert.equal(document.format, "single");
  assert.deepEqual(JSON.parse(serializeLevelFile(document)), source);
  const [preview] = normalizePresetLevels({ records: document.records }, "editor");
  assert.deepEqual(preview.disabledCells, [2]);
  assert.deepEqual(preview.letters, ["A", "B", "", "C"]);
  assert.throws(() => changeFileOrder(document, 1, "delete"), /单关文件/);
});

test("editor files retain complete snapshots, original record IDs, positions and custom fields", () => {
  const level = open().records[0].level;
  const source = { schemaVersion: 1, project: { title: "keep" }, records: [{ id: 77, position: 17, createdAt: 123, note: "keep", level }] };
  const document = parseLevelFile(JSON.stringify(source));
  assert.equal(document.format, "editor");
  assert.deepEqual(JSON.parse(serializeLevelFile(document)), source);
  edit(document);
  const saved = JSON.parse(serializeLevelFile(document));
  assert.equal(saved.records[0].id, 77);
  assert.equal(saved.records[0].position, 17);
  assert.equal(saved.records[0].createdAt, 123);
  assert.equal(saved.records[0].note, "keep");
  assert.deepEqual(saved.project, source.project);
  assert.equal(saved.records[0].level.statistics.workload.targetCount, 2);
  assert.equal(saved.records[0].level.targetWords[1].word, "AB");
});

test("game files can become empty and later receive a generated level without losing book metadata", () => {
  const document = open(), level = document.records[0].level;
  for (const { id } of [...document.records]) changeFileOrder(document, id, "delete");
  const empty = serializeLevelFile(document);
  assert.equal(parseLevelFile(empty).records.length, 0);
  assert.deepEqual(JSON.parse(empty).books.map(book => book.levels), [[], []]);
  updateFileLevel(document, null, level);
  const saved = JSON.parse(serializeLevelFile(document));
  assert.equal(saved.books[0].levels.length, 1);
  assert.equal(saved.books[0].note, "keep");
});

test("replacing an editor level preserves extension data without reviving old fixed words or layouts", () => {
  const level = open().records[0].level;
  const old = { ...level, extension: { keep: true }, fixedWords: ["ABCD"],
    fixedLayout: { rows: 2, columns: 2, placements: [{ word: "ABCD", path: [0, 1, 3, 2] }] } };
  const document = parseLevelFile(JSON.stringify({ schemaVersion: 1, records: [{ id: 9, level: old }] }));
  updateFileLevel(document, 1, level);
  const saved = JSON.parse(serializeLevelFile(document)).records[0].level;
  assert.deepEqual(saved.extension, { keep: true });
  assert.equal(saved.fixedWords, undefined);
  assert.equal(saved.fixedLayout, undefined);
});

test("saving writes back through the original handle and updates its baseline only after close", async () => {
  const document = open(), file = memoryHandle(document.savedText);
  document.handle = file.handle;
  edit(document);
  await writeLevelFile(document);
  assert.equal(document.dirty, false);
  assert.equal(document.savedText, file.read());
  assert.equal(JSON.parse(file.read()).books[0].levels[0].t, "AB ABCD");
  assert.equal(file.creates(), 1);
  assert.ok(document.records.every(record => record.changed === false));
  changeFileOrder(document, 2, "up");
  await writeLevelFile(document);
  assert.equal(JSON.parse(file.read()).books[1].levels[0].id, "101");
  assert.equal(file.creates(), 2);
});

test("permission, write and close failures retain unsaved changes and never claim a successful save", async () => {
  for (const failure of ["permission", "write", "close"]) {
    const document = open(), file = memoryHandle(document.savedText, failure);
    document.handle = file.handle; edit(document);
    const baseline = document.savedText;
    await assert.rejects(writeLevelFile(document));
    assert.equal(document.dirty, true);
    assert.equal(document.savedText, baseline);
    assert.equal(file.read(), baseline);
    assert.equal(file.aborted(), failure !== "permission");
  }
});

test("externally changed files are not overwritten, while Save As writes a separate file", async () => {
  const document = open(), original = memoryHandle(document.savedText), copy = memoryHandle("");
  document.handle = original.handle; edit(document);
  original.change("external changes");
  await assert.rejects(writeLevelFile(document), /其他程序修改/);
  assert.equal(original.creates(), 0);
  assert.equal(document.dirty, true);
  await writeLevelFile(document, copy.handle);
  assert.equal(original.read(), "external changes");
  assert.equal(JSON.parse(copy.read()).books[0].levels[0].t, "AB ABCD");
  assert.equal(document.handle, copy.handle);
  assert.equal(document.dirty, false);
});

test("unsafe legacy files can be opened for repair but cannot be saved", async () => {
  const data = JSON.parse(await readFile(new URL("./fixtures/shaped-level-41.json", import.meta.url)));
  const document = parseLevelFile(JSON.stringify(data));
  const file = memoryHandle(document.savedText); document.handle = file.handle;
  assert.throws(() => serializeLevelFile(document), /不同格子/);
  await assert.rejects(writeLevelFile(document), /不同格子/);
  assert.equal(file.creates(), 0);
});

test("configuration lists and malformed level files fail before replacing an open document", () => {
  for (const source of [{ version: 1, records: [{ id: "one", config: { rows: 3, columns: 4 } }] },
    { version: 1, records: [] }, { version: 2, activeListId: "one", lists: [] },
    { books: [{ levels: [gameLevel(1), { ...gameLevel(2), n: "0000" }] }], daily: [] },
    { schemaVersion: 1, records: [{ level: { rows: 2, columns: 2 } }] }]) assert.throws(() => parseLevelFile(JSON.stringify(source)));
  assert.throws(() => parseLevelFile("{"), /JSON/);
  const level = open().records[0].level;
  for (const invalid of [{ fixedWords: [123] }, { filters: null }, { initialForwardProbability: -1 },
    { fixedWords: ["ABCD"], fixedLayout: { rows: 3, columns: 3, placements: [] } }]) {
    assert.throws(() => parseLevelFile(JSON.stringify({ records: [{ level: { ...level, ...invalid } }] })));
  }
});
