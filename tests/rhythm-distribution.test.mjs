import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {placementQualityCost,scoreGenerationQuality} from '../dist/generation-quality.js';
import {createGenerator} from '../dist/level-generator.js';
import {validateGenerationPolicy} from '../dist/generation-policy.js';
const word=(word,path)=>({word,path,rarityLevel:1});
const rules={targetWordLengths:[4,4,4],lengthShares:[0,1,0],rarityShares:[1,0,0,0],turnShares:[1/3,1/3,1/3,0],turnsPerWord:1,reversalsPerWord:0};
test('equal turn averages still prefer the reference straight/one/multi-turn mixture',()=>{
 const mixed={columns:5,desiredTargetCount:3,targetWords:[word('AAAA',[5,6,7,8]),word('BBBB',[6,7,12,17]),word('CCCC',[7,8,13,14])]};
 const uniform={...mixed,targetWords:[word('AAAA',[5,6,11,16]),word('BBBB',[6,7,12,17]),word('CCCC',[7,8,13,18])]};
 const a=scoreGenerationQuality(mixed,rules),b=scoreGenerationQuality(uniform,rules);
 assert.equal(a.averageTurns,b.averageTurns);assert.equal(a.turnShareDifference,0);assert.ok(a.score<b.score);
});
test('six-letter references cannot be satisfied equally by five-letter words',()=>{
 const r={...rules,targetWordLengths:[3,6],lengthShares:[.5,0,.5],turnShares:[1,0,0,0],turnsPerWord:0};
 const correct={columns:8,desiredTargetCount:2,targetWords:[word('CAT',[16,17,18]),word('BANANA',[8,9,10,11,12,13])]};
 const short={...correct,targetWords:[correct.targetWords[0],word('STONE',[8,9,10,11,12])]};
 const a=scoreGenerationQuality(correct,r),b=scoreGenerationQuality(short,r);
 assert.equal(a.lengthShareDifference,b.lengthShareDifference);assert.equal(a.detailedLengthDifference,0);assert.ok(a.score<b.score);
});
test('placement scoring fills the missing straight category after a one-turn target',()=>{
 const r={...rules,targetWordLengths:[4,4],turnShares:[.5,.5,0,0]};
 const selected=[word('AAAA',[6,7,12,17])];
 assert.ok(placementQualityCost(word('BBBB',[10,11,12,13]),5,r,selected)<placementQualityCost(word('BBBB',[10,11,16,21]),5,r,selected));
});
test('reference long words seed the board before short covering words',()=>{
 const records=['PLANET','CAT','DOG','RAT'].map(word=>({word,rarityLevel:1}));
 const generator=createGenerator(records,[],{targetWordWhitelist:records.map(e=>e.word)});
 let seed=3;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
 const p=generator.findPlacement({rows:3,columns:3,letters:Array(9).fill(''),minimumWordLength:3,random,generationRules:{...rules,targetWordLengths:[6,3,3]}});
 assert.equal(p.word,'PLANET');assert.equal(new Set(p.path).size,6);
});
test('invalid reference turn distributions fail before generation',()=>{
 const preset=JSON.parse(fs.readFileSync(new URL('../dist/data/current-rule-configs.json',import.meta.url)));
 const c=structuredClone(preset.records[1].config);c.generationRules.turnShares=[1,1,0,0];
 assert.throws(()=>validateGenerationPolicy(c),/拐弯分布/);
});
