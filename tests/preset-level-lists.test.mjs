import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { normalizePresetLevels, findPresetWordPath, createPresetRecords, createPresetGameExport } from "../dist/preset-level-lists.js";
import { createGameExport } from "../dist/level-export.js";
import { gameLevelData } from "../dist/level-import.js";

const read = path => JSON.parse(readFileSync(new URL(`../dist/data/${path}`, import.meta.url)));

test("the complete reference list preserves source data and every word has an orthogonal path", () => {
  const manifest = read("preset-level-lists.json").referenceLists[0];
  const bytes = readFileSync(new URL(`../dist/data/${manifest.file}`, import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.source.sha256);
  const source = JSON.parse(bytes);
  const before = JSON.stringify(source);
  const levels = normalizePresetLevels(source, manifest.format);
  assert.equal(levels.length, 1500);
  assert.equal(levels.length, manifest.levelCount);
  assert.deepEqual(levels[0].targetWords.map(entry => entry.word), ["ICE", "JOB", "SUN"]);
  for (const [index, level] of levels.entries()) {
    assert.equal(level.letters.join(""), source[index].letters.split(",").reverse().join(""));
    for (const entry of [...level.targetWords, ...level.extraWords]) {
      const path = findPresetWordPath(level, entry.word);
      assert.ok(path, `Reference ${level.sourceId}: ${entry.word}`);
      assert.equal(path.length, entry.word.length);
      assert.equal(new Set(path).size, path.length);
      assert.equal(path.map(cell => level.letters[cell]).join(""), entry.word);
    }
  }
  assert.equal(JSON.stringify(source), before);
});

test("local version one retains twenty complete levels and exports the same content in the new format", () => {
  const version = read("local-versions.json").versions[0];
  assert.equal(version.id, "2026-10-28-v1");
  const snapshot = read(version.levels);
  assert.equal(snapshot.records.length, version.levelCount);
  assert.equal(version.levelCount, 20);
  const originalGame = read(version.gameFile);
  assert.deepEqual(createGameExport(snapshot.records), {
    level: originalGame.books.flatMap(book => book.levels).map(gameLevelData),
    daily: originalGame.daily.map(gameLevelData),
  });
  const levels = normalizePresetLevels(snapshot, "editor");
  assert.equal(levels.length, 20);
  assert.deepEqual(levels[0].targetWords.map(entry => entry.word), snapshot.records[0].level.targetWords.map(entry => entry.word));
  const configs = read(version.configs).records;
  for (const [index, record] of snapshot.records.entries()) {
    assert.equal(record.level.sourceConfig.position, index + 1);
    assert.equal(record.level.targetCount, configs[index].config.targetCount);
    assert.deepEqual(record.level.targetLengthPlan, configs[index].config.targetLengthPlan);
  }
});

test("preview paths do not reuse cells or wrap across rows", () => {
  const level = { columns: 3, letters: [..."ABCDEF"] };
  assert.deepEqual(findPresetWordPath(level, "ABE"), [0, 1, 4]);
  assert.equal(findPresetWordPath(level, "CD"), null);
  assert.equal(findPresetWordPath(level, "ABA"), null);
  assert.throws(() => normalizePresetLevels([], "word-tiles"), /为空/);
});

test("reference levels can open in the main editor without changing the original local version", () => {
  const records = createPresetRecords(read("presets/word-tiles-list0.json"), "word-tiles");
  assert.equal(records.length, 1500);
  assert.equal(records[0].id, -1);
  assert.deepEqual(records[0].level.targetWords.map(entry => entry.word), ["ICE", "JOB", "SUN"]);
  assert.equal(records[0].level.cells.map(cell => cell.letter).join(""), "SUNJICOBE");
  assert.deepEqual(records[0].level.targetWords.find(entry => entry.word === "ICE").path, [4, 5, 8]);
  assert.equal(records[1499].id, -1500);
  const snapshot = read("versions/2026-10-28-v1/levels.json");
  const before = JSON.stringify(snapshot);
  const local = createPresetRecords(snapshot, "editor");
  assert.deepEqual(local[0].level.cells, snapshot.records[0].level.cells);
  local[0].level.cells[0].letter = "Z";
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(local.length, 20);
});

test("the preset index exposes only the latest 1000 levels and the independent reference", () => {
  const { referenceLists, presets } = read("preset-level-lists.json");
  assert.deepEqual(referenceLists.map(item => item.id), ["word-tiles-list0"]);
  assert.deepEqual(presets.map(item => [item.id, item.levelCount]), [
    ["our-levels-new-plan-first-1000-2026-11-17", 1000],
  ]);

  const [preset] = presets;
  const bytes = readFileSync(new URL(`../dist/data/${preset.file}`, import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), preset.source.sha256);
  const data = JSON.parse(bytes);
  const records = createPresetRecords(data, preset.format);
  assert.equal(records.length, preset.levelCount);
  assert.deepEqual(createPresetGameExport(records), data);
  for (const [index, entry] of data.level.entries()) {
    assert.equal(Object.keys(entry)[0], "level");
    assert.equal(entry.level, `level_${index + 1}`);
    assert.equal(records[index].id, -index - 1);
    assert.equal(records[index].sourceId, index + 1);
  }
  const preview = normalizePresetLevels(data, preset.format);
  assert.deepEqual(preview[0].letters, records[0].level.cells.map(cell => cell.letter));
  assert.deepEqual(preview[0].targetWords.map(entry => entry.word), ["CAT", "ALL", "CALL"]);
  assert.deepEqual(data, JSON.parse(bytes));
});

test("the latest local snapshot restores the current preset and configuration", () => {
  const version = read("local-versions.json").versions.find(entry => entry.id === "2026-11-18-v1");
  const [preset] = read("preset-level-lists.json").presets;
  const snapshot = read(version.levels);
  assert.equal(snapshot.records.length, version.levelCount);
  assert.deepEqual(read(version.gameFile), read(preset.gameFile));
  assert.deepEqual(createPresetGameExport(snapshot.records), read(version.gameFile));
  assert.equal(read(version.configs).records.length, 2000);
});

test("compact presets preserve regular/daily order and derive source numbers from array order", () => {
  const source = { level: [{ a: "ABC,DEF", b: "111111", c: "ABC DEF", d: "FED" }],
    daily: [{ a: "CD-,AO-,TG-", b: "110110110", c: "CAT DOG", d: "" }] };
  const records = createPresetRecords(source, "game");
  assert.deepEqual(records.map(record => record.sourceId), [1, 2]);
  assert.deepEqual(createGameExport(records), source);
  assert.deepEqual(normalizePresetLevels(source, "game")[1].disabledCells, [2, 5, 8]);
});
