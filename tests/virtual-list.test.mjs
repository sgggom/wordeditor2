import assert from "node:assert/strict";
import test from "node:test";
import { virtualListRange } from "../dist/virtual-list.js";

test("empty results and a viewport larger than the list remain bounded", () => {
  assert.deepEqual(virtualListRange([0], 0, 400), { start: 0, end: 0 });
  assert.deepEqual(virtualListRange([0, 104, 208], 0, 400), { start: 0, end: 2 });
});

test("mixed heights account for recent-use badges and exact row boundaries", () => {
  const offsets = [0, 104, 237, 341, 474];
  assert.deepEqual(virtualListRange(offsets, 0, 104, 0), { start: 0, end: 1 });
  assert.deepEqual(virtualListRange(offsets, 104, 133, 0), { start: 1, end: 2 });
  assert.deepEqual(virtualListRange(offsets, 200, 100, 0), { start: 1, end: 3 });
  assert.deepEqual(virtualListRange(offsets, 999, 100, 0), { start: 3, end: 4 });
});

test("ten thousand words render only the viewport and a small overscan window", () => {
  const offsets = Array.from({ length: 10001 }, (_, index) => index * 104);
  const middle = virtualListRange(offsets, 5000 * 104, 480);
  assert.deepEqual(middle, { start: 4996, end: 5009 });
  assert.ok(middle.end - middle.start < 20);
  assert.deepEqual(virtualListRange(offsets, 9999 * 104, 480), { start: 9995, end: 10000 });
});
