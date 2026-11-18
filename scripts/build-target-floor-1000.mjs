import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPresetRecords} from '../dist/preset-level-lists.js';
import {measureWordDirections} from '../dist/word-direction.js';
import {weightedOptions,directionPairs} from './lib/direction-policy.mjs';
import {validateLevelPlan,scoreBand} from './lib/level-plan.mjs';
import {additionalScoreProfiles} from './lib/target-promotion.mjs';

const root=new URL('../../',import.meta.url),sources={};
const read=file=>{const bytes=fs.readFileSync(new URL(file,root));sources[file]=createHash('sha256').update(bytes).digest('hex');return JSON.parse(bytes);};
const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const to=Number(option('--to',1000)),preservedThrough=500;
assert.equal(to,1000);
const base=read('level-editor/dist/data/level-plan.json');
const parent=read('level-editor/dist/data/level-plan-target-floor-first-500-r2.json');
const prefixFile=option('--prefix','level-editor/dist/data/presets/our-levels-new-plan-first-500-2026-11-16.json'),prefix=read(prefixFile);
assert.equal(prefix.level.length,preservedThrough);
const dictionary=['required-words','guide-words','extra-words'].flatMap(name=>read('level-editor/dist/data/'+name+'.json'));
const reference=createPresetRecords(read('level-editor/dist/data/presets/word-tiles-list0.json').slice(0,to),'word-tiles',dictionary).map(record=>record.level);
const lengths=[3,4,5,6,7,8],vector=level=>lengths.map(length=>level.targetWords.filter(word=>word.word.length===length).length);
const apportion=(counts,total)=>{const raw=counts.map(n=>n*total/counts.reduce((a,b)=>a+b,0)),result=raw.map(Math.floor);for(const i of counts.map((_,i)=>i).sort((a,b)=>(raw[b]-result[b])-(raw[a]-result[a])||a-b).slice(0,total-result.reduce((a,b)=>a+b,0)))result[i]++;return result;};
const plan=structuredClone(parent);plan.id=`our-level-plan-target-floor-first-${to}-20261117`;plan.parentPlanId=parent.id;delete plan.revisionOf;
plan.scope={...plan.scope,to,plannedLevels:to-5};
plan.continuation={preservedThrough,prefixFile,prefixSha256:sources[prefixFile],newStages:to===100?[[51,60],[61,80],[81,100]]:Array.from({length:(to-preservedThrough)/20},(_,i)=>[preservedThrough+i*20+1,preservedThrough+(i+1)*20]),countRule:'at-least-original-plan-and-corresponding-reference'};
plan.stageBudgetScope=[6,to];
for(const original of base.records.filter(row=>row.position>preservedThrough&&row.position<=to)){
 const row=structuredClone(original),oldN=row.targetCount,N=Math.max(oldN,reference[row.position-1].targetWords.length),extra=N-oldN;
 row.minimumTargetCount=reference[row.position-1].targetWords.length;row.previousTargetCount=oldN;row.targetCount=N;
 row.scoreProfiles=additionalScoreProfiles(row.scoreCounts,extra);row.scoreCounts=apportion(row.scoreCounts,N);
 row.scoreProfiles.sort((a,b)=>a.reduce((sum,n,i)=>sum+Math.abs(n-row.scoreCounts[i]),0)-b.reduce((sum,n,i)=>sum+Math.abs(n-row.scoreCounts[i]),0));
 if(to>=200&&extra){
  const balanced=[...row.scoreProfiles],simple=[...balanced].sort((a,b)=>a.reduce((s,n,i)=>s+(n-original.scoreCounts[i])*[0,1,2,4][i],0)-b.reduce((s,n,i)=>s+(n-original.scoreCounts[i])*[0,1,2,4][i],0)),seen=new Set();
  row.scoreProfiles=[];for(let i=0;i<balanced.length;i++)for(const profile of [simple[i],balanced[i]]){const key=profile.join(',');if(!seen.has(key)){seen.add(key);row.scoreProfiles.push(profile);}}
 }
 const samples=[0,1,2,3].map(band=>row.referenceWordScores.filter(score=>scoreBand(score)===band));
 row.referenceWordScores=row.scoreCounts.flatMap((count,band)=>Array.from({length:count},(_,i)=>samples[band][i%samples[band].length]??[2,4.5,7.5,10.5][band])).sort((a,b)=>a-b);
 row.referenceScore=Number(row.referenceWordScores.reduce((a,b)=>a+b,0).toFixed(2));row.maximumWordReference=Math.max(...row.referenceWordScores);
 row.scoreMinimum=Number(Math.min(row.scoreMinimum*N/oldN,row.referenceScore).toFixed(2));row.scoreMaximum=Number(Math.max(row.scoreMaximum*N/oldN,row.referenceScore).toFixed(2));
 if(to>=200&&extra){
  const addedWordMinimum=original.targetComposition.noThreeLetter?1.4:1.3;
  row.scoreMinimum=Number(Math.min(row.scoreMinimum,original.scoreMinimum+addedWordMinimum*extra).toFixed(2));
  row.addedTargetScoring={originalTargetCount:oldN,addedTargets:extra,originalScoreMinimum:original.scoreMinimum,minimumPerAddedTarget:addedWordMinimum,originalBandSlotsPreserved:true};
 }
 const preferred=apportion(vector(reference[row.position-1]),N),cfg=row.targetComposition;
 if(cfg.noThreeLetter&&preferred[0]){preferred[1]+=preferred[0];preferred[0]=0;}
 if(!cfg.noThreeLetter&&!preferred[0]){const donor=preferred.indexOf(Math.max(...preferred));preferred[donor]--;preferred[0]++;}
 cfg.preferredLengths=preferred.flatMap((count,i)=>Array(count).fill(i+3));cfg.preferredCounts=[...preferred.slice(0,3),preferred.slice(3).reduce((a,b)=>a+b,0)];
 cfg.preferredDistinctLengths=preferred.filter(Boolean).length;cfg.minimumDistinctLengths=2;cfg.preferredCountRanges=cfg.preferredCounts.map(()=>[0,N]);
 cfg.directionMetric=plan.wordDirectionPolicy.id;cfg.weights.firstStep=5;delete cfg.firstStepPositiveShares;
 plan.records.push(row);
}
for(const [from,to]of plan.continuation.newStages){
 const rows=plan.records.filter(row=>from<=row.position&&row.position<=to),peers=reference.slice(from-1,to),total=rows.reduce((sum,row)=>sum+row.targetCount,0);
 const referenceCounts=lengths.map(length=>peers.flatMap(level=>level.targetWords).filter(word=>word.word.length===length).length),counts=apportion(referenceCounts,total);
 const budget={id:`target-floor-weighted-stage-${from}-${to}`,from,to,levels:rows.length,targetTotal:total,referenceCounts,targets:{},ranges:{},
  directionMetric:plan.wordDirectionPolicy.id,directionPolicy:structuredClone(parent.stageBudgets.at(-1).directionPolicy),directionPacing:structuredClone(parent.stageBudgets.at(-1).directionPacing),
  directionCarryByLength:{},referenceDirectionCounts:{},directionSharesByLength:{},preserveBoards:false};
 const set=(key,target,low,high)=>{budget.targets[key]=target;budget.ranges[key]=[low,high];};
 for(let i=0;i<lengths.length;i++)set('length:'+lengths[i],counts[i],counts[i]?Math.max(referenceCounts[i],counts[i]-1):0,counts[i]?counts[i]+1:0);
 const tolerance=Math.max(1,Math.ceil(rows.length*.1));
 for(const label of ['3','4','5','6+'])for(let count=0;count<=(label==='6+'?2:label==='5'?3:Math.max(...rows.map(row=>row.targetCount)));count++){
  const target=peers.filter(level=>level.targetWords.filter(word=>label==='6+'?word.word.length>5:word.word.length===Number(label)).length===count).length;
  const spread=label==='6+'?1:tolerance;set(`hist:${label}:${count}`,target,Math.max(0,target-spread),Math.min(rows.length,target+spread));
 }
 for(let n=1;n<=6;n++){const target=peers.filter(level=>new Set(level.targetWords.map(word=>word.word.length)).size===n).length,excluded=n===1||n===6&&!target;set('variety:'+n,target,excluded?0:Math.max(0,target-1),excluded?0:Math.min(rows.length,target+1));}
 const flags=peers.map(level=>level.targetWords.some(word=>word.word.length===5)),coverage=flags.filter(Boolean).length;
 let run=0,maxRun=0;for(const flag of flags){run=flag?0:run+1;maxRun=Math.max(maxRun,run);}
 const blockMinimum=Math.min(...Array.from({length:rows.length/5},(_,i)=>flags.slice(i*5,i*5+5).filter(Boolean).length));
 budget.fiveCoverage={targetLevels:coverage,allowedLevels:[coverage,Math.min(rows.length,coverage+1)],perFiveLevelsMinimum:blockMinimum,maxConsecutiveZeroLevels:Math.max(1,maxRun)};
 let P=0,Z=0;const bounds={positive:[0,0],neutral:[0,0]};
 for(const length of lengths){
  const tally={total:0,positive:0,reverse:0,neutral:0};
  for(const level of peers){const measured=measureWordDirections(level)[length];for(const key of Object.keys(tally))tally[key]+=measured?.[key]??0;}
  const shares=Object.fromEntries(['positive','reverse','neutral'].map(key=>[key,tally.total?tally[key]/tally.total:key==='reverse'?1:0]));
  budget.referenceDirectionCounts[length]=tally;budget.directionSharesByLength[length]=shares;budget.directionCarryByLength[length]={positive:0,reverse:0,neutral:0};
  const pairs=directionPairs(budget,length),preferred=weightedOptions(budget.targets['length:'+length],shares,budget.directionPolicy).preferred;
  for(const name of ['positive','neutral']){const low=Math.min(...pairs.map(pair=>pair[name])),high=Math.max(...pairs.map(pair=>pair[name]));set(name+':'+length,preferred[name],low,high);bounds[name][0]+=low;bounds[name][1]+=high;}
  P+=preferred.positive;Z+=preferred.neutral;
 }
 set('positive',P,...bounds.positive);set('neutral',Z,...bounds.neutral);
 for(const row of rows){
  const cfg=row.targetComposition,N=row.targetCount;Object.assign(cfg,{stageFrom:from,stageTo:to,stageBudgetId:budget.id,directionSharesByLength:budget.directionSharesByLength});const templates=[];
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
 plan.stageBudgets.push(budget);
}
plan.extensionSources=sources;
if(to>=200)plan.continuation.addedTargetScoring='retain-original-band-slots; lower-total-bound-adds-minimum-word-score-for-extra-targets; balanced-and-simple-profile-search-interleaved';
assert.deepEqual(plan.records.slice(0,parent.records.length),parent.records);assert.deepEqual(plan.stageBudgets.slice(0,parent.stageBudgets.length),parent.stageBudgets);
validateLevelPlan(plan);
fs.writeFileSync(new URL(`level-editor/dist/data/level-plan-target-floor-first-${to}.json`,root),JSON.stringify(plan,null,2)+'\n');
console.log(JSON.stringify({id:plan.id,preservedThrough,newTargets:plan.records.filter(row=>row.position>preservedThrough).reduce((sum,row)=>sum+row.targetCount,0),stages:plan.stageBudgets.slice(parent.stageBudgets.length).map(b=>({from:b.from,to:b.to,total:b.targetTotal,lengthTargets:Object.fromEntries(lengths.map(n=>[n,b.targets['length:'+n]])),fiveCoverage:b.fiveCoverage}))}));
