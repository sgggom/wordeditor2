import test from 'node:test';
import assert from 'node:assert/strict';
import {describeWordDirection,measureWordDirections,WORD_DIRECTION_POLICY} from '../dist/word-direction.js';
import {measureComposition} from '../scripts/lib/target-composition.mjs';

test('every edge counts once with a double weight for the first edge',()=>{
 const measured=describeWordDirection([0,1,2,5],3);
 assert.deepEqual(measured.steps.map(step=>step.score),[2,1,1]);
 assert.equal(measured.positiveScore,4);assert.equal(measured.reverseScore,0);
 assert.equal(measured.score,4);assert.equal(measured.direction,'positive');
 assert.equal(WORD_DIRECTION_POLICY.tie,'neutral');
});

test('later edges can outweigh the first edge and ties remain neutral',()=>{
 assert.equal(describeWordDirection([3,7,6,5,4],4).score,-1); // GRIND: down, left, left, left
 assert.equal(describeWordDirection([3,7,6,5,4],4).direction,'reverse');
 assert.equal(describeWordDirection([3,7,6,5],4).direction,'neutral');
 assert.equal(describeWordDirection([2,1,5,6,7],4).direction,'positive');
});

test('the pictured level becomes six positive words after a horizontal reflection',()=>{
 const entries=[['AND',[1,5,4]],['JAW',[0,1,2]],['WIN',[2,6,5]],['GRIN',[3,7,6,5]],
  ['WAND',[2,1,5,4]],['WIND',[2,6,5,4]],['GRIND',[3,7,6,5,4]]].map(([word,path])=>({word,path}));
 const summarize=targetWords=>Object.values(measureWordDirections({columns:4,targetWords}))
  .reduce((sum,row)=>({positive:sum.positive+row.positive,reverse:sum.reverse+row.reverse,neutral:sum.neutral+row.neutral}),{positive:0,reverse:0,neutral:0});
 assert.deepEqual(summarize(entries),{positive:3,reverse:2,neutral:2});
 const reflected=entries.map(entry=>({...entry,path:entry.path.map(cell=>Math.floor(cell/4)*4+3-cell%4)}));
 assert.deepEqual(summarize(reflected),{positive:6,reverse:1,neutral:0});
 const composition=measureComposition({columns:4,targetWords:entries});
 assert.equal(composition.weightedDirections[4].neutral,2);
 assert.equal(composition.firstSteps[4].positive,2); // Historical first-edge statistics stay explicit.
});

test('a half-turn negates every score, including first-edge weighting',()=>{
 for(const path of [[0,1,2],[1,5,4],[3,7,6,5],[2,1,5,4]]){
  const before=describeWordDirection(path,4),after=describeWordDirection(path.map(cell=>7-cell),4);
  assert.equal(after.score+before.score,0);
  assert.equal(after.positiveScore,before.reverseScore);assert.equal(after.reverseScore,before.positiveScore);
 }
});

test('invalid jumps and row wrapping cannot be counted as directions',()=>{
 for(const path of [[2,3],[0,4],[0,0],[0,-1]])assert.throws(()=>describeWordDirection(path,3));
 assert.throws(()=>describeWordDirection([0,1],0));
 assert.equal(describeWordDirection([0],3).direction,'neutral');
});
