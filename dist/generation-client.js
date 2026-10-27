export function detectedProcessorCount(cores = globalThis.navigator?.hardwareConcurrency) {
  return Number.isSafeInteger(cores) && cores > 0 ? cores : 1;
}

export function defaultGenerationWorkers(cores = globalThis.navigator?.hardwareConcurrency) {
  return Math.max(1, detectedProcessorCount(cores) - 1);
}

export function createGenerationClient({ workerCount = defaultGenerationWorkers(),
  workerFactory = () => new Worker("./generator-worker.js", { type: "module" }) } = {}) {
  if (!Number.isSafeInteger(workerCount) || workerCount < 1) throw new Error("并行数需为正整数。");
  let lanes = [];
  let requestId = 0;
  let pending = null;

  function dropLane(lane) {
    lane.worker.terminate();
    lanes = lanes.filter(entry => entry !== lane);
  }

  function terminateAll() {
    for (const lane of lanes) lane.worker.terminate();
    lanes = [];
  }

  function finish(run, error, level) {
    if (pending !== run) return;
    pending = null;
    run.signal.removeEventListener("abort", run.cancel);
    // Keep dictionaries and route caches warm. Old request IDs are ignored.
    for (const lane of [...lanes]) {
      try { lane.worker.postMessage({ type: "cancel", requestId: run.id }); }
      catch { dropLane(lane); }
    }
    if (error) run.reject(error);
    else run.resolve(level);
  }

  function progress(run) {
    if (pending !== run) return;
    const attempts = [...run.attempts.values()].reduce((sum, value) => sum + value, 0);
    try { run.onProgress({ attempts, workers: run.active.size }); }
    catch (error) { finish(run, error); }
  }

  function failLane(run, lane, error, terminate = false) {
    if (pending !== run || !run.active.has(lane)) return;
    run.active.delete(lane);
    if (terminate) dropLane(lane);
    if (!run.active.size) finish(run, error);
    else progress(run);
  }

  function addLane() {
    const lane = { worker: workerFactory() };
    lanes.push(lane);
    lane.worker.onmessage = ({ data }) => {
      const run = pending;
      if (!run || data.requestId !== run.id || !run.active.has(lane)) return;
      if (data.progress) {
        const attempts = data.progress.attempts;
        if (Number.isSafeInteger(attempts) && attempts >= 0) {
          run.attempts.set(lane, Math.max(run.attempts.get(lane) ?? 0, attempts));
          progress(run);
        }
      } else if (data.error) {
        failLane(run, lane, new Error(data.error));
      } else if (data.level) {
        finish(run, null, data.level);
      }
    };
    lane.worker.onerror = event => {
      event.preventDefault();
      if (!lanes.includes(lane)) return;
      if (pending?.active.has(lane)) failLane(pending, lane, new Error("生成线程异常，请重试。"), true);
      else dropLane(lane);
    };
  }

  return {
    workerCount,
    generate(config, duplicateCheck, { signal, onProgress = () => {} }) {
      if (pending) return Promise.reject(new Error("生成器正在处理上一关。"));
      if (signal.aborted) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const run = { id: ++requestId, signal, onProgress, resolve, reject, active: new Set(), attempts: new Map() };
        run.cancel = () => { terminateAll(); finish(run, null, null); };
        pending = run;
        signal.addEventListener("abort", run.cancel, { once: true });
        let startupError;
        while (lanes.length < workerCount) {
          try { addLane(); } catch (error) { startupError = error; break; }
        }
        run.active = new Set(lanes);
        if (!run.active.size) { finish(run, startupError ?? new Error("无法启动生成线程。")); return; }
        if (signal.aborted) { run.cancel(); return; }
        progress(run);
        for (const lane of [...run.active]) {
          if (pending !== run) break;
          try { lane.worker.postMessage({ ...config, duplicateCheck, requestId: run.id, type: "generate" }); }
          catch (error) { failLane(run, lane, error, true); }
        }
      });
    },
    close() {
      if (pending) pending.cancel();
      else terminateAll();
    },
  };
}
