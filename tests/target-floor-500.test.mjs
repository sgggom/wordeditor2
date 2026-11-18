import { readPlanningSource } from "./planning-source.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';

import {createHash} from 'node:crypto';
import {createPresetRecords} from '../dist/preset-level-lists.js';
import {measureWordDirections} from '../dist/word-direction.js';
import {validateLevelPlan} from '../scripts/lib/level-plan.mjs';

const read = file => JSON.parse(readPlanningSource(file));
const plan=read('level-editor/dist/data/level-plan-target-floor-first-500.json');
test('500-level continuation freezes the approved 200 and preserves all accepted plan rows',()=>{
 const parent=read('level-editor/dist/data/level-plan-target-floor-first-200.json');
 validateLevelPlan(plan);assert.equal(plan.records.length,495);assert.equal(plan.parentPlanId,parent.id);
 assert.deepEqual(plan.records.slice(0,195),parent.records);
 assert.deepEqual(plan.stageBudgets.slice(0,parent.stageBudgets.length),parent.stageBudgets);
 assert.equal(plan.continuation.preservedThrough,200);
 const bytes=readPlanningSource(plan.continuation.prefixFile);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),plan.continuation.prefixSha256);
 assert.equal(JSON.parse(bytes).level.length,200);
});
test('201–500 preserve boards and difficulty while supplementing the per-level target floor',()=>{
 const base=read('level-editor/dist/data/level-plan.json');
 const peers=createPresetRecords(read('level-editor/dist/data/presets/word-tiles-list0.json').slice(0,500),'word-tiles');
 for(const row of plan.records.filter(r=>r.position>200)){
  const original=base.records.find(r=>r.position===row.position);
  for(const key of ['rows','columns','activeCells','boardMask','shapeId','special','difficulty','type'])assert.deepEqual(row[key],original[key]);
  assert.equal(row.targetCount,Math.max(original.targetCount,peers[row.position-1].level.targetWords.length));
  assert.ok(row.scoreProfiles.every(profile=>profile.every((n,i)=>n>=original.scoreCounts[i])));
  if(row.addedTargetScoring)assert.ok(row.scoreMinimum<=original.scoreMinimum+row.addedTargetScoring.minimumPerAddedTarget*(row.targetCount-original.targetCount)+.001);
 }
});
test('all fifteen new stages take length-specific direction rates from their corresponding competitor stages',()=>{
 const dictionary=['required','guide','extra'].flatMap(n=>read(`level-editor/dist/data/${n}-words.json`));
 const peers=createPresetRecords(read('level-editor/dist/data/presets/word-tiles-list0.json').slice(0,500),'word-tiles',dictionary).map(r=>r.level);
 const stages=plan.stageBudgets.filter(b=>b.from>200);assert.equal(stages.length,15);
 for(const b of stages)for(const n of [3,4,5,6,7,8]){
  const tally={total:0,positive:0,reverse:0,neutral:0};
  for(const level of peers.slice(b.from-1,b.to))for(const key of Object.keys(tally))tally[key]+=measureWordDirections(level)[n]?.[key]??0;
  assert.deepEqual(b.referenceDirectionCounts[n],tally);assert.ok(b.ranges['length:'+n][0]>=tally.total);
  for(const key of ['positive','reverse','neutral'])assert.equal(b.directionSharesByLength[n][key],tally.total?tally[key]/tally.total:key==='reverse'?1:0);
 }
});
