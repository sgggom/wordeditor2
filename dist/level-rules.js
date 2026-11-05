import { futureFixedTargetWords } from "./level-config.js";
import { calculateLevelStatistics } from "./level-statistics.js";

export const EXTRA_DUPLICATE_ATTEMPT_LIMIT = 100_000;

export function acceptExtraDuplicateFallback(level, attempts, duplicateWords) {
  return { ...level, extraDuplicateFallback: { attempts, duplicateCount: duplicateWords.length, words: [...duplicateWords] } };
}

export function createDuplicateCheck(records, ranges, beforePosition = null) {
  let history = records;
  if (beforePosition !== null) {
    if (!Number.isSafeInteger(beforePosition) || beforePosition < 1) throw new Error("当前关号需为正整数。");
    const latest = new Map();
    for (const [index, record] of records.entries()) {
      const sourcePosition = record.level.sourceConfig?.position;
      const position = Number.isSafeInteger(sourcePosition) && sourcePosition > 0 ? sourcePosition : index + 1;
      if (position >= beforePosition) continue;
      const previous = latest.get(position);
      // A rerun appends a new record. Use the newest version of each earlier
      // level, even if the saved list has since been reordered.
      if (!previous || !Number.isSafeInteger(previous.id) || !Number.isSafeInteger(record.id) || record.id > previous.id) latest.set(position, record);
    }
    history = [...latest.entries()].sort(([a], [b]) => a - b).map(([, record]) => record);
  }
  return Object.fromEntries(["target", "extra"].map(kind => {
    const range = ranges[kind];
    if (!Number.isSafeInteger(range) || range < 0) {
      throw new Error(`${kind === "target" ? "目标词" : "额外词"}查重范围需为大于或等于 0 的整数。`);
    }
    const recent = range === 0 ? [] : history.slice(-range);
    return [kind, {
      range,
      levelIds: recent.map(record => record.id),
      words: [...new Set(recent.flatMap(({ level }) => level[`${kind}Words`])
        .map(entry => entry.word.toUpperCase()))],
    }];
  }));
}

export function findDuplicateWords(level, duplicateCheck) {
  const fixed = new Set(level.fixedWords ?? []);
  const initial = new Set(level.initialWords?.map(entry => entry.word) ?? []);
  const exemptions = new Set((level.fixedWordExemptions ?? []).filter(word => fixed.has(word) && initial.has(word)));
  return Object.fromEntries(["target", "extra"].map(kind => {
    const previous = new Set(duplicateCheck[kind].range > 0
      ? duplicateCheck[kind].words.map(word => word.toUpperCase()) : []);
    return [kind, [...new Set(level[`${kind}Words`].map(entry => entry.word.toUpperCase()))]
      .filter(word => previous.has(word) && !(kind === "target" && exemptions.has(word)))];
  }));
}

export function setTargetWord(level, word, selected) {
  if (typeof selected !== "boolean") throw new Error("目标词选择无效。");
  const candidate = level.candidateWords.find(entry => entry.word === word);
  const wasSelected = level.targetWords.some(entry => entry.word === word);
  if ((!candidate || candidate.onlyExtra) && (selected || !wasSelected)) throw new Error("只能从候选词中选择目标词。");
  if (!selected && level.fixedWords?.includes(word)) throw new Error("固定词不能移出关卡目标。");
  if (wasSelected === selected) return level;
  const allWords = [...level.targetWords, ...level.extraWords];
  const targetNames = new Set(level.targetWords.map(entry => entry.word));
  if (selected && (targetNames.has(word+'S') || (word.endsWith('S') && targetNames.has(word.slice(0,-1))))) {
    throw new Error('同关目标不能同时包含直接加S的词对。');
  }
  if (selected) targetNames.add(word);
  else targetNames.delete(word);
  const targetWords = selected ? [...level.targetWords, candidate] : level.targetWords.filter(entry => entry.word !== word);
  const extraWords = allWords.filter(entry => !targetNames.has(entry.word)).sort((a, b) => a.word.localeCompare(b.word));
  const cells = level.cells.map(cell => ({ ...cell, count: 0 }));
  for (const entry of targetWords) {
    for (const cell of entry.path) cells[cell].count += 1;
  }
  if (cells.some((cell, index) => !cell.disabled && !level.disabledCells?.includes(index) && cell.count < 1)) {
    throw new Error("移除后有格子没有目标词覆盖，请先勾选覆盖这些格子的其他目标词。");
  }
  // Counts and statistics always describe the current target selection.
  const edited = { ...level, cells, targetWords, extraWords, targetCount: targetWords.length, targetLimitsEnabled: false, targetsEdited: true };
  return { ...edited, statistics: calculateLevelStatistics(edited) };
}

// Visible list order is authoritative, regardless of legacy source annotations.
export function generationContext(records, activeId) {
  const index = records.findIndex(record => record.id === activeId);
  return { position: index < 0 ? records.length + 1 : index + 1,
    history: index < 0 ? records : records.slice(0, index) };
}

export function resizeFixedLayout(layout, next) {
  if (!layout) return { layout: null, released: [] };
  const released = [];
  const placements = layout.placements.flatMap(entry => {
    const coordinates = entry.path.map(cell => [Math.floor(cell / layout.columns), cell % layout.columns]);
    if (coordinates.some(([row, col]) => row >= next.rows || col >= next.columns || next.disabledCells?.includes(row * next.columns + col))) {
      released.push(entry.word); return [];
    }
    return [{ ...entry, path: coordinates.map(([row, col]) => row * next.columns + col) }];
  });
  return { layout: placements.length ? { rows: next.rows, columns: next.columns, placements } : null, released };
}

