import {measureWordDirections} from '../../dist/word-direction.js';
import {isWeighted} from './direction-policy.mjs';
export const COMPOSITION_POLICY_ID='empirical-target-composition-20261112';
export const lengthClass=length=>length===3?0:length===4?1:length===5?2:3;

export function measureComposition(level){
 const counts=[0,0,0,0],lengths=new Map(),firstSteps={};
 for(const entry of level.targetWords){
  const length=entry.word.length;counts[lengthClass(length)]++;
  lengths.set(length,(lengths.get(length)??0)+1);
  const [start,end]=entry.path;
  const dx=end%level.columns-start%level.columns,dy=Math.floor(end/level.columns)-Math.floor(start/level.columns);
  if(Math.abs(dx)+Math.abs(dy)!==1)throw new Error('首步方向需要正交相邻的前两个字母');
  const direction=dx>0?'R':dx<0?'L':dy>0?'D':'U';
  firstSteps[length]??={total:0,positive:0,R:0,D:0,L:0,U:0};
  const tally=firstSteps[length];tally.total++;tally.positive+=Number(direction==='R'||direction==='D');tally[direction]++;
 }
 return {counts,distinctLengths:lengths.size,lengthCounts:Object.fromEntries([...lengths].sort((a,b)=>a[0]-b[0])),firstSteps,
  weightedDirections:measureWordDirections(level)};
}

export function validateComposition(config,targetCount){
 if(!config)return;
 if(config.directionMetric){
  if(!isWeighted(config))throw new Error('正逆向统计口径无效');
  for(const length of [3,4,5,6,7,8]){
   const shares=config.directionSharesByLength?.[length],values=['positive','reverse','neutral'].map(key=>shares?.[key]);
   if(values.some(value=>!Number.isFinite(value)||value<0||value>1)||Math.abs(values.reduce((a,b)=>a+b,0)-1)>1e-9)throw new Error('正逆向及中性比例无效');
  }
 }
 if(config.policyId!==COMPOSITION_POLICY_ID)throw new Error('词长构成策略版本无效');
 if(typeof config.noThreeLetter!=='boolean')throw new Error('缺少3字母投放规则');
 if(!Array.isArray(config.preferredCounts)||config.preferredCounts.length!==4||
  config.preferredCounts.some(n=>!Number.isInteger(n)||n<0)||config.preferredCounts.reduce((a,b)=>a+b,0)!==targetCount)
  throw new Error('词长构成数量与目标数不一致');
 if(config.noThreeLetter?config.preferredCounts[0]!==0:config.preferredCounts[0]<1)throw new Error('3字母节奏与词长偏好矛盾');
 if(!Array.isArray(config.preferredLengths)||config.preferredLengths.length!==targetCount||
  config.preferredLengths.some(length=>!Number.isInteger(length)||length<3))throw new Error('逐词长度偏好无效');
 const measured=[0,0,0,0];for(const length of config.preferredLengths)measured[lengthClass(length)]++;
 if(measured.some((n,i)=>n!==config.preferredCounts[i]))throw new Error('逐词长度与构成数量矛盾');
 if(new Set(config.preferredLengths).size!==config.preferredDistinctLengths)throw new Error('词长种类偏好矛盾');
 if(!Number.isInteger(config.minimumDistinctLengths)||config.minimumDistinctLengths<1||config.minimumDistinctLengths>targetCount)
  throw new Error('最少词长种类数无效');
 if(config.preferredDistinctLengths<config.minimumDistinctLengths)throw new Error('词长种类偏好低于最少种类数');
 if(!Array.isArray(config.preferredCountRanges)||config.preferredCountRanges.length!==4||config.preferredCountRanges.some((range,i)=>
  !Array.isArray(range)||range.length!==2||!range.every(Number.isInteger)||range[0]<0||range[0]>config.preferredCounts[i]||range[1]<config.preferredCounts[i]||range[1]>targetCount))
  throw new Error('词长数量偏好范围无效');
 for(const length of [3,4,5,6,7,8]){
  const share=config.directionSharesByLength?.[length]?.positive??config.firstStepPositiveShares[length];if(!Number.isFinite(share)||share<0||share>1)throw new Error('首步正向比例无效');
 }
 const longShare=isWeighted(config)?0:config.firstStepPositiveShares['6+'];
 if(!Number.isFinite(longShare)||longShare<0||longShare>1)throw new Error('长词首步方向参考无效');
 for(const key of ['counts','rangeOverflow','variety','firstStep'])if(!Number.isFinite(config.weights?.[key])||config.weights[key]<0)throw new Error('词长构成权重无效');
 if(config.allowedTemplates){
  if(!Array.isArray(config.allowedTemplates)||!config.allowedTemplates.length||config.allowedTemplates.some(vector=>
   !Array.isArray(vector)||vector.length!==6||vector.some(n=>!Number.isInteger(n)||n<0)||vector.reduce((a,b)=>a+b,0)!==targetCount||
   (config.noThreeLetter?vector[0]!==0:vector[0]<1)||vector.filter(Boolean).length<config.minimumDistinctLengths))throw new Error('联合词长模板无效');
 }
}

