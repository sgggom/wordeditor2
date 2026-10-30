import { CONFIG_FILTER_OPTIONS } from "./level-config.js";

export const GLOBAL_FILTER_STORAGE_KEY = "fangge.level-word-filters.v1";
const listeners = new Set();
let current;

function normalize(filters) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return {};
  const result = {};
  for (const [key, values] of Object.entries(filters)) {
    const options = CONFIG_FILTER_OPTIONS[key];
    if (!options || !Array.isArray(values) || values.some(value => !options.includes(value))) return {};
    const selected = [...new Set(values)].sort((a, b) => a - b);
    if (selected.length < options.length) result[key] = selected;
  }
  return result;
}

export function getGlobalWordFilters() {
  if (current === undefined) {
    try { current = normalize(JSON.parse(localStorage.getItem(GLOBAL_FILTER_STORAGE_KEY))); }
    catch { current = {}; }
  }
  return structuredClone(current);
}

export function setGlobalWordFilters(filters) {
  const next = normalize(filters);
  if (JSON.stringify(next) === JSON.stringify(getGlobalWordFilters())) return;
  current = next;
  try { localStorage.setItem(GLOBAL_FILTER_STORAGE_KEY, JSON.stringify(current)); } catch {}
  for (const listener of listeners) listener(getGlobalWordFilters());
}

export function subscribeGlobalWordFilters(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
