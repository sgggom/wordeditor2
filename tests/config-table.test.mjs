import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigTable, serializeConfigTable, configTableTemplate } from '../dist/config-table.js';
import { CONFIG_LIST_STORAGE_KEY, changeConfigLists, readConfigLists } from '../dist/level-config.js';

const defaults = () => ({ rows: 3, columns: 3, disabledCells: [], fixedWords: ['OLD'],
  fixedWordExemptions: ['OLD'], fixedLayout: null, initialForwardProbability: 70,
  targetDuplicateRange: 20, extraDuplicateRange: 0, filters: { abbreviation: [0] } });
const table = (overrides = {}) => {
  const row = { '关卡id': '001', '棋盘造型': '[[1,1,1],[1,1,1],[1,0,1]]', '初始单词1': 'cat', '初始单词2': 'dog',
    '范围库': '[0,2]', '情绪': '[-1,0,2]', '生僻程度': '[1,3,5]', ...overrides };
  return Object.keys(row).join(',') + '\r\n' + Object.values(row).map(value => `"${value.replaceAll('"', '""')}"`).join(',') + '\r\n';
};

test('CSV reads the seven fields, shapes and IDs while retaining independent defaults', () => {
  const base = defaults(), original = structuredClone(base);
  const [record] = parseConfigTable('\uFEFF' + table(), base);
  assert.equal(record.levelId, '001');
  assert.deepEqual(record.config.disabledCells, [7]);
  assert.deepEqual(record.config.fixedWords, ['CAT', 'DOG']);
  assert.equal(record.config.fixedLayout, null);
  assert.deepEqual(record.config.fixedWordExemptions, []);
  assert.deepEqual(record.config.filters, { abbreviation: [0], scope: [0,2], emotion: [-1,0,2], rarityLevel: [1,3,5] });
  assert.equal(record.config.initialForwardProbability, 70);
  record.config.filters.abbreviation.push(1);
  assert.deepEqual(base, original);
});

test('template and export reimport preserve all seven fields, including quoted IDs and empty filters', () => {
  const template = parseConfigTable(configTableTemplate(), defaults());
  assert.deepEqual(template[0].config.fixedWords, ['CAT', 'DOG']);
  const original = parseConfigTable(table({ '棋盘造型': '4x3', '关卡id': 'level,"one"', '范围库': '[]', '初始单词1': '', '初始单词2': '' }), defaults());
  const restored = parseConfigTable(serializeConfigTable(original), defaults());
  assert.equal(restored[0].levelId, original[0].levelId);
  assert.deepEqual(restored[0].config, original[0].config);
});

test('reordered headers and multiline shapes work; invalid data identifies the row', () => {
  const source = table({ '棋盘造型': '[[1,1,1],\n[1,1,1],\n[1,0,1]]' });
  assert.deepEqual(parseConfigTable(source, defaults())[0].config.disabledCells, [7]);
  const [header, data] = table().trim().split('\r\n');
  const reordered = header.split(',');
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.equal(parseConfigTable(reordered.join(',') + '\n' + data.replace('"001","[[1,1,1],[1,1,1],[1,0,1]]"', '"[[1,1,1],[1,1,1],[1,0,1]]","001"'), defaults())[0].levelId, '001');
  for (const override of [{ '范围库': '[5]' }, { '情绪': '["0"]' }, { '生僻程度': '' },
    { '棋盘造型': '[[0,0],[0,0]]' }, { '棋盘造型': '[[1,1],[1,1,1]]' },
    { '棋盘造型': '[[1,1,1,1,1,1],[1,1,1,1,1,1]]' },
    ...['null', '{}', '[]', '[1,1]', '[[1,1]]', '[[1],[1]]', '[[1,2],[1,1]]',
      '[[true,1],[1,1]]', '[["1",1],[1,1]]', '[[1,1],null]', '111/111/101',
      '[[1,1],[1,1],[1,1],[1,1],[1,1],[1,1]]'].map(value => ({ '棋盘造型': value })),
    { '关卡id': '' }, { '初始单词1': 'cat dog' }, { '初始单词2': 'CAT' }]) {
    assert.throws(() => parseConfigTable(table(override), defaults()), /第 2 行/);
  }
  assert.throws(() => parseConfigTable(header + '\n' + data + '\n' + data, defaults()), /第 3 行.*重复/);
  assert.throws(() => parseConfigTable('wrong\nabc', defaults()), /表头/);
  assert.throws(() => parseConfigTable(table() + '"unclosed', defaults()), /引号/);
  assert.throws(() => parseConfigTable(header, defaults()), /没有关卡/);
});

test('export rejects more than two words rather than losing configured words', () => {
  const records = parseConfigTable(configTableTemplate(), defaults());
  records[0].config.fixedWords.push('COT');
  assert.throws(() => serializeConfigTable(records), /超过两个/);
});

test('table import creates a new list and saves the outgoing draft in a single write; failures leave storage intact', () => {
  const old = [{ id: 'old', config: defaults() }];
  let saved = JSON.stringify({ version: 2, activeListId: 'original', lists: [{ id: 'original', name: '旧配置', records: old }] });
  let writes = 0;
  const storage = { getItem: key => key === CONFIG_LIST_STORAGE_KEY ? saved : null,
    setItem(key, value) { writes++; saved = value; } };
  const imported = parseConfigTable(table(), defaults());
  const draft = structuredClone(old); draft[0].config.initialForwardProbability = 33;
  const library = changeConfigLists({ type: 'create', name: '配置表', records: imported,
    draft: { id: 'original', records: draft } }, storage);
  assert.equal(writes, 1);
  assert.deepEqual(library.lists[0].records, draft);
  assert.deepEqual(library.lists[1].records, imported);
  assert.equal(readConfigLists(storage).activeListId, library.lists[1].id);
  const before = saved;
  imported[0].config.rows = 9;
  assert.throws(() => changeConfigLists({ type: 'create', name: '非法表', records: imported }, storage), /行数/);
  assert.equal(saved, before);
  assert.throws(() => changeConfigLists({ type: 'create', name: '存储失败', records: old },
    { getItem: storage.getItem, setItem() { throw new Error('quota'); } }), /quota/);
  assert.equal(saved, before);
});
