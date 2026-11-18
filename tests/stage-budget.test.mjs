import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateLevelPlan} from '../scripts/lib/level-plan.mjs';
import {measureComposition,compareComposition} from '../scripts/lib/target-composition.mjs';
import {createStageContext,checkStageCandidate,checkStageComplete,templateMetrics} from '../scripts/lib/stage-budget.mjs';

const level=(lengths,positive=true)=>({columns:3,targetWords:lengths.map((length,index)=>({word:String.fromCharCode(65+index).repeat(length),
 path:positive?[0,1,2,5,4,3,6,7].slice(0,length):[1,0,3,4,5,8,7,6].slice(0,length)}))});
const row=(position,templates)=>({position,targetCount:templates[0].reduce((a,b)=>a+b),targetComposition:{allowedTemplates:templates}});

test('stage lookahead reserves remaining length slots and prevents overshoot',()=>{
 const budget={id:'test',from:6,to:7,levels:2,targetTotal:4,targets:{'length:3':2,'length:4':2},ranges:{'length:3':[2,2],'length:4':[2,2]}};
 const current=row(6,[[1,1,0,0,0,0]]),future=row(7,[[1,1,0,0,0,0]]);
 const context=createStageContext(budget,current,[],[future]);
 assert.ok(checkStageCandidate(measureComposition(level([3,4])),context));
 assert.equal(checkStageCandidate(measureComposition(level([3,3])),context),false);
 assert.equal(checkStageCandidate(measureComposition(level([4,4])),context),false);
});

test('exact 7/8 budgets cannot both reserve the same single future long slot',()=>{
 const budget={id:'longs',from:6,to:7,levels:2,targetTotal:4,targets:{},ranges:{'length:6':[0,1],'length:7':[1,1],'length:8':[1,1]}};
 const context=createStageContext(budget,row(6,[[1,0,0,1,0,0]]),[],[row(7,[[1,0,0,0,1,0],[1,0,0,0,0,1]])]);
 assert.equal(checkStageCandidate(measureComposition(level([3,6])),context),false);
});

test('lookahead requires one jointly feasible future template rather than independent marginal bounds',()=>{
 const budget={id:'joint',from:6,to:7,levels:2,targetTotal:7,targets:{},ranges:{'length:3':[3,3],'length:4':[3,3],'length:5':[1,1]}};
 const context=createStageContext(budget,row(6,[[1,1,1,0,0,0]]),[],[row(7,[[1,3,0,0,0,0],[3,1,0,0,0,0]])]);
 assert.equal(checkStageCandidate(measureComposition(level([3,4,5])),context),false);
});
test('joint lookahead prunes incompatible allocations across three remaining levels',()=>{
 const budget={id:'three-future',from:6,to:9,levels:4,targetTotal:7,targets:{},ranges:{'length:3':[3,3],'length:4':[3,3],'length:5':[1,1]}};
 const options=[[1,1,0,0,0,0],[0,0,2,0,0,0]];
 const context=createStageContext(budget,row(6,[[1,0,0,0,0,0]]),[],[row(7,options),row(8,options),row(9,options)]);
 assert.equal(checkStageCandidate(measureComposition(level([3])),context),false);
});

test('first-step quotas reject reverse-heavy results at final acceptance',()=>{
 const budget={id:'direction',from:6,to:6,levels:1,targetTotal:2,targets:{positive:2},ranges:{positive:[2,2]}};
 const context=createStageContext(budget,row(6,[[1,1,0,0,0,0]]),[],[]);
 assert.ok(checkStageCandidate(measureComposition(level([3,4])),context));
 assert.equal(checkStageCandidate(measureComposition(level([3,4],false)),context),false);
 assert.equal(checkStageComplete(budget,[level([3,4],false)]).passed,false);
 assert.ok(checkStageComplete(budget,[level([3,4])]).passed);
});
test('direction pacing prevents a feasible final quota from accumulating excessive early debt',()=>{
 const budget={id:'pacing',from:6,to:7,levels:2,targetTotal:10,targets:{'length:3':10,'positive:3':8,positive:8},
  ranges:{'length:3':[10,10],'positive:3':[7,9],positive:[7,9]}};
 const current=row(6,[[5,0,0,0,0,0]]),future=row(7,[[5,0,0,0,0,0]]);
 const composition=measureComposition(level([3,3,3,3,3]));composition.firstSteps[3].positive=2;
 assert.ok(checkStageCandidate(composition,createStageContext(budget,current,[],[future])));
 budget.directionPacing={maximumDebt:1,maximumDebtByLength:{3:1}};
 assert.equal(checkStageCandidate(composition,createStageContext(budget,current,[],[future])),false);
 composition.firstSteps[3].positive=3;
 assert.ok(checkStageCandidate(composition,createStageContext(budget,current,[],[future])));
});

test('per-level templates distinguish long lengths even when aggregate 6+ count is unchanged',()=>{
 const config={noThreeLetter:false,minimumDistinctLengths:2,allowedTemplates:[[1,0,0,0,1,0]],preferredCounts:[1,0,0,1]};
 assert.ok(compareComposition(measureComposition(level([3,7])),config).passed);
 assert.ok(compareComposition(measureComposition(level([3,8])),config).violations.includes('compositionTemplate'));
});

test('compiled first-50 quotas fit our own word totals and preserve all original core rows',()=>{
 const read=file=>JSON.parse(fs.readFileSync(new URL(file,import.meta.url)));
 const plan=read('../../outputs/20261112-stage-budget-first-50/plan.json');
 const base=read('../dist/data/level-plan.json');validateLevelPlan(plan);assert.equal(plan.records.length,45);
 for(const current of plan.records){
  const original=base.records.find(row=>row.position===current.position);
  for(const [key,value]of Object.entries(original))if(key!=='targetComposition')assert.deepEqual(current[key],value);
  assert.ok(current.targetComposition.allowedTemplates.length);
 }
 assert.equal(plan.stageBudgets.reduce((sum,budget)=>sum+budget.targetTotal,0),299);
 for(const budget of plan.stageBudgets){
  const rows=plan.records.filter(row=>row.position>=budget.from&&row.position<=budget.to);
  const totals={};
  for(const current of rows){
   const vector=[3,4,5,6,7,8].map(length=>current.targetComposition.preferredLengths.filter(value=>value===length).length);
   assert.ok(current.targetComposition.allowedTemplates.some(template=>template.every((n,i)=>n===vector[i])));
   for(const [key,value]of Object.entries(templateMetrics(vector)))totals[key]=(totals[key]??0)+value;
  }
  for(const [key,range]of Object.entries(budget.ranges))if(!key.startsWith('positive'))assert.ok((totals[key]??0)>=range[0]&&(totals[key]??0)<=range[1],key);
 }
});
