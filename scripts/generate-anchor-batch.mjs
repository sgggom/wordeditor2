import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createPoolContext, prepareJob, verifyCandidate, writeJSON } from './generate-anchor-candidates.mjs';
import { createGameExport } from '../dist/level-export.js';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const poolName = position => String(position).padStart(4, '0') + '.json';

function generate(task, context, key, directory, budgetMs) {
  const file = path.join(directory, 'pools', poolName(task.position));
  const prior = fs.existsSync(file) ? read(file) : null;
  if (prior) assert.equal(prior.key, key, '候选池的输入与本次任务不同');
  const job = prepareJob(task, context, context.history);
  const opening = task.position === 1;
  const requested = context.count;
  const required = opening ? 1 : requested;
  const candidates = prior?.candidates ?? [];
  const seen = new Set(candidates.map(candidate => candidate.game.g));
  assert.equal(seen.size, candidates.length, '已存候选含重复棋盘');
  assert.ok(candidates.length <= required, '候选数量超过要求');
  if (candidates.length === required) return prior.summary;

  const started = performance.now();
  const pass = (prior?.summary.passes ?? 0) + 1;
  let state = prior?.randomState ?? (context.seed + task.position) >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  let relocated = prior?.relocated ?? false;
  let attempts = prior?.summary.attempts ?? 0;
  let stalls = 0;
  const initialCount = candidates.length;
  const flexible = { ...job, config: { ...job.config, fixedLayout: null } };
  const excluded = new Set(job.config.excludedBoards);

  const save = stopReason => {
    const summary = {
      position: task.position, coreWords: job.config.fixedWords, requested, required,
      validatedDistinctBoards: candidates.length,
      distinctTargetSets: new Set(candidates.map(candidate => candidate.game.t)).size,
      exactTargetCount: candidates.filter(candidate => candidate.quality.targetCountDifference === 0).length,
      suggestedPlacementCount: candidates.filter(candidate => candidate.placementMode === 'suggested').length,
      attempts, passes: pass, elapsedMs: (prior?.summary.elapsedMs ?? 0) + Math.round(performance.now() - started),
      stopReason, complete: candidates.length === required,
    };
    writeJSON(file, {
      key, presetId: context.preset.id, seed: context.seed, randomState: state, relocated,
      summary, anchors: task.placements, candidates,
    });
    return summary;
  };

  while (candidates.length < required && performance.now() - started < budgetMs) {
    // Try the proposed placement first, then vary only the core positions inside the same mask.
    if (!opening && performance.now() - started >= 750) relocated = true;
    const current = relocated && !opening ? flexible : job;
    try {
      const level = context.generator.generate({
        ...current.config, excludedBoards: [...excluded, ...seen], duplicateCheck: job.duplicateCheck, random,
      });
      const game = createGameExport([{ level }]).books[0].levels[0];
      game.id = String(task.position);
      game.name = '第' + task.position + '关';
      assert.ok(!seen.has(game.g), '本关出现重复候选棋盘');
      verifyCandidate(level, game, current, context);
      seen.add(game.g);
      attempts += level.generationQuality.attemptsEvaluated;
      candidates.push({
        id: hash([task.position, game.g, game.t, game.n]).slice(0, 16),
        number: candidates.length + 1,
        placementMode: current === job ? 'suggested' : 'varied',
        game, paths: level.targetWords.map(entry => [entry.word, entry.path]), quality: level.generationQuality,
      });
      stalls = 0;
      if ((candidates.length - initialCount) % 25 === 0) save('generating');
    } catch (error) {
      if (error.code !== 'GENERATION_RETRY') {
        save('error');
        throw error;
      }
      attempts += error.attempts;
      stalls++;
      if (!opening) relocated = true;
      if (stalls >= 8) break;
    }
  }
  return save(candidates.length === required ? (opening ? 'fixed-opening' : 'requested-count') : 'retry-needed');
}

function workerMain() {
  const { directory, budgetMs } = workerData;
  const input = path.join(directory, 'inputs');
  const { context, key } = createPoolContext(path.join(input, 'plan.json'), pathToFileURL(input + path.sep));
  parentPort.on('message', position => {
    try {
      const task = context.plan.levels.find(level => level.position === position);
      const summary = generate(task, context, key, directory, budgetMs);
      parentPort.postMessage({ summary });
    } catch (error) {
      parentPort.postMessage({ position, error: error.stack });
    }
  });
  parentPort.postMessage({ ready: true });
}

function snapshotInputs(planFile, directory) {
  const input = path.join(directory, 'inputs');
  if (fs.existsSync(input)) return input;
  const temporary = input + '.tmp';
  fs.mkdirSync(temporary, { recursive: true });
  const source = new URL('../dist/data/', import.meta.url);
  for (const name of ['current-rule-configs.json', 'candidate-words.json', 'required-words.json', 'guide-words.json', 'extra-words.json']) {
    fs.copyFileSync(new URL(name, source), path.join(temporary, name));
  }
  const plan = read(planFile);
  if (plan.history) {
    fs.copyFileSync(path.resolve(path.dirname(planFile), plan.history), path.join(temporary, 'history.json'));
    plan.history = 'history.json';
  }
  writeJSON(path.join(temporary, 'plan.json'), plan);
  fs.renameSync(temporary, input);
  return input;
}

