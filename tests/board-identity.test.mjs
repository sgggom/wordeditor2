import test from 'node:test';
import assert from 'node:assert/strict';
import {boardOrientations,boardFamily,letterMultiset} from '../scripts/lib/board-identity.mjs';

test('GOODWILL row swaps and every rotation or reflection share the old board identity',()=>{
 const original='DOOG,WILL',swapped='WILL,DOOG';
 assert.equal(boardFamily(original),boardFamily(swapped));
 assert.equal(letterMultiset(original),letterMultiset(swapped));
 for(const grid of boardOrientations(original))assert.equal(boardFamily(grid),boardFamily(original));
});
test('letter combinations preserve multiplicities and ignore empty shape cells',()=>{
 assert.equal(letterMultiset('AB-,CDE'),letterMultiset('EDC,-BA'));
 assert.notEqual(letterMultiset('AAB,CDE'),letterMultiset('ABB,CDE'));
 assert.notEqual(boardFamily('ABC,DEF'),boardFamily('ABD,CEF'));
 assert.equal(letterMultiset('ABC,DEF'),letterMultiset('ABD,CEF'));
});
