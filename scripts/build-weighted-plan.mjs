import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPresetRecords} from '../dist/preset-level-lists.js';
import {WORD_DIRECTION_POLICY,measureWordDirections} from '../dist/word-direction.js';
import {weightedOptions,directionPairs} from './lib/direction-policy.mjs';
import {validateLevelPlan} from './lib/level-plan.mjs';
const root=new URL('../../',import.meta.url),sources={};
const read=file=>{const bytes=fs.readFileSync(new URL(file,root));sources[file]=createHash('sha256').update(bytes).digest('hex');return JSON.parse(bytes);};
const base=read('level-editor/dist/data/level-plan-tightened-first-50.json');
const policy={...read('level-editor/dist/data/stage-tightening-policy.json'),id:'weighted-tightened-first-50-20261113',wordDirection:WORD_DIRECTION_POLICY};
Object.assign(policy.directionPolicy,{basis:WORD_DIRECTION_POLICY.id,categories:['positive','reverse','neutral'],denominator:'all-actual-exported-target-words-including-neutral',
 integerFallback:'joint-largest-remainder-allocation-if-no-triple-fits',smallSample:'joint-largest-remainder-exact',nEqualsOne:'carry-three-category-rounding-residual-by-length'});
fs.writeFileSync(new URL('level-editor/dist/data/weighted-stage-policy.json',root),JSON.stringify(policy,null,2)+'\n');
const reference=createPresetRecords(read('level-editor/dist/data/presets/word-tiles-list0.json').slice(0,50),'word-tiles').map(record=>measureWordDirections(record.level));
const plan=structuredClone(base);plan.id='our-level-plan-weighted-first-50-20261113';plan.parentPlanId=base.id;plan.tighteningPolicy=policy.id;plan.wordDirectionPolicy=WORD_DIRECTION_POLICY;
for(const budget of plan.stageBudgets){
 budget.id='weighted-'+budget.id;budget.directionMetric=WORD_DIRECTION_POLICY.id;budget.directionPolicy=policy.directionPolicy;
 budget.referenceDirectionCounts={};budget.directionSharesByLength={};budget.directionCarryByLength={};delete budget.firstStepPositiveShares;
 let P=0,Z=0;const min={positive:0,neutral:0},max={positive:0,neutral:0};
 for(const length of [3,4,5,6,7,8]){
  const tally={total:0,positive:0,reverse:0,neutral:0};
  for(const row of reference.slice(budget.from-1,budget.to))for(const key of Object.keys(tally))tally[key]+=row[length]?.[key]??0;
  const shares=Object.fromEntries(['positive','reverse','neutral'].map(key=>[key,tally.total?tally[key]/tally.total:key==='reverse'?1:0]));
  budget.referenceDirectionCounts[length]=tally;budget.directionSharesByLength[length]=shares;budget.directionCarryByLength[length]={positive:0,reverse:0,neutral:0};
  const preferred=weightedOptions(budget.targets['length:'+length],shares,policy.directionPolicy).preferred;
  const pairs=directionPairs(budget,length);
  for(const name of ['positive','neutral']){
   budget.targets[name+':'+length]=preferred[name];budget.ranges[name+':'+length]=[Math.min(...pairs.map(pair=>pair[name])),Math.max(...pairs.map(pair=>pair[name]))];
   min[name]+=budget.ranges[name+':'+length][0];max[name]+=budget.ranges[name+':'+length][1];
  }
  P+=preferred.positive;Z+=preferred.neutral;
 }
 budget.targets.positive=P;budget.ranges.positive=[min.positive,max.positive];budget.targets.neutral=Z;budget.ranges.neutral=[min.neutral,max.neutral];
 for(const row of plan.records.filter(row=>budget.from<=row.position&&row.position<=budget.to)){
  Object.assign(row.targetComposition,{stageBudgetId:budget.id,directionMetric:WORD_DIRECTION_POLICY.id,directionSharesByLength:budget.directionSharesByLength});
  delete row.targetComposition.firstStepPositiveShares;
 }
}
plan.provenance.weightedDirectionSources=sources;
for(const row of plan.records)for(const [key,value]of Object.entries(base.records.find(old=>old.position===row.position)))if(key!=='targetComposition')assert.deepEqual(row[key],value);
validateLevelPlan(plan);
fs.writeFileSync(new URL('level-editor/dist/data/level-plan-weighted-first-50.json',root),JSON.stringify(plan,null,2)+'\n');
console.log(JSON.stringify({id:plan.id,stages:plan.stageBudgets.map(b=>({from:b.from,to:b.to,reference:b.referenceDirectionCounts,positive:b.targets.positive,neutral:b.targets.neutral}))}));
