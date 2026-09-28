#!/usr/bin/env bash
# Render synthetic end-mill batches in parallel: synth_batch.sh <n_per_worker> <seed1> [seed2 ...]
B="${BLENDER:-$LOCALAPPDATA/Programs/Blender/blender-4.5.10-windows-x64/blender.exe}"
OUT=${OUT:-C:/agent_research_team/datasets/toolwear/raw/synth_endmill}
N=$1; shift
for s in "$@"; do
  "$B" -b --factory-startup -noaudio -P "$(dirname "$0")/synth_endmill.py" -- --out "$OUT" --n "$N" --seed "$s" --samples ${SAMPLES:-24} > "$OUT.log.$s" 2>&1 &
done
wait; echo SYNTH_BATCH_DONE
