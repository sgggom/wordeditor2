import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createGenerator } from '../dist/level-generator.js';
import { setTargetWord } from '../dist/level-rules.js';
import { createGameExport } from '../dist/level-export.js';
import { importGameLevels } from '../dist/level-import.js';
import { CONFIG_FILTER_OPTIONS, validateLevelConfig, saveConfigList, readConfigList } from '../dist/level-config.js';

const normal = JSON.parse(await readFile(new URL('../dist/data/required-words.json', import.meta.url)));
const extras = JSON.parse(await readFile(new URL('../dist/data/extra-words.json', import.meta.url)));
const guide = JSON.parse(await readFile(new URL('../dist/data/guide-words.json', import.meta.url)));
const generator = createGenerator([...normal, ...guide], extras);
const options = () => ({ rows: 2, columns: 2, targetCount: 2, targetLengthPlan: null, targetLimitsEnabled: false,
  initialMaxWordLength: 2, maxWordLength: 2, initialForwardProbability: 50, initialRarityLevel: 1,
  minimumEmotionScore: 0, filters: { scope: [0] }, targetDuplicateRange: 0, extraDuplicateRange: 0,
  fixedWords: ['OF', 'IF'], fixedLayout: { rows: 2, columns: 2, placements: [
    { word: 'OF', path: [0, 1] }, { word: 'IF', path: [2, 3] },
  ] } });

test('the guide bank is independent and every word has complete compatible parameters', async () => {
  assert.equal(guide.length, 30);
  const names = new Set(guide.map(entry => entry.word));
  assert.equal(names.size, 30);
  assert.ok(['OF', 'IF', 'PO', 'TI', 'OH', 'OK'].every(word => names.has(word)));
  const sources = JSON.parse(await readFile(new URL('../dist/data/word-game-sources.json', import.meta.url)));
  assert.equal(sources.zenTwoLetterWords.length, 28);
  assert.ok(sources.zenTwoLetterWords.every(word => names.has(word)));
  assert.deepEqual([...names].filter(word => !sources.zenTwoLetterWords.includes(word)), ['OH', 'OK']);
  assert.equal(normal.some(entry => names.has(entry.word)), false);
  assert.equal(extras.some(entry => names.has(entry.word)), false);
  for (const entry of guide) {
    assert.match(entry.word, /^[A-Z]{2}$/);
    assert.equal(entry.id, `guide:${entry.word.toLowerCase()}`);
    assert.equal(entry.scope, 0); assert.equal(entry.rarityLevel, { PO: 4, TI: 3 }[entry.word] ?? 1); assert.equal(entry.emotion, 0);
    assert.equal(entry.abbreviation, entry.word === 'OK' ? 1 : 0);
    for (const key of ['phonetic', 'definitionEn', 'definitionZh']) assert.ok(typeof entry[key] === 'string' && entry[key].trim());
  }
  const source = JSON.parse(await readFile(new URL('../data/source/guide-words.json', import.meta.url)));
  assert.deepEqual(guide, source);
  const manifest = JSON.parse(await readFile(new URL('../dist/data/word-bank.json', import.meta.url)));
  assert.deepEqual(manifest.groups.map(group => group.key), ['required', 'extra', 'guide']);
  assert.equal(manifest.groups.find(group => group.key === 'guide').label, '2词库');
  assert.equal(manifest.totalCount, normal.length + extras.length + guide.length);
  for (const group of manifest.groups) {
    const bytes = await readFile(new URL(`../dist/data/${group.file}`, import.meta.url));
    assert.equal(group.count, JSON.parse(bytes).length);
    assert.equal(group.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
});

test('guide-only filtering supports fixed words, generation, export and metadata restoration', () => {
  const level = generator.generate(options());
  assert.deepEqual(level.targetWords.map(entry => entry.word), ['OF', 'IF']);
  assert.ok(level.candidateWords.every(entry => entry.scope === 0 && entry.rarityLevel === 1));
  const pack = createGameExport([{ level }]);
  assert.equal(pack.books[0].levels[0].g, 'OF,IF');
  const [restored] = importGameLevels(pack, [...normal, ...extras, ...guide]);
  for (const entry of restored.targetWords) {
    const source = guide.find(record => record.word === entry.word);
    for (const key of ['id', 'scope', 'phonetic', 'emotion', 'abbreviation', 'rarityLevel', 'definitionEn', 'definitionZh']) assert.equal(entry[key], source[key]);
  }
});

test('ordinary scopes exclude guide targets while a mixed selection permits both banks', () => {
  assert.throws(() => generator.generate({ ...options(), filters: { scope: [1] } }), /词库筛选/);
  const mixed = setTargetWord(generator.generate({ ...options(), filters: { scope: [0, 1] } }), 'OFF', true);
  assert.ok(mixed.targetWords.some(entry => entry.scope === 0));
  assert.ok(mixed.targetWords.some(entry => entry.word === 'OFF' && entry.scope === 1));
});

test('guide parameters participate in abbreviation, rarity and emotion filters', () => {
  const config = { ...options(), disabledCells: [2, 3], targetCount: 1, fixedWords: ['OK'],
    fixedLayout: { rows: 2, columns: 2, placements: [{ word: 'OK', path: [0, 1] }] } };
  const level = generator.generate({ ...config, filters: { scope: [0], abbreviation: [1], rarityLevel: [1], emotion: [0] } });
  assert.equal(level.targetWords[0].word, 'OK');
  for (const filters of [{ scope: [0], abbreviation: [0] }, { scope: [0], rarityLevel: [2] }, { scope: [0], emotion: [1] }]) {
    assert.throws(() => generator.generate({ ...config, filters }), /词库筛选/);
  }
});

test('new Zen words retain their parameters through candidate selection and export/import', () => {
  const config = { rows: 2, columns: 2, filters: { scope: [0] }, fixedWords: ['PO', 'IT'],
    fixedLayout: { rows: 2, columns: 2, placements: [{ word: 'PO', path: [0, 1] }, { word: 'IT', path: [2, 3] }] } };
  const level = setTargetWord(generator.generate(config), 'TI', true);
  const pack = createGameExport([{ level }]);
  const [restored] = importGameLevels(pack, [...normal, ...extras, ...guide]);
  for (const word of ['PO', 'TI']) {
    const source = guide.find(entry => entry.word === word);
    const entry = restored.targetWords.find(entry => entry.word === word);
    for (const key of ['scope', 'phonetic', 'emotion', 'abbreviation', 'rarityLevel', 'definitionEn', 'definitionZh']) assert.equal(entry[key], source[key]);
    assert.ok(source.definitionSources.length > 0);
  }
  assert.throws(() => generator.generate({ ...config, initialRarityLevel: 1 }), /生僻档位/);
});

test('guide scope selection survives configuration validation and local storage', () => {
  assert.deepEqual(CONFIG_FILTER_OPTIONS.scope, [0, 1, 2, 3, 4]);
  const config = options(); assert.equal(validateLevelConfig(config), config);
  const values = new Map(); const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  saveConfigList([{ id: 'guide', config }], storage);
  assert.deepEqual(readConfigList(storage)[0].config.filters, { scope: [0] });
});
