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
import {stageMetrics,checkStageComplete,createStageContext,checkStageCandidate,resolveStageBudget} from './lib/stage-budget.mjs';
import {boardFamily,boardOrientations,letterMultiset} from './lib/board-identity.mjs';
import {createSeedSearch} from './lib/seed-search.mjs';
import {promoteExtraTargets} from './lib/target-promotion.mjs';
import {stageBlockedWords} from './lib/stage-cooldown.mjs';

const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const out=option('--out','outputs/20261113-tightened-first-50'),from=Number(option('--from',6)),through=Number(option('--through',20)),python=option('--python','python3');
const solveOnly=args.includes('--solve-only'),solverSeconds=Number(option('--solver-seconds',0));
const solverBackend=option('--solver-backend','auto');assert.ok(['auto','milp'].includes(solverBackend));
const planFile=option('--plan','level-editor/dist/data/level-plan-tightened-first-50.json');
const read=file=>JSON.parse(fs.readFileSync(file)),sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const progress=read(out+'/progress.json'),plan=read(planFile);
const strategyFile='level-editor/dist/data/tightened-seed-strategy.json',strategy=read(strategyFile),strategyHash=sha(strategyFile);
assert.equal(plan.id,progress.planId);
for(const [file,hash]of Object.entries(progress.sources))assert.equal(sha(file),hash,file);
const required=read('level-editor/dist/data/required-words.json'),guide=read('level-editor/dist/data/guide-words.json'),extras=read('level-editor/dist/data/extra-words.json');
const dictionary=[...required,...guide,...extras.map(word=>({...word,onlyExtra:true}))],lookup=new Map(dictionary.map(word=>[word.word,word]));
const whitelist=plan.targetSupplementation?new Set([...required,...guide].filter(word=>word.rarityLevel>=1&&word.rarityLevel<=4&&!word.abbreviation).map(word=>word.word)):new Set(read('level-editor/dist/data/candidate-words.json').words.map(word=>word[0]));
const supplementalGames=plan.targetSupplementation?read(plan.targetSupplementation.baselineFile).level:null;
const supplementalLevels=supplementalGames?importGameLevels({level:supplementalGames,daily:[]},dictionary):null;
const baselineOwners=new Map((supplementalGames??[]).map((game,index)=>[letterMultiset(game.a),index+1]));
const source=read('level-editor/dist/data/presets/our-levels-adaptive-pool-manual-opening-1000-2026-11-12.json');
const prefixSource=plan.continuation?.prefixFile?read(plan.continuation.prefixFile):source;
if(plan.continuation?.prefixFile)assert.equal(sha(plan.continuation.prefixFile),plan.continuation.prefixSha256,'已确认的前序关卡发生变化');
const opening=importGameLevels({level:prefixSource.level.slice(0,5),daily:[]},dictionary);
const prefix=progress.selected.filter(entry=>entry.position<from),originalBudget=plan.stageBudgets.find(budget=>budget.from===from&&budget.to===through);
assert.ok(originalBudget,'按完整阶段联合生成');
const budget=resolveStageBudget(plan,originalBudget,prefix);
assert.equal(prefix.length,from-6);assert.ok(budget);
const rows=plan.records.filter(row=>row.position>=from&&row.position<=through);
const blockedByPosition=stageBlockedWords([...opening.map((level,index)=>({position:index+1,level})),...prefix],rows,{futureLevels:supplementalLevels?.slice(through)??[]});
const historical=[...source.level,...['outputs/20261112-new-plan-through-50/game.json','outputs/20261112-reference-size-plan-through-50/game.json',
 'outputs/20261112-composition-fresh-through-100/game.json','outputs/20261112-reference-size-fresh-through-100/game.json',
 'outputs/20261112-stage-budget-v6-fresh-through-50/game.json',...(progress.excludeGameFiles??[])].flatMap(file=>read(file).level),...prefix.map(entry=>entry.game)];
