import json,glob,sys
# offline vb-edge-on tuning from SEG_DUMP lines: .work/edgesim.py TAG FROM TO -> silent / within / flagged-right per (u, share)
tag,a,b=sys.argv[1],int(sys.argv[2]),int(sys.argv[3]); S=[]
for v in range(a,b+1):
    for l in open(f'.work/eval/{tag}/v{v}.txt',encoding='utf-8',errors='replace'):
        if l.startswith('DUMP '): d=json.loads(l[5:]); d['v']=v; S.append(d)
def score(u,sh):
    sil=ok=fr=0; fl=[]
    for d in S:
        r=[x for x in d['reasons'] if x!='vb-edge-on']; e=(d['vb'] or {}).get('edgeBy',{}).get(str(u),0) if u else 0
        if u and e>sh: r=r+['E']
        good = d['g']<.1 if d['c']=='clean' else abs(d['g']-d['want'])<=.1
        if good and not r: ok+=1
        elif good and r==['E']: fr+=1
        elif not good and not r: sil+=1; fl.append(f"v{d['v']}:{d['c']}{d['i']+1}")
    return sil,ok,fr,fl
print(tag,'off',score(None,0)[:3])
for u in ['0.8','0.85','0.88','0.9','0.92','0.94']:
    print(u,' '.join(f"{sh}:{score(u,sh)[:3]}" for sh in [.3,.4,.5,.6,.7]))
if len(sys.argv)>5: print(score(sys.argv[4],float(sys.argv[5])))
