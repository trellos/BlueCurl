# 10 — Asset viewer and animation laboratory ("Surf Lab"): architecture proposal

Status: proposal v1, 2026-11-19. Not yet implemented.
Builds on [05-runtime-animation-tech.md](05-runtime-animation-tech.md) (runtime design),
[03-surfboards.md](03-surfboards.md) (board kit and anchor schema),
[02-character-assets.md](02-character-assets.md) (character pipeline) and
[06-environments-and-lighting.md](06-environments-and-lighting.md) (lighting contract).

## 1. Purpose and principles

The lab is a standalone browser app for iterating on **character quality, the board and
animation** without the wave renderer. It must answer: *does this surfer, on this board,
reacting to this board motion and this performance stream, look believable from the rear
chase camera?*

Principles:

1. **The lab hosts the real runtime modules, not throwaway prototypes.** The rider pose
   pipeline, the board kit, the stream playout and the look/lighting presets are **production
   packages**. The lab is just one host; the final visualization is another.
2. **Deterministic and reproducible.** Fixed-step simulation, seeded noise, recorded inputs. Any
   moment can be replayed, stepped frame by frame and captured identically. A review comment
   like "the knee pops at 12.4 s in scenario `cutback-wobble`" must be reproducible by anyone.
3. **Judged against real footage.** Reference-video overlay and side-by-side are first-class
   features, not extras.
4. **Same stack as ShoreBreak:** Three.js r186 (pinned, matching ShoreBreak; upgrade together),
   WebGL2, Vite, plus **TypeScript** for our code. That makes later integration a drop-in.
5. **Measure everything.** Every pipeline stage is timed; contact error is measured in mm.

## 2. Package layout

```
bluecurl/
  packages/
    boardkit/        # procedural board: BoardSpec → geometry, anchors, deck queries (runtime + build)
    rider/           # pose pipeline: sampler, blender, inertialization, IK, balance model, springs,
                     #   secondary motion, ragdoll bridge (Jolt, lazy-loaded)
    surfsim/         # board motion: lab trajectory generators now; wave-coupled surfing sim later
    stream/          # performance stream: playout buffer, interpolation, impulses, simulators, recorder
    look/            # lighting presets, sky provider adapter, IBL, shadows, post/tone/LUT, wet materials
    assets/          # manifests, loaders (GLTF + KTX2 + meshopt), skeleton retarget maps
  apps/
    lab/             # this app
  tools/
    blender/         # bpy scripts: character export, correctives bake, GLB optimisation
    board-bake/      # node: BoardSpec presets → GLB + LODs
    capture/         # playwright: batch renders, contact sheets, regression images
  scenarios/         # versioned JSON test scenarios (see §6)
  docs/research/     # this research
```

## 3. Scene and modules

```mermaid
flowchart LR
  subgraph Inputs
    SS[Stream simulator<br/>presets / script / recorded file] --> PB[stream: playout buffer]
    TR[Board trajectory source<br/>sliders / generators / recorded 6DoF] --> BM
  end
  PB --> PL[rider: intent planner]
  PL --> BM[surfsim: board motion<br/>120 Hz fixed step]
  BM --> RK[rider: board kinematics f_B]
  PL --> RP[rider: param controller → pose synth → IK → balance → secondary]
  RK --> RP
  RP --> SK[SkinnedMesh]
  BM --> BD[boardkit mesh]
  SK & BD --> R[look: renderer, lights, IBL, shadows, post]
  R --> V[viewport(s)]
  DBG[debug overlays + scopes] --> V
  CAP[capture: PNG / WebCodecs MP4 / Playwright] --> V
```

### 3.1 Stage

- A neutral **"lab sea"** plane that is *not* the wave renderer:
  - a large plane with a cheap normal-mapped surface, or a few Gerstner waves;
  - a waterline cut showing how deep the rails and fins sit;
  - a **virtual wave face**: an analytic, inclined, curved surface the board can ride on.
    It gives correct gravity directions for wave-face trim and turns without any fluid
    rendering.
- Optional studio stage: grey floor, turntable, neutral HDRI. Use this for character and board
  inspection.

### 3.2 Characters, boards and clips (hot-swappable)

- **Character registry:** `assets/characters/*.json` lists the GLB, the skeleton map to the
  canonical BlueCurl skeleton, the corrective drivers, material parameters and wardrobe
  variants.
- **Board registry:** BoardSpec presets (shortboard, fish, mid, longboard, gun). The board can
  be regenerated live from sliders through `boardkit`; anchors update instantly.
- **Clip library:** clips and static key poses on the canonical skeleton, stored in board frame
  B, with `AnimationClip.userData` for phase and contact markers.
- Drag-and-drop a GLB, or a BVH/FBX-converted clip, to test new sources (character bake-off,
  mocap sessions, HMR results).

