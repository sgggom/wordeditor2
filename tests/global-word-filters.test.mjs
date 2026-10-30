import assert from "node:assert/strict";
import test from "node:test";

const values = new Map([["fangge.level-word-filters.v1", JSON.stringify({ scope: [1] })]]);
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
const { getGlobalWordFilters, setGlobalWordFilters, subscribeGlobalWordFilters, GLOBAL_FILTER_STORAGE_KEY } = await import("../dist/global-word-filters.js");

test("global filters reuse saved settings, publish changes and return independent snapshots", () => {
  assert.deepEqual(getGlobalWordFilters(), { scope: [1] });
  const changes = [];
  const unsubscribe = subscribeGlobalWordFilters(filters => changes.push(filters));
  setGlobalWordFilters({ scope: [2, 0, 2], rarityLevel: [5] });
  assert.deepEqual(changes, [{ scope: [0, 2], rarityLevel: [5] }]);
  assert.deepEqual(JSON.parse(values.get(GLOBAL_FILTER_STORAGE_KEY)), changes[0]);
  const snapshot = getGlobalWordFilters(); snapshot.scope.push(4);
  assert.deepEqual(getGlobalWordFilters().scope, [0, 2]);
  setGlobalWordFilters({ scope: [0, 2], rarityLevel: [5] });
  assert.equal(changes.length, 1, "unchanged generation settings must not clear the current result");
  unsubscribe(); setGlobalWordFilters({}); assert.equal(changes.length, 1);
});

test("all options normalize to unrestricted while an empty selection remains empty", () => {
  setGlobalWordFilters({ scope: [0, 1, 2, 3, 4], emotion: [] });
  assert.deepEqual(getGlobalWordFilters(), { emotion: [] });
  setGlobalWordFilters({ scope: [99] });
  assert.deepEqual(getGlobalWordFilters(), {});
});
