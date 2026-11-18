import { readPlanningSource } from "./planning-source.mjs";
import assert from 'node:assert/strict';

import {createHash} from 'node:crypto';
import test from 'node:test';

const read = file => JSON.parse(readPlanningSource(file));
const base=read('level-editor/dist/data/level-plan-target-floor-first-500.json');
const plan=read('level-editor/dist/data/level-plan-target-floor-first-500-r2.json');
const config=read('level-editor/dist/data/target-floor-500-budget-consistency.json');

test('the feasible revision preserves every level and all accepted stage budgets',()=>{
  assert.equal(plan.revisionOf,base.id);
  assert.deepEqual(plan.records,base.records);
  assert.deepEqual(plan.continuation,base.continuation);
  assert.deepEqual(plan.stageBudgets.filter(b=>b.to<=320),base.stageBudgets.filter(b=>b.to<=320));
  const bytes=readPlanningSource(config.sourcePlanFile);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),config.sourcePlanSha256);
  assert.deepEqual(config.adjustments.map(c=>[c.from,c.to,c.range[1]-c.previousRange[1]]),[[321,340,1],[341,360,2],[461,480,1]]);
  const expected=structuredClone(base.stageBudgets);
  for(const change of config.adjustments)expected.find(b=>b.from===change.from).ranges[change.metric]=change.range;
  assert.deepEqual(plan.stageBudgets,expected);
});

test('long target minima fit within the allowed level distribution in every new stage',()=>{
  for(const b of plan.stageBudgets.filter(b=>b.from>200)){
    const minimum=[6,7,8].reduce((sum,n)=>sum+b.ranges['length:'+n][0],0);
    let capacity=-1;
    for(let zero=b.ranges['hist:6+:0'][0];zero<=b.ranges['hist:6+:0'][1];zero++){
      for(let pair=b.ranges['hist:6+:2'][0];pair<=b.ranges['hist:6+:2'][1];pair++){
        const single=b.levels-zero-pair;
        if(single>=b.ranges['hist:6+:1'][0]&&single<=b.ranges['hist:6+:1'][1])capacity=Math.max(capacity,single+2*pair);
      }
    }
    assert.ok(minimum<=capacity,`${b.from}–${b.to}: ${minimum} long targets exceed ${capacity} slots`);
  }
});
