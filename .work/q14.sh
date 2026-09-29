#!/bin/bash
# seg14: folds (held-out human tool) + fA, from ft4, with the land micro pool; then eval. Summaries .work/ev14_*.txt
cd /c/agent_research_team/worktrees/worker-seg14
export PYTHONUTF8=1
PY=/c/agent_research_team/worktrees/worker-seg/.work/venv/Scripts/python.exe
FT4=../worker-seg/.work/runs/ft4/it8000.pt
while [ ! -f .work/gen14.done ]; do sleep 60; done
COMMON="--pool ../worker-seg/.work/pool --pool3 .work/pool_micro14 --init $FT4 --iters 3000 --bs 8 --lr 1e-4 --workers 6 --eval_every 1000 --nval 200 --win .5 --bw 2 --ignore_tool mud,qitw,xd --mix pool:.4,syn:.2,mud:.1,micro:.15,hum:.08,xd:.04,qitw:.03 --save_every"
for T in 10Pi_1 10Pi_2 12Pi; do
  [ -f .work/runs/g_$T/it3000.pt ] || $PY scripts/seg/train.py $COMMON --out .work/runs/g_$T --exclude "^hum_${T}" > .work/runs/g_$T.out 2>&1
done
[ -f .work/runs/fA/it3000.pt ] || $PY scripts/seg/train.py $COMMON --out .work/runs/fA > .work/runs/fA.out 2>&1
FE=scripts/seg/fold_eval.py
for T in 10Pi_1 10Pi_2 12Pi; do
  $PY $FE .work/ev14_$T $FT4=ft4 .work/runs/g_$T/it3000.pt=g_$T .work/runs/fA/it3000.pt=fA --match "^hum_${T}_" > .work/ev14_$T.txt 2>&1
done
for M in ft4:$FT4 fA:.work/runs/fA/it3000.pt; do
  $PY scripts/seg/target_eval.py ${M#*:} .work/tgt14_${M%%:*} > .work/tgt14_${M%%:*}.txt 2>&1
done
echo DONE > .work/q14.done
