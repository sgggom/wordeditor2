import { readPlanningSource } from "./planning-source.mjs";
import test from 'node:test';import assert from 'node:assert/strict';import{createHash}from'node:crypto';
import{createPresetRecords}from'../dist/preset-level-lists.js';import{measureWordDirections}from'../dist/word-direction.js';import{validateLevelPlan}from'../scripts/lib/level-plan.mjs';
const read = file => JSON.parse(readPlanningSource(file));
const parent=read('level-editor/dist/data/level-plan-target-floor-first-500-r2.json'),raw=read('level-editor/dist/data/level-plan-target-floor-first-1000.json'),plan=read('level-editor/dist/data/level-plan-target-floor-first-1000-r2.json'),config=read('level-editor/dist/data/target-floor-1000-budget-consistency.json');
test('1000-level continuation freezes all approved 500 levels and their stage budgets',()=>{
 validateLevelPlan(plan);assert.equal(plan.records.length,995);assert.equal(plan.parentPlanId,parent.id);assert.equal(plan.continuation.preservedThrough,500);
 assert.deepEqual(plan.records.slice(0,495),parent.records);assert.deepEqual(plan.stageBudgets.filter(b=>b.to<=500),parent.stageBudgets);
 const bytes=readPlanningSource(plan.continuation.prefixFile);assert.equal(JSON.parse(bytes).level.length,500);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),plan.continuation.prefixSha256);
 assert.equal(plan.continuation.prefixSha256,'1756ad011e087b882473da14b8a975b8021a9fb770b46e008105535f98feba6e');
});
test('501–1000 preserve board and difficulty schedules and meet both target floors',()=>{
 const base=read('level-editor/dist/data/level-plan.json'),peers=createPresetRecords(read('level-editor/dist/data/presets/word-tiles-list0.json').slice(0,1000),'word-tiles');
 const rows=plan.records.filter(r=>r.position>500);assert.equal(rows.length,500);assert.equal(rows.reduce((s,r)=>s+r.targetCount,0),5503);
 for(const row of rows){const original=base.records.find(r=>r.position===row.position);
  for(const key of ['rows','columns','activeCells','boardMask','shapeId','special','difficulty','type'])assert.deepEqual(row[key],original[key]);
  assert.equal(row.targetCount,Math.max(original.targetCount,peers[row.position-1].level.targetWords.length));
  assert.ok(row.scoreProfiles.every(v=>v.every((n,i)=>n>=original.scoreCounts[i])));
 }
});
test('all 25 new stages use the corresponding length-specific competitor directions',()=>{
 const dictionary=['required','guide','extra'].flatMap(n=>read(`level-editor/dist/data/${n}-words.json`));
 const peers=createPresetRecords(read('level-editor/dist/data/presets/word-tiles-list0.json').slice(0,1000),'word-tiles',dictionary).map(r=>r.level),stages=plan.stageBudgets.filter(b=>b.from>500);assert.equal(stages.length,25);
 for(const b of stages)for(const n of [3,4,5,6,7,8]){const tally={total:0,positive:0,reverse:0,neutral:0};
  for(const l of peers.slice(b.from-1,b.to))for(const key of Object.keys(tally))tally[key]+=measureWordDirections(l)[n]?.[key]??0;
  assert.deepEqual(b.referenceDirectionCounts[n],tally);assert.ok(b.ranges['length:'+n][0]>=tally.total);
  for(const key of ['positive','reverse','neutral'])assert.equal(b.directionSharesByLength[n][key],tally.total?tally[key]/tally.total:key==='reverse'?1:0);
 }
});
test('consistency corrections change only the recorded new-stage ranges',()=>{
 assert.equal(plan.revisionOf,raw.id);assert.deepEqual(plan.records,raw.records);assert.deepEqual(plan.continuation,raw.continuation);
 assert.equal(createHash('sha256').update(readPlanningSource(config.sourcePlanFile)).digest('hex'),config.sourcePlanSha256);
 const expected=structuredClone(raw.stageBudgets);
 for(const c of config.adjustments){assert.ok(c.from>500);assert.match(c.metric,/^(hist:|variety:)/);const b=expected.find(b=>b.from===c.from);assert.deepEqual(b.ranges[c.metric],c.previousRange);b.ranges[c.metric]=c.range;}
 assert.deepEqual(plan.stageBudgets,expected);assert.equal(config.verifiedStages,25);
});
test('long-word minima fit the combined zero, single and double-long level ranges',()=>{
 for(const b of plan.stageBudgets.filter(b=>b.from>500)){let capacity=-1;
  for(let zero=b.ranges['hist:6+:0'][0];zero<=b.ranges['hist:6+:0'][1];zero++)for(let two=b.ranges['hist:6+:2'][0];two<=b.ranges['hist:6+:2'][1];two++){
   const one=20-zero-two;if(one>=b.ranges['hist:6+:1'][0]&&one<=b.ranges['hist:6+:1'][1])capacity=Math.max(capacity,one+two*2);
  }
  assert.ok([6,7,8].reduce((s,n)=>s+b.ranges['length:'+n][0],0)<=capacity,`${b.from}–${b.to}`);
 }
});
