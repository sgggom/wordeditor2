import fs from 'node:fs';import assert from 'node:assert/strict';import{createHash}from'node:crypto';
import{validateLevelPlan}from'./lib/level-plan.mjs';
const root=new URL('../../',import.meta.url),configFile='level-editor/dist/data/target-floor-1000-budget-consistency.json';
const sha=b=>createHash('sha256').update(b).digest('hex'),read=f=>JSON.parse(fs.readFileSync(new URL(f,root)));
const configBytes=fs.readFileSync(new URL(configFile,root)),config=JSON.parse(configBytes),baseBytes=fs.readFileSync(new URL(config.sourcePlanFile,root));
assert.equal(sha(baseBytes),config.sourcePlanSha256);
const plan=JSON.parse(baseBytes),records=structuredClone(plan.records),prefixBudgets=structuredClone(plan.stageBudgets.filter(b=>b.to<=500));
plan.revisionOf=plan.id;plan.id+='-r2';
for(const change of config.adjustments){
  assert.ok(change.from>500);
  const stage=plan.stageBudgets.find(b=>b.from===change.from&&b.to===change.to);assert.ok(stage);
  assert.deepEqual(stage.ranges[change.metric],change.previousRange);
  stage.ranges[change.metric]=[...change.range];
}
assert.deepEqual(plan.records,records);assert.deepEqual(plan.stageBudgets.filter(b=>b.to<=500),prefixBudgets);
plan.consistencyAdjustments=[...(plan.consistencyAdjustments??[]),...config.adjustments];
plan.consistencySources={...(plan.consistencySources??{}),[config.sourcePlanFile]:config.sourcePlanSha256,[configFile]:sha(configBytes)};
validateLevelPlan(plan);
const file='level-editor/dist/data/level-plan-target-floor-first-1000-r2.json';
fs.writeFileSync(new URL(file,root),JSON.stringify(plan,null,2)+'\n');
console.log(JSON.stringify({file,id:plan.id,adjustments:config.adjustments}));
