# PLAN — source of truth (update status as packages land)

Branch `claude/bluecurl-viz`. Interfaces: `src/contracts.js` (+ stubs with exact export signatures). Design: `DESIGN.md`. Decisions: `LOG.md`.
Rules for every package: commit **only your own files** (`git commit -m … -- <paths>`), never `git add -A`, never stash/checkout/reset/rebase/switch branch, never push (orchestrator pushes). Don't edit `contracts.js`; request changes in your report.

| WP | Package | Owns | Needs | Done when | Status |
|---|---|---|---|---|---|
| 1 | App shell: loop, fixed-step clock, test hooks, HUD, system wiring; copied FFT ocean, water optics, sky, post, gpu, foamNoise (MIT attribution) | index.html, src/main.js, src/core/*, src/water/*, src/sky/*, src/post/*, src/hud/*, THIRD_PARTY.md, test/clock.test.mjs, tools/shot.mjs | contracts | build ok; dawn ocean+sky still; `__advance` determinism test; Post viewport render | done |
| 2 | Spot: headland+cliff, palms, beach, sea floor zones, bathymetry JS+GLSL | src/spot/*, dev/spot.html | contracts | still from default camera; depthAt matches zones | done |
| 3 | Input API + swell sim + energy→wave mapping + demo script | src/input/*, src/sim/*, test/input.test.mjs, test/swell.test.mjs, demo/*.json | contracts | tests: determinism, 4/16/32 grid, sets, ambient never breaks, 5 input-shape cases | done |
| 4a | Wave geometry: keyframes, profile(), field.js JS mirror, GLSL mirror, parity test | src/wave/profile.js, keyframes.js, field.js, profile.glsl.js, test/wave*.mjs, dev/wave-parity.html | contracts | JS tests + GPU parity < 1e-3 m; profile strip image | done |
| 4b | Wave renderer: mesh per front, ocean coupling, lip translucency, foam, spray | src/wave/WaveMesh.js, src/wave/foam*.js, src/wave/spray*.js | 1,3,4a | still of breaking wave in app | done |
| 5 | Input feedback fx: shimmer, glow, particles, dolphin jumps | src/fx/* | 1,3 | keypress visible next frame (frame diff) | done |
| 6a | Rider sim: state machine, wave choice, ride styles, planner | src/riders/Riders.js, src/riders/plan*.js, test/riders.test.mjs | 3,4a | deterministic rides; every rider returns to lineup | done |
| 6b | Rider models + animation | src/riders/RiderViews.js, src/riders/models/* | 6a contract | silhouettes read in wide + PiP | done |
| 7 | Camera: wide default + automatic PiP | src/camera/* | 1, 6a contract | PiP on each takeoff, not covering lineup | done |
| 8 | Capture: resumable frames + video, demo runner | tools/capture.mjs, tools/clips.sh | 1 | resume reproduces identical frames; mp4 | done |
| 9 | Optional: verify research sources | docs/research notes | – | – | deferred |

Integration (orchestrator): after each wave, build + deterministic stills via `tools/shot.mjs`; reviewer sub-agent checks milestone vs success test.
Milestone: (1) keys 1–8 visibly feed fronts that roll in; (2) breaks at the point on 4/16/32 s grid shaped by input; (3) riders take waves and paddle back; (4) PiP on each ride.

## Status after milestone 1 (2026-11-20)
All packages landed; two review rounds + two fix rounds; 105/105 tests.
Final capture: `node tools/capture.mjs --name final-demo-basic --demo demo/demo-basic.json --from 0 --to 92 --fps 30 --w 1920 --h 1080 --video`.
Known issues / next:
- soft few-note fronts still pale in the wide view;
- fx CPU ~0.6–1.2 ms/frame (over the 0.5 ms target); PiP draws the wave geometry a second time (~0.5 ms GPU);
- rare tau pop when a column re-forming from an outer break starts its point break;
- HUD is DOM-only (not in captures);
- end-to-end live fps with every system on not yet measured (only per-component GPU ms);
- WP9 research-source verification deferred.

## Milestone 2 — guitar (Tuninator), beat, rider presence, splash + birds (2026-11-20)
Interfaces: contracts.js sections "guitar input", "beat", "riders" (presence), "note splash + birds".

| WP | Package | Owns | Needs | Done when | Status |
|---|---|---|---|---|---|
| 10 | Guitar input: Tuninator recognizer → GuitarMapper (key/octave/chord key change) → impulses | src/input/guitar*.js, test/guitar*.test.mjs, public/tuninator/*, package.json dep | contracts | mapper rule tests; offline Tuninator fixtures → lanes; mock + live in app | done (de271c4) |
| 11 | Beat: 4/4 bar clock, 8 levels from notes/measure (±1 per measure), Web Audio surf/tropical groove, HUD tempo control + beat/guitar readout | src/beat/*, src/hud/*, test/beat*.test.mjs | contracts | level-rule tests; audible 8 patterns with accented 1; bpm editable in HUD | done (92c93d5) |
| 12a | Rider presence: 8 riders follow beat level, 4-measure swim out / leave, flock events | src/riders/Riders.js, plan.js, brain.js, test/riders*.test.mjs, tools/rides-report.mjs | 11 contract | presence + flock timing tests; all old ride tests still pass | done (5fc03c1) |
| 12b | Rider views: Noa (surfer) + Honu (turtle) models, enter/leave animation, hidden ASHORE | src/riders/RiderViews.js, src/riders/models/* | 12a contract | stills of turtle + surfer in wide and PiP | done (d1caadb) |
| 13 | Note splash + birds (per note, circling then away) + flock bursts | src/fx/* | contracts | keypress → massive splash + bird next frame; flock still | done (6a250b1) |
Orchestrator: contracts, App/main wiring, demo-guitar script, docs, integration stills, review.