async function main() {
  const [planFile, outputDirectory, workerArgument = '6', fromArgument = '1', toArgument = '2000', budgetArgument = '12000'] = process.argv.slice(2);
  if (!planFile || planFile === '--help') {
    console.log('node scripts/generate-anchor-batch.mjs PLAN.json OUTPUT_DIR [WORKERS] [FROM] [TO] [BUDGET_MS_PER_LEVEL]');
    return;
  }
  assert.ok(outputDirectory, '缺少输出目录');
  const workerCount = Number(workerArgument), from = Number(fromArgument), to = Number(toArgument), budgetMs = Number(budgetArgument);
  assert.ok(Number.isInteger(workerCount) && workerCount >= 1 && workerCount <= os.availableParallelism());
  assert.ok(Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to <= 2000 && from <= to);
  assert.ok(Number.isFinite(budgetMs) && budgetMs >= 1000);
  const directory = path.resolve(outputDirectory);
  fs.mkdirSync(path.join(directory, 'pools'), { recursive: true });
  const lockFile = path.join(directory, 'running.json');
  if (fs.existsSync(lockFile)) {
    const lock = read(lockFile);
    let alive = true;
    try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    assert.ok(!alive, '此输出目录已有批处理在运行');
    fs.unlinkSync(lockFile);
  }
  writeJSON(lockFile, { pid: process.pid, startedAt: new Date().toISOString() }, true);
  const workers = new Set();
  let interval;
  try {
    const input = snapshotInputs(path.resolve(planFile), directory);
    assert.equal(hash(read(planFile)), hash({ ...read(path.join(input, 'plan.json')), ...(read(planFile).history ? { history: read(planFile).history } : {}) }), '续跑计划与已保存计划不同');
    const { context, key } = createPoolContext(path.join(input, 'plan.json'), pathToFileURL(input + path.sep));
    const sourceDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
    const codeFiles = [...fs.readdirSync(sourceDirectory).filter(name => name.endsWith('.js')).map(name => path.join(sourceDirectory, name)),
      fileURLToPath(import.meta.url), fileURLToPath(new URL('./generate-anchor-candidates.mjs', import.meta.url))];
    const codeHash = hash(codeFiles.sort().map(file => [path.basename(file), fs.readFileSync(file, 'utf8')]));
    const runFile = path.join(directory, 'run.json');
    if (fs.existsSync(runFile)) {
      const run = read(runFile);
      assert.equal(run.key, key, '输入快照已变更');
      assert.equal(run.codeHash, codeHash, '生成器版本已变化，请使用新的输出目录');
    } else {
      writeJSON(runFile, { key, codeHash, createdAt: new Date().toISOString(), sourcePlan: path.resolve(planFile),
        levels: context.plan.levels.length, candidatesPerLevel: context.count, placementPolicy: 'suggested-then-varied',
        exceptions: [{ position: 1, required: 1, reason: 'CAT/ALL T型全盘固定' }], stage: 'generate-only' }, true);
    }
    const summaries = new Map();
    for (const task of context.plan.levels) {
      const file = path.join(directory, 'pools', poolName(task.position));
      if (fs.existsSync(file)) {
        const pool = read(file);
        assert.equal(pool.key, key, '已存候选的输入不一致');
        assert.equal(pool.summary.validatedDistinctBoards, pool.candidates.length);
        assert.equal(new Set(pool.candidates.map(candidate => candidate.game.g)).size, pool.candidates.length);
        summaries.set(task.position, pool.summary);
      }
    }
    const pending = context.plan.levels.filter(task => task.position >= from && task.position <= to && !summaries.get(task.position)?.complete);
    const errors = [];
    const active = new Set();
    const startedAt = new Date().toISOString();
    const saveProgress = phase => {
      const values = [...summaries.values()].sort((a, b) => a.position - b.position);
      const incomplete = context.plan.levels.filter(task => !summaries.get(task.position)?.complete).map(task => task.position);
      const progress = { phase, startedAt, updatedAt: new Date().toISOString(), levels: context.plan.levels.length,
        completedLevels: values.filter(summary => summary.complete).length,
        candidates: values.reduce((sum, summary) => sum + summary.validatedDistinctBoards, 0),
        activePositions: [...active], pendingPositions: incomplete, errors, summaries: values };
      writeJSON(path.join(directory, 'progress.json'), progress);
      return progress;
    };
    interval = setInterval(() => {
      const p = saveProgress('generating');
      console.log(JSON.stringify({ completedLevels: p.completedLevels, candidates: p.candidates, active: p.activePositions }));
    }, 20000);
    saveProgress('generating');
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(workerCount, pending.length) }, () => new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { directory, budgetMs } });
      workers.add(worker);
      let currentPosition = null;
      const next = () => {
        const task = pending[cursor++];
        if (!task) { worker.terminate().then(resolve, reject); return; }
        currentPosition = task.position;
        active.add(task.position);
        worker.postMessage(task.position);
      };
      worker.on('error', reject);
      worker.on('message', message => {
        if (message.ready) { next(); return; }
        active.delete(currentPosition);
        if (message.error) errors.push(message);
        else summaries.set(message.summary.position, message.summary);
        saveProgress('generating');
        next();
      });
      worker.on('exit', code => {
        workers.delete(worker);
        if (currentPosition !== null && active.has(currentPosition)) reject(new Error('生成进程提前退出 ' + currentPosition + ', code ' + code));
      });
    })));
    const report = saveProgress('finished-pass');
    report.phase = report.pendingPositions.length ? 'awaiting-retry' : 'generation-complete';
    writeJSON(path.join(directory, 'progress.json'), report);
    console.log(JSON.stringify({ phase: report.phase, completedLevels: report.completedLevels, candidates: report.candidates, pending: report.pendingPositions, errors }));
    if (errors.length) process.exitCode = 1;
  } finally {
    clearInterval(interval);
    await Promise.allSettled([...workers].map(worker => worker.terminate()));
    fs.rmSync(lockFile, { force: true });
  }
}

if (isMainThread) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
else workerMain();
