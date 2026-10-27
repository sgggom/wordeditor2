import { createGenerator, generateUntilComplete } from "./level-generator.js";

let generatorPromise;
let activeRun;

function loadGenerator() {
  if (!generatorPromise) {
    generatorPromise = Promise.all(["required-words.json", "extra-words.json"].map(async file => {
      const response = await fetch(new URL(`./data/${file}`, import.meta.url));
      if (!response.ok) throw new Error("词库加载失败，请重试。");
      return response.json();
    }))
      .then(([normalRecords, onlyExtraRecords]) => createGenerator(normalRecords, onlyExtraRecords))
      .catch(error => {
        generatorPromise = null;
        throw error;
      });
  }
  return generatorPromise;
}

self.onmessage = async ({ data }) => {
  if (data.type === "cancel") {
    if (activeRun?.requestId === data.requestId) activeRun = null;
    return;
  }
  const { requestId, rows, columns, targetCount, targetLengthPlan, initialMaxWordLength, maxWordLength, initialForwardProbability, filters, duplicateCheck } = data;
  const run = { requestId };
  activeRun = run;
  try {
    const generator = await loadGenerator();
    const options = { rows, columns, targetCount, targetLengthPlan, initialMaxWordLength, maxWordLength, initialForwardProbability,
      initialRarityLevel: 1, minimumEmotionScore: 0, filters, duplicateCheck };
    const level = await generateUntilComplete(generator, options, {
      isCurrent: () => activeRun === run,
      onProgress: progress => self.postMessage({ requestId, progress }),
    });
    if (level && activeRun === run) self.postMessage({ requestId, level });
  } catch (error) {
    if (activeRun === run) self.postMessage({ requestId, error: error.message || "生成失败，请重试。" });
  }
};
