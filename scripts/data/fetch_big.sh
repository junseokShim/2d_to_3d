#!/usr/bin/env bash
# Background fetch of the big sources: QIT-CEMC rar (parallel ranges) + MATWI images only.
PY=${PY:-C:/agent_research_team/datasets/.venv/Scripts/python.exe}
ROOT=${ROOT:-C:/agent_research_team/datasets/toolwear}
F=$(dirname "$0")/fetch.py
"$PY" "$F" pget "https://ndownloader.figshare.com/files/50069727" "$ROOT/raw/qit_cemc/milling_dataset_QIT.rar" --parts 8 &
for s in 12:269922 13:269908 15:269906 5:269916 2:269907 3:269914 4:269920 7:269915 8:269913 9:269904 10:269918 11:269903 1:269921 14:269911 16:269917 17:269910 6:269919; do
  "$PY" "$F" zipimgs "https://rdr.kuleuven.be/api/access/datafile/${s##*:}" "$ROOT/raw/matwi/Set${s%%:*}"
done
wait; echo ALLDONE
