import assert from "node:assert/strict";
import test from "node:test";
import { CONFIG_LIST_STORAGE_KEY, patchLevelConfigs, readConfigList, resizeTargetPlan, saveConfigList,
  validateConfigList, validateLevelConfig, configJobsInRange } from "../dist/level-config.js";

const config = () => ({ rows: 3, columns: 4, targetCount: 6,
  targetLengthPlan: ["short", "medium", "long", "short", "medium", "long"],
  initialMaxWordLength: 8, maxWordLength: 8, initialForwardProbability: 50,
  targetDuplicateRange: 20, extraDuplicateRange: 10, filters: { scope: [1, 2], emotion: [-1, 0] } });
const records = () => ["a", "b", "c"].map(id => ({ id, config: config() }));

test("configuration values enforce the editor bounds while preserving independent settings and zero", () => {
  const valid = { ...config(), initialMaxWordLength: 9, maxWordLength: 4,
    targetLengthPlan: null, initialForwardProbability: 0, targetDuplicateRange: 0, extraDuplicateRange: 0,
    filters: { scope: [] } };
  assert.equal(validateLevelConfig(valid), valid);
  for (const [field, value] of [["rows", 4], ["columns", 2], ["targetCount", 0], ["targetCount", NaN],
    ["initialMaxWordLength", 0], ["maxWordLength", 2.5], ["initialForwardProbability", 101],
    ["targetDuplicateRange", -1], ["extraDuplicateRange", "20"]]) {
    assert.throws(() => validateLevelConfig({ ...config(), [field]: value }));
  }
  for (const invalid of [null, [], { scope: [5] }, { emotion: [3] }, { abbreviation: [2] }, { rarityLevel: [0] }, { unknown: [] }]) {
    assert.throws(() => validateLevelConfig({ ...config(), filters: invalid }), /筛选/);
  }
});

test("bulk changes affect only selected configurations and do not share nested values", () => {
  const original = records();
  const before = structuredClone(original);
  const updated = patchLevelConfigs(original, ["a", "c"], {
    initialForwardProbability: 100, targetDuplicateRange: 0, filters: { rarityLevel: [1, 2] },
  });
  assert.equal(updated[1], original[1]);
  assert.equal(updated[0].config.initialForwardProbability, 100);
  assert.equal(updated[2].config.targetDuplicateRange, 0);
  updated[0].config.filters.rarityLevel.push(3);
  assert.deepEqual(updated[2].config.filters.rarityLevel, [1, 2]);
  assert.deepEqual(original, before);
});

test("bulk target counts resize each row's own plan without changing quantity-only mode", () => {
  const original = records();
  original[1].config.targetLengthPlan = null;
  const updated = patchLevelConfigs(original, ["a", "b"], { targetCount: 8 });
  assert.deepEqual(updated[0].config.targetLengthPlan, [...original[0].config.targetLengthPlan, "short", "medium"]);
  assert.equal(updated[1].config.targetLengthPlan, null);
  assert.equal(updated[1].config.targetCount, 8);
  assert.equal(updated[2].config.targetCount, 6);
  assert.deepEqual(resizeTargetPlan(["long", "short", "medium"], 2), ["long", "short"]);
});

test("invalid bulk changes reject the whole update and preserve all original configurations", () => {
  const original = records();
  const before = structuredClone(original);
  assert.throws(() => patchLevelConfigs(original, ["a", "c"], { targetCount: 1001 }), /1000/);
  assert.throws(() => patchLevelConfigs(original, ["a"], { columns: 6 }), /列数/);
  assert.throws(() => patchLevelConfigs(original, ["a"], { targetCount: 4, targetLengthPlan: ["short"] }), /一致/);
  assert.throws(() => patchLevelConfigs(original, ["a"], { unsupported: true }), /字段/);
  assert.deepEqual(original, before);
});

test("configuration lists round-trip all fields and distinguish no saved list from an empty saved list", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(readConfigList(storage), null);
  const original = records();
  saveConfigList(original, storage);
  assert.deepEqual(readConfigList(storage), original);
  original[0].config.targetLengthPlan[0] = "long";
  assert.equal(readConfigList(storage)[0].config.targetLengthPlan[0], "short");
  saveConfigList([], storage);
  assert.deepEqual(readConfigList(storage), []);
  values.set(CONFIG_LIST_STORAGE_KEY, "invalid JSON");
  assert.throws(() => readConfigList(storage));
  assert.equal(values.get(CONFIG_LIST_STORAGE_KEY), "invalid JSON");
});

test("invalid rows and storage failures cannot be reported as saved", () => {
  const invalid = records();
  invalid[1].config.initialForwardProbability = 101;
  let writes = 0;
  assert.throws(() => saveConfigList(invalid, { setItem: () => { writes += 1; } }), /第 2 关/);
  assert.equal(writes, 0);
  assert.throws(() => validateConfigList([{ id: "a", config: config() }, { id: "a", config: config() }]), /编号/);
  assert.throws(() => saveConfigList(records(), { setItem: () => { throw new Error("Storage unavailable"); } }), /Storage unavailable/);
});

test("the configuration list supports all 1500 reference levels", () => {
  const full = Array.from({ length: 1500 }, (_, index) => ({ id: `reference-${index + 1}`, config: config() }));
  assert.equal(validateConfigList(full).length, 1500);
  assert.throws(() => validateConfigList([...full, { id: "reference-1501", config: config() }]), /1500/);
});

test("generation ranges include both endpoints and preserve the displayed configuration numbers", () => {
  const full = Array.from({ length: 1500 }, (_, index) => ({ id: `reference-${index + 1}`, config: config() }));
  const before = structuredClone(full);
  const range = configJobsInRange(full, 20, 50);
  assert.equal(range.length, 31);
  assert.deepEqual(range.map(job => job.position), Array.from({ length: 31 }, (_, index) => index + 20));
  assert.equal(range[0].id, "reference-20");
  assert.equal(range.at(-1).id, "reference-50");
  assert.equal(configJobsInRange(full, 1, 1500).length, 1500);
  assert.deepEqual(configJobsInRange(full, 1500, 1500).map(job => job.position), [1500]);
  assert.deepEqual(full, before);
});

test("invalid generation ranges fail instead of truncating, swapping or rounding the request", () => {
  const list = records();
  for (const [from, to] of [[0, 2], [1, 4], [3, 2], [1.5, 3], [1, 2.5], [NaN, 2], [1, NaN], ["1", 3], [1, Infinity]]) {
    assert.throws(() => configJobsInRange(list, from, to), /起始关|结束关/);
  }
  assert.throws(() => configJobsInRange([], 1, 1), /为空/);
});
