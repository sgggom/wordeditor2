import assert from 'node:assert/strict';
import test from 'node:test';
import { createWordCooldown } from '../dist/word-cooldown.js';

const level = (target = [], extra = []) => ({
  targetWords: target.map(word => ({ word })),
  extraWords: extra.map(word => ({ word })),
});

test('a level-one word blocks targets through 51 and extras through 21', () => {
  const cooldown = createWordCooldown({ target: 50, extra: 20 });
  cooldown.commit(level(['ALL']));
  assert.deepEqual(cooldown.remaining('all'), { target: 50, extra: 20 });
  for (let position = 2; position <= 21; position++) {
    assert.deepEqual(cooldown.check(level([], ['ALL'])).extra, ['ALL']);
    cooldown.commit(level());
  }
  assert.deepEqual(cooldown.remaining('ALL'), { target: 30, extra: 0 });
  assert.deepEqual(cooldown.check(level([], ['ALL'])).extra, []);
  for (let position = 22; position <= 51; position++) {
    assert.deepEqual(cooldown.check(level(['ALL'])).target, ['ALL']);
    cooldown.commit(level());
  }
  assert.deepEqual(cooldown.remaining('ALL'), { target: 0, extra: 0 });
  cooldown.commit(level(['ALL']));
  assert.deepEqual(cooldown.remaining('ALL'), { target: 50, extra: 20 });
});

test('an extra occurrence resets both counters and prevents cross-role reuse', () => {
  const cooldown = createWordCooldown({ target: 50, extra: 20 });
  cooldown.commit(level(['ALL']));
  for (let i = 0; i < 20; i++) cooldown.commit(level());
  cooldown.commit(level([], ['ALL']));
  assert.deepEqual(cooldown.remaining('ALL'), { target: 50, extra: 20 });
  assert.deepEqual(cooldown.check(level(['ALL'])), { target: ['ALL'], extra: [] });
  assert.deepEqual(cooldown.blockedWords(), { target: ['ALL'], extra: ['ALL'] });
});

test('retries leave countdowns unchanged and a rejected commit is atomic', () => {
  const cooldown = createWordCooldown({ target: 3, extra: 1 });
  cooldown.commit(level(['ALL']));
  const before = cooldown.snapshot();
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(cooldown.check(level(['ALL'], ['CAT'])), { target: ['ALL'], extra: [] });
    assert.throws(() => cooldown.commit(level(['ALL'], ['CAT'])), { code: 'WORD_COOLDOWN' });
  }
  assert.deepEqual(cooldown.snapshot(), before);
  assert.deepEqual(cooldown.remaining('CAT'), { target: 0, extra: 0 });
});

test('a snapshot restores cooldowns for a sequence backtrack', () => {
  const ranges = { target: 2, extra: 1 };
  const cooldown = createWordCooldown(ranges);
  cooldown.commit(level(['ALL']));
  const saved = cooldown.snapshot();
  cooldown.commit(level(['CAT']));
  assert.deepEqual(cooldown.remaining('ALL'), { target: 1, extra: 0 });
  const restored = createWordCooldown(ranges, saved);
  assert.deepEqual(restored.remaining('ALL'), { target: 2, extra: 1 });
  assert.deepEqual(restored.remaining('CAT'), { target: 0, extra: 0 });
  saved.lastSeen[0][1] = 0;
  assert.deepEqual(restored.remaining('ALL'), { target: 2, extra: 1 });
});

test('a disabled counter permits its role while the other role stays blocked', () => {
  for (const ranges of [{ target: 0, extra: 2 }, { target: 2, extra: 0 }]) {
    const cooldown = createWordCooldown(ranges);
    cooldown.commit(level(['ALL']));
    const disabled = ranges.target === 0 ? 'target' : 'extra';
    const enabled = disabled === 'target' ? 'extra' : 'target';
    assert.equal(cooldown.remaining('ALL')[disabled], 0);
    assert.deepEqual(cooldown.blockedWords()[disabled], []);
    assert.deepEqual(cooldown.blockedWords()[enabled], ['ALL']);
  }
});

test('invalid ranges and snapshots are rejected', () => {
  for (const bad of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => createWordCooldown({ target: bad, extra: 20 }), /冷却范围/);
  }
  const cooldown = createWordCooldown({ target: 2, extra: 1 });
  cooldown.commit(level(['ALL']));
  const saved = cooldown.snapshot();
  assert.throws(() => createWordCooldown({ target: 3, extra: 1 }, saved), /范围不一致/);
  assert.throws(() => createWordCooldown({ target: 2, extra: 1 }, { ...saved, lastSeen: [['ALL', 2]] }), /快照无效/);
});

test('rollback restores both counters after a reused word and allows an alternative branch', () => {
  const cooldown = createWordCooldown({ target: 2, extra: 1 });
  cooldown.commit(level(['ALL']));
  cooldown.commit(level(['CAT']));
  const before = cooldown.snapshot();
  cooldown.commit(level([], ['ALL']));
  assert.deepEqual(cooldown.remaining('ALL'), { target: 2, extra: 1 });
  cooldown.rollback();
  assert.deepEqual(cooldown.snapshot(), before);
  cooldown.commit(level(['DOG']));
  assert.deepEqual(cooldown.remaining('ALL'), { target: 0, extra: 0 });
  assert.deepEqual(cooldown.remaining('DOG'), { target: 2, extra: 1 });
  cooldown.rollback();
  cooldown.rollback();
  cooldown.rollback();
  assert.equal(cooldown.snapshot().completed, 0);
  assert.deepEqual(cooldown.blockedWords(), { target: [], extra: [] });
  assert.throws(() => cooldown.rollback(), /没有可回退/);
});
