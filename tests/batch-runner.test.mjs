import assert from "node:assert/strict";
import test from "node:test";
import { createBatchRunner } from "../dist/batch-runner.js";
import { configJobsInRange } from "../dist/level-config.js";

const config = () => ({ rows: 3, columns: 4, targetCount: 6, targetLengthPlan: null,
  initialMaxWordLength: 4, maxWordLength: 6, initialForwardProbability: 80,
  targetDuplicateRange: 2, extraDuplicateRange: 1, filters: {} });
const jobs = () => [2, 5, 9].map(position => ({ id: `config-${position}`, position, config: config() }));
const level = word => ({ targetWords: [{ word }], extraWords: [{ word: `${word}X` }] });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

test("middle-range generation checks only preceding levels and uses newly saved versions", async () => {
  const history = Array.from({ length: 10 }, (_, index) => ({ id: index + 1,
    level: { ...level(`OLD${index + 1}`), sourceConfig: { id: `config-${index + 1}`, position: index + 1 } } }));
  const checks = [], saved = [];
  const runner = createBatchRunner({
    getHistory: async () => history,
    generate: async (_, check) => { checks.push(check); return level(`NEW${checks.length + 4}`); },
    save: async generated => { const record = { id: 11 + saved.length, level: generated }; saved.push(record); return record; },
  });
  await runner.run([5, 6].map(position => ({ id: `config-${position}`, position, config: config() })));
  assert.deepEqual(checks[0].target.words, ["OLD3", "OLD4"]);
  assert.deepEqual(checks[0].extra.words, ["OLD4X"]);
  assert.deepEqual(checks[1].target.words, ["OLD4", "NEW5"]);
  assert.deepEqual(checks[1].target.levelIds, [4, 11]);
  assert.deepEqual(checks[1].extra.words, ["NEW5X"]);
  assert.equal(history.length, 10);
});

test("batch generation uses list order, freezes its configuration, and includes committed results in subsequent duplicate windows", async () => {
  const queue = jobs();
  const history = [{ id: 1, level: level("OLD") }];
  const seen = [];
  const saved = [];
  const updates = [];
  let id = 1;
  const runner = createBatchRunner({
    getHistory: async () => history,
    generate: async (settings, check, { onProgress }) => {
      seen.push({ settings, check });
      onProgress({ attempts: 80 });
      return level(["ONE", "TWO", "THREE"][seen.length - 1]);
    },
    save: async generated => ({ id: ++id, level: generated }),
    onSaved: record => saved.push(record),
    onUpdate: state => updates.push(state),
  });
  const running = runner.run(queue);
  queue[0].config.maxWordLength = 100;
  const result = await running;
  assert.equal(result.phase, "complete");
  assert.equal(result.completed, 3);
  assert.equal(seen[0].settings.maxWordLength, 6);
  assert.deepEqual(saved.map(record => record.level.sourceConfig.position), [2, 5, 9]);
  assert.deepEqual(seen[0].check.target.words, ["OLD"]);
  assert.deepEqual(seen[1].check.target.words, ["OLD", "ONE"]);
  assert.deepEqual(seen[2].check.target.words, ["ONE", "TWO"]);
  assert.deepEqual(seen[2].check.extra.words, ["TWOX"]);
  assert.equal(history.length, 1, "The supplied history array must remain untouched");
  assert.ok(updates.some(state => state.phase === "generating" && state.attempts === 80));
});

test("the next configuration never starts before the previous save commits", async () => {
  const saveStarted = deferred();
  const commit = deferred();
  let generated = 0;
  let saves = 0;
  const updates = [];
  const runner = createBatchRunner({
    getHistory: async () => [],
    generate: async () => level(`WORD${++generated}`),
    save: async value => { if (++saves === 1) { saveStarted.resolve(); await commit.promise; } return { id: saves, level: value }; },
    onUpdate: state => updates.push(state),
  });
  const running = runner.run(jobs());
  await saveStarted.promise;
  assert.equal(generated, 1);
  assert.equal(updates.at(-1).completed, 0);
  commit.resolve();
  assert.equal((await running).completed, 3);
});

