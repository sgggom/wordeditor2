import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createPresetRecords} from '../dist/preset-level-lists.js';
import {measureWordDirections} from '../dist/word-direction.js';
import {validateLevelPlan} from '../scripts/lib/level-plan.mjs';
const root=new URL('../../',import.meta.url),read=file=>JSON.parse(fs.readFileSync(new URL(file,root)));
const plan=read('level-editor/dist/data/level-plan-target-floor-first-100.json');
test('extension freezes the accepted first 50 and preserves their stage constraints',()=>{
 const parent=read('level-editor/dist/data/level-plan-target-floor-first-50.json');validateLevelPlan(plan);
 assert.equal(plan.parentPlanId,parent.id);assert.deepEqual(plan.records.slice(0,45),parent.records);
 assert.deepEqual(plan.stageBudgets.slice(0,3),parent.stageBudgets);assert.equal(plan.records.length,95);
 const prefix=plan.continuation.prefixFile;
 assert.equal(createHash('sha256').update(fs.readFileSync(new URL(prefix,root))).digest('hex'),plan.continuation.prefixSha256);
});
test('new levels retain board and difficulty planning and independently meet each reference count',()=>{
 const original=read('level-editor/dist/data/level-plan.json');
 const reference=createPresetRecords(read('level-editor/dist/data/presets/word-tiles-list0.json').slice(0,100),'word-tiles');
 for(const row of plan.records.filter(row=>row.position>50)){
  const old=original.records.find(old=>old.position===row.position);
  for(const key of ['rows','columns','activeCells','boardMask','shapeId','special','difficulty','type'])assert.deepEqual(row[key],old[key]);
  assert.equal(row.minimumTargetCount,reference[row.position-1].level.targetWords.length);
  assert.equal(row.targetCount,Math.max(old.targetCount,row.minimumTargetCount));
  assert.ok(row.scoreProfiles.every(profile=>profile.every((n,i)=>n>=old.scoreCounts[i])));
 }
});
test('each new stage uses its own weighted reference rates and exact long lengths',()=>{
 const reference=createPresetRecords(read('level-editor/dist/data/presets/word-tiles-list0.json').slice(0,100),'word-tiles').map(record=>record.level);
 for(const stage of plan.stageBudgets.filter(stage=>stage.from>50))for(const length of [3,4,5,6,7,8]){
  const tally={total:0,positive:0,reverse:0,neutral:0};
  for(const level of reference.slice(stage.from-1,stage.to))for(const key of Object.keys(tally))tally[key]+=measureWordDirections(level)[length]?.[key]??0;
  assert.deepEqual(stage.referenceDirectionCounts[length],tally);
  assert.ok(stage.ranges['length:'+length][0]>=tally.total);
  for(const key of ['positive','reverse','neutral'])assert.equal(stage.directionSharesByLength[length][key],tally.total?tally[key]/tally.total:key==='reverse'?1:0);
 }
});
