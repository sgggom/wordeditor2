import test from 'node:test';
import assert from 'node:assert/strict';
import {createGenerator} from '../dist/level-generator.js';
import {setTargetWord,createDuplicateCheck} from '../dist/level-rules.js';
import {createGameExport} from '../dist/level-export.js';

test('generation filters extras by actual target lengths before extra duplicate checks',()=>{
 const g=createGenerator(['CAT','DOG'].map(word=>({word})),['TAC','GOD','CATGOD'].map(word=>({word})));
 const config={rows:2,columns:3,minimumWordLength:3,fixedWords:['CAT','DOG'],
  fixedLayout:{rows:2,columns:3,placements:[{word:'CAT',path:[0,1,2]},{word:'DOG',path:[3,4,5]}]},
  duplicateCheck:createDuplicateCheck([{id:1,level:{targetWords:[],extraWords:[{word:'CATGOD'}]}}],{target:0,extra:10})};
 const level=g.generate(config);
 assert.deepEqual(level.targetWords.map(e=>e.word),['CAT','DOG']);
 assert.deepEqual(level.extraWords.map(e=>e.word),['GOD','TAC']);
 assert.ok(level.foundWords.some(e=>e.word==='CATGOD'));
 assert.equal(createGameExport([{level}]).books[0].levels[0].e,'GOD TAC');
});

test('allowed extra lengths are the exact target length set, not an inclusive interval',()=>{
 const g=createGenerator(['ABC','ABCFE'].map(word=>({word})),['CBA','ABCF','EFCBA'].map(word=>({word})));
 const board={rows:2,columns:3,disabledCells:[3],letters:['A','B','C','','E','F'],
  initialWords:[{word:'ABC',path:[0,1,2]},{word:'ABCFE',path:[0,1,2,5,4]}],minimumWordLength:3};
 const level=g.selectTargets({...board,foundWords:g.findWords(board)});
 assert.deepEqual(level.extraWords.map(e=>e.word),['CBA','EFCBA']);
 assert.ok(level.candidateWords.some(e=>e.word==='ABCFE'));
 assert.ok(level.foundWords.some(e=>e.word==='ABCF'));
});

test('adding and removing a target length restores and filters only-extra words',()=>{
 const g=createGenerator(['ABCDEF','ABC'].map(word=>({word})),['CBA','FEDCBA'].map(word=>({word})));
 const board={rows:2,columns:3,letters:[...'ABCFED'],initialWords:[{word:'ABCDEF',path:[0,1,2,5,4,3]}],minimumWordLength:3};
 const original=g.selectTargets({...board,foundWords:g.findWords(board)});
 assert.deepEqual(original.extraWords.map(e=>e.word),['FEDCBA']);
 const added=setTargetWord(original,'ABC',true);
 assert.deepEqual(added.extraWords.map(e=>e.word),['CBA','FEDCBA']);
 const removed=setTargetWord(added,'ABC',false);
 assert.deepEqual(removed.extraWords.map(e=>e.word),['FEDCBA']);
 assert.deepEqual(setTargetWord(removed,'ABC',true).extraWords.map(e=>e.word),['CBA','FEDCBA']);
 assert.deepEqual(original.extraWords.map(e=>e.word),['FEDCBA']);
});

test('automatic optional targets establish the final allowed extra lengths',()=>{
 const g=createGenerator(['ABCDEF','ABC'].map(word=>({word})),['CBA','FEDCBA'].map(word=>({word})));
 const board={rows:2,columns:3,letters:[...'ABCFED'],initialWords:[{word:'ABCDEF',path:[0,1,2,5,4,3]}],minimumWordLength:3,desiredTargetCount:2};
 const level=g.selectTargets({...board,foundWords:g.findWords(board),requireSafePaths:true});
 assert.deepEqual(level.targetWords.map(e=>e.word),['ABCDEF','ABC']);
 assert.deepEqual(level.extraWords.map(e=>e.word),['CBA','FEDCBA']);
});
