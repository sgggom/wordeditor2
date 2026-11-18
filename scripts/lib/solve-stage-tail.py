"""Check the complete remaining stage, retaining every configured budget."""
import json
import sys

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp


def template_metrics(vector):
    result = {f'length:{length}':count for length,count in zip(range(3,9),vector)}
    result.update({f'hist:3:{vector[0]}':1,f'hist:4:{vector[1]}':1,
                   f'hist:5:{vector[2]}':1,f'hist:6+:{sum(vector[3:])}':1,
                   f'variety:{sum(count>0 for count in vector)}':1})
    return result


def solve(request):
    budget,used,rows = request['budget'],request['used'],request['rows']
    ranges = budget['ranges']
    if not rows:
        return {'feasible':all(low <= used.get(key,0) <= high for key,(low,high) in ranges.items()),'templates':[]}
    options = [(row,vector,template_metrics(vector)) for row in rows for vector in row['targetComposition']['allowedTemplates']]
    size = len(options)
    matrix,lower,upper = [],[],[]
    for row in rows:
        matrix.append([int(source['position']==row['position']) for source,_,_ in options]+[0]*6)
        lower.append(1);upper.append(1)
    for key,(low,high) in ranges.items():
        if key.startswith('positive'):continue
        matrix.append([metrics.get(key,0) for _,_,metrics in options]+[0]*6)
        lower.append(low-used.get(key,0));upper.append(high-used.get(key,0))
    # Future positive words must fit their exact length slots, and their sum
    # must also satisfy the stage's overall direction quota.
    positive_min,positive_max = [],[]
    future_words = sum(row['targetCount'] for row in rows)
    for index,length in enumerate(range(3,9)):
        key = f'positive:{length}'
        low,high = ranges.get(key,[0,future_words])
        positive_min.append(max(0,low-used.get(key,0)))
        positive_max.append(high-used.get(key,0))
        matrix.append([-metrics.get(f'length:{length}',0) for _,_,metrics in options]+[int(i==index) for i in range(6)])
        lower.append(-np.inf);upper.append(0)
    if any(low>high for low,high in zip(positive_min,positive_max)):
        return {'feasible':False,'templates':[]}
    low,high = ranges.get('positive',[0,future_words+used.get('positive',0)])
    matrix.append([0]*size+[1]*6)
    lower.append(low-used.get('positive',0));upper.append(high-used.get('positive',0))
    costs=[]
    for row,vector,_ in options:
        preferred=row['targetComposition'].get('preferredLengths',[])
        costs.append(sum(abs(count-preferred.count(length)) for length,count in zip(range(3,9),vector))*.01)
    result=milp(np.array(costs+[0]*6),integrality=np.ones(size+6),
                bounds=Bounds([0]*size+positive_min,[1]*size+positive_max),
                constraints=LinearConstraint(np.array(matrix),lower,upper),options={'time_limit':5})
    if result.x is None:
        if result.status==2:return {'feasible':False,'templates':[]}
        raise RuntimeError(result.message)
    values=np.array(matrix)@result.x
    if not (np.all(values>=np.array(lower)-1e-7) and np.all(values<=np.array(upper)+1e-7)):
        raise RuntimeError('Solver returned an invalid budget allocation')
    return {'feasible':True,'templates':[{'position':row['position'],'vector':vector}
            for (row,vector,_),value in zip(options,result.x[:size]) if value>.5]}


if __name__=='__main__':
    print(json.dumps(solve(json.load(sys.stdin)),separators=(',',':')))
