import { describePath } from "./level-statistics.js";

const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const round = value => Number(value.toFixed(4));
function isPositive(path, columns) {
  let balance = 0;
  for (let index = 1; index < path.length; index++) {
    const previous = path[index - 1], cell = path[index];
    balance += cell % columns > previous % columns || Math.floor(cell / columns) > Math.floor(previous / columns) ? 1 : -1;
  }
  return balance > 0;
}
function normalizedShares(values, size) {
  if (!Array.isArray(values) || values.length !== size) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return sum > 0 ? values.map(value => value / sum) : null;
}
function shares(words, bins, group) {
  return bins.map(bin => words.length ? words.filter(word => group(word) === bin).length / words.length : 0);
}
const lengthGroup = entry => Math.min(5, entry.word.length);
const detailedLengthGroup = entry => Math.min(8, entry.word.length);
const turnBins = [0, 1, 2, 3];
const pathFor = (entry, columns) => entry.path ? describePath(entry.path, columns) : null;
const gap = (actual, reference) => reference ? actual.reduce((sum, value, index) => sum + Math.abs(value - reference[index]), 0) : 0;

export function placementQualityCost(entry, columns, rules, selected = []) {
  const path = describePath(entry.path, columns);
  const topHorizontal = path.turns === 0 && entry.path.every(cell => cell < columns);
  const referenceLengths = rules.targetWordLengths ?? [];
  const lengthShares = normalizedShares(rules.lengthShares, 3);
  const rarityShares = normalizedShares(rules.rarityShares, 4);
  const next = [...selected, entry];
  const detailedReference = referenceLengths.length ? [3,4,5,6,7,8].map(bin => referenceLengths.filter(n=>Math.min(8,n)===bin).length/referenceLengths.length) : null;
  const distributionRules = normalizedShares(rules.turnShares, 4);
  const lengthCost = distributionRules && detailedReference ? gap(shares(next,[3,4,5,6,7,8],detailedLengthGroup),detailedReference)
    : lengthShares ? gap(shares(next, [3, 4, 5], lengthGroup), lengthShares)
    : referenceLengths.length ? Math.abs(entry.word.length - average(referenceLengths)) / 3 : 0;
  const knownPaths = next.map(e=>pathFor(e,columns)).filter(Boolean);
  const turnCost = distributionRules ? gap(shares(knownPaths,turnBins,p=>Math.min(3,p.turns)),distributionRules) * 4
    : Math.abs(path.turns - (rules.turnsPerWord ?? 1)) * 1.5;
  return lengthCost * (distributionRules ? 5 : 2) + gap(shares(next, [1, 2, 3, 4], word => word.rarityLevel), rarityShares) * 1.5
    + turnCost
    + Math.abs(path.reversals - (rules.reversalsPerWord ?? 0.15)) * 0.5
    + Number(topHorizontal) * (distributionRules ? 0.5 : 3) + Number(entry.path[0] < columns) * (distributionRules ? 0.15 : 0.6)
    + (rules.positiveWordShare == null ? 0 : Math.abs(Number(isPositive(entry.path, columns)) - rules.positiveWordShare) * 0.7);
}

