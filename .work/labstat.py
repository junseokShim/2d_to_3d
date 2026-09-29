import sys,glob,json,cv2,numpy as np
d=sys.argv[1]; M={}
for f in glob.glob(d+'/meta_*.jsonl'):
    for l in open(f): m=json.loads(l); M[m['id']]=m
for i,m in sorted(M.items()):
    L=cv2.imread(f'{d}/{i:06d}_lab.png',0); t=(L>0).sum()
    print(i,m['mode'],m.get('view'),'ppm %.0f'%m.get('ppm',0),' '.join('c%d=%.3f'%(c,(L==c).sum()/t) for c in (2,3)))
