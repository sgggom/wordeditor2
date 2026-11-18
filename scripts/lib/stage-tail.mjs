import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {templateMetrics,templateVector,EXACT_LENGTHS,compositionMetrics} from './stage-budget.mjs';

export function appendCompositionMetrics(used,composition,budget){
 const next={...used};for(const [key,count]of Object.entries(compositionMetrics(composition,budget)))next[key]=(next[key]??0)+count;return next;
}

export function createStageTailSolver(python){
 const cache=new Map(),stats={queries:0,cacheHits:0,solves:0};
 const script=fileURLToPath(new URL('./solve-stage-tail.py',import.meta.url));
 const solve=request=>{
  stats.queries++;
  const key=JSON.stringify([request.budget.id,request.rows.map(row=>row.position),Object.entries(request.used).filter(([,value])=>value).sort()]);
  if(cache.has(key)){stats.cacheHits++;return cache.get(key);}
  const result=spawnSync(python,[script],{input:JSON.stringify(request),encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
  if(result.error||result.status!==0)throw new Error('阶段剩余预算求解失败：'+(result.error?.message??result.stderr));
  const value=JSON.parse(result.stdout);stats.solves++;
  if(cache.size>=5000)cache.delete(cache.keys().next().value);
  cache.set(key,value);return value;
 };
 solve.stats=stats;return solve;
}
