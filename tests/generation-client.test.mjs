import assert from "node:assert/strict";
import test from "node:test";
import { createGenerationClient, defaultGenerationWorkers, detectedProcessorCount } from "../dist/generation-client.js";
import { createBatchRunner } from "../dist/batch-runner.js";

class FakeWorker {
  messages = [];
  terminated = 0;
  postMessage(data) { this.messages.push(structuredClone(data)); }
  terminate() { this.terminated += 1; }
  get requestId() { return this.messages.findLast(message => message.type === "generate")?.requestId; }
  emit(data, requestId = this.requestId) { this.onmessage({ data: { requestId, ...data } }); }
  crash() { this.onerror({ preventDefault() {} }); }
}

function pool(workerCount = 3) {
  const workers = [];
  const client = createGenerationClient({ workerCount, workerFactory: () => {
    const worker = new FakeWorker(); workers.push(worker); return worker;
  } });
  return { client, workers };
}
const options = onProgress => ({ signal: new AbortController().signal, onProgress });
const settings = { rows: 3, columns: 4, targetCount: 6, targetLengthPlan: null,
  initialMaxWordLength: 4, maxWordLength: 6, initialForwardProbability: 80,
  targetDuplicateRange: 20, extraDuplicateRange: 0, filters: {} };

test("parallelism follows runtime logical cores without a fixed device cap, with a safe fallback", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    for (const [cores, expected] of [[1, 1], [2, 1], [4, 3], [8, 7], [16, 15], [64, 63],
      [undefined, 1], [null, 1], [0, 1], [-1, 1], [1.5, 1], [Infinity, 1], [NaN, 1], ["8", 1]]) {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { hardwareConcurrency: cores } });
      assert.equal(defaultGenerationWorkers(), expected);
      assert.equal(createGenerationClient().workerCount, expected);
      assert.equal(detectedProcessorCount(), Number.isSafeInteger(cores) && cores > 0 ? cores : 1);
    }
    for (const workerCount of [0, -1, 1.5, Infinity]) {
      assert.throws(() => createGenerationClient({ workerCount }), /正整数/);
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete globalThis.navigator;
  }
});

test("all workers search the same configuration and history; progress sums completed attempts", async () => {
  const { client, workers } = pool();
  const progress = [];
  const check = { target: { words: ["OLD"], levelIds: [1] }, extra: { words: [] } };
  const result = client.generate(settings, check, options(value => progress.push(value)));
  assert.equal(workers.length, 3);
  for (const worker of workers) assert.deepEqual(worker.messages[0], { ...settings, duplicateCheck: check, type: "generate", requestId: 1 });
  workers[0].emit({ progress: { attempts: 80 } });
  workers[1].emit({ progress: { attempts: 160 } });
  workers[0].emit({ progress: { attempts: 1 } });
  workers[2].emit({ progress: { attempts: -3 } });
  assert.deepEqual(progress.at(-1), { attempts: 240, workers: 3 });
  workers[1].emit({ level: { winner: 1 } });
  workers[0].emit({ level: { winner: 0 } });
  assert.deepEqual(await result, { winner: 1 });
  for (const worker of workers) {
    assert.deepEqual(worker.messages.at(-1), { type: "cancel", requestId: 1 });
    assert.equal(worker.terminated, 0, "Healthy workers keep their caches for the next level");
  }
  client.close();
  assert.ok(workers.every(worker => worker.terminated === 1));
});

test("warm workers are reused and stale results/progress/errors cannot affect the next request", async () => {
  const { client, workers } = pool(2);
  const first = client.generate(settings, {}, options());
  workers[0].emit({ level: { id: 1 } });
  await first;
  const progress = [];
  const second = client.generate(settings, {}, options(value => progress.push(value)));
  assert.equal(workers.length, 2);
  assert.equal(workers[0].requestId, 2);
  workers[1].emit({ level: { id: "stale" } }, 1);
  workers[0].emit({ error: "stale error" }, 1);
  workers[1].emit({ progress: { attempts: 900 } }, 1);
  assert.deepEqual(progress, [{ attempts: 0, workers: 2 }]);
  workers[1].emit({ level: { id: 2 } });
  assert.deepEqual(await second, { id: 2 });
  client.close();
});

test("abort terminates every worker, ignores late responses and allows a fresh run", async () => {
  const { client, workers } = pool(2);
  const controller = new AbortController();
  const result = client.generate(settings, {}, { signal: controller.signal });
  controller.abort();
  assert.equal(await result, null);
  assert.ok(workers.every(worker => worker.terminated === 1));
  const next = client.generate(settings, {}, options());
  assert.equal(workers.length, 4);
  workers[0].emit({ level: { id: "stale" } });
  workers[0].crash();
  workers[2].emit({ level: { id: "fresh" } });
  assert.deepEqual(await next, { id: "fresh" });
  client.close();
});

