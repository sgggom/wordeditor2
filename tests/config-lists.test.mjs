import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG_LIST_STORAGE_KEY, readConfigList, readConfigLists, migrateConfigLists, changeConfigLists,
  saveConfigList, installConfigPreset, hasConfigPreset } from '../dist/level-config.js';
import { installOpeningWordsPreset, OPENING_WORDS_PRESET_ID } from '../dist/opening-words-preset.js';

const config = () => ({ rows: 3, columns: 4, disabledCells: [0, 11], targetCount: 6, targetLengthPlan: null,
  initialMaxWordLength: 8, maxWordLength: 8, initialForwardProbability: 50, targetDuplicateRange: 20,
  extraDuplicateRange: 0, filters: { scope: [1, 2] }, fixedWords: ['CAT'],
  fixedLayout: { rows: 3, columns: 4, placements: [{ word: 'CAT', path: [1, 2, 6] }] } });
const rows = () => [{ id: 'row-one', reference: { position: 1 }, config: config() }];
function memory(value = null) {
  const values = new Map(value === null ? [] : [[CONFIG_LIST_STORAGE_KEY, JSON.stringify(value)]]);
  let writes = 0;
  return { values, get writes() { return writes; }, getItem: key => values.get(key) ?? null,
    setItem(key, value) { values.set(key, value); writes++; } };
}
const legacy = () => ({ version: 1, records: rows(), presetId: 'reference', openingWordsPresetId: OPENING_WORDS_PRESET_ID });

test('legacy migration preserves every row, shape, fixed word and preset marker and runs only once', () => {
  const saved = legacy(), storage = memory(saved), before = storage.getItem(CONFIG_LIST_STORAGE_KEY);
  const preview = readConfigLists(storage);
  assert.equal(storage.getItem(CONFIG_LIST_STORAGE_KEY), before, 'Reading must not write');
  assert.deepEqual(preview.lists[0].records, saved.records);
  const library = migrateConfigLists(storage);
  assert.equal(library.version, 2); assert.equal(library.activeListId, library.lists[0].id);
  assert.equal(library.lists[0].name, '原有关卡配置');
  assert.deepEqual(library.lists[0].records, saved.records);
  assert.equal(library.lists[0].presetId, 'reference');
  assert.equal(library.lists[0].openingWordsPresetId, OPENING_WORDS_PRESET_ID);
  assert.equal(installOpeningWordsPreset(storage), false);
  assert.deepEqual(migrateConfigLists(storage), library);
  assert.equal(storage.writes, 1);
});

test('new lists start empty and atomically save the outgoing draft; switching restores independent contents', () => {
  const storage = memory(legacy()), original = migrateConfigLists(storage).activeListId;
  const draft = rows(); draft[0].config.initialForwardProbability = 73;
  let library = changeConfigLists({ type: 'create', name: '新关卡', draft: { id: original, records: draft } }, storage);
  const created = library.activeListId;
  assert.notEqual(created, original); assert.deepEqual(readConfigList(storage), []);
  assert.equal(library.lists.find(l => l.id === original).records[0].config.initialForwardProbability, 73);
  draft[0].config.disabledCells.push(8);
  assert.deepEqual(readConfigLists(storage).lists[0].records[0].config.disabledCells, [0, 11]);
  const newRows = rows(); newRows[0].config.initialForwardProbability = 12;
  library = changeConfigLists({ type: 'switch', id: original, draft: { id: created, records: newRows } }, storage);
  assert.equal(readConfigList(storage)[0].config.initialForwardProbability, 73);
  changeConfigLists({ type: 'switch', id: created }, storage);
  assert.equal(readConfigList(storage)[0].config.initialForwardProbability, 12);
  assert.equal(readConfigLists(storage).lists.length, 2);
});

test('copies include the latest draft and use independent row IDs and nested data', () => {
  const storage = memory(legacy()), original = migrateConfigLists(storage).activeListId;
  const draft = rows(); draft[0].config.initialForwardProbability = 80;
  const library = changeConfigLists({ type: 'copy', id: original, name: '造型副本', draft: { id: original, records: draft } }, storage);
  const copied = library.lists.find(l => l.id === library.activeListId);
  assert.notEqual(copied.records[0].id, draft[0].id);
  assert.deepEqual(copied.records[0].config, draft[0].config);
  assert.deepEqual(copied.records[0].reference, draft[0].reference);
  assert.equal(copied.presetId, undefined);
  copied.records[0].config.disabledCells.push(10);
  changeConfigLists({ type: 'save', id: copied.id, draft: { id: copied.id, records: copied.records } }, storage);
  assert.deepEqual(readConfigLists(storage).lists.find(l => l.id === original).records[0].config.disabledCells, [0, 11]);
});