const forbiddenBags=new Set(historical.map(game=>letterMultiset(game.a)));
const generator=createGenerator([...required,...guide],extras,{targetWordWhitelist:[...whitelist]});
const hooks={},make=await createBoundedGenerator(),bounded=make([...required,...guide],extras,{targetWordWhitelist:[...whitelist],trial:hooks});
let rng=(progress.rngState+20261113)>>>0;const random=()=>((rng=(Math.imul(rng,1664525)+1013904223)>>>0)/4294967296);
const shapeCache=new Map(),gridMask=grid=>grid.replace(/[A-Z]/g,'1').replaceAll('-','0');
const shapeKey=mask=>{if(!shapeCache.has(mask))shapeCache.set(mask,boardFamily(mask));return shapeCache.get(mask);};
const used=stageMetrics(prefix.filter(entry=>entry.position>=budget.from).map(entry=>entry.level),budget);
const abstractContexts=new Map(rows.map(row=>[row.position,createStageContext({...budget,directionPacing:null},row,prefix.filter(entry=>entry.position>=budget.from).map(entry=>entry.level),rows.filter(other=>other.position!==row.position))]));
const previousWords=0;
const library=[...(progress.candidateLibraryFile?read(progress.candidateLibraryFile).freshInventory:[]),...(progress.candidatePoolFiles??[]).flatMap(file=>read(file).entries.map(entry=>({grid:entry.game.a})))];
const distinctLibrary=[...new Map(library.map(base=>[base.grid,base])).values()];
const caches=new Map(),pools=new Map(rows.map(row=>[row.position,new Map()])),bagVariants=new Map(),profileCounts=new Map(),states=new Map();
const semantics=new Map();
const profileKey=(row,composition)=>row.position+':'+[3,4,5,6,7,8].map(length=>composition.lengthCounts[length]??0).join(',');
const semanticKey=entry=>JSON.stringify([entry.position,entry.bag,[...entry.words].sort(),Object.entries(entry.metrics).filter(([,value])=>value).sort()]);
const keyForEntry=entry=>entry.position+':'+[3,4,5,6,7,8].map(length=>entry.metrics['length:'+length]??0).join(',');
function remove(row,entry){const key=keyForEntry(entry),bagKey=row.position+':'+entry.bag+':'+key;pools.get(row.position).delete(entry.id);profileCounts.set(key,(profileCounts.get(key)??1)-1);bagVariants.set(bagKey,(bagVariants.get(bagKey)??1)-1);if(semantics.get(semanticKey(entry))===entry.id)semantics.delete(semanticKey(entry));}
function insert(row,entry){
 const pool=pools.get(row.position),key=keyForEntry(entry),bagKey=row.position+':'+entry.bag+':'+key,signature=semanticKey(entry),existingId=semantics.get(signature);
 if(pool.has(entry.id))return false;
 if(existingId){const existing=pool.get(existingId);if(budget.preserveBoards&&existing.preservedBoard!==entry.preservedBoard){if(existing.preservedBoard)return false;}else if(existing.cost<=entry.cost)return false;remove(row,existing);}
 if(pool.size>=strategy.poolLimit||(profileCounts.get(key)??0)>=strategy.maxPerLengthProfile||(bagVariants.get(bagKey)??0)>=(budget.directionMetric?8:3))return false;
 pool.set(entry.id,entry);semantics.set(signature,entry.id);profileCounts.set(key,(profileCounts.get(key)??0)+1);bagVariants.set(bagKey,(bagVariants.get(bagKey)??0)+1);states.get(row.position).accepted++;return true;
}
let searched=0,generationCalls=0,stopped=false;process.once('SIGINT',()=>stopped=true);
const started=Date.now();
function foundFor(grid){
 if(caches.has(grid))return caches.get(grid);
 const lines=grid.split(','),letters=[...grid.replaceAll(',','')].map(letter=>letter==='-'?'':letter),disabledCells=letters.flatMap((letter,index)=>letter?[]:[index]);
 const found=generator.findWords({rows:lines.length,columns:lines[0].length,letters,disabledCells,minimumWordLength:3});
 if(caches.size>=500)caches.delete(caches.keys().next().value);caches.set(grid,found);searched++;return found;
}
function admitCandidate(level,row,metadata={}){
 const game=createGameExport([{level}]).level[0],id=row.position+':'+createHash('sha256').update(JSON.stringify(game)).digest('hex').slice(0,20);
 const old=supplementalLevels?.[row.position-1],oldNames=new Set(old?.targetWords.map(word=>word.word)??[]),newNames=new Set(level.targetWords.map(word=>word.word));
 const preservedBoard=Boolean(supplementalGames?.[row.position-1]&&boardFamily(game.a)===boardFamily(supplementalGames[row.position-1].a)),lost=[...oldNames].filter(word=>!newNames.has(word)).length;
 const compared=compareLevelPlan(level,row);assert.ok(compared.passed);
 const cost=compared.actual.words.reduce((sum,word,index)=>sum+Math.abs(word.score-row.referenceWordScores[index]),0)+level.extraWords.length*.5+compositionCost(measureComposition(level),row.targetComposition,{})*.1+lost*100+level.targetWords.reduce((sum,word)=>sum+word.rarityLevel,0)*.5;
 return insert(row,{position:row.position,id,context:'joint-stage-20261113',level:{...level,foundWords:undefined,candidateWords:level.targetWords,initialWords:[]},game,compared,cost,metrics:stageMetrics([level],budget),words:[...new Set([...level.targetWords,...level.extraWords].map(word=>word.word))],bag:letterMultiset(game.a),preservedBoard,preservedTargets:lost===0,promoted:preservedBoard?level.targetWords.filter(word=>!oldNames.has(word.word)).map(word=>word.word):[],...metadata});
}
function collect(grid,row,deadline,found=null){
 const blocked=blockedByPosition.get(row.position);
 const bag=letterMultiset(grid),pool=pools.get(row.position),bagKey=row.position+':'+bag;
 if(forbiddenBags.has(bag)||baselineOwners.has(bag)&&baselineOwners.get(bag)!==row.position||pool.size>=strategy.poolLimit)return;
 found??=foundFor(grid);
 const letters=[...grid.replaceAll(',','')].map(letter=>letter==='-'?'':letter);
 const profiles=row.scoreProfiles??[row.scoreCounts],state=states.get(row.position),start=state.profileCursor++%profiles.length;
 for(let offset=0;offset<profiles.length&&offset<8&&Date.now()<deadline;offset++){
 const selectionRow={...row,scoreCounts:profiles[(start+offset)%profiles.length]};
 selectPlannedTargets({row:selectionRow,letters,found,whitelist,blocked,random,nodeLimit:60000,withinBudget:()=>Date.now()<deadline&&!stopped,
  normalizeCandidate:level=>{const imported=importGameLevels(createGameExport([{level}]),dictionary)[0];return compareLevelPlan(imported,row).passed?{...level,...imported}:null;},
  onComposition:composition=>checkStageCandidate(composition,abstractContexts.get(row.position))&&(profileCounts.get(profileKey(row,composition))??0)<strategy.maxPerLengthProfile,
  onCandidate:level=>{admitCandidate(level,row);return false;}});
 }
}

