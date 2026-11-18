import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {importGameLevels} from '../dist/level-import.js';
import {compareLevelPlan,validateLevelPlan} from '../scripts/lib/level-plan.mjs';
import {promoteExtraTargets,additionalScoreProfiles,targetCountFloor} from '../scripts/lib/target-promotion.mjs';
const dictionary=['CAR','COTE','CARE'].map(word=>({word,rarityLevel:1}));
const baseline=()=>importGameLevels({level:[{a:'CAR,OTE',b:'211111',c:'CAR COTE',d:'CARE'}],daily:[]},dictionary)[0];
const row={rows:2,columns:3,boardMask:['111','111'],targetCount:3,minimumTargetCount:3,scoreCounts:[3,0,0,0],scoreProfiles:additionalScoreProfiles([2,0,0,0],1),scoreMinimum:0,scoreMaximum:36};
test('target minimum never reduces a level that already exceeds the reference',()=>{
 assert.equal(targetCountFloor(4,6),6);assert.equal(targetCountFloor(7,5),7);
 assert.ok(additionalScoreProfiles([2,1,0,0],2).every(profile=>profile.reduce((a,b)=>a+b,0)===5&&profile[0]>=2&&profile[1]>=1));
});
test('promoting an extra keeps original targets and board, and updates exported cell counts',()=>{
 const original=baseline(),saved=structuredClone(original),result=promoteExtraTargets({baseline:original,row,dictionary,eligibleWords:new Set(['CARE'])});
 assert.equal(result.candidates.length,1);const picked=result.candidates[0];
 assert.deepEqual(picked.promoted,['CARE']);assert.equal(picked.game.a,'CAR,OTE');assert.equal(picked.game.b,'322112');
 assert.equal(picked.game.c,'CAR CARE COTE');assert.equal(picked.game.d,'');assert.ok(compareLevelPlan(picked.level,row).passed);
 assert.deepEqual(original,saved);
});
test('a lack of eligible extras cannot be hidden by lowering the target minimum',()=>{
 assert.equal(promoteExtraTargets({baseline:baseline(),row,dictionary,eligibleWords:new Set()}).candidates.length,0);
 assert.ok(compareLevelPlan(baseline(),row).violations.includes('targetCountFloor'));
});
test('the compiled plan raises every level 6–50 to its corresponding reference minimum',()=>{
 const plan=JSON.parse(fs.readFileSync(new URL('../dist/data/level-plan-target-floor-first-50.json',import.meta.url)));validateLevelPlan(plan);
 assert.equal(plan.records.length,45);assert.ok(plan.records.every(row=>row.targetCount>=row.minimumTargetCount&&row.targetCount>=row.previousTargetCount));
 assert.equal(plan.records.reduce((sum,row)=>sum+row.targetCount-row.previousTargetCount,0),70);
 assert.deepEqual(plan.scope.excludedPositions,[1,2,3,4,5]);
 const baselineFile=plan.targetSupplementation.baselineFile;
 assert.equal(plan.targetFloorSources[baselineFile],createHash('sha256').update(fs.readFileSync(new URL('../../'+baselineFile,import.meta.url))).digest('hex'));
});
