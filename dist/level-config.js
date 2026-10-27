import { countTargetLengthPlan } from "./level-generator.js";

export const CONFIG_LIST_STORAGE_KEY = "fangge.level-config-list.v1";
export const MAX_CONFIG_ROWS = 1500;
export const MAX_TARGET_PLAN_SLOTS = 1000;
export const TARGET_LENGTH_OPTIONS = { short: "短词 · 3 字母", medium: "中词 · 4 字母", long: "长词 · 5 字母及以上" };
export const CONFIG_NUMBER_FIELDS = {
  rows: { label: "行数", min: 2, max: 3 },
  columns: { label: "列数", min: 3, max: 5 },
  targetCount: { label: "目标数量", min: 1 },
  initialMaxWordLength: { label: "初始词最长", min: 1 },
  maxWordLength: { label: "最长单词长度", min: 1 },
  initialForwardProbability: { label: "初始正向概率", min: 0, max: 100 },
  targetDuplicateRange: { label: "目标词查重", min: 0 },
  extraDuplicateRange: { label: "额外词查重", min: 0 },
};
export const CONFIG_FILTER_OPTIONS = {
  scope: [1, 2, 3, 4], emotion: [-2, -1, 0, 1, 2], abbreviation: [0, 1], rarityLevel: [1, 2, 3, 4, 5],
};

export function validateConfigNumber(field, value) {
  const rule = CONFIG_NUMBER_FIELDS[field];
  if (!rule || !Number.isSafeInteger(value) || value < rule.min || (rule.max !== undefined && value > rule.max)) {
    throw new Error(`${rule?.label ?? "配置值"}需为${rule?.max !== undefined ? `${rule.min}–${rule.max}` : `${rule?.min ?? 0} 及以上`}的整数。`);
  }
}

export function resizeTargetPlan(plan, targetCount) {
  validateConfigNumber("targetCount", targetCount);
  if (plan === null) return null;
  if (targetCount > MAX_TARGET_PLAN_SLOTS) throw new Error(`逐个配置最多支持 ${MAX_TARGET_PLAN_SLOTS} 个目标词。`);
  return Array.from({ length: targetCount }, (_, index) => plan[index] ?? Object.keys(TARGET_LENGTH_OPTIONS)[index % 3]);
}

export function validateLevelConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("关卡配置无效。");
  for (const key of Object.keys(CONFIG_NUMBER_FIELDS)) validateConfigNumber(key, config[key]);
  if (config.targetLengthPlan !== null && (!Array.isArray(config.targetLengthPlan) || config.targetLengthPlan.length > MAX_TARGET_PLAN_SLOTS)) {
    throw new Error(`逐个词长配置需为不超过 ${MAX_TARGET_PLAN_SLOTS} 项的列表。`);
  }
  countTargetLengthPlan(config.targetCount, config.targetLengthPlan);
  if (!config.filters || typeof config.filters !== "object" || Array.isArray(config.filters)) throw new Error("词库筛选无效。");
  for (const [key, values] of Object.entries(config.filters)) {
    const allowed = CONFIG_FILTER_OPTIONS[key];
    if (!allowed || !Array.isArray(values) || values.some(value => !allowed.includes(value))) throw new Error("词库筛选值无效。");
  }
  return config;
}

export function patchLevelConfigs(records, selectedIds, patch) {
  const allowed = [...Object.keys(CONFIG_NUMBER_FIELDS), "targetLengthPlan", "filters"];
  if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error("配置字段无效。");
  const ids = new Set(selectedIds);
  return records.map(record => {
    if (!ids.has(record.id)) return record;
    const config = { ...structuredClone(record.config), ...structuredClone(patch) };
    if (Object.hasOwn(patch, "targetCount") && !Object.hasOwn(patch, "targetLengthPlan")) {
      config.targetLengthPlan = resizeTargetPlan(config.targetLengthPlan, config.targetCount);
    }
    validateLevelConfig(config);
    return { ...record, config };
  });
}

export function validateConfigList(records) {
  if (!Array.isArray(records) || records.length > MAX_CONFIG_ROWS) throw new Error(`配置列表最多支持 ${MAX_CONFIG_ROWS} 关。`);
  const ids = new Set();
  records.forEach((record, index) => {
    if (typeof record?.id !== "string" || !record.id || ids.has(record.id)) throw new Error("配置列表编号无效。");
    ids.add(record.id);
    try { validateLevelConfig(record.config); } catch (error) {
      throw new Error(`第 ${index + 1} 关：${error.message}`);
    }
  });
  return records;
}

export function readConfigList(storage = localStorage) {
  const raw = storage.getItem(CONFIG_LIST_STORAGE_KEY);
  if (raw === null) return null;
  const saved = JSON.parse(raw);
  if (saved?.version !== 1) throw new Error("关卡配置列表格式无效。");
  return validateConfigList(saved.records);
}

export function hasConfigPreset(presetId, storage = localStorage) {
  const raw = storage.getItem(CONFIG_LIST_STORAGE_KEY);
  if (raw === null) return false;
  try { return JSON.parse(raw)?.presetId === presetId; } catch { return false; }
}

export function saveConfigList(records, storage = localStorage, presetId) {
  validateConfigList(records);
  if (presetId === undefined) {
    try { presetId = JSON.parse(storage.getItem(CONFIG_LIST_STORAGE_KEY))?.presetId; } catch { /* An explicit save can replace invalid old data. */ }
  }
  storage.setItem(CONFIG_LIST_STORAGE_KEY, JSON.stringify({ version: 1, records,
    ...(typeof presetId === "string" ? { presetId } : {}) }));
}

export function installConfigPreset(preset, storage = localStorage) {
  if (!preset || typeof preset.id !== "string" || !preset.id) throw new Error("参考配置标识无效。");
  if (hasConfigPreset(preset.id, storage)) return false;
  saveConfigList(preset.records, storage, preset.id);
  return true;
}
