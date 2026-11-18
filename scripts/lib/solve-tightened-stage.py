"""Joint template/candidate solver with conditional integer direction quotas."""
import json
import sys
import math
import copy
import hashlib
from collections import defaultdict
from fractions import Fraction
import numpy as np
from scipy.optimize import Bounds,LinearConstraint,milp
from scipy.sparse import coo_matrix
from direction_policy import positive_options,direction_pairs,weighted_options,LENGTHS


def template_metrics(v):
    result={f'length:{length}':count for length,count in zip(LENGTHS,v)}
    result.update({f'hist:3:{v[0]}':1,f'hist:4:{v[1]}':1,f'hist:5:{v[2]}':1,f'hist:6+:{sum(v[3:])}':1,f'variety:{sum(count>0 for count in v)}':1})
    return result


class Model:
    def __init__(self):
        self.lo=[];self.hi=[];self.integer=[];self.center=[];self.quality=[];self.seed=[];self.rows=[];self.lower=[];self.upper=[]
    def var(self,low=0,high=1,integer=True,center=0,quality=0,seed=0):
        index=len(self.lo);self.lo.append(low);self.hi.append(high);self.integer.append(int(integer));self.center.append(center);self.quality.append(quality);self.seed.append(seed);return index
    def add(self,entries,low=-np.inf,high=np.inf):
        row=defaultdict(float)
        for index,value in entries:row[index]+=value
        self.rows.append({index:value for index,value in row.items() if value});self.lower.append(low);self.upper.append(high)
    def deviation(self,entries,target,baseline=0,weight=1):
        variable=self.var(high=np.inf,integer=False,center=weight)
        self.add([*entries,(variable,-1)],high=target-baseline)
        self.add([(index,-value) for index,value in entries]+[(variable,-1)],high=baseline-target)
    def solve_cp(self,second):
        from ortools.sat.python import cp_model
        cp=cp_model.CpModel();variables=[];booleans=[]
        for index,(low,high) in enumerate(zip(self.lo,self.hi)):
            boolean=low==0 and high==1
            variables.append(cp.new_bool_var(f'x{index}') if boolean else cp.new_int_var(math.ceil(low),math.floor(high) if np.isfinite(high) else 10000,f'x{index}'))
            booleans.append(boolean)
        for entries,low,high in zip(self.rows,self.lower,self.upper):
            assert all(abs(value-round(value))<1e-7 for value in entries.values())
            if entries and all(value==1 and booleans[index] for index,value in entries.items()) and high==1 and low in (0,1):
                if low==1:cp.add_exactly_one([variables[index] for index in entries])
                else:cp.add_at_most_one([variables[index] for index in entries])
            else:
                expression=sum(int(round(value))*variables[index] for index,value in entries.items())
                if np.isfinite(low):cp.add(expression>=math.ceil(low-1e-8))
                if np.isfinite(high):cp.add(expression<=math.floor(high+1e-8))
        center_coefficients=[int(round(value*100000)) for value in self.center]
        quality_coefficients=[int(round(value*1000)) for value in self.quality]
        if getattr(self,'strategy','')=='guide':center_coefficients=[value+int(round(quality*.1)) for value,quality in zip(center_coefficients,quality_coefficients)]
        center=sum(coefficient*variable for coefficient,variable in zip(center_coefficients,variables) if coefficient)
        def run(coefficients,seconds,hint=None):
            cp.clear_hints()
            if hint is not None:
                for variable,value in zip(variables,hint):cp.add_hint(variable,int(value))
            cp.minimize(sum(coefficient*variable for coefficient,variable in zip(coefficients,variables) if coefficient))
            solver=cp_model.CpSolver();solver.parameters.max_time_in_seconds=seconds;solver.parameters.num_search_workers=4;solver.parameters.random_seed=getattr(self,'search_seed',20261113)
            status=solver.solve(cp)
            return (np.array([solver.value(variable) for variable in variables],dtype=float) if status in (cp_model.FEASIBLE,cp_model.OPTIMAL) else None),status,solver.status_name(status)
        limits=getattr(self,'time_limits',{})
        seed,_,_=run([0]*len(variables),limits.get('seed',20)) if second and limits.get('seed',20)>0 else (None,None,None)
        if seed is not None:cp.add(center<=int(np.dot(center_coefficients,seed)))
        optimized,status,message=run(center_coefficients,limits.get('center',25),seed)
        chosen=optimized if optimized is not None else seed
        if chosen is None:return None,message,None
        if second and any(quality_coefficients) and limits.get('quality',7)>0:
            cp.add(center<=int(np.dot(center_coefficients,chosen)))
            refined,_,refined_message=run(quality_coefficients,limits.get('quality',7),chosen)
            if refined is not None:chosen=refined;message=refined_message
        for entries,low,high in zip(self.rows,self.lower,self.upper):
            value=sum(chosen[index]*coefficient for index,coefficient in entries.items());assert low-1e-6<=value<=high+1e-6
        return chosen,message,{'centerCost':float(np.dot(self.center,chosen)),'centerOptimal':optimized is not None and status==cp_model.OPTIMAL,'backend':'cp-sat'}
    def solve(self,second=True):
        if getattr(self,'backend','auto')!='milp':
            try:
                import ortools.sat.python.cp_model
            except ImportError:pass
            else:return self.solve_cp(second)
        ri=[];ci=[];values=[]
        for row,entries in enumerate(self.rows):
            for column,value in entries.items():ri.append(row);ci.append(column);values.append(value)
        matrix=coo_matrix((values,(ri,ci)),shape=(len(self.rows),len(self.lo))).tocsc()
        def run(cost,extra=None,seconds=20):
            constraints=[LinearConstraint(matrix,self.lower,self.upper)]
            if extra is not None:constraints.append(extra)
            return milp(np.array(cost),integrality=np.array(self.integer),bounds=Bounds(self.lo,self.hi),constraints=constraints,options={'time_limit':seconds,'mip_rel_gap':.005})
        limits=getattr(self,'time_limits',{})
        seed=run(self.seed,seconds=limits.get('seed',4)) if second and limits.get('seed',4)>0 else None
        limit=None
        if seed is not None and seed.x is not None:
            limit=LinearConstraint(np.array(self.center).reshape(1,-1),-np.inf,float(np.dot(self.center,seed.x))+1e-7)
        optimized=run(self.center,limit,limits.get('center',12))
        first=optimized if optimized.x is not None else seed
        if first is None or first.x is None:return None,optimized.message,None
        result=first
        if second and any(self.quality) and limits.get('quality',8)>0:
            limit=LinearConstraint(np.array(self.center).reshape(1,-1),-np.inf,float(np.dot(self.center,first.x))+1e-7)
            refined=run(self.quality,limit,limits.get('quality',8))
            if refined.x is not None:result=refined
        actual=matrix@result.x
        assert np.all(actual>=np.array(self.lower)-1e-5) and np.all(actual<=np.array(self.upper)+1e-5)
        return result.x,result.message,{'centerCost':float(np.dot(self.center,result.x)),'centerOptimal':optimized.x is not None and optimized.status==0}


