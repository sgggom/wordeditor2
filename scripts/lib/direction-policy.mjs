export const halfUp=value=>Math.floor(value+.5+1e-10);
export const isWeighted=config=>config?.directionMetric==='weighted-path-direction-20261113';
export const directionRate=(budget,length)=>budget.directionSharesByLength?.[length]?.positive??budget.firstStepPositiveShares?.[length]??0;
export function weightedOptions(N,shares,policy,carry={}){
 const names=['positive','reverse','neutral'],raw=names.map(name=>N*(shares[name]??0)+(N>0?(carry?.[name]??0):0));
 const preferred=raw.map(value=>Math.max(0,Math.floor(value+1e-10)));
 while(preferred.reduce((a,b)=>a+b,0)<N){const order=names.map((_,i)=>i).sort((a,b)=>(raw[b]-preferred[b])-(raw[a]-preferred[a])||a-b);preferred[order[0]]++;}
 while(preferred.reduce((a,b)=>a+b,0)>N){const order=names.map((_,i)=>i).filter(i=>preferred[i]).sort((a,b)=>(raw[a]-preferred[a])-(raw[b]-preferred[b])||a-b);preferred[order[0]]--;}
 const nearest=Object.fromEntries(names.map((name,i)=>[name,preferred[i]])),allowed=[];
 if(N>=policy.largeSampleMinimum)for(let P=0;P<=N;P++)for(let Z=0;Z<=N-P;Z++){
  const values={positive:P,neutral:Z,reverse:N-P-Z};
  if(names.every(name=>Math.abs(values[name]/N-(shares[name]??0))<=policy.largeSampleTolerancePoints/100+1e-10))allowed.push(values);
 }
 if(!allowed.length)allowed.push(nearest);
 return {preferred:nearest,allowed};
}
export function nextWeightedCarry(carry,N,shares,counts){
 return Object.fromEntries(['positive','reverse','neutral'].map(name=>[name,N===0?(carry?.[name]??0):N===1?(carry?.[name]??0)+(shares[name]??0)-(counts[name]??0):0]));
}
export function positiveOptions(N,rate,policy,carry=0){
 if(!N)return {preferred:0,allowed:[0]};
 const nearest=Math.max(0,Math.min(N,halfUp(N*rate+carry)));
 if(N<policy.largeSampleMinimum)return {preferred:nearest,allowed:[nearest]};
 const tolerance=policy.largeSampleTolerancePoints/100;
 const low=Math.max(0,Math.ceil(N*(rate-tolerance)-1e-9)),high=Math.min(N,Math.floor(N*(rate+tolerance)+1e-9));
 const allowed=low<=high?Array.from({length:high-low+1},(_,i)=>low+i):[nearest];
 return {preferred:allowed.reduce((best,n)=>Math.abs(n-nearest)<Math.abs(best-nearest)?n:best,allowed[0]),allowed};
}
export function directionPairs(budget,length){
 const [low,high]=budget.ranges['length:'+length],rate=directionRate(budget,length),carry=budget.directionCarryByLength?.[length]??0;
 if(isWeighted(budget))return Array.from({length:high-low+1},(_,i)=>low+i).flatMap(N=>{
  const shares=budget.directionSharesByLength[length],{preferred,allowed}=weightedOptions(N,shares,budget.directionPolicy,carry);
  return allowed.map(counts=>({N,...counts,preferred,cost:N?['positive','reverse','neutral'].reduce((sum,name)=>sum+Math.abs(counts[name]/N-shares[name])*100,0):0}));
 });
 return Array.from({length:high-low+1},(_,i)=>low+i).flatMap(N=>{
  const {preferred,allowed}=positiveOptions(N,rate,budget.directionPolicy,carry);
  return allowed.map(positive=>({N,positive,preferred,cost:N?Math.abs(positive/N-rate)*100:0}));
 });
}
export function assessDirections(budget,metrics){
 if(!budget.directionPolicy)return [];
 return [3,4,5,6,7,8].map(length=>{
  const N=metrics['length:'+length]??0,positive=metrics['positive:'+length]??0,reference=directionRate(budget,length);
  if(isWeighted(budget)){
   const neutral=metrics['neutral:'+length]??0,{preferred,allowed}=weightedOptions(N,budget.directionSharesByLength[length],budget.directionPolicy,budget.directionCarryByLength?.[length]);
   return {length,N,positive,neutral,reverse:N-positive-neutral,preferred,allowed,reference:budget.directionSharesByLength[length],passed:allowed.some(row=>row.positive===positive&&row.neutral===neutral)};
  }
  const {preferred,allowed}=positiveOptions(N,reference,budget.directionPolicy,budget.directionCarryByLength?.[length]??0);
  return {length,N,positive,reverse:N-positive,preferred,allowed,reference,passed:allowed.includes(positive)};
 });
}
export function nextDirectionCarry(carry,N,rate,positive){return N===0?carry:N===1?carry+rate-positive:0;}
