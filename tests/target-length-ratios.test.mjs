import assert from "node:assert/strict";
import test from "node:test";
import { allocateTargetLengths, countTargetLengthPlan, targetLengthGroup } from "../dist/level-generator.js";

test("numbered targets count exact categories without percentage rounding", () => {
  assert.deepEqual(countTargetLengthPlan(6, ["short", "medium", "long", "short", "short", "medium"]),
    { short: 3, medium: 2, long: 1 });
  const plan = Array(101).fill("short");
  plan[100] = "long";
  assert.deepEqual(countTargetLengthPlan(101, plan), { short: 100, medium: 0, long: 1 });
  assert.equal(countTargetLengthPlan(6, null), null);
  for (const invalid of [[], ["short"], "short", { short: 3 }, ["short", "medium", "unknown"], Array(3)]) {
    assert.throws(() => countTargetLengthPlan(3, invalid), /配置|请选择/);
  }
  assert.throws(() => countTargetLengthPlan(0, []), /目标数量/);
});

test("ratios round to exact word counts using largest remainders and stable short/medium/long ties", () => {
  assert.deepEqual(allocateTargetLengths(6, { short: 34, medium: 33, long: 33 }), { short: 2, medium: 2, long: 2 });
  assert.deepEqual(allocateTargetLengths(7, { short: 50, medium: 30, long: 20 }), { short: 4, medium: 2, long: 1 });
  assert.deepEqual(allocateTargetLengths(5, { short: 0, medium: 50, long: 50 }), { short: 0, medium: 3, long: 2 });
  assert.deepEqual(allocateTargetLengths(1, { short: 34, medium: 33, long: 33 }), { short: 1, medium: 0, long: 0 });
  const large = allocateTargetLengths(Number.MAX_SAFE_INTEGER, { short: 34, medium: 33, long: 33 });
  assert.equal(Object.values(large).reduce((sum, count) => sum + count, 0), Number.MAX_SAFE_INTEGER);
  assert.equal(allocateTargetLengths(6, null), null);
  assert.deepEqual([2, 3, 4, 5, 8].map(targetLengthGroup), [null, "short", "medium", "long", "long"]);
});

test("invalid ratios fail rather than being normalized or silently relaxed", () => {
  for (const ratios of [[], "50/30/20", {}, { short: 50, medium: 50 },
    { short: 50, medium: 30, long: 10 }, { short: 50, medium: 30, long: 21 },
    { short: -1, medium: 51, long: 50 }, { short: 0.5, medium: 49.5, long: 50 },
    { short: "50", medium: 30, long: 20 }, { short: 50, medium: 30, long: 20, other: 0 }]) {
    assert.throws(() => allocateTargetLengths(6, ratios), /占比/);
  }
  assert.throws(() => allocateTargetLengths(0, { short: 34, medium: 33, long: 33 }), /目标数量/);
});
