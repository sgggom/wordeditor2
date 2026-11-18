import assert from 'node:assert/strict';
import {describePath, calculateLevelStatistics} from '../../dist/level-statistics.js';
import {selectExtraWords} from '../../dist/level-rules.js';
import {analyzeTargetPaths} from '../../dist/target-path-analysis.js';
import {validateComposition,measureComposition,compareComposition,compositionCost} from './target-composition.mjs';
import {directionPairs,directionRate} from './direction-policy.mjs';
import {describeWordDirection} from '../../dist/word-direction.js';

export const scoreBand=score=>score<3?0:score<6?1:score<9?2:3;
const tenth=n=>Math.round(n*10);
export function validateLevelPlan(plan){
 assert.equal(plan.status,'review-plan-only','需要逐关规划文件，不能使用旧竞品约束表');
 assert.deepEqual(plan.scope.excludedPositions,[1,2,3,4,5]);
 const seen=new Set();
 for(const row of plan.records){
  assert.ok(Number.isInteger(row.position)&&!seen.has(row.position));seen.add(row.position);
  assert.equal(row.boardMask.length,row.rows);
  assert.ok(row.boardMask.every(line=>line.length===row.columns&&/^[01]+$/.test(line)));
  assert.equal(row.boardMask.join('').replaceAll('0','').length,row.activeCells);
  assert.equal(row.scoreCounts.length,4);assert.ok(row.scoreCounts.every(n=>Number.isInteger(n)&&n>=0));
  assert.equal(row.scoreCounts.reduce((a,b)=>a+b),row.targetCount);
  if(row.minimumTargetCount!==undefined)assert.ok(Number.isInteger(row.minimumTargetCount)&&row.targetCount>=row.minimumTargetCount,'目标词数量低于竞品对应关');
  if(row.scoreProfiles)assert.ok(row.scoreProfiles.length&&row.scoreProfiles.some(profile=>JSON.stringify(profile)===JSON.stringify(row.scoreCounts))&&row.scoreProfiles.every(profile=>profile.length===4&&profile.every(n=>Number.isInteger(n)&&n>=0)&&profile.reduce((a,b)=>a+b,0)===row.targetCount),'补词得分分布配置无效');
  assert.equal(row.referenceWordScores.length,row.targetCount);
  const referenceCounts=[0,0,0,0];for(const score of row.referenceWordScores){assert.ok(Number.isFinite(score)&&score>0&&score<=12);referenceCounts[scoreBand(score)]++;}
  assert.deepEqual(referenceCounts,row.scoreCounts,'逐词参考分与分档数量不一致');
  assert.ok(Math.abs(row.referenceWordScores.reduce((a,b)=>a+b,0)-row.referenceScore)<1e-8,'参考总分不一致');
  assert.ok(row.scoreMinimum<=row.referenceScore&&row.referenceScore<=row.scoreMaximum);
  if(plan.targetCompositionPolicy)assert.equal(row.targetComposition?.policyId,plan.targetCompositionPolicy.id,'逐关词长策略缺失');
  validateComposition(row.targetComposition,row.targetCount);
 }
 if(plan.stageBudgets)for(const budget of plan.stageBudgets){
  const rows=plan.records.filter(row=>row.position>=budget.from&&row.position<=budget.to);
  assert.equal(rows.length,budget.levels,'阶段预算关卡数不一致');
  assert.equal(rows.reduce((sum,row)=>sum+row.targetCount,0),budget.targetTotal,'阶段预算词量不一致');
  assert.equal([3,4,5,6,7,8].reduce((sum,length)=>sum+budget.targets['length:'+length],0),budget.targetTotal,'精确词长预算不一致');
  for(const [key,range]of Object.entries(budget.ranges)){
   assert.ok(Array.isArray(range)&&range.length===2&&range.every(n=>Number.isInteger(n)&&n>=0)&&range[0]<=range[1],'阶段验收范围无效');
   assert.ok(Number.isFinite(budget.targets[key])&&budget.targets[key]>=range[0]&&budget.targets[key]<=range[1],'阶段目标超出验收范围');
  }
  assert.ok(rows.every(row=>row.targetComposition?.stageBudgetId===budget.id&&row.targetComposition.allowedTemplates?.length),'阶段联合模板缺失');
  if(budget.directionPacing)assert.ok([budget.directionPacing.maximumDebt,...[3,4,5,6,7,8].map(length=>budget.directionPacing.maximumDebtByLength?.[length])]
   .every(value=>Number.isInteger(value)&&value>=0),'阶段方向欠额上限无效');
  if(budget.directionPolicy){
   assert.ok(Number.isInteger(budget.directionPolicy.largeSampleMinimum)&&budget.directionPolicy.largeSampleMinimum>0);
   assert.ok(Number.isFinite(budget.directionPolicy.largeSampleTolerancePoints)&&budget.directionPolicy.largeSampleTolerancePoints>=0);
   for(const length of [3,4,5,6,7,8]){assert.ok(directionRate(budget,length)>=0&&directionRate(budget,length)<=1);assert.ok(directionPairs(budget,length).length);}
  }
  if(budget.fiveCoverage){const coverage=budget.fiveCoverage;assert.ok(coverage.allowedLevels[0]<=coverage.targetLevels&&coverage.targetLevels<=coverage.allowedLevels[1]&&coverage.allowedLevels[1]<=budget.levels);assert.ok(Number.isInteger(coverage.perFiveLevelsMinimum)&&coverage.perFiveLevelsMinimum>=0&&coverage.perFiveLevelsMinimum<=5);assert.ok(Number.isInteger(coverage.maxConsecutiveZeroLevels)&&coverage.maxConsecutiveZeroLevels>=0);}
 }
 return plan;
}
export function measuredScores(level){
 const words=level.targetWords.map(entry=>({word:entry.word,path:[...entry.path],
  score:Number((describePath(entry.path,level.columns).difficultyScore+entry.rarityLevel*(1+entry.word.length*.1)).toFixed(2))}));
 const counts=[0,0,0,0];for(const w of words)counts[scoreBand(w.score)]++;
 return {targetCount:words.length,counts,total:Number(words.reduce((s,w)=>s+w.score,0).toFixed(2)),
  maximum:Math.max(...words.map(w=>w.score)),words:words.sort((a,b)=>a.score-b.score||a.word.localeCompare(b.word))};
}
export function compareLevelPlan(level,row,{enforceComposition=true}={}){
 const actual=measuredScores(level),violations=[];
 if(level.rows!==row.rows||level.columns!==row.columns)violations.push('boardSize');
 const mask=Array.from({length:level.rows},(_,r)=>level.cells.slice(r*level.columns,(r+1)*level.columns).map((c,i)=>c.disabled||level.disabledCells?.includes(r*level.columns+i)?'0':'1').join(''));
 if(JSON.stringify(mask)!==JSON.stringify(row.boardMask))violations.push('boardMask');
 if(actual.targetCount!==row.targetCount)violations.push('targetCount');
 if(row.minimumTargetCount!==undefined&&actual.targetCount<row.minimumTargetCount)violations.push('targetCountFloor');
 if(row.scoreProfiles?!row.scoreProfiles.some(profile=>profile.every((n,i)=>n===actual.counts[i])):actual.counts.some((n,i)=>n!==row.scoreCounts[i]))violations.push('scoreDistribution');
 if(actual.total<row.scoreMinimum-1e-8||actual.total>row.scoreMaximum+1e-8)violations.push('totalScore');
 let composition;
 if(row.targetComposition){
  actual.composition=measureComposition(level);composition=compareComposition(actual.composition,row.targetComposition);
  if(enforceComposition)violations.push(...composition.violations);
  else composition={...composition,passed:true,violations:[],mode:'preserved-before-policy'};
 }
 return {passed:!violations.length,violations,actual,...(composition?{composition}:{}),planned:{targetCount:row.targetCount,counts:row.scoreCounts,
  total:row.referenceScore,totalRange:[row.scoreMinimum,row.scoreMaximum],maximum:row.maximumWordReference,...(row.scoreProfiles?{allowedScoreProfiles:row.scoreProfiles,minimumTargetCount:row.minimumTargetCount}:{})}};
}

