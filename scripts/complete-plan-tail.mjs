import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createGenerator} from '../dist/level-generator.js';
import {importGameLevels} from '../dist/level-import.js';
import {createGameExport} from '../dist/level-export.js';
import {createBoundedGenerator} from './lib/bounded-generator.mjs';
import {compareLevelPlan,selectPlannedTargets} from './lib/level-plan.mjs';
import {measureComposition,compositionCost} from './lib/target-composition.mjs';
import {stageMetrics,checkStageComplete,createStageContext,checkStageCandidate} from './lib/stage-budget.mjs';
import {boardFamily,boardOrientations,letterMultiset} from './lib/board-identity.mjs';

const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const out=option('--out','outputs/20261112-stage-budget-v6-fresh-through-50'),from=Number(option('--from',44)),python=option('--python','python3');
const read=file=>JSON.parse(fs.readFileSync(file)),sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const progress=read(out+'/progress.json'),plan=read('outputs/20261112-stage-budget-first-50/plan.json');
assert.equal(plan.id,progress.planId);
for(const [file,hash]of Object.entries(progress.sources))assert.equal(sha(file),hash,file);
const required=read('level-editor/dist/data/required-words.json'),guide=read('level-editor/dist/data/guide-words.json'),extras=read('level-editor/dist/data/extra-words.json');
const dictionary=[...required,...guide,...extras.map(word=>({...word,onlyExtra:true}))],lookup=new Map(dictionary.map(word=>[word.word,word]));
const whitelist=new Set(read('level-editor/dist/data/candidate-words.json').words.map(word=>word[0]));
const source=read('level-editor/dist/data/presets/our-levels-adaptive-pool-manual-opening-1000-2026-11-12.json');
const opening=importGameLevels({level:source.level.slice(0,5),daily:[]},dictionary);
const prefix=progress.selected.filter(entry=>entry.position<from),budget=plan.stageBudgets.find(budget=>budget.from<=from&&budget.to===50);
assert.equal(prefix.length,from-6);assert.ok(budget);
const rows=plan.records.filter(row=>row.position>=from&&row.position<=50);
const blocked=new Set([...opening,...prefix.map(entry=>entry.level)].flatMap(level=>[...level.targetWords,...level.extraWords].map(word=>word.word)));
const historical=[...source.level,...['outputs/20261112-new-plan-through-50/game.json','outputs/20261112-reference-size-plan-through-50/game.json',
 'outputs/20261112-composition-fresh-through-100/game.json','outputs/20261112-reference-size-fresh-through-100/game.json'].flatMap(file=>read(file).level),...prefix.map(entry=>entry.game)];
