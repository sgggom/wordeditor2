import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {COMPOSITION_POLICY_ID,lengthClass,validateComposition} from './lib/target-composition.mjs';
import {validateLevelPlan} from './lib/level-plan.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const sourceFiles={};
const read=file=>{const bytes=fs.readFileSync(path.resolve(ROOT,file));sourceFiles[file]=createHash('sha256').update(bytes).digest('hex');return JSON.parse(bytes);};
const original=read('outputs/20261112-level-plan-reference-size/plan.json');
const reference=read('level-editor/dist/data/presets/word-tiles-list0.json');
const direction=read('outputs/20261112-competitor-direction-by-length/first-step-summary.json');
const three=read('outputs/20261112-competitor-three-letter-counts/summary.json');
const other=read('outputs/20261112-competitor-target-counts-by-length/summary.json');
const variety=read('outputs/20261112-competitor-length-variety/summary.json');
for(const report of [direction,three,other,variety])assert.equal(report.source.sha256,sourceFiles['level-editor/dist/data/presets/word-tiles-list0.json']);
let state=2026111220;const random=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/4294967296);
function weighted(values,weight){const weights=values.map(weight);let left=random()*weights.reduce((a,b)=>a+b,0);for(let i=0;i<values.length;i++){left-=weights[i];if(left<0)return values[i];}return values.at(-1);}
const peers=reference.map((level,index)=>({position:index+1,cells:level.width*level.height,
 lengths:level.target_words.map(entry=>entry.word.length),targetCount:level.target_words.length,
 noThree:!level.target_words.some(entry=>entry.word.length===3)}));
const stageRanges=[[1,10],[11,20],[21,50],[51,100],[101,500],[501,1000],[1001,1500],[1501,2000]];
const referenceStage=position=>stageRanges.find(([from,to])=>position>=from&&position<=to);
function directionShares(position){
 const referencePosition=position>1500?position-500:position;
 const stage=direction.stages.find(stage=>referencePosition>=stage.from&&referencePosition<=stage.to);
 const globalLong=direction.byLength.filter(row=>row.length>=6&&row.length<=8);
 const longShare=globalLong.reduce((sum,row)=>sum+row.positive,0)/globalLong.reduce((sum,row)=>sum+row.total,0);
 const shares={'6+':longShare};
 for(let length=3;length<=8;length++){
  const global=direction.byLength.find(row=>row.length===length),local=stage.byLength.find(row=>row.length===length);
  // Sparse long-word groups borrow twenty observations from the overall rate.
  shares[length]=((local?.positive??0)+20*global.positive/global.total)/((local?.total??0)+20);
 }
 return shares;
}
const noThreePositions=[];
for(let from=31;from<=2000;from+=30){
 const to=Math.min(2000,from+29),center=from+14;
 let choices=original.records.filter(row=>row.position>=Math.max(from,center-5)&&row.position<=Math.min(to,center+5)&&
  row.targetCount>=6&&row.targetCount<=row.activeCells&&row.activeCells>=9&&row.position-(noThreePositions.at(-1)??-100)>=20);
 if(!choices.length)choices=original.records.filter(row=>row.position>=from&&row.position<=to&&row.targetCount>=6&&row.targetCount<=row.activeCells&&row.position-(noThreePositions.at(-1)??-100)>=20);
 assert.ok(choices.length,'无法安排不含3字母目标的关卡');
 noThreePositions.push(weighted(choices,row=>(row.difficulty==='标准'?1.3:1)/(1+Math.abs(row.position-center)*.1)).position);
}
const zeroThree=new Set(noThreePositions);
function scaleLengths(lengths,count,noThree){
 const entries=[...new Set(lengths)].sort((a,b)=>a-b).map(length=>{
  const share=lengths.filter(value=>value===length).length*count/lengths.length;
  return {length,count:Math.floor(share),fraction:share%1};
 });
 let left=count-entries.reduce((sum,entry)=>sum+entry.count,0);
 for(const entry of [...entries].sort((a,b)=>b.fraction-a.fraction||a.length-b.length))if(left){entry.count++;left--;}
 const three=entries.find(entry=>entry.length===3);
 if(!noThree&&(!three||!three.count)){
  const donor=[...entries].sort((a,b)=>b.count-a.count).find(entry=>entry.length!==3&&entry.count>1);assert.ok(donor);
  donor.count--;if(three)three.count++;else entries.push({length:3,count:1});
 }
 if(entries.filter(entry=>entry.count).length<2){
  const donor=entries.find(entry=>entry.count>1);assert.ok(donor);
  const alternative=noThree?(donor.length===4?5:4):(donor.length===3?4:3);
  donor.count--;const existing=entries.find(entry=>entry.length===alternative);if(existing)existing.count++;else entries.push({length:alternative,count:1});
 }
 return entries.sort((a,b)=>a.length-b.length).flatMap(entry=>Array(entry.count).fill(entry.length));
}
const records=original.records.map(row=>{
 const [from,to]=referenceStage(row.position),sourceFrom=from>1500?1001:from,sourceTo=to>1500?1500:to;
 const noThreeLetter=zeroThree.has(row.position);
 let candidates=peers.filter(peer=>peer.position>=sourceFrom&&peer.position<=sourceTo&&peer.noThree===noThreeLetter);
 if(!candidates.length)candidates=peers.filter(peer=>peer.noThree===noThreeLetter);
 const peer=weighted(candidates,peer=>Math.exp(-Math.abs(peer.targetCount-row.targetCount)*.65-Math.abs(peer.cells-row.activeCells)*.15));
 const preferredLengths=scaleLengths(peer.lengths,row.targetCount,noThreeLetter),preferredCounts=[0,0,0,0];
 for(const length of preferredLengths)preferredCounts[lengthClass(length)]++;
 const config={policyId:COMPOSITION_POLICY_ID,stageFrom:from,stageTo:to,noThreeLetter,
  preferredLengths,preferredCounts,preferredCountRanges:preferredCounts.map((count,index)=>
   index===0&&noThreeLetter?[0,0]:[Math.max(index===0?1:0,count-1),Math.min(row.targetCount,count+1)]),
  preferredDistinctLengths:new Set(preferredLengths).size,minimumDistinctLengths:2,
  firstStepPositiveShares:directionShares(row.position),weights:{counts:3,rangeOverflow:2,variety:2,firstStep:1.25}};
 validateComposition(config,row.targetCount);
 return {...row,targetComposition:config};
});
const policy={schemaVersion:1,id:COMPOSITION_POLICY_ID,mode:'empirical-joint-preferences',seed:2026111220,sourceFiles,
 classes:['3','4','5','6+'],
 countPolicy:'按阶段、相近有效格数和目标总数抽取竞品联合词长构成，再按我们的目标总数分配；计数范围、种类数和首步比例用于排序，不逐关强配参考配额。',
 hardRules:{ordinaryThreeLetterMinimum:1,noThreeLetterPositions:noThreePositions,minimumDistinctLengths:2},
 noThreeSchedule:{firstBlock:31,blockSize:30,onePerBlock:true,minimumGap:20,centerJitter:5,minimumTargets:6,maximumTargetsPerActiveCell:1},
 directionPolicy:{basis:'第1个字母到第2个字母',positive:['R','D'],reverse:['L','U'],balance:'stage-and-exact-length',
  sparsePriorWords:20,rareNinePlusFallback:'6～8字母合并比例，避免各1例样本造成100%正向'},
 observed:{three:three.all,others:other.categories.map(category=>({label:category.label,all:category.all,positive:category.positive})),
  distinctLengths:variety.overall,firstStepByLength:direction.byLength},
 stageProfiles:stageRanges.map(([from,to])=>{
  const selected=records.filter(row=>row.position>=from&&row.position<=to);
  const mean=index=>selected.reduce((sum,row)=>sum+row.targetComposition.preferredCounts[index],0)/selected.length;
  return {from,to,levels:selected.length,meanPreferredCounts:[0,1,2,3].map(mean),zeroThree:selected.filter(row=>row.targetComposition.noThreeLetter).length,
   firstStepPositiveShares:directionShares(from)};
 })};
