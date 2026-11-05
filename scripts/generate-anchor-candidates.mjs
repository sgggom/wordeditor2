import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createGenerator } from '../dist/level-generator.js';
import { validateCurrentRuleConfigs, validateGenerationPolicy } from '../dist/generation-policy.js';
import { fixedLayoutLetters, normalizeFixedLayout, validateFixedWords } from '../dist/fixed-words.js';
import { prepareGeneration } from '../dist/level-rules.js';
import { createGameExport } from '../dist/level-export.js';
import { importSingleGameLevel, importGameLevels } from '../dist/level-import.js';
import { analyzeTargetPaths } from '../dist/target-path-analysis.js';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dataDirectory = new URL('../dist/data/', import.meta.url);
const usage = 'node scripts/generate-anchor-candidates.mjs pool PLAN.json OUTPUT_DIR\nnode scripts/generate-anchor-candidates.mjs pick PLAN.json OUTPUT_DIR PICKS.json';

export function writeJSON(file, value, exclusive = false) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    if (exclusive) fs.linkSync(temporary, file);
    else fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function writeWordOptions(directory, pools) {
  const lines = pools.flatMap(pool => {
    const core = new Set(pool.summary.coreWords);
    const heading = '第' + pool.summary.position + '关　核心词 ' + [...core].join(' / ')
      + '　' + pool.candidates.length + '张棋盘，' + pool.summary.distinctTargetSets + '组选词';
    const groups = new Map();
    for (const candidate of pool.candidates) {
      if (!groups.has(candidate.game.t)) {
        const additions = candidate.paths.map(([word]) => word).filter(word => !core.has(word));
        groups.set(candidate.game.t, { additions, numbers: [] });
      }
      groups.get(candidate.game.t).numbers.push(String(candidate.number).padStart(3, '0'));
    }
    const options = [...groups.values()].map(group => group.numbers.join('/') + '　' + group.additions.join(' / '));
    return [heading, ...options, ''];
  });
  fs.writeFileSync(path.join(directory, 'word-options.txt'), lines.join('\n'));
}

export function prepareJob(task, context, history) {
  const config = structuredClone(context.preset.records[task.position - 1].config);
  const pins = new Map((config.fixedLayout?.placements ?? []).map(pin => [pin.word, pin]));
  assert.ok(Array.isArray(task.placements), '核心词需要给出固定路径');
  for (const pin of task.placements) {
    assert.match(pin.word, /^[A-Z]{3,}$/);
    if (pins.has(pin.word)) assert.deepEqual(pins.get(pin.word).path, pin.path, '同一个核心词有两条指定路径');
    pins.set(pin.word, pin);
  }
  assert.ok(pins.size, '至少指定一个核心词及路径');
  config.fixedWords = [...new Set([...config.fixedWords, ...pins.keys()])];
  config.fixedLayout = { rows: config.rows, columns: config.columns, placements: [...pins.values()] };
  config.fixedWords = validateFixedWords(config);
  config.fixedLayout = normalizeFixedLayout(config);
  assert.ok(config.fixedWords.length <= config.desiredTargetCount, '固定词数量超过本关配置');
  // Return each valid candidate to the reviewer instead of hiding the alternatives behind a single best score.
  config.generationRules.candidateSamples = 1;
  const nearbyAnchors = context.plan.levels
    .filter(other => other.position !== task.position && Math.abs(other.position - task.position) <= 10)
    .flatMap(other => other.placements.map(pin => pin.word));
  const nearbyPresetWords = context.preset.records.slice(Math.max(0, task.position - 11), task.position + 10)
    .filter(record => record.position !== task.position).flatMap(record => record.config.fixedWords);
  config.reservedTargetWords = [...new Set([...nearbyAnchors, ...nearbyPresetWords])];
  validateGenerationPolicy(config);
  const prepared = prepareGeneration(history, null, config, null, context.preset.records);
  const forbiddenWords = new Set([...prepared.duplicateCheck.target.words, ...prepared.config.reservedTargetWords]);
  for (const word of config.fixedWords) {
    assert.ok(context.bank.has(word) && context.bank.get(word) <= 4, '核心词超出当前目标词库：' + word);
    assert.ok(!forbiddenWords.has(word), '相邻关卡已使用或预留核心词：' + word);
  }
  const filled = fixedLayoutLetters(config.rows, config.columns, config.fixedLayout.placements).filter(Boolean).length;
  const known = new Set(history.map(record => record.level.sourceConfig.position));
  const missingPreceding = Array.from({ length: Math.min(task.position - 1, 10) }, (_, i) => task.position - i - 1)
    .filter(position => !known.has(position));
  return { ...prepared, forbiddenWords, missingPreceding, freeCells: config.rows * config.columns - config.disabledCells.length - filled };
}

