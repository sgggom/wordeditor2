import { targetPathSnapshot } from './target-path-monitor.js';

export function createTargetPathBatchChecker({ onUpdate = () => {}, onResult = () => {},
  workerFactory = () => new Worker(new URL('./target-path-worker.js', import.meta.url), { type: 'module' }) } = {}) {
  let active = null;
  function publish(run) { onUpdate({ ...run.state }); }
  function finish(run, phase) {
    if (active !== run) return;
    active = null;
    run.worker?.terminate();
    run.state.phase = phase;
    publish(run);
    run.resolve({ ...run.state });
  }
  function stop() { if (active) finish(active, 'stopped'); }
  return {
    stop,
    run(records) {
      stop();
      const jobs = records.map((record, index) => {
        const snapshot = targetPathSnapshot(record.level);
        return { id: record.id, position: index + 1, snapshot, key: JSON.stringify(snapshot) };
      });
      return new Promise(resolve => {
        const run = { jobs, resolve, worker: null, state: { phase: 'running', total: jobs.length,
          completed: 0, passed: 0, issues: 0, errors: 0, position: 0, id: null, key: null } };
        active = run;
        function receive(data) {
          if (active !== run) return;
          const job = jobs[run.state.completed];
          const error = data.error || (!data.result ? '检测线程没有返回结果' : '');
          const status = error ? 'error' : data.result.allChoicesComplete ? 'safe' : 'unsafe';
          run.state.completed++;
          run.state[error ? 'errors' : status === 'safe' ? 'passed' : 'issues']++;
          onResult(job, { key: job.key, status, ...(error ? { error } : { result: data.result }) });
          publish(run);
          next();
        }
        function next() {
          if (active !== run) return;
          const job = jobs[run.state.completed];
          if (!job) { finish(run, 'complete'); return; }
          Object.assign(run.state, { position: job.position, id: job.id, key: job.key });
          publish(run);
          try {
            if (!run.worker) {
              const worker = workerFactory();
              run.worker = worker;
              worker.onmessage = ({ data }) => { if (run.worker === worker) receive(data); };
              worker.onerror = () => {
                if (active !== run || run.worker !== worker) return;
                run.worker.terminate(); run.worker = null;
                receive({ error: '检测线程异常，请重试' });
              };
            }
            run.worker.postMessage(job.snapshot);
          } catch (error) {
            run.worker?.terminate(); run.worker = null;
            // A failed worker startup cannot check the remaining list.
            onResult(job, { key: job.key, status: 'error', error: error.message });
            run.state.errors++; run.state.completed++;
            finish(run, 'error');
          }
        }
        next();
      });
    },
  };
}
