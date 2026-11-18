import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {positiveOptions,nextDirectionCarry,assessDirections} from '../scripts/lib/direction-policy.mjs';
import {checkStageComplete} from '../scripts/lib/stage-budget.mjs';
import {validateLevelPlan} from '../scripts/lib/level-plan.mjs';
const python=process.env.WORD_BUDGET_PYTHON,script=fileURLToPath(new URL('../scripts/lib/solve-tightened-stage.py',import.meta.url));
const policy={largeSampleMinimum:20,largeSampleTolerancePoints:2};
function solve(request){const result=spawnSync(python,[script],{input:JSON.stringify(request),encoding:'utf8',timeout:45000});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
function budget(counts,rates){
 const ranges={},targets={},shares={};let total=0,positive=0;
 for(const length of [3,4,5,6,7,8]){const N=counts[length]??0,rate=rates[length]??0;ranges['length:'+length]=[N,N];ranges['positive:'+length]=[0,N];targets['length:'+length]=N;targets['positive:'+length]=positiveOptions(N,rate,policy).preferred;shares[length]=rate;total+=N;positive+=targets['positive:'+length];}
 ranges.positive=[0,total];targets.positive=positive;
 return {id:'test',targetTotal:total,targets,ranges,firstStepPositiveShares:shares,directionPolicy:policy};
}
const candidate=(id,length,N,P,cost=0)=>({id,bag:id,words:[id],cost,metrics:{['length:'+length]:N,['positive:'+length]:P,positive:P}});
test('directions use actual counts, integer fallback, and singleton carry',()=>{
 assert.deepEqual(positiveOptions(59,17/23,policy).allowed,[43,44]);
 assert.deepEqual(positiveOptions(57,17/23,policy).allowed,[41,42,43]);
 assert.deepEqual(positiveOptions(20,19/23,policy).allowed,[17]);
 assert.deepEqual(positiveOptions(9,8/11,policy).allowed,[7]);
 assert.deepEqual(positiveOptions(2,2/3,policy).allowed,[1]);
 const first=positiveOptions(1,.5,policy).preferred,carry=nextDirectionCarry(0,1,.5,first);
 assert.equal(first,1);assert.equal(positiveOptions(1,.5,policy,carry).preferred,0);
 const b=budget({6:7,7:2,8:2},{6:.75,7:.5,8:2/3});
 const rows=assessDirections(b,{'length:6':7,'positive:6':4,'length:7':2,'positive:7':2,'length:8':2,'positive:8':2});
 assert.ok(rows.filter(row=>row.N).every(row=>!row.passed));
});
test('JS and Python agree on all rounding boundaries',{skip:!python},()=>{
 const cases=[];for(let N=0;N<=100;N++)for(const rate of [0,.5,2/3,.75,19/23,40/42,1])for(const carry of [-.5,0,.5])cases.push({N,rate,policy,carry});
 assert.deepEqual(solve({mode:'direction-options',cases}),cases.map(row=>positiveOptions(row.N,row.rate,row.policy,row.carry)));
});
test('conditional integer pairs exclude an all-positive rare length',{skip:!python},()=>{
 const b=budget({7:2},{7:.5}),request={budget:b,used:{},rows:[{position:31,targetCount:1,candidates:[candidate('a',7,1,1)]},{position:32,targetCount:1,candidates:[candidate('b',7,1,1),candidate('c',7,1,0,10)]}]};
 assert.deepEqual(solve(request).selected,['a','c']);request.rows[1].candidates.pop();assert.equal(solve(request).feasible,false);
});
test('stage center takes precedence over cheaper individual candidates',{skip:!python},()=>{
 const b=budget({3:50},{3:.8}),result=solve({budget:b,used:{},rows:[{position:31,targetCount:50,candidates:[candidate('edge',3,50,39),candidate('center',3,50,40,100)]}]});
 assert.deepEqual(result.selected,['center']);
});
test('orientation families retain direction choices while sharing word conflicts',{skip:!python},()=>{
 const b=budget({7:2},{7:.5}),variant=(id,P,words,bag,cost=0)=>({...candidate(id,7,1,P,cost),words,bag});
 const result=solve({budget:b,used:{},rows:[
  {position:31,targetCount:1,candidates:[variant('reverse',0,['SHARED'],'same'),variant('forward',1,['SHARED'],'same')]},
  {position:32,targetCount:1,candidates:[variant('collision',1,['SHARED'],'other'),variant('safe',1,['UNIQUE'],'safe',10)]}
 ]});
 assert.deepEqual(result.selected,['reverse','safe']);
});
test('tail directions cannot borrow positive words from another length',{skip:!python},()=>{
 const b=budget({3:1,7:2},{3:1,7:.5}),request={mode:'tail',budget:b,used:{'length:7':2,'positive:7':0,positive:0},rows:[{position:32,targetCount:1,targetComposition:{allowedTemplates:[[1,0,0,0,0,0]]}}]};
 assert.equal(solve(request).feasible,false);request.used['positive:7']=1;request.used.positive=1;assert.ok(solve(request).feasible);
});
test('coverage validates both five-level blocks and consecutive empty levels',{skip:!python},()=>{
 const b={from:31,to:40,levels:10,targets:{},ranges:{},fiveCoverage:{allowedLevels:[8,8],perFiveLevelsMinimum:4,maxConsecutiveZeroLevels:1}};
 const make=zeros=>Object.fromEntries(Array.from({length:10},(_,i)=>[31+i,!zeros.includes(31+i)]));
 for(const [zeros,expected]of [[[31,32],false],[[35,36],false],[[31,36],true]]){
  const flags=make(zeros);assert.equal(solve({mode:'tail',budget:b,used:{},rows:[],fivePresence:flags}).feasible,expected);
  const levels=Object.values(flags).map(flag=>({columns:5,targetWords:[{word:'A'.repeat(flag?5:4),path:flag?[0,1,2,3,4]:[0,1,2,3]}]}));
  assert.equal(checkStageComplete(b,levels).passed,expected);
 }
});
test('compiled tightened plan preserves every core row and uses raw stage rates',()=>{
 const read=file=>JSON.parse(fs.readFileSync(new URL(file,import.meta.url))),plan=read('../dist/data/level-plan-tightened-first-50.json'),old=read('../../outputs/20261112-stage-budget-first-50/plan.json');
 validateLevelPlan(plan);assert.equal(plan.records.length,45);
 for(const row of plan.records)for(const [key,value]of Object.entries(old.records.find(original=>original.position===row.position)))if(key!=='targetComposition')assert.deepEqual(row[key],value);
 assert.equal(plan.stageBudgets[0].firstStepPositiveShares[5],1);assert.equal(plan.stageBudgets[1].firstStepPositiveShares[6],.5);
 assert.deepEqual(plan.stageBudgets[2].ranges['hist:5:0'],[2,3]);assert.deepEqual(plan.stageBudgets[2].ranges['variety:4'],[8,9]);
});
