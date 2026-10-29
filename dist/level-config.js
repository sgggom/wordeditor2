import { normalizeDisabledCells } from "./board-shape.js";
import { countTargetLengthPlan } from "./level-generator.js";
import { normalizeFixedWords, validateFixedWords, normalizeFixedLayout, normalizeFixedWordExemptions } from "./fixed-words.js";

export const CONFIG_LIST_STORAGE_KEY = "fangge.level-config-list.v1";
export const MAX_CONFIG_ROWS = 1500;
export const MAX_TARGET_PLAN_SLOTS = 1000;
export const TARGET_LENGTH_OPTIONS = { short: "短词 · 3 字母", medium: "中词 · 4 字母", long: "长词 · 5 字母及以上" };
export const CONFIG_NUMBER_FIELDS = {
  rows: { label: "行数", min: 2, max: 5 },
  columns: { label: "列数", min: 2, max: 5 },
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
  if (config.targetLimitsEnabled !== undefined && typeof config.targetLimitsEnabled !== "boolean") throw new Error("目标限制开关无效。");
  normalizeDisabledCells(config);
  const lengthCounts = countTargetLengthPlan(config.targetCount, config.targetLengthPlan);
  if (config.fixedWords !== undefined && !Array.isArray(config.fixedWords)) throw new Error("固定单词需为单词列表。");
  validateFixedWords(config, lengthCounts);
  normalizeFixedWordExemptions(config);
  normalizeFixedLayout(config);
  if (!config.filters || typeof config.filters !== "object" || Array.isArray(config.filters)) throw new Error("词库筛选无效。");
  for (const [key, values] of Object.entries(config.filters)) {
    const allowed = CONFIG_FILTER_OPTIONS[key];
    if (!allowed || !Array.isArray(values) || values.some(value => !allowed.includes(value))) throw new Error("词库筛选值无效。");
  }
  return config;
}

