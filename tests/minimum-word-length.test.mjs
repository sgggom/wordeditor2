import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createGenerator} from '../dist/level-generator.js';
import {createBatchRunner} from '../dist/batch-runner.js';
import {createDuplicateCheck} from '../dist/level-rules.js';

test('first-level rules allow two-letter targets and extras; later rules remove them before selection', () => {
  const generator=createGenerator(['AT','TO','CAT','DOG'].map(word=>({word})),[{word:'DO'}]);
  const first=generator.generate({rows:2,columns:2,minimumWordLength:2,fixedWords:['AT','TO'],
    fixedLayout:{rows:2,columns:2,placements:[{word:'AT',path:[0,1]},{word:'TO',path:[2,3]}]}});
  assert.ok(first.targetWords.every(entry=>entry.word.length===2));
  const later=generator.generate({rows:2,columns:3,minimumWordLength:3,fixedWords:['CAT','DOG'],
    fixedLayout:{rows:2,columns:3,placements:[{word:'CAT',path:[0,1,2]},{word:'DOG',path:[3,4,5]}]}});
  for(const key of ['initialWords','candidateWords','targetWords','extraWords']) assert.ok(later[key].every(entry=>entry.word.length>=3));
  const all=generator.findWords({rows:2,columns:3,letters:['C','A','T','D','O','G']});
  assert.ok(all.some(entry=>entry.word==='AT'));
  assert.ok(all.some(entry=>entry.word==='DO'));
  assert.ok(generator.findWords({rows:2,columns:3,letters:['C','A','T','D','O','G'],minimumWordLength:3}).every(entry=>entry.word.length>=3));
  assert.throws(()=>generator.generate({rows:2,columns:2,minimumWordLength:3,fixedWords:['AT'],fixedWordExemptions:['AT']}),/固定词.*长度/);
  const onlyShort=createGenerator([{word:'AT'},{word:'TO'}]);
  assert.throws(()=>onlyShort.generate({rows:2,columns:2,minimumWordLength:3}),/没有可用的初始词/);
});

test('normal batch uses absolute level positions, including ranges starting after level one', async () => {
  const seen=[];
  const config={rows:3,columns:3,initialForwardProbability:50,targetDuplicateRange:0,extraDuplicateRange:0,filters:{},minimumWordLength:2};
  const runner=createBatchRunner({getHistory:async()=>[],generate:async config=>{
    seen.push(config.minimumWordLength);return{targetWords:[],extraWords:[]};
  },save:async level=>({id:seen.length,level})});
  const jobs=positions=>positions.map(position=>({id:`config-${position}`,position,config}));
  assert.equal((await runner.run(jobs([1,2,3]))).phase,'complete');
  assert.deepEqual(seen,[2,3,3]);seen.length=0;
  await runner.run(jobs([9]));assert.deepEqual(seen,[3]);
  assert.equal(config.minimumWordLength,2);
});

test('real dictionaries exclude BE from level three before extra-word duplicate checks', async () => {
  const read=name=>fs.readFile(new URL('../dist/data/'+name,import.meta.url),'utf8').then(JSON.parse);
  const [normal,guide,extra]=await Promise.all(['required-words.json','guide-words.json','extra-words.json'].map(read));
  const generator=createGenerator([...normal,...guide],extra);
  const options={rows:3,columns:3,fixedWords:['WEB','COUPLE'],minimumWordLength:3,
    fixedLayout:{rows:3,columns:3,placements:[{word:'WEB',path:[0,1,2]},{word:'COUPLE',path:[3,4,5,8,7,6]}]},
    duplicateCheck:createDuplicateCheck([{id:2,level:{targetWords:[{word:'BEE'},{word:'TABLE'}],extraWords:[{word:'BE'}]}}],{target:50,extra:20})};
  const level=generator.generate(options);
  assert.ok([...level.targetWords,...level.extraWords,...level.candidateWords].every(entry=>entry.word.length>=3));
  assert.deepEqual(level.targetWords.map(entry=>entry.word),['WEB','COUPLE']);
});
