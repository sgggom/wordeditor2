import test from 'node:test';
import assert from 'node:assert/strict';
import {futureFixedTargetWords,configJobsInRange} from '../dist/level-config.js';
import {createBatchRunner} from '../dist/batch-runner.js';
import {createGenerator} from '../dist/level-generator.js';

const config=(words=[],range=50)=>({rows:3,columns:3,fixedWords:words,filters:{},initialForwardProbability:50,targetDuplicateRange:range,extraDuplicateRange:20});
const record=(position,words,range)=>({id:`config-${position}`,position,config:config(words,range)});

test('future reservations use the later config window, including its boundary and nonconsecutive positions',()=>{
  const records=[record(1,['PAST']),record(8,['LAY','MEET'],0),record(16,['all'],8),record(17,['OUTSIDE'],8),
    record(18,['DISABLED'],0),record(19,['EXEMPT']),record(20,['LAY'])];
  records[5].config.fixedWordExemptions=['EXEMPT'];
  assert.deepEqual(futureFixedTargetWords(records,8,['LAY','MEET']),['ALL']);
  assert.deepEqual(futureFixedTargetWords(records,16,['ALL']),['OUTSIDE','LAY']);
  const plain=[{config:config(['AAA'])},{config:config(['BBB'],1)}];
  assert.deepEqual(futureFixedTargetWords(plain,1),['BBB']);
});

test('partial-range runs reserve later fixed words outside the requested interval and freeze the full config list',async()=>{
  const records=Array.from({length:16},(_,i)=>({id:`row-${i+1}`,config:config(i===7?['LAY','MEET']:i===15?['ALL']:[])}));
  const seen=[],saved=[];
  const runner=createBatchRunner({getHistory:async()=>[],generate:async settings=>{
    seen.push(settings);return{targetWords:[{word:'LAY'}],extraWords:[]};
  },save:async level=>{saved.push(level);return{id:saved.length,level};}});
  const running=runner.run(configJobsInRange(records,8,8),records);
  records[15].config.fixedWords=['CHANGED'];
  const result=await running;
  assert.equal(result.phase,'complete');
  assert.equal(seen.length,1);
  assert.deepEqual(seen[0].reservedTargetWords,['ALL']);
  assert.deepEqual(seen[0].fixedWords,['LAY','MEET']);
  assert.equal(saved[0].sourceConfig.position,8);
});

test('reserved future words cannot fill the board as random targets, but remain valid extras',()=>{
  const generator=createGenerator(['CAT','DOG','TAC'].map(word=>({word})));
  assert.equal(generator.findPlacement({rows:2,columns:2,letters:['','','',''],reservedTargetWords:['CAT','DOG','TAC']}),null);
  const level=generator.generate({rows:2,columns:3,reservedTargetWords:['TAC'],fixedWords:['CAT','DOG'],
    fixedLayout:{rows:2,columns:3,placements:[{word:'CAT',path:[0,1,2]},{word:'DOG',path:[3,4,5]}]}});
  assert.ok(!level.targetWords.some(w=>w.word==='TAC'));
  assert.ok(!level.candidateWords.some(w=>w.word==='TAC'));
  assert.ok(level.extraWords.some(w=>w.word==='TAC'));
  const pinned=generator.generate({rows:2,columns:3,reservedTargetWords:['CAT','DOG'],fixedWords:['CAT','DOG'],
    fixedLayout:{rows:2,columns:3,placements:[{word:'CAT',path:[0,1,2]},{word:'DOG',path:[3,4,5]}]}});
  assert.deepEqual(pinned.targetWords.map(w=>w.word),['CAT','DOG']);
});
