import test from 'node:test';
import assert from 'node:assert/strict';
import {createGenerator} from '../dist/level-generator.js';
import {analyzeTargetPaths} from '../dist/target-path-analysis.js';
import {describePath} from '../dist/level-statistics.js';
import {scoreBand,selectPlannedTargets,compareLevelPlan,validateLevelPlan} from '../scripts/lib/level-plan.mjs';
import {createBoundedGenerator} from '../scripts/lib/bounded-generator.mjs';

const ordinary=[{word:'CAT',rarityLevel:1},{word:'DOG',rarityLevel:1}];
const extras=[{word:'TAC',rarityLevel:4},{word:'CATGOD',rarityLevel:4}];
const letters=[...'CATDOG'];
const generator=createGenerator(ordinary,extras);
const found=generator.findWords({rows:2,columns:3,letters,minimumWordLength:3});
const row={position:6,rows:2,columns:3,boardMask:['111','111'],activeCells:6,targetCount:2,
 scoreCounts:[2,0,0,0],referenceWordScores:[1.3,1.3],referenceScore:2.6,scoreMinimum:2.6,scoreMaximum:2.6};
const select=overrides=>selectPlannedTargets({row,letters,found,whitelist:new Set(['CAT','DOG']),random:()=>.5,...overrides});

test('score cutoffs assign 3, 6 and 9 to their higher bands',()=>{
 assert.deepEqual([1.3,2.9,3,5.9,6,8.9,9,12].map(scoreBand),[0,0,1,1,2,2,3,3]);
});
test('new plan selection enforces coverage, exact scores, current extra lengths and safety',()=>{
 const level=select();assert.ok(level);
 assert.ok(compareLevelPlan(level,row).passed);assert.ok(analyzeTargetPaths(level).allChoicesComplete);
 assert.deepEqual(level.extraWords.map(e=>e.word),['TAC']);
 assert.equal(level.statistics.difficulty.total,2.6);
 assert.equal(select({row:{...row,scoreCounts:[1,1,0,0]}}),null);
 assert.equal(select({row:{...row,scoreMinimum:3,scoreMaximum:4}}),null);
 assert.ok(compareLevelPlan(level,{...row,boardMask:['110','111']}).violations.includes('boardMask'));
});
test('a cooled extra cannot be silently omitted, and a cooled target cannot be selected',()=>{
 assert.equal(select({blocked:new Set(['TAC'])}),null);
 assert.equal(select({blocked:new Set(['CAT'])}),null);
});
test('composition acceptance and ranking use normalized paths',()=>{
 const profile={noThreeLetter:false,minimumDistinctLengths:1,preferredCounts:[2,0,0,0],preferredCountRanges:[[2,2],[0,0],[0,0],[0,0]],
  preferredDistinctLengths:1,firstStepPositiveShares:{3:0},weights:{counts:1,rangeOverflow:1,variety:1,firstStep:1}};
 let checked=0,ranked=0;
 const level=select({row:{...row,scoreMaximum:4.6,targetComposition:profile},
  normalizeCandidate:level=>({...level,cells:[...level.cells].reverse(),
   targetWords:level.targetWords.map(word=>{const path=word.path.map(cell=>5-cell);return {...word,path,
    pathAnalysis:{...word.pathAnalysis,assigned:describePath(path,3)}};})}),
  onComposition:composition=>{checked++;return composition.firstSteps[3].positive===0;},
  additionalCost:composition=>{ranked++;assert.equal(composition.firstSteps[3].positive,0);return 0;}});
 assert.ok(level);assert.ok(checked&&ranked);assert.equal(level.statistics.difficulty.total,4.6);
 assert.equal(select({normalizeCandidate:()=>null}),null);
});
test('adapter rejects old competitor constraint format and inconsistent new quotas',()=>{
 assert.throws(()=>validateLevelPlan({status:'legacy',scope:{},records:[]}),/旧竞品/);
 const plan={status:'review-plan-only',scope:{excludedPositions:[1,2,3,4,5]},records:[row]};
 assert.equal(validateLevelPlan(plan),plan);
 assert.throws(()=>validateLevelPlan({...plan,records:[{...row,targetCount:3}]}));
});
test('CLI generation hooks obey cancellation without changing the editor generator',async()=>{
 const make=await createBoundedGenerator();
 const bounded=make(ordinary,extras,{trial:{withinBudget:()=>false,observeBoard:()=>{throw new Error('unexpected board');}}});
 assert.throws(()=>bounded.generate({rows:2,columns:3,minimumWordLength:3}),e=>e.code==='GENERATION_RETRY');
 assert.equal(generator.findWords({rows:2,columns:3,letters,minimumWordLength:3}).length,4);
});
