#!/bin/bash
cd /c/agent_research_team/worktrees/worker-seg14
export PYTHONUTF8=1
PY=/c/agent_research_team/worktrees/worker-seg/.work/venv/Scripts/python.exe
$PY scripts/seg/gen_pool_micro.py .work/pool_micro14 5000000 2000 land > .work/gen14.log 2>&1
echo DONE > .work/gen14.done
