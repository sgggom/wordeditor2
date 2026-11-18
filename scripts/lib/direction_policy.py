import math

LENGTHS=range(3,9)

def positive_options(N,rate,policy,carry=0):
    if not N:return {'preferred':0,'allowed':[0]}
    nearest=max(0,min(N,math.floor(N*rate+carry+.5+1e-10)))
    if N<policy['largeSampleMinimum']:return {'preferred':nearest,'allowed':[nearest]}
    tolerance=policy['largeSampleTolerancePoints']/100
    low=max(0,math.ceil(N*(rate-tolerance)-1e-9));high=min(N,math.floor(N*(rate+tolerance)+1e-9))
    allowed=list(range(low,high+1)) if low<=high else [nearest]
    return {'preferred':min(allowed,key=lambda count:abs(count-nearest)),'allowed':allowed}

def weighted_options(N,shares,policy,carry=None):
    names=['positive','reverse','neutral'];carry=carry or {}
    raw=[N*shares.get(name,0)+(carry.get(name,0) if N and isinstance(carry,dict) else 0) for name in names]
    preferred=[max(0,math.floor(value+1e-10)) for value in raw]
    while sum(preferred)<N:
        chosen=min(range(3),key=lambda i:(-(raw[i]-preferred[i]),i));preferred[chosen]+=1
    while sum(preferred)>N:
        chosen=min((i for i in range(3) if preferred[i]),key=lambda i:(raw[i]-preferred[i],i));preferred[chosen]-=1
    nearest=dict(zip(names,preferred));allowed=[]
    if N>=policy['largeSampleMinimum']:
        for P in range(N+1):
            for Z in range(N-P+1):
                values={'positive':P,'neutral':Z,'reverse':N-P-Z}
                if all(abs(values[name]/N-shares.get(name,0))<=policy['largeSampleTolerancePoints']/100+1e-10 for name in names):allowed.append(values)
    return {'preferred':nearest,'allowed':allowed or [nearest]}

def direction_pairs(budget,length):
    low,high=budget['ranges'][f'length:{length}'];rate=budget.get('directionSharesByLength',{}).get(str(length),{}).get('positive',budget.get('firstStepPositiveShares',{}).get(str(length),0))
    carry=budget.get('directionCarryByLength',{}).get(str(length),0)
    result=[]
    if budget.get('directionMetric')=='weighted-path-direction-20261113':
        shares=budget['directionSharesByLength'][str(length)]
        for N in range(low,high+1):
            options=weighted_options(N,shares,budget['directionPolicy'],carry)
            for counts in options['allowed']:result.append({'N':N,**counts,'preferred':options['preferred'],'cost':sum(abs(counts[name]/N-shares[name])*100 for name in ['positive','reverse','neutral']) if N else 0})
        return result
    for N in range(low,high+1):
        options=positive_options(N,rate,budget['directionPolicy'],carry)
        for P in options['allowed']:result.append({'N':N,'positive':P,'preferred':options['preferred'],'cost':(abs(P/N-rate)*100 if N else 0)+(0 if P==options['preferred'] else .0001)})
    return result
