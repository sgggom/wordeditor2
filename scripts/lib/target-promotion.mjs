import {createGameExport} from '../../dist/level-export.js';
import {importGameLevels} from '../../dist/level-import.js';
import {analyzeTargetPaths} from '../../dist/target-path-analysis.js';
import {compareLevelPlan} from './level-plan.mjs';

export function targetCountFloor(current,reference){return Math.max(current,reference);}

export function additionalScoreProfiles(base,extra){
 const result=[];
 for(let a=0;a<=extra;a++)for(let b=0;b<=extra-a;b++)for(let c=0;c<=extra-a-b;c++){
  result.push([base[0]+a,base[1]+b,base[2]+c,base[3]+extra-a-b-c]);
 }
 return result;
}

export function promoteExtraTargets({baseline,row,dictionary,eligibleWords,limit=160}){
 const required=row.targetCount-baseline.targetWords.length,names=new Set(baseline.targetWords.map(word=>word.word));
 if(required<0)throw new Error('补词不能减少原有目标');
 const eligible=baseline.extraWords.filter(word=>eligibleWords.has(word.word)&&word.rarityLevel>=1&&word.rarityLevel<=4&&word.word.length<=8&&!names.has(word.word+'S')&&!(word.word.endsWith('S')&&names.has(word.word.slice(0,-1))))
  .sort((a,b)=>a.rarityLevel-b.rarityLevel||a.word.localeCompare(b.word));
 const result=[],chosen=[];let tested=0;
 function visit(start){
  if(result.length>=limit||tested>=3000)return;
  if(chosen.length<required){
   for(let i=start;i<=eligible.length-(required-chosen.length);i++){
    const entry=eligible[i];if(chosen.some(other=>other.word===entry.word+'S'||entry.word===other.word+'S'))continue;
    chosen.push(entry);visit(i+1);chosen.pop();
   }
   return;
  }
  tested++;
  const added=new Set(chosen.map(word=>word.word)),targets=[...baseline.targetWords,...chosen],cells=baseline.cells.map(cell=>({...cell,count:0}));
  for(const target of targets)for(const cell of target.path)cells[cell].count++;
  const candidate={...baseline,cells,targetWords:targets,extraWords:baseline.extraWords.filter(word=>!added.has(word.word))};
  const game=createGameExport([{level:candidate}]).level[0],level=importGameLevels({level:[game],daily:[]},dictionary)[0],compared=compareLevelPlan(level,row);
  if(!compared.passed||compared.actual.maximum>12||!analyzeTargetPaths(level).allChoicesComplete)return;
  result.push({level,game,compared,promoted:[...added],preservedBoard:true,preservedTargets:true});
 }
 if(eligible.length>=required)visit(0);
 return {candidates:result,eligible:eligible.length,tested,required};
}
