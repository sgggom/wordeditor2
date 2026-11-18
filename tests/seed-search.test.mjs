import test from 'node:test';
import assert from 'node:assert/strict';
import {createFailureTracker,createSeedSearch} from '../scripts/lib/seed-search.mjs';

const config={failuresBeforeCooldown:3,cooldownSelections:20,recentWordWindow:0,modes:['five-four']};
test('three failed uses cool a seed for twenty selections and survive a resume',()=>{
 const tracker=createFailureTracker(config);
 for(let attempt=0;attempt<3;attempt++){tracker.advance();tracker.finish(['STONE'],false);}
 assert.equal(tracker.cooling('STONE'),true);
 const restored=createFailureTracker(config);restored.restore(tracker.snapshot());
 for(let attempt=0;attempt<19;attempt++)restored.advance();
 assert.equal(restored.eligible('STONE'),false);restored.advance();assert.equal(restored.eligible('STONE'),true);
 restored.finish(['STONE'],true);
 for(let attempt=0;attempt<2;attempt++){restored.advance();restored.finish(['STONE'],false);}
 assert.equal(restored.cooling('STONE'),false);
});

function search(modes,blocked=new Set()){
 const words=['STONE','NOTE','NOTES','TON','TONER','TONE','STONES'];let rng=7;
 return createSeedSearch({row:{columns:3,rows:3,boardMask:['111','111','111'],activeCells:9,scoreCounts:[8,8,8,8]},
  whitelist:new Set(words),dictionary:new Map(words.map(word=>[word,{rarityLevel:1}])),blocked,
  random:()=>((rng=(Math.imul(rng,1664525)+1013904223)>>>0)/4294967296),config:{...config,modes}});
}
test('combined seed modes select distinct requested lengths and respect blocked words',()=>{
 const seeds=search(['five-four'],new Set(['STONE']));
 for(let attempt=0;attempt<10;attempt++){
  const {words}=seeds.choose([1,1,1,0,0,0]);assert.deepEqual(words.map(word=>word.length),[5,4]);
  assert.ok(!words.includes('STONE'));assert.ok(!words.some(word=>words.includes(word+'S')));seeds.finish(words,true);
 }
 const long=search(['long-five']).choose([0,0,1,1,0,0]);assert.deepEqual(long.words.map(word=>word.length),[6,5]);
});
test('mixed starts include short words instead of always choosing the longest',()=>{
 const seeds=search(['mixed']),lengths=new Set();
 for(let attempt=0;attempt<30;attempt++){const {words}=seeds.choose([1,1,1,0,0,0]);lengths.add(words[0].length);seeds.finish(words,true);}
 assert.deepEqual([...lengths].sort(),[3,4,5]);
 const saved=seeds.snapshot(),restored=search(['mixed']);restored.restore(saved);assert.deepEqual(restored.snapshot(),saved);
});
test('a seed also excludes cooled words read backwards along its path',()=>{
 const words=['REFLECT','CAPTURE','ELECT'];
 const seeds=createSeedSearch({row:{rows:3,columns:4,boardMask:['1111','1111','1111'],activeCells:12,scoreCounts:[5,5,1,0]},
  whitelist:new Set(words),dictionary:new Map(words.map(word=>[word,{rarityLevel:1}])),blocked:new Set(['ELF']),random:()=>.4,
  config:{...config,modes:['long-five']}});
 for(let attempt=0;attempt<8;attempt++){const seed=seeds.choose([3,5,1,0,1,0]);assert.ok(!seed.words.includes('REFLECT'));assert.ok(seed.words.includes('CAPTURE'));}
});