// Select exactly the requested score composition, with coverage, cooling and all-choice safety.
// Original target words and original competitor quotas are intentionally not inputs.
export function selectPlannedTargets({row,letters,found,whitelist,blocked=new Set(),withinBudget=()=>true,
 random=Math.random,nodeLimit=30000,onCandidate=()=>true,compositionHistory={},onComposition=()=>true,additionalCost=()=>0,
 normalizeCandidate=level=>level}){
 const disabledCells=row.boardMask.join('').split('').flatMap((v,i)=>v==='0'?[i]:[]);
 const forbiddenLengths=new Set(found.filter(e=>blocked.has(e.word)).map(e=>e.word.length));
 const groups=[[],[],[],[]],layout=letters.reduce((mask,c,i)=>c?mask|(1<<i):mask,0),templates=row.targetComposition?.allowedTemplates;
 function pathVariants(original){
  if(!templates||original.pathAnalysis.legalPathCount===1)return [original.pathAnalysis.representative.path];
  const options=new Map(),neighbors=letters.map((_,cell)=>[cell-row.columns,cell+row.columns,...(cell%row.columns?[cell-1]:[]),...(cell%row.columns<row.columns-1?[cell+1]:[])].filter(next=>next>=0&&next<letters.length));
  let visited=0;
  function visit(cell,used,path){
   if(++visited>1500||letters[cell]!==original.word[path.length])return;
   const route=[...path,cell];used|=1<<cell;
   if(route.length===original.word.length){
    const described=describePath(route,row.columns),score=described.difficultyScore+original.rarityLevel*(1+route.length*.1);
    if(score>12)return;
    const direction=row.targetComposition.directionMetric?describeWordDirection(route,row.columns).direction:['R','D'].includes(described.firstDirection);
    const key=[scoreBand(score),direction,used].join(':');
    if(!options.has(key)||described.difficultyScore<options.get(key).score)options.set(key,{path:route,score:described.difficultyScore});
   }else for(const next of neighbors[cell])if(!(used&(1<<next)))visit(next,used,route);
  }
  for(let cell=0;cell<letters.length;cell++)visit(cell,0,[]);
  return [...options.values()].map(option=>option.path);
 }
 for(const original of found){
  if(original.onlyExtra||!whitelist.has(original.word)||blocked.has(original.word)||original.word.length<3||
   original.rarityLevel<1||original.rarityLevel>4||forbiddenLengths.has(original.word.length))continue;
  if(row.targetComposition?.noThreeLetter&&original.word.length===3)continue;
  if(templates&&!templates.some(vector=>vector[original.word.length-3]>0))continue;
  for(const path of pathVariants(original)){
  const assigned=describePath(path,row.columns);
  const entry={...original,path:[...path],pathAnalysis:{...original.pathAnalysis,assigned}};
  const score=tenth(assigned.difficultyScore+entry.rarityLevel*(1+entry.word.length*.1));
  if(score>120)continue;
  const band=scoreBand(score/10);if(!row.scoreCounts[band])continue;
  groups[band].push({entry,score,mask:path.reduce((m,c)=>m|(1<<c),0),tie:random()});
  }
 }
 if(groups.some((g,i)=>g.length<row.scoreCounts[i]))return null;
 if(row.targetComposition&&!row.targetComposition.noThreeLetter&&!groups.some(group=>group.some(candidate=>candidate.entry.word.length===3)))return null;
 for(const group of groups)group.sort((a,b)=>b.entry.path.length-a.entry.path.length||a.tie-b.tie);
 const suffix=groups.map(g=>{const s=Array(g.length+1).fill(0);for(let i=g.length-1;i>=0;i--)s[i]=s[i+1]|g[i].mask;return s;});
 const starts=[0,0,0,0],remaining=[...row.scoreCounts],chosen=[],names=new Set(),chosenLengths=[0,0,0,0,0,0];
 const minTotal=tenth(row.scoreMinimum),maxTotal=tenth(row.scoreMaximum);
 let nodes=0,winner=null,bestCost=Infinity,examined=0;
 function search(coverage,total){
  if(++nodes>nodeLimit||!withinBudget()||examined>=12)return;
  if(templates&&!templates.some(vector=>vector.every((count,index)=>count>=chosenLengths[index])))return;
  let possible=coverage,lower=total,upper=total,bucket=-1,bestRatio=Infinity;
  for(let b=0;b<4;b++){
   const needed=remaining[b];if(!needed)continue;
   const available=groups[b].length-starts[b];if(available<needed)return;
   possible|=suffix[b][starts[b]];
   const scores=groups[b].slice(starts[b]).map(c=>c.score).sort((a,b)=>a-b);
   lower+=scores.slice(0,needed).reduce((s,n)=>s+n,0);upper+=scores.slice(-needed).reduce((s,n)=>s+n,0);
   const ratio=available/needed;if(ratio<bestRatio){bucket=b;bestRatio=ratio;}
  }
  if(possible!==layout||lower>maxTotal||upper<minTotal||total>maxTotal)return;
  if(bucket<0){
   if(coverage!==layout||total<minTotal)return;
   const targets=chosen.map(c=>c.entry),extras=selectExtraWords(found,targets);
   if(extras.some(e=>blocked.has(e.word)))return;
   const cells=letters.map((letter,i)=>({letter,count:0,...(disabledCells.includes(i)?{disabled:true}:{})}));
   for(const e of targets)for(const c of e.path)cells[c].count++;
   if(cells.some((c,i)=>disabledCells.includes(i)?c.count!==0:c.count<1||c.count>35))return;
   let level={rows:row.rows,columns:row.columns,disabledCells,cells,targetWords:targets,extraWords:extras,
    candidateWords:found.filter(e=>!e.onlyExtra),foundWords:found,initialWords:[],minimumWordLength:3,
    desiredTargetCount:row.targetCount,fixedWords:[],fixedLayout:null,fixedWordExemptions:[],filters:{rarityLevel:[1,2,3,4]}};
   level=normalizeCandidate(level);if(!level)return;
   const composition=row.targetComposition?measureComposition(level):null;
   if(composition&&!compareComposition(composition,row.targetComposition).passed)return;
   if(!onComposition(composition,level))return;
   if(level.targetWords.some(e=>!e.pathAnalysis.safe)&&!analyzeTargetPaths(level).allChoicesComplete)return;
   examined++;
   const actual=measuredScores(level);
   const vectorCost=actual.words.reduce((s,w,i)=>s+Math.abs(w.score-row.referenceWordScores[i]),0);
   const cost=vectorCost+extras.length*1.25+Math.abs(actual.total-row.referenceScore)*.25+
    (composition?compositionCost(composition,row.targetComposition,compositionHistory):0)+additionalCost(composition,level);
   if(cost<bestCost&&onCandidate(level)){level.statistics=calculateLevelStatistics(level);winner=level;bestCost=cost;}
   return;
  }
  const group=groups[bucket],old=starts[bucket];
  for(let i=old;i<=group.length-remaining[bucket];i++){
   const c=group[i],word=c.entry.word;
   if(names.has(word)||names.has(word+'S')||word.endsWith('S')&&names.has(word.slice(0,-1)))continue;
   starts[bucket]=i+1;remaining[bucket]--;chosen.push(c);names.add(word);chosenLengths[word.length-3]++;
   search(coverage|c.mask,total+c.score);
   names.delete(word);chosen.pop();remaining[bucket]++;starts[bucket]=old;chosenLengths[word.length-3]--;
   if(nodes>nodeLimit||!withinBudget()||examined>=12)break;
  }
 }
 search(0,0);return winner;
}
