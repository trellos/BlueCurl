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
   inertialization. Use a small custom pose pipeline. Buffer the 500 ms stream about **1 s**
   behind real time: that gives smooth interpolation, look-ahead and anticipation at no visible
   cost. Use Jolt (MIT) for wipeout ragdolls.
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
7. **Lighting must be co-owned with the water team.** ShoreBreak's sky is a LUT fitted to *one*
   phone clip at one sun angle, and its post-processing emulates a *phone camera*. The surfer
   should render into ShoreBreak's HDR target before the water pass, lit by one shared sun, sky
   and haze source. The post chain should get a "cinema" look profile.
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
| 2026-11-19 | **Board motion through the world (the surfing sim) belongs to BlueCurl.** The water team provides wave-state queries. Doc 05 calls the board sim "other team"; read that as "a separate module with a defined interface". | Proposed; confirm with water team | Brief: everything except ocean and wave rendering is ours |
| 2026-11-19 | Custom pose pipeline; `AnimationMixer` not used for the surfer | Proposed | 05 §1 |
| 2026-11-19 | Playout buffer: render the stream about 1.0 s behind real time | Proposed | 05 §8.1 |
| 2026-11-19 | Wipeout physics: Jolt (`jolt-physics`, MIT); Rapier as fallback; cannon-es and ammo.js rejected | Proposed | 05 §5 |
| 2026-11-19 | Procedural `boardkit` (clean-room); don't port BoardCAD (GPL) | Proposed | 03 §8 |
| 2026-11-19 | Character milestone 1: MetaHuman vs CC5 bake-off; open-topology "BlueCurl body" for production | Proposed; needs X0 answers | 02 §7 |
| 2026-11-19 | Lighting contract: ShoreBreak relative units; surfer in the opaque HDR pass; one shared sky/sun/haze; single post chain with look profiles | Proposed; needs water team | 06 §B8 |
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

## Open questions for the project owner

1. **Commercial status and distribution territory.** Several otherwise useful tools (Tencent
   Hunyuan family, HY-Motion) exclude the EU, UK and South Korea. Several research tools are
   non-commercial. Some research documents assumed an EU audience because ShoreBreak's scenery
   is Nice-inspired. That assumption is **not confirmed**.
2. Is the 500 ms stream allowed to be displayed with about 1 s of latency? This is
   recommended, and essential for anticipation.
3. What exactly is in the stream? Doc 05 assumes impulse events, accumulated performance and
   stability. The spec decides the parameter mapping.
4. Who owns the post-processing chain and the sky? This needs a joint decision with the water
   team. Note that ShoreBreak currently renders a **shore-break** at a pebble beach; a
   surfable **peeling** wave is a prerequisite for our riding animation.
5. Approval for the spend in [11 §5](11-experiments.md): previs credits, mocap pilot,
   possibly CC5.
