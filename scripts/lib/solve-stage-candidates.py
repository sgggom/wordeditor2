"""Choose actual levels jointly, including cross-level word cooldown."""
import json
import sys
from collections import defaultdict
import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import coo_matrix


def solve(data):
    rows,used,budget=data['rows'],data['used'],data['budget']
    options=[(row,candidate) for row in rows for candidate in row['candidates']]
    if any(not row['candidates'] for row in rows):return {'feasible':False}
    ri,ci,values,lower,upper=[],[],[],[],[]
    def constraint(entries,low,high):
        index=len(lower);lower.append(low);upper.append(high)
        for column,value in entries:
            if value:ri.append(index);ci.append(column);values.append(value)
    for row in rows:constraint([(i,int(source['position']==row['position'])) for i,(source,c) in enumerate(options)],1,1)
    for key,(low,high) in budget['ranges'].items():
        constraint([(i,c['metrics'].get(key,0)) for i,(_,c) in enumerate(options)],low-used.get(key,0),high-used.get(key,0))
    budget_end=len(lower)
    words,bags=defaultdict(list),defaultdict(list)
    for i,(_,candidate) in enumerate(options):
        for word in candidate['words']:words[word].append((i,1))
        bags[candidate['bag']].append((i,1))
    for groups in [words,bags]:
        for entries in groups.values():
            if len(entries)>1:constraint(entries,0,1)
    pacing_start=len(lower)
    pacing=budget.get('directionPacing')
    if pacing:
        previous_words=data['previousWords']
        for row in rows:
            previous_words+=row['targetCount']
            minimum=int(np.floor(budget['targets']['positive']*previous_words/budget['targetTotal']-pacing['maximumDebt']))
            constraint([(i,c['metrics'].get('positive',0)) for i,(source,c) in enumerate(options) if source['position']<=row['position']],minimum-used.get('positive',0),np.inf)
            for length in range(3,9):
                total=budget['targets'][f'length:{length}'];positive=budget['targets'][f'positive:{length}']
                if not total:continue
                slack=pacing['maximumDebtByLength'][str(length)]
                key=f'positive:{length}';length_key=f'length:{length}'
                baseline=total*used.get(key,0)-positive*used.get(length_key,0)
                constraint([(i,total*c['metrics'].get(key,0)-positive*c['metrics'].get(length_key,0)) for i,(source,c) in enumerate(options) if source['position']<=row['position']],-total*(slack+1)+1-baseline,np.inf)
    matrix=coo_matrix((values,(ri,ci)),shape=(len(lower),len(options))).tocsc()
    result=milp(np.array([candidate['cost'] for _,candidate in options]),integrality=np.ones(len(options)),
                bounds=Bounds(np.zeros(len(options)),np.ones(len(options))),
                constraints=LinearConstraint(matrix,lower,upper),options={'time_limit':15,'mip_rel_gap':.05})
    if result.x is None:
        indices=list(range(budget_end))+list(range(pacing_start,len(lower)))
        relaxed=milp(np.zeros(len(options)),integrality=np.ones(len(options)),bounds=Bounds(np.zeros(len(options)),np.ones(len(options))),
                     constraints=LinearConstraint(matrix[indices],np.array(lower)[indices],np.array(upper)[indices]),options={'time_limit':3})
        impossible=[]
        for key,(low,high) in budget['ranges'].items():
            minimum=used.get(key,0)+sum(min(c['metrics'].get(key,0) for c in row['candidates']) for row in rows)
            maximum=used.get(key,0)+sum(max(c['metrics'].get(key,0) for c in row['candidates']) for row in rows)
            if minimum>high or maximum<low:impossible.append({'metric':key,'available':[minimum,maximum],'required':[low,high]})
        keys=list(budget['ranges'])
        def probe(include):
            subset=list(range(len(rows)))+[len(rows)+i for i,key in enumerate(keys) if include(key)]
            answer=milp(np.zeros(len(options)),integrality=np.ones(len(options)),bounds=Bounds(np.zeros(len(options)),np.ones(len(options))),
                        constraints=LinearConstraint(matrix[subset],np.array(lower)[subset],np.array(upper)[subset]),options={'time_limit':2})
            return answer.x is not None
        return {'feasible':False,'status':result.message,'withoutCooldownFeasible':relaxed.x is not None,'impossibleMetrics':impossible,
                'countsOnlyFeasible':probe(lambda key:not key.startswith('positive')),
                'finalDirectionsFeasible':probe(lambda key:True),
                'withoutHistogramsFeasible':probe(lambda key:key.startswith('length:') or key.startswith('positive'))}
    actual=matrix@result.x
    assert np.all(actual>=np.array(lower)-1e-6) and np.all(actual<=np.array(upper)+1e-6)
    return {'feasible':True,'selected':[candidate['id'] for (_,candidate),value in zip(options,result.x) if value>.5],'status':result.message}


if __name__=='__main__':print(json.dumps(solve(json.load(sys.stdin)),separators=(',',':')))
