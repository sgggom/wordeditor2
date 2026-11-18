import {measureComposition} from './target-composition.mjs';
import {assessDirections,directionPairs,nextDirectionCarry,positiveOptions,isWeighted,directionRate,nextWeightedCarry,weightedOptions} from './direction-policy.mjs';

export const EXACT_LENGTHS=[3,4,5,6,7,8];
export const templateVector=composition=>EXACT_LENGTHS.map(length=>composition.lengthCounts[length]??0);
export const templateMetrics=vector=>({
 ...Object.fromEntries(EXACT_LENGTHS.map((length,index)=>['length:'+length,vector[index]])),
 ['hist:3:'+vector[0]]:1,
 ['hist:4:'+vector[1]]:1,
 ['hist:5:'+vector[2]]:1,
 ['hist:6+:'+vector.slice(3).reduce((sum,n)=>sum+n,0)]:1,
 ['variety:'+vector.filter(Boolean).length]:1,
});

export function compositionMetrics(composition,budget){
 const metrics=templateMetrics(templateVector(composition));
 let positive=0;
 for(const length of EXACT_LENGTHS){const tally=composition[isWeighted(budget)?'weightedDirections':'firstSteps'][length];metrics['positive:'+length]=tally?.positive??0;positive+=tally?.positive??0;}
 metrics.positive=positive;if(isWeighted(budget)){metrics.neutral=0;for(const length of EXACT_LENGTHS){metrics['neutral:'+length]=composition.weightedDirections[length]?.neutral??0;metrics.neutral+=metrics['neutral:'+length];}}return metrics;
}
export function stageMetrics(levels,budget){
 const result={};
 for(const level of levels)for(const [key,value]of Object.entries(compositionMetrics(measureComposition(level),budget)))result[key]=(result[key]??0)+value;
 return result;
}

export function resolveStageBudget(plan,budget,entries){
 if(!budget.directionPolicy)return budget;
 const carry=Object.fromEntries(EXACT_LENGTHS.map(length=>[length,0]));
 for(const previous of plan.stageBudgets.filter(stage=>stage.to<budget.from)){
  const levels=entries.filter(entry=>previous.from<=entry.position&&entry.position<=previous.to).map(entry=>entry.level);
  if(levels.length!==previous.levels)continue;
  const metrics=stageMetrics(levels,previous);
  for(const length of EXACT_LENGTHS)carry[length]=isWeighted(previous)?nextWeightedCarry(carry[length],metrics['length:'+length]??0,previous.directionSharesByLength[length],{positive:metrics['positive:'+length]??0,neutral:metrics['neutral:'+length]??0,reverse:(metrics['length:'+length]??0)-(metrics['positive:'+length]??0)-(metrics['neutral:'+length]??0)}):nextDirectionCarry(carry[length],metrics['length:'+length]??0,previous.firstStepPositiveShares[length]??0,metrics['positive:'+length]??0);
 }
 const resolved={...budget,directionCarryByLength:carry,targets:{...budget.targets},ranges:{...budget.ranges}};
 let preferred=0,minimum=0,maximum=0;
 for(const length of EXACT_LENGTHS){
  const pairs=directionPairs(resolved,length),range=[Math.min(...pairs.map(pair=>pair.positive)),Math.max(...pairs.map(pair=>pair.positive))];
  const counts=isWeighted(budget)?weightedOptions(budget.targets['length:'+length],budget.directionSharesByLength[length],budget.directionPolicy,carry[length]).preferred:null;
  const target=counts?counts.positive:positiveOptions(budget.targets['length:'+length],budget.firstStepPositiveShares[length]??0,budget.directionPolicy,carry[length]).preferred;
  if(counts){resolved.targets['neutral:'+length]=counts.neutral;resolved.ranges['neutral:'+length]=[Math.min(...pairs.map(pair=>pair.neutral)),Math.max(...pairs.map(pair=>pair.neutral))];}
  resolved.targets['positive:'+length]=target;resolved.ranges['positive:'+length]=range;preferred+=target;minimum+=range[0];maximum+=range[1];
 }
 if(isWeighted(budget)){resolved.targets.neutral=EXACT_LENGTHS.reduce((sum,length)=>sum+resolved.targets['neutral:'+length],0);resolved.ranges.neutral=[0,1].map(i=>EXACT_LENGTHS.reduce((sum,length)=>sum+resolved.ranges['neutral:'+length][i],0));}
 resolved.targets.positive=preferred;resolved.ranges.positive=[minimum,maximum];return resolved;
}

