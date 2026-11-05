import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateConfigList, installConfigPreset, readConfigLists, writeConfigLists } from '../dist/level-config.js';
import { CURRENT_INITIAL_WORDS_REVISION, validateGenerationPolicy, validateCurrentRuleConfigs } from '../dist/generation-policy.js';
import { prepareGeneration } from '../dist/level-rules.js';
import { createBatchRunner } from '../dist/batch-runner.js';
import { randomizeBoardShape } from '../dist/board-shape.js';

const preset=JSON.parse(fs.readFileSync(new URL('../dist/data/current-rule-configs.json',import.meta.url)));
const memory=()=>{const data=new Map();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};};
test('every current config has a distinct curated pair from the game target bank with a ten-level cooldown', () => {
  const bank = new Map(JSON.parse(fs.readFileSync(new URL('../dist/data/candidate-words.json', import.meta.url))).words);
  const lastUsed = new Map(), pairs = new Set();
  assert.equal(preset.initialWordsRevision, CURRENT_INITIAL_WORDS_REVISION);
  for (const { position, config } of preset.records) {
    const words = config.fixedWords;
    assert.equal(new Set(words).size, 2);
    assert.equal(words.length, 2);
    const pair = [...words].sort().join('/');
    assert.ok(!pairs.has(pair));
    pairs.add(pair);
    for (const word of words) {
      assert.ok(bank.has(word) && config.filters.rarityLevel.includes(bank.get(word)) && word.length >= 3);
      assert.ok(!words.includes(word + 'S'));
      assert.ok(position - (lastUsed.get(word) ?? -10) > 10);
      lastUsed.set(word, position);
    }
  }
  for (const [position, words] of [[1,['CAT','ALL']], [3,['BAT','OWL']], [6,['CLOUD','LOUD']], [10,['MARKET','SALE']]]) {
    assert.deepEqual(preset.records[position - 1].config.fixedWords, words);
  }
});

test('an existing config list receives initial words once and keeps personal edits and their neighbors safe', () => {
  const storage = memory();
  const records = structuredClone(preset.records.slice(0, 25));
  for (const row of records.slice(1)) row.config.fixedWords = [];
  records[2].config.fixedWords = [preset.records[4].config.fixedWords[0]];
  records[6].config.generationRules.targetWordLengths.push(3);
  records[6].config.desiredTargetCount += 1;
  installConfigPreset({ id: preset.id, label: preset.label, records }, storage);
  installConfigPreset({ id: 'personal', label: '我的配置', records: [] }, storage);
  const before = readConfigLists(storage);
  assert.equal(installConfigPreset(preset, storage), true);
  const library = readConfigLists(storage), list = library.lists[0];
  assert.equal(library.activeListId, before.activeListId);
  assert.deepEqual(library.lists[1], before.lists[1]);
  assert.equal(list.records.length, 25);
  assert.deepEqual(list.records[1].config.fixedWords, preset.records[1].config.fixedWords);
  assert.deepEqual(list.records[2], records[2]);
  assert.deepEqual(list.records[4].config.fixedWords, []);
  assert.deepEqual(list.records[6], records[6]);
  list.records[1].config.fixedWords = [];
  writeConfigLists(library, storage);
  assert.equal(installConfigPreset(preset, storage), false);
  assert.deepEqual(readConfigLists(storage).lists[0].records[1].config.fixedWords, []);
});

test('starting from the middle also reserves the previous ten ungenerated core-word pairs', () => {
  const job = preset.records[60];
  const { config } = prepareGeneration([], null, job.config, null, preset.records);
  const expected = preset.records.slice(50, 71).filter(row => row.position !== job.position).flatMap(row => row.config.fixedWords);
  assert.deepEqual(new Set(config.reservedTargetWords), new Set(expected));
});

