import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createPresetRecords} from '../dist/preset-level-lists.js';
import {importGameLevels} from '../dist/level-import.js';
import {measureComposition} from './lib/target-composition.mjs';
import {weightedOptions,directionPairs} from './lib/direction-policy.mjs';
import {validateLevelPlan,measuredScores,scoreBand} from './lib/level-plan.mjs';
import {targetCountFloor,additionalScoreProfiles} from './lib/target-promotion.mjs';

const root=new URL('../../',import.meta.url),sources={};
const read=file=>{const bytes=fs.readFileSync(new URL(file,root));sources[file]=createHash('sha256').update(bytes).digest('hex');return JSON.parse(bytes);};
const base=read('level-editor/dist/data/level-plan-weighted-first-50.json');
const dictionary=['required-words','guide-words','extra-words'].flatMap(name=>read('level-editor/dist/data/'+name+'.json'));
const baselineFile='outputs/20261113-weighted-first-50/game.json',baseline=importGameLevels(read(baselineFile),dictionary);
const reference=createPresetRecords(read('level-editor/dist/data/presets/word-tiles-list0.json').slice(0,50),'word-tiles',dictionary).map(record=>record.level);
const vector=level=>[3,4,5,6,7,8].map(length=>level.targetWords.filter(word=>word.word.length===length).length);
const apportion=(counts,total)=>{const raw=counts.map(n=>n*total/counts.reduce((a,b)=>a+b,0)),result=raw.map(Math.floor);for(const i of counts.map((_,i)=>i).sort((a,b)=>(raw[b]-result[b])-(raw[a]-result[a])||a-b).slice(0,total-result.reduce((a,b)=>a+b,0)))result[i]++;return result;};
const plan=structuredClone(base);plan.id='our-level-plan-target-floor-first-50-20261113';plan.parentPlanId=base.id;
plan.targetSupplementation={id:'reference-target-floor-extra-promotion-20261113',baselineFile,preservedOpening:[1,5],
 countRule:'each-level-at-least-reference-and-current-target-count',targetVocabulary:'current-required-and-guide-words-rarity-1-to-4-no-abbreviations',
 scoreRule:'retain-existing-band-slots-and-allow-added-slots; total-score-range-scales-with-target-count',selectionPriority:'preserve-boards-then-stage-center'};