export function createStageContext(budget,row,previous,futureRows){
 if(!budget)return null;
 const used=stageMetrics(previous,budget),keys=Object.keys(budget.ranges),remaining={};
 for(const key of keys){
  let minimum=0,maximum=0;
  for(const future of futureRows){
   const possibilities=future.targetComposition.allowedTemplates.map(vector=>{
    const metrics=templateMetrics(vector);
    if(key==='positive'||key==='neutral')return [0,future.targetCount];
    if(key.startsWith('positive:')||key.startsWith('neutral:'))return [0,metrics['length:'+key.split(':')[1]]??0];
    const value=metrics[key]??0;return [value,value];
   });
   minimum+=Math.min(...possibilities.map(value=>value[0]));maximum+=Math.max(...possibilities.map(value=>value[1]));
  }
  remaining[key]=[minimum,maximum];
 }
 const futureTemplates=futureRows.length<=3?futureRows.map(future=>future.targetComposition.allowedTemplates):null;
 let futureBounds=null;
 if(futureTemplates){
  const countKeys=keys.filter(key=>key!=='positive'&&key!=='neutral'&&!key.startsWith('positive:')&&!key.startsWith('neutral:'));
  futureBounds=Array(futureTemplates.length+1);futureBounds[futureTemplates.length]=Object.fromEntries(countKeys.map(key=>[key,[0,0]]));
  for(let index=futureTemplates.length-1;index>=0;index--){
   const options=futureTemplates[index].map(templateMetrics);
   futureBounds[index]=Object.fromEntries(countKeys.map(key=>[key,[
    futureBounds[index+1][key][0]+Math.min(...options.map(option=>option[key]??0)),
    futureBounds[index+1][key][1]+Math.max(...options.map(option=>option[key]??0)),
   ]]));
  }
 }
 return {budget,row,used,remaining,previousWords:previous.reduce((sum,level)=>sum+level.targetWords.length,0),
  previousFive:previous.map(level=>level.targetWords.some(word=>word.word.length===5)),futureRows,
  previousLevels:previous.length,futureWords:futureRows.reduce((sum,level)=>sum+level.targetCount,0),
  futureTemplates,futureBounds,
  futureLongSlots:futureRows.reduce((sum,level)=>sum+Math.max(...level.targetComposition.allowedTemplates.map(vector=>vector.slice(3).reduce((a,b)=>a+b,0))),0)};
}