const forbiddenBags=new Set(historical.map(game=>letterMultiset(game.a)));
const generator=createGenerator([...required,...guide],extras,{targetWordWhitelist:[...whitelist]});
const hooks={},make=await createBoundedGenerator(),bounded=make([...required,...guide],extras,{targetWordWhitelist:[...whitelist],trial:hooks});
let rng=(progress.rngState+20261113)>>>0;const random=()=>((rng=(Math.imul(rng,1664525)+1013904223)>>>0)/4294967296);
const shapeCache=new Map(),gridMask=grid=>grid.replace(/[A-Z]/g,'1').replaceAll('-','0');
const shapeKey=mask=>{if(!shapeCache.has(mask))shapeCache.set(mask,boardFamily(mask));return shapeCache.get(mask);};
const used=stageMetrics(prefix.filter(entry=>entry.position>=budget.from).map(entry=>entry.level));
const abstractContexts=new Map(rows.map(row=>[row.position,createStageContext({...budget,directionPacing:null},row,prefix.filter(entry=>entry.position>=budget.from).map(entry=>entry.level),rows.filter(other=>other.position!==row.position))]));
const previousWords=prefix.filter(entry=>entry.position>=budget.from).reduce((sum,entry)=>sum+entry.level.targetWords.length,0);
const caches=new Map(),pools=new Map(rows.map(row=>[row.position,new Map()])),bagVariants=new Map(),profileCounts=new Map(),states=new Map();
const profileKey=(row,composition)=>row.position+':'+[3,4,5,6,7,8].map(length=>composition.lengthCounts[length]??0).join(',');
let searched=0,generationCalls=0,stopped=false;process.once('SIGINT',()=>stopped=true);
const started=Date.now();
function foundFor(grid){
 if(caches.has(grid))return caches.get(grid);
 const lines=grid.split(','),letters=[...grid.replaceAll(',','')].map(letter=>letter==='-'?'':letter),disabledCells=letters.flatMap((letter,index)=>letter?[]:[index]);
 const found=generator.findWords({rows:lines.length,columns:lines[0].length,letters,disabledCells,minimumWordLength:3});
 if(caches.size>=500)caches.delete(caches.keys().next().value);caches.set(grid,found);searched++;return found;
}
function collect(grid,row,deadline,found=null){
 const bag=letterMultiset(grid),pool=pools.get(row.position),bagKey=row.position+':'+bag;
 if(forbiddenBags.has(bag)||pool.size>=700)return;
 found??=foundFor(grid);
 const letters=[...grid.replaceAll(',','')].map(letter=>letter==='-'?'':letter);
 selectPlannedTargets({row,letters,found,whitelist,blocked,random,nodeLimit:60000,withinBudget:()=>Date.now()<deadline&&!stopped,
  normalizeCandidate:level=>{const imported=importGameLevels(createGameExport([{level}]),dictionary)[0];return compareLevelPlan(imported,row).passed?{...level,...imported}:null;},
  onComposition:composition=>checkStageCandidate(composition,abstractContexts.get(row.position))&&(profileCounts.get(profileKey(row,composition))??0)<40,
  onCandidate:level=>{
   const game=createGameExport([{level}]).level[0],id=row.position+':'+createHash('sha256').update(JSON.stringify(game)).digest('hex').slice(0,20);
   const key=profileKey(row,measureComposition(level)),bagProfile=bagKey+':'+key;
   if(pool.has(id)||(bagVariants.get(bagProfile)??0)>=3||pool.size>=700)return false;
   const compared=compareLevelPlan(level,row);assert.ok(compared.passed);
   const cost=compared.actual.words.reduce((sum,word,index)=>sum+Math.abs(word.score-row.referenceWordScores[index]),0)+level.extraWords.length*.5+compositionCost(measureComposition(level),row.targetComposition,{})*.1;
   const clean={...level,foundWords:undefined,candidateWords:level.targetWords,initialWords:[]};
   pool.set(id,{position:row.position,id,context:'joint-tail-20261113',level:clean,game,compared,cost,
    metrics:stageMetrics([level]),words:[...new Set([...level.targetWords,...level.extraWords].map(word=>word.word))],bag});
   bagVariants.set(bagProfile,(bagVariants.get(bagProfile)??0)+1);profileCounts.set(key,(profileCounts.get(key)??0)+1);return false;
  }});
}
for(const row of rows){
 const mask=row.boardMask.join(','),key=shapeKey(mask),bases=[];
 for(const base of progress.freshInventory??[]){
  if(shapeKey(gridMask(base.grid))!==key||forbiddenBags.has(letterMultiset(base.grid)))continue;
  if(base.recognizedWords){
   const forbiddenLengths=new Set(base.recognizedWords.filter(word=>blocked.has(word)).map(word=>word.length));
   const eligible=base.recognizedWords.filter(word=>whitelist.has(word)&&!blocked.has(word)&&!forbiddenLengths.has(word.length)&&(!row.targetComposition.noThreeLetter||word.length!==3));
   const counts={};for(const word of eligible)counts[word.length]=(counts[word.length]??0)+1;
   if(eligible.length<row.targetCount||!row.targetComposition.allowedTemplates.some(vector=>vector.every((count,index)=>count<=(counts[index+3]??0))))continue;
   bases.push({base,rank:Math.abs(eligible.length-row.targetCount)+random()});
  }else bases.push({base,rank:random()});
 }
 bases.sort((a,b)=>a.rank-b.rank);
 states.set(row.position,{bases,cursor:0,variants:[],templates:[...row.targetComposition.allowedTemplates].sort(()=>random()-.5),templateCursor:0});
 console.log(JSON.stringify({position:row.position,inventory:bases.length}));
}
function inventorySlice(row,milliseconds){
 const state=states.get(row.position),deadline=Date.now()+milliseconds;
 while(Date.now()<deadline&&!stopped&&pools.get(row.position).size<700){
  if(!state.variants.length){if(state.cursor>=state.bases.length)break;state.variants=boardOrientations(state.bases[state.cursor++].base.grid).filter(grid=>gridMask(grid)===row.boardMask.join(','));}
  collect(state.variants.pop(),row,Math.min(deadline,Date.now()+40));
 }
}
function generateSlice(row,milliseconds){
 const state=states.get(row.position),deadline=Date.now()+milliseconds;
 while(Date.now()<deadline&&!stopped&&pools.get(row.position).size<700){
  const template=state.templates[state.templateCursor++%state.templates.length],active=new Set(template.flatMap((count,index)=>count?[index+3]:[]));
  const length=Math.max(...active),localDeadline=Math.min(deadline,Date.now()+200);
  const words=[...whitelist].filter(word=>word.length===length&&!blocked.has(word)&&lookup.get(word)?.rarityLevel<=4&&![...active].some(size=>Array.from({length:Math.max(0,word.length-size+1)},(_,start)=>word.slice(start,start+size)).some(part=>blocked.has(part))));
  if(!words.length)continue;
  const anchor=words[Math.floor(random()*words.length)];
  hooks.withinBudget=()=>Date.now()<localDeadline&&!stopped;hooks.observeBoard=()=>hooks.withinBudget();
  hooks.selectTargets=(filled,found)=>{const grid=Array.from({length:row.rows},(_,r)=>filled.letters.slice(r*row.columns,(r+1)*row.columns).map(letter=>letter||'-').join('')).join(',');collect(grid,row,localDeadline,found);return null;};
  generationCalls++;
  try{bounded.generate({rows:row.rows,columns:row.columns,disabledCells:row.boardMask.join('').split('').flatMap((bit,index)=>bit==='0'?[index]:[]),
   minimumWordLength:3,desiredTargetCount:row.targetCount,filters:{rarityLevel:[1,2,3,4]},fixedWords:[anchor],fixedLayout:null,initialRarityLevel:null,
   initialForwardProbability:75,reservedTargetWords:[...whitelist].filter(word=>!active.has(word.length)),
   duplicateCheck:{target:{range:50,words:[...blocked],levelIds:[]},extra:{range:0,words:[],levelIds:[]}},random});}
  catch(error){if(error.code!=='GENERATION_RETRY'&&!error.message.includes('没有可安全完成的摆法'))throw error;}
 }
}
let answer=null;
for(let cycle=0;cycle<30&&!stopped;cycle++){
 for(const row of rows){inventorySlice(row,cycle?500:2200);generateSlice(row,cycle?2200:1000);console.log(JSON.stringify({cycle,position:row.position,candidates:pools.get(row.position).size,elapsedSeconds:Math.round((Date.now()-started)/1000)}));}
 const request={budget,used,previousWords,rows:rows.map(row=>({position:row.position,targetCount:row.targetCount,candidates:[...pools.get(row.position).values()].map(({id,metrics,words,bag,cost})=>({id,metrics,words,bag,cost}))}))};
 const result=spawnSync(python,['level-editor/scripts/lib/solve-stage-candidates.py'],{input:JSON.stringify(request),encoding:'utf8',timeout:25000,maxBuffer:1024*1024});
 if(result.error||result.status!==0)throw new Error(result.error?.message??result.stderr);
 const solved=JSON.parse(result.stdout);console.log(JSON.stringify({cycle,...solved}));
 if(solved.feasible){const chosen=new Set(solved.selected);answer=rows.flatMap(row=>[...pools.get(row.position).values()].filter(entry=>chosen.has(entry.id)));break;}
}
if(!answer){console.log('No complete joint tail yet; checkpoint untouched.');process.exit(stopped?130:1);}
const selected=[...prefix,...answer].sort((a,b)=>a.position-b.position);
assert.equal(selected.length,45);
for(const stage of plan.stageBudgets)assert.ok(checkStageComplete(stage,selected.filter(entry=>stage.from<=entry.position&&entry.position<=stage.to).map(entry=>entry.level)).passed);
for(const entry of answer){const row=rows.find(row=>row.position===entry.position),context=createStageContext(budget,row,selected.filter(previous=>budget.from<=previous.position&&previous.position<row.position).map(previous=>previous.level),plan.records.filter(future=>row.position<future.position&&future.position<=budget.to));assert.ok(checkStageCandidate(measureComposition(entry.level),context));}
const proofFile=out+'/joint-tail-selection.json';fs.writeFileSync(proofFile,JSON.stringify({from,to:50,poolCounts:Object.fromEntries(rows.map(row=>[row.position,pools.get(row.position).size])),searched,generationCalls,selected:answer.map(({position,id,game,metrics})=>({position,id,game,metrics}))},null,2)+'\n');
progress.sources[proofFile]=sha(proofFile);progress.selected=selected;progress.rngState=rng;progress.stats.selections+=answer.length;
progress.events.push({kind:'joint-tail',from,to:50,proofFile});
fs.writeFileSync(out+'/progress.json.tmp',JSON.stringify(progress,null,2)+'\n');fs.renameSync(out+'/progress.json.tmp',out+'/progress.json');
console.log('JOINT_TAIL_COMPLETE',JSON.stringify({from,to:50,chosen:answer.length,elapsedSeconds:Math.round((Date.now()-started)/1000)}));
