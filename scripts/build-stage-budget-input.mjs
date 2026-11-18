import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describePath} from '../dist/level-statistics.js';
import {createPresetRecords} from '../dist/preset-level-lists.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file)));
const plan=read('level-editor/dist/data/level-plan.json');
const reference=read('level-editor/dist/data/presets/word-tiles-list0.json').slice(0,50);
const records=createPresetRecords(reference,'word-tiles');
const shapes={};
for(const row of plan.records.filter(row=>row.position<=50)){
 const key=row.boardMask.join(',');if(shapes[key])continue;
 const enabled=row.boardMask.join('').split('').map(value=>value==='1'),columns=row.columns;
 const neighbors=enabled.map((_,cell)=>[cell-columns,cell+columns,...(cell%columns?[cell-1]:[]),...(cell%columns<columns-1?[cell+1]:[])].filter(next=>next>=0&&next<enabled.length&&enabled[next]));
 const costs=Object.fromEntries([3,4,5,6,7,8].map(length=>[length,new Set()]));
 function visit(cell,used,route){
  const next=[...route,cell];used|=1<<cell;
  if(next.length>=3)costs[next.length].add(describePath(next,columns).difficultyScore);
  if(next.length<8)for(const neighbor of neighbors[cell])if(!(used&(1<<neighbor)))visit(neighbor,used,next);
 }
 for(let cell=0;cell<enabled.length;cell++)if(enabled[cell])visit(cell,0,[]);
 shapes[key]=Object.fromEntries(Object.entries(costs).map(([length,values])=>[length,[...values].sort((a,b)=>a-b)]));
}
const data={plan,reference:records.map(({level},index)=>({position:index+1,cells:level.cells.length,words:level.targetWords.map(entry=>({length:entry.word.length,
 positive:['R','D'].includes(describePath(entry.path,level.columns).firstDirection)}))})),pathCosts:shapes};
const file=path.join(root,'outputs/20261112-stage-budget-first-50/input.json');fs.writeFileSync(file,JSON.stringify(data));
console.log(JSON.stringify({rows:45,shapes:Object.keys(shapes).length,file}));