### 3.3 Board motion simulator (lab version)

The lab version runs without the wave renderer. It provides four trajectory sources, all
producing a 120 Hz board state history with **future samples** (to match the playout-buffer
design):

| Mode | Use |
|---|---|
| **Manual**: sliders for pitch, roll, yaw, heave, plus buttons for impulses (chop bump, deceleration, lateral kick) | Isolating responses; tuning springs |
| **Generators**: parametric moves on the virtual wave face: trim line, pump cycle (frequency, amplitude, roll), bottom turn (speed, radius → lean), top turn/snap (pivot rate), cutback, rail-to-rail, chop noise, air (ballistic plus rotation), landing impact | Maneuver tuning; "does the lean match `atan(v²/rg)`?" |
| **Scripted sequences**: chains of generators on a timeline | Repeatable review scenarios |
| **Recorded 6DoF**: board trajectories estimated from video (experiment V2), or from a phone IMU taped to a surfskate | Testing against reality |

A later, wave-coupled `surfsim` replaces the generators in production. It uses the same
interface (board state history and analytic derivatives) and queries the water team's wave
model. **Board motion through the world belongs to us**, not the water team (see the decision
log).

### 3.4 Performance stream simulator

- **Presets** emitting a packet every 500 ms: `cruise`, `escalating`, `struggling`,
  `recovering`, `wipeout`, `random-walk`, plus "replay file".
- A timeline editor for hand-authored streams: magnitude, stability and event markers.
- **Network faults:** jitter, late packets, drops and bursts, to test the playout buffer.
- A recorder that saves any session's stream to JSON for regression.

### 3.5 Cameras

| Camera | Notes |
|---|---|
| Orbit | Inspection; free |
| **Rear chase** | Spring-damped follow of a point on the board-heading frame H. Parameters: distance (default 5 m, range 4–7, stretch with speed, about 3 m in barrels), height (default 2 m, range 1.6–2.5; about 1 m when paddling), vertical FOV (default 45°, range 40–50°, rectilinear only), yaw lag (0.3–0.5 s critically damped), height lag (0.2 s), horizon roll follow (15–30%), bob. Values from [01 §2.2](01-visual-references.md). There are presets per art direction. The *same* class later ships in the visualization. |
| Side profile, front, top | Analysis: knee angles, lean, stance width |
| Reference-match | Free FOV, height and distance to line up with a reference clip's framing |

Split view: chase and side, or two configurations for A/B comparison.

### 3.6 Lighting and look presets

- Presets: **A Tropical Clarity, B Golden Hour, C Atlantic Power, Studio Neutral** and
  **ShoreBreak-calibrated**. The last one imports ShoreBreak's sky LUT, sun, ambient and
  tone curve values from `src/core/look.js` and `src/post/Post.js`, to check that the surfer
  integrates under the water team's current look.
- Sun azimuth and elevation slider (time of day), exposure (manual and auto), tone mapper
  (AgX / ACES / Neutral / ShoreBreak "phone look" port), 3D LUT slot, bloom amount.
- Initial IBL: CC0 Poly Haven HDRIs for quick tests, then the shared sky provider once it
  exists ([06](06-environments-and-lighting.md) E3).
- Wetness controls: global wet, per-region masks, a "dry-off" timer, droplet intensity.

### 3.7 Animation controls

- **Pose blending panel:** the live values of every parameter channel (crouch, lean fore/aft,
  toe/heel, twist, arm set, gaze), each with a manual-override toggle. Blend-space weights
  are visualized.
- **Clip playback:** scrub any clip in isolation, on the board or in place, with the
  procedural layers on or off per layer (IK, balance, head, arms, secondary). Toggling layers
  shows what each contributes.
- **Performance magnitude and stability** sliders (when not driven by the stream).
- **Skill knobs:** anticipation lead `τ_lead`, disturbance stiffness and damping, reaction
  latency.
- **Pose torture test:** predefined extreme poses (deep crouch, max twist, arms overhead,
  aerial tuck, barrel crouch, layback, pop-up mid-frame) on a turntable. Used for the character
  bake-off and the corrective-shape work.

### 3.8 Debug visualization

- Skeleton; joint-limit heat colours.
- Frames B, S and H as axes.
- Specific-force vector `f_B`, planned vs disturbance split.
- COM and its projection, with the support polygon between the feet.
- **Foot anchors with live contact error in mm** (red above 2 mm).
- IK targets and pole vectors; hand IK targets.
- Corrective morph weights.
- Spring states.
- **Signal scope** (uPlot or a small canvas plot) for any channel over the last 10 s. Lets you
  compare stream input vs smoothed parameter vs resulting joint angle.

### 3.9 Time control

- A global clock with a fixed simulation step (120 Hz board, render at display rate).
- Time scale 0.05–2×, pause, step one render frame, step one sim tick.
- **History ring buffer** of full state (about 60 s) for scrubbing back and replaying. Seeded
  RNG makes replays bit-identical.

