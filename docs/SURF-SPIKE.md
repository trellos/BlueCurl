# Surfing visualization — wave rendering spike on ShoreBreak

_Status: concluded. **Verdict: ShoreBreak is not suitable as the rendering foundation for surfable waves.** Its ocean is a
single-valued heightfield built for a 0.45 m shore break; the overturning lip is a separate thin ribbon, the broken wave's
surface vanishes after impact and its foam / swash systems are tied to the Nice near-shore zone. The spike did prove the
indefinite peel (stage = f(t − x/v_peel)) and produced a reusable surf rig (board, wave-coordinate planner, chase camera).
The comparison of alternatives and the recommended approach (a swept-profile wave mesh) are in
[research/WAVE-RENDERING.md](research/WAVE-RENDERING.md)._

## 1. What ShoreBreak is

ShoreBreak (MIT, © Christopher Canavan; Three.js r186, WebGL 2) is a real-time **shore-break**
renderer calibrated frame-by-frame to one phone video of ~0.45 m waves dumping on the steep pebble
beach of the Baie des Anges (Nice). Its water is the sum of separate, carefully coupled systems:

| System | Files | What it is |
| --- | --- | --- |
| Wave schedule | `src/core/schedule.js` | Deterministic list of breaker *events* (time, height, landing line, peel timing), with an exact JS mirror (`brkTiming`) of the shader timing |
| Breaker profile | `src/glsl/breaker.js` | Per along-shore column `x`, a **2D cross-shore profile** `eta(z)` driven by a measured stage table (18 knots, tau = -6 … +0.85) on a per-column clock `ti(x)`; Froude-scaled by `s = H/0.45` |
| Plunging lip | `src/water/LipRibbon.js` | A separate swept sheet (jet, curtain, barrel ceiling, fillet, wall) per event, ±40 m around the focus, 2 slots |
| Wind sea | `src/water/OceanFFT.js` | 3-cascade GPU FFT (41 m / 7.3 m / 1.37 m), displacement + LEAN slope textures |
| Offshore swell | `src/water/Swell.js` | 256×512 field texture of the same events beyond ~22 m |
| Swash | `src/swash/SwashSim.js` | GPU shallow-water solver (22 m × 18 m scrolling window, 3 cm cells) + analytic far field |
| Whitewater | `src/whitewater/` | CPU-scheduled GPU particles (splash domes, jets, spray, bore foam) from `brkTiming` |
| Surface optics | `src/glsl/water.js` | Refraction/absorption to an analytic bed, sky-integrated reflection, LEAN, glints, crest backlight, foam |
| Water mesh | `src/water/ExploreMesh.js` | Focus-following CDLOD band (rows world-fixed, columns on power-of-two lattices) + ocean fan to the horizon |

The ocean surface is a **single-valued heightfield** (`y = f(x, z)`); everything that overturns lives
in the lip ribbon.

## 2. How a continuously peeling wave was obtained without replacing the breaker

Each column `x` runs the same 2D breaker on its own clock `ti(x)`. The original events peel only
locally (a bounded logistic/quadratic peel, or a ±1.5 s sinusoidal modulation along the beach).
Surf mode (`?surf`, compile-time `OPT_SURF`) adds an **unbounded linear peel** to that clock:

```
ti(x) = t0 + (dir / v_peel) · x  + (existing bounded modulation, staircase, wobble)
```

(`brkAt()` in `glsl/breaker.js` and its mirror `brkTiming()` in `core/schedule.js`; the slope is
carried in the otherwise unused `uEvtD` slot, so every consumer — heightfield, lip ribbon, swell
field, particles, bubbles, swash injection — picks it up unchanged.)

Because the stage then depends only on `t − x/v_peel`, **each event becomes a pattern that
travels along the coast at the peel speed and is steady in its own frame**: unbroken shoulder ahead,
steepening face, lip, impact and collapse behind. Followed at the peel speed, it peels for as long as
the world extends along `x` — indefinitely in time, with no rescheduling. A train of `SURF_EVENTS = 4`
such waves (period ~12 s) provides the next lines of the set offshore. The bounded `far` modulation is
kept at ±25 % of the peel rate so that sections peel faster and slower, and the existing along-crest
height/landing-line variation provides natural variety along the ride.

What had to be changed for the bigger, further-out wave (all behind `OPT_SURF` / `CONFIG.surf`, the
original modes compile exactly as before):

* fixed z ranges tied to the Nice beach (crest-optics birth fades at −13…−23 m, the wave-zone gate at
  −18 m, the analytic-breaker / swell-field hand-over at −22…−32 m) are moved offshore;
* the explore water mesh gets a uniform 2.5 cm row band over the surf zone (landing line +3 m …
  −16 m) and the ocean fan starts at −45 m instead of −16 m;
* the swell field (fixed ±512 m) follows the focus in whole 4 m texels (`uSwellX0`);
* the schedule keeps the surf events always active and picks lip-ribbon slots analytically around the
  focus (the original precomputed ±200 m tables would run out);
* face steepness scales the stage table's front/back face lengths.

Parameters (URL or `?gui` panel): `height` (face height, m), `steep`, `curl` (plunge style + lip
throw), `peel` (m/s), `dir` (±1), `chop` (FFT amplitude, live), `zbreak`, `period`, `seed`.

## 3. Board, trajectory and camera

* `src/surf/Board.js` — lofted 6'0" thruster: 1.83 m × 0.483 m × 62 mm, 12.5 cm nose / 4.5 cm tail
  rocker, soft rails, three fins, stringer and tail pad, lit with the scene's sun/sky constants and
  drawn in the opaque pass (so the water refracts and occludes its wetted bottom).
* `src/surf/SurfProbe.js` — samples the **rendered** water height (the water mesh's own
  `waterParts`: breakers + FFT + swash, with the horizontal chop displacement inverted) at the
  board's nose, tail, rails and centre each frame. The board origin sits 2.2 cm below the centre
  sample; its normal is the plane through the four outer samples; it banks into the turn by up to
  ~24° from the lateral acceleration.
* `src/surf/SurfDemo.js` — the path is planned in **wave coordinates** as pure functions of time:
  `alpha(t)` (the wave's arrival clock at the board = how far ahead of the curl) and `h(t)` (position
  across the face, apex → toe → flats). Seeded, jittered keyframes repeat the cycle
  _cruise → climb → descend → bottom turn → return_; every third cycle is set up deeper. World `x`
  solves the arrival clock (Newton), `z` comes from the CPU mirror of the profile (`waveGeom.js`) of a
  smoothed copy of the event (crest wobble and the 0.45 m closing staircase removed — a rider does not
  trace 1–3 m crest ripples; the probe still gives the true local surface).
* Chase camera: 4 m behind the board along an exponentially smoothed heading (τ ≈ 0.6 s), 2 m above
  an exponentially smoothed board height (τ ≈ 0.45 s), kept ≥ 0.8 m above the water under it, looking
  2.5 m ahead of the board; yaw and pitch only — **roll is always zero** (horizon stabilised).
