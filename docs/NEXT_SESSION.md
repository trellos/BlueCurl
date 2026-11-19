You're building the first runnable piece of BlueCurl: a browser-based "Surf Lab" where a realistic surfer stands on a procedural surfboard and reacts convincingly to board motion and to a live performance stream. Research is done; this session is implementation.

## Context (read first, briefly)
- Repo: trellos/BlueCurl. The research is in `docs/research/`. Read `README.md` (summary + decision log) first. Then read `10-lab-architecture.md` (lab design), `05-runtime-animation-tech.md` §7–10 (rider architecture) and `03-surfboards.md` §4 and §6 (board geometry + anchor schema). Skim the others only when needed.
- Visual target: realistic sports cinematography, seen from a continuous rear chase camera. Not stylised, not gamey. Believability is the only criterion.
- Ocean and wave rendering belong to a separate effort, the ShoreBreak wave renderer (https://github.com/cryptomanavan/ShoreBreak: three r186, WebGL2, metres, y-up). Don't depend on it. Use a simple analytic stand-in wave face, which real wave queries replace later. Everything else (surfer, board, board motion, animation, camera, lighting) is ours.

## Repo layout and the parallel wave work
- This repo is shared with the wave-renderer effort. Branch `shorebreak-original` holds ShoreBreak. Branch `claude/trusting-pascal-l7a99k` holds the wave session's work: a peeling-wave surf demo in `src/surf/` with `Board.js`, a planned board trajectory over the wave, a GPU water-height probe and a chase camera. **Read those files for ideas, don't modify that branch.**
- Its board convention differs from ours: +x nose, +z right rail, origin on the bottom. Ours is glTF-style: +Z nose, +Y deck normal, +X left rail. Provide a small conversion so the two can be merged later.
- **Put all lab code under `lab/`** with its own `package.json`. ShoreBreak owns the root `package.json` and `src/`, so a root-level app would collide at merge time.
- Base your branch on `claude/wonderful-knuth-7dtpcs`, which has the research docs.

## Owner decisions (don't re-litigate)
- **Instant reaction:** every input from the 500 ms stream must show on the next frame, including the start of a maneuver. No playout buffer or input delay. Smoothness comes from springs with asymmetric attack (1–3 frames) and slower release. Anticipation comes from the body leading: head, shoulders and compression start immediately and the board follows about 0.2 s later.
- **No motion capture.** Use existing animations as placeholders, an authored key-pose library, and the procedural board-frame layer.
- **Use an existing downloadable rigged realistic human** for development. A licence that allows internal use is enough for now; note the licence in an assets manifest.
- Don't ask about teams or ownership. Don't propose spend. Keep questions to real blockers.

## Build (in this order; each step runnable and committed)
1. **Lab shell.** Vite + TypeScript + `three@0.186.0` (pinned) + lil-gui:
   - orbit camera and rear chase camera (spring follow: 5 m back, 2 m up, 45° vertical FOV, level horizon with 15–30% roll pass-through, 0.3–0.5 s yaw lag);
   - lighting presets B Golden Hour, D Soft Overcast and Studio, using a CC0 Poly Haven HDRI plus a sun with one tight shadow map on surfer and board;
   - AgX tone mapping;
   - time controls: pause, slow motion, single-frame step;
   - PNG screenshots;
   - a performance HUD.
2. **`boardkit` v0.** A procedural 6'0" thruster shortboard from a `BoardSpec` (outline, rocker, foil, deck dome, rails, 3 fins), in board frame +Y deck normal, +Z nose, +X left rail, metres. It exposes anchors (`ANC_foot_front/back_regular/goofy`, hand pop-up points, leash plug, fins, pivot) and a `deckFrame(z, x)` query that returns the deck point and normal. Materials: sanded or gloss clearcoat, wax, tail pad.
3. **Placeholder surfer.** Find, download and convert to GLB a realistic rigged athletic adult (male to start). Prefer twist bones; 4 skin influences.
   - Reachable hosts include GitHub, sketchfab.com, poly.pizza, quaternius.com and PyPI. Headless Blender is available via `pip install bpy` for conversion.
   - If a source needs a login or API token (e.g. Sketchfab downloads), ask once for the credential via the secure form rather than giving up.
   - Fallbacks: Microsoft Rocketbox (MIT, GitHub) or Meta MHR (Apache-2.0, has a GLB exporter).
   - Pose-test it in deep crouch, 45° torso twist with arms out, and an aerial tuck, viewed from the chase camera. Report deformation problems honestly with screenshots.
4. **Rider v0.** Our own pose pipeline on Float32Array local poses. Do **not** use `AnimationMixer` for the surfer: it rewrites bones only when values change, which breaks procedural edits.
   - Static key poses: stance, crouch (3 levels), lean deltas, twist deltas, arm sets.
   - Analytic two-bone leg IK locking the feet to the board anchors. Target foot drift < 2 mm.
   - The pelvis and upper body follow the apparent-gravity vector `f_B = R_Bᵀ(a − g)` through spring-dampers, so the body does not rotate rigidly with the board. Knees and ankles absorb pitch and roll; the head keeps the horizon mostly level.
   - Stability drives force-noise, damping and graded recovery: arms out → stumble step → fall.
5. **Board-motion generator + stream simulator.**
   - Manual pitch/roll/yaw/impulse sliders.
   - Generators on the stand-in wave face: trim, pump, bottom turn (lean ≈ `atan(v²/rg)`), top turn, cutback, chop.
   - A 500 ms performance-stream simulator (magnitude, stability, events) with presets: cruise, escalating, struggling, wipeout.
   - Debug overlays: board frame axes, `f_B`, centre of mass with support polygon, foot contact error in mm, live signal plots.
6. **Placeholder clips.** Paddle or swim cycles and a pop-up from free sources (or author them in Blender), stored relative to the board.

## Working rules
- Commit and push small, working steps to the session's branch. Keep a short "Lab log" section in `docs/research/README.md` with the decisions made and anything rejected.
- Verify visually: render screenshots with the pre-installed Playwright/Chromium and look at them before claiming something works. Judge against real surf footage (`docs/lookbook/`, `docs/research/01-visual-references.md`).
- Measure what the acceptance tests name: foot drift, lean angle, per-frame animation CPU (< 0.5 ms target).
- Be concise with the owner. Recommend, don't survey.