// All values are measured on actual legal representative routes; the score is
// a soft comparison between already safe, fully covered boards, never a proof.
export function scoreGenerationQuality(level, rules) {
  const words = level.targetWords;
  const paths = words.map(entry => describePath(entry.path, level.columns));
  const referenceLengths = rules.targetWordLengths ?? [];
  const referenceLengthShares = normalizedShares(rules.lengthShares, 3)
    ?? (referenceLengths.length ? [3, 4, 5].map(bin => referenceLengths.filter(length => Math.min(length, 5) === bin).length / referenceLengths.length) : null);
  const referenceRarityShares = normalizedShares(rules.rarityShares, 4);
  const actualLengthShares = shares(words, [3, 4, 5], lengthGroup);
  const actualRarityShares = shares(words, [1, 2, 3, 4], entry => entry.rarityLevel);
  const startCounts = new Map();
  for (const path of paths) startCounts.set(path.path[0], (startCounts.get(path.path[0]) ?? 0) + 1);
  const targetCountDifference = words.length - level.desiredTargetCount;
  const averageTurns = average(paths.map(path => path.turns));
  const averageReversals = average(paths.map(path => path.reversals));
  const topRowHorizontalCount = paths.filter(path => path.turns === 0 && path.path.every(cell => cell < level.columns)).length;
  const startConcentration = words.length > 1 ? (Math.max(...startCounts.values()) - 1) / (words.length - 1) : 0;
  const straightShare = paths.filter(path => path.turns === 0).length / words.length;
  const positiveWordShare = paths.filter(path => isPositive(path.path, level.columns)).length / words.length;
  const lengthShareDifference = gap(actualLengthShares, referenceLengthShares);
  const rarityShareDifference = gap(actualRarityShares, referenceRarityShares);
  const turnsDifference = averageTurns - (rules.turnsPerWord ?? 1);
  const reversalsDifference = averageReversals - (rules.reversalsPerWord ?? 0.15);
  const positiveDifference = rules.positiveWordShare == null ? 0 : positiveWordShare - rules.positiveWordShare;
  const referenceTurnShares = normalizedShares(rules.turnShares,4);
  const turnShares = shares(paths,turnBins,p=>Math.min(3,p.turns));
  const turnShareDifference = gap(turnShares,referenceTurnShares);
  const referenceDetailedLengthShares = referenceLengths.length ? [3,4,5,6,7,8].map(bin=>referenceLengths.filter(n=>Math.min(8,n)===bin).length/referenceLengths.length) : null;
  const detailedLengthShares = shares(words,[3,4,5,6,7,8],detailedLengthGroup);
  const detailedLengthDifference = gap(detailedLengthShares,referenceDetailedLengthShares);
  const score = referenceTurnShares ? Math.abs(targetCountDifference)*4 + detailedLengthDifference*8 + turnShareDifference*8
    + rarityShareDifference*3 + Math.abs(turnsDifference)*3 + Math.abs(reversalsDifference)*0.5
    + topRowHorizontalCount*0.35 + startConcentration + Math.abs(positiveDifference)
    : Math.abs(targetCountDifference) * 3 + lengthShareDifference * 5 + rarityShareDifference * 3
    + Math.abs(turnsDifference) * 2 + Math.abs(reversalsDifference) + topRowHorizontalCount * 1.2
    + startConcentration * 2 + Math.abs(straightShare - 0.2) + Math.abs(positiveDifference);
  return { version: referenceTurnShares ? 2 : 1, score: round(score), softTargetsMatched: false,
    turnShares:turnShares.map(round),referenceTurnShares,turnShareDifference:round(turnShareDifference),
    detailedLengthShares:detailedLengthShares.map(round),referenceDetailedLengthShares,detailedLengthDifference:round(detailedLengthDifference),
    requestedTargetCount: level.desiredTargetCount, actualTargetCount: words.length, targetCountDifference,
    lengthShares: actualLengthShares.map(round), referenceLengthShares,
    rarityShares: actualRarityShares.map(round), referenceRarityShares,
    lengthShareDifference: round(lengthShareDifference), rarityShareDifference: round(rarityShareDifference),
    averageTurns: round(averageTurns), turnsDifference: round(turnsDifference),
    averageReversals: round(averageReversals), reversalsDifference: round(reversalsDifference),
    positiveWordShare: round(positiveWordShare), positiveDifference: round(positiveDifference),
    topRowHorizontalCount, startConcentration: round(startConcentration), straightShare: round(straightShare),
    searchLimits: { candidateSamples: Math.min(32, rules.candidateSamples ?? 12), attempts: 80,
      placementsPerBoard: 256, nodesPerPlacement: 24000, nodesPerBoard: 150000, routesPerPlacement: 32, wordsPerPlacement: 80 } };
}
