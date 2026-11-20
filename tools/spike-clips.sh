#!/bin/bash
# Renders the spike's video clips, resuming each from the frames already on disk (the cloud container
# that runs the captures restarts every 30-60 min; the simulation is a pure function of the start time
# and the step count, so a resumed sequence continues exactly: same warm-up start, same step count).
#
#   tools/spike-clips.sh            # render / resume all clips, in order
#
# Clip: name | params | start | end | sim step per frame | fps | pre-roll (s; settles the chase camera)
cd "$(dirname "$0")/.."
M='surf&fastload&colpx=18&surfrow=0.05'
S24=0.041666666666666664   # 1/24 s
CLIPS=(
  "wave-beach-slowmo|$M&at=24&shot=beach|23|25.4|0.025|24|0"
  "wave-channel|$M&at=24&shot=channel|20|26|$S24|24|0"
  "wave-drone|$M&at=24&shot=drone|20|26|$S24|24|0"
  "surf-chase|$M|18|26|$S24|24|1.2"
)
WARM0=1.0   # warm-up before the first frame (the simulation starts at start - WARM0)
for c in "${CLIPS[@]}"; do
  IFS='|' read -r name params a b s fps pre <<< "$c"
  out="captures/$name"; mkdir -p "$out/seq"
  total=$(python3 -c "print(int(round(($b-$a)/$s))+1)")
  n=$(ls "$out/seq" | grep -c '\.png$')
  if [ "$n" -ge "$total" ] && [ -f "$out/$name.mp4" ]; then echo "$name: done"; continue; fi
  [ "$n" -eq 0 ] && pre=0
  # warm-up so the simulation starts at a - WARM0, like an uninterrupted run
  warm=$(python3 -c "print(repr($WARM0 + $n*$s - $pre))")
  echo "$name: frames $n/$total, warm-up $warm"
  node tools/spike-capture.mjs --w 960 --h 540 --timeout 30000 --out "$out" \
    --params "$params&warmup=$warm" --seq "$a:$b:$s" --from "$n" --preroll "$pre:0.2" \
    --fps "$fps" --video "$name.mp4" >> "captures/$name.log" 2>&1
  echo "$name: exit $? frames $(ls "$out/seq" | grep -c '\.png$')/$total"
done
echo ALL CLIPS DONE
