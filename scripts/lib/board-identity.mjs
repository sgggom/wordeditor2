const gridText=(letters,columns)=>Array.from({length:letters.length/columns},(_,r)=>letters.slice(r*columns,(r+1)*columns).join('')).join(',');
export function boardOrientations(grid){
 const input=grid.split(','),h=input.length,w=input[0].length,out=new Set();
 for(let rotation=0;rotation<4;rotation++)for(const mirror of [false,true]){
  const rows=rotation%2?w:h,cols=rotation%2?h:w,letters=Array(h*w);
  for(let r=0;r<h;r++)for(let c=0;c<w;c++){
   let nr,nc;if(rotation===0)[nr,nc]=[r,c];if(rotation===1)[nr,nc]=[c,h-1-r];if(rotation===2)[nr,nc]=[h-1-r,w-1-c];if(rotation===3)[nr,nc]=[w-1-c,r];
   if(mirror)nc=cols-1-nc;letters[nr*cols+nc]=input[r][c];
  }
  out.add(gridText(letters,cols));
 }
 return [...out];
}
export const boardFamily=grid=>boardOrientations(grid).sort()[0];
export const letterMultiset=grid=>[...grid.replaceAll(',','').replaceAll('-','')].sort().join('');
