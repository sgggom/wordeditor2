import {describePath} from '../../dist/level-statistics.js';
const scoreBand=score=>score<3?0:score<6?1:score<9?2:3;
const shapeScores=new Map();
function physicalScores(row){
 const key=row.boardMask.join(',');if(shapeScores.has(key))return shapeScores.get(key);
 const enabled=row.boardMask.join('').split('').map(bit=>bit==='1'),neighbors=enabled.map((_,cell)=>[cell-row.columns,cell+row.columns,...(cell%row.columns?[cell-1]:[]),...(cell%row.columns<row.columns-1?[cell+1]:[])].filter(next=>next>=0&&next<enabled.length&&enabled[next]));
 const scores=Object.fromEntries([3,4,5,6,7,8].map(length=>[length,new Set()]));
 function visit(cell,used,path){const route=[...path,cell];used|=1<<cell;if(route.length>=3)scores[route.length].add(describePath(route,row.columns).difficultyScore);if(route.length<8)for(const next of neighbors[cell])if(!(used&(1<<next)))visit(next,used,route);}
 enabled.forEach((on,cell)=>{if(on)visit(cell,0,[]);});shapeScores.set(key,scores);return scores;
}
const letterCounts=word=>{const counts={};for(const letter of word)counts[letter]=(counts[letter]??0)+1;return counts;};
function minimumCells(words){const counts={};for(const word of words)for(const [letter,count]of Object.entries(letterCounts(word)))counts[letter]=Math.max(counts[letter]??0,count);return Object.values(counts).reduce((a,b)=>a+b,0);}
export function createFailureTracker(config){
 let serial=0;const failures=new Map(),recent=[];
 return {advance(){serial++;},eligible(word){return (failures.get(word)?.until??0)<=serial&&!recent.includes(word);},
  cooling(word){return (failures.get(word)?.until??0)>serial;},
  finish(words,produced){for(const word of words){const state=failures.get(word)??{count:0,until:0};state.count=produced?0:state.count+1;if(state.count>=config.failuresBeforeCooldown){state.until=serial+config.cooldownSelections;state.count=0;}failures.set(word,state);recent.push(word);while(recent.length>config.recentWordWindow)recent.shift();}},
  stats(){return {selections:serial,coolingWords:[...failures.values()].filter(state=>state.until>serial).length};},
  snapshot(){return {serial,failures:[...failures],recent:[...recent]};},restore(saved){serial=saved.serial;failures.clear();for(const [word,state]of saved.failures)failures.set(word,state);recent.splice(0,recent.length,...saved.recent);}};
}
export function createSeedSearch({row,whitelist,dictionary,blocked,random,config}){
 const cache=new Map(),scores=physicalScores(row),tracker=createFailureTracker(config);let attempts=0;
 const bands=row.scoreCounts.flatMap((count,band)=>count?[band]:[]);
 function poolsFor(template){
  const active=template.flatMap((count,index)=>count?[index+3]:[]),signature=active.join(',');if(cache.has(signature))return cache.get(signature);
  const pools=Object.fromEntries(active.map(length=>[length,[]]));
  for(const word of whitelist){
   const rarity=dictionary.get(word)?.rarityLevel;if(!pools[word.length]||rarity<1||rarity>4||blocked.has(word))continue;
   let conflict=false;for(const length of active)for(let start=0;start+length<=word.length;start++){const part=word.slice(start,start+length);if(blocked.has(part)||blocked.has([...part].reverse().join(''))){conflict=true;break;}}
   if(conflict)continue;
   const possible=[...scores[word.length]].map(path=>path+rarity*(1+word.length*.1)).filter(score=>score<=12).map(scoreBand);
   if(possible.some(band=>row.scoreCounts[band]>0))pools[word.length].push({word,bands:new Set(possible)});
  }
  cache.set(signature,pools);return pools;
 }
 function choose(template){
  attempts++;tracker.advance();const active=template.flatMap((count,index)=>count?[index+3]:[]),longs=template.flatMap((count,index)=>index>=3?Array(count).fill(index+3):[]),mode=config.modes[(attempts-1)%config.modes.length],pools=poolsFor(template);
  let lengths=mode==='long-five'&&longs.length&&template[2]?[longs[Math.floor(random()*longs.length)],5]:
   mode==='five-four'&&template[1]&&template[2]?[5,4]:mode==='two-longs-five'&&longs.length===2&&template[2]?[...longs,5]:[active[Math.floor(random()*active.length)]];
  const words=[];
  for(const length of lengths){
   let pool=(pools[length]??[]).filter(entry=>!words.includes(entry.word)&&!words.some(word=>word===entry.word+'S'||entry.word===word+'S')&&minimumCells([...words,entry.word])<=row.activeCells&&!tracker.cooling(entry.word));
   const fresh=pool.filter(entry=>tracker.eligible(entry.word));if(fresh.length)pool=fresh;
   const desired=bands[(attempts+words.length)%bands.length],byBand=pool.filter(entry=>entry.bands.has(desired));if(byBand.length)pool=byBand;
   if(!pool.length)continue;
   const known=new Set(words.join(''));let best=null,bestScore=-Infinity;
   for(let sample=0;sample<Math.min(80,pool.length);sample++){
    const candidate=pool[Math.floor(random()*pool.length)],overlap=[...candidate.word].filter(letter=>known.has(letter)).length;
    const cost=random()*2+(words.length?overlap/candidate.word.length*2:0);
    if(cost>bestScore){best=candidate.word;bestScore=cost;}
   }
   words.push(best);
  }
  return {words,mode};
 }
 return {choose,finish:tracker.finish,stats:tracker.stats,snapshot:()=>({attempts,tracker:tracker.snapshot()}),restore:saved=>{attempts=saved.attempts;tracker.restore(saved.tracker);}};
}