### 3.10 Capture

- **Screenshot:** PNG at 1×, 2× or 4× (re-render at a higher pixel ratio), with an optional
  transparent background for contact sheets.
- **Video:**
  - (a) Quick real-time capture: `canvas.captureStream()` with `MediaRecorder` (WebM).
  - (b) **Deterministic offline capture:** step the simulation at a fixed dt, render each frame
    and encode it with **WebCodecs `VideoEncoder` + an MP4 muxer** at any resolution and
    framerate. Frame rate is independent of machine speed; this is the quality path for
    reviews.
- **Headless batch** (`tools/capture`, Playwright, as ShoreBreak's `tools/capture.mjs` does):
  render scenario × camera × lighting matrices to image sequences and contact sheets for
  review and visual-regression checks.

### 3.11 Reference overlay

- Load a local reference video (drag-and-drop; never committed to the repo because of rights).
- Show it as a picture-in-picture, a background plate with an opacity slider, or a side-by-side.
- **Sync scrub** with the simulation timeline, plus a time-offset and rate control to align
  maneuvers.
- Overlay HMR-derived skeletons (experiment V1) on the video for QA.

### 3.12 Performance HUD

Frame time, plus CPU ms per rider stage (planner, synth, IK, balance, secondary, ragdoll), GPU
ms via `EXT_disjoint_timer_query_webgl2` where available, draw calls, triangles, texture and
geometry memory, and morph-target VRAM.

## 4. Libraries

| Need | Choice | Licence |
|---|---|---|
| Rendering | `three` 0.186.0 (pinned with ShoreBreak) | MIT |
| UI | `lil-gui` (ShoreBreak uses 0.21) + custom panels; `uplot` for scopes | MIT |
| Physics (ragdoll, lazy) | `jolt-physics` | MIT |
| Hair springs | `@pixiv/three-vrm-springbone` | MIT |
| Asset optimisation (build) | `@gltf-transform/cli` (KTX2, meshopt) | MIT |
| MP4 muxing | `mp4-muxer` or `mediabunny` (check status at implementation time) | MIT / MPL — verify |
| Batch capture | Playwright (pre-installed in this environment) | Apache-2.0 |

Everything else (pose pipeline, IK, springs, inertialization, balance) is our own code, as
argued in [05](05-runtime-animation-tech.md).

## 5. Build-up plan (each step is usable)

| Step | Scope | Answers |
|---|---|---|
| **L0 Shell** (≈1 week) | Vite + TS app; GLB loading; orbit and chase cameras; lighting presets with a Poly Haven HDRI; time control; screenshots; HUD | Infrastructure. Lets the character bake-off start. |
| **L1 Board + contact** (≈1–2 weeks) | `boardkit` v0 board on manual and generator trajectories; static key poses; two-bone foot IK; pelvis/COM balance springs; debug overlays; contact error metric | Experiment R1: do feet stay planted, and does the body stop "rotating rigidly with the board"? |
| **L2 Animation** (≈2–3 weeks) | Pose synth (crouch blend + additive lean/twist/arms); inertialization; stream simulator + playout buffer; stability noise and graded recovery; maneuver curves for pump, bottom turn and cutback | R2/R3: continuous reaction to the stream, no snapping |
| **L3 Character polish** (parallel) | Correctives driven by joint angles; wet skin; hair cards and springs; boardshorts springs; wardrobe switch | Character believability in A/B/C light |
| **L4 Phases** | Paddle cycle; pop-up clip with inertialization; kick-out; Jolt ragdoll wipeout and recovery | Full phase loop in the lab |
| **L5 Capture and reference** | Offline MP4, reference overlay, Playwright batch | Review workflow with the client and animators |

## 6. Scenarios (review and regression assets)

A scenario is a versioned JSON file:
`{character, wardrobe, board, boardTrajectory | generatorScript, stream | streamPreset, lighting, camera, seed, duration, notes}`.

A starter set mirrors the previs shots in [09](09-video-previs.md) (cruise, escalate,
peak-sequence, mistake-recovery, barrel-crouch, paddle-catch, pop-up, kick-out, wipeout). The
real-time result can then be compared directly with the previs mockup and the real reference.
Scenarios are rendered in batch for every significant change. The resulting contact sheets are
the primary review artefact.

## 7. Integration path with the water renderer

The lab's `look` package implements the lighting contract from
[06 §B8](06-environments-and-lighting.md):

- the surfer and board render into ShoreBreak's HDR opaque target before the water pass;
- one shared sun, sky and haze source;
- post is owned in one place, with a selectable look profile.

The "ShoreBreak-calibrated" lab preset is the early-warning system: if the surfer looks wrong
under that preset, the integration contract needs work before the projects are merged.