export function verifyCandidate(level, game, job, context) {
  const targetNames = new Set(level.targetWords.map(entry => entry.word));
  for (const word of job.config.fixedWords) assert.ok(targetNames.has(word), '缺少指定目标词：' + word);
  const excluded = new Set(job.config.excludedBoards);
  assert.ok(!excluded.has(game.g), '棋盘与其他已保存位置重复');
  assert.deepEqual(game.g.split(',').map(row => [...row].map(c => c === '-' ? '0' : '1').join('')), job.config.generationRules.boardMask);
  for (const pin of job.config.fixedLayout?.placements ?? []) {
    const target = level.targetWords.find(entry => entry.word === pin.word);
    assert.deepEqual(target?.path, pin.path, '核心词路径发生变化：' + pin.word);
  }
  for (const word of targetNames) {
    assert.ok(context.bank.has(word) && context.bank.get(word) <= 4 && word.length >= 3, '目标词不合规：' + word);
    assert.ok(!targetNames.has(word + 'S') && !job.forbiddenWords.has(word), '目标词冲突：' + word);
  }
  const found = context.generator.findWords({
    rows: level.rows, columns: level.columns, disabledCells: level.disabledCells,
    letters: level.cells.map(cell => cell.letter), minimumWordLength: 3,
  });
  const expectedExtras = found.filter(entry => !targetNames.has(entry.word)).map(entry => entry.word).sort();
  assert.equal(game.e, expectedExtras.join(' '), '额外词不完整');
  const roundTrip = createGameExport([{ level }]).books[0].levels[0];
  for (const key of ['g', 't', 'n', 'e']) assert.equal(roundTrip[key], game[key]);
  assert.equal(level.cells.map(cell => cell.count.toString(36)).join(''), game.n);
  const safety = analyzeTargetPaths(level);
  assert.ok(safety.solvable && safety.allChoicesComplete, '存在不能完成的合法消词选择');
}

function generatePool(task, job, context) {
  const random = seededRandom(context.seed + task.position);
  const seen = new Set(job.config.excludedBoards);
  const candidates = [];
  const limit = Math.min(context.count, 26 ** job.freeCells);
  const started = performance.now();
  let stalls = 0;
  let attempts = 0;
  while (candidates.length < limit && stalls < 3 && performance.now() - started < context.timeLimitMs) {
    try {
      const level = context.generator.generate({ ...job.config, excludedBoards: [...seen], duplicateCheck: job.duplicateCheck, random });
      const game = createGameExport([{ level }]).books[0].levels[0];
      game.id = String(task.position);
      game.name = '第' + task.position + '关';
      assert.ok(!seen.has(game.g), '重复候选棋盘');
      verifyCandidate(level, game, job, context);
      seen.add(game.g);
      attempts += level.generationQuality.attemptsEvaluated;
      candidates.push({
        id: hash([task.position, game.g, game.t, game.n]).slice(0, 16), number: candidates.length + 1,
        game, paths: level.targetWords.map(entry => [entry.word, entry.path]), quality: level.generationQuality,
      });
      stalls = 0;
    } catch (error) {
      if (error.code !== 'GENERATION_RETRY') throw error;
      attempts += error.attempts;
      stalls++;
    }
  }
  let stopReason = 'requested-count';
  if (candidates.length < context.count) {
    if (candidates.length === limit) stopReason = 'free-cell-capacity';
    else stopReason = stalls >= 3 ? 'search-limit' : 'time-limit';
  }
  const ranked = [...candidates].sort((a, b) => a.quality.score - b.quality.score);
  const wordSets = new Set();
  const shortlist = [];
  for (const candidate of ranked) {
    if (!wordSets.has(candidate.game.t) && shortlist.length < 8) shortlist.push(candidate.id);
    wordSets.add(candidate.game.t);
  }
  const summary = {
    position: task.position, coreWords: job.config.fixedWords, freeCells: job.freeCells,
    requested: context.count, validatedDistinctBoards: candidates.length, distinctTargetSets: wordSets.size,
    exactTargetCount: candidates.filter(c => c.quality.targetCountDifference === 0).length,
    attempts, elapsedMs: Math.round(performance.now() - started), stopReason, missingPreceding: job.missingPreceding,
  };
  return { summary, anchors: job.config.fixedLayout.placements, intent: task.intent, shortlist, candidates };
}