test('renaming rejects empty, long and duplicate names without changing storage', () => {
  const storage = memory(legacy()), original = migrateConfigLists(storage).activeListId;
  const second = changeConfigLists({ type: 'create', name: 'Test' }, storage).activeListId;
  changeConfigLists({ type: 'rename', id: original, name: '  第一组  ' }, storage);
  assert.equal(readConfigLists(storage).lists[0].name, '第一组');
  for (const name of [' ', 'a'.repeat(41), 'test']) {
    const before = storage.getItem(CONFIG_LIST_STORAGE_KEY);
    assert.throws(() => changeConfigLists({ type: 'rename', id: original, name }, storage), /名称|同名/);
    assert.equal(storage.getItem(CONFIG_LIST_STORAGE_KEY), before);
  }
  assert.equal(readConfigLists(storage).activeListId, second);
});

test('deleting an active list selects a surviving list, supports discarding its invalid draft, and keeps the last list', () => {
  const storage = memory(legacy()), original = migrateConfigLists(storage).activeListId;
  const second = changeConfigLists({ type: 'create', name: '空列表' }, storage).activeListId;
  const invalid = rows(); invalid[0].config.rows = 0;
  const library = changeConfigLists({ type: 'delete', id: second, draft: { id: second, records: invalid } }, storage);
  assert.equal(library.activeListId, original); assert.deepEqual(readConfigList(storage), rows());
  const before = storage.getItem(CONFIG_LIST_STORAGE_KEY);
  assert.throws(() => changeConfigLists({ type: 'delete', id: original }, storage), /至少/);
  assert.throws(() => changeConfigLists({ type: 'save', id: second, draft: { id: second, records: [] } }, storage), /已被删除/);
  assert.equal(storage.getItem(CONFIG_LIST_STORAGE_KEY), before);
});

test('validation and storage failures never partially save a draft or change the active list', () => {
  const storage = memory(legacy()), original = migrateConfigLists(storage).activeListId;
  const second = changeConfigLists({ type: 'create', name: '第二组' }, storage).activeListId;
  const before = storage.getItem(CONFIG_LIST_STORAGE_KEY);
  const invalid = rows(); invalid[0].config.columns = 6;
  assert.throws(() => changeConfigLists({ type: 'switch', id: original, draft: { id: second, records: invalid } }, storage), /列数/);
  assert.equal(storage.getItem(CONFIG_LIST_STORAGE_KEY), before);
  const failing = { getItem: storage.getItem, setItem: () => { throw new Error('Storage full'); } };
  assert.throws(() => changeConfigLists({ type: 'switch', id: original, draft: { id: second, records: rows() } }, failing), /Storage full/);
  assert.equal(storage.getItem(CONFIG_LIST_STORAGE_KEY), before);
  const old = memory(legacy()), oldBefore = old.getItem(CONFIG_LIST_STORAGE_KEY);
  assert.throws(() => migrateConfigLists({ getItem: old.getItem, setItem: failing.setItem }), /Storage full/);
  assert.equal(old.getItem(CONFIG_LIST_STORAGE_KEY), oldBefore);
});

test('reference presets are independent lists and switching to an empty list does not reinstall them', () => {
  const storage = memory(); saveConfigList(rows(), storage);
  const original = readConfigLists(storage).activeListId;
  const preset = { id: 'reference-new', records: rows() };
  assert.equal(installConfigPreset(preset, storage), true);
  const reference = readConfigLists(storage).activeListId;
  assert.deepEqual(readConfigLists(storage).lists.find(l => l.id === original).records, rows());
  changeConfigLists({ type: 'create', name: '空列表' }, storage);
  assert.equal(hasConfigPreset(preset.id, storage), true);
  assert.equal(installConfigPreset(preset, storage), false);
  assert.deepEqual(readConfigList(storage), []);
  changeConfigLists({ type: 'delete', id: reference }, storage);
  const count = readConfigLists(storage).lists.length;
  migrateConfigLists(storage);
  assert.equal(readConfigLists(storage).lists.length, count);
  assert.deepEqual(readConfigList(storage), []);
});

test('corrupted library data is never replaced with a new list', () => {
  const storage = memory({ version: 2, activeListId: 'missing', lists: [] });
  const before = storage.getItem(CONFIG_LIST_STORAGE_KEY);
  assert.throws(() => migrateConfigLists(storage), /无效/);
  assert.throws(() => changeConfigLists({ type: 'create', name: 'new' }, storage), /无效/);
  assert.equal(storage.getItem(CONFIG_LIST_STORAGE_KEY), before);
  assert.equal(storage.writes, 0);
});
