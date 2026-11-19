# BlueCurl — art direction and asset pipeline research

Living research record for the surfer, board, animation, environment, lighting and asset
pipeline. Ocean and wave rendering are out of scope; that is a separate effort evaluating
[ShoreBreak](https://github.com/cryptomanavan/ShoreBreak).

Started 2026-11-19. Visual look book: [docs/lookbook](../lookbook/) (published at https://claude.ai/artifact/6L6sGPbk542AppFkRRZrfe). Keep this file updated: record every decision and rejected alternative
in the decision log below.

## Documents

| # | Document | Deliverable |
|---|---|---|
| — | [_brief.md](_brief.md) | Shared brief and evidence labels used by all research |
| 01 | [01-visual-references.md](01-visual-references.md) | 1. Art-direction research with visual references |
| 02 | [02-character-assets.md](02-character-assets.md) | 3. Ranked character asset sources |
| 03 | [03-surfboards.md](03-surfboards.md) | 5. Surfboard asset pipeline |
| 04 | [04-animation-sources.md](04-animation-sources.md) | 4. Ranked animation sources, animation taxonomy, surfing biomechanics |
| 05 | [05-runtime-animation-tech.md](05-runtime-animation-tech.md) | Procedural animation architecture (Investigation 5) |
| 06 | [06-environments-and-lighting.md](06-environments-and-lighting.md) | 6. Environment strategy; sky, atmosphere and lighting |
| 07 | [07-ai-asset-tools.md](07-ai-asset-tools.md) | 7. AI-assisted asset-generation workflows |
| 08 | [08-art-direction.md](08-art-direction.md) | 2. Three realistic art-direction proposals |
| 09 | [09-video-previs.md](09-video-previs.md) | 8. Video mockup prompts, continuity bible, storyboards |
| 10 | [10-lab-architecture.md](10-lab-architecture.md) | 9. Asset viewer and animation laboratory architecture |
| 11 | [11-experiments.md](11-experiments.md) | 10. Prioritized technical experiments |

**Evidence labels** (used throughout):
- **[Verified]**: checked directly in a primary source (licence file, source code, package
  metadata, a computation we ran).
- **[Vendor claim]**: from vendor marketing or docs; not tested.
- **[Reported]**: third-party reviews, papers, forums, or search excerpts of pages we could not
  open.
- **[Assessment]**: expert judgment.

**Research limitation:** this session's network allowed GitHub, npm/PyPI and a list of art
sites, but blocked most vendor sites (Epic, Reallusion, Fab, Hugging Face, Kling and others).
Commercial licence wording and prices are therefore mostly **[Reported]**. Re-read them
directly before buying anything.

## Executive summary

1. **Animation is solvable, but not by finding finished surf animation.** No marketplace pack,
   mocap dataset or text-to-motion model contains believable surfing. The viable strategy is:
   - a compact library of about 25–40 base clips stored **relative to the board**, captured
     from a surfer on a surfskate, on land and on a paddling bench;
   - refined against **video-derived** body motion from real footage;
   - animated continuously by a **procedural board-frame balance layer**: feet locked by IK,
     the body following apparent gravity, and anticipation of planned turns versus lag behind
     disturbances.

   Roughly 30–40% of families (aerials, landings, wipeouts, barrel postures, duck-dives)
   remain authored, with Cascadeur and physics help.
   ([04](04-animation-sources.md), [05](05-runtime-animation-tech.md))
2. **Video-to-mocap of real surfing works only in part.** It is good for body reference on
   close, clean footage (trim, pumps, bottom turns, cutbacks, paddling). It fails in spray,
   barrels, airs and wipeouts. We avoid its hardest part, the world trajectory, because we
   only need **body relative to board**. The board pose needs a custom tracker (about 2 weeks).
   Licensing narrows the tools: only **NVIDIA GEM-X** and **Meta SAM 3D Body** are
   commercially usable state of the art. GVHMR, WHAM and the other SMPL-based tools are not.
3. **Don't build the surfer on three.js's `AnimationMixer`.** It writes bones only when values
   change, which breaks IK and procedural layers. It also has no blend spaces, masks or
   inertialization. Use a small custom pose pipeline. Apply the 500 ms stream with **no added
   delay**: springs give continuity, and anticipation comes from simulating our own planned
   board path ahead. Use Jolt (MIT) for wipeout ragdolls.
4. **Character:** no good-looking vendor human is clearly licensed for shipping a raw,
   extractable GLB to the public web.
   - **MetaHuman** has the best anatomy and deformation and is free, and has been usable
     outside Unreal since 2025. Get Epic's answer in writing.
   - **Character Creator 5** is the runner-up.
   - The long-term, risk-free path is an **owned "BlueCurl body"** on open topology
     (MPFB2/Anny, CC0/Apache), built from a commissioned scan or sculpt. One skeleton and one
     corrective set serve all surfer variants.
   - Twist bones plus runtime corrective shapes driven by joint angles are mandatory with
     three.js's 4-influence linear skinning.
5. **Surfboards: generate procedurally.** A TypeScript `boardkit` takes about 40 shaper
   parameters and reproduces published volumes within about ±4%. It emits GLBs with
   standardized anchor nodes (feet, hands, fins, leash, buoyancy) and answers deck queries at
   runtime. Bought models are used only as benchmarks. Realism comes mostly from materials:
   sanded finish, wax, pad, heel dents, backlit foam.
6. **Environments are data, not code.** The coast is seen from offshore: beyond about 2 km only
   silhouette, tone and haze are visible. Each location is a JSON preset plus a build-time bake:
   - far silhouette strips from Copernicus GLO-30 elevation data;
   - mid-band cliffs and beaches with CC0 materials and impostor vegetation;
   - a physical sky through a shared `SkyProvider` (`@takram/three-atmosphere`, MIT);
   - 2D and card clouds;
   - a per-location colour LUT.

   Rejected: Google 3D Tiles (terms), bare HDRI backdrops, Gaussian-splat backdrops,
   volumetric clouds.
7. **Lighting needs one source of truth across the scene.** ShoreBreak's sky is a LUT fitted to
   *one* phone clip at one sun angle, and its post-processing emulates a *phone camera*. The
   surfer should render into the wave renderer's HDR target before the water pass, lit by one
   sun, sky and haze source. Post-processing should get a "cinema" look profile. We define this
   interface (06 §B8); the wave renderer adopts it at integration.
8. **AI tools.** Production-ready for concept stills and look/camera previs (Kling 4.0,
   Seedance 2.5, Veo 3.1; Nano Banana Pro / gpt-image for stills). Usable with cleanup for
   textures and rocks. **Not viable** for the rigged human, surfboards, vegetation, terrain or
   surf animation. Watch the licences: Hunyuan models exclude the EU, UK and South Korea, and
   the FLUX dev weights are non-commercial.
9. **Art direction.** Three realistic proposals: A *Tropical Clarity*, B *Golden Hour
   Cinematic*, C *Atlantic Power*. The reference study added a fourth, D *Soft Overcast*.
   Build all of them as presets of one pipeline.
   - **Hero look: B.** Backlit spray and a rim-lit silhouette suit the rear chase camera.
   - **Engineering baseline: D/C.** Soft light separates animation errors from lighting errors.
   - **A last.** It is cheap to render but the least forgiving of character flaws.

   Real reference colour is less saturated than expected: teal/jade water, turquoise only
   through the lip. ([08](08-art-direction.md), [01](01-visual-references.md))
10. **Next step:** the smallest experiment set is in [11](11-experiments.md). The critical path
    is X1 (moving-board rig test) → X2 (footage-matched believability gate), with X3/X4
    (video→board-frame motion) in parallel. The decision point is in about 3 weeks.

## Decision log

| Date | Decision | Status | Rationale / doc |
|---|---|---|---|
| 2026-11-19 | Store all riding animation in the **board frame B**; board world motion and body-in-board motion are separate channels, coupled at runtime by a procedural layer | Proposed | 04 §1, 05 §7 |
| 2026-11-19 | **Board frame convention:** metres, +Y deck normal, +Z toward the nose, +X toward the left rail, origin on the stringer. This follows glTF's "+Z forward" convention. Doc 04 §1 used +X nose; **03/05's convention wins**. | Proposed | 03 §6, 05 §7.1 |
| 2026-11-19 | **Board motion through the world (the surfing sim) is ours.** Wave state comes from the wave renderer through a query interface. Where docs 05/10 say "other team" or "water team", read it as "the wave renderer module". | Adopted | Brief: everything except ocean and wave rendering is ours |
| 2026-11-19 | Custom pose pipeline; `AnimationMixer` not used for the surfer | Proposed | 05 §1 |
| 2026-11-19 | **No added input latency.** Samples apply immediately; springs give continuity (~100–250 ms visible response); anticipation comes from simulating our own planned board path 0.2–0.4 s ahead. The 1 s playout buffer was rejected by the owner. | Adopted | 05 §8.1 |
| 2026-11-19 | **Instant onset:** every input shows on the next frame, including the start of a maneuver (head, shoulders, compression lead; board follows). | Adopted (owner) | 05 §8.1 |
| 2026-11-19 | **No motion-capture shoot for now.** Use existing animations (Mixamo, ActorCore, marketplace surf packs) as a base, plus an authored key-pose library (Blender/Cascadeur) driven by the procedural board-frame layer. Video-to-motion stays an optional reference tool. Capture is reconsidered only if this fails the believability gate. | Adopted (owner) | 04, 11 |
| 2026-11-19 | **Character: start with an existing downloadable rigged realistic human** for development (licence for internal use is enough now); revisit licence and quality before any public release. | Adopted (owner) | 02 |
| 2026-11-19 | Wipeout physics: Jolt (`jolt-physics`, MIT); Rapier as fallback; cannon-es and ammo.js rejected | Proposed | 05 §5 |
| 2026-11-19 | Procedural `boardkit` (clean-room); don't port BoardCAD (GPL) | Proposed | 03 §8 |
| 2026-11-19 | Character milestone 1: MetaHuman vs CC5 bake-off; open-topology "BlueCurl body" for production | Proposed; needs X0 answers | 02 §7 |
| 2026-11-19 | Lighting interface: ShoreBreak relative units; surfer in the opaque HDR pass; one sky/sun/haze source; single post chain with look profiles. We define it; the wave renderer adopts it at integration. | Proposed | 06 §B8 |
| 2026-11-19 | Not commercial initially, but may become so: **nothing from a non-commercial or territory-restricted tool goes into shipped assets or data.** Such tools may be used for internal evaluation only. | Adopted | Licensing section below |
| 2026-11-19 | Art directions as presets of one pipeline; B is the hero look, D/C the engineering baseline, A last; time-of-day and weather cycle for long runs | Proposed; confirm after the previs bake-off | 08 §5, 01 §9 |
| 2026-11-19 | Chase camera starting spec: 4–7 m back, 1.6–2.5 m high, 40–50° vertical FOV, level horizon (15–30% roll), 0.3–0.5 s yaw lag, no fisheye, frozen spray | Proposed; watch the follow-cam clips in 01 §2.3 first | 01 §2.2 |
| 2026-11-19 | AI video previs is a look/camera reference only, never a motion reference | Adopted | 07, 09 |

### Rejected alternatives (summary; details in each document)

**Characters:**
- Daz (anti-extraction EULA)
- MB-Lab (AGPL output)
- SMPL family (non-commercial)
- Hunyuan3D (territory exclusion)
- AI-generated humans (quality)
- Ready Player Me (shut down)
- Marketplace surfers (quality)

**Animation:**
- marketplace surf packs as final animation
- text-to-motion for maneuvers
- GVHMR, PromptHMR, SMPLer-X, GENMO or AMASS-derived data in shipped assets
- RADiCAL and Meshcapade (closed)
- in-water IMU suits as the primary source
- motion matching (no surf dataset)
- fully physics-simulated rider

**Runtime:**
- `AnimationMixer` for the surfer
- `CCDIKSolver` for legs
- three-ik (unmaintained)
- ozz-animation wasm
- cross-fade-only state machines

**Boards:**
- BoardCAD port (GPL)
- Shape3d/AKU as the source
- marketplace boards as shipped assets
- a Blender-only generator
- a NURBS kernel

**Environments:**
- Google Photorealistic 3D Tiles (terms)
- bare HDRI backdrops
- Gaussian-splat backdrops (baked light; three.js splats need WebGPU)
- HunyuanWorld (territory)
- volumetric clouds (cost)
- cascaded shadow maps (unnecessary)

**AI:**
- Sora (API shut down)
- Midjourney in automated pipelines (no API)
- AI 3D for hero assets

## Licensing: non-commercial and restricted items

The project is not commercial initially but may become so. Policy: use these items for
internal evaluation at most, and never let their outputs or derived data reach shipped assets.
Re-capturing or re-authoring later costs more than avoiding them now.

| Item | Restriction | Commercial-safe alternative |
|---|---|---|
| GVHMR, PromptHMR, SMPLer-X, NVIDIA GENMO / GEM-SMPL (video-to-motion) | Non-commercial research licences | NVIDIA GEM-X, Meta SAM 3D Body |
| WHAM, TRAM, 4D-Humans, CameraHMR | MIT code, but need the SMPL body model (non-commercial) | Same as above |
| SMPL / SMPL-X / STAR / SUPR body models; Anny's optional `smplx` topology | Non-commercial (SMPL commercial licence sold separately by Max Planck) | MHR (Apache-2.0), Anny `anny` topology, MPFB2 (CC0) |
| AMASS, Motion-X, HumanML3D, LAFAN1, Bandai Namco mocap datasets | Non-commercial | Own capture; 100STYLE (CC BY) for filler |
| Text-to-motion models trained on those datasets (MDM, MoMask, T2M-GPT, MotionGPT) | Code is permissive, data is not | Not needed (no surf ability anyway) |
| FLUX.1 / FLUX.2 [dev], FLUX.2 klein 9B weights (image generation) | Non-commercial | FLUX.2 klein 4B (Apache-2.0), or paid APIs |
| TRELLIS.2 (image-to-3D) | MIT, but depends on NVIDIA nvdiffrast (research/evaluation only) | Not needed |
| Free tiers: DeepMotion, Cascadeur, most video generators | Non-commercial or watermarked | Paid tiers |
| Tencent Hunyuan3D, HunyuanWorld, HY-Motion, Hunyuan Video | **Territory**: not licensed in the EU, UK or South Korea | Avoid if users or the team may be there |
| Revenue thresholds | MetaHuman/UE free under $1M/yr; Stability models under $1M; LTX-2 under $10M; Cascadeur Indie under $100k | Fine for now; revisit if commercial |

## Lab log

The Surf Lab lives in [`lab/`](../../lab/README.md), with its own `package.json`. Screenshots and
metrics are in [`docs/lab/`](../lab/).

**2026-11-19: steps 1–6 of the build plan, v0.**

**Decisions:**
- **Placement and stack.** Everything is under `lab/`. Vite 8 + TypeScript + `three@0.186.0`
  (pinned) + lil-gui. There are no other runtime dependencies.
- **Clock.** The simulation runs at a fixed 120 Hz and renders the latest tick. `seek=` re-simulates
  deterministically, so screenshots, metrics and reviews reproduce.
- **Chase camera.** The spec is as given: 5 m back, 2 m up, 45° vertical FOV, 0.4 s yaw lag, 20% roll
  pass-through. Aim is 1.0 m above the deck and 0.6 m ahead.
- **Lighting.**
  - The only Poly Haven golden-hour HDRI reachable here (*Blouberg Sunrise 2*, CC0, via the
    three.js examples) is shot on land, with buildings on the horizon. It lights the surfer and
    board only. The sky and the sea reflection come from a procedural Preetham sky that uses the
    sun direction measured from the HDRI.
  - Preset D uses a CIE overcast sky computed in code. Studio uses `RoomEnvironment`.
  - One sun with a 2048 PCF shadow map in a ±1.6 m box that follows the subject. AgX tone mapping.
- **boardkit.**
  - The outline, rocker and foil are monotone Hermite curves. Cross-sections are superellipses
    (deck/rail exponent, bottom/edge exponent and apex ratio).
  - Volume is solved to the published 28.5 L by one fullness scalar (1.03 for the 6'0").
  - Normals are analytic. Anchors follow 03 §6 (`ANC_*`), plus `deckFrame(z, x)`.
  - The ShoreBreak conversion is `Ry(−90°)` plus the widest-point origin offset (`boardkit/shorebreak.ts`).
- **Character.** Microsoft Rocketbox *Male_Adult_01* (MIT), the only male in shorts, converted
  FBX → GLB with headless Blender (`pip install bpy`).
  - Licence: in `lab/ASSETS.md`.
  - It has no twist bones, and the clothing is fused to the body (polo shirt, shorts, sneakers).
    It is a development placeholder only.
- **Pose pipeline.**
  - `Float32Array` local poses, our own FK, and bones written in exactly one place. No `AnimationMixer`.
  - Key poses are authored in **character space**, so they are independent of the Biped bone axes,
    and mirrored for goofy.
  - Analytic two-bone IK for the legs, with knee-plane control and foot-to-deck alignment.
- **Balance.** `f_B` is computed at the stance point.
  - The body axis follows the planned apparent-up, read 0.15–0.3 s ahead. Its spring state lives in
    the **world** frame; in the board frame it rotated rigidly with fast board rolls.
  - The axis is clamped to 55° from the deck. Where |f| is small (cresting), apparent-up gets less
    weight.
  - Only the perturbation layer's tangential acceleration counts as a disturbance. The plan's own
    rotation at the stance offset is planned, and heave is absorbed by the knees.
- **Board motion.**
  - The planner integrates the path 0.6 s ahead. A maneuver commit re-integrates the future from
    `now + 0.2 s`, so the body starts on the next frame and the board follows 0.2 s later.
  - Turn rate is slew-limited (7 rad/s²) under a lateral-g budget (0.35–2 g). Guards keep the
    board off the crest and the flats.
- **Clips.** No free paddle or pop-up clip was found (none in Rocketbox MIT; Mixamo needs a login).
  The paddle cycle and pop-up are authored procedurally in the board frame. Phase switches use a
  dead blend (half-life 60 ms).

**Measured** (`window.__lab.metrics`, [metrics_v0.json](../lab/metrics_v0.json), headless Chromium/SwiftShader):

| Check | Target | Result |
|---|---|---|
| Foot contact error (three.js bone matrices vs anchors), all scenarios | < 2 mm | **max 0.002 mm** (steps and phase blends excluded) |
| Rider CPU per frame (synth + IK + head + bone write) | < 0.5 ms | **mean 0.02–0.03 ms**, p95 0.1 ms (browser timer resolution is 0.1 ms) |
| Bottom-turn lean vs `atan(v²/rg)` | match | Peak −56° vs −58° theory. Over full maneuver runs the RMS gap is 12–17° because the body deliberately leads by 0.1–0.13 s |
| Body leads board roll | lead | **+83 to +133 ms** (cross-correlation) |
| Clean riding at stability 0.85 (24 s, 4 maneuvers; 30 s cruise; 40 s escalating) | no stumbles | 0 steps, 0 falls |
| Struggling stream (30 s) | graded recovery | arms out, 10 stumble steps, 3 falls |
| Heavy chop 0.12 m at stability 0.85 | absorbed | 0 steps, 0 falls |

**Known issues (honest):**
- Rocketbox deformation:
  - In the deep crouch the back knee nearly touches the deck. The knee and shorts fold acceptably.
  - In the 45° twist the shoulder and armpit pinch where the arm is raised.
  - There are no twist bones (see [pose_tests_v0.jpg](../lab/pose_tests_v0.jpg) and
    [deformation_closeups_v0.jpg](../lab/deformation_closeups_v0.jpg)).
  - Sneakers and a polo shirt are wrong for a surfer.
  - The hair cards read as layered patches from behind.
- **Lean overshoot near the crest.** In crest-guard top turns the body (55° clamp) plus a 60° board
  roll reach about 85–88° from vertical for a few frames.
- **Pop-up.** The tuck-to-landing blend makes the legs float sideways for about 0.1 s.
- **Sea.** The analytic stand-in is smooth, so the procedural sky's horizon gradient reflects as a
  colour band along the face. That belongs to the wave renderer, not to us.
- **Fall.** The fall is a kinematic topple (placeholder); the Jolt ragdoll comes later.

**Rejected while building:**
- **Balance error from the angle of f.** It is undefined near weightlessness and caused false falls.
- **Counting the plan's rotational stance acceleration as a disturbance.** It caused constant stumbles.
- **Whole-body pitch for the pop-up push.** It drove the legs through the board, because in the
  Biped skeleton the thighs hang off `Spine`, not `Pelvis`.

## Open questions for the project owner

1. What exactly is in the stream? Doc 05 assumes impulse events, accumulated performance and
   stability. The spec decides the parameter mapping.
2. ShoreBreak currently renders a beach **shore-break**. The riding animation needs a surfable
   **peeling** wave. Is the wave renderer expected to provide one, or should the lab assume an
   analytic wave face until it does?
