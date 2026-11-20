# LOG — decisions, defaults, known issues (newest last)

- 2026-11-20 Fresh start on branch `claude/bluecurl-viz` from `claude/trusting-pascal-l7a99k` (d81139a). An earlier attempt (`claude/bluecurl-swell`, commit cd5309d, now unreferenced) was discarded at the user's request; nothing reused.
- Lanes map spatially along one straight crest spanning the bay (z −260…260); zones are depth stages with their own crest ranges (see DESIGN.md). Swell reaches outer → point → inside; residual energy re-forms.
- Break phase per column is defined once in JS (`contracts.breakStartTime` / `localTau`) and mirrored in GLSL — sim, riders and shader agree by construction.
- Foam: analytic from τ (age since break) instead of the research's persistence texture — keeps every frame a pure function of (state, t) so captures resume from any frame.
- Defaults: bpm 120, bars 8 (16 s), travel 14 s, set 3 × 2.5 s (clamped to fit interval), commitLead 3 s, energy half-life 20 s, lane σ 0.8, ambient 0.22 m/12 s + 0.12 m/17 s, Shift = soft note 0.4.
- Capture runs headless Chrome on the real GPU (RTX 5050 laptop present). ffmpeg at `C:/dev/ffmpeg/bin/ffmpeg`. Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`.