function selectCandidates(pools, picks, context) {
  assert.ok(Array.isArray(picks) && picks.length === pools.length, '每个任务关都需明确选择一份候选');
  assert.equal(new Set(picks.map(p => p.position)).size, picks.length, '同一关有多个选择');
  const history = new Map(context.history.map(record => [record.level.sourceConfig.position, record]));
  const chosen = pools.map(pool => {
    const position = pool.summary.position;
    const pick = picks.find(item => item.position === position);
    const candidate = pool.candidates.find(item => item.id === pick?.id);
    assert.ok(candidate && typeof pick.reason === 'string' && pick.reason.trim(), '缺少有效候选或选用理由：' + position);
    const level = importSingleGameLevel(JSON.stringify(candidate.game), context.dictionary);
    const paths = new Map(candidate.paths);
    for (const target of level.targetWords) target.path = paths.get(target.word);
    level.sourceConfig = { position };
    history.set(position, { id: position, level });
    return { pool, candidate, level, reason: pick.reason };
  });
  // Two independently good candidates can contain the same new word. Check the final choices together.
  const finalHistory = [...history.values()];
  const decisions = chosen.map(({ pool, candidate, level, reason }) => {
    const position = pool.summary.position;
    const task = context.plan.levels.find(entry => entry.position === position);
    const job = prepareJob(task, context, finalHistory);
    verifyCandidate(level, candidate.game, job, context);
    const ranked = [...pool.candidates].sort((a, b) => a.quality.score - b.quality.score);
    return { position, id: candidate.id, number: candidate.number, programRank: ranked.findIndex(c => c.id === candidate.id) + 1,
      poolCount: pool.candidates.length, reason, anchors: pool.anchors, paths: candidate.paths,
      missingPreceding: job.missingPreceding, quality: candidate.quality };
  });
  const game = createGameExport(chosen.map(choice => ({ level: choice.level })));
  game.books[0].name = '核心词试拼';
  game.books[0].levels.forEach((entry, i) => { entry.id = String(decisions[i].position); });
  return { ...game, sourcePreset: context.preset.id, poolSeed: context.seed, decisions };
}

export function createPoolContext(planFile, sourceDirectory = dataDirectory) {
  const data = file => read(new URL(file, sourceDirectory));
  const plan = read(planFile);
  const preset = data('current-rule-configs.json');
  validateCurrentRuleConfigs(preset.records, { complete: true });
  assert.equal(plan.presetId, preset.id, '核心词任务与当前配置预设不一致');
  assert.ok(Array.isArray(plan.levels) && plan.levels.length && plan.levels.every(task => Number.isInteger(task.position) && task.position >= 1 && task.position <= 2000), '任务关号无效');
  assert.equal(new Set(plan.levels.map(task => task.position)).size, plan.levels.length, '任务关号重复');
  const ordinary = [...data('required-words.json'), ...data('guide-words.json')];
  const extra = data('extra-words.json');
  const dictionary = [...ordinary, ...extra.map(entry => ({ ...entry, onlyExtra: true }))];
  const bank = new Map(data('candidate-words.json').words);
  const history = [];
  let historyGame = null;
  if (plan.history) {
    historyGame = read(path.resolve(path.dirname(planFile), plan.history));
    const source = [...historyGame.books.flatMap(book => book.levels), ...historyGame.daily];
    const levels = importGameLevels(historyGame, dictionary);
    for (const [i, level] of levels.entries()) {
      const position = Number(source[i].id);
      assert.ok(Number.isSafeInteger(position) && position > 0, '历史关号无效');
      level.sourceConfig = { position };
      history.push({ id: position, level });
    }
    assert.equal(new Set(history.map(record => record.id)).size, history.length, '历史中关号重复');
  }
  const count = plan.count ?? 100;
  const seed = plan.seed ?? 20261105;
  const timeLimitMs = plan.timeLimitMs ?? 60000;
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 100, '每关候选数需为1～100');
  assert.ok(Number.isSafeInteger(seed) && Number.isFinite(timeLimitMs) && timeLimitMs > 0, '种子或时间上限无效');
  const generator = createGenerator(ordinary, extra, { targetWordWhitelist: [...bank.keys()] });
  const context = { plan, preset, generator, dictionary, bank, history, count, seed, timeLimitMs };
  const key = hash([plan, historyGame, plan.levels.map(task => preset.records[task.position - 1]), [...bank], dictionary.map(r => [r.word, r.rarityLevel, r.onlyExtra])]);
  return { context, key };
}

function main() {
  const [command, planFile, outputDirectory, picksFile] = process.argv.slice(2);
  if (command === '--help') { console.log(usage); return; }
  assert.ok(['pool', 'pick'].includes(command) && planFile && outputDirectory, usage);
  const { context, key } = createPoolContext(planFile);
  const { plan, preset, history, seed } = context;
  const poolFile = path.join(outputDirectory, 'pool.json');
  fs.mkdirSync(outputDirectory, { recursive: true });
  if (command === 'pool' && !fs.existsSync(poolFile)) {
    const jobs = plan.levels.map(task => prepareJob(task, context, history));
    const pools = plan.levels.map((task, i) => {
      const pool = generatePool(task, jobs[i], context);
      console.log(JSON.stringify(pool.summary));
      return pool;
    });
    writeJSON(poolFile, { key, presetId: preset.id, seed, pools }, true);
    writeWordOptions(outputDirectory, pools);
    return;
  }
  const stored = read(poolFile);
  assert.equal(stored.key, key, '候选池输入已变化，请使用新输出目录');
  if (command === 'pool') {
    writeWordOptions(outputDirectory, stored.pools);
    console.log(JSON.stringify(stored.pools.map(pool => pool.summary)));
    return;
  }
  assert.ok(picksFile, usage);
  const game = selectCandidates(stored.pools, read(picksFile), context);
  const output = path.join(outputDirectory, 'selected-game.json');
  writeJSON(output, game);
  console.log(JSON.stringify({ selected: game.decisions.map(({ position, number }) => ({ position, number })), output }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