def solve(request):
    mode=request.get('mode','candidates');budget=request['budget'];used=request.get('used',{});rows=request['rows'];weighted=budget.get('directionMetric')=='weighted-path-direction-20261113'
    if not rows:
        feasible=all(low<=used.get(key,0)<=high for key,(low,high) in budget['ranges'].items())
        if budget.get('directionPolicy'):
            feasible=feasible and all(any(pair['N']==used.get(f'length:{length}',0) and pair['positive']==used.get(f'positive:{length}',0) and (not weighted or pair['neutral']==used.get(f'neutral:{length}',0)) for pair in direction_pairs(budget,length)) for length in LENGTHS) if weighted else feasible and all(used.get(f'positive:{length}',0) in positive_options(used.get(f'length:{length}',0),budget['firstStepPositiveShares'].get(str(length),0),budget['directionPolicy'],budget.get('directionCarryByLength',{}).get(str(length),0))['allowed'] for length in LENGTHS)
        coverage=budget.get('fiveCoverage')
        if coverage:
            flags=[bool(request.get('fivePresence',{}).get(str(position),False)) for position in range(budget['from'],budget['to']+1)]
            feasible=feasible and coverage['allowedLevels'][0]<=sum(flags)<=coverage['allowedLevels'][1]
            feasible=feasible and all(sum(flags[start:start+5])>=min(coverage['perFiveLevelsMinimum'],len(flags[start:start+5])) for start in range(0,len(flags),5))
            width=coverage['maxConsecutiveZeroLevels']+1
            feasible=feasible and all(any(flags[start:start+width]) for start in range(len(flags)-width+1))
        return {'feasible':feasible,'selected':[],'templates':[]}
    if mode=='candidates':
        if any(not row['candidates'] for row in rows):return {'feasible':False,'status':'missing candidate pool'}
        options=[]
        for row in rows:
            unique={}
            for candidate in row['candidates']:
                signature=(candidate['bag'],tuple(sorted(candidate['words'])),tuple(sorted((key,value) for key,value in candidate['metrics'].items() if value)))
                rank=lambda item:((0 if item.get('preservedBoard') else 1) if budget.get('preserveBoards') else 0,item['cost'])
                if signature not in unique or rank(candidate)<rank(unique[signature]):unique[signature]=candidate
            options.extend((row,candidate) for candidate in unique.values())
    else:
        options=[(row,{'vector':v,'metrics':template_metrics(v),'cost':sum(abs(count-row['targetComposition'].get('preferredLengths',[]).count(length)) for length,count in zip(LENGTHS,v))*.01}) for row in rows for v in row['targetComposition']['allowedTemplates']]
    model=Model();model.backend=request.get('backend','auto');model.time_limits=request.get('timeLimits',{});model.search_seed=request.get('searchSeed',20261113);model.strategy=request.get('strategy','')
    variables=[model.var(center=100000 if mode=='candidates' and budget.get('preserveBoards') and not candidate.get('preservedBoard') else 0,quality=candidate.get('cost',0),seed=len(candidate.get('words',[]))) for row,candidate in options]
    for row in rows:model.add([(i,1) for i,(source,c) in zip(variables,options) if source['position']==row['position']],1,1)
    expression=lambda key:[(i,c['metrics'].get(key,0)) for i,(_,c) in zip(variables,options)]
    future_positive={};future_neutral={}
    if mode=='tail':
        for length in LENGTHS:future_positive[length]=model.var(high=sum(row['targetCount'] for row in rows))
        for length in LENGTHS:
            if weighted:future_neutral[length]=model.var(high=sum(row['targetCount'] for row in rows))
            model.add([(future_positive[length],1)]+([(future_neutral[length],1)] if weighted else [])+[(index,-value) for index,value in expression(f'length:{length}')],high=0)
    for key,(low,high) in budget['ranges'].items():
        entries=expression(key)
        if mode=='tail' and key.startswith('positive:'):entries=[(future_positive[int(key.split(':')[1])],1)]
        elif mode=='tail' and key=='positive':entries=[(index,1) for index in future_positive.values()]
        elif mode=='tail' and key.startswith('neutral:'):entries=[(future_neutral[int(key.split(':')[1])],1)]
        elif mode=='tail' and key=='neutral':entries=[(index,1) for index in future_neutral.values()]
        model.add(entries,low-used.get(key,0),high-used.get(key,0))
    if budget.get('directionPolicy'):
        for length in LENGTHS:
            pairs=direction_pairs(budget,length)
            z=[model.var(center=pair['cost']) for pair in pairs]
            model.add([(index,1) for index in z],1,1)
            model.add([(index,pair['N']) for index,pair in zip(z,pairs)]+[(index,-value) for index,value in expression(f'length:{length}')],used.get(f'length:{length}',0),used.get(f'length:{length}',0))
            entries=expression(f'positive:{length}') if mode=='candidates' else [(future_positive[length],1)]
            model.add([(index,pair['positive']) for index,pair in zip(z,pairs)]+[(index,-value) for index,value in entries],used.get(f'positive:{length}',0),used.get(f'positive:{length}',0))
            if weighted:
                entries=expression(f'neutral:{length}') if mode=='candidates' else [(future_neutral[length],1)]
                model.add([(index,pair['neutral']) for index,pair in zip(z,pairs)]+[(index,-value) for index,value in entries],used.get(f'neutral:{length}',0),used.get(f'neutral:{length}',0))
    # Preferred stage distributions are independent of the candidate found first.
    for key,target in budget['targets'].items():
        if key.startswith('hist:5:') or key.startswith('variety:') or key.startswith('length:'):
            weight=5 if key in ('hist:5:0','variety:4') else .25 if key.startswith('length:') else 1
            model.deviation(expression(key),target,used.get(key,0),weight)
    presence={int(position):int(flag) for position,flag in request.get('fivePresence',{}).items()}
    coverage=budget.get('fiveCoverage')
    if coverage:
        def covered(positions):return [(i,int(source['position'] in positions and c['metrics'].get('length:5',0)>0)) for i,(source,c) in zip(variables,options)]
        for start in range(budget['from'],budget['to']+1,5):
            positions=set(range(start,min(start+5,budget['to']+1)));known=sum(presence.get(position,0) for position in positions)
            model.add(covered(positions),min(coverage['perFiveLevelsMinimum'],len(positions))-known,len(positions)-known)
        width=coverage['maxConsecutiveZeroLevels']+1
        for start in range(budget['from'],budget['to']-width+2):
            positions=set(range(start,start+width));known=sum(presence.get(position,0) for position in positions)
            model.add(covered(positions),low=1-known)
        known=sum(presence.values());model.add(covered(set(range(budget['from'],budget['to']+1))),coverage['allowedLevels'][0]-known,coverage['allowedLevels'][1]-known)
    if mode=='candidates':
        words=defaultdict(list);bags=defaultdict(list)
        families=defaultdict(list)
        for i,(row,candidate) in zip(variables,options):
            signature=(row['position'],candidate['bag'],tuple(sorted(candidate['words'])))
            families[signature].append(i)
        # Direction/path variants consume the same words. Share one family
        # variable so word conflicts do not repeat every orientation.
        for (_,bag,family_words),variants in families.items():
            family=variants[0]
            if len(variants)>1:
                family=model.var()
                model.add([(family,1)]+[(index,-1) for index in variants],0,0)
            for word in family_words:words[word].append((family,1))
            bags[bag].append((family,1))
        for groups in (words,bags):
            for entries in groups.values():
                if len(entries)>1:model.add(entries,0,1)
        pacing=budget.get('directionPacing')
        if pacing:
            previous_words=request.get('previousWords',0)
            for row in rows:
                previous_words+=row['targetCount']
                minimum=(budget['targets']['positive']*previous_words)//budget['targetTotal']-pacing['maximumDebt']
                model.add([(i,c['metrics'].get('positive',0)) for i,(source,c) in zip(variables,options) if source['position']<=row['position']],low=minimum-used.get('positive',0))
                for length in LENGTHS:
                    if not budget['targets'].get(f'length:{length}',0):continue
                    if budget.get('directionPolicy'):
                        reference=budget.get('referenceDirectionCounts',{}).get(str(length))
                        rate=Fraction(reference['positive'],reference['total']) if reference and reference['total'] else Fraction(budget.get('directionSharesByLength',{}).get(str(length),{}).get('positive',budget.get('firstStepPositiveShares',{}).get(str(length),0))).limit_denominator(1000000)
                        total,positive=rate.denominator,rate.numerator
                    else:total,positive=budget['targets'][f'length:{length}'],budget['targets'][f'positive:{length}']
                    carry_value=budget.get('directionCarryByLength',{}).get(str(length),0)
                    carry=Fraction(carry_value.get('positive',0) if isinstance(carry_value,dict) else carry_value).limit_denominator(1000000)
                    baseline=total*used.get(f'positive:{length}',0)-positive*used.get(f'length:{length}',0)
                    minimum=math.floor(total*(carry-pacing['maximumDebtByLength'][str(length)]-1))+1-baseline
                    entries=[(i,total*c['metrics'].get(f'positive:{length}',0)-positive*c['metrics'].get(f'length:{length}',0)) for i,(source,c) in zip(variables,options) if source['position']<=row['position']]
                    model.add(entries,low=minimum)
    values,status,quality=model.solve(second=mode=='candidates')
    if values is None:
        if mode=='candidates' and not request.get('strategy'):
            # Select a composition first, then solve the much smaller actual
            # word-packing problem. Every restricted solve retains all rules.
            for attempt in range(3):
                guide=copy.deepcopy(request);guide['strategy']='guide';guide['searchSeed']=20261113+attempt*97+sum(len(row['candidates']) for row in rows)
                guide['timeLimits']={'seed':0,'center':2,'quality':0};guide['budget'].pop('directionPolicy',None);guide['budget'].pop('directionPacing',None)
                guide['budget']['ranges']={key:range for key,range in guide['budget']['ranges'].items() if not key.startswith(('positive','neutral'))}
                lookup={};positions={candidate['id']:row['position'] for row in rows for candidate in row['candidates']}
                for row in guide['rows']:
                    groups={}
                    for candidate in row['candidates']:
                        candidate['metrics']={key:value for key,value in candidate['metrics'].items() if not key.startswith(('positive','neutral'))}
                        signature=tuple(candidate['metrics'].get(f'length:{length}',0) for length in LENGTHS)
                        candidate['words']=[];candidate['bag']=candidate['id'];candidate['cost']=((int(hashlib.sha256(candidate['id'].encode()).hexdigest()[:8],16)+attempt*104729)%1000)/1000
                        groups.setdefault(signature,candidate);lookup[candidate['id']]=signature
                    row['candidates']=list(groups.values())
                suggested=solve(guide)
                if not suggested['feasible']:continue
                signatures={positions[identifier]:lookup[identifier] for identifier in suggested['selected']}
                restricted={**request,'strategy':'restricted','searchSeed':guide['searchSeed'],'timeLimits':{'seed':1,'center':3,'quality':1},
                    'rows':[{**row,'candidates':[candidate for candidate in row['candidates'] if tuple(candidate['metrics'].get(f'length:{length}',0) for length in LENGTHS)==signatures[row['position']]]} for row in rows]}
                answer=solve(restricted)
                if answer['feasible']:
                    answer['quality']['searchStrategy']='composition-then-actual-words';return answer
        return {'feasible':False,'status':status}
    chosen=[candidate for i,(_,candidate) in zip(variables,options) if values[i]>.5]
    assert len(chosen)==len(rows)
    return {'feasible':True,'status':status,'quality':quality,
            **({'selected':[candidate['id'] for candidate in chosen]} if mode=='candidates' else {'templates':[{'position':row['position'],'vector':candidate['vector']} for i,(row,candidate) in zip(variables,options) if values[i]>.5]})}


if __name__=='__main__':
    request=json.load(sys.stdin)
    if request.get('mode')=='weighted-options':print(json.dumps([weighted_options(**case) for case in request['cases']]))
    elif request.get('mode')=='direction-options':print(json.dumps([positive_options(**case) for case in request['cases']]))
    else:print(json.dumps(solve(request),separators=(',',':')))
