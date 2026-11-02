import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '../dist/vendor/sheetjs/xlsx.js';
import { configXlsxTemplate, parseConfigXlsx, serializeConfigXlsx } from '../dist/config-table-xlsx.js';

const defaults = { rows: 3, columns: 3, disabledCells: [], fixedWords: [], fixedLayout: null,
  initialForwardProbability: 50, targetDuplicateRange: 20, extraDuplicateRange: 0, filters: {} };
function editTemplate(edit) {
  const book = XLSX.read(configXlsxTemplate(), { type: 'array' });
  edit(book.Sheets[book.SheetNames[0]]);
  return XLSX.write(book, { type: 'array', bookType: 'xlsx' });
}

test('template is a genuine XLSX workbook with seven columns and literal text IDs', () => {
  const file = configXlsxTemplate();
  assert.deepEqual([...new Uint8Array(file).slice(0, 2)], [80, 75]);
  const book = XLSX.read(file, { type: 'array' });
  assert.deepEqual(book.SheetNames, ['关卡配置']);
  const sheet = book.Sheets['关卡配置'];
  assert.equal(sheet.A2.t, 's'); assert.equal(sheet.A2.v, '001');
  assert.equal(sheet['!ref'], 'A1:G2');
  assert.equal(sheet.B2.v, '3x3');
  const [record] = parseConfigXlsx(file, defaults);
  assert.equal(record.levelId, '001');
  assert.deepEqual(record.config.fixedWords, ['CAT', 'DOG']);
});

test('XLSX export stores dimensions and reimports random shapes, words, filters and IDs', () => {
  const original = parseConfigXlsx(configXlsxTemplate(), defaults);
  original[0].levelId = '=001';
  original[0].config.disabledCells = [7];
  original[0].config.fixedWords = [];
  original[0].config.filters.scope = [];
  const file = serializeConfigXlsx(original);
  const restored = parseConfigXlsx(file, defaults);
  assert.equal(restored[0].levelId, '=001');
  assert.deepEqual(restored[0].config, { ...original[0].config, disabledCells: [] });
  const sheet = XLSX.read(file, { type: 'array' }).Sheets['关卡配置'];
  assert.equal(sheet.A2.f, undefined);
  assert.equal(sheet.B2.v, '3x3');
});

test('Excel numeric IDs preserve displayed leading zeroes; blank word cells are accepted', () => {
  const file = editTemplate(sheet => {
    sheet.A2 = { t: 'n', v: 1, z: '000' };
    delete sheet.C2; delete sheet.D2;
  });
  const [record] = parseConfigXlsx(file, defaults);
  assert.equal(record.levelId, '001');
  assert.deepEqual(record.config.fixedWords, []);
});

test('invalid Excel data and extra columns are rejected with spreadsheet row numbers', () => {
  assert.throws(() => parseConfigXlsx(editTemplate(sheet => { sheet.E2.v = '[9]'; }), defaults), /第 2 行.*范围库/);
  assert.throws(() => parseConfigXlsx(editTemplate(sheet => {
    sheet.H1 = { t: 's', v: 'extra' }; sheet['!ref'] = 'A1:H2';
  }), defaults), /表头/);
  assert.throws(() => parseConfigXlsx(new Uint8Array([0, 1, 2, 3]), defaults), /Excel/);
});

test('formatted trailing rows do not count as levels, but nonempty excess rows are rejected', () => {
  const file = editTemplate(sheet => {
    sheet.G1731 = {t:'z',z:'@'};
    sheet['!ref'] = 'A1:H1731';
  });
  assert.equal(parseConfigXlsx(file,defaults).length,1);
  assert.throws(()=>parseConfigXlsx(editTemplate(sheet=>{
    sheet.A1502 = {t:'s',v:'extra'}; sheet['!ref']='A1:G1502';
  }), defaults),/1500/);
});

test('the supplied optional target duplicate column overrides the editor default', () => {
  const file=editTemplate(sheet=>{
    sheet.H1={t:'s',v:'目标重复检测'};sheet.H2={t:'n',v:50};sheet['!ref']='A1:H2';
  });
  assert.equal(parseConfigXlsx(file,defaults)[0].config.targetDuplicateRange,50);
  assert.throws(()=>parseConfigXlsx(editTemplate(sheet=>{
    sheet.H1={t:'s',v:'目标重复检测'};sheet.H2={t:'s',v:'bad'};sheet['!ref']='A1:H2';
  }),defaults),/目标重复检测/);
});
