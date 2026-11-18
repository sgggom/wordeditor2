import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {alignReferenceBoardLayout,checkReferenceBoardLayout,competitorPosition} from '../scripts/lib/reference-board-layout.mjs';

const shapes=JSON.parse(fs.readFileSync(new URL('../docs/manual-level-spec/shape-library.json',import.meta.url))).shapes;
function fixture(){
 const reference=Array.from({length:1500},()=>({width:3,height:3}));
 reference[6]={width:4,height:2};reference[9]={width:4,height:3};reference[14]={width:4,height:3};reference[1000]={width:4,height:3};
 const records=Array.from({length:15},(_,i)=>({position:i+6,rows:3,columns:5,activeCells:15,boardMask:['11111','11111','11111'],
  difficulty:'标准',type:'常规探索',targetCount:4,scoreCounts:[2,2,0,0],referenceWordScores:[1.3,2.4,3.4,3.6],
  referenceScore:10.7,scoreMinimum:9.6,scoreMaximum:11.8,maximumWordReference:3.6}));
 return {reference,records};
}
test('ordinary sizes follow the competitor without changing approved score and word-count plans',()=>{
 const {reference,records}=fixture(),before=structuredClone(records);
 const result=alignReferenceBoardLayout(records,reference,shapes);
 assert.deepEqual([result[0].columns,result[0].rows],[3,3]);
 assert.deepEqual([result[1].columns,result[1].rows],[4,2]);
 assert.ok(checkReferenceBoardLayout(result,reference,shapes).passed);
 for(let i=0;i<result.length;i++)for(const key of ['difficulty','targetCount','scoreCounts','referenceWordScores','referenceScore','scoreMinimum','scoreMaximum'])assert.deepEqual(result[i][key],before[i][key]);
 assert.deepEqual(records,before,'alignment must not mutate its input');
});
test('special selection avoids the prior shape and chooses the nearest competitor cell count',()=>{
 const {reference,records}=fixture();
 const result=alignReferenceBoardLayout(records,reference,shapes,{preferredShapes:new Map([[15,28]])});
 const selected=result.filter(r=>r.special);
 assert.deepEqual(selected.map(r=>r.shapeId),[25,28,12]);
 const bad=structuredClone(result);bad[0].columns=4;
 assert.equal(checkReferenceBoardLayout(bad,reference,shapes).passed,false);
});
test('1501–2000 use competitor 1001–1500 for board size only',()=>{
 assert.equal(competitorPosition(1500),1500);assert.equal(competitorPosition(1501),1001);assert.equal(competitorPosition(2000),1500);
 const {reference,records}=fixture();
 const tail=alignReferenceBoardLayout([{...records[0],position:1501}],reference,shapes);
 assert.deepEqual([tail[0].columns,tail[0].rows,tail[0].referencePosition],[4,3,1001]);
 assert.throws(()=>competitorPosition(2001));
});
