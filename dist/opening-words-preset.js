import { CONFIG_LIST_STORAGE_KEY, validateConfigList } from "./level-config.js";
import { countTargetLengthPlan, targetLengthGroup } from "./level-generator.js";

export const OPENING_WORDS_PRESET_ID = "opening-fixed-words-20261028-v1";
export const OPENING_FIXED_WORDS = [
  ["MAP", "SUN"], ["DOG", "HAT"], ["BOX", "FOX"], ["COW", "PIG"], ["FAN", "FAT"],
  ["BUG", "BUS"], ["ART", "CAR", "CAT"], ["NET", "PEN", "TEN"], ["MAP", "PAL", "LAMP"], ["BED", "RED", "READ"],
  ["EAT", "HAT", "HEAT"], ["BIG", "BIN", "PIG"], ["BUN", "RUN", "SUN"], ["SEA", "TEA", "SEAT"], ["FIT", "HIT", "FISH"],
  ["BAT", "TAB", "BOAT"], ["EAT", "CAKE", "TAKE"], ["RAN", "RAIN", "TRAIN"], ["HOT", "THE", "HOME"], ["LOVE", "OVER", "ROLE"],
];

function fitLengthPlan(config, words) {
  if (config.targetLengthPlan === null) return null;
  const plan = [...config.targetLengthPlan];
  const counts = countTargetLengthPlan(config.targetCount, plan);
  const groups = ["short", "medium", "long"];
  const needed = { short: 0, medium: 0, long: 0 };
  for (const word of words) needed[targetLengthGroup(word.length)]++;
  for (const group of groups) {
    while (counts[group] < needed[group]) {
      const groupIndex = groups.indexOf(group);
      const donor = groups.filter(key => counts[key] > needed[key]).sort((a, b) =>
        Math.abs(groups.indexOf(a) - groupIndex) - Math.abs(groups.indexOf(b) - groupIndex) ||
        (counts[b] - needed[b]) - (counts[a] - needed[a]))[0];
      if (!donor) throw new Error("目标数量不足以容纳指定词。");
      const index = groupIndex < groups.indexOf(donor) ? plan.indexOf(donor) : plan.lastIndexOf(donor);
      plan[index] = group; counts[donor]--; counts[group]++;
    }
  }
  return plan;
}

export function configureOpeningWords(records) {
  if (!Array.isArray(records) || records.length < OPENING_FIXED_WORDS.length) throw new Error("配置列表不足 20 关，无法应用前 20 关指定词。");
  const updated = records.map((record, index) => {
    if (index >= OPENING_FIXED_WORDS.length) return record;
    const words = OPENING_FIXED_WORDS[index];
    const config = structuredClone(record.config);
    if (config.targetCount < words.length) throw new Error(`第 ${index + 1} 关目标数量少于 ${words.length} 个指定词，请先增加目标数量。`);
    const longest = Math.max(...words.map(word => word.length));
    config.fixedWords = [...words];
    config.fixedLayout = null;
    config.fixedWordExemptions = [...words];
    config.initialMaxWordLength = Math.max(config.initialMaxWordLength, longest);
    config.maxWordLength = Math.max(config.maxWordLength, longest);
    config.targetLengthPlan = fitLengthPlan(config, words);
    return { ...record, config };
  });
  return validateConfigList(updated);
}

export function installOpeningWordsPreset(storage = localStorage) {
  const saved = JSON.parse(storage.getItem(CONFIG_LIST_STORAGE_KEY));
  if (saved?.openingWordsPresetId === OPENING_WORDS_PRESET_ID) return false;
  if (saved?.version !== 1) throw new Error("关卡配置列表尚未就绪。");
  const records = configureOpeningWords(saved.records);
  storage.setItem(CONFIG_LIST_STORAGE_KEY, JSON.stringify({ ...saved, records, openingWordsPresetId: OPENING_WORDS_PRESET_ID }));
  return true;
}
