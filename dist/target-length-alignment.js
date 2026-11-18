// Keep exact lengths here: 8 and 9 letters must not collapse into the same bin.
export function referenceLengthQuota(reference, count = reference.length) {
  if (!reference.length || !reference.every(n => Number.isInteger(n) && n >= 3) ||
    !Number.isInteger(count) || count < 1) throw new Error('词长参考或目标数量无效。');
  const bins = [...new Set(reference)].sort((a, b) => a - b).map(length => {
    const share = reference.filter(n => n === length).length * count / reference.length;
    return { length, count: Math.floor(share), remainder: share - Math.floor(share) };
  });
  let remaining = count - bins.reduce((sum, bin) => sum + bin.count, 0);
  for (const bin of [...bins].sort((a, b) => b.remainder - a.remainder || a.length - b.length)) {
    if (remaining > 0) { bin.count++; remaining--; }
  }
  return bins.flatMap(bin => Array(bin.count).fill(bin.length));
}

// The final sorted matching distance is the minimum number of letter-length
// changes. With unfilled slots, this is a safe lower bound for pruning.
export function targetLengthDistance(lengths, quota, remaining = 0) {
  const maximum = Math.max(...lengths, ...quota);
  let actual = 0, target = 0, distance = 0;
  for (let length = 3; length < maximum; length++) {
    actual += lengths.filter(n => n === length).length;
    target += quota.filter(n => n === length).length;
    distance += Math.max(0, actual - target, target - actual - remaining);
  }
  return distance;
}

export function measureTargetLengthAlignment(words, reference) {
  const actual = words.map(entry => typeof entry === 'number' ? entry : entry.word.length).sort((a, b) => a - b);
  const expected = referenceLengthQuota(reference, actual.length);
  const distance = targetLengthDistance(actual, expected);
  return { actual, expected, letterDistance: distance, exact: distance === 0,
    maximum: Math.max(...actual), referenceMaximum: Math.max(...reference) };
}

export function alignConstraintWordLengths(source, { maximumLetterDistance = 2 } = {}) {
  if (!Number.isInteger(maximumLetterDistance) || maximumLetterDistance < 0) throw new Error('词长偏差上限无效。');
  const plan = structuredClone(source);
  plan.id += '-reference-length-aligned';
  for (const record of plan.records) if (record.mode === 'automatic') {
    const reference = record.preferences.targetWordLengths;
    referenceLengthQuota(reference);
    record.hard.targetWordLength = { minimum: 3, maximum: Math.max(...reference), maximumLetterDistance };
  }
  plan.preferencePolicy = '逐关词长优先完全匹配参考；最长词不超过参考最长词；按0、1、2字母总偏差依次筛选，偏差不得超过逐关上限。其他参考用于排序，阶段范围仍硬检查。';
  plan.wordLengthPolicy = { priority: 'exact-then-smallest-letter-distance', maximumLetterDistance,
    countTolerance: 'largest-remainder-apportionment-shorter-first-on-ties',
    distance: 'sum-absolute-differences-of-sorted-lengths', maximum: 'reference-maximum' };
  return plan;
}
