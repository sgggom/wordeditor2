import { importGameLevels } from "./level-import.js";

self.onmessage = async ({ data }) => {
  try {
    const records = await Promise.all(["required-words.json", "extra-words.json"].map(async (file, index) => {
      const response = await fetch(new URL(`./data/${file}`, import.meta.url));
      if (!response.ok) throw new Error("词库读取失败，请重试。");
      return (await response.json()).map(record => ({ ...record, onlyExtra: index === 1 }));
    }));
    self.postMessage({ levels: importGameLevels(JSON.parse(data.replace(/^\uFEFF/, "")), records.flat()) });
  } catch (error) {
    self.postMessage({ error: error.message || "无法读取关卡文件。" });
  }
};
