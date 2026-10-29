import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CONFIG_LIST_STORAGE_KEY, hasConfigPreset, installConfigPreset, readConfigList, readConfigLists, saveConfigList } from "../dist/level-config.js";
import { initialCoverageLimit, REFERENCE_CONFIG_ID, referenceFilters, referenceForwardProbability } from "../dist/reference-config.js";
import { countTargetLengthPlan, targetLengthGroup } from "../dist/level-generator.js";

const preset = JSON.parse(await readFile(new URL("../dist/data/list0-configs.json", import.meta.url), "utf8"));

test("all 1500 rows retain source dimensions, target counts and word-length order", () => {
  assert.equal(preset.id, REFERENCE_CONFIG_ID);
  assert.equal(preset.records.length, 1500);
  let total = 0;
  const shapes = {};
  const groups = { short: 0, medium: 0, long: 0 };
  for (const [index, record] of preset.records.entries()) {
    const { config, reference } = record;
    assert.equal(reference.position, index + 1);
    assert.equal(config.targetCount, reference.targetWordLengths.length);
    assert.deepEqual(config.targetLengthPlan, reference.targetWordLengths.map(targetLengthGroup));
    assert.equal(config.maxWordLength, Math.min(8, reference.originalMaxWordLength));
    assert.equal(config.targetDuplicateRange, 20);
    assert.equal(config.extraDuplicateRange, 0);
    assert.equal(config.initialRarityLevel, 1);
    assert.equal(config.minimumEmotionScore, 0);
    assert.ok(!Object.hasOwn(config.filters, "rarityLevel") && !Object.hasOwn(config.filters, "abbreviation") && !Object.hasOwn(config.filters, "emotion"));
    const counts = countTargetLengthPlan(config.targetCount, config.targetLengthPlan);
    assert.ok(initialCoverageLimit(counts, config.initialMaxWordLength, config.maxWordLength) >= config.rows * config.columns);
    for (const key of Object.keys(groups)) groups[key] += counts[key];
    const shape = `${config.columns}x${config.rows}`;
    shapes[shape] = (shapes[shape] ?? 0) + 1;
    total += config.targetCount;
  }
  assert.equal(total, 14650);
  assert.deepEqual(groups, { short: 6195, medium: 5517, long: 2938 });
  assert.deepEqual(shapes, { "3x3": 556, "4x2": 17, "4x3": 619, "5x3": 308 });
  assert.equal(preset.records[703].config.targetCount, 23);
});

test("only the approved 94 initial limits and two long-word caps are adjusted", () => {
  const adjusted = preset.records.filter(({ config }) => config.initialMaxWordLength !== config.columns);
  assert.equal(adjusted.length, 94);
  assert.equal(adjusted.filter(({ config }) => config.columns === 3 && config.initialMaxWordLength === 4).length, 92);
  assert.equal(adjusted.filter(({ config }) => config.columns === 4 && config.initialMaxWordLength === 5).length, 2);
  assert.deepEqual(adjusted.map(record => record.reference.position), preset.initialLengthExceptions);
  assert.deepEqual(preset.longestWordExceptions, [943, 1224]);
  assert.equal(preset.records[1].config.initialMaxWordLength, 4);
  assert.equal(preset.records[9].config.initialMaxWordLength, 5);
});

test("forward probability and cumulative library unlocks follow the confirmed phase boundaries", () => {
  const forward = new Map([[1,100],[20,100],[21,80],[50,80],[51,70],[100,70],[101,70],[125,65],[150,60],[175,55],[200,50],[201,50],[1500,50]]);
  for (const [position, value] of forward) {
    assert.equal(referenceForwardProbability(position), value);
    assert.equal(preset.records[position - 1].config.initialForwardProbability, value);
  }
  for (const [position, scope] of [[1,[1]],[20,[1]],[21,[1,2]],[50,[1,2]],[51,[1,2,3]],[100,[1,2,3]],[101,null],[1500,null]]) {
    assert.deepEqual(referenceFilters(position), scope ? { scope } : {});
    assert.deepEqual(preset.records[position - 1].config.filters, referenceFilters(position));
  }
});

test("preset installation keeps existing lists and never overwrites subsequent edits or deletions", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  saveConfigList([{ id: "old", config: preset.records[0].config }], storage);
  assert.equal(installConfigPreset(preset, storage), true);
  assert.deepEqual(readConfigList(storage), preset.records);
  assert.equal(readConfigLists(storage).lists.length, 2);
  assert.deepEqual(readConfigLists(storage).lists[0].records, [{ id: "old", config: preset.records[0].config }]);
  assert.deepEqual([...values.keys()], [CONFIG_LIST_STORAGE_KEY]);
  const edited = readConfigList(storage);
  edited[0].config.initialForwardProbability = 80;
  saveConfigList(edited, storage);
  assert.equal(hasConfigPreset(preset.id, storage), true);
  assert.equal(installConfigPreset(preset, storage), false);
  assert.equal(readConfigList(storage)[0].config.initialForwardProbability, 80);
  saveConfigList([], storage);
  assert.equal(installConfigPreset(preset, storage), false);
  assert.deepEqual(readConfigList(storage), []);
});

test("failed preset installation keeps the previous list and leaves no installed marker", () => {
  let stored = JSON.stringify({ version: 1, records: [{ id: "old", config: preset.records[0].config }] });
  const before = stored;
  const storage = { getItem: () => stored, setItem: () => { throw new Error("Storage full"); } };
  assert.throws(() => installConfigPreset(preset, storage), /Storage full/);
  assert.equal(stored, before);
  assert.equal(hasConfigPreset(preset.id, storage), false);
});
