import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { normalizePresetLevels, findPresetWordPath, createPresetRecords } from "../dist/preset-level-lists.js";
import { createGameExport } from "../dist/level-export.js";

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
  for (const level of levels) {
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

test("local version one retains exactly twenty complete levels and an identical game export", () => {
  const version = read("local-versions.json").versions[0];
  assert.equal(version.id, "2026-10-28-v1");
  const snapshot = read(version.levels);
  assert.equal(snapshot.records.length, version.levelCount);
  assert.equal(version.levelCount, 20);
  assert.deepEqual(createGameExport(snapshot.records), read(version.gameFile));
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
  assert.equal(records[1499].id, -1500);
  const snapshot = read("versions/2026-10-28-v1/levels.json");
  const before = JSON.stringify(snapshot);
  const local = createPresetRecords(snapshot, "editor");
  local[0].level.cells[0].letter = "Z";
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(local.length, 20);
});