test('a revised core pair replaces its previous stock pair while preserving an edited pair', () => {
  const storage = memory();
  const records = structuredClone(preset.records);
  for (const change of preset.initialWordReplacements) {
    records[change.position - 1].config.fixedWords = [...change.previousWords];
  }
  records[1236].config.fixedWords = ['DESIGN', 'SIGN'];
  installConfigPreset({ ...preset, initialWordsRevision: 'initial-words-2000-20261105-v1', records }, storage);
  assert.equal(installConfigPreset(preset, storage), true);
  const saved = readConfigLists(storage).lists[0];
  assert.deepEqual(saved.records[916].config.fixedWords, ['HELP', 'HOPE']);
  assert.deepEqual(saved.records[1236].config.fixedWords, ['DESIGN', 'SIGN']);
  assert.deepEqual(saved.records[1366].config.fixedWords, ['TART', 'TASTE']);
  assert.deepEqual(saved.records[1826].config.fixedWords, ['FLIGHT', 'LIGHT']);
  assert.deepEqual(saved.records[1892].config.fixedWords, ['GROWTH', 'GROWN']);
});
test('the full 2000-rule preset aligns masks, three hollow boards per ten, cooldown and the last500 cycle',()=>{
  assert.equal(validateConfigList(preset.records).length,2000);
  assert.equal(validateCurrentRuleConfigs(preset.records,{complete:true}).length,2000);
  for(let start=0;start<2000;start+=10){
    const block=preset.records.slice(start,start+10);
    assert.deepEqual(block.flatMap((r,i)=>r.config.disabledCells.length?[i+1]:[]),[1,3,7]);
  }
  for(const position of [233,597,747,777,837,897,933]){
    const c=preset.records[position-1].config;
    assert.equal(c.rows*c.columns-c.disabledCells.length,13);
    assert.equal(c.generationRules.referenceCells,15);
  }
  assert.equal(preset.records[1500].config.generationRules.referencePosition,1001);
  assert.equal(preset.records.at(-1).config.generationRules.referencePosition,1500);
  const tampered=structuredClone(preset.records[2].config);tampered.disabledCells=[];
  assert.throws(()=>validateGenerationPolicy(tampered),/禁用格/);
  assert.equal(randomizeBoardShape(preset.records[2].config),preset.records[2].config);
});
test('installing the new rule preset preserves existing records and the active list',()=>{
  const storage=memory(),old={id:'older',label:'保留配置',records:[preset.records[0]]};
  installConfigPreset(old,storage);
  const before=readConfigLists(storage);
  installConfigPreset({...preset,activate:false},storage);
  const after=readConfigLists(storage);
  assert.equal(after.activeListId,before.activeListId);
  assert.deepEqual(after.lists[0],before.lists[0]);
  assert.equal(after.lists[1].records.length,2000);
});
test('rule preparation uses logical positions and reserves actual future targets as well as fixed words',()=>{
  const config=preset.records[19].config;
  const record=(position,word)=>({id:position,level:{rows:2,columns:2,cells:[...'ABCD'].map(letter=>({letter})),
    targetWords:[{word}],extraWords:[],sourceConfig:{position}}});
  const history=[record(1,'OUTSIDE'),record(10,'START'),record(19,'NEAR'),record(20,'OLD'),record(21,'FUTURE')];
  const {config:prepared,duplicateCheck}=prepareGeneration(history,null,config,null,preset.records);
  assert.deepEqual(duplicateCheck.target.words,['START','NEAR']);
  assert.ok(prepared.reservedTargetWords.includes('FUTURE'));
  assert.equal(prepared.minimumWordLength,3);
  assert.equal(prepared.excludedBoards.length,4);
  assert.deepEqual(config,preset.records[19].config);
});
test('batch rule settings reach generation without changing the opening to two-letter mode',async()=>{
  const seen=[],saved=[];
  const runner=createBatchRunner({getHistory:async()=>[],generate:async(config,duplicates)=>{
    seen.push({config,duplicates});
    return {rows:3,columns:3,cells:[],targetWords:[{word:config.generationRules.position===1?'CAT':'BIRD'}],extraWords:[],generationRules:config.generationRules};
  },save:async(level,position)=>{const record={id:position,level};saved.push(record);return record;}});
  const result=await runner.run(preset.records.slice(0,2),preset.records);
  assert.equal(result.phase,'complete');assert.equal(seen.length,2);
  assert.ok(seen.every(entry=>entry.config.minimumWordLength===3));
  assert.ok(seen[1].duplicates.target.words.includes('CAT'));
});
test('a sparse rule run retains later saved positions in the duplicate-board history',async()=>{
  const historical=position=>({id:position,level:{rows:2,columns:2,cells:[...'ABCD'].map(letter=>({letter})),
    targetWords:[{word:position===1?'CAT':'FAR'}],extraWords:[],sourceConfig:{position}}});
  const seen=[];
  const runner=createBatchRunner({getHistory:async()=>[historical(1),historical(801)],generate:async config=>{
    seen.push(config.excludedBoards);
    return {rows:2,columns:2,cells:[...'EFGH'].map(letter=>({letter})),targetWords:[{word:'DOG'}],extraWords:[],generationRules:config.generationRules};
  },save:async(level,position)=>({id:position,level})});
  assert.equal((await runner.run(preset.records.slice(1,3),preset.records)).phase,'complete');
  assert.equal(seen[1].length,3,'position801 remains alongside positions1 and2');
});
