import test from 'node:test';
import assert from 'node:assert/strict';
import {createGenerator,generateUntilComplete} from '../dist/level-generator.js';
import {createGenerationClient} from '../dist/generation-client.js';
import {createDuplicateCheck,findDuplicateWords,EXTRA_DUPLICATE_ATTEMPT_LIMIT} from '../dist/level-rules.js';

const candidate = (name,words) => ({name,targetWords:[{word:'TARGET'}],extraWords:words.map(word=>({word}))});
const retry = (attempts,bestLevel,bestExtraWords) => Object.assign(new Error('retry'),{
  code:'GENERATION_RETRY',attempts,...(bestLevel?{bestLevel,bestExtraWords}:{}),
});

test('real generation retains only target-valid candidates for soft extra-word fallback', () => {
  const generator=createGenerator([{word:'ABCDEF'}],[{word:'ABC'},{word:'DEF'}]);
  const check=createDuplicateCheck([{id:1,level:{targetWords:[],extraWords:[{word:'ABC'},{word:'DEF'}]}}],{target:50,extra:20});
  const options={rows:2,columns:3,random:()=>0,duplicateCheck:check};
  assert.throws(()=>generator.generate(options),error=>{
    assert.equal(error.code,'GENERATION_RETRY');
    assert.equal(error.attempts,80);
    assert.deepEqual(error.bestExtraWords.sort(),['ABC','DEF']);
    assert.equal(error.bestLevel.duplicateCheck.extra.range,20);
    assert.deepEqual(findDuplicateWords(error.bestLevel,check),{target:[],extra:['ABC','DEF']});
    return true;
  });
  const blocked=createDuplicateCheck([{id:1,level:{targetWords:[{word:'ABCDEF'}],extraWords:[]}}],{target:50,extra:20});
  assert.throws(()=>generator.generate({...options,duplicateCheck:blocked}),error=>{
    assert.equal(error.code,'GENERATION_RETRY');assert.equal(error.bestLevel,undefined);return true;
  });
  assert.throws(()=>generator.generate({...options,fixedWords:['ABCDEF'],duplicateCheck:blocked}),/目标词重复/);
});

test('standalone search keeps the fewest duplicate words and only relaxes beyond one hundred thousand attempts', async () => {
  assert.equal(EXTRA_DUPLICATE_ATTEMPT_LIMIT,100_000);
  let calls=0;
  const progress=[];
  const variants=[['first',['AAA','BBB']],['best',['AAA']],['last',['AAA','BBB','CCC']]];
  const level=await generateUntilComplete({generate(){
    const [name,words]=variants[calls++];throw retry(50000,candidate(name,words),words);
  }},{},{onProgress:p=>progress.push(p)});
  assert.equal(calls,3);
  assert.equal(level.name,'best');
  assert.deepEqual(level.extraDuplicateFallback,{attempts:150000,duplicateCount:1,words:['AAA']});
  assert.deepEqual(progress.map(p=>p.attempts),[50000,100000,150000]);
});

test('zero-duplicate results win before the threshold; no valid target candidate never relaxes', async () => {
  let calls=0;
  const clean=candidate('clean',[]);
  assert.equal(await generateUntilComplete({generate(){
    if(++calls===1)throw retry(80,candidate('duplicate',['AAA']),['AAA']);return clean;
  }},{}),clean);
  let current=true;
  assert.equal(await generateUntilComplete({generate(){throw retry(100080);}}, {},{
    isCurrent:()=>current,onProgress:()=>{current=false;},
  }),null);
  current=true;
  assert.equal(await generateUntilComplete({generate(){throw retry(100080,candidate('cancelled',['AAA']),['AAA']);}}, {},{
    isCurrent:()=>current,onProgress:()=>{current=false;},
  }),null);
});

test('failed random shape does not supply a candidate after switching to the base rectangle', async () => {
  let calls=0;
  const options={randomBoardShape:true,disabledCells:[0]};
  const level=await generateUntilComplete({generate(config){
    if(++calls===1)throw retry(80,{...candidate('shape',['AAA']),disabledCells:[0]},['AAA']);
    assert.deepEqual(config.disabledCells,[]);
    throw retry(100001,{...candidate('rectangle',['AAA','BBB']),disabledCells:[]},['AAA','BBB']);
  }},options);
  assert.equal(level.name,'rectangle');
  assert.equal(level.extraDuplicateFallback.duplicateCount,2);
});

test('parallel workers combine attempts, compare candidates, ignore target duplicates, and reset per level', async () => {
  const workers=[];
  const client=createGenerationClient({workerCount:2,workerFactory:()=>{
    const worker={messages:[],postMessage(m){this.messages.push(m);},terminate(){},
      emit(progress,requestId=this.messages.findLast(m=>m.type==='generate').requestId){this.onmessage({data:{requestId,progress}});}};
    workers.push(worker);return worker;
  }});
  const check=createDuplicateCheck([{id:1,level:{targetWords:[{word:'FORBIDDEN'}],extraWords:['AAA','BBB','CCC'].map(word=>({word}))}}],{target:50,extra:20});
  const signal=new AbortController().signal;
  let completed=false;
  const promise=client.generate({},check,{signal}).then(level=>{completed=true;return level;});
  workers[0].emit({attempts:50000,bestLevel:candidate('two',['AAA','BBB'])});
  workers[1].emit({attempts:49920,bestLevel:candidate('one',['AAA'])});
  workers[0].emit({attempts:50080,bestLevel:{...candidate('forbidden',[]),targetWords:[{word:'FORBIDDEN'}]}});
  await Promise.resolve();assert.equal(completed,false,'exactly one hundred thousand attempts keeps searching');
  workers[1].emit({attempts:50000,bestLevel:candidate('worse',['AAA','BBB','CCC'])});
  const level=await promise;
  assert.equal(level.name,'one');
  assert.deepEqual(level.extraDuplicateFallback,{attempts:100080,duplicateCount:1,words:['AAA']});
  assert.ok(workers.every(w=>w.messages.at(-1).type==='cancel'));
  const next=client.generate({},check,{signal});
  workers[0].emit({attempts:2000000,bestLevel:candidate('stale',['AAA'])},1);
  workers[0].emit({attempts:100080});
  workers[1].emit({attempts:80,bestLevel:candidate('fresh',['AAA','BBB'])});
  assert.equal((await next).name,'fresh');
  client.close();
});
