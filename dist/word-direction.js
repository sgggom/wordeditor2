export const WORD_DIRECTION_POLICY = Object.freeze({
  id: "weighted-path-direction-20261113",
  basis: "all-path-steps",
  firstStepWeight: 2,
  subsequentStepWeight: 1,
  positiveDirections: Object.freeze(["R", "D"]),
  reverseDirections: Object.freeze(["L", "U"]),
  tie: "neutral",
});

// This score classifies reading direction; it is independent of path difficulty.
export function describeWordDirection(path, columns) {
  if (!Number.isInteger(columns) || columns < 1 || !Array.isArray(path) ||
      path.some(cell => !Number.isInteger(cell) || cell < 0)) {
    throw new Error("方向统计需要有效的列数和路径格子。");
  }
  const steps = [];
  let positiveScore = 0, reverseScore = 0;
  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1], end = path[index];
    const dx = end % columns - start % columns;
    const dy = Math.floor(end / columns) - Math.floor(start / columns);
    if (Math.abs(dx) + Math.abs(dy) !== 1) {
      throw new Error("方向统计要求每一步正交相邻，不能跨行或跳格。");
    }
    const direction = dx > 0 ? "R" : dx < 0 ? "L" : dy > 0 ? "D" : "U";
    const weight = index === 1 ? WORD_DIRECTION_POLICY.firstStepWeight : WORD_DIRECTION_POLICY.subsequentStepWeight;
    const positive = direction === "R" || direction === "D";
    if (positive) positiveScore += weight;
    else reverseScore += weight;
    steps.push({ direction, weight, score: positive ? weight : -weight });
  }
  const score = positiveScore - reverseScore;
  return { positiveScore, reverseScore, score,
    direction: score > 0 ? "positive" : score < 0 ? "reverse" : "neutral", steps };
}

export function measureWordDirections(level) {
  const byLength = {};
  for (const entry of level.targetWords) {
    const measured = describeWordDirection(entry.path, level.columns);
    const tally = byLength[entry.word.length] ??= { total: 0, positive: 0, reverse: 0, neutral: 0,
      positiveScore: 0, reverseScore: 0, score: 0 };
    tally.total += 1;
    tally[measured.direction] += 1;
    tally.positiveScore += measured.positiveScore;
    tally.reverseScore += measured.reverseScore;
    tally.score += measured.score;
  }
  return byLength;
}
