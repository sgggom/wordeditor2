import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function createTightenedStageTailSolver(python){
 const cache=new Map(),stats={queries:0,cacheHits:0,solves:0};
 const script=fileURLToPath(new URL('./solve-tightened-stage.py',import.meta.url));
 const solve=request=>{
  stats.queries++;
  const key=JSON.stringify([request.budget.id,request.rows.map(row=>row.position),Object.entries(request.used).filter(([,value])=>value).sort(),request.fivePresence??{},request.budget.directionCarryByLength??{}]);
  if(cache.has(key)){stats.cacheHits++;return cache.get(key);}
  const result=spawnSync(python,[script],{input:JSON.stringify({...request,mode:'tail'}),encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  if(result.error||result.status!==0)throw new Error('收紧配置预算求解失败：'+(result.error?.message??result.stderr));
  const value=JSON.parse(result.stdout);stats.solves++;
  if(cache.size>=5000)cache.delete(cache.keys().next().value);cache.set(key,value);return value;
 };
 solve.stats=stats;return solve;
}
