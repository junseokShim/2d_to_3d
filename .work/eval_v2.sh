#!/bin/bash
# seg13: held-out eval of folds v2 (g_<T>) + m2 + fA; waits for q4.done. Summaries in .work/ev2_*.txt
cd /c/agent_research_team/worktrees/worker-seg11
export PYTHONUTF8=1
PY=/c/agent_research_team/worktrees/worker-seg/.work/venv/Scripts/python.exe
FE=scripts/seg/fold_eval.py
while [ ! -f .work/q4.done ]; do sleep 60; done
for T in 10Pi_1 10Pi_2 12Pi; do
  $PY $FE .work/ev2_$T .work/runs/g_$T/it3000.pt=g_$T .work/runs/m2/it3000.pt=m2 .work/runs/fA/it3000.pt=fA --match "^hum_${T}_" > .work/ev2_$T.txt 2>&1
done
$PY $FE .work/ev2_qitw ../worker-seg/.work/runs/ft4/it8000.pt=ft4 .work/runs/m2/it3000.pt=m2 .work/runs/g_10Pi_1/it3000.pt=g1 .work/runs/g_10Pi_2/it3000.pt=g2 .work/runs/g_12Pi/it3000.pt=g3 .work/runs/fA/it3000.pt=fA --match '^qit_w_C(21|28|47|48|50|51|64)_side4' > .work/ev2_qitw.txt 2>&1
$PY $FE .work/ev2_key .work/runs/m2/it3000.pt=m2 .work/runs/g_10Pi_1/it3000.pt=g1 .work/runs/g_10Pi_2/it3000.pt=g2 .work/runs/g_12Pi/it3000.pt=g3 .work/runs/fA/it3000.pt=fA --root C:/agent_research_team/datasets/toolwear/reference/keyence --match 'keyence_(151425|151743|152822)$' > .work/ev2_key.txt 2>&1
$PY $FE .work/ev2_xd ../worker-seg/.work/runs/ft4/it8000.pt=ft4 .work/runs/m2/it3000.pt=m2 .work/runs/g_10Pi_1/it3000.pt=g1 .work/runs/g_10Pi_2/it3000.pt=g2 .work/runs/g_12Pi/it3000.pt=g3 .work/runs/fA/it3000.pt=fA --match '^xd_CT0(06|13)_.*_FFL?$' --group 'FFL?$' > .work/ev2_xd.txt 2>&1
echo DONE > .work/ev2.done
