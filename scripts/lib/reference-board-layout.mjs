import assert from 'node:assert/strict';

const SPECIAL_IDS=[12,25,28,29,33];
export function competitorPosition(position){
 assert.ok(Number.isInteger(position)&&position>=1&&position<=2000);
 return position<=1500?position:position-500;
}
export function checkReferenceBoardLayout(records,reference,shapes,{previousSpecialShapeId=12}={}){
 const byId=new Map(shapes.map(s=>[s.id,s]));
 const violations=[];let previous=previousSpecialShapeId;
 for(const row of records){
  const source=reference[competitorPosition(row.position)-1];
  assert.ok(source,'缺少竞品参考关');
  const special=row.position%5===0;
  if(!special){
   if(row.rows!==source.height||row.columns!==source.width||row.boardMask.some(line=>line.includes('0')))
    violations.push({position:row.position,kind:'ordinarySize',expected:[source.width,source.height]});
  }else{
   const shape=byId.get(row.shapeId),choices=SPECIAL_IDS.filter(id=>id!==previous).map(id=>byId.get(id));
   const nearest=Math.min(...choices.map(s=>Math.abs(s.activeCells-source.width*source.height)));
   if(!shape||!SPECIAL_IDS.includes(row.shapeId)||row.shapeId===previous||
    Math.abs(shape.activeCells-source.width*source.height)!==nearest||
    shape.rows!==row.rows||shape.columns!==row.columns||JSON.stringify(shape.boardMask)!==JSON.stringify(row.boardMask))
    violations.push({position:row.position,kind:'specialShape',previous});
   previous=row.shapeId;
  }
 }
 return {passed:violations.length===0,violations};
}
export function alignReferenceBoardLayout(records,reference,shapes,{previousSpecialShapeId=12,preferredShapes=new Map()}={}){
 const byId=new Map(shapes.map(s=>[s.id,s])),used=new Map(SPECIAL_IDS.map(id=>[id,0]));
 let previous=previousSpecialShapeId;
 const result=records.map(row=>{
  const referencePosition=competitorPosition(row.position),source=reference[referencePosition-1];
  const special=row.position%5===0;let shape;
  if(special){
   const choices=SPECIAL_IDS.filter(id=>id!==previous).map(id=>byId.get(id));
   const distance=Math.min(...choices.map(s=>Math.abs(s.activeCells-source.width*source.height)));
   const nearest=choices.filter(s=>Math.abs(s.activeCells-source.width*source.height)===distance);
   shape=nearest.find(s=>s.id===preferredShapes.get(row.position))??nearest.sort((a,b)=>used.get(a.id)-used.get(b.id)||a.id-b.id)[0];
   previous=shape.id;used.set(shape.id,used.get(shape.id)+1);
  }else{
   shape=shapes.find(s=>s.rows===source.height&&s.columns===source.width&&s.activeCells===s.rows*s.columns);
  }
  assert.ok(shape,`第${row.position}关缺少造型`);
  return {...row,rows:shape.rows,columns:shape.columns,activeCells:shape.activeCells,shapeId:shape.id,
   special,boardMask:[...shape.boardMask],referencePosition,
   type:row.difficulty==='简单'?(shape.activeCells===15?'大盘舒缓':'轻松连词'):row.type};
 });
 assert.ok(checkReferenceBoardLayout(result,reference,shapes,{previousSpecialShapeId}).passed);
 return result;
}
