import { validateConfigList } from "./level-config.js";
import { createDuplicateCheck, prepareGeneration, configDestination, reserveFutureTargets } from "./level-rules.js";

export function createBatchRunner({ getHistory, generate, save, onSaved = () => {}, onUpdate = () => {} }) {
  let controller = null;
  let state = null;

  function publish(update) {
    state = { ...state, ...update };
    onUpdate({ ...state });
  }

  return {
    stop() {
      if (!controller || controller.signal.aborted) return;
      controller.abort();
      publish({ phase: "stopping" });
    },
    async run(jobs, allConfigs = jobs) {
      if (controller) throw new Error("已有配置列表正在运行。");
      validateConfigList(jobs);
      validateConfigList(allConfigs);
      if (!jobs.length) throw new Error("请先选择要运行的配置。");
      const queue = structuredClone(jobs);
      const configurations = structuredClone(allConfigs);
      controller = new AbortController();
      const { signal } = controller;
      state = { phase: "loading", total: queue.length, completed: 0, position: queue[0].position,
        configId: queue[0].id, attempts: 0, workers: 0, error: "" };
      publish({});
      try {
        const history = [...await getHistory()];
        for (const [jobIndex, job] of queue.entries()) {
          if (signal.aborted) break;
          publish({ phase: "generating", position: job.position, configId: job.id, attempts: 0, workers: 0 });
          // Replacement follows the visible list order, including imported or
          // manually reordered records with older sourceConfig annotations.
          const precedingHistory = history.map((record, index) => ({ ...record, level: { ...record.level,
            sourceConfig: { ...record.level.sourceConfig, position: index + 1 } } }));
          const duplicateCheck = createDuplicateCheck(precedingHistory, {
            target: job.config.targetDuplicateRange, extra: job.config.extraDuplicateRange,
          }, job.position);
          const planned = queue.slice(jobIndex + 1);
          const source = job.listId ? { listId: job.listId, id: job.id, configId: job.id, position: job.position, ...(job.levelId ? { levelId: job.levelId } : {}) } : null;
          const prepared = source || job.config.generationRules ? prepareGeneration(history, null, job.config, source, configurations, planned) :
            { config: { ...job.config,
              reservedTargetWords: reserveFutureTargets(history, { id: job.id, position: job.position }, configurations, planned)
                .filter(word => !(job.config.fixedWords ?? []).includes(word)),
              minimumWordLength: Math.max(job.position === 1 ? 2 : 3, job.config.minimumWordLength ?? 2) }, duplicateCheck };
          const level = await generate(prepared.config, prepared.duplicateCheck, {
            signal,
            onProgress: ({ attempts, workers }) => {
              if (!signal.aborted) publish({ attempts, ...(Number.isInteger(workers) ? { workers } : {}) });
            },
          });
          if (signal.aborted) break;
          if (!level) throw new Error("生成器没有返回关卡。");
          publish({ phase: "saving" });
          const record = await save({ ...level, sourceConfig: source ?? { id: job.id, position: job.position } }, job.position);
          // A save already in progress is allowed to commit when stopping. Only
          // committed results enter history and advance the completed count.
          if (source) {
            const { index, existing } = configDestination(history, source);
            history.splice(index, existing ? 1 : 0, record);
          } else {
          const replaceIndex = job.config.generationRules
            ? history.findLastIndex(previous => (previous.level.generationRules?.position ?? previous.level.sourceConfig?.position) === job.position)
            : job.position <= history.length ? job.position - 1
              : history.findLastIndex(previous => previous.level.sourceConfig?.position === job.position);
          if (replaceIndex >= 0) history[replaceIndex] = record;
          else history.push(record);
          }
          state.completed += 1;
          onSaved(record, job);
          publish({ phase: "saved" });
        }
        publish({ phase: state.completed === state.total ? "complete" : "stopped" });
      } catch (error) {
        publish({ phase: "error", error: error.message || "运行失败，请重试。" });
      } finally {
        controller = null;
      }
      return { ...state };
    },
  };
}

export function formatBatchState(state) {
  if (!state) return "";
  const progress = `已保存 ${state.completed} / ${state.total} 关`;
  const position = String(state.position).padStart(3, "0");
  const parallel = state.workers ? ` · ${state.workers} 路并行` : "";
  switch (state.phase) {
    case "loading": return `${progress} · 准备中`;
    case "generating": return `${progress} · 正在生成配置 ${position}${parallel}${state.attempts ? ` · 已尝试 ${state.attempts} 次` : ""}`;
    case "saving": return `${progress} · 正在保存配置 ${position}`;
    case "saved": return `${progress} · 配置 ${position} 已保存`;
    case "stopping": return `${progress} · 停止中`;
    case "stopped": return `${progress} · 已停止`;
    case "complete": return `${progress} · 全部完成`;
    case "error": return `${progress} · 配置 ${position}：${state.error}`;
    default: return progress;
  }
}
