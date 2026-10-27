import { validateConfigList } from "./level-config.js";
import { createDuplicateCheck } from "./level-rules.js";

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
    async run(jobs) {
      if (controller) throw new Error("已有配置列表正在运行。");
      validateConfigList(jobs);
      if (!jobs.length) throw new Error("请先选择要运行的配置。");
      const queue = structuredClone(jobs);
      controller = new AbortController();
      const { signal } = controller;
      state = { phase: "loading", total: queue.length, completed: 0, position: queue[0].position,
        configId: queue[0].id, attempts: 0, workers: 0, error: "" };
      publish({});
      try {
        const history = [...await getHistory()];
        for (const job of queue) {
          if (signal.aborted) break;
          publish({ phase: "generating", position: job.position, configId: job.id, attempts: 0, workers: 0 });
          const duplicateCheck = createDuplicateCheck(history, {
            target: job.config.targetDuplicateRange, extra: job.config.extraDuplicateRange,
          });
          const level = await generate(job.config, duplicateCheck, {
            signal,
            onProgress: ({ attempts, workers }) => {
              if (!signal.aborted) publish({ attempts, ...(Number.isInteger(workers) ? { workers } : {}) });
            },
          });
          if (signal.aborted) break;
          if (!level) throw new Error("生成器没有返回关卡。");
          publish({ phase: "saving" });
          const record = await save({ ...level, sourceConfig: { id: job.id, position: job.position } });
          // A save already in progress is allowed to commit when stopping. Only
          // committed results enter history and advance the completed count.
          history.push(record);
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
