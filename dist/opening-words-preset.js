import { readConfigLists, writeConfigLists, validateConfigList } from "./level-config.js";

export const OPENING_WORDS_PRESET_ID = "opening-fixed-words-20261028-v1";
export const OPENING_FIXED_WORDS = [
  ["MAP", "SUN"], ["DOG", "HAT"], ["BOX", "FOX"], ["COW", "PIG"], ["FAN", "FAT"],
  ["BUG", "BUS"], ["ART", "CAR", "CAT"], ["NET", "PEN", "TEN"], ["MAP", "PAL", "LAMP"], ["BED", "RED", "READ"],
  ["EAT", "HAT", "HEAT"], ["BIG", "BIN", "PIG"], ["BUN", "RUN", "SUN"], ["SEA", "TEA", "SEAT"], ["FIT", "HIT", "FISH"],
  ["BAT", "TAB", "BOAT"], ["EAT", "CAKE", "TAKE"], ["RAN", "RAIN", "TRAIN"], ["HOT", "THE", "HOME"], ["LOVE", "OVER", "ROLE"],
];

export function configureOpeningWords(records) {
  if (!Array.isArray(records) || records.length < OPENING_FIXED_WORDS.length) throw new Error("配置列表不足 20 关，无法应用前 20 关指定词。");
  const updated = records.map((record, index) => {
    if (index >= OPENING_FIXED_WORDS.length) return record;
    const words = OPENING_FIXED_WORDS[index];
    const config = structuredClone(record.config);
    config.fixedWords = [...words];
    config.fixedLayout = null;
    config.fixedWordExemptions = [...words];
    return { ...record, config };
  });
  return validateConfigList(updated);
}

export function installOpeningWordsPreset(storage = localStorage) {
  const library = readConfigLists(storage);
  if (!library) throw new Error("关卡配置列表尚未就绪。");
  const saved = library.lists.find(list => list.id === library.activeListId);
  if (saved.openingWordsPresetId === OPENING_WORDS_PRESET_ID) return false;
  saved.records = configureOpeningWords(saved.records);
  saved.openingWordsPresetId = OPENING_WORDS_PRESET_ID;
  writeConfigLists(library, storage);
  return true;
}