export function compareComposition(actual,config){
 if(!config)return {passed:true,violations:[]};
 const violations=[];
 if(config.noThreeLetter?actual.counts[0]!==0:actual.counts[0]<1)violations.push('threeLetterSchedule');
 if(actual.distinctLengths<config.minimumDistinctLengths)violations.push('minimumLengthVariety');
 if(config.allowedTemplates&&!config.allowedTemplates.some(vector=>vector.every((count,index)=>count===(actual.lengthCounts[index+3]??0))&&
  Object.keys(actual.lengthCounts).every(length=>Number(length)>=3&&Number(length)<=8)))violations.push('compositionTemplate');
 return {passed:!violations.length,violations,actual,preferred:{counts:config.preferredCounts,
  countRanges:config.preferredCountRanges,distinctLengths:config.preferredDistinctLengths,
  ...(isWeighted(config)?{directionMetric:config.directionMetric,directionSharesByLength:config.directionSharesByLength}:{firstStepPositiveShares:config.firstStepPositiveShares})},mode:'empirical-preference-with-explicit-zero-three-schedule'};
}

export function compositionHistory(levels,config){
 const history={};
 for(const level of levels)for(const [length,tally]of Object.entries(measureComposition(level)[isWeighted(config)?'weightedDirections':'firstSteps'])){
  history[length]??={total:0,positive:0};history[length].total+=tally.total;history[length].positive+=tally.positive;
 }
 return history;
}

export function compositionCost(actual,config,history={}){
 if(!config)return 0;
 let cost=actual.counts.reduce((sum,n,i)=>sum+Math.abs(n-config.preferredCounts[i])*config.weights.counts,0);
 for(let i=0;i<4;i++){
  const [minimum,maximum]=config.preferredCountRanges[i];
  cost+=(Math.max(0,minimum-actual.counts[i])+Math.max(0,actual.counts[i]-maximum))*config.weights.rangeOverflow;
 }
 cost+=Math.abs(actual.distinctLengths-config.preferredDistinctLengths)*config.weights.variety;
 // Balance actual canonical first steps over the stage. A one-word length group
 // must not always choose positive simply because its reference is above 50%.
 for(const [length,tally]of Object.entries(actual[isWeighted(config)?'weightedDirections':'firstSteps'])){
  const prior=history[length]??{total:0,positive:0},share=config.directionSharesByLength?.[length]?.positive??config.firstStepPositiveShares?.[length]??config.firstStepPositiveShares?.['6+'];
  const before=prior.positive-prior.total*share,after=before+tally.positive-tally.total*share;
  cost+=(after*after-before*before)*config.weights.firstStep;
 }
 return cost;
}
