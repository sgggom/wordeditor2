import { createDuplicateCheck, findDuplicateWords } from './level-rules.js';
import { validateLevelConfig } from './level-config.js';

export function repairConfigurations(records, savedConfigs = [], ranges = { target: 0, extra: 0 }, { requireLinked = false } = {}) {
  const byId = new Map(savedConfigs.map(record => [record.id, record]));
  const aligned = savedConfigs.length === records.length && records.every((record, index) => {
    const config = savedConfigs[index].config, level = record.level;
    return (!level.sourceConfig?.listId || savedConfigs[index].listId === level.sourceConfig.listId) && config.rows === level.rows && config.columns === level.columns &&
      (config.fixedWords ?? []).every(word => level.targetWords.some(entry => entry.word === word));
  });
  return records.map((record, index) => {
    const level = record.level;
    const candidate = byId.get(level.sourceConfig?.configId ?? level.sourceConfig?.id);
    const linked = (candidate && (!level.sourceConfig?.listId || candidate.listId === level.sourceConfig.listId) ? candidate : null) ?? (aligned ? savedConfigs[index] : null);
    if (!linked && requireLinked) {
      const error = new Error('当前游戏文件未包含完整生成配置。请读取对应配置表后继续重跑；原关卡已保留。');
      error.code = 'MISSING_REPAIR_CONFIG';
      throw error;
    }
    const config = linked ? structuredClone(linked.config) : {
      rows: level.rows, columns: level.columns, disabledCells: level.disabledCells ?? [],
      initialForwardProbability: level.initialForwardProbability ?? 50,
      fixedWords: level.fixedWords ?? [], fixedLayout: level.fixedLayout ?? null,
      fixedWordExemptions: level.fixedWordExemptions ?? [], filters: level.filters ?? {},
      desiredTargetCount: level.desiredTargetCount ?? level.targetWords.length,
      targetDuplicateRange: level.duplicateCheck?.target?.range ?? ranges.target,
      extraDuplicateRange: level.duplicateCheck?.extra?.range ?? ranges.extra,
    };
    validateLevelConfig(config);
    return { id: linked?.id ?? level.sourceConfig?.id ?? `repair-${record.id}`, position: index + 1, config };
  });
}

export function createTargetPathCheckClient({ workerFactory = () => new Worker(new URL('./target-path-worker.js', import.meta.url), { type: 'module' }) } = {}) {
  let worker = null, pending = null;
  function drop() { worker?.terminate(); worker = null; }
  function finish(error, result) {
    if (!pending) return;
    const request = pending; pending = null;
    request.signal.removeEventListener('abort', request.cancel);
    if (error) request.reject(error); else request.resolve(result);
  }
  return {
    check(level, { signal }) {
      if (pending) return Promise.reject(new Error('已有无解检测正在运行。'));
      if (signal.aborted) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, signal, cancel() { drop(); finish(null, null); } };
        signal.addEventListener('abort', pending.cancel, { once: true });
        try {
          if (!worker) {
            const current = workerFactory(); worker = current;
            current.onmessage = ({ data }) => { if (worker === current) finish(data.error ? new Error(data.error) : !data.result ? new Error('无解检测没有返回结果。') : null, data.result); };
            current.onerror = () => { if (worker === current) { drop(); finish(new Error('无解检测线程异常。')); } };
          }
          // The analyzer only reads board counts and target answers.
          worker.postMessage({ rows: level.rows, columns: level.columns, disabledCells: level.disabledCells,
            cells: level.cells, targetWords: level.targetWords.map(({ word }) => ({ word })) });
        } catch (error) { drop(); finish(error); }
      });
    },
    close() { drop(); finish(null, null); },
  };
}

export function createTargetPathRepairRunner({ generate, check, save, onSaved = () => {}, onUpdate = () => {} }) {
  let controller = null, state;
  function publish(update) { state = { ...state, ...update }; onUpdate({ ...state }); }
  return {
    stop() { if (controller && !controller.signal.aborted) { controller.abort(); publish({ phase: 'stopping' }); } },
    async run(records, configs, problemIds) {
      if (controller) throw new Error('问题关卡正在重新生成。');
      const history = structuredClone(records), configurations = structuredClone(configs), problems = new Set(problemIds);
      const jobs = history.flatMap((record, index) => problems.has(record.id) ? [{ record, index }] : []);
      controller = new AbortController(); const { signal } = controller;
      state = { phase: 'generating', total: jobs.length, completed: 0, position: 0, id: null, attempts: 0, error: '' };
      try {
        for (const { record, index } of jobs) {
          if (signal.aborted) break;
          const job = configurations[index], config = job.config;
          const preceding = history.slice(0,index);
          const duplicateCheck = createDuplicateCheck(preceding, { target: config.targetDuplicateRange, extra: config.extraDuplicateRange });
          const reserved = new Set();
          // Passed later levels are immutable. Avoid blocking their target windows;
          // later problem levels still reserve their explicit fixed words.
          for (let next = index + 1; next < history.length; next++) {
            const future = configurations[next].config;
            if (next - index > future.targetDuplicateRange) continue;
            const words = problems.has(history[next].id) ? future.fixedWords ?? [] : history[next].level.targetWords.map(entry => entry.word);
            for (const word of words) reserved.add(word);
          }
          if ((config.fixedWords ?? []).some(word => reserved.has(word) && !(config.fixedWordExemptions ?? []).includes(word))) {
            throw new Error(`第 ${index + 1} 关固定词与后续关卡的目标词查重要求冲突，请调整配置。`);
          }
          let attempt = 0;
          while (!signal.aborted) {
            publish({ phase: 'generating', position: index + 1, id: record.id, attempts: ++attempt });
            const generated = await generate({ ...config, reservedTargetWords: [...reserved], minimumWordLength: (record.level.sourceConfig?.listId ? record.level.sourceConfig.position === 1 : index === 0) ? 2 : 3 }, duplicateCheck, { signal });
            if (signal.aborted) break;
            if (!generated) throw new Error('生成器没有返回关卡。');
            if (findDuplicateWords(generated, duplicateCheck).target.length) throw new Error('新关卡未通过目标词查重，原关卡已保留。');
            publish({ phase: 'checking' });
            const result = await check(generated, { signal });
            if (signal.aborted) break;
            if (!result) throw new Error('无解检测没有返回结果。');
            if (!result.allChoicesComplete || !result.solvable) continue;
            publish({ phase: 'saving' });
            const level = { ...generated, name: record.level.name ?? generated.name,
              sourceConfig: { ...record.level.sourceConfig, id: job.id, position: record.level.sourceConfig?.listId ? record.level.sourceConfig.position : index + 1 } };
            const saved = await save(level, record, index + 1);
            history[index] = saved;
            onSaved(saved, result, index + 1);
            publish({ completed: state.completed + 1 });
            break;
          }
        }
        publish({ phase: state.completed === state.total ? 'complete' : 'stopped' });
      } catch (error) { publish({ phase: 'error', error: error.message || '问题关卡重新生成失败。' }); }
      finally { controller = null; }
      return { ...state };
    },
  };
}
