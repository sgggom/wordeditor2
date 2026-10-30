import assert from "node:assert/strict";
import test from "node:test";
import { createTargetPathMonitor } from "../dist/target-path-monitor.js";
const board = () => ({ rows: 2, columns: 2, cells: [..."ABAB"].map(letter => ({ letter, count: 1 })),
  targetWords: [{ word: "AB" }, { word: "BA" }], extraWords: [{ word: "ABAB" }] });
function fixture() {
  const output = { dataset: {}, hidden: true }, workers = [];
  const monitor = createTargetPathMonitor(output, { workerFactory: () => {
    const worker = { terminated: false, postMessage(data) { this.data = data; }, terminate() { this.terminated = true; } };
    workers.push(worker); return worker;
  } });
  return { output, workers, monitor };
}
test("only target data is sent, repeated renders reuse analysis, and success waits for the worker", () => {
  const { output, workers, monitor } = fixture();
  monitor.update(board());
  assert.equal(output.dataset.pathStatus, "checking"); assert.equal(output.hidden, false);
  assert.equal(Object.hasOwn(workers[0].data, "extraWords"), false);
  monitor.update({ ...board(), extraWords: [{ word: "OTHER" }] }); assert.equal(workers.length, 1);
  workers[0].onmessage({ data: { result: { allChoicesComplete: true, solvable: true } } });
  assert.equal(output.dataset.pathStatus, "safe"); assert.equal(output.hidden, true);
  assert.equal(workers[0].terminated, true);
});
test("obsolete workers cannot overwrite a newer check even when the user returns to the same board", () => {
  const { output, workers, monitor } = fixture();
  monitor.update(board());
  const changed = board(); changed.cells[0].count++;
  monitor.update(changed); monitor.update(board());
  assert.equal(workers[0].terminated, true); assert.equal(workers[1].terminated, true);
  workers[0].onmessage({ data: { result: { allChoicesComplete: true, solvable: true } } });
  assert.equal(output.dataset.pathStatus, "checking");
  workers[2].onmessage({ data: { error: "检测失败" } });
  assert.equal(output.dataset.pathStatus, "error"); assert.equal(output.hidden, false);
  monitor.destroy();
  workers[2].onmessage({ data: { result: { allChoicesComplete: true, solvable: true } } });
  assert.equal(output.dataset.pathStatus, "error");
});
test("actual deadlock examples display words and one-based grid coordinates, without blocking", () => {
  const { output, workers, monitor } = fixture(); monitor.update(board());
  workers[0].onmessage({ data: { result: { solvable: true, allChoicesComplete: false,
    counterexample: { moves: [{ word: "AB", path: [0, 1] }], remainingWords: ["BA"] } } } });
  assert.equal(output.hidden, false); assert.equal(output.dataset.pathStatus, "unsafe");
  assert.match(output.textContent, /本关存在问题/); assert.match(output.textContent, /已停止检查/);
  assert.match(output.title, /AB〔1,1→1,2〕/); assert.match(output.title, /剩余目标 BA/);
  assert.match(output.textContent, /仅作警告/);
  monitor.update(null); assert.equal(output.hidden, true); assert.equal(output.dataset.pathStatus, "idle");
});
