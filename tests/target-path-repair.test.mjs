import test from 'node:test';
import assert from 'node:assert/strict';
import { repairConfigurations, createTargetPathRepairRunner, createTargetPathCheckClient } from '../dist/target-path-repair.js';

const level = word => ({ rows: 2, columns: 3, cells: Array(6).fill({ letter: 'A', count: 1 }), disabledCells: [],
  targetWords: [{ word }], extraWords: [], fixedWords: [], filters: {}, initialWords: [], desiredTargetCount: 4, name: `name-${word}` });
const records = () => ['KEEP','OLD','NEXT'].map((word,index)=>({id:index+1,position:index+1,level:level(word)}));
const configs = rows => repairConfigurations(rows, [], {target:50,extra:0});
const pass = {solvable:true,allChoicesComplete:true};

test('only problem levels rerun; unsafe candidates are never saved and passed neighbors remain intact', async () => {
  const rows=records(), original=structuredClone(rows), settings=[], saved=[];
  let checks=0;
  const runner=createTargetPathRepairRunner({
    async generate(config,duplicates){settings.push({config,duplicates});return level(settings.length===1?'BAD':'NEW');},
    async check(){return ++checks===1?{solvable:true,allChoicesComplete:false}:pass;},
    async save(generated,record,position){saved.push({generated,record,position});return {...record,level:generated};},
  });
  const result=await runner.run(rows,configs(rows),[2]);
  assert.equal(result.phase,'complete');assert.equal(result.completed,1);assert.equal(result.attempts,2);
  assert.equal(saved.length,1);assert.equal(saved[0].generated.targetWords[0].word,'NEW');
  assert.equal(saved[0].generated.name,'name-OLD');assert.equal(saved[0].record.id,2);assert.equal(saved[0].position,2);
  assert.ok(settings[0].duplicates.target.words.includes('KEEP'));
  assert.ok(settings[0].config.reservedTargetWords.includes('NEXT'));
  assert.equal(settings[0].config.desiredTargetCount,4);
  assert.deepEqual(rows,original);
});

test('cancellation during analysis preserves the original problem level', async()=>{
  const rows=records();let saves=0,runner;
  runner=createTargetPathRepairRunner({generate:async()=>level('NEW'),check:async()=>{runner.stop();return pass;},save:async()=>{saves++;}});
  const result=await runner.run(rows,configs(rows),[2]);
  assert.equal(result.phase,'stopped');assert.equal(saves,0);assert.equal(result.completed,0);
});

test('save failure reports no completed replacement; a save already committing can finish when stopped',async()=>{
  const rows=records();
  const failure=createTargetPathRepairRunner({generate:async()=>level('NEW'),check:async()=>pass,save:async()=>{throw new Error('quota');}});
  const result=await failure.run(rows,configs(rows),[2]);
  assert.equal(result.phase,'error');assert.equal(result.completed,0);assert.match(result.error,/quota/);
  let runner;
  runner=createTargetPathRepairRunner({generate:async()=>level('NEW'),check:async()=>pass,save:async(generated,record)=>{runner.stop();return {...record,level:generated};}});
  const committed=await runner.run(rows,configs(rows),[1,2]);
  assert.equal(committed.phase,'stopped');assert.equal(committed.completed,1);
});

test('config association requires a source ID or matching dimensions and fixed words for the whole table',()=>{
  const rows=records(), c=configs(rows);
  const matching=c.map((job,index)=>({id:`config-${index}`,config:{...job.config,fixedWords:[rows[index].level.targetWords[0].word],desiredTargetCount:10}}));
  assert.equal(repairConfigurations(rows,matching)[1].config.desiredTargetCount,10);
  matching[0].config.fixedWords=['OTHER'];
  assert.equal(repairConfigurations(rows,matching)[1].config.desiredTargetCount,4);
  assert.throws(()=>repairConfigurations(rows,matching, {target:50,extra:0}, {requireLinked:true}),/对应配置表/);
  rows[1].level.sourceConfig={id:'config-1'};
  assert.equal(repairConfigurations(rows,matching)[1].config.desiredTargetCount,10);
});

test('fixed-word conflicts with a preserved later level stop without changing either record',async()=>{
  const rows=records(), c=configs(rows);c[1].config.fixedWords=['NEXT'];let generated=0;
  const runner=createTargetPathRepairRunner({generate:async()=>{generated++;},check:async()=>pass,save:async()=>{}});
  const result=await runner.run(rows,c,[2]);
  assert.equal(result.phase,'error');assert.match(result.error,/后续/);assert.equal(generated,0);
});

test('check client reuses its Worker, cancels obsolete work, and never accepts failed analysis',async()=>{
  const workers=[];
  const client=createTargetPathCheckClient({workerFactory(){const worker={postMessage(data){this.data=data;},terminate(){this.terminated=true;}};workers.push(worker);return worker;}});
  const controller=new AbortController(), first=client.check(level('OLD'),{signal:controller.signal});
  workers[0].onmessage({data:{result:pass}});assert.deepEqual(await first,pass);
  const second=client.check(level('OLD'),{signal:controller.signal});controller.abort();assert.equal(await second,null);
  const next=client.check(level('NEW'),{signal:new AbortController().signal});
  workers[0].onmessage({data:{result:pass}});workers[1].onmessage({data:{error:'bad'}});
  await assert.rejects(next,/bad/);assert.equal(workers[0].terminated,true);client.close();
});
