# LOG — decisions, defaults, known issues (newest last)

- 2026-11-20 Fresh start on branch `claude/bluecurl-viz` from `claude/trusting-pascal-l7a99k` (d81139a). An earlier attempt (`claude/bluecurl-swell`, commit cd5309d, now unreferenced) was discarded at the user's request; nothing reused.
- Lanes map spatially along one straight crest spanning the bay (z −260…260); zones are depth stages with their own crest ranges (see DESIGN.md). Swell reaches outer → point → inside; residual energy re-forms.
- Break phase per column is defined once in JS (`contracts.breakStartTime` / `localTau`) and mirrored in GLSL — sim, riders and shader agree by construction.
- Foam: analytic from τ (age since break) instead of the research's persistence texture — keeps every frame a pure function of (state, t) so captures resume from any frame.
- Defaults: bpm 120, bars 8 (16 s), travel 14 s, set 3 × 2.5 s (clamped to fit interval), commitLead 3 s, energy half-life 20 s, lane σ 0.8, ambient 0.22 m/12 s + 0.12 m/17 s, Shift = soft note 0.4.
- Capture runs headless Chrome on the real GPU (RTX 5050 laptop present). ffmpeg at `C:/dev/ffmpeg/bin/ffmpeg`. Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- WP1 landed: RTX 5050 via headless Chrome flags `--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist --force_high_performance_gpu`; 3.7 ms GPU @1080p (ocean+sky+post). `npm test` = `node --test "test/*.test.mjs"` (Node 24 rejects a directory).
- WP3 landed: demo-basic gives 5 distinct sets (soft / barrel / wall / south-peak peeling right / close-out). First set point at 16 s for all intervals.
- WP2/WP4a landed. WP2 found the default camera could not frame all three zones; the only camera that did put the point ~370 m away (a 2.6 m wave ≈ 9 px at 1080p). Decision: compact the layout ×0.6 (FRONT_W 312, zone lines 180/100/33, PATH 600/180/100/33/0) and fantasy-scale heights (Hscale 2.0/1.3/0.7, Hbreak 3.0/0.9/0.45). WP2/WP3/WP4a re-tuned to match.
- breakStartTime sections: was a discontinuous staircase (mesh tears, per WP4a); now smooth monotone `s − 0.75·sin(ws)/w`. Remaining discontinuities (peel end, zone edges) are hidden by the sim tapering H there.
- Known: in the bay, set fronts are ~20 m apart but a profile is ~40 m wide → WP4b clips each mesh at the midpoint to its neighbours.
