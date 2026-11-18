import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { alignConstraintWordLengths } from '../dist/target-length-alignment.js';

const root = new URL('../../', import.meta.url);
const args = process.argv.slice(2);
const destination = args[0] ? path.resolve(args[0]) : fileURLToPath(new URL('outputs/20261112-reference-length-aligned/', root));
assert.ok(args.length <= 1, '只接受一个输出目录');
const sourcePath = 'outputs/20261111-level-constraints/constraints.json';
const bytes = fs.readFileSync(new URL(sourcePath, root));
const original = JSON.parse(bytes);
const plan = alignConstraintWordLengths(original);
plan.sources[sourcePath] = { sha256: createHash('sha256').update(bytes).digest('hex'), purpose: '原有约束；仅补充逐关词长匹配规则' };
for (const record of plan.records) {
  const before = original.records[record.position - 1];
  if (record.mode === 'manual') assert.deepEqual(record, before);
  else {
    const copy = structuredClone(record);
    delete copy.hard.targetWordLength;
    assert.deepEqual(copy, before);
    assert.ok(record.hard.board.options.every(shape => shape.activeCells <= record.hard.targetCount.maximum * record.hard.targetWordLength.maximum));
  }
}
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, 'constraints.json'), JSON.stringify(plan, null, 2) + '\n');
const lines = ['逐关词长对齐参考 · 2026-11-12',
  '前5关保留人工安排。第6～2000关沿用原尺寸、词数、档位、生僻上限、额外词、冷却与阶段硬规则。',
  '新增硬要求：目标词至少3字母，最长不超过本关参考最长词；词长总偏差最多2字母。',
  '筛选顺序：精确配额 → 总偏差≤1 → 总偏差≤2；优先比较词长偏差，再比较原排序分数。',
  '总偏差：实际词长与参考词长分别排序后，逐项绝对差之和。',
  '目标词数发生已允许的偏差时，参考各词长数量按比例采用最大余数法分配；余数相同优先短词。',
  '本文件是生成要求，不表示已将旧1000关全部重排。', '',
  ...plan.records.map(record => record.mode === 'manual' ? `${record.position} | 人工保留` :
    `${record.position} | 参考${record.reference.position} | 参考词长 ${record.preferences.targetWordLengths.join('、')} | 最长≤${record.hard.targetWordLength.maximum} | 总偏差≤${record.hard.targetWordLength.maximumLetterDistance}`)];
fs.writeFileSync(path.join(destination, 'constraints.txt'), lines.join('\n') + '\n');
console.log(JSON.stringify({ destination, automatic: plan.scope.automaticPositions, manual: plan.scope.excludedPositions, policy: plan.wordLengthPolicy }));
