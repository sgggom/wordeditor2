import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const python=process.env.WORD_BUDGET_PYTHON,script=fileURLToPath(new URL('../scripts/lib/solve-stage-candidates.py',import.meta.url));
const solve=request=>{const result=spawnSync(python,[script],{input:JSON.stringify(request),encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
const candidate=(id,words,positive,cost=0)=>({id,words,bag:id,cost,metrics:{'length:3':2,'positive:3':positive,positive}});
test('joint level selection enforces cooldown between actual candidates',{skip:!python},()=>{
 const request={budget:{ranges:{'length:3':[4,4],'positive:3':[3,3],positive:[3,3]}},used:{},previousWords:0,
  rows:[{position:6,targetCount:2,candidates:[candidate('a',['ATE','EAT'],2)]},
   {position:7,targetCount:2,candidates:[candidate('b',['ATE','TEA'],1),candidate('c',['DOG','CAT'],1,10)]}]};
 assert.deepEqual(solve(request).selected,['a','c']);
 request.rows[1].candidates.pop();assert.equal(solve(request).feasible,false);
});
test('a valid final direction total cannot bypass configured prefix pacing',{skip:!python},()=>{
 const targets=Object.fromEntries([3,4,5,6,7,8].flatMap(length=>[['length:'+length,length===3?4:0],['positive:'+length,length===3?2:0]]));targets.positive=2;
 const budget={targets,targetTotal:4,ranges:{'length:3':[4,4],'positive:3':[2,2],positive:[2,2]},
  directionPacing:{maximumDebt:0,maximumDebtByLength:Object.fromEntries([3,4,5,6,7,8].map(length=>[length,0]))}};
 const request={budget,used:{},previousWords:0,rows:[{position:6,targetCount:2,candidates:[candidate('a',['ATE','EAT'],0)]},
  {position:7,targetCount:2,candidates:[candidate('b',['DOG','CAT'],2)]}]};
 assert.equal(solve(request).feasible,false);
 request.rows[0].candidates[0]=candidate('a',['ATE','EAT'],1);request.rows[1].candidates[0]=candidate('b',['DOG','CAT'],1);
 assert.ok(solve(request).feasible);
});
