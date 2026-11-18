import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildLevelConstraintPlan, checkLevelConstraint, checkConstraintSequence } from '../dist/level-constraints.js';
import { createGenerator } from '../dist/level-generator.js';
import { importSingleGameLevel, gameLevelLocations, gameLevelData } from '../dist/level-import.js';
import { validateCurrentRuleConfigs } from '../dist/generation-policy.js';

const root = new URL('../../', import.meta.url);
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/build-level-constraints.mjs [--out OUTPUT_DIRECTORY]');
  process.exit(0);
}
const outIndex = args.indexOf('--out');
assert.ok(args.length === 0 || outIndex === 0 && args.length === 2 && args[1], '仅支持 --out OUTPUT_DIRECTORY');
const destination = outIndex < 0 ? fileURLToPath(new URL('outputs/20261111-level-constraints/', root)) : path.resolve(args[1]);
const sources = {};
function read(relative, purpose) {
  const text = fs.readFileSync(new URL(relative, root), 'utf8');
  sources[relative] = { sha256: createHash('sha256').update(text).digest('hex'), purpose };
  return JSON.parse(text);
}
const data = 'level-editor/dist/data/';
const accepted = 'outputs/20261111-one-in-five-special-2000/';
const preset = read(data + 'current-rule-configs.json', '当前尺寸、造型规则与体验参考');
validateCurrentRuleConfigs(preset.records, { complete: true });
const shapePlan = read(accepted + 'shape-plan.json', '当前逐关尺寸参考及造型建议');
const acceptedValidation = read(accepted + 'validation.json', '已验证的阶段硬范围');
assert.ok(acceptedValidation.passed);
const gamePack = read(data + 'presets/our-levels-one-in-five-special-2000-2026-11-11.json',
  '用于试核的当前成品；前5关跳过');
const sourceRows = gameLevelLocations(gamePack).filter(entry => entry.group !== 'daily').map(entry => gameLevelData(entry.original));
const pathReport = read(accepted + 'report.json', '当前成品的实际目标路径');
assert.equal(sourceRows.length, 2000);
assert.equal(pathReport.levels.length, 2000);

// Historical files provide only already-confirmed numerical ceilings. They are
// never used as a dictionary or as a source of recognized words.
const baseline = read('outputs/20261110-repeat-window-refined-2000/game-early-joint.json', '仅提取既有词量误差和额外词数量上限').books[0].levels;
const previous = read(data + 'presets/our-levels-repeat-reduced-2000-2026-11-11.json', '仅提取既有逐关数量上限').books[0].levels;
const direction = read('outputs/20261105-direction-rarity-selected-2000/review-data.json', '仅提取既有词量、额外词和生僻词上限');
const policy = read('outputs/20261105-low-extra-selected-2000/selection.json', '既有首行节奏限制').policy;
const phases = read('outputs/20261105-low-extra-selected-2000/phases.json', '既有阶段划分与生僻比例');
const words = text => text.trim() ? text.trim().split(/\s+/) : [];
const limits = preset.records.map(({ position, config }, index) => {
  const phase = phases.find(row => position >= row.from && position <= row.to);
  return { countError: index === 0 ? Math.abs(words(baseline[index].t).length - config.desiredTargetCount)
    : Math.min(Math.abs(words(baseline[index].t).length - config.desiredTargetCount),
      Math.abs(words(previous[index].t).length - config.desiredTargetCount), Math.abs(direction[index].countDifference)),
  extraMaximum: Math.min(words(baseline[index].e).length, words(previous[index].e).length, direction[index].extraCount),
  previousRareCount: direction[index].rareCount, rareRate: phase.rare + 0.15 };
});
const ordinary = [...read(data + 'required-words.json', '当前目标词库'), ...read(data + 'guide-words.json', '当前引导词库')];
const extra = read(data + 'extra-words.json', '当前仅额外词库');
const dictionaryRows = [...ordinary, ...extra.map(entry => ({ ...entry, onlyExtra: true }))];
const dictionary = new Map(dictionaryRows.map(entry => [entry.word, entry]));
const whitelist = new Map(read(data + 'candidate-words.json', '当前目标候选白名单').words);
const excluded = read('level-editor/data/source/excluded-words.json', '永久排除词记录');
assert.ok(excluded.words.every(word => !dictionary.has(word)), '当前词库重新包含了永久排除词');
const generator = createGenerator(ordinary, extra, { targetWordWhitelist: [...whitelist.keys()] });
const plan = buildLevelConstraintPlan({ configs: preset.records, shapePlan, limits,
  stages: acceptedValidation.stageValidation, sequence: policy, sources });

