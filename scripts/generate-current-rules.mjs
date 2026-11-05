import fs from 'node:fs';
import path from 'node:path';
import {createGenerator,generateUntilComplete} from '../dist/level-generator.js';
import {createBatchRunner} from '../dist/batch-runner.js';
import {validateCurrentRuleConfigs} from '../dist/generation-policy.js';
import {analyzeTargetPaths} from '../dist/target-path-analysis.js';
import {createGameExport} from '../dist/level-export.js';
import {importGameLevels,importSingleGameLevel} from '../dist/level-import.js';

const args=process.argv.slice(2);
if(args.includes('--help')){console.log('node scripts/generate-current-rules.mjs --from 1 --to 20 --seed 20261104 --out OUTPUT_DIRECTORY [--history HISTORY_JSON]');process.exit(0);}
const option=(name,fallback)=>{const i=args.indexOf(name);if(i<0)return fallback;if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('Missing value: '+name);return args[i+1];};
const from=Number(option('--from','1')),to=Number(option('--to','20')),seed=Number(option('--seed','20261104'));
if(!Number.isInteger(from)||!Number.isInteger(to)||from<1||to>2000||to<from)throw new Error('范围必须为1～2000。');
if(!Number.isSafeInteger(seed))throw new Error('seed必须为整数。');
const destination=path.resolve(option('--out','outputs/current-rule-generation'));
const read=url=>JSON.parse(fs.readFileSync(url,'utf8'));
const data=new URL('../dist/data/',import.meta.url);
const preset=read(new URL('../dist/data/current-rule-configs.json',import.meta.url));
validateCurrentRuleConfigs(preset.records,{complete:true});
const ordinary=[...read(new URL('required-words.json',data)),...read(new URL('guide-words.json',data))];
const extra=read(new URL('extra-words.json',data)),dictionary=[...ordinary,...extra.map(r=>({...r,onlyExtra:true}))];
const whitelist=read(new URL('candidate-words.json',data)).words.map(([word])=>word);
const generator=createGenerator(ordinary,extra,{targetWordWhitelist:whitelist});
let randomState=seed>>>0;
const random=()=>((randomState=(Math.imul(randomState,1664525)+1013904223)>>>0)/4294967296);
const historyFile=option('--history',null);
let history=[];
if(historyFile){
 const input=read(path.resolve(historyFile)),values=Array.isArray(input)?input:input.records;
 if(values)history=values.map((record,index)=>{
   if(record.level)return record;
   const position=record.position??index+1,counts=Array(record.grid.join('').length).fill(0);
   for(const [,route]of record.paths)for(const cell of route)counts[cell]++;
   const level=importSingleGameLevel(JSON.stringify({g:record.grid.join(','),t:record.paths.map(([w])=>w).join(' '),n:counts.map(n=>n.toString(36)).join(''),e:(record.extraPaths??[]).map(([w])=>w).join(' ')}),dictionary);
   return {id:position,level:{...level,sourceConfig:{position}}};
 });
 else if(input.books){
   const raw=[...input.books.flatMap(b=>b.levels),...input.daily];
   history=importGameLevels(input,dictionary).map((level,index)=>({id:Number(raw[index].id)||index+1,level:{...level,sourceConfig:{position:Number(raw[index].id)||index+1}}}));
 }else throw new Error('历史文件需为draft数组、编辑器records或游戏books/daily格式。');
}
const saved=[],started=Date.now();
fs.mkdirSync(destination,{recursive:true});
const write=(name,value)=>fs.writeFileSync(path.join(destination,name),JSON.stringify(value,null,2)+'\n');
const drafts=()=>saved.map(({level})=>({position:level.generationRules.position,name:level.name??'',
 grid:Array.from({length:level.rows},(_,r)=>level.cells.slice(r*level.columns,(r+1)*level.columns).map(c=>c.letter||'-').join('')),
 paths:level.targetWords.map(e=>[e.word,e.path]),extraPaths:level.extraWords.map(e=>[e.word,e.path]),
 notes:['固定造型程序生成；seed '+seed],generationQuality:level.generationQuality}));
const runner=createBatchRunner({getHistory:async()=>history,generate:async(config,duplicateCheck,{signal,onProgress})=>{
 await new Promise(resolve=>setTimeout(resolve,0));
 if(signal.aborted)return null;
 let attempts=0;
 const level=await generateUntilComplete(generator,{...config,duplicateCheck,random},{isCurrent:()=>!signal.aborted&&attempts<1600,
   onProgress:progress=>{attempts=progress.attempts;onProgress(progress);}});
 if(!level&&!signal.aborted)throw new Error('达到本关搜索上限，已保留固定造型；请调整选词或重试。');
 if(level&&!analyzeTargetPaths(level).allChoicesComplete)throw new Error('通关安全验证失败。');
 return level;
},save:async(level,position)=>{const record={id:position,position,level};saved.push(record);return record;},
onSaved:(_,job)=>{if(saved.length%20===0)write('drafts.json',drafts());console.log(JSON.stringify({saved:saved.length,position:job.position}));}});
process.once('SIGINT',()=>runner.stop());
const result=await runner.run(preset.records.slice(from-1,to),preset.records);
write('drafts.json',drafts());
write('editor.json',{schemaVersion:1,label:preset.label,records:saved});
if(saved.length){const game=createGameExport(saved);game.books[0].name=preset.label;game.books[0].levels.forEach((l,i)=>{l.id=String(saved[i].position);});write('game.json',game);}
const quality=saved.map(({level})=>({position:level.generationRules.position,...level.generationQuality}));
const knownPositions=new Set([...history.map((r,i)=>r.level.generationRules?.position??r.level.sourceConfig?.position??i+1),...saved.map(r=>r.position)]);
const partialHistory=saved.filter(r=>Array.from({length:Math.min(10,r.position-1)},(_,i)=>r.position-i-1).some(p=>!knownPositions.has(p))).map(r=>r.position);
const report={...result,seed,elapsedMilliseconds:Date.now()-started,allChoicesComplete:saved.length?true:null,
 historyComplete:partialHistory.length===0,partialHistoryPositions:partialHistory,quality,
 summary:{saved:saved.length,targets:saved.reduce((n,r)=>n+r.level.targetWords.length,0),extras:saved.reduce((n,r)=>n+r.level.extraWords.length,0),
   levelsWithTopRowTargets:quality.filter(q=>q.topRowHorizontalCount>0).length,
   exactTargetCounts:quality.filter(q=>q.targetCountDifference===0).length,
   meanTurns:quality.length?quality.reduce((n,q)=>n+q.averageTurns,0)/quality.length:0}};
write('report.json',report);console.log(JSON.stringify({...report,quality:undefined}));
if(result.phase!=='complete')process.exitCode=1;
