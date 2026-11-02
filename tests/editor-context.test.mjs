import assert from 'node:assert/strict';
import test from 'node:test';
import { generationContext, resizeFixedLayout, configDestination, prepareGeneration, resolveConfigSource } from '../dist/level-rules.js';
import { defaultGenerationConfig } from '../dist/level-config.js';
import { createBatchRunner } from '../dist/batch-runner.js';
const source = (id, position, listId = 'a') => ({ listId, id, configId: id, position });
const record = (id, position, listId = 'a') => ({ id, level: {
  sourceConfig: source(id, position, listId), targetWords: [{ word: `WORD${id}` }], extraWords: [] } });

test('regeneration history follows visible order and excludes the current and later levels', () => {
  const records = [record(5, 100), record(8, 1), record(2, 2)];
  assert.deepEqual(generationContext(records, 8), { position: 2, history: [records[0]] });
  assert.deepEqual(generationContext(records, null), { position: 4, history: records });
});

test('resizing fixed placements keeps coordinates and releases only invalid paths', () => {
  const layout = { rows: 3, columns: 4, placements: [
    { word: 'CAT', path: [0, 1, 5] }, { word: 'DOG', path: [3, 7, 11] }] };
  assert.deepEqual(resizeFixedLayout(layout, { rows: 3, columns: 3 }), {
    layout: { rows: 3, columns: 3, placements: [{ word: 'CAT', path: [0, 1, 4] }] }, released: ['DOG'] });
  assert.deepEqual(layout.placements[0].path, [0, 1, 5]);
  assert.deepEqual(resizeFixedLayout(layout, { rows: 3, columns: 4, disabledCells: [5] }).released, ['CAT']);
});

test('configuration identities are scoped to their list and legacy ids still match', () => {
  const records = [record('same', 1, 'b'), record('same', 9, 'a')];
  assert.equal(configDestination(records, source('same', 2)).index, 1);
  assert.equal(configDestination(records, source('different', 3)).index, 1);
  assert.equal(configDestination([{ id: 1, level: { sourceConfig: { id: 'legacy', position: 1 } } }], source('legacy', 1)).existing.id, 1);
  assert.equal(configDestination([record('same', 1, 'b')], source('same', 1)).existing, null);
});

test('partial configuration runs retain their opening rules and future fixed-word reservation', () => {
  const config = { ...defaultGenerationConfig(), targetDuplicateRange: 20 };
  const configs = [{ id: '50', position: 50, config },
    { id: '51', position: 51, config: { ...config, fixedWords: ['CAT'] } }];
  const result = prepareGeneration([], null, config, source('50', 50), configs);
  assert.equal(result.config.minimumWordLength, 3);
  assert.deepEqual(result.config.reservedTargetWords, ['CAT']);
  assert.equal(prepareGeneration([], null, config).config.minimumWordLength, 2);
});

test('linked reruns replace by identity after manual reordering and check only preceding levels', async () => {
  const history = [record('second', 2), record('first', 1)];
  const checks = [];
  const runner = createBatchRunner({ getHistory: async () => history,
    generate: async (config, check) => { checks.push(check.target.words); return { targetWords: [], extraWords: [] }; },
    save: async level => ({ id: 'second', level }) });
  const state = await runner.run([{ id: 'second', listId: 'a', position: 2, config: defaultGenerationConfig() }]);
  assert.equal(state.phase, 'complete');
  assert.deepEqual(checks, [[]]);
});

test('import defaults do not share mutable arrays or hidden fixed words', () => {
  const first = defaultGenerationConfig(); first.fixedWords.push('CAT'); first.filters.scope = [0];
  assert.deepEqual(defaultGenerationConfig().fixedWords, []);
  assert.deepEqual(defaultGenerationConfig().filters, {});
});

test('legacy source ids are upgraded only when their owning list is unambiguous', () => {
  const records = [{ id: 'old', config: defaultGenerationConfig() }];
  const linked = resolveConfigSource({ id: 'old', position: 10 }, [{ id: 'a', records }]);
  assert.equal(linked.source.listId, 'a');
  assert.equal(linked.source.configId, 'old');
  assert.equal(linked.source.position, 1);
  assert.equal(resolveConfigSource({ id: 'old' }, [{ id: 'a', records }, { id: 'b', records }]), null);
});
