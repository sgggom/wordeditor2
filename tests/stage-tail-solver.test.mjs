import test from 'node:test';
import assert from 'node:assert/strict';
import {createStageTailSolver} from '../scripts/lib/stage-tail.mjs';

const python=process.env.WORD_BUDGET_PYTHON;
const row=(position,templates)=>({position,targetCount:templates[0].reduce((a,b)=>a+b),targetComposition:{allowedTemplates:templates}});
test('whole-tail solver rejects incompatible joint allocations beyond the three-level lookahead',{skip:!python},()=>{
 const solve=createStageTailSolver(python),options=[[1,1,0,0,0,0],[0,0,2,0,0,0]];
 const request={budget:{id:'four-tail',ranges:{'length:3':[4,4],'length:4':[3,3],'length:5':[1,1]}},used:{},rows:[6,7,8,9].map(position=>row(position,options))};
 assert.equal(solve(request).feasible,false);
 request.budget={id:'feasible-tail',ranges:{'length:3':[3,3],'length:4':[3,3],'length:5':[2,2]}};
 const result=solve(request);assert.ok(result.feasible);assert.equal(result.templates.length,4);
 assert.equal(result.templates.reduce((sum,entry)=>sum+entry.vector[2],0),2);
 assert.deepEqual(solve(request),result);assert.equal(solve.stats.cacheHits,1);
});
test('overall positive quota must fit the exact per-length positive capacities',{skip:!python},()=>{
 const solve=createStageTailSolver(python),request={budget:{id:'directions',ranges:{'length:3':[1,1],'length:4':[1,1],
  'positive:3':[1,1],'positive:4':[0,0],positive:[2,2]}},used:{},rows:[row(6,[[1,1,0,0,0,0]])]};
 assert.equal(solve(request).feasible,false);
 request.budget={...request.budget,id:'directions-valid',ranges:{...request.budget.ranges,positive:[1,1]}};
 assert.ok(solve(request).feasible);
});