export function checkStageCandidate(composition,context,{countsOnly=false}={}){
 if(!context)return true;
 const metrics=countsOnly?templateMetrics(templateVector(composition)):compositionMetrics(composition,context.budget);
 for(const [key,[minimum,maximum]]of Object.entries(context.budget.ranges)){
  if(countsOnly&&(key==='positive'||key==='neutral'||key.startsWith('positive:')||key.startsWith('neutral:')))continue;
  const count=(context.used[key]??0)+(metrics[key]??0),[futureMin,futureMax]=context.remaining[key];
  if(count>maximum||count+futureMin>maximum||count+futureMax<minimum)return false;
 }
 // Independent length bounds alone could reserve two missing long lengths for
 // a single remaining slot. Check their combined demand as well.
 const neededLong=EXACT_LENGTHS.filter(length=>length>5).reduce((sum,length)=>{
  const key='length:'+length;return sum+Math.max(0,(context.budget.ranges[key]?.[0]??0)-(context.used[key]??0)-(metrics[key]??0));
 },0);
 if(neededLong>context.futureLongSlots)return false;
 if(context.budget.directionPolicy&&!countsOnly)for(const length of EXACT_LENGTHS){
  const N=(context.used['length:'+length]??0)+(metrics['length:'+length]??0),P=(context.used['positive:'+length]??0)+(metrics['positive:'+length]??0);
  const [futureMin,futureMax]=context.remaining['length:'+length];
  if(!directionPairs(context.budget,length).some(pair=>pair.N-N>=futureMin&&pair.N-N<=futureMax&&pair.positive>=P&&pair.positive-P<=pair.N-N&&(!isWeighted(context.budget)||(pair.neutral-(context.used['neutral:'+length]??0)-(metrics['neutral:'+length]??0)>=0&&pair.positive-P+pair.neutral-(context.used['neutral:'+length]??0)-(metrics['neutral:'+length]??0)<=pair.N-N))))return false;
 }
 const coverage=context.budget.fiveCoverage;
 if(coverage&&context.previousLevels===context.row.position-context.budget.from){
  const flags=[...context.previousFive,(metrics['length:5']??0)>0];let zeros=0;
  for(const flag of flags){zeros=flag?0:zeros+1;if(zeros>coverage.maxConsecutiveZeroLevels)return false;}
  for(let start=0;start<flags.length;start+=5){
   const end=Math.min(start+5,context.budget.levels),known=flags.slice(start,end).filter(Boolean).length;
   const possible=context.futureRows.filter(row=>context.budget.from+start<=row.position&&row.position<context.budget.from+end)
    .filter(row=>row.targetComposition.allowedTemplates.some(vector=>vector[2]>0)).length;
   if(known+possible<Math.min(coverage.perFiveLevelsMinimum,end-start))return false;
  }
 }
 const pacing=context.budget.directionPacing;
 if(pacing&&!countsOnly){
  // Keep directional debt spread over the stage instead of requiring nearly
  // every word in the final few levels to be positive.
  const words=context.previousWords+context.row.targetCount;
  if((context.used.positive??0)+metrics.positive<Math.floor(context.budget.targets.positive*words/context.budget.targetTotal-pacing.maximumDebt))return false;
  for(const length of EXACT_LENGTHS){
   const target=context.budget.targets['length:'+length];if(!target)continue;
   const count=(context.used['length:'+length]??0)+(metrics['length:'+length]??0);
   const rate=context.budget.directionPolicy?directionRate(context.budget,length):context.budget.targets['positive:'+length]/target;
   const minimum=Math.floor(rate*count+(isWeighted(context.budget)?context.budget.directionCarryByLength?.[length]?.positive??0:context.budget.directionCarryByLength?.[length]??0)-pacing.maximumDebtByLength[length]+1e-9);
   if((context.used['positive:'+length]??0)+(metrics['positive:'+length]??0)<minimum)return false;
  }
 }
 if(context.futureTemplates){
  const after={...context.used};for(const [key,value]of Object.entries(metrics))after[key]=(after[key]??0)+value;
  function possible(index,totals,futureLengths){
   for(const [key,[futureMin,futureMax]]of Object.entries(context.futureBounds[index])){
    const [minimum,maximum]=context.budget.ranges[key],actual=totals[key]??0;
    if(actual+futureMin>maximum||actual+futureMax<minimum)return false;
   }
   if(index<context.futureTemplates.length){
    for(const vector of context.futureTemplates[index]){
     const next={...totals},nextLengths=[...futureLengths];
     for(const [key,value]of Object.entries(templateMetrics(vector)))next[key]=(next[key]??0)+value;
     vector.forEach((count,i)=>nextLengths[i]+=count);
     if(possible(index+1,next,nextLengths))return true;
    }
    return false;
   }
   for(const [key,[minimum,maximum]]of Object.entries(context.budget.ranges))if(key!=='positive'&&key!=='neutral'&&!key.startsWith('positive:')&&!key.startsWith('neutral:')){
    const actual=totals[key]??0;if(actual<minimum||actual>maximum)return false;
   }
   if(!countsOnly){
    let minimumPositive=0,maximumPositive=0;
    for(let i=0;i<EXACT_LENGTHS.length;i++){
     const key='positive:'+EXACT_LENGTHS[i],range=context.budget.ranges[key];if(!range)continue;
     const used=after[key]??0;
     let minimum=Math.max(0,range[0]-used),maximum=Math.min(futureLengths[i],range[1]-used);
     if(context.budget.directionPolicy){
      const N=(after['length:'+EXACT_LENGTHS[i]]??0)+futureLengths[i];
      const possible=directionPairs(context.budget,EXACT_LENGTHS[i]).filter(pair=>pair.N===N&&pair.positive>=used&&pair.positive-used<=futureLengths[i]&&(!isWeighted(context.budget)||(pair.neutral>=(after['neutral:'+EXACT_LENGTHS[i]]??0)&&pair.positive-used+pair.neutral-(after['neutral:'+EXACT_LENGTHS[i]]??0)<=futureLengths[i])));
      if(!possible.length)return false;
      minimum=Math.min(...possible.map(pair=>pair.positive-used));maximum=Math.max(...possible.map(pair=>pair.positive-used));
     }
     if(minimum>maximum)return false;minimumPositive+=minimum;maximumPositive+=maximum;
    }
    const totalRange=context.budget.ranges.positive;
    if(totalRange&&((after.positive??0)+minimumPositive>totalRange[1]||(after.positive??0)+maximumPositive<totalRange[0]))return false;
   }
   return true;
  }
  if(!possible(0,after,[0,0,0,0,0,0]))return false;
 }
 return true;
}

