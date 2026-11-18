import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceLengthQuota, targetLengthDistance, measureTargetLengthAlignment, alignConstraintWordLengths } from '../dist/target-length-alignment.js';

test('exact lengths, including lengths above eight, retain their individual quotas', () => {
  assert.deepEqual(referenceLengthQuota([3, 3, 4, 8, 9]), [3, 3, 4, 8, 9]);
  assert.equal(measureTargetLengthAlignment([3, 3, 4, 8, 8], [3, 3, 4, 8, 9]).letterDistance, 1);
  assert.equal(measureTargetLengthAlignment([3, 3, 3, 3, 8], [3, 3, 3, 4, 5]).letterDistance, 4);
});

test('count tolerance apportions integer quotas deterministically without changing their sum', () => {
  assert.deepEqual(referenceLengthQuota([3, 4, 5], 2), [3, 4]);
  assert.deepEqual(referenceLengthQuota([3, 3, 4, 5], 5), [3, 3, 3, 4, 5]);
  for (let count = 1; count <= 20; count++) assert.equal(referenceLengthQuota([3, 3, 4, 5, 8], count).length, count);
});

test('partial length distance never prunes an achievable completion', () => {
  const quota = [3, 3, 4, 6];
  for (const a of [3, 4, 5, 6]) for (const b of [3, 4, 5, 6]) {
    const lower = targetLengthDistance([a, b], quota, 2);
    for (const c of [3, 4, 5, 6]) for (const d of [3, 4, 5, 6]) {
      assert.ok(lower <= targetLengthDistance([a, b, c, d], quota));
    }
  }
});

test('aligning a plan preserves manual openings and all existing positional requirements', () => {
  const original = { id: 'test', records: [{ position: 1, mode: 'manual' },
    { position: 6, mode: 'automatic', hard: { targetCount: { minimum: 5 } }, preferences: { targetWordLengths: [3, 3, 3, 4, 5] } }] };
  const before = structuredClone(original), plan = alignConstraintWordLengths(original);
  assert.deepEqual(original, before);
  assert.deepEqual(plan.records[0], original.records[0]);
  assert.deepEqual(plan.records[1].hard.targetCount, original.records[1].hard.targetCount);
  assert.deepEqual(plan.records[1].hard.targetWordLength, { minimum: 3, maximum: 5, maximumLetterDistance: 2 });
});
