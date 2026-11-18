import json
import math
import argparse
import hashlib
from collections import Counter
from itertools import product
from pathlib import Path

import numpy as np
from scipy.optimize import milp, Bounds, LinearConstraint, linear_sum_assignment
from scipy.sparse import coo_matrix

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'outputs/20261112-stage-budget-first-50'
data=json.loads((OUT/'input.json').read_text())
parser=argparse.ArgumentParser()
parser.add_argument('--reuse-prefix-plan')
args=parser.parse_args()
prefix_file=ROOT/args.reuse_prefix_plan if args.reuse_prefix_plan else None
prefix_plan=json.loads(prefix_file.read_text()) if prefix_file else None
base=data['plan']
rows=[row for row in base['records'] if row['position']<=50]
lengths=list(range(3,9))


def apportion(counts,total):
    values=np.array(counts,dtype=float)*total/sum(counts)
    result=np.floor(values).astype(int)
    for index in sorted(range(len(counts)),key=lambda index:(-(values[index]%1),index))[:total-int(result.sum())]:result[index]+=1
    return result.tolist()


def vector_of(words):
    return [sum(word['length']==length for word in words) for length in lengths]


def metrics(vector):
    result={f'length:{length}':count for length,count in zip(lengths,vector)}
    result.update({f'hist:3:{vector[0]}':1,f'hist:4:{vector[1]}':1,f'hist:5:{vector[2]}':1,
                   f'hist:6+:{sum(vector[3:])}':1,f'variety:{sum(count>0 for count in vector)}':1})
    return result


