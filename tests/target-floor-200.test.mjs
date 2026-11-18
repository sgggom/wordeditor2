import { readPlanningSource } from "./planning-source.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';

import {createHash} from 'node:crypto';
import {createPresetRecords} from '../dist/preset-level-lists.js';
import {measureWordDirections} from '../dist/word-direction.js';
import {validateLevelPlan} from '../scripts/lib/level-plan.mjs';
const read = file => JSON.parse(readPlanningSource(file));
const plan=read('level-editor/dist/data/level-plan-target-floor-first-200.json');
test('200-level extension freezes the amended 100-level prefix and all previous constraints',()=>{
 const parent=read('level-editor/dist/data/level-plan-target-floor-first-100.json');validateLevelPlan(plan);
 assert.equal(plan.parentPlanId,parent.id);assert.equal(plan.records.length,195);
 assert.deepEqual(plan.records.slice(0,95),parent.records);assert.deepEqual(plan.stageBudgets.slice(0,6),parent.stageBudgets);
 assert.equal(plan.continuation.preservedThrough,100);
 assert.equal(createHash('sha256').update(readPlanningSource(plan.continuation.prefixFile)).digest('hex'),plan.continuation.prefixSha256);
 const prefix=read(plan.continuation.prefixFile);assert.equal(prefix.level.length,100);
 assert.equal(prefix.level[2].c,'BOX SKY CITY');assert.equal(prefix.level[3].c,'FAN WEB BOMB');
});
test('101–200 independently retain layout, difficulty slots, and the per-level target floor',()=>{
 const base=read('level-editor/dist/data/level-plan.json');
 const peers=createPresetRecords(read('level-editor/dist/data/presets/word-tiles-list0.json').slice(0,200),'word-tiles');
 for(const row of plan.records.filter(row=>row.position>100)){
  const original=base.records.find(r=>r.position===row.position);
  for(const key of ['rows','columns','activeCells','boardMask','shapeId','special','difficulty','type'])assert.deepEqual(row[key],original[key]);
  assert.equal(row.targetCount,Math.max(original.targetCount,peers[row.position-1].level.targetWords.length));
  assert.ok(row.scoreProfiles.every(profile=>profile.every((n,i)=>n>=original.scoreCounts[i])));
 }
});
test('five new stages use the corresponding weighted reference directions and separate 6/7/8 counts',()=>{
 const dictionary=['required','guide','extra'].flatMap(n=>read(`level-editor/dist/data/${n}-words.json`));
 const peers=createPresetRecords(read('level-editor/dist/data/presets/word-tiles-list0.json').slice(0,200),'word-tiles',dictionary).map(r=>r.level);
 assert.equal(plan.stageBudgets.filter(b=>b.from>100).length,5);
 for(const b of plan.stageBudgets.filter(b=>b.from>100))for(const n of [3,4,5,6,7,8]){
  const tally={total:0,positive:0,reverse:0,neutral:0};
  for(const level of peers.slice(b.from-1,b.to))for(const key of Object.keys(tally))tally[key]+=measureWordDirections(level)[n]?.[key]??0;
  assert.deepEqual(b.referenceDirectionCounts[n],tally);assert.ok(b.ranges['length:'+n][0]>=tally.total);
  for(const key of ['positive','reverse','neutral'])assert.equal(b.directionSharesByLength[n][key],tally.total?tally[key]/tally.total:key==='reverse'?1:0);
 }
});
test('extra targets can retain simple score slots without proportionally raising the original difficulty floor',()=>{
 const base=read('level-editor/dist/data/level-plan.json');
 for(const row of plan.records.filter(r=>r.addedTargetScoring)){
  const original=base.records.find(r=>r.position===row.position),extra=row.targetCount-original.targetCount;
  assert.ok(row.scoreProfiles.some(profile=>profile[0]===original.scoreCounts[0]+extra&&profile.slice(1).every((n,i)=>n===original.scoreCounts[i+1])));
  assert.ok(row.scoreMinimum<=original.scoreMinimum+row.addedTargetScoring.minimumPerAddedTarget*extra+.001);
 }
 const dense=plan.records.find(r=>r.position===136);assert.equal(dense.targetCount,15);assert.ok(dense.scoreMinimum<50);
});
