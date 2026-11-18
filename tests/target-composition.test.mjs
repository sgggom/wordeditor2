import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createGenerator} from '../dist/level-generator.js';
import {selectPlannedTargets,compareLevelPlan,validateLevelPlan} from '../scripts/lib/level-plan.mjs';
import {COMPOSITION_POLICY_ID,measureComposition,compareComposition,compositionCost,validateComposition} from '../scripts/lib/target-composition.mjs';

function config(lengths,overrides={}){
 const counts=[0,0,0,0];for(const length of lengths)counts[length===3?0:length===4?1:length===5?2:3]++;
 return {policyId:COMPOSITION_POLICY_ID,noThreeLetter:counts[0]===0,preferredLengths:lengths,preferredCounts:counts,
  preferredCountRanges:counts.map(count=>[count,count]),preferredDistinctLengths:new Set(lengths).size,minimumDistinctLengths:1,
  firstStepPositiveShares:{3:.75,4:.72,5:.73,6:.62,7:.65,8:.61,'6+':.63},
  weights:{counts:3,rangeOverflow:2,variety:2,firstStep:1.25},...overrides};
}

test('composition keeps exact length variety while combining 6+ counts and measures the first edge',()=>{
 const measured=measureComposition({columns:3,targetWords:[
  {word:'CAT',path:[6,7,4]}, // right then up: first-step positive, whole-path mixed
  {word:'CODE',path:[4,3,0,1]},
  {word:'ABCDEF',path:[0,1,2,5,4,3]},
  {word:'ABCDEFG',path:[0,1,2,5,8,7,6]},
 ]});
 assert.deepEqual(measured.counts,[1,1,0,2]);assert.equal(measured.distinctLengths,4);
 assert.equal(measured.firstSteps[3].positive,1);assert.equal(measured.firstSteps[4].positive,0);
 assert.equal(measured.firstSteps[3].R,1);assert.equal(measured.firstSteps[4].L,1);
});

test('ordinary presence and scheduled zero-three rules are hard; preferred quantities remain preferences',()=>{
 const policy=config([3,3,4],{minimumDistinctLengths:2});
 const changed={counts:[1,2,0,0],distinctLengths:2,firstSteps:{}};
 assert.ok(compareComposition(changed,policy).passed);
 assert.ok(compositionCost(changed,policy)>compositionCost({counts:[2,1,0,0],distinctLengths:2,firstSteps:{}},policy));
 assert.deepEqual(compareComposition({counts:[0,3,0,0],distinctLengths:1},policy).violations,['threeLetterSchedule','minimumLengthVariety']);
 assert.ok(compareComposition({counts:[1,1,0,0],distinctLengths:2},config([4,5])).violations.includes('threeLetterSchedule'));
});

test('stage direction balancing does not make every one-word group choose positive',()=>{
 const policy=config([3]),history={3:{total:0,positive:0}},sequence=[];
 for(let i=0;i<12;i++){
  const make=positive=>({counts:[1,0,0,0],distinctLengths:1,firstSteps:{3:{total:1,positive}}});
  const positive=compositionCost(make(1),policy,history)<compositionCost(make(0),policy,history)?1:0;
  sequence.push(positive);history[3].total++;history[3].positive+=positive;
 }
 assert.equal(sequence.reduce((sum,n)=>sum+n,0),9);
});

test('selector excludes three-letter targets and extras at scheduled zero-three levels',()=>{
 const words=[{word:'LEARN',rarityLevel:1},{word:'CODE',rarityLevel:1}],extras=[{word:'COD',rarityLevel:1}];
 const letters=[...'CODELEARN'],generator=createGenerator(words,extras);
 const found=generator.findWords({rows:3,columns:3,letters,minimumWordLength:3});
 const row={rows:3,columns:3,boardMask:['111','111','111'],targetCount:2,scoreCounts:[1,1,0,0],
  referenceWordScores:[2.4,5.5],referenceScore:7.9,scoreMinimum:7.9,scoreMaximum:7.9,targetComposition:config([4,5],{minimumDistinctLengths:2})};
 const level=selectPlannedTargets({row,letters,found,whitelist:new Set(['LEARN','CODE']),random:()=>.5});
 assert.ok(level);assert.ok(compareLevelPlan(level,row).passed);
 assert.deepEqual(level.targetWords.map(entry=>entry.word).sort(),['CODE','LEARN']);
 assert.deepEqual(level.extraWords,[]);
 assert.equal(selectPlannedTargets({row:{...row,targetComposition:config([3,4])},letters,found,whitelist:new Set(['LEARN','CODE']),random:()=>.5}),null);
 const ordinaryRow={...row,targetComposition:config([3,4])};
 assert.ok(compareLevelPlan(level,ordinaryRow).violations.includes('threeLetterSchedule'));
 const preserved=compareLevelPlan(level,ordinaryRow,{enforceComposition:false});
 assert.ok(preserved.passed);assert.equal(preserved.composition.mode,'preserved-before-policy');
});

test('validation rejects contradictory count, variety and direction settings',()=>{
 const policy=config([3,4,5]);assert.doesNotThrow(()=>validateComposition(policy,3));
 assert.throws(()=>validateComposition({...policy,noThreeLetter:true},3),/节奏/);
 assert.throws(()=>validateComposition({...policy,preferredCounts:[1,1,0,0]},3),/目标数/);
 assert.throws(()=>validateComposition({...policy,preferredDistinctLengths:2},3),/种类/);
 assert.throws(()=>validateComposition({...policy,firstStepPositiveShares:{...policy.firstStepPositiveShares,3:2}},3),/正向比例/);
});

test('compiled 1995-row plan preserves approved scores, sizes and totals and schedules one zero-three per block',()=>{
 const read=file=>JSON.parse(fs.readFileSync(new URL(file,import.meta.url)));
 const before=read('../../outputs/20261112-level-plan-reference-size/plan.json');
 const after=read('../dist/data/level-plan.json');
 const policy=read('../dist/data/target-composition-policy.json');
 validateLevelPlan(after);assert.equal(after.records.length,1995);
 for(let i=0;i<before.records.length;i++)for(const [key,value]of Object.entries(before.records[i]))assert.deepEqual(after.records[i][key],value);
 const zeros=after.records.filter(row=>row.targetComposition.noThreeLetter).map(row=>row.position);
 assert.deepEqual(zeros,policy.hardRules.noThreeLetterPositions);assert.equal(zeros.length,66);
 for(let from=31;from<=2000;from+=30)assert.equal(zeros.filter(position=>position>=from&&position<=Math.min(2000,from+29)).length,1);
 for(let i=1;i<zeros.length;i++)assert.ok(zeros[i]-zeros[i-1]>=20);
 assert.ok(after.records.filter(row=>row.targetComposition.noThreeLetter).every(row=>row.targetCount<=row.activeCells));
 assert.ok(after.records.every(row=>row.targetComposition.firstStepPositiveShares['6+']<.7));
});