def score_feasible(row,vector):
    path_costs=data['pathCosts'][','.join(row['boardMask'])]
    slots=[length for length,count in zip(lengths,vector) for _ in range(count)]
    bands=[band for band,count in enumerate(row['scoreCounts']) for _ in range(count)]
    low=np.full((len(slots),len(slots)),1e6);high=np.full_like(low,-1e6)
    for i,length in enumerate(slots):
        available=[cost+rarity*(1+length*.1) for cost in path_costs[str(length)] for rarity in range(1,5)]
        for j,band in enumerate(bands):
            values=[score for score in available if min(3,int(round(score,6)//3))==band and score<=12]
            if values:low[i,j]=min(values);high[i,j]=max(values)
    rr,cc=linear_sum_assignment(low)
    if np.max(low[rr,cc])>=1e6:return False
    if low[rr,cc].sum()>row['scoreMaximum']+1e-6:return False
    rr,cc=linear_sum_assignment(-high)
    return high[rr,cc].sum()>=row['scoreMinimum']-1e-6


budgets=[]
for start,end in [(6,20),(21,30),(31,50)]:
    selected=[row for row in rows if start<=row['position']<=end]
    if prefix_plan and end<=30:
        old_rows={row['position']:row for row in prefix_plan['records']}
        for row in selected:
            previous=old_rows[row['position']]
            for key,value in row.items():
                if key!='targetComposition':assert previous[key]==value
            row['targetComposition']=previous['targetComposition']
        budget=next(b for b in prefix_plan['stageBudgets'] if b['from']==start and b['to']==end)
        budgets.append(budget)
        print(json.dumps({'stage':[start,end],'reusedValidatedConfiguration':True},ensure_ascii=False),flush=True)
        continue
    peers=[row for row in data['reference'] if start<=row['position']<=end]
    total=sum(row['targetCount'] for row in selected)
    raw_counts=[sum(vector_of(peer['words'])[i] for peer in peers) for i in range(6)]
    targets=apportion(raw_counts,total)
    ratio=total/sum(raw_counts)
    # Keep long words spread across levels when our total word count is smaller.
    doubles=min(sum(sum(word['length']>5 for word in peer['words'])==2 for peer in peers),math.floor(sum(sum(word['length']>5 for word in peer['words'])==2 for peer in peers)*ratio))
    long_total=sum(targets[3:]);long_hist={0:len(selected)-long_total+doubles,1:long_total-2*doubles,2:doubles}
    direction_shares={}
    for i,length in enumerate(lengths):
        words=[word for peer in peers for word in peer['words'] if word['length']==length]
        all_words=[word for peer in data['reference'] for word in peer['words'] if word['length']==length]
        rate=sum(word['positive'] for word in all_words)/len(all_words) if all_words else .7
        direction_shares[str(length)]=(sum(word['positive'] for word in words)+5*rate)/(len(words)+5) if len(words)<15 else sum(word['positive'] for word in words)/len(words)

    options=[];expected_hist=Counter()
    for row in selected:
        n=row['targetCount'];no_three=row['targetComposition']['noThreeLetter']
        peer_templates=[]
        for peer in peers:
            original=vector_of(peer['words'])
            if bool(original[0]==0)!=bool(no_three):continue
            scaled=apportion(original,n)
            if not no_three and scaled[0]==0:
                donor=max(range(1,6),key=lambda i:scaled[i]);scaled[donor]-=1;scaled[0]+=1
            if sum(value>0 for value in scaled)<2:continue
            weight=math.exp(-abs(len(peer['words'])-n)*.5-abs(peer['cells']-row['activeCells'])*.12)
            peer_templates.append((scaled,weight))
        if not peer_templates:
            peer_templates=[(row['targetComposition']['preferredCounts'][:3]+[0,0,0],1)]
            if sum(peer_templates[0][0])!=n:peer_templates=[([0,n-2,2,0,0,0] if no_three else [max(1,n-3),2,1,0,0,0],1)]
        weight_sum=sum(weight for _,weight in peer_templates)
        for vector,weight in peer_templates:
            for key,value in metrics(vector).items():
                if key.startswith('hist:') or key.startswith('variety:'):expected_hist[key]+=weight/weight_sum*value
        candidates=[]
        for six,seven,eight in product(range(3),repeat=3):
            long=six+seven+eight
            if long>2 or any(value and targets[index]==0 for index,value in enumerate([six,seven,eight],start=3)):continue
            if long==2 and (row['activeCells']<12 or no_three):continue
            short=n-long
            for three in ([0] if no_three else range(1,short)):
                for five in range(min(4,short-three)+1):
                    four=short-three-five
                    if four<0:continue
                    vector=[three,four,five,six,seven,eight]
                    variety=sum(value>0 for value in vector)
                    if variety<2 or variety>5:continue
                    if not score_feasible(row,vector):continue
                    distance=min(sum(abs(a-b) for a,b in zip(vector,peer))/2 for peer,_ in peer_templates)
                    # Different level kinds remain possible; favor observed joint shapes.
                    cost=distance*.35+max(0,variety-4)*.15
                    candidates.append({'position':row['position'],'vector':vector,'metrics':metrics(vector),'cost':cost})
        assert candidates, row['position']
        options.extend(candidates)

    # A small MILP assigns a feasible primary template per row. Histogram slack
    # is minimized while word totals and long-word placement counts are bounded.
    constraints=[]
    for row in selected:constraints.append((f'row:{row["position"]}',1,1))
    for length,target in zip(lengths,targets):constraints.append((f'length:{length}',target,target))
    for count,target in long_hist.items():constraints.append((f'hist:6+:{count}',target,target))
    hist_keys=sorted(key for key in expected_hist if not key.startswith('hist:6+'))
    for key in hist_keys:constraints.append((key,expected_hist[key],expected_hist[key]))
    m=len(options);slacks=len(hist_keys)*2
    c=np.array([option['cost'] for option in options]+[2.0]*slacks)
    integrality=np.r_[np.ones(m),np.zeros(slacks)]
    lower=np.zeros(m+slacks);upper=np.r_[np.ones(m),np.full(slacks,np.inf)]
    ri=[];ci=[];values=[];lb=[];ub=[];hist_index={key:index for index,key in enumerate(hist_keys)}
    for index,(key,a,b) in enumerate(constraints):
        lb.append(a);ub.append(b)
        for j,option in enumerate(options):
            value=int(option['position']==int(key.split(':')[1])) if key.startswith('row:') else option['metrics'].get(key,0)
            if value:ri.append(index);ci.append(j);values.append(value)
        if key in hist_index:
            offset=m+hist_index[key]*2
            ri.extend([index,index]);ci.extend([offset,offset+1]);values.extend([1,-1])
    matrix=coo_matrix((values,(ri,ci)),shape=(len(constraints),m+slacks)).tocsc()
    solution=milp(c,integrality=integrality,bounds=Bounds(lower,upper),constraints=LinearConstraint(matrix,lb,ub),options={'time_limit':30,'mip_rel_gap':.02})
    assert solution.x is not None, solution.message
    chosen=[option for option,value in zip(options,solution.x[:m]) if value>.5]
    assert len(chosen)==len(selected)
    primary={option['position']:option for option in chosen}
    actual_metrics=Counter()
    for option in chosen:actual_metrics.update(option['metrics'])
    budget_targets={f'length:{length}':target for length,target in zip(lengths,targets)}
    budget_ranges={key:[max(0,target-1),target+1] if target else [0,0] for key,target in budget_targets.items()}
    # Exact length accounting, with at most one word of deviation per stage.
    for cls,max_count in [('3',max(row['targetCount'] for row in selected)),('4',max(row['targetCount'] for row in selected)),('5',4),('6+',2)]:
        for count in range(max_count+1):
            key=f'hist:{cls}:{count}';target=actual_metrics[key]
            budget_targets[key]=target
            tolerance=0 if cls=='6+' else max(1,round(len(selected)*.08))
            budget_ranges[key]=[max(0,target-tolerance),min(len(selected),target+tolerance)]
    for variety in range(1,7):
        key=f'variety:{variety}';target=actual_metrics[key];budget_targets[key]=target
        budget_ranges[key]=[max(0,target-1),min(len(selected),target+1)]
    positive_total=0
    for length,target in zip(lengths,targets):
        key=f'positive:{length}';positive=round(target*direction_shares[str(length)]);positive_total+=positive
        tolerance=0 if not target else max(1,round(target*.04))
        budget_targets[key]=positive;budget_ranges[key]=[max(0,positive-tolerance),min(target,positive+tolerance)]
    budget_targets['positive']=positive_total
    budget_ranges['positive']=[max(0,positive_total-max(1,round(total*.03))),min(total,positive_total+max(1,round(total*.03)))]
    budget={'id':f'stage-{start}-{end}','from':start,'to':end,'levels':len(selected),'targetTotal':total,
            'targets':budget_targets,'ranges':budget_ranges,'firstStepPositiveShares':direction_shares,'referenceCounts':raw_counts,
            'directionPacing':{'maximumDebt':max(1,round(total*.03)),
                               'maximumDebtByLength':{str(length):max(1,round(target*.04)) for length,target in zip(lengths,targets)}}}
    budgets.append(budget)
    # Keep the stage coverage quota hard while letting single-long placements
    # move between rows. A difficult small board must not force its predecessor
    # to abandon a good candidate merely to move one long-word slot.
    flexible_long_positions={row['position'] for row in selected if sum(primary[row['position']]['vector'][3:])<2}
    if flexible_long_positions:budget['flexibleLongPositions']=sorted(flexible_long_positions)
    for row in selected:
        vector=primary[row['position']]['vector'];long_count=sum(vector[3:])
        long_options={0,1} if row['position'] in flexible_long_positions else {long_count}
        alternatives=[option['vector'] for option in options if option['position']==row['position'] and sum(option['vector'][3:]) in long_options and
                      sum(abs(a-b) for a,b in zip(option['vector'][:3],vector[:3]))<=6+abs(sum(option['vector'][3:])-long_count)]
        # Only retain a modest family around the primary short-word mix; long
        # types may move between slots, but stage exact totals remain mandatory.
        alternatives.sort(key=lambda v:(sum(abs(a-b) for a,b in zip(v,vector)),v))
        if len(long_options)>1:
            alternatives=[v for count in sorted(long_options) for v in [v for v in alternatives if sum(v[3:])==count][:60]]
        else:alternatives=alternatives[:60]
        cfg=row['targetComposition'];cfg['allowedTemplates']=alternatives;cfg['stageBudgetId']=budget['id']
        cfg['stageFrom']=start;cfg['stageTo']=end
        cfg['preferredLengths']=[length for length,count in zip(lengths,vector) for _ in range(count)]
        cfg['preferredCounts']=vector[:3]+[long_count]
        cfg['preferredDistinctLengths']=sum(n>0 for n in vector)
        cfg['preferredCountRanges']=[[max(0,n-1),min(row['targetCount'],n+1)] for n in cfg['preferredCounts']]
        if cfg['noThreeLetter']:cfg['preferredCountRanges'][0]=[0,0]
        else:cfg['preferredCountRanges'][0][0]=max(1,cfg['preferredCountRanges'][0][0])
        cfg['firstStepPositiveShares'].update(direction_shares)
        cfg['weights']['firstStep']=5
    print(json.dumps({'stage':[start,end],'totals':targets,'longHistogram':long_hist,'templates':len(options),'solver':solution.message},ensure_ascii=False),flush=True)

plan={**base,'id':'our-level-plan-stage-budget-first-50-20261112-v6','parentPlanId':base['id'],'stageBudgets':budgets,
      'stageBudgetScope':{'from':6,'to':50},'records':rows,'scope':{'from':6,'to':50,'plannedLevels':45,'excludedPositions':[1,2,3,4,5]}}
if prefix_file:plan['reusedPrefixConfiguration']={'through':30,'file':str(prefix_file.relative_to(ROOT)),'sha256':hashlib.sha256(prefix_file.read_bytes()).hexdigest()}
(OUT/'plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n')
(OUT/'stage-budgets.json').write_text(json.dumps(budgets,ensure_ascii=False,indent=2)+'\n')
lines=['阶段预算版：第6～50关','前5关保留；棋盘、难度、目标总数、四档分布和总分范围沿用原规划。','精确长度按3/4/5/6/7/8分别统计。']
for budget in budgets:
    lines.extend(['',f'阶段{budget["from"]}～{budget["to"]}，总目标{budget["targetTotal"]}个',
                  '各词长数量：'+json.dumps({length:budget['targets'][f'length:{length}'] for length in lengths},ensure_ascii=False),
                  '长词0/1/2个关卡数：'+json.dumps({count:budget['targets'][f'hist:6+:{count}'] for count in range(3)},ensure_ascii=False),
                  '首步正向总数范围：'+str(budget['ranges']['positive'])])
lines.extend(['','关号\t目标数\t主模板（3/4/5/6/7/8）\t可选模板数\t长词数'])
for row in rows:
    cfg=row['targetComposition'];vector=vector_of([{'length':n} for n in cfg['preferredLengths']])
    lines.append(f'{row["position"]}\t{row["targetCount"]}\t'+ '/'.join(map(str,vector))+f'\t{len(cfg["allowedTemplates"])}\t{sum(vector[3:])}')
(OUT/'配置清单.txt').write_text('\n'.join(lines)+'\n')
