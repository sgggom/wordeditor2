import test from 'node:test';
import assert from 'node:assert/strict';
import { createTargetPathBatchChecker } from '../dist/target-path-batch.js';

const level = () => ({ rows: 2, columns: 2, cells: [...'ABAB'].map(letter => ({ letter, count: 1 })),
  targetWords: [{ word: 'AB' }, { word: 'BA' }], extraWords: [{ word: 'IGNORE' }] });
const jobs = () => [1,2,3].map(id => ({ id, level: level() }));
function fixture() {
  const workers = [], updates = [], results = [];
  const checker = createTargetPathBatchChecker({ onUpdate: state => updates.push(state), onResult: (...args) => results.push(args), workerFactory() {
    const worker = { messages: [], terminated: false, postMessage(data) { this.messages.push(data); }, terminate() { this.terminated = true; } };
    workers.push(worker); return worker;
  } });
  return { checker, workers, updates, results };
}
const safe = { solvable: true, allChoicesComplete: true };
const unsafe = { solvable: true, allChoicesComplete: false, counterexample: { moves: [] } };

test('checks every snapshot in order with one reusable worker and counts safe, unsafe and errors separately', async () => {
  const { checker, workers, updates, results } = fixture();
  const records = jobs(), pending = checker.run(records);
  records[0].level.cells[0].count = 100;
  assert.equal(workers[0].messages[0].cells[0].count, 1);
  assert.equal(Object.hasOwn(workers[0].messages[0], 'extraWords'), false);
  workers[0].onmessage({ data: { result: safe } });
  workers[0].onmessage({ data: { result: unsafe } });
  workers[0].onmessage({ data: { error: 'bad board' } });
  const result = await pending;
  assert.deepEqual([result.completed, result.passed, result.issues, result.errors], [3,1,1,1]);
  assert.equal(result.phase, 'complete');
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(results.map(([job, value]) => [job.position, value.status]), [[1,'safe'],[2,'unsafe'],[3,'error']]);
  assert.equal(updates[0].completed, 0);
});

test('stop terminates the active check and late results cannot alter completed results', async () => {
  const { checker, workers, results } = fixture();
  const pending = checker.run(jobs());
  workers[0].onmessage({ data: { result: safe } });
  checker.stop();
  workers[0].onmessage({ data: { result: unsafe } });
  assert.equal((await pending).phase, 'stopped');
  assert.equal(results.length, 1);
  assert.equal(workers[0].terminated, true);
});

test('starting a new list cancels the old run and rejects stale worker replies', async () => {
  const { checker, workers, results } = fixture();
  const first = checker.run(jobs());
  const second = checker.run(jobs().slice(0,1));
  workers[0].onmessage({ data: { result: unsafe } });
  workers[1].onmessage({ data: { result: safe } });
  assert.equal((await first).phase, 'stopped');
  assert.equal((await second).passed, 1);
  assert.equal(results.length, 1);
});

test('worker crashes are marked incomplete and a new worker checks the remaining levels', async () => {
  const { checker, workers, results } = fixture();
  const pending = checker.run(jobs().slice(0,2));
  workers[0].onerror();
  workers[0].onmessage({ data: { result: unsafe } });
  workers[0].onerror();
  workers[1].onmessage({ data: { result: safe } });
  assert.equal((await pending).errors, 1);
  assert.deepEqual(results.map(([,value]) => value.status), ['error','safe']);
});

test('empty lists complete without a worker; failed startup never reports untested levels as passed', async () => {
  const empty = fixture();
  assert.equal((await empty.checker.run([])).completed, 0);
  assert.equal(empty.workers.length, 0);
  const checker = createTargetPathBatchChecker({ workerFactory() { throw new Error('unavailable'); } });
  const result = await checker.run(jobs());
  assert.equal(result.phase, 'error');
  assert.equal(result.completed, 1);
  assert.equal(result.errors, 1);
  assert.equal(result.passed, 0);
});
