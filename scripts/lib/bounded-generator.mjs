import fs from 'node:fs';
import assert from 'node:assert/strict';

// Opt-in CLI hooks over the current generator; the editor's normal runtime is unchanged.
export async function createBoundedGenerator(){
 const url=new URL('../../dist/level-generator.js',import.meta.url);
 let source=fs.readFileSync(url,'utf8');
 function replace(before,after){assert.equal(source.split(before).length,2,'Generator hook changed');source=source.replace(before,after);}
 source=source.replace(/from "\.\/([^"]+)"/g,(_,file)=>`from "${new URL(file,url).href}"`);
 replace('{ targetWordWhitelist } = {})','{ targetWordWhitelist, trial } = {})');
 replace('    function place(index) {','    function place(index) {\n      if (trial && !trial.withinBudget()) return false;');
 replace('for (let attempt = 0; attempt < GENERATION_BATCH_SIZE; attempt++) {','for (let attempt = 0; attempt < GENERATION_BATCH_SIZE && (!trial || trial.withinBudget()); attempt++) {');
 replace('        const foundWords = findWords({ rows, columns, disabledCells, ...filled, minimumWordLength });',
  `        if (trial && !trial.observeBoard(filled)) return false;
        const foundWords = findWords({ rows, columns, disabledCells, ...filled, minimumWordLength });
        if (trial?.selectTargets) { result = trial.selectTargets(filled, foundWords); return Boolean(result); }`);
 return (await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).createGenerator;
}