export function stageCandidateCost(composition,context){
 if(!context)return 0;
 const metrics=compositionMetrics(composition,context.budget),wordProgress=(context.previousWords+context.row.targetCount)/context.budget.targetTotal;
 const levelProgress=(context.previousLevels+1)/context.budget.levels;
 let cost=0;
 for(const [key,target]of Object.entries(context.budget.targets)){
  const progress=key.startsWith('hist:')||key.startsWith('variety:')?levelProgress:wordProgress;
  const deviation=(context.used[key]??0)+(metrics[key]??0)-target*progress;
  cost+=deviation*deviation*(key.startsWith('positive')?3:2)/Math.max(1,Math.sqrt(target));
 }
 return cost;
}

export function checkStageComplete(budget,levels){
 const metrics=stageMetrics(levels,budget),violations=[];
 for(const [key,[minimum,maximum]]of Object.entries(budget.ranges)){
  const actual=metrics[key]??0;if(actual<minimum||actual>maximum)violations.push({metric:key,actual,range:[minimum,maximum]});
 }
 const directions=assessDirections(budget,metrics);
 for(const row of directions)if(!row.passed)violations.push({metric:'direction:'+row.length,actual:row.positive,allowed:row.allowed,N:row.N});
 let fiveCoverage;
 if(budget.fiveCoverage&&levels.length===budget.levels){
  const flags=levels.map(level=>level.targetWords.some(word=>word.word.length===5)),covered=flags.filter(Boolean).length,blocks=[];
  let zeros=0,maximumZeros=0;
  for(const flag of flags){zeros=flag?0:zeros+1;maximumZeros=Math.max(maximumZeros,zeros);}
  for(let start=0;start<flags.length;start+=5){const count=flags.slice(start,start+5).filter(Boolean).length;blocks.push(count);if(count<budget.fiveCoverage.perFiveLevelsMinimum)violations.push({metric:'fiveCoverage:block',from:budget.from+start,actual:count,minimum:budget.fiveCoverage.perFiveLevelsMinimum});}
  const [minimum,maximum]=budget.fiveCoverage.allowedLevels;
  if(covered<minimum||covered>maximum)violations.push({metric:'fiveCoverage:levels',actual:covered,range:[minimum,maximum]});
  if(maximumZeros>budget.fiveCoverage.maxConsecutiveZeroLevels)violations.push({metric:'fiveCoverage:zeroStreak',actual:maximumZeros});
  fiveCoverage={covered,blocks,maximumZeros};
 }
 return {id:budget.id,from:budget.from,to:budget.to,completed:levels.length,expectedLevels:budget.levels,
  passed:levels.length===budget.levels&&!violations.length,targets:budget.targets,ranges:budget.ranges,actual:metrics,violations,
  ...(directions.length?{directions}:{}),...(fiveCoverage?{fiveCoverage}:{})};
}
