import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {createGenerator} from '../dist/level-generator.js';
import {createGameExport} from '../dist/level-export.js';
import {createPresetRecords} from '../dist/preset-level-lists.js';
import {importGameLevels} from '../dist/level-import.js';
import {analyzeTargetPaths} from '../dist/target-path-analysis.js';
import {describePath} from '../dist/level-statistics.js';
import {validateLevelPlan,compareLevelPlan,selectPlannedTargets,scoreBand} from './lib/level-plan.mjs';
import {createBoundedGenerator} from './lib/bounded-generator.mjs';
import {checkReferenceBoardLayout} from './lib/reference-board-layout.mjs';
import {boardOrientations as orientations,boardFamily as family,letterMultiset} from './lib/board-identity.mjs';
import {measureComposition,compositionCost,compositionHistory} from './lib/target-composition.mjs';
import {createStageContext,checkStageCandidate,stageCandidateCost,checkStageComplete,templateMetrics,resolveStageBudget} from './lib/stage-budget.mjs';
import {createStageTailSolver,appendCompositionMetrics} from './lib/stage-tail.mjs';
import {createTightenedStageTailSolver} from './lib/tightened-stage-tail.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
if(args.includes('--help')){
 console.log('node scripts/run-level-plan.mjs --plan JSON --to N --out DIR [--continue-from DIR] [--resume] [--exclude-game JSON] [--reuse-inventory] [--inventory JSON.GZ] [--seed N] [--budget-python PATH]');process.exit(0);
}
const to=Number(option('--to',50)),seed=Number(option('--seed',2026111250));
assert.ok(Number.isInteger(to)&&to>=6&&to<=2000);
const freshGeneration=!args.includes('--reuse-inventory');
const destination=path.resolve(option('--out',path.join(ROOT,`outputs/20261112-composition-${freshGeneration?'fresh':'inventory'}-through-${to}`)));
const continuation=option('--continue-from',null);
if(!args.includes('--resume'))assert.ok(!fs.existsSync(path.join(destination,'progress.json')),'输出已有进度；使用新目录或--resume');
fs.mkdirSync(destination,{recursive:true});
const sources={};
function read(file){const absolute=path.resolve(ROOT,file),bytes=fs.readFileSync(absolute);sources[path.relative(ROOT,absolute)]=createHash('sha256').update(bytes).digest('hex');return JSON.parse(bytes);}
const planFile=option('--plan','level-editor/dist/data/level-plan.json');
const plan=validateLevelPlan(read(planFile));
const budgetPython=option('--budget-python',null),tightened=Boolean(plan.tighteningPolicy),tailSolver=budgetPython?(tightened?createTightenedStageTailSolver: createStageTailSolver)(budgetPython):null;
if(plan.targetSupplementation)for(const file of ['level-editor/scripts/lib/target-promotion.mjs','level-editor/scripts/build-target-floor-plan.mjs'])sources[file]=createHash('sha256').update(fs.readFileSync(path.resolve(ROOT,file))).digest('hex');
if(tailSolver)for(const file of tightened?['level-editor/scripts/lib/solve-tightened-stage.py','level-editor/scripts/lib/direction_policy.py','level-editor/scripts/lib/tightened-stage-tail.mjs','level-editor/scripts/lib/direction-policy.mjs','level-editor/scripts/lib/seed-search.mjs','level-editor/scripts/generate-tightened-stage.mjs','level-editor/dist/word-direction.js','level-editor/scripts/lib/target-composition.mjs','level-editor/scripts/lib/stage-budget.mjs','level-editor/scripts/lib/level-plan.mjs']:['level-editor/scripts/lib/solve-stage-tail.py','level-editor/scripts/lib/stage-tail.mjs'])sources[file]=createHash('sha256').update(fs.readFileSync(path.resolve(ROOT,file))).digest('hex');
const reference=read('level-editor/dist/data/presets/word-tiles-list0.json');
const shapes=read('level-editor/docs/manual-level-spec/shape-library.json').shapes;
const layoutCheck=checkReferenceBoardLayout(plan.records,reference,shapes,{previousSpecialShapeId:12});
assert.ok(layoutCheck.passed,'规划尺寸不符合竞品参考规则：'+JSON.stringify(layoutCheck.violations.slice(0,5)));
const rows=plan.records.filter(r=>r.position>=6&&r.position<=to);
assert.equal(rows.length,to-5);
const required=read('level-editor/dist/data/required-words.json'),guide=read('level-editor/dist/data/guide-words.json'),extra=read('level-editor/dist/data/extra-words.json');
const dictionaryRows=[...required,...guide,...extra.map(e=>({...e,onlyExtra:true}))],dictionary=new Map(dictionaryRows.map(e=>[e.word,e]));
if(plan.targetSupplementation){
 const baseline=read(plan.targetSupplementation.baselineFile),referenceLevels=createPresetRecords(reference.slice(0,to),'word-tiles',dictionaryRows);
 assert.equal(sources[plan.targetSupplementation.baselineFile],plan.targetFloorSources[plan.targetSupplementation.baselineFile],'补词原始关卡发生变化');
 for(const row of rows){
  assert.ok(row.minimumTargetCount>=referenceLevels[row.position-1].level.targetWords.length,'逐关目标下限低于竞品');
  const previousCount=baseline.level[row.position-1]?.c.trim().split(/\s+/).length??row.previousTargetCount;
  assert.ok(Number.isInteger(previousCount)&&row.targetCount>=previousCount,'目标数量不能低于原关卡或原规划');
 }
}
const candidateWhitelist=read('level-editor/dist/data/candidate-words.json');
const whitelist=plan.targetSupplementation?new Set([...required,...guide].filter(word=>word.rarityLevel>=1&&word.rarityLevel<=4&&!word.abbreviation).map(word=>word.word)):new Set(candidateWhitelist.words.map(e=>e[0]));
const excluded=read('level-editor/data/source/excluded-words.json');assert.ok(excluded.words.every(w=>!dictionary.has(w)));
const openingFile='level-editor/dist/data/presets/our-levels-adaptive-pool-manual-opening-1000-2026-11-12.json';
const original=read(openingFile);let opening=original.level.slice(0,5);
let preservedGames=null,preservedThrough=5;
if(continuation){
 const previousDirectory=path.resolve(continuation);
 assert.notEqual(previousDirectory,destination,'续跑必须使用独立输出目录');
 const previousReport=JSON.parse(fs.readFileSync(path.join(previousDirectory,'report.json')));
 assert.ok(previousReport.passed&&previousReport.freshGeneration===freshGeneration,'只能从相同铺盘模式且完整通过校验的结果续跑');
 preservedGames=read(path.join(previousDirectory,'game.json')).level;
 preservedThrough=preservedGames.length;
 assert.equal(preservedThrough,previousReport.to);
 assert.ok(preservedThrough<to,'结束关号必须大于续跑起点');
 if(plan.continuation?.prefixFile){
  const approvedPrefix=read(plan.continuation.prefixFile);
  assert.equal(sources[plan.continuation.prefixFile],plan.continuation.prefixSha256,'已确认的续跑前序关卡发生变化');
  assert.deepEqual(preservedGames,approvedPrefix.level,'续跑必须保留配置指定的完整前序关卡');
  opening=preservedGames.slice(0,5);
 }else assert.deepEqual(preservedGames.slice(0,5),opening);
}
const frozenSelectedCount=preservedThrough-5;
const openingLevels=importGameLevels({level:opening,daily:[]},dictionaryRows);
const generator=createGenerator([...required,...guide],extra,{targetWordWhitelist:[...whitelist]});
const makeBounded=await createBoundedGenerator(),hooks={},bounded=makeBounded([...required,...guide],extra,{targetWordWhitelist:[...whitelist],trial:hooks});
let rngState=seed>>>0;const random=()=>((rngState=(Math.imul(rngState,1664525)+1013904223)>>>0)/4294967296);
const shuffle=a=>{a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,20);
const gridText=(letters,columns)=>Array.from({length:letters.length/columns},(_,r)=>letters.slice(r*columns,(r+1)*columns).map(c=>c||'-').join('')).join(',');
const mask=grid=>grid.replace(/[A-Z]/g,'1').replaceAll('-','0');
const historicalGames=[...original.level];
if(freshGeneration)for(const file of ['outputs/20261112-new-plan-through-50/game.json','outputs/20261112-reference-size-plan-through-50/game.json']){
 if(fs.existsSync(path.resolve(ROOT,file)))historicalGames.push(...read(file).level);
}
for(let index=0;index<args.length;index++)if(args[index]==='--exclude-game'){
 assert.ok(freshGeneration,'--exclude-game 仅适用于重新铺盘模式');
 assert.ok(args[index+1]&&!args[index+1].startsWith('--'),'缺少排除棋盘文件');
 const excludedGame=read(args[++index]);assert.ok(Array.isArray(excludedGame.level),'排除文件需为游戏关卡格式');
 historicalGames.push(...excludedGame.level);
}
const historicalFamilies=new Set(freshGeneration?historicalGames.map(g=>family(g.a)):[]);
const historicalLetterBags=new Set(freshGeneration?historicalGames.map(g=>letterMultiset(g.a)):[]);
const requestedMasks=new Set(rows.map(r=>r.boardMask.join(',')));
const minimumTargetsByMask=new Map([...requestedMasks].map(m=>[m,Math.min(...rows.filter(row=>row.boardMask.join(',')===m).map(row=>row.targetCount))]));
const inventory=new Map([...requestedMasks].map(m=>[m,[]])),indexed=new Set();
let inventoryBoards=0;
function addInventory(grid,recognized=null){
 const targetWords=recognized?.filter(w=>whitelist.has(w)&&dictionary.has(w)&&dictionary.get(w).rarityLevel>=1&&dictionary.get(w).rarityLevel<=4);
 const f=family(grid);if(indexed.has(f))return;
 const byMask=new Map();for(const oriented of orientations(grid)){const m=mask(oriented);if(!requestedMasks.has(m)||targetWords&&targetWords.length<minimumTargetsByMask.get(m))continue;if(!byMask.has(m))byMask.set(m,[]);byMask.get(m).push(oriented);}
 if(!byMask.size)return;
 indexed.add(f);
 const base={id:f,recognized,targetWords};
 for(const [m,variants] of byMask)inventory.get(m).push({...base,variants});inventoryBoards++;
}
const inventoryPath=option('--inventory','outputs/20261112-reference-length-through-50/library.json.gz');
if(!freshGeneration&&inventoryPath&&fs.existsSync(path.resolve(ROOT,inventoryPath))){
 const library=JSON.parse(gunzipSync(fs.readFileSync(path.resolve(ROOT,inventoryPath))));
 const currentFiles=['level-editor/dist/data/required-words.json','level-editor/dist/data/guide-words.json','level-editor/dist/data/extra-words.json'];
 const matching=currentFiles.every(file=>library.sourceHashes[file]===sources[file]);
 // Cached recognition is only a coarse index, and only under identical current dictionaries.
 for(const base of library.boards)addInventory(base.grid,matching?base.recognizedWords:null);
 console.log(JSON.stringify({inventory:inventoryBoards,cachedRecognitionCurrent:matching}));
}
if(!freshGeneration)for(const game of original.level)addInventory(game.a);
console.log(JSON.stringify({freshGeneration,historicalLayoutsExcluded:historicalFamilies.size,historicalLetterBagsExcluded:historicalLetterBags.size}));