export function patchLevelConfigs(records, selectedIds, patch) {
  const allowed = [...Object.keys(CONFIG_NUMBER_FIELDS), "targetLengthPlan", "filters", "fixedWords", "fixedLayout", "fixedWordExemptions", "disabledCells", "targetLimitsEnabled"];
  if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error("配置字段无效。");
  const ids = new Set(selectedIds);
  return records.map(record => {
    if (!ids.has(record.id)) return record;
    const config = { ...structuredClone(record.config), ...structuredClone(patch) };
    if (Object.hasOwn(patch, "fixedWords")) config.fixedWords = normalizeFixedWords(config.fixedWords);
    if (Object.hasOwn(patch, "fixedWords") && !Object.hasOwn(patch, "fixedWordExemptions") && config.fixedWordExemptions) {
      config.fixedWordExemptions = config.fixedWordExemptions.filter(word => config.fixedWords.includes(word));
    }
    if (Object.hasOwn(patch, "fixedWordExemptions")) config.fixedWordExemptions = normalizeFixedWordExemptions(config);
    if (Object.hasOwn(patch, "fixedWords") && !Object.hasOwn(patch, "fixedLayout") && config.fixedLayout) config.fixedLayout = null;
    if (Object.hasOwn(patch, "fixedLayout")) config.fixedLayout = normalizeFixedLayout(config);
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

export function configJobsInRange(records, from, to) {
  if (!Array.isArray(records) || !records.length) throw new Error("关卡配置列表为空。");
  for (const [value, label] of [[from, "起始关"], [to, "结束关"]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > records.length) throw new Error(`${label}需为 1～${records.length} 的整数。`);
  }
  if (from > to) throw new Error("起始关不能大于结束关。");
  return records.slice(from - 1, to).map((record, index) => ({ ...record, position: from + index }));
}

export function validateConfigListName(name) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 40) throw new Error("列表名称需为 1～40 个字符。");
  return name.trim();
}

export function validateConfigLists(library) {
  if (library?.version !== 2 || !Array.isArray(library.lists) || !library.lists.length) throw new Error("配置列表管理数据无效。");
  const ids = new Set(), names = new Set();
  for (const list of library.lists) {
    if (typeof list?.id !== "string" || !list.id || ids.has(list.id)) throw new Error("配置列表编号无效。");
    const name = validateConfigListName(list.name);
    if (name !== list.name || names.has(name.toLowerCase())) throw new Error("列表名称重复或无效。");
    ids.add(list.id); names.add(name.toLowerCase());
    validateConfigList(list.records);
  }
  if (!ids.has(library.activeListId)) throw new Error("当前配置列表不存在。");
  return library;
}

export function readConfigLists(storage = localStorage) {
  const raw = storage.getItem?.(CONFIG_LIST_STORAGE_KEY) ?? null;
  if (raw === null) return null;
  const saved = JSON.parse(raw);
  if (saved?.version === 1) {
    return validateConfigLists({ version: 2, activeListId: "legacy-config-list", lists: [{
      id: "legacy-config-list", name: "原有关卡配置", records: saved.records,
      ...(typeof saved.presetId === "string" ? { presetId: saved.presetId } : {}),
      ...(typeof saved.openingWordsPresetId === "string" ? { openingWordsPresetId: saved.openingWordsPresetId } : {}),
    }] });
  }
  return validateConfigLists(saved);
}

export function writeConfigLists(library, storage = localStorage) {
  validateConfigLists(library);
  // One write commits both list contents and the active selection atomically.
  storage.setItem(CONFIG_LIST_STORAGE_KEY, JSON.stringify(library));
  return library;
}

export function migrateConfigLists(storage = localStorage) {
  const library = readConfigLists(storage);
  if (library && JSON.parse(storage.getItem(CONFIG_LIST_STORAGE_KEY)).version === 1) writeConfigLists(library, storage);
  return library;
}

export function readConfigList(storage = localStorage) {
  const library = readConfigLists(storage);
  return library?.lists.find(list => list.id === library.activeListId).records ?? null;
}

export function hasConfigPreset(presetId, storage = localStorage) {
  try { return readConfigLists(storage)?.lists.some(list => list.presetId === presetId) ?? false; }
  catch { return false; }
}

export function saveConfigList(records, storage = localStorage, presetId) {
  validateConfigList(records);
  const id = crypto.randomUUID();
  const library = readConfigLists(storage) ?? { version: 2, activeListId: id, lists: [{ id, name: "默认列表", records: [] }] };
  const current = library.lists.find(list => list.id === library.activeListId);
  current.records = structuredClone(records);
  if (presetId !== undefined) current.presetId = presetId;
  writeConfigLists(library, storage);
}

export function installConfigPreset(preset, storage = localStorage) {
  if (!preset || typeof preset.id !== "string" || !preset.id) throw new Error("参考配置标识无效。");
  const library = readConfigLists(storage);
  if (library?.lists.some(list => list.presetId === preset.id)) return false;
  validateConfigList(preset.records);
  let name = "参考竞品配置", number = 2;
  while (library?.lists.some(list => list.name === name)) name = `参考竞品配置 ${number++}`;
  const list = { id: crypto.randomUUID(), name, records: structuredClone(preset.records), presetId: preset.id,
    ...(typeof preset.openingWordsPresetId === "string" ? { openingWordsPresetId: preset.openingWordsPresetId } : {}) };
  writeConfigLists({ version: 2, activeListId: list.id, lists: [...(library?.lists ?? []), list] }, storage);
  return true;
}

export function changeConfigLists(action, storage = localStorage) {
  const library = readConfigLists(storage);
  if (!library) throw new Error("配置列表尚未就绪。");
  if (!["create", "switch", "rename", "copy", "delete", "save"].includes(action.type)) throw new Error("列表操作无效。");
  const find = id => {
    const list = library.lists.find(entry => entry.id === id);
    if (!list) throw new Error("该列表已被删除，请重新打开配置列表。");
    return list;
  };
  const target = action.type === "create" ? null : find(action.id);
  if (action.draft && !(action.type === "delete" && action.draft.id === action.id)) {
    const current = find(action.draft.id);
    validateConfigList(action.draft.records);
    current.records = structuredClone(action.draft.records);
    library.activeListId = current.id;
  }
  if (["create", "copy", "rename"].includes(action.type)) {
    const name = validateConfigListName(action.name);
    if (library.lists.some(list => list.name.toLowerCase() === name.toLowerCase() && !(action.type === "rename" && list.id === target.id))) {
      throw new Error("已有同名列表，请使用其他名称。");
    }
    if (action.type === "rename") target.name = name;
    else {
      const list = { id: crypto.randomUUID(), name, records: action.type === "copy"
        ? structuredClone(target.records).map(record => ({ ...record, id: crypto.randomUUID() })) : [] };
      library.lists.push(list);
      library.activeListId = list.id;
    }
  } else if (action.type === "switch" || action.type === "save") {
    library.activeListId = target.id;
  } else if (action.type === "delete") {
    if (library.lists.length === 1) throw new Error("至少需要保留一个列表。");
    const index = library.lists.indexOf(target);
    library.lists.splice(index, 1);
    if (library.activeListId === target.id) library.activeListId = library.lists[Math.min(index, library.lists.length - 1)].id;
  }
  return writeConfigLists(library, storage);
}
