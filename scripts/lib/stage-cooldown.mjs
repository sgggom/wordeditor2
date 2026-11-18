// Only accepted prefix levels have known words. The joint solver separately
// prevents any word from appearing twice among the new levels of a stage.
export function stageBlockedWords(entries,rows,{range=50,futureLevels=[]}={}){
 return new Map(rows.map(row=>[row.position,new Set([
  ...entries.filter(entry=>entry.position<row.position&&row.position-entry.position<=range).map(entry=>entry.level),
  ...futureLevels,
 ].flatMap(level=>[...level.targetWords,...level.extraWords].map(word=>word.word)))]));
}
