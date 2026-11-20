# BlueCurl Swell — design (first prototype)

A stylised surf-fantasy visualizer for live music. Notes add energy to swell fronts that roll in from the horizon and break at a fictional east-facing point break. Surfers, dolphins and seals ride them. The target is stylised realism (GTA V / Saints Row), dawn patrol, saturated and juicy. Shared interfaces live in `src/contracts.js`; this file is the why and the defaults.

## Spot
World axes: +X east (seaward, sunrise), +Y up, +Z north. Waves travel toward −X. The sun is low in the east (about 6°), behind the swell, so the lips are backlit.
- **Headland (the point):** north side, with a ~30 m cliff and palms; its tip is near (70, 57).
- **Bay:** a beach at x≈0 to the south.

Three zones are reached in this order:

| zone | break line x | crest z-range | character |
|---|---|---|---|
| outer reef | 180 | 18…138 | biggest, hollow, short peel; needs a lot of energy (H ≥ 3 m) to break |
| point | 100 | −72…54 | long peeling wall, the main break |
| inside | 33 | −141…−21 | small, mellow beach break |

A front is one straight crest across the bay (z −156…156). The layout is compact (×0.6 of the first draft) and the heights are fantasy-scaled, so waves read in the wide view. Each zone breaks the columns inside its range. Whatever passes a zone unbroken, plus 35–40 % of what broke, re-forms smaller toward the inside.

## Swell and input
- **Lanes:** keys 1–8 are lanes 0–7 along the crest, south→north, which is screen left→right from the cliff camera. Shift+key gives a soft note (0.4); a plain key is 1.0. Keyup is logged, so duration is available later.
- **Harness API:** `window.bluecurl.impulse({lane, lanes: 8|15, scale, velocity, duration, time})` and `release(id)`.
- **Where impulses go:** each impulse deposits energy on the front currently receiving input. That is the earliest front that has not yet committed at the outer reef. If none is on the water, it goes to the next scheduled front, shown as a glow at the horizon. The deposit is gaussian across columns (σ 0.8 lane), and energy decays with a half-life of 20 s.
- **Timing:** interval = bars × 4 × 60 / bpm, with bars ∈ {2, 8, 16}, i.e. 4, 16 or 32 s at 120 bpm. Key `I` cycles it, `[ ]` changes bpm, `, .` changes travel.
  - The first front of each set reaches the point line exactly on the interval grid.
  - A set is `setSize` fronts (default 3) spaced `setSpacing` (2.5 s) apart, clamped so the set fits inside the interval (one front at 4 s).
  - Travel from horizon to point defaults to 14 s.
  - Config changes are logged as input events, so replays reproduce them.
- **Ambient swell:** two long, gentle sines (0.22 m at 12 s and 0.12 m at 17 s) lift the lineup. Fronts with no input stay below every zone's break height, so silence rolls through without breaking.

## Energy → wave (per front × zone, frozen `commitLead` = 3 s before the break)
The stats come from the energy in the zone's columns:
- `E`: the sum;
- `centroid`: where along the crest the energy sits;
- `spread`: normalised standard deviation;
- `strength`: mean impulse strength;
- `erratic`: variation in timing and strength;
- `count`.

| input | wave |
|---|---|
| many strong, concentrated | big, steep, hollow: high `curl`, barrel time |
| strong, spread out | steep wall for turns: high `steep`, moderate curl, long peel |
| few, mellow | small, soft, slow peel: low steep/curl, low vPeel |
| weighted to one side | peak at the centroid; peels away from the heavy side (A-frame when centred) |
| weak or erratic | mush (soft profile), `sections` 2–3, or `closeout` when erratic and strong |

Height: `H = Hscale · (0.35 + 2.4·(1 − e^(−E/6)))`; the zone breaks if `H ≥ Hbreak`. Ride quality has four parts: size, steepness, barrel time (≈ curl·H/vPeel·k) and peel length.