const started=Date.now(),selected=[],events=[],cache=new Map(),contexts=new Map(),ban=new Map(),bannedBoards=new Map(),failedStages=new Map();
const stats={boardsScanned:0,fullSearches:0,selections:0,generationCalls:0,localMutations:0,backtracks:0,roundTripRejected:0};
const physicalScores=new Map();
function scoresForShape(row){
 const key=row.boardMask.join(',');if(physicalScores.has(key))return physicalScores.get(key);
 const enabled=row.boardMask.join('').split('').map(bit=>bit==='1'),columns=row.columns,scores=Object.fromEntries([3,4,5,6,7,8].map(length=>[length,new Set()]));
 const neighbors=enabled.map((_,cell)=>[cell-columns,cell+columns,...(cell%columns?[cell-1]:[]),...(cell%columns<columns-1?[cell+1]:[])].filter(next=>next>=0&&next<enabled.length&&enabled[next]));
 function visit(cell,used,path){const route=[...path,cell];used|=1<<cell;
  if(route.length>=3)scores[route.length].add(describePath(route,columns).difficultyScore);
  if(route.length<8)for(const next of neighbors[cell])if(!(used&(1<<next)))visit(next,used,route);
 }
 for(let cell=0;cell<enabled.length;cell++)if(enabled[cell])visit(cell,0,[]);
 physicalScores.set(key,scores);return scores;
}
function wordsForTemplate(row,template,blocked){
 const active=template.flatMap((count,index)=>count?[index+3]:[]),scores=scoresForShape(row),words=Object.fromEntries(active.map(length=>[length,[]]));
 const rarityAllowed=Object.fromEntries(active.map(length=>[length,new Set([1,2,3,4].filter(rarity=>[...scores[length]].some(pathScore=>{
  const score=pathScore+rarity*(1+length*.1);return score<=12&&row.scoreCounts[scoreBand(score)]>0;
 })))]));
 for(const word of whitelist){
  if(!words[word.length]||blocked.has(word)||!rarityAllowed[word.length].has(dictionary.get(word)?.rarityLevel))continue;
  // Any cooled contiguous subword remains recognizable along an anchor route.
  // Its length would invalidate the whole target-length group on that board.
  let conflict=false;
  for(const length of active)for(let start=0;start+length<=word.length;start++){const part=word.slice(start,start+length);if(blocked.has(part)||blocked.has([...part].reverse().join(''))){conflict=true;break;}}
  if(!conflict)words[word.length].push(word);
 }
 return words;
}
const FOUND_CACHE_LIMIT=500;
function rememberFound(grid,found){
 if(!cache.has(grid)&&cache.size>=FOUND_CACHE_LIMIT)cache.delete(cache.keys().next().value);
 cache.set(grid,found);
}
let stopped=false;process.once('SIGINT',()=>stopped=true);
function write(name,data){const tmp=path.join(destination,name+'.tmp');fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n');fs.renameSync(tmp,path.join(destination,name));}
if(args.includes('--resume')||continuation){
 const prior=JSON.parse(fs.readFileSync(path.join(args.includes('--resume')?destination:path.resolve(continuation),'progress.json')));
 if(args.includes('--resume'))assert.equal(prior.preservedThrough??5,preservedThrough,'恢复续跑时需保持相同的 --continue-from 参数');
 assert.equal(prior.freshGeneration??false,freshGeneration,'恢复时铺盘模式发生变化');
 assert.ok(prior.selected.length<=rows.length,'结束关号早于已完成范围');
 assert.ok(prior.planId===plan.id||(!args.includes('--resume')&&continuation&&prior.planId===plan.parentPlanId),'恢复或续跑规划版本不兼容');
 for(const [key,value] of Object.entries(prior.sources)){
  if(sources[key]===undefined)sources[key]=createHash('sha256').update(fs.readFileSync(path.resolve(ROOT,key))).digest('hex');
  assert.equal(sources[key],value,'恢复时数据源发生变化：'+key);
 }
 if(freshGeneration)for(const base of prior.freshInventory??[]){
  assert.ok(!historicalFamilies.has(family(base.grid))&&!historicalLetterBags.has(letterMultiset(base.grid)),'检查点含历史棋盘');
  addInventory(base.grid,base.recognizedWords??null);
 }
 for(const entry of prior.selected){
  const row=plan.records.find(r=>r.position===entry.position);
  const comparisonOptions={enforceComposition:entry.position>preservedThrough};
  entry.compared=compareLevelPlan(entry.level,row,comparisonOptions);assert.ok(entry.compared.passed);
  const imported=importGameLevels({level:[entry.game],daily:[]},dictionaryRows)[0];
  if(!compareLevelPlan(imported,row,comparisonOptions).passed){assert.ok(entry.position>preservedThrough,'续跑前序关卡回读校验失败');console.log(JSON.stringify({rewoundTo:entry.position,reason:'checkpoint round-trip score mismatch'}));break;}
  const originalBudget=plan.stageBudgets?.find(budget=>entry.position>=budget.from&&entry.position<=budget.to),budget=originalBudget?resolveStageBudget(plan,originalBudget,selected):null;
  if(budget&&entry.position>preservedThrough){
   const context=createStageContext(budget,row,selected.filter(previous=>previous.position>=budget.from).map(previous=>previous.level),plan.records.filter(future=>future.position>entry.position&&future.position<=budget.to));
   if(!checkStageCandidate(measureComposition(imported),context)){console.log(JSON.stringify({rewoundTo:entry.position,reason:'stage budget lookahead mismatch'}));break;}
  }
  selected.push(entry);
 }
 assert.ok(selected.length>=frozenSelectedCount,'续跑检查点缺少已定稿关卡');
 if(preservedGames)assert.deepEqual([...opening,...selected.slice(0,frozenSelectedCount).map(e=>e.game)],preservedGames);
 Object.assign(stats,prior.stats);rngState=prior.rngState;
 console.log(JSON.stringify({resumed:selected.length,through:selected.at(-1)?.position,preservedThrough}));
}
function blockedFor(position){
 const previous=[...openingLevels.map((level,i)=>({position:i+1,level})),...selected];
 return new Set(previous.filter(e=>e.position<position&&position-e.position<=50).flatMap(e=>[...e.level.targetWords,...e.level.extraWords].map(w=>w.word)));
}
function usedFamilies(){return new Set([...historicalFamilies,...opening.map(g=>family(g.a)),...selected.map(e=>family(e.game.a))]);}
function foundFor(grid){
 if(cache.has(grid))return cache.get(grid);
 const lines=grid.split(','),letters=[...grid.replaceAll(',','')].map(c=>c==='-'?'':c),disabledCells=letters.flatMap((c,i)=>c?[]:[i]);
 const found=generator.findWords({rows:lines.length,columns:lines[0].length,letters,disabledCells,minimumWordLength:3});
 rememberFound(grid,found);stats.fullSearches++;return found;
}
function coarse(base,row,blocked,templates=null){
 if(!base.recognized)return 0;
 const forbidden=new Set(base.recognized.filter(w=>blocked.has(w)).map(w=>w.length));
 const eligible=base.targetWords.filter(w=>!blocked.has(w)&&!forbidden.has(w.length)&&(!row.targetComposition?.noThreeLetter||w.length!==3));
 if(eligible.length<row.targetCount)return Infinity;
 if(row.targetComposition&&!row.targetComposition.noThreeLetter&&!eligible.some(word=>word.length===3))return Infinity;
 if(templates){
  const lengths={};for(const word of eligible)lengths[word.length]=(lengths[word.length]??0)+1;
  if(!templates.some(vector=>vector.every((count,index)=>count<=(lengths[index+3]??0))))return Infinity;
 }
 const potential=[0,0,0,0];
 for(const w of eligible){const rarity=dictionary.get(w).rarityLevel,min=rarity*(1+w.length*.1),max=min+2*(w.length-2)+1;
  for(let b=0;b<4;b++)if(min<(b+1)*3&&max>=b*3)potential[b]++;
 }
 if(potential.some((n,i)=>n<row.scoreCounts[i]))return Infinity;
 return Math.abs(eligible.length-row.targetCount)*.2+Math.max(0,base.recognized.length-row.targetCount)*.06+random()*.5;
}
function evaluateGrid(grid,row,context,deadline,nodeLimit=30000){
 if(context.used.has(family(grid))||bannedBoards.get(context.key)?.has(family(grid))||historicalLetterBags.has(letterMultiset(grid)))return null;
 const letters=[...grid.replaceAll(',','')].map(c=>c==='-'?'':c),found=foundFor(grid);
 stats.boardsScanned++;
 const selectionRow=context.allowedTemplates?{...row,targetComposition:{...row.targetComposition,allowedTemplates:context.allowedTemplates}}:row;
 const candidate=selectPlannedTargets({row:selectionRow,letters,found,whitelist,blocked:context.blocked,random,nodeLimit,compositionHistory:context.compositionHistory,
  normalizeCandidate:context.stageBudget?level=>{
   const imported=importGameLevels(createGameExport([{level}]),dictionaryRows)[0];
   if(!compareLevelPlan(imported,row).passed){stats.roundTripRejected++;return null;}
   return {...level,...imported};
  }:undefined,
  onComposition:composition=>checkStageCandidate(composition,context.stageBudget)&&(!context.tailRows||tailSolver({budget:context.stageBudget.budget,
   used:appendCompositionMetrics(context.stageBudget.used,composition,context.stageBudget.budget),rows:context.tailRows,fivePresence:{...context.fivePresence,[row.position]:(composition.lengthCounts[5]??0)>0}}).feasible),additionalCost:composition=>stageCandidateCost(composition,context.stageBudget),
  withinBudget:()=>Date.now()<deadline&&!stopped,onCandidate:level=>{
   const game=createGameExport([{level}]).level[0];
   if(ban.get(context.key)?.has(hash(game)))return false;
   const imported=importGameLevels({level:[game],daily:[]},dictionaryRows)[0];
   const matches=compareLevelPlan(imported,row).passed&&checkStageCandidate(measureComposition(imported),context.stageBudget);if(!matches)stats.roundTripRejected++;return matches;
  }});
 if(!candidate)return null;
 const imported=importGameLevels(createGameExport([{level:candidate}]),dictionaryRows)[0];
 const level={...candidate,cells:imported.cells,targetWords:imported.targetWords,extraWords:imported.extraWords,statistics:imported.statistics};
 const compared=compareLevelPlan(level,row);assert.ok(compared.passed);
 const game=createGameExport([{level}]).level[0],id=hash(game);
 if(ban.get(context.key)?.has(id))return null;
 const vector=compared.actual.words.reduce((s,w,i)=>s+Math.abs(w.score-row.referenceWordScores[i]),0);
 const preference=row.targetComposition?compositionCost(measureComposition(level),row.targetComposition,context.compositionHistory):0;
 return {position:row.position,id,context:context.key,level,game,compared,cost:vector+level.extraWords.length*1.25+preference+stageCandidateCost(measureComposition(level),context.stageBudget)};
}
function contextFor(row){
 const profile=row.targetComposition;
 const history=profile?compositionHistory([...openingLevels.map((level,i)=>({position:i+1,level})),...selected]
  .filter(entry=>entry.position>=profile.stageFrom&&entry.position<=profile.stageTo).map(entry=>entry.level),profile):{};
 const originalBudget=plan.stageBudgets?.find(budget=>row.position>=budget.from&&row.position<=budget.to),budget=originalBudget?resolveStageBudget(plan,originalBudget,selected):null;
 const stageBudget=budget?createStageContext(budget,row,selected.filter(entry=>entry.position>=budget.from&&entry.position<row.position).map(entry=>entry.level),
  plan.records.filter(future=>future.position>row.position&&future.position<=budget.to)):null;
 const blocked=blockedFor(row.position),used=usedFamilies(),key=hash([row.position,[...blocked].sort(),[...used].sort(),history,stageBudget?.used]);
 if(contexts.has(key))return contexts.get(key);
 const tailRows=tailSolver&&stageBudget&&budget.to-row.position<=6?plan.records.filter(future=>future.position>row.position&&future.position<=budget.to):null;
 const fivePresence=budget?Object.fromEntries(selected.filter(entry=>budget.from<=entry.position&&entry.position<row.position).map(entry=>[entry.position,entry.level.targetWords.some(word=>word.word.length===5)])):{};
 const tail=tailRows?tailSolver({budget,used:stageBudget.used,rows:[row,...tailRows],fivePresence}):null;
 let allowedTemplates=profile?.allowedTemplates?.filter(vector=>checkStageCandidate({lengthCounts:Object.fromEntries(vector.map((count,index)=>[index+3,count]))},stageBudget,{countsOnly:true}));
 if(tail&&!tail.feasible)allowedTemplates=[];
 const templateWords=new Map(),signatureWords=new Map();
 if(allowedTemplates)allowedTemplates=allowedTemplates.filter(template=>{
  const signature=template.map((count,index)=>count?index+3:0).filter(Boolean).join(',');
  if(!signatureWords.has(signature))signatureWords.set(signature,wordsForTemplate(row,template,blocked));
  const words=signatureWords.get(signature);templateWords.set(template.join(','),words);
  return template.every((count,index)=>count<=(words[index+3]?.length??0));
 });
 const bases=inventory.get(row.boardMask.join(','))??[];
 const ranked=[];if(!allowedTemplates||allowedTemplates.length)for(const base of bases){if(used.has(base.id))continue;const score=coarse(base,row,blocked,allowedTemplates);if(Number.isFinite(score))ranked.push({base,score});}
 ranked.sort((a,b)=>a.score-b.score);
 if(stageBudget&&ranked.length>400)ranked.length=400;
 const templateOrder=shuffle(allowedTemplates??[]),suggested=tail?.templates.find(entry=>entry.position===row.position)?.vector;
 if(suggested)templateOrder.sort((a,b)=>a.reduce((sum,n,i)=>sum+Math.abs(n-suggested[i]),0)-b.reduce((sum,n,i)=>sum+Math.abs(n-suggested[i]),0));
 const context={key,blocked,used,compositionHistory:history,stageBudget,tailRows,fivePresence,allowedTemplates,templateOrder,templateCursor:0,
  templateWords,ranked,cursor:0,variants:[],choices:[],freshBatches:0,bestSeeds:[]};contexts.set(key,context);return context;
}
function inventorySlice(row,context,milliseconds=1600){
 const deadline=Date.now()+milliseconds;
 while(Date.now()<deadline&&!stopped&&context.choices.length<8){
  if(!context.variants.length){if(context.cursor>=context.ranked.length)break;context.variants=shuffle(context.ranked[context.cursor++].base.variants);}
  const grid=context.variants.pop(),choice=evaluateGrid(grid,row,context,Math.min(deadline,Date.now()+25));
  if(choice)context.choices.push(choice);
 }
 context.choices.sort((a,b)=>a.cost-b.cost);
}
function generationSlice(row,context,milliseconds=1600){
 if(context.allowedTemplates&&!context.allowedTemplates.length){context.freshBatches=8;return;}
 const deadline=Date.now()+milliseconds,disabledCells=row.boardMask.join('').split('').flatMap((v,i)=>v==='0'?[i]:[]);
 let calls=0;
 while(Date.now()<deadline&&!stopped&&context.choices.length<5){
  const anchorCap=[4,5,6,8][(context.freshBatches+calls)%4],localDeadline=Math.min(deadline,Date.now()+180);calls++;stats.generationCalls++;
  // Keep the cursor across time slices so later templates are actually tried.
  const template=context.templateOrder.length?context.templateOrder[context.templateCursor++%context.templateOrder.length]:null;
  const anchorLength=template?Math.max(...template.flatMap((count,index)=>count?[index+3]:[]),0):0;
  const anchorWords=anchorLength?(context.templateWords.get(template.join(','))?.[anchorLength]??[]):[];
  const occupiedBands=row.scoreCounts.flatMap((count,band)=>count?[band]:[]),anchorBand=occupiedBands[(context.templateCursor-1)%occupiedBands.length];
  const bandWords=anchorLength?anchorWords.filter(word=>[...scoresForShape(row)[anchorLength]].some(pathScore=>{
   const score=pathScore+dictionary.get(word).rarityLevel*(1+anchorLength*.1);return score<=12&&scoreBand(score)===anchorBand;
  })):[];
  const anchorPool=(bandWords.length?bandWords:anchorWords)
   .flatMap(word=>Array(dictionary.get(word).rarityLevel===1?4:dictionary.get(word).rarityLevel===2?2:1).fill(word));
  const anchor=anchorPool.length?anchorPool[Math.floor(random()*anchorPool.length)]:null;
  const stageForward=context.stageBudget?Math.round(100*Math.max(0,Math.min(1,(context.stageBudget.budget.targets.positive-(context.stageBudget.used.positive??0))/
   (context.stageBudget.budget.targetTotal-context.stageBudget.previousWords)))):null;
  hooks.withinBudget=()=>Date.now()<localDeadline&&!stopped;
  hooks.observeBoard=()=>hooks.withinBudget();
  hooks.selectTargets=(filled,found)=>{
   const grid=gridText(filled.letters,row.columns);
   if(context.used.has(family(grid))||bannedBoards.get(context.key)?.has(family(grid))||historicalLetterBags.has(letterMultiset(grid)))return null;
   rememberFound(grid,found);addInventory(grid,found.map(e=>e.word));
   const choice=evaluateGrid(grid,row,context,localDeadline);
   if(choice)context.choices.push(choice);return choice?.level??null;
  };
  try{bounded.generate({rows:row.rows,columns:row.columns,disabledCells,minimumWordLength:3,
   desiredTargetCount:row.targetCount,filters:{rarityLevel:[1,2,3,4]},fixedWords:anchor?[anchor]:[],fixedLayout:null,
   initialRarityLevel:anchor?null:calls%3===0?null:1,initialForwardProbability:stageForward??[95,80,60,45][calls%4],
   reservedTargetWords:[...whitelist].filter(w=>template?!template[w.length-3]:w.length>anchorCap||row.targetComposition?.noThreeLetter&&w.length===3),
   duplicateCheck:{target:{range:50,words:[...context.blocked],levelIds:[]},extra:{range:0,words:[],levelIds:[]}},random});}
  catch(error){if(error.code!=='GENERATION_RETRY'&&!error.message.includes('没有可安全完成的摆法'))throw error;}
 }
 context.freshBatches++;context.choices.sort((a,b)=>a.cost-b.cost);
}
function cleanLevel(level){return {...level,foundWords:undefined,candidateWords:level.targetWords,initialWords:[],
 targetWords:level.targetWords.map(e=>({...e})),extraWords:level.extraWords.map(e=>({...e}))};}
function checkpoint(){write('progress.json',{schemaVersion:1,planId:plan.id,from:6,to,seed,rngState,sources,freshGeneration,preservedThrough,
 selected:selected.map(e=>({...e,level:cleanLevel(e.level)})),stats,events,
 ...(freshGeneration?{freshInventory:[...new Map([...inventory.values()].flat().filter(base=>!historicalFamilies.has(base.id)&&!historicalLetterBags.has(letterMultiset(base.id)))
  .map(base=>[base.id,{grid:base.id,recognizedWords:base.recognized}])).values()]}:{})});}
while(selected.length<rows.length&&!stopped){
 const row=rows[selected.length],context=contextFor(row);
 if(!context.choices.length&&(context.cursor<context.ranked.length||context.variants.length))inventorySlice(row,context);
 else if(!context.choices.length)generationSlice(row,context);
 context.choices=context.choices.filter(choice=>!bannedBoards.get(context.key)?.has(family(choice.game.a)));
 if(context.choices.length){
  const choice=context.choices.shift();selected.push(choice);stats.selections++;
  events.push({kind:'accepted',position:row.position,extras:choice.level.extraWords.length,cost:choice.cost});
  checkpoint();console.log(JSON.stringify({position:row.position,completed:selected.length,planned:row.scoreCounts,actual:choice.compared.actual.counts,
   total:choice.compared.actual.total,range:[row.scoreMinimum,row.scoreMaximum],targets:choice.level.targetWords.map(e=>e.word),extras:choice.level.extraWords.length,
   elapsedSeconds:Math.round((Date.now()-started)/1000)}));
 }else{
  console.log(JSON.stringify({searching:row.position,inventoryCursor:context.cursor,inventoryCandidates:context.ranked.length,
   freshBatches:context.freshBatches,stats,elapsedSeconds:Math.round((Date.now()-started)/1000)}));
  if(context.cursor>=context.ranked.length&&!context.variants.length&&context.freshBatches>=8&&selected.length>frozenSelectedCount){
   const failures=(failedStages.get(row.position)??0)+1;failedStages.set(row.position,failures);
   const depth=context.stageBudget?Math.min(4,1+Math.floor(failures/3)):1;
   let removed;
   for(let step=0;step<depth&&selected.length>frozenSelectedCount;step++){
    removed=selected.pop();if(!ban.has(removed.context))ban.set(removed.context,new Set());ban.get(removed.context).add(removed.id);
    if(!bannedBoards.has(removed.context))bannedBoards.set(removed.context,new Set());bannedBoards.get(removed.context).add(family(removed.game.a));
    stats.backtracks++;events.push({kind:'backtrack',from:row.position,to:removed.position});
   }
   checkpoint();console.log(JSON.stringify({backtrack:removed.position,depth,reason:'no matching score/cooling/coverage/budget selection'}));
  }
 }
 await new Promise(resolve=>setImmediate(resolve));
}
checkpoint();
const combined={level:[...opening,...selected.map(e=>e.game)],daily:[]};
assert.deepEqual(combined.level.slice(0,5),opening);
if(preservedGames)assert.deepEqual(combined.level.slice(0,preservedThrough),preservedGames);
const allLevels=[...openingLevels,...selected.map(e=>e.level)];
const roundTripLevels=importGameLevels(combined,dictionaryRows);
const violations=[];
for(const entry of selected){
 const row=rows.find(r=>r.position===entry.position),comparisonOptions={enforceComposition:entry.position>preservedThrough},comparison=compareLevelPlan(entry.level,row,comparisonOptions);
 entry.compared=comparison;
 if(freshGeneration&&entry.position>preservedThrough&&(historicalFamilies.has(family(entry.game.a))||historicalLetterBags.has(letterMultiset(entry.game.a))))violations.push({position:entry.position,kind:'historicalLayoutReuse'});
 if(!comparison.passed)violations.push({position:entry.position,kind:'plan',details:comparison.violations});
 if(plan.targetSupplementation&&comparison.actual.maximum>12)violations.push({position:entry.position,kind:'targetScoreCap',maximum:comparison.actual.maximum});
 const imported=roundTripLevels[entry.position-1],roundTripComparison=compareLevelPlan(imported,row,comparisonOptions);
 if(!roundTripComparison.passed)violations.push({position:entry.position,kind:'roundTripPlan',details:roundTripComparison.violations});
 if(!analyzeTargetPaths(imported).allChoicesComplete)violations.push({position:entry.position,kind:'roundTripSafety'});
 const safety=analyzeTargetPaths(entry.level);if(!safety.allChoicesComplete)violations.push({position:entry.position,kind:'pathSafety'});
 const fresh=generator.findWords({rows:entry.level.rows,columns:entry.level.columns,letters:entry.level.cells.map(c=>c.letter),disabledCells:entry.level.disabledCells,minimumWordLength:3});
 const targets=new Set(entry.level.targetWords.map(e=>e.word)),lengths=new Set([...targets].map(w=>w.length));
 const expected=fresh.filter(e=>!targets.has(e.word)&&lengths.has(e.word.length)).map(e=>e.word).sort();
 assert.deepEqual(entry.level.extraWords.map(e=>e.word).sort(),expected);
 const previous=new Set(allLevels.slice(Math.max(0,entry.position-51),entry.position-1).flatMap(l=>[...l.targetWords,...l.extraWords].map(e=>e.word)));
 const duplicates=[...entry.level.targetWords,...entry.level.extraWords].filter(e=>previous.has(e.word)).map(e=>e.word);
 if(duplicates.length)violations.push({position:entry.position,kind:'cooldown',words:duplicates});
}
const report={planId:plan.id,planFile:path.relative(ROOT,path.resolve(ROOT,planFile)),targetCompositionPolicy:plan.targetCompositionPolicy??null,wordDirectionPolicy:plan.wordDirectionPolicy??null,targetSupplementation:plan.targetSupplementation??null,
 minimumTargetsChecked:Boolean(plan.targetSupplementation),
 stageTailSolver:tailSolver?{...tailSolver.stats,lookahead:7}:null,
 from:6,to,completed:selected.length,requested:rows.length,passed:selected.length===rows.length&&!violations.length,
 firstFivePreserved:true,roundTripChecked:true,competitorLayoutChecked:true,freshGeneration,historicalLayoutReuse:violations.filter(v=>v.kind==='historicalLayoutReuse').length,
 historicalLayoutsExcluded:historicalFamilies.size,historicalLetterBagsExcluded:historicalLetterBags.size,actualLevelsGenerated:selected.length-frozenSelectedCount,preservedThrough,preservedPrefix:true,sources,stats,violations,
 elapsedSeconds:Math.round((Date.now()-started)/1000),levels:selected.map(e=>({position:e.position,...e.compared,extras:e.level.extraWords.length}))};
if(plan.stageBudgets){
 report.stageBudgets=plan.stageBudgets.filter(budget=>budget.to<=to).map(budget=>checkStageComplete(resolveStageBudget(plan,budget,selected),selected.filter(entry=>entry.position>=budget.from&&entry.position<=budget.to).map(entry=>entry.level)));
 for(const budget of report.stageBudgets)if(!budget.passed)violations.push({kind:'stageBudget',id:budget.id,details:budget.violations});
 report.passed=selected.length===rows.length&&!violations.length;
}
write('report.json',report);write('game.json',combined);write('new-game.json',{level:selected.slice(frozenSelectedCount).map(e=>e.game),daily:[]});
write('editor.json',{schemaVersion:1,label:plan.wordDirectionPolicy?`新规划试跑 · 前${to}关 · 2026-11-13（${plan.targetSupplementation?'目标补齐':'路径加权'}）`:`新规划试跑 · 前${to}关 · 2026-11-12`,records:allLevels.map((level,i)=>({id:i+1,level:cleanLevel(level)}))});
console.log('FINAL',JSON.stringify({passed:report.passed,completed:selected.length,to,violations}));
if(!report.passed)process.exitCode=stopped?130:1;