export function configDestination(records, source) {
  const id = source.configId ?? source.id;
  const index = records.findIndex(({ level }) => {
    const saved = level.sourceConfig;
    return saved && (!saved.listId || saved.listId === source.listId) &&
      ((saved.configId ?? saved.id) === id || (saved.listId === source.listId && source.levelId && saved.levelId === source.levelId));
  });
  if (index >= 0) return { index, existing: records[index] };
  const next = records.findIndex(({ level }) => level.sourceConfig?.listId === source.listId && level.sourceConfig.position > source.position);
  return { index: next < 0 ? records.length : next, existing: null };
}

// Project only saved levels and jobs that are actually queued. Missing config
// rows are not placeholder levels and cannot increase a duplicate distance.
export function reserveFutureTargets(records, source, configs, plannedConfigs = []) {
  const projected = [...records];
  const destination = value => source.listId ? configDestination(projected, value) : {
    index: Math.min(value.position - 1, projected.length),
    existing: projected[value.position - 1] ?? null,
  };
  const current = { level: { sourceConfig: source } };
  const insert = (record, value) => {
    const { index, existing } = destination(value);
    projected.splice(index, existing ? 1 : 0, record);
  };
  insert(current, source);
  for (const job of plannedConfigs) {
    if (job.id === (source.configId ?? source.id) || (job.listId && job.listId !== source.listId)) continue;
    const value = { listId: source.listId, id: job.id, configId: job.id, position: job.position, levelId: job.levelId };
    insert({ level: { sourceConfig: value } }, value);
  }
  return futureFixedTargetWords(configs, source.position, [], (record, position) => {
    if (record.id === (source.configId ?? source.id) || (record.listId && record.listId !== source.listId)) return 0;
    const value = { listId: source.listId, id: record.id, configId: record.id, position, levelId: record.levelId };
    return destination(value).index - projected.indexOf(current);
  });
}

export function prepareGeneration(records, activeId, config, source = null, configs = [], plannedConfigs = []) {
  if (config.generationRules) {
    const position = config.generationRules.position;
    if (source && source.position !== position) throw new Error('当前规则的配置关号与生成位置不一致。');
    const indexed = records.map((record,index)=>({...record,level:{...record.level,sourceConfig:{...record.level.sourceConfig,
      position:record.level.generationRules?.position ?? record.level.sourceConfig?.position ?? index+1}}}));
    const preceding = indexed.filter(record=>record.level.sourceConfig.position>=position-10&&record.level.sourceConfig.position<position);
    const duplicateCheck = createDuplicateCheck(preceding,{target:10,extra:0},position);
    const future = indexed.filter(record=>record.level.sourceConfig.position>position&&record.level.sourceConfig.position<=position+10)
      .flatMap(record=>(record.level.targetWords??[]).map(entry=>entry.word));
    // A range can start in the middle of the list. Leave its earlier, ungenerated neighbors their core words too.
    const nearbyFixed = futureFixedTargetWords(configs, position, [], (record, fallbackPosition) =>
      Math.abs((record.config.generationRules?.position ?? fallbackPosition) - position));
    const reservedTargetWords = [...new Set([...(config.reservedTargetWords??[]),...future,...nearbyFixed])];
    const excludedBoards = indexed.filter(record=>record.level.sourceConfig.position!==position).flatMap(({level})=>{
      if (!level.cells?.length) return [];
      return [Array.from({length:level.rows},(_,row)=>level.cells.slice(row*level.columns,(row+1)*level.columns).map(cell=>cell.letter||'-').join('')).join(',')];
    });
    return {config:{...config,minimumWordLength:3,reservedTargetWords,excludedBoards},duplicateCheck};
  }
  const context = source ? configDestination(records, source) : null;
  const { position, history } = context
    ? { position: source.position, history: records.slice(0, context.index) }
    : generationContext(records, activeId);
  const duplicateCheck = createDuplicateCheck(history, { target: config.targetDuplicateRange, extra: config.extraDuplicateRange });
  const reservedTargetWords = source ? reserveFutureTargets(records, source, configs, plannedConfigs)
    .filter(word => !(config.fixedWords ?? []).includes(word)) : [];
  return { config: { ...config, reservedTargetWords, minimumWordLength: Math.max(position === 1 ? 2 : 3, config.minimumWordLength ?? 2) }, duplicateCheck };
}

export function resolveConfigSource(source, lists) {
  if (!source) return null;
  const matches = lists.flatMap(list => {
    if (source.listId && list.id !== source.listId) return [];
    const index = list.records.findIndex(record => record.id === (source.configId ?? source.id) ||
      (source.listId === list.id && source.levelId && record.levelId === source.levelId));
    return index < 0 ? [] : [{ list, index }];
  });
  if (matches.length !== 1) return null;
  const { list, index } = matches[0], record = list.records[index];
  return { source: { ...source, listId: list.id, id: record.id, configId: record.id, position: index + 1 },
    records: list.records.map((record, index) => ({ ...record, position: index + 1 })) };
}