for(const row of plan.records){
 const actual=measuredScores(baseline[row.position-1]),oldN=actual.targetCount,N=targetCountFloor(oldN,reference[row.position-1].targetWords.length),extra=N-oldN;
 row.minimumTargetCount=reference[row.position-1].targetWords.length;row.previousTargetCount=oldN;row.targetCount=N;
 row.scoreProfiles=additionalScoreProfiles(actual.counts,extra);row.scoreCounts=apportion(actual.counts,N);
 row.scoreProfiles.sort((a,b)=>a.reduce((sum,n,i)=>sum+Math.abs(n-row.scoreCounts[i]),0)-b.reduce((sum,n,i)=>sum+Math.abs(n-row.scoreCounts[i]),0));
 const samples=[0,1,2,3].map(band=>row.referenceWordScores.filter(score=>scoreBand(score)===band));
 row.referenceWordScores=row.scoreCounts.flatMap((count,band)=>Array.from({length:count},(_,i)=>samples[band][i%samples[band].length]??[2,4.5,7.5,10.5][band])).sort((a,b)=>a-b);
 row.referenceScore=Number(row.referenceWordScores.reduce((a,b)=>a+b,0).toFixed(2));row.maximumWordReference=Math.max(...row.referenceWordScores);
 row.scoreMinimum=Number(Math.min(row.scoreMinimum*N/oldN,row.referenceScore).toFixed(2));row.scoreMaximum=Number(Math.max(row.scoreMaximum*N/oldN,row.referenceScore).toFixed(2));
 const preferred=apportion(vector(reference[row.position-1]),N),cfg=row.targetComposition;
 if(cfg.noThreeLetter&&preferred[0]){preferred[1]+=preferred[0];preferred[0]=0;}
 if(!cfg.noThreeLetter&&!preferred[0]){const donor=preferred.indexOf(Math.max(...preferred));preferred[donor]--;preferred[0]++;}
 cfg.preferredLengths=preferred.flatMap((count,i)=>Array(count).fill(i+3));cfg.preferredCounts=[...preferred.slice(0,3),preferred.slice(3).reduce((a,b)=>a+b,0)];
 cfg.preferredDistinctLengths=preferred.filter(Boolean).length;cfg.minimumDistinctLengths=2;cfg.preferredCountRanges=cfg.preferredCounts.map(()=>[0,N]);
}
for(const budget of plan.stageBudgets){
 const previousId=budget.id;budget.id='target-floor-'+previousId;budget.preserveBoards=true;
 const rows=plan.records.filter(row=>budget.from<=row.position&&row.position<=budget.to),peers=reference.slice(budget.from-1,budget.to),total=rows.reduce((sum,row)=>sum+row.targetCount,0);
 const counts=apportion([3,4,5,6,7,8].map(length=>peers.flatMap(level=>level.targetWords).filter(word=>word.word.length===length).length),total);
 budget.targetTotal=total;budget.targets={};budget.ranges={};
 const set=(key,target,low,high)=>{budget.targets[key]=target;budget.ranges[key]=[low,high];};
 for(let i=0;i<6;i++)set('length:'+(i+3),counts[i],counts[i]?Math.max(0,counts[i]-1):0,counts[i]?counts[i]+1:0);
 const tolerance=Math.max(1,Math.ceil(rows.length*.1));
 for(const label of ['3','4','5','6+'])for(let count=0;count<=(label==='6+'?2:label==='5'?4:Math.max(...rows.map(row=>row.targetCount)));count++){
  const target=peers.filter(level=>level.targetWords.filter(word=>label==='6+'?word.word.length>5:word.word.length===Number(label)).length===count).length;
  const spread=label==='6+'?1:tolerance;set(`hist:${label}:${count}`,target,Math.max(0,target-spread),Math.min(rows.length,target+spread));
 }
 for(let n=1;n<=6;n++){const target=peers.filter(level=>new Set(level.targetWords.map(word=>word.word.length)).size===n).length;set('variety:'+n,target,n===1||n===6?0:Math.max(0,target-1),n===1||n===6?0:Math.min(rows.length,target+1));}
 if(budget.from===31){
  set('hist:5:0',2,1,2);set('hist:5:4',0,0,0);set('variety:5',1,1,1);
  budget.fiveCoverage={targetLevels:18,allowedLevels:[18,19],perFiveLevelsMinimum:4,maxConsecutiveZeroLevels:1};
 }
 let P=0,Z=0;const bounds={positive:[0,0],neutral:[0,0]};
 for(const length of [3,4,5,6,7,8]){
  const pairs=directionPairs(budget,length),preferred=weightedOptions(budget.targets['length:'+length],budget.directionSharesByLength[length],budget.directionPolicy).preferred;
  for(const name of ['positive','neutral']){const low=Math.min(...pairs.map(pair=>pair[name])),high=Math.max(...pairs.map(pair=>pair[name]));set(name+':'+length,preferred[name],low,high);bounds[name][0]+=low;bounds[name][1]+=high;}
  P+=preferred.positive;Z+=preferred.neutral;
 }
 set('positive',P,...bounds.positive);set('neutral',Z,...bounds.neutral);
 for(const row of rows){
  const cfg=row.targetComposition,N=row.targetCount;cfg.stageBudgetId=budget.id;const templates=[];
  for(let six=0;six<=2;six++)for(let seven=0;seven<=2;seven++)for(let eight=0;eight<=2;eight++){
   const longs=[six,seven,eight],long=six+seven+eight;if(long>2||long===2&&(row.activeCells<12||cfg.noThreeLetter)||longs.some((n,i)=>n&&!counts[i+3]))continue;
   for(let three=cfg.noThreeLetter?0:1;three<=N-long;three++){
    if(cfg.noThreeLetter&&three>0)break;
    for(let five=0;five<=Math.min(3,N-long-three);five++){
     const four=N-long-three-five,v=[three,four,five,...longs],variety=v.filter(Boolean).length;
     if(variety>=2&&variety<=5)templates.push(v);
    }
   }
  }
  cfg.allowedTemplates=templates;
 }
}
plan.targetFloorSources=sources;validateLevelPlan(plan);
fs.writeFileSync(new URL('level-editor/dist/data/level-plan-target-floor-first-50.json',root),JSON.stringify(plan,null,2)+'\n');
console.log(JSON.stringify({id:plan.id,added:plan.records.reduce((sum,row)=>sum+row.targetCount-row.previousTargetCount,0),stageTotals:plan.stageBudgets.map(b=>({from:b.from,to:b.to,total:b.targetTotal,lengthTargets:Object.fromEntries([3,4,5,6,7,8].map(n=>[n,b.targets['length:'+n]]))}))}));