## Wave technique
This follows the swept-profile approach in `docs/research/WAVE-RENDERING.md`.
- **Cross-section keyframes:** swell → steepen → throw → plunge → collapse. Each is resampled to equal arc length with the same point count, and the lip may overhang. Re-forming (τ 1→2) blends from collapse back to swell.
- **Shape parameters:** `steep`, `curl` and `mush` deform the keys; `H` scales them.
- **Sweep:** the break phase of each crest column is `τ = (t − breakStartTime(zb, u)) / Tb`. That is f(s − v_peel·t), written once in JS in `contracts.js` and mirrored in GLSL.
- **Mesh:** one double-sided mesh per front: about 200 columns along the crest × 64 points across the profile, refined near the lip. Per-column H/steep/curl/mush go to the GPU as a small float texture each frame.
- **JS mirror** (`src/wave/field.js`): gives rider position, normal and velocity, the tube centre and the lip. A parity test compares JS and GPU to within 1e-3 m.
- **Water:** the FFT ocean surrounds the wave mesh, and the wave mesh carries the FFT chop, faded out on the face and lip. The lip is translucent through ShoreBreak's `shadeWater` (thickness, absorption, forward scatter); thickness comes from the profile.
- **Foam and spray:** foam is analytic from τ and age in wave coordinates, with detail advected in world space, never a GPU persistence texture. This keeps frames resumable. Spray is analytic particles emitted along the lip and crash curve, backlit with Henyey-Greenstein scattering. Foam and mist are what carry scale in the wide view.

## Riders (6)
Two surfers (Kai, Moana), two dolphins (Flip, Echo) and two seals (Pudge, Gus).
- **States:** `LINEUP → POSITION → TAKEOFF → RIDE → KICKOUT | CLOSEOUT → RETURN → LINEUP`.
- **Picking a wave:** when a zone break commits, riders whose preferred zones match compete. The pick is seeded by event id, with a cool-down.
- **Ride style comes from the wave:**
  - `cruise` (trim) on a slow, soft peel;
  - `carve` (bottom turn, lip hit, cutback) on a steep wall;
  - `tube` when the curl is high;
  - dolphins `porpoise`, and seals `breach`/bodysurf.
- **Planning:** paths are planned in wave coordinates (u, σ) with seeded Hermite keyframes, adapted from `src/surf/SurfDemo.js`, and evaluated through `field.js`. A ride ends in a kick-out over the shoulder, or a close-out when the peel overtakes the rider; then the rider paddles or swims back.

## Camera
- **Default view:** wide and elevated from the headland (around (40, 55, 150)), looking ESE over the lineup toward the sunrise, so fronts roll toward the viewer.
- **PiP:** a follow cam of the rider fills a third of the screen in the bottom-right corner, which sits over the headland, not the lineup.
  - Triggers are tunable: on take-off, on barrel, `minHeight`, `maxConcurrent`, `holdAfterRide`.
  - Smoothing is stepped at the sim DT, so the PiP is deterministic.

## Determinism and capture
- **Simulation:** fixed step DT = 1/120; `state(t) = f(cfg, input log)`; no `Math.random`.
- **Visuals:** a pure function of (sim state, t).
- **Hooks:** `window.__advance(sec)` uses `round(sec/DT)` with a 1 %·DT tolerance; `?t0=` fast-forwards sim-only for resumable captures; `?capture=1` disables RAF and HMR.
- **Capture:** headless Chrome on the real GPU, with frames written to `captures/<name>/%05d.png`. A resume counts the frames already on disk; ffmpeg turns them into the video.

## Look and performance
- **Look:** dawn grade with teal/jade water, turquoise only where light passes through the lip, a gold sun path, and warm-tinted foam. Backlit spray and lips are the brightest pixels; bloom applies only above the threshold. Feedback accents are warm gold and cyan.
- **Performance:** 60 fps in desktop Chrome (RTX 5050 laptop). FFT 256², wave meshes ≤ 200k vertices in total. The HUD shows fps, GPU ms (timer query), fronts and energies, wave parameters and the interval.
