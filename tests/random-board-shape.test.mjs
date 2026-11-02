import test from 'node:test';
import assert from 'node:assert/strict';
import { RANDOM_BOARD_SHAPES, randomizeBoardShape } from '../dist/board-shape.js';
import { createGenerator, generateUntilComplete } from '../dist/level-generator.js';
import { createGenerationClient } from '../dist/generation-client.js';
import { parseConfigTableRows, CONFIG_TABLE_HEADERS } from '../dist/config-table.js';

test('all supplied pools have the correct size, unique masks and full base boards', () => {
  for (const [key, count] of [['3x3',5],['4x3',8],['5x3',19]]) {
    const [columns, rows] = key.split('x').map(Number);
    const shapes = RANDOM_BOARD_SHAPES[key];
    assert.equal(shapes.length, count);
    assert.equal(new Set(shapes.map(JSON.stringify)).size, count);
    for (let i=0;i<count;i++) {
      assert.equal(shapes[i].length, rows);
      assert.ok(shapes[i].every(row => row.length === columns && /^[01]+$/.test(row)));
      const chosen = randomizeBoardShape({rows, columns, randomBoardShape:true}, () => (i+0.5)/count);
      assert.deepEqual(chosen.disabledCells, shapes[i].join('').split('').flatMap((cell,j) => cell==='0'?[j]:[]));
    }
    assert.deepEqual(randomizeBoardShape({rows,columns,randomBoardShape:true},()=>0).disabledCells, []);
  }
  const pinned = {rows:3,columns:3,randomBoardShape:true,fixedLayout:{placements:[]}};
  assert.equal(randomizeBoardShape(pinned), pinned);
});

test('size imports use width then height; unsupported pools remain full rectangles', () => {
  const defaults = {initialForwardProbability:50,targetDuplicateRange:0,extraDuplicateRange:0,filters:{}};
  for(const size of ['2x2','3x3','4x2','4x3','5x2','5x3','4×3']) {
    const [record] = parseConfigTableRows([CONFIG_TABLE_HEADERS,['001',size,'','','[0]','[0]','[1]']],defaults);
    assert.equal(record.config.columns, Number(size[0]));
    assert.equal(record.config.rows, Number(size[2]));
    assert.equal(record.config.randomBoardShape, true);
    assert.deepEqual(record.config.disabledCells, []);
    if(record.config.rows===2) assert.equal(randomizeBoardShape(record.config),record.config);
  }
});

test('random impossible shape falls back to an actual complete rectangular level', async () => {
  const options = {rows:3,columns:3,disabledCells:[1,2,3,5,6,7,8],randomBoardShape:true,
    fixedWords:['CAT','DOG','BEE'],filters:{}};
  const level = await generateUntilComplete(createGenerator(['CAT','DOG','BEE'].map(word=>({word}))),options);
  assert.deepEqual(level.disabledCells, []);
  assert.equal(level.cells.length,9);
  assert.ok(level.cells.every(cell=>cell.letter && !cell.disabled));
  assert.deepEqual(options.disabledCells,[1,2,3,5,6,7,8]);
});

test('exhausted shaped batch falls back once, preserving all level constraints and cancellation', async () => {
  const options={rows:3,columns:4,disabledCells:[0],randomBoardShape:true,fixedWords:['CAT'],filters:{scope:[1]},duplicateCheck:{target:{range:1}}};
  const seen=[], progress=[];
  const level = await generateUntilComplete({generate(config) {
    seen.push(config);
    if(seen.length<3) throw Object.assign(new Error('retry'),{code:'GENERATION_RETRY',attempts:80});
    return {disabledCells:config.disabledCells};
  }}, options,{onProgress:p=>progress.push(p)});
  assert.deepEqual(level.disabledCells,[]);
  assert.deepEqual(seen[1],{...options,disabledCells:[],randomBoardShape:false});
  assert.equal(seen[2],seen[1]);
  assert.deepEqual(progress,[{attempts:80},{attempts:160}]);
  let current=true,calls=0;
  assert.equal(await generateUntilComplete({generate(){calls++;throw Object.assign(new Error('retry'),{code:'GENERATION_RETRY',attempts:80});}},options,
    {isCurrent:()=>current,onProgress:()=>{current=false;}}),null);
  assert.equal(calls,1);
  await assert.rejects(generateUntilComplete({generate(){throw new Error('explicit shape');}},{...options,randomBoardShape:false}),/explicit shape/);
});

test('one random shape is shared by every parallel worker and saved configuration stays intact', async () => {
  const workers=[];
  const client=createGenerationClient({workerCount:3,workerFactory:()=>{const w={postMessage(data){this.data=structuredClone(data);},terminate(){}};workers.push(w);return w;}});
  const options={rows:3,columns:5,disabledCells:[],randomBoardShape:true};
  const result=client.generate(options,{}, {signal:new AbortController().signal});
  assert.deepEqual(workers[0].data,workers[1].data);
  assert.deepEqual(workers[0].data,workers[2].data);
  assert.deepEqual(options.disabledCells,[]);
  workers[0].onmessage({data:{requestId:workers[0].data.requestId,level:{ok:true}}});
  assert.deepEqual(await result,{ok:true});
  client.close();
});
