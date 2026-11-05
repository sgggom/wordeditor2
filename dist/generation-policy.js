import { SHAPE_LIBRARY } from './shape-library.js';

export const CURRENT_RULES_ID = 'three-in-ten-shapes-2000-v2';
export const CURRENT_CONFIG_PRESET_ID = 'current-rules-2000-20261104-v3';
export const CURRENT_INITIAL_WORDS_REVISION = 'initial-words-2000-20261105-v2';
const LEGACY_RULES_ID = 'alternating-shapes-2000-v1';
export const usesHollowShape = position => [1, 3, 7].includes((position - 1) % 10 + 1);
export const MINUS_TWO_POSITIONS = Object.freeze([233,597,747,777,837,897,933]);
const requireRule = (condition, message) => { if (!condition) throw new Error('当前拼关规则：' + message); };
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);

export function validateGenerationPolicy(config) {
  const rules = config.generationRules;
  if (!rules) return null;
  requireRule([CURRENT_RULES_ID, LEGACY_RULES_ID].includes(rules.id), '规则版本无效。');
  const position = rules.position;
  requireRule(Number.isInteger(position) && position >= 1 && position <= 2000, '关号需为1～2000。');
  requireRule(rules.referencePosition === (position <= 1500 ? position : position-500), '参考关号或末500关循环不正确。');
  const shape = position === 1 ? { id:'opening-t', rows:3, columns:3, boardMask:['111','010','010'] }
    : SHAPE_LIBRARY.find(shape => shape.id === rules.shapeId);
  requireRule(shape && rules.shapeId === shape.id, '造型编号无效。');
  requireRule(same(rules.boardMask,shape.boardMask), '必须保留造型库原始掩码。');
  requireRule(config.rows === shape.rows && config.columns === shape.columns, '尺寸与固定造型不一致。');
  const disabled = shape.boardMask.join('').split('').flatMap((bit,cell) => bit === '0' ? [cell] : []);
  requireRule(same([...(config.disabledCells ?? [])].sort((a,b)=>a-b),disabled), '禁用格与固定造型不一致，不能填平或新增缺口。');
  requireRule(config.randomBoardShape !== true, '固定造型配置不能开启随机换形状。');
  requireRule(Boolean(disabled.length) === (rules.id === LEGACY_RULES_ID ? position%2 === 1 : usesHollowShape(position)), '每10关第1、3、7关镂空，其余完整矩形。');
  if (position !== 1 && config.rows === 3 && config.columns === 3) requireRule(!disabled.length, '除首关外3×3必须完整。');
  if (rules.referenceCells !== undefined && position !== 1) {
    requireRule(Number.isInteger(rules.referenceCells), '参考格数无效。');
    const delta = config.rows*config.columns-disabled.length-rules.referenceCells;
    requireRule(MINUS_TWO_POSITIONS.includes(position) ? delta === -2 : Math.abs(delta) <= 1, '有效格数与已确认范围不符。');
  }
  requireRule(config.minimumWordLength === 3, '目标词和额外词至少3字母。');
  const rarity = config.filters?.rarityLevel;
  requireRule(Array.isArray(rarity) && rarity.length > 0 && rarity.every(value=>Number.isInteger(value)&&value>=1&&value<=4), '目标词只能使用已允许的1～4档。');
  const targetRange = config.targetDuplicateRange ?? config.duplicateCheck?.target?.range;
  const extraRange = config.extraDuplicateRange ?? config.duplicateCheck?.extra?.range;
  requireRule(targetRange === 10 && extraRange === 0, '目标词前10关查重，额外词不查重。');
  requireRule(!(config.fixedWordExemptions?.length), '当前规则不允许固定词绕过词库或查重。');
  requireRule(Number.isSafeInteger(config.desiredTargetCount)&&config.desiredTargetCount>0, '必须给出参考目标数量。');
  requireRule(Array.isArray(rules.targetWordLengths)&&rules.targetWordLengths.length===config.desiredTargetCount&&rules.targetWordLengths.every(n=>Number.isInteger(n)&&n>=3), '逐词长度参考与目标数量不一致。');
  for (const [key,count] of [['lengthShares',3],['rarityShares',4]]) {
    requireRule(Array.isArray(rules[key])&&rules[key].length===count&&rules[key].every(n=>Number.isFinite(n)&&n>=0&&n<=1), key+'比例无效。');
    requireRule(Math.abs(rules[key].reduce((sum,n)=>sum+n,0)-1)<0.025, key+'比例总和需接近1。');
  }
  if(rules.turnShares!==undefined){
    requireRule(Array.isArray(rules.turnShares)&&rules.turnShares.length===4&&rules.turnShares.every(n=>Number.isFinite(n)&&n>=0&&n<=1)&&Math.abs(rules.turnShares.reduce((a,b)=>a+b,0)-1)<0.001,'拐弯分布需为直线、1拐、2拐、3拐及以上四组比例。');
  }
  for (const key of ['turnsPerWord','reversalsPerWord']) requireRule(Number.isFinite(rules[key])&&rules[key]>=0, key+'无效。');
  requireRule(Number.isFinite(rules.positiveWordShare)&&rules.positiveWordShare>=0&&rules.positiveWordShare<=1, '正向词比例无效。');
  requireRule(Number.isInteger(rules.candidateSamples)&&rules.candidateSamples>=1&&rules.candidateSamples<=32, '候选数量需为1～32。');
  if (position === 1) {
    requireRule(config.desiredTargetCount === 2, '首关固定两个目标。');
    requireRule(same([...(config.fixedWords??[])].sort(),['ALL','CAT']), '首关必须使用CAT和ALL。');
    const placements = config.fixedLayout?.placements;
    requireRule(config.fixedLayout?.rows===3&&config.fixedLayout?.columns===3&&placements?.length===2, '首关必须固定T型字母位置。');
    requireRule(same(placements.find(p=>p.word==='CAT')?.path,[0,1,2])&&same(placements.find(p=>p.word==='ALL')?.path,[1,4,7]), '首关CAT/ALL路径不可改变。');
  }
  return rules;
}

