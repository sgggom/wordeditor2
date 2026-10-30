export function createTargetPathMonitor(output, { placedOnly = false,
  workerFactory = () => new Worker(new URL("./target-path-worker.js", import.meta.url), { type: "module" }) } = {}) {
  let worker = null, currentKey = null, revision = 0;
  function stop() { worker?.terminate(); worker = null; }
  function update(level) {
    const snapshot = level ? { rows: level.rows, columns: level.columns, disabledCells: level.disabledCells ?? [],
      cells: level.cells.map(({ letter, count, disabled }) => ({ letter, count, disabled: Boolean(disabled) })),
      targetWords: level.targetWords.map(({ word }) => ({ word })) } : null;
    const key = JSON.stringify(snapshot);
    if (key === currentKey) return;
    stop(); currentKey = key;
    const token = ++revision;
    output.title = "";
    if (!snapshot?.targetWords.length) { output.hidden = true; output.dataset.pathStatus = "idle"; return; }
    output.hidden = false;
    output.dataset.pathStatus = "checking";
    output.textContent = placedOnly ? "正在检测已摆放目标的全部路径…" : "正在检测目标答案的全部路径…";
    function fail(message) {
      if (token !== revision) return;
      output.hidden = false; output.dataset.pathStatus = "error";
      output.textContent = `目标路径检测未完成：${message}；不影响生成。`;
      stop();
    }
    try {
      worker = workerFactory();
      worker.onerror = () => fail("请刷新后重试");
      worker.onmessage = ({ data }) => {
        if (token !== revision) return;
        if (data.error) { fail(data.error); return; }
        const result = data.result;
        output.dataset.pathStatus = result.allChoicesComplete ? "safe" : "unsafe";
        output.hidden = result.allChoicesComplete;
        const prefix = placedOnly ? "已摆放目标路径警告" : "目标路径警告";
        if (!result.solvable) output.textContent = `${prefix}：本关存在问题，目标答案无法按格子次数全部完成；仅作警告，不影响生成。`;
        else if (result.counterexample) {
          const moves = result.counterexample.moves.map(move => `${move.word}〔${move.path.map(cell =>
            `${Math.floor(cell / snapshot.columns) + 1},${cell % snapshot.columns + 1}`).join("→")}〕`).join(" → ");
          const remaining = result.counterexample.remainingWords.join("、");
          output.textContent = `${prefix}：本关存在问题，发现一条会导致无解的目标作答路径，已停止检查；仅作警告，不影响生成。`;
          output.title = `按 ${moves} 作答后，${remaining ? `剩余目标 ${remaining} 无法全部完成` : "仍有格子次数未清零"}。`;
        }
        if (!output.title) output.title = output.hidden ? "所有合法目标路径和作答顺序均可完成" : output.textContent;
        stop();
      };
      worker.postMessage(snapshot);
    } catch (error) { fail(error.message); }
  }
  return { update, destroy() { revision++; stop(); currentKey = null; } };
}
