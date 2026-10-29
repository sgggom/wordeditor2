import assert from "node:assert/strict";
import test from "node:test";
import { createGenerator, generateUntilComplete } from "../dist/level-generator.js";

function retryError() {
  const error = new Error("No matching board in this batch");
  error.code = "GENERATION_RETRY";
  error.attempts = 80;
  return error;
}

test("generation continues past multiple exhausted batches without changing the configuration", async () => {
  const options = Object.freeze({ rows: 3, columns: 4, targetCount: 6,
    targetLengthRatios: Object.freeze({ short: 50, medium: 30, long: 20 }), maxWordLength: 6, initialMaxWordLength: 4 });
  const level = { targetCount: 6 };
  const progress = [];
  let calls = 0;
  const result = await generateUntilComplete({ generate(received) {
    assert.equal(received, options);
    calls += 1;
    if (calls <= 3) throw retryError();
    return level;
  } }, options, { onProgress: update => progress.push(update.attempts) });
  assert.equal(result, level);
  assert.equal(calls, 4);
  assert.deepEqual(progress, [80, 160, 240]);
});

test("invalid configuration and unexpected failures stop immediately instead of retrying", async () => {
  const generator = createGenerator([{ word: "ABCDEF" }]);
  let progress = 0;
  await assert.rejects(generateUntilComplete(generator, { rows: 2, columns: 3, initialForwardProbability: 101 },
    { onProgress: () => { progress += 1; } }), /初始正向概率/);
  let calls = 0;
  const failure = new Error("Unexpected failure");
  await assert.rejects(generateUntilComplete({ generate() { calls += 1; throw failure; } }, {}), error => error === failure);
  assert.equal(calls, 1);
  assert.equal(progress, 0);
});

test("generation yields between batches and stops when its request is no longer current", async () => {
  let current = true;
  let calls = 0;
  const generator = { generate() { calls += 1; throw retryError(); } };
  const result = await generateUntilComplete(generator, {}, {
    isCurrent: () => current,
    onProgress: () => setTimeout(() => { current = false; }, 0),
  });
  assert.equal(result, null);
  assert.equal(calls, 1);
  assert.equal(await generateUntilComplete(generator, {}, { isCurrent: () => false }), null);
  assert.equal(calls, 1);
});

test("ambiguity does not retry while impossible physical coverage fails immediately", () => {
  const repeated = createGenerator([{ word: "AAA" }, { word: "AAAA" }]);
  assert.ok(repeated.generate({ rows: 2, columns: 3, random: () => 0.5 }).targetWords.some(entry => !entry.pathAnalysis.safe));
  const tooLong = createGenerator([{ word: "ABCDEFG" }]);
  assert.throws(() => tooLong.generate({ rows: 2, columns: 3 }),
    error => error.code !== "GENERATION_RETRY" && /没有可用的初始词/.test(error.message));
  const insufficientInitial = createGenerator([{ word: "AAA" }]);
  assert.throws(() => insufficientInitial.generate({ rows: 2, columns: 3 }),
    error => error.code !== "GENERATION_RETRY" && /无法填满棋盘/.test(error.message));
});