// Construct the full plan first. The audit reports real disagreements instead
// of adjusting any limit to make the existing levels pass.
const started = performance.now(), entries = [], measurements = [], staticViolations = [];
for (const record of plan.records) {
  if (record.mode === 'manual') continue;
  const index = record.position - 1;
  const level = importSingleGameLevel(JSON.stringify(sourceRows[index]), dictionaryRows);
  const assigned = new Map(pathReport.levels[index].paths);
  assert.equal(pathReport.levels[index].position, record.position);
  assert.deepEqual([...assigned.keys()].sort(), level.targetWords.map(entry => entry.word).sort());
  for (const target of level.targetWords) target.path = assigned.get(target.word);
  const foundWords = generator.findWords({ rows: level.rows, columns: level.columns, disabledCells: level.disabledCells,
    letters: level.cells.map(cell => cell.letter), minimumWordLength: 3 });
  const result = checkLevelConstraint(level, record, { dictionary, whitelist, foundWords });
  for (const issue of result.violations) staticViolations.push({ position: record.position, ...issue });
  if (result.metrics) {
    entries.push({ position: record.position, level, game: result.game, metrics: result.metrics, shapeId: result.shapeId });
    measurements.push({ position: record.position, targetCount: level.targetWords.length, extraCount: level.extraWords.length,
      shapeId: result.shapeId, matchesPosition: result.matchesPosition,
      actualLengthCounts: result.metrics.lengthCounts, referenceLengthCounts: record.preferences.targetLengthCounts,
      exactReferenceLengthCounts: result.exactReferenceLengthCounts });
  }
  if (record.position % 250 === 0) console.log(JSON.stringify({ checkedThrough: record.position, staticViolations: staticViolations.length }));
}
const sequence = checkConstraintSequence(plan, entries);
const automatic = plan.records.filter(record => record.mode === 'automatic');
const summary = {
  status: staticViolations.length || sequence.violations.length ? 'failed' : 'automatic-checks-passed-manual-history-pending',
  totalPositions: plan.scope.totalPositions, excludedPositions: plan.scope.excludedPositions,
  checkedAutomaticPositions: entries.length,
  constraintCounts: { ordinary: automatic.filter(record => record.hard.board.selection === 'exact-mask').length,
    special: automatic.filter(record => record.hard.board.selection !== 'exact-mask').length,
    exactTargetCount: automatic.filter(record => record.hard.targetCount.allowedError === 0).length,
    targetCountWithTolerance: automatic.filter(record => record.hard.targetCount.allowedError > 0).length },
  staticViolations, sequence,
  lengthReference: { hardPerLevelRequirement: false,
    exact: measurements.filter(row => row.exactReferenceLengthCounts).length,
    different: measurements.filter(row => !row.exactReferenceLengthCounts).length },
  rarityHardRules: { globalTargetAllowedLevels: [1, 2, 3, 4], forbiddenTargetLevels: [5],
    perLevelAllowedLists: automatic.filter(record => record.hard.targetRarityLevels.length > 0).length,
    combinedCountLimitLevels: [3, 4], separateLevel4CountLimit: false, appliesTo: 'target-words' },
  notes: [
    '本次只整理、核验约束，不生成或重排关卡，不修改编辑器现有关卡或配置。',
    '前5关不读取为已定稿历史，不锁定其字母、目标、数量或造型；后续关号保持不变。',
    '第6～55关涉及前5关的50关冷却待补检；整盘去重也需在手调后补查。',
    '第10关的特殊造型需在第5关手调后按实际前款复核；后续特殊关按实际前款选择。',
    '第1～10关阶段包含人工保留关，暂不宣称整个阶段通过。',
    '逐关词长、拐弯等参考仍用于候选排序；硬范围继承当前已确认规则，未擅自收紧。',
    '参考词量、额外词和生僻上限已算成明确数值，未来排关不必再读取历史实验文件。',
  ],
  sourcePresetId: presetId, elapsedMilliseconds: Math.round(performance.now() - started),
};
fs.mkdirSync(destination, { recursive: true });
const write = (name, value) => fs.writeFileSync(path.join(destination, name), JSON.stringify(value, null, 2) + '\n');
write('constraints.json', plan);
write('validation.json', summary);
write('current-measurements.json', measurements);
const sampleLine = record => {
  if (record.mode === 'manual') return String(record.position).padStart(4, '0') + ' | 人工保留（暂不设置自动约束）';
  const hard = record.hard, count = hard.targetCount;
  const boards = hard.board.options.map(option => option.shapeId + ':' + option.rows + '×' + option.columns + '/' + option.activeCells + '格').join('、');
  const lengths = record.preferences.targetLengthCounts.map((n, index) => n ? record.preferences.lengthBins[index] + '字母×' + n : '').filter(Boolean).join('，');
  return String(record.position).padStart(4, '0') + ' | 参考' + record.reference.position + ' | ' +
    (hard.board.selection === 'exact-mask' ? '普通 ' : '特殊（按前款选最近） ') + boards +
    ' | 目标' + count.minimum + (count.minimum === count.maximum ? '' : '～' + count.maximum) + '（优先' + count.preferred + '）' +
    ' | 额外≤' + hard.extraCount.maximum + ' | 目标允许档位' + hard.targetRarityLevels.join('、') +
    ' | 3～4档合计硬上限[目标数:上限] ' +
    hard.rareWordMaximumByTargetCount.map(pair => pair.join(':')).join('、') + ' | 阶段' + record.stageId + ' | 词长参考 ' + lengths;
};
const metricLabels = { positive: '正向词占比', rare: '生僻词占比', letters: '平均词长', turns: '每词拐弯数',
  longFive: '5字母以上占比', straight: '直线路径占比', twoPlus: '至少2拐占比' };