for(const row of rows){
 const blocked=blockedByPosition.get(row.position);
 const mask=row.boardMask.join(','),key=shapeKey(mask),bases=[];
 for(const base of distinctLibrary){
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
 const templates=row.targetComposition.allowedTemplates.filter(vector=>checkStageCandidate({lengthCounts:Object.fromEntries(vector.map((count,index)=>[index+3,count]))},abstractContexts.get(row.position),{countsOnly:true}));
 for(let i=templates.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[templates[i],templates[j]]=[templates[j],templates[i]];}
 states.set(row.position,{bases,cursor:0,variants:[],templates,templateCursor:0,accepted:0,profileCursor:0,pendingOrientations:[],seeds:createSeedSearch({row,whitelist,dictionary:lookup,blocked,random,config:strategy})});
 console.log(JSON.stringify({position:row.position,inventory:bases.length}));
}
if(supplementalLevels)for(const row of rows){
 if(!supplementalLevels[row.position-1])continue;
 const promotion=promoteExtraTargets({baseline:supplementalLevels[row.position-1],row,dictionary,eligibleWords:whitelist});
 for(const candidate of promotion.candidates)if(checkStageCandidate(measureComposition(candidate.level),abstractContexts.get(row.position)))admitCandidate(candidate.level,row,{promoted:candidate.promoted,preservedTargets:true});
 console.log(JSON.stringify({position:row.position,promotionCandidates:promotion.candidates.length,eligibleExtras:promotion.eligible,needed:promotion.required}));
}
const cacheFile=out+`/candidate-pools-${from}-${through}.json`,restoreCacheFile=option('--candidate-cache',cacheFile);
const cacheKey=createHash('sha256').update(JSON.stringify([sha(planFile),[...blockedByPosition].map(([position,words])=>[position,[...words].sort()]),progress.sources['level-editor/dist/data/required-words.json'],progress.sources['level-editor/dist/data/guide-words.json'],progress.sources['level-editor/dist/data/extra-words.json']])).digest('hex');
if(fs.existsSync(restoreCacheFile)){
 const saved=read(restoreCacheFile);
 if(saved.key===cacheKey){
  if(restoreCacheFile!==cacheFile)progress.sources[restoreCacheFile]=sha(restoreCacheFile);
  for(const entry of saved.entries){const row=rows.find(row=>row.position===entry.position);if(!row||forbiddenBags.has(letterMultiset(entry.game.a)))continue;const level=importGameLevels({level:[entry.game],daily:[]},dictionary)[0],compared=compareLevelPlan(level,row);assert.ok(compared.passed);insert(row,{...entry,level:{...level,candidateWords:level.targetWords,initialWords:[]},compared,metrics:stageMetrics([level],budget)});}
  rng=saved.rng;
  for(const row of rows){const state=states.get(row.position),old=saved.states[row.position];if(old){state.cursor=Math.min(old.cursor,state.bases.length);state.templateCursor=old.templateCursor;if(saved.strategyHash===strategyHash)state.seeds.restore(old.seeds);}}
  console.log(JSON.stringify({restoredCandidates:saved.entries.length}));
 }
}
function checkpointPools(){const entries=rows.flatMap(row=>[...pools.get(row.position).values()].map(({level,compared,...entry})=>entry)),saved={key:cacheKey,strategyHash,rng,entries,states:Object.fromEntries(rows.map(row=>{const state=states.get(row.position);return [row.position,{cursor:state.cursor,templateCursor:state.templateCursor,seeds:state.seeds.snapshot()}];}))};fs.writeFileSync(cacheFile+'.tmp',JSON.stringify(saved));fs.renameSync(cacheFile+'.tmp',cacheFile);}
function refreshPools(){
 const wordRows=new Map();for(const row of rows)for(const entry of pools.get(row.position).values())for(const word of entry.words){if(!wordRows.has(word))wordRows.set(word,new Set());wordRows.get(word).add(row.position);}
 for(const row of rows){const pool=pools.get(row.position),target=Math.ceil(pool.size*strategy.refreshFractionAfterFailure),ranked=[...pool.values()].map(entry=>({entry,score:entry.words.reduce((sum,word)=>sum+Math.log1p(wordRows.get(word).size-1),0)+entry.level.extraWords.length*.5+random()*3})).sort((a,b)=>b.score-a.score);let removed=0;
  for(const {entry}of ranked){if(removed>=target)break;const key=keyForEntry(entry);if(entry.preservedBoard||(profileCounts.get(key)??0)<=2)continue;remove(row,entry);removed++;}
 }
}
function inventorySlice(row,milliseconds){
 const state=states.get(row.position),deadline=Date.now()+milliseconds;
 while(Date.now()<deadline&&!stopped&&pools.get(row.position).size<strategy.poolLimit){
  if(!state.variants.length){if(state.cursor>=state.bases.length)break;state.variants=boardOrientations(state.bases[state.cursor++].base.grid).filter(grid=>gridMask(grid)===row.boardMask.join(','));}
  collect(state.variants.pop(),row,Math.min(deadline,Date.now()+40));
 }
}
function generateSlice(row,milliseconds){
 const blocked=blockedByPosition.get(row.position);
 const state=states.get(row.position),deadline=Date.now()+milliseconds;
 while(Date.now()<deadline&&!stopped&&pools.get(row.position).size<strategy.poolLimit){
  if(state.pendingOrientations.length){const grid=state.pendingOrientations.shift();collect(grid,row,Math.min(deadline,Date.now()+45));continue;}
  const template=state.templates[state.templateCursor++%state.templates.length],active=new Set(template.flatMap((count,index)=>count?[index+3]:[]));
  const localDeadline=Math.min(deadline,Date.now()+strategy.millisecondsPerSeed),seed=state.seeds.choose(template),before=state.accepted;
  if(!seed.words.length)continue;
  hooks.withinBudget=()=>Date.now()<localDeadline&&!stopped;hooks.observeBoard=()=>hooks.withinBudget();
  hooks.selectTargets=(filled,found)=>{const grid=Array.from({length:row.rows},(_,r)=>filled.letters.slice(r*row.columns,(r+1)*row.columns).map(letter=>letter||'-').join('')).join(',');const variants=boardOrientations(grid).filter(oriented=>gridMask(oriented)===row.boardMask.join(','));
   state.pendingOrientations.push(...variants.filter(oriented=>oriented!==grid));collect(grid,row,Math.min(localDeadline,Date.now()+45),found);return null;};
  generationCalls++;
  try{bounded.generate({rows:row.rows,columns:row.columns,disabledCells:row.boardMask.join('').split('').flatMap((bit,index)=>bit==='0'?[index]:[]),
   minimumWordLength:3,desiredTargetCount:row.targetCount,filters:{rarityLevel:[1,2,3,4]},fixedWords:seed.words,fixedLayout:null,initialRarityLevel:null,
   initialForwardProbability:[95,75,50,25][state.templateCursor%4],reservedTargetWords:[...whitelist].filter(word=>!active.has(word.length)),
   duplicateCheck:{target:{range:50,words:[...blocked],levelIds:[]},extra:{range:0,words:[],levelIds:[]}},random});}
  catch(error){if(error.code!=='GENERATION_RETRY'&&!error.message.includes('没有可安全完成的摆法'))throw error;}
  finally{state.seeds.finish(seed.words,state.accepted>before);}
 }
}
let answer=null;
for(let cycle=0;cycle<(solveOnly?1:30)&&!stopped;cycle++){
 if(!solveOnly)for(const row of rows){inventorySlice(row,cycle?500:2200);generateSlice(row,cycle?2200:1000);await new Promise(resolve=>setImmediate(resolve));console.log(JSON.stringify({cycle,position:row.position,candidates:pools.get(row.position).size,seeds:states.get(row.position).seeds.stats(),elapsedSeconds:Math.round((Date.now()-started)/1000)}));}
 checkpointPools();
 const request={mode:'candidates',backend:solverBackend,budget,used,previousWords,rows:rows.map(row=>({position:row.position,targetCount:row.targetCount,candidates:[...pools.get(row.position).values()].map(({id,metrics,words,bag,cost,preservedBoard})=>({id,metrics,words,bag,cost,preservedBoard}))}))};
 if(solverSeconds)request.timeLimits={seed:0,center:solverSeconds,quality:7};
 fs.writeFileSync(out+`/solver-input-${from}-${through}.json`,JSON.stringify(request));
 const result=spawnSync(python,['level-editor/scripts/lib/solve-tightened-stage.py'],{input:JSON.stringify(request),encoding:'utf8',timeout:Math.max(100000,(solverSeconds+35)*1000),maxBuffer:1024*1024});
 if(result.error||result.status!==0)throw new Error(result.error?.message??result.stderr);
 const solved=JSON.parse(result.stdout);console.log(JSON.stringify({cycle,...solved}));
 if(solved.feasible){const chosen=new Set(solved.selected);answer=rows.flatMap(row=>[...pools.get(row.position).values()].filter(entry=>chosen.has(entry.id)));break;}
 refreshPools();
}
if(!answer){console.log('No complete joint tail yet; checkpoint untouched.');process.exit(stopped?130:1);}
const selected=[...prefix,...answer].sort((a,b)=>a.position-b.position);
assert.equal(selected.length,through-5);
for(const stage of plan.stageBudgets.filter(stage=>stage.to<=through))assert.ok(checkStageComplete(resolveStageBudget(plan,stage,selected),selected.filter(entry=>stage.from<=entry.position&&entry.position<=stage.to).map(entry=>entry.level)).passed);
for(const entry of answer){const row=rows.find(row=>row.position===entry.position),context=createStageContext(budget,row,selected.filter(previous=>budget.from<=previous.position&&previous.position<row.position).map(previous=>previous.level),plan.records.filter(future=>row.position<future.position&&future.position<=budget.to));assert.ok(checkStageCandidate(measureComposition(entry.level),context));}
const proofFile=out+`/joint-stage-${from}-${through}.json`;fs.writeFileSync(proofFile,JSON.stringify({from,to:through,poolCounts:Object.fromEntries(rows.map(row=>[row.position,pools.get(row.position).size])),searched,generationCalls,selected:answer.map(({position,id,game,metrics})=>({position,id,game,metrics}))},null,2)+'\n');
progress.sources[proofFile]=sha(proofFile);progress.selected=selected;progress.rngState=rng;progress.stats.selections+=answer.length;
progress.sources[strategyFile]=strategyHash;
progress.events.push({kind:'joint-stage',from,to:through,proofFile});
fs.writeFileSync(out+'/progress.json.tmp',JSON.stringify(progress,null,2)+'\n');fs.renameSync(out+'/progress.json.tmp',out+'/progress.json');
console.log('JOINT_STAGE_COMPLETE',JSON.stringify({from,to:through,chosen:answer.length,elapsedSeconds:Math.round((Date.now()-started)/1000)}));
