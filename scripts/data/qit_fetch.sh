#!/usr/bin/env bash
# resumable QIT-CEMC download; loops until complete
PY=${PY:-C:/agent_research_team/datasets/.venv/Scripts/python.exe}
for i in 1 2 3 4 5 6 7 8 9 10; do
  "$PY" "$(dirname "$0")/fetch.py" pget "https://ndownloader.figshare.com/files/50069727" "C:/agent_research_team/datasets/toolwear/raw/qit_cemc/milling_dataset_QIT.rar" --parts 8 && break
  sleep 30
done
