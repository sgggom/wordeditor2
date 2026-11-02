import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaytestState, extendPlaytestPath, playtestComplete, submitPlaytestPath } from '../dist/playtest.js';

const level = () => ({ rows: 2, columns: 3, disabledCells: [],
  cells: [...'CATDOG'].map(letter => ({ letter, count: 1 })),
  targetWords: [{ word: 'CAT', path: [0, 1, 2] }, { word: 'DOG', path: [3, 4, 5] }],
  extraWords: [{ word: 'AT', path: [1, 2] }, { word: 'DO', path: [3, 4] }] });

test('target answers consume the actual path and win only after all targets and counts are cleared', () => {
  const source = level(), before = structuredClone(source), initial = createPlaytestState(source);
  const first = submitPlaytestPath(initial, [0, 1, 2]);
  assert.equal(first.kind, 'target');
  assert.deepEqual(first.state.cells.map(cell => cell.count), [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(first.state.foundTargets, ['CAT']);
  assert.equal(playtestComplete(first.state), false);
  const last = submitPlaytestPath(first.state, [3, 4, 5]);
  assert.equal(last.kind, 'complete');
  assert.equal(playtestComplete(last.state), true);
  assert.ok(last.state.cells.every(cell => cell.count === 0));
  assert.equal(submitPlaytestPath(last.state, [0, 1, 2]).state, last.state);
  assert.deepEqual(source, before);
  assert.ok(initial.cells.every(cell => cell.count === 1));
  assert.deepEqual(createPlaytestState(source), initial, 'a new session restarts without altering the editor');
});

test('extra words are collected once and never consume cell counts', () => {
  const state = createPlaytestState(level());
  const extra = submitPlaytestPath(state, [1, 2]);
  assert.equal(extra.kind, 'extra');
  assert.deepEqual(extra.state.foundExtras, ['AT']);
  assert.deepEqual(extra.state.cells, state.cells);
  assert.deepEqual(extra.state.foundTargets, []);
  const duplicate = submitPlaytestPath(extra.state, [1, 2]);
  assert.equal(duplicate.kind, 'repeat');
  assert.equal(duplicate.state, extra.state);
});

test('diagonals, row wrapping, jumps, repeated cells and unknown words do not change progress', () => {
  const state = createPlaytestState(level());
  for (const path of [[], [0, 4], [2, 3], [0, 2], [0, 1, 0], [0, 3, 4], [-1, 0], [0, 1.5], [0, 99], null]) {
    const result = submitPlaytestPath(state, path);
    assert.equal(result.kind, 'invalid');
    assert.equal(result.state, state);
  }
});

test('shared cells decrement once per target and target answers cannot be scored twice', () => {
  const state = createPlaytestState({ rows: 2, columns: 3,
    cells: [...'ABCFED'].map((letter, index) => ({ letter, count: index < 3 ? 2 : 1 })),
    targetWords: [{ word: 'ABCDEF' }, { word: 'ABC' }], extraWords: [] });
  const first = submitPlaytestPath(state, [0, 1, 2]);
  assert.ok(first.state.cells.every(cell => cell.count === 1));
  assert.equal(submitPlaytestPath(first.state, [0, 1, 2]).kind, 'repeat');
  assert.equal(submitPlaytestPath(first.state, [0, 1, 2, 5, 4, 3]).kind, 'complete');
});

test('valid alternate routes consume the player-selected cells rather than the assigned answer path', () => {
  const state = createPlaytestState({ rows: 2, columns: 3,
    cells: [...'CATOTO'].map((letter, index) => ({ letter, count: [2, 1, 2, 1, 2, 1][index] })),
    targetWords: [{ word: 'CAT', path: [0, 1, 2] }, { word: 'COT' }, { word: 'TOT' }] });
  const alternate = submitPlaytestPath(state, [0, 1, 4]);
  assert.equal(alternate.kind, 'target');
  assert.deepEqual(alternate.state.cells.map(cell => cell.count), [1, 0, 2, 1, 1, 1]);
});

test('disabled and depleted cells cannot be selected; reversing one step shortens the route', () => {
  const source = level();
  source.disabledCells = [5]; source.cells[5] = { letter: '', count: 0, disabled: true };
  source.targetWords = [{ word: 'CAT' }, { word: 'DO' }];
  const state = createPlaytestState(source), path = [0, 1];
  assert.deepEqual(extendPlaytestPath(state, path, 0), [0]);
  assert.deepEqual(extendPlaytestPath(state, path, 2), [0, 1, 2]);
  assert.equal(extendPlaytestPath(state, path, 3), path);
  assert.equal(extendPlaytestPath(state, path, 5), path);
  assert.deepEqual(extendPlaytestPath(state, [0, 1, 4, 3], 0), [0, 1, 4, 3]);
  assert.equal(submitPlaytestPath(state, [3, 4, 5]).kind, 'invalid');
  const next = submitPlaytestPath(state, [0, 1, 2]).state;
  assert.deepEqual(extendPlaytestPath(next, [], 0), []);
  assert.equal(submitPlaytestPath(next, [0, 1, 2]).kind, 'invalid');
  assert.equal(submitPlaytestPath(next, [3, 4]).kind, 'complete');
});

test('a mismatched remaining count never produces a false win', () => {
  const source = level(); source.cells[0].count = 2;
  let state = createPlaytestState(source);
  state = submitPlaytestPath(state, [0, 1, 2]).state;
  const last = submitPlaytestPath(state, [3, 4, 5]);
  state = last.state;
  assert.equal(state.foundTargets.length, 2);
  assert.equal(playtestComplete(state), false);
  assert.match(last.message, /剩余次数/);
});

test('empty or malformed boards cannot open a session', () => {
  for (const source of [null, { ...level(), rows: 1 }, { ...level(), targetWords: [] },
    { ...level(), cells: [] }, { ...level(), targetWords: 'CAT' }, { ...level(), extraWords: null },
    { ...level(), targetWords: [null] }, { ...level(), targetWords: [{ word: 'CAT' }, { word: 'CAT' }] }]) {
    assert.throws(() => createPlaytestState(source));
  }
  for (const count of [-1, 36, 1.5, NaN]) {
    const source = level(); source.cells[0].count = count;
    assert.throws(() => createPlaytestState(source), /次数无效/);
  }
});