test("pre-aborted requests spawn no workers; closing an active pool resolves cancellation", async () => {
  const { client, workers } = pool();
  const controller = new AbortController(); controller.abort();
  assert.equal(await client.generate(settings, {}, { signal: controller.signal }), null);
  assert.equal(workers.length, 0);
  const result = client.generate(settings, {}, options());
  await assert.rejects(client.generate(settings, {}, options()), /上一关/);
  client.close();
  assert.equal(await result, null);
  assert.ok(workers.every(worker => worker.terminated === 1));
  client.close();
  assert.ok(workers.every(worker => worker.terminated === 1));
});

test("one failed lane does not discard another lane's valid result; crashed workers are replaced", async () => {
  const { client, workers } = pool();
  const progress = [];
  const result = client.generate(settings, {}, options(value => progress.push(value)));
  workers[0].emit({ progress: { attempts: 80 } });
  workers[0].crash();
  workers[1].emit({ error: "temporary dictionary error" });
  assert.deepEqual(progress.at(-1), { attempts: 80, workers: 1 });
  workers[1].emit({ level: { id: "failed lane" } });
  workers[2].emit({ level: { id: "valid" } });
  assert.deepEqual(await result, { id: "valid" });
  const next = client.generate(settings, {}, options());
  assert.equal(workers.length, 4);
  workers[3].emit({ level: { id: "replacement" } });
  assert.deepEqual(await next, { id: "replacement" });
  client.close();
});

test("all lane failures reject once with their reason and leave the pool usable", async () => {
  const { client, workers } = pool(2);
  const result = client.generate(settings, {}, options());
  const rejected = assert.rejects(result, /无法满足词长配置/);
  workers[0].emit({ error: "无法满足词长配置" });
  workers[1].emit({ error: "无法满足词长配置" });
  await rejected;
  const next = client.generate(settings, {}, options());
  workers[0].emit({ level: { ok: true } });
  assert.deepEqual(await next, { ok: true });
  client.close();
});

test("partial worker startup and posting failures allow surviving workers to finish", async () => {
  const workers = [];
  let startupFails = true;
  const client = createGenerationClient({ workerCount: 3, workerFactory: () => {
    if (workers.length === 2 && startupFails) throw new Error("Worker quota");
    const worker = new FakeWorker(); workers.push(worker); return worker;
  } });
  const first = client.generate(settings, {}, options());
  assert.equal(workers.length, 2);
  workers[1].emit({ level: { ok: 1 } });
  await first;
  startupFails = false;
  workers[0].postMessage = () => { throw new Error("posting failed"); };
  const second = client.generate(settings, {}, options());
  assert.equal(workers.length, 3);
  assert.equal(workers[0].terminated, 1);
  workers[2].emit({ level: { ok: 2 } });
  assert.deepEqual(await second, { ok: 2 });
  client.close();
  const unavailable = createGenerationClient({ workerFactory: () => { throw new Error("Worker unavailable"); } });
  await assert.rejects(unavailable.generate(settings, {}, options()), /Worker unavailable/);
});

test("parallel winners save exactly once per configuration and subsequent workers see committed history", async () => {
  const { client, workers } = pool(3);
  const saved = [];
  const runner = createBatchRunner({
    getHistory: async () => [],
    generate: (...args) => client.generate(...args),
    save: async level => { const record = { id: saved.length + 1, level }; saved.push(record); return record; },
  });
  const running = runner.run([1, 2].map(position => ({ id: `config-${position}`, position, config: settings })));
  await new Promise(resolve => setImmediate(resolve));
  const firstLevel = { targetWords: [{ word: "ONE" }], extraWords: [] };
  workers[1].emit({ level: firstLevel });
  workers[2].emit({ level: { targetWords: [{ word: "LOSER" }], extraWords: [] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved.length, 1);
  for (const worker of workers) {
    const next = worker.messages.findLast(message => message.type === "generate");
    assert.equal(next.requestId, 2);
    assert.deepEqual(next.duplicateCheck.target.words, ["ONE"]);
    assert.deepEqual(next.duplicateCheck.target.levelIds, [1]);
  }
  workers[0].emit({ level: { targetWords: [{ word: "TWO" }], extraWords: [] } });
  assert.equal((await running).phase, "complete");
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map(record => record.level.sourceConfig.position), [1, 2]);
  client.close();
});