const text = [
  '逐关约束初版 · 2026-11-11',
  '共2000个位置；前5关人工保留；第6～2000关共1995关参与本次约束核验。',
  '已知条件检查：' + (summary.status === 'failed' ? '发现冲突' : '通过') + '；人工历史与开场阶段待手调后补检。',
  '普通关' + summary.constraintCounts.ordinary + '关；特殊关' + summary.constraintCounts.special + '关。',
  '目标数量必须精确的关卡' + summary.constraintCounts.exactTargetCount + '关；沿用既有允许偏差的关卡' + summary.constraintCounts.targetCountWithTolerance + '关。',
  '实际词长组成与参考完全一致' + summary.lengthReference.exact + '关，不同' + summary.lengthReference.different + '关；逐关精确词长暂非硬门槛。',
  '', '统一硬要求：',
  '使用当前dist/data词库及白名单；目标仅1～4档、至少3字母；禁止目标词直接加S词对。',
  '逐关明确允许的目标词档位；5档不能成为目标词；3～4档目标词合计不能超过本关配额。额外词档位不按此限档。',
  '额外词完整搜出，且长度必须属于本关实际目标词长度集合。',
  '路径上下左右相邻、单词内不重复用格；覆盖所有有效格；每格次数1～35；所有合法消词选择都能完成。',
  '目标、额外词跨类型一起冷却50关，重复词最早在相距51关时再用；仅正式采用的关卡更新历史。',
  '整盘不能与其他已定稿关重复；每5关的第5关使用特殊造型，前款去重后优先选有效格数最接近参考的款式。',
  '首行直接出现目标词最多连续' + policy.maxTopRun + '关；不出现最多连续' + policy.maxNoTopRun +
    '关；出现/不出现的交替最多连续' + policy.maxAlternatingRun + '关。',
  '前5关不占候选库，不锁定旧核心词；后续旧核心词也仅为生成建议。',
  '', '待补项：', ...summary.notes.slice(1, 5),
  '', '阶段硬范围（以目标词数加权，不能要求每一关都等于阶段平均）：',
  ...plan.stages.map(stage => stage.from + '～' + stage.to + '关 | ' + Object.entries(stage.ranges).map(([field, range]) =>
    metricLabels[field] + '=' + range.minimum.toFixed(6) + '～' + range.maximum.toFixed(6)).join(' | ') +
    ({ pending: ' | 包含未定稿关，待补检', passed: ' | 当前成品核验通过', failed: ' | 当前成品存在冲突' }[
      sequence.stages.find(result => result.id === stage.id).status])),
  '', '逐关清单（词长列为排序参考；特殊造型在实际前款确定后再筛）：', ...plan.records.map(sampleLine), '',
];
fs.writeFileSync(path.join(destination, 'constraints.txt'), text.join('\n'));
console.log(JSON.stringify({ destination, ...summary, sequence: { ...sequence, stages: undefined } }));
if (summary.status === 'failed') process.exitCode = 1;