export function validateCurrentRuleConfigs(records, { complete = false } = {}) {
  const selected = records.filter(record=>record.config?.generationRules).sort((a,b)=>a.config.generationRules.position-b.config.generationRules.position);
  if (complete) requireRule(selected.length===2000,'完整规则配置应有2000关。');
  const seen = new Set();
  for (const [i,record] of selected.entries()) {
    const rules = validateGenerationPolicy(record.config);
    requireRule(!seen.has(rules.position),'关号重复。');seen.add(rules.position);
    requireRule(record.position === undefined || record.position === rules.position,'配置位置与规则关号不一致。');
    if (complete) requireRule(rules.position===i+1,'配置关号不连续。');
    if (record.config.disabledCells.length) requireRule(!selected.slice(0,i).some(old=>
      old.config.generationRules.position>=rules.position-10 && old.config.disabledCells.length && old.config.generationRules.shapeId===rules.shapeId), '镂空造型与前10关重复。');
  }
  return records;
}

export function buildCurrentRulePreset(plan, profiles, initialWordPairs = null) {
  requireRule(plan.length===2000&&profiles.length===2000,'需要完整2000关造型及参考配置。');
  if (initialWordPairs) {
    requireRule(initialWordPairs.length === plan.length && initialWordPairs.every(pair =>
      Array.isArray(pair) && pair.length === 2 && pair[0] !== pair[1] && pair.every(word => /^[A-Z]{3,}$/.test(word))),
    '每关需配两个不同的初始词。');
    requireRule(same(initialWordPairs[0], ['CAT', 'ALL']), '首关初始词需为 CAT / ALL。');
  }
  const records = plan.map((shape,index)=>{
    const soft = profiles[index].designPolicy.rhythmSoftTargets;
    const config = { rows:shape.rows, columns:shape.columns,
      disabledCells:shape.boardMask.join('').split('').flatMap((bit,i)=>bit==='0'?[i]:[]),randomBoardShape:false,
      minimumWordLength:3,desiredTargetCount:shape.targetCount,initialForwardProbability:Math.round(soft.positiveWordShare*100),
      targetDuplicateRange:10,extraDuplicateRange:0,filters:{rarityLevel:[1,2,3,4]},fixedWords:initialWordPairs ? [...initialWordPairs[index]] : [],fixedLayout:null,fixedWordExemptions:[],
      generationRules:{id:CURRENT_RULES_ID,position:shape.position,shapeId:shape.shapeId,boardMask:shape.boardMask,
        referencePosition:shape.referencePosition,referenceCells:shape.referenceCells,targetWordLengths:shape.targetProfile.targetWordLengths,
        lengthShares:soft.lengthShares,rarityShares:soft.rarityShares,turnsPerWord:soft.turnsPerWord,
        reversalsPerWord:soft.reversalsPerWord,positiveWordShare:soft.positiveWordShare,candidateSamples:soft.turnShares?32:12,
        ...(soft.turnShares?{turnShares:soft.turnShares}: {})} };
    if(shape.position===1){config.fixedWords=['CAT','ALL'];config.fixedLayout={rows:3,columns:3,placements:[{word:'CAT',path:[0,1,2]},{word:'ALL',path:[1,4,7]}]};}
    return {id:'current-'+String(shape.position).padStart(4,'0'),position:shape.position,reference:{position:shape.referencePosition},config};
  });
  validateCurrentRuleConfigs(records,{complete:true});
  return {id:CURRENT_CONFIG_PRESET_ID,label:'当前规则 · 2000关 · 三成造型 · 长词与路径节奏优化',
    ...(initialWordPairs ? { initialWordsRevision: CURRENT_INITIAL_WORDS_REVISION } : {}), records};
}
