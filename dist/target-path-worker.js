import { analyzeTargetPaths } from "./target-path-analysis.js";

self.onmessage = ({ data }) => {
  try { self.postMessage({ result: analyzeTargetPaths(data) }); }
  catch (error) { self.postMessage({ error: error.message || "目标路径检测失败" }); }
};
