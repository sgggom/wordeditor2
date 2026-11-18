import test from 'node:test';
import assert from 'node:assert/strict';
import {stageBlockedWords} from '../scripts/lib/stage-cooldown.mjs';
const entry=(position,target,extra)=>({position,level:{targetWords:target.map(word=>({word})),extraWords:extra.map(word=>({word}))}});
test('stage rows release expired prefix words at their own position',()=>{
 const entries=[entry(1,['CAT'],['CATS']),entry(2,['DOG'],['DOGS']),entry(50,['BEE'],['BEES'])];
 const sets=stageBlockedWords(entries,[{position:51},{position:52},{position:53}]);
 assert.deepEqual([...sets.get(51)],['CAT','CATS','DOG','DOGS','BEE','BEES']);
 assert.deepEqual([...sets.get(52)],['DOG','DOGS','BEE','BEES']);
 assert.deepEqual([...sets.get(53)],['BEE','BEES']);
});
test('future retained baselines stay reserved and the current row is excluded',()=>{
 const future=entry(90,['FUTURE'],['FUTURES']).level;
 const sets=stageBlockedWords([entry(61,['SELF'],[]),entry(60,['PAST'],[])],[{position:61}],{futureLevels:[future]});
 assert.deepEqual([...sets.get(61)],['PAST','FUTURE','FUTURES']);
});