const plan={...structuredClone(original),id:'our-level-plan-composition-20261112',parentPlanId:original.id,
 targetCompositionPolicy:{id:policy.id,file:'level-editor/dist/data/target-composition-policy.json'},
 provenance:[...new Map([...original.provenance,...Object.entries(sourceFiles).map(([file,sha256])=>({file,sha256}))].map(entry=>[entry.file,entry])).values()],
 notes:[...original.notes,'2026-11-12：加入实际词长频数、词长种类及首步方向统计；以联合构成为偏好，独立安排每30关一次不含3字母目标。'],
 records};
for(let i=0;i<records.length;i++)for(const [key,value]of Object.entries(original.records[i]))assert.deepEqual(records[i][key],value,'保持原规划 '+key);
validateLevelPlan(plan);
const out=path.resolve(ROOT,'outputs/20261112-level-plan-composition');fs.mkdirSync(out,{recursive:true});
const write=(file,data)=>fs.writeFileSync(path.resolve(ROOT,file),JSON.stringify(data,null,2)+'\n');
write('level-editor/dist/data/target-composition-policy.json',policy);write('level-editor/dist/data/level-plan.json',plan);
write('outputs/20261112-level-plan-composition/plan.json',plan);write('outputs/20261112-level-plan-composition/policy.json',policy);
const lines=['新规划：词长构成与首步方向配置（第6～2000关）',policy.countPolicy,
 '棋盘、难度、目标总数、四档得分数量和总分区间全部保持原规划。当前前100关成品不改；续跑时旧成品按原规则保留。',
 '必须满足：常规关至少1个3字母目标；变化关0个3字母目标；至少2种词长。其他构成为候选排序偏好。',
 '数量顺序：3字母 / 4字母 / 5字母 / 6字母及以上。方向为首两个字母的连接方向，按阶段和词长平衡。',
 '不含3字母关号：'+noThreePositions.join('、'),'',
 '关号\t难度\t棋盘（列×行）\t目标数\t3字母规则\t偏好数量\t偏好词长种类\t逐词长度偏好'];
for(const row of records)lines.push([row.position,row.difficulty,`${row.columns}×${row.rows}`,row.targetCount,
 row.targetComposition.noThreeLetter?'不投放':'至少1个',row.targetComposition.preferredCounts.join('/'),row.targetComposition.preferredDistinctLengths,row.targetComposition.preferredLengths.join('/')].join('\t'));
fs.writeFileSync(path.join(out,'配置说明及逐关清单.txt'),lines.join('\n')+'\n');
console.log(JSON.stringify({planId:plan.id,records:records.length,noThreeLevels:noThreePositions.length,noThreeFirst:noThreePositions.slice(0,5),stageProfiles:policy.stageProfiles},null,2));