test("stopping during generation ignores late results and does not save or advance", async () => {
  const started = deferred();
  const result = deferred();
  let saves = 0;
  let activeSignal;
  const runner = createBatchRunner({
    getHistory: async () => [],
    generate: async (_, __, { signal }) => { activeSignal = signal; started.resolve(); return result.promise; },
    save: async () => { saves += 1; },
  });
  const running = runner.run(jobs());
  await started.promise;
  runner.stop();
  assert.equal(activeSignal.aborted, true);
  result.resolve(level("LATE"));
  const state = await running;
  assert.equal(state.phase, "stopped");
  assert.equal(state.completed, 0);
  assert.equal(saves, 0);
});

test("stopping during a save retains the committed result exactly once and does not start the next configuration", async () => {
  const started = deferred();
  const commit = deferred();
  let generated = 0;
  const saved = [];
  const runner = createBatchRunner({
    getHistory: async () => [],
    generate: async () => { generated += 1; return level("ONE"); },
    save: async value => { started.resolve(); await commit.promise; return { id: 1, level: value }; },
    onSaved: record => saved.push(record),
  });
  const running = runner.run(jobs());
  await started.promise;
  runner.stop();
  commit.resolve();
  const state = await running;
  assert.equal(state.phase, "stopped");
  assert.equal(state.completed, 1);
  assert.equal(generated, 1);
  assert.equal(saved.length, 1);
});

test("a failed save stops on that configuration without skipping ahead or counting the result", async () => {
  let generated = 0;
  const saved = [];
  const runner = createBatchRunner({
    getHistory: async () => [],
    generate: async () => level(`WORD${++generated}`),
    save: async value => { if (generated === 2) throw new Error("Storage full"); return { id: generated, level: value }; },
    onSaved: record => saved.push(record),
  });
  const state = await runner.run(jobs());
  assert.equal(state.phase, "error");
  assert.equal(state.error, "Storage full");
  assert.equal(state.position, 5);
  assert.equal(state.completed, 1);
  assert.equal(generated, 2);
  assert.equal(saved.length, 1);
});

test("fatal generation errors and unreadable history stop without writing a result", async () => {
  let saves = 0;
  const runner = createBatchRunner({
    getHistory: async () => [],
    generate: async () => { throw new Error("Impossible configuration"); },
    save: async () => { saves += 1; },
  });
  const state = await runner.run(jobs());
  assert.equal(state.phase, "error");
  assert.equal(state.completed, 0);
  assert.equal(state.position, 2);
  assert.equal(saves, 0);
  const badHistory = createBatchRunner({
    getHistory: async () => { throw new Error("Database unavailable"); },
    generate: async () => { assert.fail("Should not generate without duplicate history"); },
    save: async () => { assert.fail("Should not save"); },
  });
  assert.equal((await badHistory.run(jobs())).error, "Database unavailable");
});

test("a range run generates and saves only its inclusive configuration interval", async () => {
  const records = Array.from({ length: 6 }, (_, index) => ({ id: `row-${index + 1}`,
    config: { ...config(), initialForwardProbability: (index + 1) * 10 } }));
  const seen = [], saved = [];
  const runner = createBatchRunner({
    getHistory: async () => [],
    generate: async settings => { seen.push(settings.initialForwardProbability); return level(`WORD${seen.length}`); },
    save: async generated => { const record = { id: saved.length + 1, level: generated }; saved.push(record); return record; },
  });
  const state = await runner.run(configJobsInRange(records, 2, 4));
  assert.equal(state.phase, "complete");
  assert.equal(state.completed, 3);
  assert.deepEqual(seen, [20, 30, 40]);
  assert.deepEqual(saved.map(record => record.level.sourceConfig), [
    { id: "row-2", position: 2 }, { id: "row-3", position: 3 }, { id: "row-4", position: 4 },
  ]);
});
