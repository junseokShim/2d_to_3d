#!/usr/bin/env bash
# Download open tool-wear datasets into $ROOT/raw/<source>/ (resumable, curl -C -).
ROOT=${ROOT:-C:/agent_research_team/datasets/toolwear}
set -u
get() { mkdir -p "$ROOT/raw/$1"; echo "[$(date +%T)] $1/$2"; curl -sSL --retry 5 -C - -o "$ROOT/raw/$1/$2" "$3" || echo "FAIL $1/$2"; }
which="${1:-all}"
if [[ $which == all || $which == small ]]; then
  # Aqifi 2026 end-mill vibration set, CC-BY-4.0; only the figures (microscope images)
  get aqifi_endmill README.md "https://zenodo.org/records/21845441/files/README.md?download=1"
  get aqifi_endmill Figures.zip "https://zenodo.org/records/21845441/files/Figures.zip?download=1"
  # MATWI labels
  for f in README.md:269905 labels.csv:269912 sets.csv:269909; do get matwi ${f%%:*} "https://rdr.kuleuven.be/api/access/datafile/${f##*:}"; done
  get mudestreda README.md "https://zenodo.org/records/8238653/files/README.md?download=1"
  get mudestreda dataset_original.zip "https://zenodo.org/records/8238653/files/dataset_original.zip?download=1"
  get mudestreda labels_original.zip "https://zenodo.org/records/8238653/files/labels_original.zip?download=1"
fi
if [[ $which == all || $which == big ]]; then
  get qit_cemc mill_data_processing.py "https://ndownloader.figshare.com/files/50331915"
  get qit_cemc milling_dataset_QIT.rar "https://ndownloader.figshare.com/files/50069727" &
  for f in Set1:269921 Set2:269907 Set3:269914 Set4:269920 Set5:269916 Set6:269919 Set7:269915 Set8:269913 Set9:269904 Set10:269918 Set11:269903 Set12:269922 Set13:269908 Set14:269911 Set15:269906 Set16:269917 Set17:269910; do
    get matwi ${f%%:*}.zip "https://rdr.kuleuven.be/api/access/datafile/${f##*:}"; done
  wait
fi
echo ALLDONE
