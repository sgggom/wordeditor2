import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPresetRecords} from '../dist/preset-level-lists.js';
import {measureComposition} from './lib/target-composition.mjs';
import {directionPairs,positiveOptions} from './lib/direction-policy.mjs';
const root=new URL('../../',import.meta.url),sources={};
const read=file=>{const bytes=fs.readFileSync(new URL(file,root));sources[file]=createHash('sha256').update(bytes).digest('hex');return JSON.parse(bytes);};
const base=read('outputs/20261112-stage-budget-first-50/plan.json'),policy=read('level-editor/dist/data/stage-tightening-policy.json');
const reference=createPresetRecords(read('level-editor/dist/data/presets/word-tiles-list0.json').slice(0,50),'word-tiles').map(record=>measureComposition(record.level));
const plan=structuredClone(base);plan.id='our-level-plan-tightened-first-50-20261113';plan.parentPlanId=base.id;plan.tighteningPolicy=policy.id;
for(const budget of plan.stageBudgets){
 budget.directionPolicy=policy.directionPolicy;budget.referenceDirectionCounts={};budget.directionCarryByLength=Object.fromEntries([3,4,5,6,7,8].map(length=>[length,0]));
 if(budget.from===31){
  const set=(key,entry)=>{budget.targets[key]=entry.target;budget.ranges[key]=entry.range;};
  for(const [count,entry]of Object.entries(policy.stage31To50.fiveHistogram))set('hist:5:'+count,entry);
  for(const [count,entry]of Object.entries(policy.stage31To50.varietyHistogram))set('variety:'+count,entry);
  for(const [length,count]of Object.entries(policy.stage31To50.rareLengthCounts))set('length:'+length,{target:count,range:[count,count]});
  budget.fiveCoverage=policy.stage31To50.fiveCoverage;
 }
 let positiveTarget=0,minPositive=0,maxPositive=0;
 for(const length of [3,4,5,6,7,8]){
  const tallies=reference.slice(budget.from-1,budget.to).map(composition=>composition.firstSteps[length]).filter(Boolean);
  const total=tallies.reduce((sum,tally)=>sum+tally.total,0),positive=tallies.reduce((sum,tally)=>sum+tally.positive,0);
  budget.referenceDirectionCounts[length]={total,positive};
  budget.firstStepPositiveShares[length]=total?positive/total:0;
  const pairs=directionPairs(budget,length),preferred=positiveOptions(budget.targets['length:'+length],budget.firstStepPositiveShares[length],budget.directionPolicy).preferred;
  budget.targets['positive:'+length]=preferred;budget.ranges['positive:'+length]=[Math.min(...pairs.map(pair=>pair.positive)),Math.max(...pairs.map(pair=>pair.positive))];
  positiveTarget+=preferred;minPositive+=budget.ranges['positive:'+length][0];maxPositive+=budget.ranges['positive:'+length][1];
 }
 budget.targets.positive=positiveTarget;budget.ranges.positive=[minPositive,maxPositive];
 for(const row of plan.records.filter(row=>budget.from<=row.position&&row.position<=budget.to)){
  Object.assign(row.targetComposition.firstStepPositiveShares,budget.firstStepPositiveShares);
  if(budget.from===31)row.targetComposition.weights.firstStep=5;
 }
}
for(const row of plan.records){const original=base.records.find(original=>original.position===row.position);for(const [key,value]of Object.entries(original))if(key!=='targetComposition')assert.deepEqual(row[key],value);}
plan.provenance.tighteningSources=sources;
fs.writeFileSync(new URL('level-editor/dist/data/level-plan-tightened-first-50.json',root),JSON.stringify(plan,null,2)+'\n');
console.log(JSON.stringify({planId:plan.id,stages:plan.stageBudgets.map(budget=>({from:budget.from,to:budget.to,directions:budget.firstStepPositiveShares,fiveCoverage:budget.fiveCoverage??null}))}));
