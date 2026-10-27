import { countTargetLengthPlan, targetLengthGroup } from "./level-generator.js";
import { validateConfigList } from "./level-config.js";

export const REFERENCE_CONFIG_ID = "word-tiles-list0-20261027-v1";

export function referenceForwardProbability(position) {
  if (position <= 20) return 100;
  if (position <= 50) return 80;
  if (position <= 100) return 70;
  if (position <= 200) return Math.round(70 - (position - 100) * 0.2);
  return 50;
}

export function referenceFilters(position) {
  const unlocked = position <= 20 ? 1 : position <= 50 ? 2 : position <= 100 ? 3 : 4;
  return unlocked === 4 ? {} : { scope: Array.from({ length: unlocked }, (_, index) => index + 1) };
}

export function initialCoverageLimit(counts, initialMaxWordLength, maxWordLength) {
  const limit = Math.min(initialMaxWordLength, maxWordLength);
  return (limit >= 3 ? counts.short * 3 : 0) + (limit >= 4 ? counts.medium * 4 : 0) + (limit >= 5 ? counts.long * limit : 0);
}

export function buildList0ConfigPreset(sourceLevels) {
  if (!Array.isArray(sourceLevels) || sourceLevels.length !== 1500) throw new Error("list 0 原始数据需为完整的 1500 关。");
  const initialLengthExceptions = [];
  const longestWordExceptions = [];
  const records = sourceLevels.map((source, index) => {
    const position = index + 1;
    const lengths = source.target_words.map(entry => {
      if (typeof entry.word !== "string" || !/^[A-Z]+$/.test(entry.word)) throw new Error(`第 ${position} 关包含无效目标词。`);
      return entry.word.length;
    });
    const targetLengthPlan = lengths.map(targetLengthGroup);
    const counts = countTargetLengthPlan(lengths.length, targetLengthPlan);
    const originalMaximum = Math.max(...lengths);
    const maxWordLength = Math.min(8, originalMaximum);
    let initialMaxWordLength = source.width;
    const cells = source.width * source.height;
    if (initialCoverageLimit(counts, initialMaxWordLength, maxWordLength) < cells) {
      initialMaxWordLength += 1;
      initialLengthExceptions.push(position);
    }
    if (initialCoverageLimit(counts, initialMaxWordLength, maxWordLength) < cells) {
      throw new Error(`第 ${position} 关在放宽 1 字母后仍无法覆盖棋盘。`);
    }
    if (originalMaximum > 8) longestWordExceptions.push(position);
    return {
      id: `wt-list0-${String(position).padStart(4, "0")}`,
      reference: { position, levelId: source.id, targetWordLengths: lengths, originalMaxWordLength: originalMaximum },
      config: {
        rows: source.height, columns: source.width, targetCount: lengths.length, targetLengthPlan,
        initialMaxWordLength, maxWordLength, initialForwardProbability: referenceForwardProbability(position),
        initialRarityLevel: 1, minimumEmotionScore: 0,
        targetDuplicateRange: 20, extraDuplicateRange: 0, filters: referenceFilters(position),
      },
    };
  });
  validateConfigList(records);
  return { id: REFERENCE_CONFIG_ID, initialLengthExceptions, longestWordExceptions, records };
}
