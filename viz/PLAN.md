# PLAN — source of truth (update status as packages land)

Branch `claude/bluecurl-viz`. Interfaces: `src/contracts.js` (+ stubs with exact export signatures). Design: `DESIGN.md`. Decisions: `LOG.md`.
Rules for every package: commit **only your own files** (`git commit -m … -- <paths>`), never `git add -A`, never stash/checkout/reset/rebase/switch branch, never push (orchestrator pushes). Don't edit `contracts.js`; request changes in your report.

| WP | Package | Owns | Needs | Done when | Status |
|---|---|---|---|---|---|
| 1 | App shell: loop, fixed-step clock, test hooks, HUD, system wiring; copied FFT ocean, water optics, sky, post, gpu, foamNoise (MIT attribution) | index.html, src/main.js, src/core/*, src/water/*, src/sky/*, src/post/*, src/hud/*, THIRD_PARTY.md, test/clock.test.mjs, tools/shot.mjs | contracts | build ok; dawn ocean+sky still; `__advance` determinism test; Post viewport render | wave 1 |
| 2 | Spot: headland+cliff, palms, beach, sea floor zones, bathymetry JS+GLSL | src/spot/*, dev/spot.html | contracts | still from default camera; depthAt matches zones | wave 1 |
| 3 | Input API + swell sim + energy→wave mapping + demo script | src/input/*, src/sim/*, test/input.test.mjs, test/swell.test.mjs, demo/*.json | contracts | tests: determinism, 4/16/32 grid, sets, ambient never breaks, 5 input-shape cases | wave 1 |
| 4a | Wave geometry: keyframes, profile(), field.js JS mirror, GLSL mirror, parity test | src/wave/profile.js, keyframes.js, field.js, profile.glsl.js, test/wave*.mjs, dev/wave-parity.html | contracts | JS tests + GPU parity < 1e-3 m; profile strip image | wave 1 |
| 4b | Wave renderer: mesh per front, ocean coupling, lip translucency, foam, spray | src/wave/WaveMesh.js, src/wave/foam*.js, src/wave/spray*.js | 1,3,4a | still of breaking wave in app | wave 2 |
| 5 | Input feedback fx: shimmer, glow, particles, dolphin jumps | src/fx/* | 1,3 | keypress visible next frame (frame diff) | wave 2 |
| 6a | Rider sim: state machine, wave choice, ride styles, planner | src/riders/Riders.js, src/riders/plan*.js, test/riders.test.mjs | 3,4a | deterministic rides; every rider returns to lineup | wave 2 |
| 6b | Rider models + animation | src/riders/RiderViews.js, src/riders/models/* | 6a contract | silhouettes read in wide + PiP | wave 2 |
| 7 | Camera: wide default + automatic PiP | src/camera/* | 1, 6a contract | PiP on each takeoff, not covering lineup | wave 2 |
| 8 | Capture: resumable frames + video, demo runner | tools/capture.mjs, tools/clips.sh | 1 | resume reproduces identical frames; mp4 | wave 2 |
| 9 | Optional: verify research sources | docs/research notes | – | – | deferred |

Integration (orchestrator): after each wave, build + deterministic stills via `tools/shot.mjs`; reviewer sub-agent checks milestone vs success test.
Milestone: (1) keys 1–8 visibly feed fronts that roll in; (2) breaks at the point on 4/16/32 s grid shaped by input; (3) riders take waves and paddle back; (4) PiP on each ride.
