import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateLevelPlan} from './lib/level-plan.mjs';

const root=new URL('../../',import.meta.url);
const configFile='level-editor/dist/data/target-floor-500-budget-consistency.json';
const bytes=fs.readFileSync(new URL(configFile,root));
const config=JSON.parse(bytes);
const baseBytes=fs.readFileSync(new URL(config.sourcePlanFile,root));
const sha=value=>createHash('sha256').update(value).digest('hex');
assert.equal(sha(baseBytes),config.sourcePlanSha256,'基础规划已变化，需要重新验证阶段配额');
const plan=JSON.parse(baseBytes);
plan.revisionOf=plan.id;
plan.id+='-r2';
for(const change of config.adjustments){
  const stage=plan.stageBudgets.find(b=>b.from===change.from&&b.to===change.to);
  assert.ok(stage&&stage.from>320,'已验收的前320关不得修改');
  assert.deepEqual(stage.ranges[change.metric],change.previousRange);
  stage.ranges[change.metric]=[...change.range];
}
plan.consistencyAdjustments=config.adjustments;
plan.consistencySources={[config.sourcePlanFile]:config.sourcePlanSha256,[configFile]:sha(bytes)};
validateLevelPlan(plan);
const file='level-editor/dist/data/level-plan-target-floor-first-500-r2.json';
fs.writeFileSync(new URL(file,root),JSON.stringify(plan,null,2)+'\n');
console.log(JSON.stringify({file,id:plan.id,adjustments:config.adjustments}));
