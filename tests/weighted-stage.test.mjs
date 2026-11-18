import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {weightedOptions,directionPairs,nextWeightedCarry} from '../scripts/lib/direction-policy.mjs';
import {stageMetrics,createStageContext,checkStageCandidate,checkStageComplete} from '../scripts/lib/stage-budget.mjs';
import {measureComposition} from '../scripts/lib/target-composition.mjs';
const python=process.env.WORD_BUDGET_PYTHON,policy={largeSampleMinimum:20,largeSampleTolerancePoints:2};
const metric='weighted-path-direction-20261113',zero={positive:0,reverse:1,neutral:0};
const solve=request=>{const r=spawnSync(python,['scripts/lib/solve-tightened-stage.py'],{input:JSON.stringify(request),encoding:'utf8',timeout:45000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
function budget(){const ranges={},targets={},shares={};for(const n of [3,4,5,6,7,8]){ranges['length:'+n]=[n===4?2:0,n===4?2:0];targets['length:'+n]=n===4?2:0;ranges['positive:'+n]=[0,2];ranges['neutral:'+n]=[0,2];shares[n]=n===4?{positive:.5,reverse:0,neutral:.5}:zero;}return{directionMetric:metric,directionPolicy:policy,directionSharesByLength:shares,ranges,targets};}
test('three-way rounding preserves the word total and reports no fictional reverse words',()=>{
 const shares={positive:19/23,reverse:1/23,neutral:3/23},a=weightedOptions(20,shares,policy);
 assert.deepEqual(a.preferred,{positive:16,reverse:1,neutral:3});assert.deepEqual(a.allowed,[a.preferred]);
 const first=weightedOptions(1,{positive:.5,reverse:.5,neutral:0},policy).preferred;
 const carry=nextWeightedCarry({},1,{positive:.5,reverse:.5,neutral:0},first);
 assert.equal(weightedOptions(1,{positive:.5,reverse:.5,neutral:0},policy,carry).preferred.reverse,1);
 assert.equal(weightedOptions(3,{positive:.5,reverse:.5,neutral:0},policy,carry).preferred.reverse,2);
});
test('JS and Python agree on three-way counts and tolerance boundaries',{skip:!python},()=>{
 const cases=[];for(let N=0;N<=90;N++)for(const shares of [{positive:.5,reverse:.5,neutral:0},{positive:19/31,reverse:3/31,neutral:9/31},{positive:19/23,reverse:1/23,neutral:3/23}])cases.push({N,shares,policy});
 assert.deepEqual(solve({mode:'weighted-options',cases}),cases.map(c=>weightedOptions(c.N,c.shares,c.policy)));
});
test('stage acceptance uses whole paths and neutral capacity rather than the first edge',()=>{
 const b=budget(),positive={columns:4,targetWords:[{word:'ABCD',path:[0,1,2,3]}]},neutral={columns:4,targetWords:[{word:'EFGH',path:[3,7,6,5]}]};
 assert.equal(stageMetrics([neutral],b)['neutral:4'],1);
 assert.equal(stageMetrics([neutral],b)['positive:4'],0);
 assert.ok(checkStageComplete({...b,levels:2},[positive,neutral]).passed);
 const row={position:2,targetCount:1},context=createStageContext(b,row,[positive],[]);
 assert.ok(checkStageCandidate(measureComposition(neutral),context));
 assert.equal(checkStageCandidate(measureComposition(positive),context),false);
});
test('candidate and tail solvers enforce a neutral word independently of reverse words',{skip:!python},()=>{
 const b=budget(),candidate=(id,P,Z)=>({id,bag:id,words:[id],cost:0,metrics:{'length:4':1,'positive:4':P,'neutral:4':Z,positive:P,neutral:Z}});
 const request={budget:b,used:{},rows:[{position:1,targetCount:1,candidates:[candidate('p',1,0)]},{position:2,targetCount:1,candidates:[candidate('r',0,0),candidate('z',0,1)]}]};
 assert.deepEqual(solve(request).selected,['p','z']);request.rows[1].candidates.pop();assert.equal(solve(request).feasible,false);
 assert.equal(solve({mode:'tail',budget:b,used:{'length:4':1,'positive:4':1,positive:1},rows:[{position:2,targetCount:1,targetComposition:{allowedTemplates:[[0,1,0,0,0,0]]}}]}).feasible,true);
});
test('weighted plan preserves core planning and records the new competitor rates',()=>{
 const read=file=>JSON.parse(fs.readFileSync(file)),plan=read('dist/data/level-plan-weighted-first-50.json'),old=read('dist/data/level-plan-tightened-first-50.json');
 for(const row of plan.records)for(const [key,value]of Object.entries(old.records.find(r=>r.position===row.position)))if(key!=='targetComposition')assert.deepEqual(row[key],value);
 assert.equal(plan.stageBudgets[2].directionSharesByLength[5].positive,25/28);
 assert.equal(plan.stageBudgets[2].directionSharesByLength[8].positive,1);
 assert.ok(directionPairs(plan.stageBudgets[0],4).every(row=>row.positive+row.reverse+row.neutral===row.N));
});
test('board preservation precedes cheaper duplicate candidates in supplementation mode',{skip:!python},()=>{
 const b=budget();b.preserveBoards=true;
 const c=(id,kept,cost)=>({id,preservedBoard:kept,cost,bag:'shared',words:['SAME'],metrics:{'length:4':2,'positive:4':1,'neutral:4':1,positive:1,neutral:1}});
 for(const backend of ['auto','milp']){
  const result=solve({backend,budget:b,used:{},rows:[{position:1,targetCount:2,candidates:[c('new',false,0),c('kept',true,100)]}]});
  assert.deepEqual(result.selected,['kept']);
 }
});
