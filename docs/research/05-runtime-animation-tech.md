# 05 — Runtime animation technology and procedural animation architecture

Investigation 5 (technology part). Author role: gameplay-animation programmer.
Checked: **2026-11-19**. Three.js at the time of writing: **r187** (npm `three@0.187.0`, published 2026-10-30); ShoreBreak is on r186.

Evidence labels follow `_brief.md`: **[Verified]** (I read the code, licence or package metadata myself), **[Vendor claim]**, **[Reported]**, **[Assessment]**.

> **How this was checked.** I inspected the npm tarballs of `three@0.170.0` and `three@0.187.0` (`src/animation/*`, `examples/jsm/animation/*`, `examples/jsm/physics/*`, GLTFLoader, skinning shader chunks), `jolt-physics@1.1.1`, `@dimforge/rapier3d-compat@0.21.0` and `@pixiv/three-vrm-springbone@3.5.5`. I made shallow clones of `gkjohnson/closed-chain-ik-js`, `lo-th/fullik`, `jsantell/THREE.IK`, `guillaumeblanc/ozz-animation`, `orangeduck/Motion-Matching` and `orangeduck/Spring-It-On`. All of this went into a scratch directory, not the repo.
> Two limits applied: the sandbox's network blocked direct fetches of theorangeduck.com, gdcvault.com and threejs.org, and the web-search budget for this session ran out before the end. A few article URLs therefore come from search-result listings or from memory and are marked *(URL not re-fetched)*. Code-level claims about Holden's work are verified against his MIT repositories instead.

---

## 0. TL;DR

- **Do not build the surfer on `AnimationMixer`.** Use three.js for loading, clip data (`KeyframeTrack` interpolants), skinning and rendering. Write a small custom **pose pipeline** on flat `Float32Array` local-pose buffers: sample, blend, additive layers, inertialization, own forward kinematics (FK), IK, procedural passes, secondary motion, then write to the bones once per frame. One reason is a verified mixer quirk: a bone is only rewritten when the mixed value changes, so procedural edits leak across frames. Another is that the mixer has no blend spaces, masks, inertialization or IK. **[Assessment, based on Verified code]**
- **The core of believability is a board-frame balance model, not clips.** Feet are locked to anchors on the board deck. The pelvis and upper body are driven by the **apparent-gravity vector** `f = a − g` at the stance, expressed in the board frame. That vector passes through **spring-dampers**: they lag behind unplanned board accelerations (inertia) and lead planned ones (anticipation from the intent stream). Ankles and knees absorb board pitch and roll automatically through **analytic two-bone IK**. The head is world-stabilized with a level horizon. This one mechanism yields centripetal lean (`atan(v²/(r·g))`), lean on the wave face, chop absorption and the "doesn't rotate rigidly with the board" property. **[Assessment]**
- **Buffer the 500 ms input stream.** Play it out about **1.0 s behind real time**. Because this is a visualization, not a game, the delay is invisible to viewers. It makes interpolation smooth and enables lookahead, so the planner can schedule maneuvers and pop-ups at phase-compatible moments and the body can anticipate turns. **[Assessment]**
- **Libraries.** Physics: **Jolt** (`jolt-physics`, MIT) for wipeout ragdolls, because it has a real `Ragdoll` with swing-twist limits and `DriveToPoseUsingMotors`. Hair springs: **`@pixiv/three-vrm-springbone`** (MIT). Everything else is custom and small: two-bone IK, aim chains, springs, inertialization, the leash rope, the pose blender. Estimated total animation CPU is **< 0.5 ms/frame** on desktop Chrome, plus 0.1–0.3 ms while the ragdoll is active. **[Assessment; measure in experiment E1]**

---

## 1. Three.js animation system (r170 → r187)

### 1.1 What exists (verified in r187 source)

| Feature | API | Notes |
|---|---|---|
| Clip playback, weights | `AnimationMixer`, `AnimationAction.setEffectiveWeight/fadeIn/fadeOut` | Weight fades are linear ramps (`_weightInterpolant`). **[Verified]** |
| Cross-fade | `crossFadeTo/crossFadeFrom(action, dur, warp)` | Both clips are evaluated during the fade. `warp` ramps timeScales; r187 restores the fading-out action's timeScale afterwards (`_restoreTimeScale`, new since r170). **[Verified]** |
| Additive | `AdditiveAnimationBlendMode`, `AnimationUtils.makeClipAdditive(clip, refFrame, refClip, fps)` | **Mutates the clip in place** and returns it, so clone it first. Additive accumulation is applied after normal accumulation (`PropertyMixer.apply`). **[Verified]** |
| Sync / timescale | `syncWith(action)`, `setEffectiveTimeScale`, `warp`, `halt` | `syncWith` copies time and timeScale only. There are **no sync markers** or phase matching. **[Verified]** |
| Sub-clips | `AnimationUtils.subclip` | **[Verified]** |
| Interpolation | Discrete, Linear, Smooth, **Bezier** (new since r170: `InterpolateBezier`, `BezierInterpolant`, tangent settings in JSON) | **[Verified]** by diffing r170 against r187 |
| Clip metadata | `AnimationClip.userData` (new since r170) | Useful for storing phase or foot-contact markers. **[Verified]** |
| Raw sampling | `track.createInterpolant().evaluate(t)` | This is what our own sampler would use. **[Verified]** |
| IK addon | `examples/jsm/animation/CCDIKSolver.js` | CCD with per-link `limitation` axis, `rotationMin/Max` and chain `minAngle/maxAngle`. Per-chain `blendFactor` and a global blend were added after r170. Built for MMD models. **[Verified]** |
| Physics addons | `examples/jsm/physics/{Ammo,Jolt,Rapier}Physics.js` | Simple rigid-body helpers that load from a CDN: Jolt pinned to `jolt-physics@1.0.0`, Rapier to `rapier3d-compat@0.21.0`, Ammo to a pinned git commit. **No ragdoll support.** **[Verified]** |

**What changed r170 → r187 in `src/animation`:** functionally almost nothing. I diffed the code with comments stripped and found Bezier keyframes, `userData`, the cross-fade warp timeScale fix, logging changes and JSDoc. `PropertyMixer` is unchanged. The blending model is unchanged. **[Verified]**

### 1.2 Limitations that matter for us

1. **Under-weight falls back to the "original" pose.** In `PropertyMixer.apply()`, when the cumulative normal weight is below 1, the remainder is filled from the value captured when the binding was first created (`_origIndex`). That is usually the bind or T-pose. So a blend space whose weights do not sum to 1 drifts toward a T-pose. **[Verified]** ozz-animation behaves similarly, falling back to the rest pose below a `threshold` in `blending_job.h`. **[Verified]**
2. **Write-on-change only.** `PropertyMixer.apply()` calls `binding.setValue()` only if the newly mixed value differs from the previous frame's mixed value. It compares mixer buffers `accu0` and `accu1`, not the bone. If we modify `bone.quaternion` after `mixer.update()` (IK, springs), and the next frame's mixed value is identical (a static pose, a paused action, a held pose), **the bone keeps our modified value and the modification is applied again on top**, so it drifts and accumulates. Workaround: restore cached animated values before each `mixer.update()`, or own the pose buffer. **[Verified]** This is the main reason for recommending a custom pose pipeline.
3. Missing pieces: no blend spaces (1D/2D), no state machine, **no per-bone layer masks** (only by stripping tracks from clips), no inertialization, no root-motion extraction, no IK graph, no foot-lock tooling. **[Verified]** by reading the API surface.
4. **Skinning: 4 influences per vertex.** The skinning shader chunk uses `skinWeight.x/y/z/w`. GLTFLoader maps only `JOINTS_0` and `WEIGHTS_0`, so a second influence set is ignored. Bone matrices go to a texture, so bone count is not a practical limit. Skinning is linear blend only; there is no dual-quaternion skinning. **[Verified]** Consequence: forearm, upper-arm and thigh **twist bones** are needed in the rig to avoid candy-wrapper collapse at strong arm twists, which are common in surf arm poses. We drive them procedurally (§6.6). **[Assessment]**
5. `CCDIKSolver` is not suitable for legs. CCD gives poor knee-plane control and converges at different speeds frame to frame, which shows as jitter on a moving board. Analytic two-bone IK is exact, branch-free and costs a few dot products. Keep CCD at most for a spine-aim fallback. **[Assessment]**

### 1.3 Decision

Use three.js for GLTF loading, `AnimationClip` and `KeyframeTrack` data, `SkinnedMesh` and rendering. Do **not** use `AnimationMixer` for the surfer. It remains fine for props or cosmetic animation. **[Assessment]**

---

## 2. JS/TS IK libraries

| Library | Licence | Status (checked 2026-11-19) | Solver | Fit |
|---|---|---|---|---|
| three.js `CCDIKSolver` | MIT | Maintained with three.js; `blendFactor` added after r170 **[Verified]** | CCD with angle limits | Poor for legs (see §1.2) |
| **closed-chain-ik-js** (gkjohnson) | Apache-2.0 **[Verified LICENSE]** | Active repo: commits Sept 2026, package.json 0.0.7. But npm `closed-chain-ik` is still **0.0.3 (2023)** **[Verified]** | Damped-least-squares Jacobian, closed chains, web-worker solver | Robotics-oriented (URDF robots, ATHLETE, Robonaut demos) **[Verified README]**. Overkill and iterative. Reference only. |
| FIK / fullik (lo-th) | MIT **[Verified LICENSE]** | Last commit 2025-05-17 ("up pack"); **not on npm** under `fullik` **[Verified]** | FABRIK (port of Caliko) | Useful for tentacle or spine-like chains. No pole control comparable to analytic two-bone IK. Not needed. |
| THREE.IK (jsantell) | MIT | Last commit 2021-10; npm `three-ik@0.1.0` **[Verified]** | FABRIK | Unmaintained. Reject. |
| Babylon `BoneIKController` / `BoneLookController` | Apache-2.0 | Maintained with Babylon 9.x **[Vendor claim, unpkg d.ts]** | Two-bone; look-at limited to 2 bones **[Reported, forum]** | Wrong engine. A design reference only. |
| ozz-animation `IKTwoBoneJob`, `IKAimJob` | MIT **[Verified]** | Release 0.17.0, 2026-08 **[Verified]** | Analytic two-bone with `pole_vector`, `twist_angle`, **`soften`** and `weight`; aim with `forward/up/offset/pole/twist` **[Verified header]** | **Best design reference.** Port the parameterization, not the C++. |

**Recommendation: hand-write it (about 300–400 lines of TS).**
- **Analytic two-bone IK** for legs (hip→knee→ankle) and arms (shoulder→elbow→wrist), using the law of cosines. The pole vector comes from the animated pose plus a lean term. Use ozz-style **soften**, so that as reach approaches its limit the target is pulled in smoothly and the knee never snaps straight. Use a `weight` for IK blend in and out. Reference: Holden, *Simple Two Joint IK* — https://theorangeduck.com/page/simple-two-joint *(URL not re-fetched)*; ozz `ik_two_bone_job.h` **[Verified]**.
- **Foot-orientation solve.** Align the ankle so the sole matches the deck normal, with heel and toe roll limits.
- **Pelvis solve.** A closed-form clamp of the pelvis target into the reachable region of both legs (intersection of two spheres of radius `soft·(l_thigh+l_shin)` around the hip-relative anchors).
- **Aim chain.** Spine and neck/head look-at distributed across N bones with weights (as in the ozz `look_at` sample **[Verified sample exists]**).
- **No full-body IK solver.** On a board, the "full-body" problem decomposes cleanly: the pelvis is placed by balance, the legs by two-bone IK, the torso by the aim and twist distribution, and the arms by two-bone IK or FK plus springs. A general iterative full-body IK adds non-determinism and tuning cost without a visual benefit here. **[Assessment]**

---

## 3. Runtime animation frameworks for the web (to adopt or to borrow design from)

| Option | Licence | Status | Verdict |
|---|---|---|---|
| **ozz-animation** (C++, has wasm CI) | MIT | 0.17.0 (Aug 2026), WASM CI badge, live wasm samples **[Verified repo; Vendor claim for samples]** | **Do not adopt.** Sampling cost is not our bottleneck: one character, ~65 bones. Adding an emscripten toolchain, ozz binary archives and a JS↔wasm pose copy each frame costs more than it saves. **Borrow** its job decomposition: Sampling → Blending (layers + per-joint weights + additive) → LocalToModel → IK jobs. **[Assessment]** |
| PlayCanvas anim (state graph, 1D / 2D-cartesian / 2D-directional blend trees, layer masks, additive layers) | MIT | engine 2.24.2, 2026-11-19 **[Verified npm]**; blend tree types **[Vendor claim, docs/blog]** | Design reference for the blend-space weight algorithms. Its 2D-directional tree uses Johansen's gradient-band interpolation **[Reported, source comment]**. |
| Babylon.js (AnimationGroup weights, `MakeAnimationAdditive`, `isAdditive`, bone controllers) | Apache-2.0 | 9.37.1 **[Verified npm]**. No built-in animation graph found **[Reported, forum]** | Reference only. |
| Unity Animation Rigging (Two Bone IK, Multi-Aim, Damped Transform, Override Transform, Twist Correction, Twist Chain…) | Unity licence | docs 1.x **[Vendor claim]** | **Design reference for our constraint vocabulary.** Constraints are evaluated as an ordered list of weighted post-process jobs. https://docs.unity3d.com/Packages/com.unity.animation.rigging@1.2/manual/ConstraintComponents.html |
| Unreal Control Rig / Full Body IK / IK Rig | UE EULA | current docs **[Vendor claim]** | Reference for the pelvis-as-root FBIK idea and per-bone stiffness. https://dev.epicgames.com/documentation/en-us/unreal-engine/control-rig-full-body-ik-in-unreal-engine |
| Unreal Physical Animation component (per-body motor strength profiles, physics blend weight ramp 0→1→0 for hit reactions) | UE EULA | **[Vendor claim]** https://dev.epicgames.com/documentation/en-us/unreal-engine/physics-driven-animation-in-unreal-engine | Template for our ragdoll blend (§9). |
| three-vrm spring bones | MIT | 3.5.5 (2026-07) **[Verified]** | **Adopt** for hair (§6). |
| Motion matching in JS | — | No mature JS/three.js library. Research ports exist: AI4Animation-js, `sweriko/ai4anim-webgpu` (neural, WebGPU) **[Reported]**. Holden's reference C++ (raylib, emscripten web demo) is MIT **[Verified]** | Reject for v1 (§12). |
| Rive | — | 2D | Not applicable. |

---

## 4. Key techniques (with references)

| Technique | Use in BlueCurl | References |
|---|---|---|
| **Critically damped spring / exact damper** (half-life parameterization) | Every continuous parameter: crouch, lean, twist, arm sets, gaze target, balance offsets | Holden, *Spring-It-On: The Game Developer's Spring-Roll-Call* (2021) https://theorangeduck.com/page/spring-roll-call **[Reported]**. Code: `orangeduck/Spring-It-On` (MIT, last commit 2026-03) has `simple_spring_damper_exact`, `double_spring_damper_exact`, **`timed_spring_damper_exact`** (reach a goal at a given time, for anticipation with lookahead), `tracking_spring_update_exact` (follow a sampled signal), `velocity_spring_damper_exact` **[Verified]** |
| **Inertialization** (post-process transition: record the pose offset and velocity at switch time, then decay to zero) | Phase switches (paddle→pop-up→ride), maneuver-set swaps, ragdoll→animation recovery, any discontinuity in a pose source | Bollo, *Inertialization: High-Performance Animation Transitions in Gears of War*, GDC 2018, https://gdcvault.com/play/1025165/Inertialization-High-Performance-Animation-Transitions **[Reported]**. Holden's offset-decay variant: `inertialize_transition/inertialize_update/inertialize_pose_transition` in `orangeduck/Motion-Matching/spring.h` and `controller.cpp` (MIT) **[Verified]** |
| **Dead blending** (extrapolate the old pose with its velocity, then cross-fade into the new pose with smoothstep; decay variant) | Alternative to inertialization when the new source is itself poorly predictable, e.g. ragdoll exit | Holden, *Dead Blending* (blog, 2023-02-25) **[Reported, archive listing]**; code `Spring-It-On/deadblending.c` (`dead_blending_transition`, `dead_blending_update`, `_decay`) **[Verified]** |
| **Motion matching** | Not for v1 (§12). Possibly later for paddling and wipeout get-ups | Clavet, *Motion Matching and The Road to Next-Gen Animation*, GDC 2016, https://www.gdcvault.com/play/1022985/Motion-Matching-and-The-Road **[Reported]**. Holden et al., *Learned Motion Matching*, SIGGRAPH 2020, https://theorangeduck.com/page/learned-motion-matching **[Reported]** |
| **COM over support / balance strategies** (ankle → hip → stepping strategy as the disturbance grows) | Graded recovery reactions (§8.4) | Horak & Nashner 1986, J. Neurophysiol. 55(6), doi:10.1152/jn.1986.55.6.1369 *(citation from memory, not re-checked)* |
| **Postural sway as a correlated random walk** (short-term open-loop drift, long-term closed-loop correction) | Shape of the idle and low-stability wobble (§8.3) | Collins & De Luca 1993, Exp. Brain Res., https://link.springer.com/article/10.1007/BF00229788 **[Reported]**; Peterka 2000 shows an inverted-pendulum plus feedback model reproduces it **[Reported]** |
| **Head stabilization in space** during locomotion (head pitch and roll held near-level, gaze anchored) | Head and neck pass (§6.5) | Pozzo, Berthoz & Lefort 1990, Exp. Brain Res. 82:97–106, https://www.doi.org/10.1007/BF00230842 **[Reported]**. Gaze anticipation in steering: Grasso et al. 1998, https://web.math.princeton.edu/~sswang/CB-pediatric/grasso_berthoz98_locomotor-children.pdf **[Reported]** |
| **Physics-based / active ragdoll** (PD motors tracking the animation) | Wipeouts only (§9) | Euphoria / NaturalMotion (proprietary, no web runtime). UE Physical Animation (above). DReCon / *Ragdoll Motion Matching* GDC 2020, https://gdcvault.com/play/1026712/contactUs **[Reported]**. Jolt `Ragdoll::DriveToPoseUsingMotors` **[Verified API]** |
| **Procedural animation with few key poses plus springs** | Philosophy of the whole system: a handful of strong athletic key poses, everything between them driven by physics-flavoured springs | Rosen, *An Indie Approach to Procedural Animation*, GDC 2014, https://gdcvault.com/play/1020049/contactUs **[Reported]**. Avalanche, *Finding Balance … Just Cause 3*, https://gdcvault.com/play/1021981/contactUs **[Reported]**. Skateboarder procedural devlog: https://upakai.itch.io/grail/devlog/734501/how-the-procedural-animation-of-the-skateboarder-works **[Reported]** |
| **Board-sport games** | — | I found **no public GDC talk on board-sport character animation** (Steep, Riders Republic, Skate, SSX) in the time available. The Steep and Riders Republic talks found are about world and terrain pipelines (https://gdcvault.com/play/1028029/Creating-the-World-of-Riders). Riders Republic used Xsens mocap (https://www.xsens.com/resources/cases/ubisoft-hits-the-slopes-for-the-riders-republic-with-xsens-mvn-suits) **[Reported]**. A 2005 I3D paper simulates snowboarding with a 13-link rigid body: https://www.cs.ubc.ca/~van/papers/i3d-2005.pdf **[Reported]**. Gap: industry practice for board sports here is inferred **[Assessment]** |
| **Surf biomechanics** | Pose-space targets (knee flexion, stance width, chest over lead knee) | No established biomechanical model of surfing (2025 optimal-control paper, https://link.springer.com/10.1007/s11044-025-10071-3) **[Reported]**. Aerial landings: mean front-knee flexion ≈114°, base of support ≈79 cm, "chest over lead knee", wider than hip width (video-analysis study, https://ojs.ub.uni-konstanz.de/cpa/article/view/6883/6179) **[Reported]** |

**Key formulas** **[Assessment / textbook mechanics]**
- Exact damper: `x ← lerp(x, g, 1 − exp(−ln2·dt/halflife))`. This is framerate-independent; never use `lerp(x, g, k)` with a constant `k`.
- Critically damped spring (half-life `h`): `y = (4·ln2/h)/2 = 2·ln2/h`, `j0 = x−g`, `j1 = v + j0·y`, `e = exp(−y·dt)`, `x = e·(j0 + j1·dt) + g`, `v = e·(v − j1·y·dt)`. This is Holden's `simple_spring_damper_exact` **[Verified code]**.
- Under-damped spring (for wobble at low stability): stiffness `k = (2π f)²`, damping `c = 2ζ√k`, integrated in closed form (Holden's `spring_damper_exact`) or semi-implicitly with substeps.
- Steady-turn lean from vertical: **`φ = atan(v²/(r·g)) = atan(v·ω/g)`**. Example: 8 m/s on a 6 m radius gives about 47°; 6 m/s on 10 m gives about 20°.
- General case (wave face, pumping, airs): use the specific force `f = a_stance − g`. Quasi-static equilibrium needs the COM-to-centre-of-pressure line parallel to `f`. **This one vector covers turns, face inclination, compression in bottom turns (|f| > g) and unweighting (|f| < g).**

---

## 5. Physics engines in the browser (ragdoll, secondary)

| Engine | Package / licence | Status | Ragdoll capability | Size | Verdict |
|---|---|---|---|---|---|
| **Jolt Physics** | `jolt-physics@1.1.1`, **MIT** **[Verified]** | Published 2026-10-23 **[Verified]** | `RagdollSettings`, `Ragdoll`, `SkeletonPose`, **`SwingTwistConstraintSettings`**, `Ragdoll.SetPose`, `DriveToPoseUsingKinematics`, **`DriveToPoseUsingMotors`**, `MotorSettings`, `Skeleton`, `SkeletalAnimation`; also `SoftBody*` including rods **[Verified types.d.ts]**. A "Powered Rig" JS demo (animation-driven motorized ragdoll) **[Reported]** | `jolt-physics.wasm.wasm` 2.02 MB, **0.75 MB gzip**; multithread build needs SharedArrayBuffer (COOP/COEP) **[Verified file sizes]** | **Choose.** It is the only browser engine with a first-class humanoid ragdoll API and swing-twist limits. Memory is managed manually (`Jolt.destroy`) **[Vendor claim]**. |
| **Rapier** | `@dimforge/rapier3d(-compat)@0.21.0`, **Apache-2.0** **[Verified]** | Published 2026-09-25 **[Verified]** | Impulse and multibody joints; `SphericalImpulseJoint` has **per-axis motors** but **no swing or cone limits** (`setLimits` exists only on single-axis unit joints); `GenericImpulseJoint` with axis masks; a new soft-body module **[Verified d.ts]** | `rapier_wasm3d_bg.wasm` 3.08 MB, **1.17 MB gzip** **[Verified]** | Viable fallback. Ragdolls need hand-made joint-limit setups. Good if another team already standardises on Rapier. |
| Ammo.js (Bullet) | `ammo.js@0.0.10` on npm (2022), zlib licence (Bullet) | Effectively unmaintained on npm; three's addon pins a git commit **[Verified]** | Cone-twist constraints, but an old API | — | Reject (maintenance). |
| cannon-es | `cannon-es@0.20.0`, MIT | Last publish **2022-08** **[Verified]** | Basic constraints, JS-only (slower) | — | Reject (unmaintained, no swing-twist limits, too slow for stable 15-body chains). |

---

## 6. Secondary motion: what is cheap and convincing

| Element | Technique | Cost | Notes |
|---|---|---|---|
| **Hair** (wet, clumped) | `@pixiv/three-vrm-springbone` `VRMSpringBoneJoint(bone, child, {stiffness, gravityPower, gravityDir, dragForce, hitRadius}, colliderGroups)` on plain glTF bones, with sphere or capsule colliders on head, neck and shoulders **[Verified API]** | 4–8 chains × 3–4 joints, about 0.05 ms **[Assessment]** | Set **`joint.center`** (verified property: "if null, calculated in world space") to the **character root, not world**. That way the board's 8–10 m/s world velocity does not fling the hair; add an explicit relative-wind force instead. Wet hair: high drag, low stiffness, short chains. Watch the scale caveat (three-vrm docs, "spring bones on scaled models"). |
| **Boardshorts** | 2–3 verlet "skirt" bones per leg panel (front, back, outer) at the hem, with thigh capsule collisions; plus pose-driven corrective morphs for hip and knee folds | ~12 particles, < 0.02 ms | Wet fabric clings, so keep amplitude small. Hem flutter matters mainly in airs and fast carves. Do not use Jolt or Rapier soft bodies here: too expensive and too much tuning risk for the visual gain. **[Assessment]** |
| **Leash cord** | Verlet rope, 16–24 particles, 6–10 distance-constraint iterations, collision with the deck plane and an ankle capsule, gravity plus drag; float on the water surface when below the wave height (needs a height query from the wave team) | < 0.05 ms | Render as a skinned tube (one bone per particle) or a rebuilt `TubeGeometry` (more expensive). The leash is a strong realism cue in a rear chase camera. During wipeouts it becomes a Jolt distance constraint between ankle and board. |
| **Skin and muscle jiggle** | Spring on helper bones (calves, glutes, belly) | negligible | **Skip in v1.** An athletic surfer has little visible jiggle, and getting it wrong reads as uncanny. **[Assessment]** |
| **Twist bones** | Procedural: distribute the hand's twist about the forearm axis over 2 forearm twist bones (50/100%), and the upper arm likewise | negligible | Required because of linear blend skinning with 4 influences (§1.2). Equivalent to Unity's "Twist Correction" constraint. |
| **Breathing** | Additive chest and shoulder sine (rate rises after paddling bursts) | negligible | Low amplitude; sells "alive" in calm moments. |

---

## 7. Board-motion decomposition and body reactions

### 7.1 Coordinate frames

| Frame | Origin and axes | Owner | Used for |
|---|---|---|---|
| **W** world | ShoreBreak: metres, +Y up, +Z inland | engine | rendering, camera, wave queries |
| **B** board | Origin at the deck surface, midpoint between the stance anchors; +Y_b deck normal, +Z_b toward the nose, +X_b = Y_b × Z_b | board simulation (6DoF trajectory) | **primary reference during riding**: foot anchors, pelvis targets, all balance springs |
| **S** stance | B rotated about Y_b by the stance angle (feet ~10–20° off the stringer). Mirror flag `s = +1` regular / `−1` goofy; toe-side direction `t̂ = −s·X_b` | character | blend-space axes: fore/aft = along the anchor line, toe/heel = across |
| **H** heading | Board position, yaw from the board velocity direction, **gravity-aligned** (no pitch or roll) | derived | head stabilization, horizon-level gaze, camera hints |
| **C** character skeleton | Root bone at S, pelvis free within S | character | skinning; FK and IK computed in B, then converted to bone-local |

**Rule.** During riding the skeleton root is parented to S, so it moves rigidly with the board. **Only the feet stay rigid.** Every other joint's target is computed from quantities that are **not** board-rotation-locked: apparent gravity, the gaze target and intent. That is what prevents "rotates rigidly with the board". **[Assessment]**

### 7.2 Board kinematics → signals (per frame)

1. The board sim runs at a fixed step (e.g. 120 Hz). Keep a short history of `(p, q)`. Thanks to the playout buffer (§8.1) we have **future** board states. Use **centred finite differences** or a 5–7 tap Savitzky–Golay derivative for `v, a, ω, α`. This gives zero-lag, low-noise derivatives, which a live game could not get. If the board team exposes analytic `a` and `ω`, use those. **[Assessment]**
2. Stance acceleration: `a_s = a + α×r + ω×(ω×r)`, where `r` runs from the board centre of mass to the stance midpoint.
3. Specific force in the board frame: **`f_B = R_Bᵀ (a_s − g)`**, with `g = (0, −9.81, 0)`.
4. Split into **planned** and **unplanned** parts: `f_B = f_B^plan + f_B^dist`. Here `f_B^plan` is the force the intent planner predicted (it commanded the carve, so it knows the expected centripetal load), and `f_B^dist` is the residual from chop, lip hits and planner mismatch. In practice: `f^plan` = a heavily smoothed (half-life ~250 ms, look-ahead-centred) version of `f`, and `f^dist = f − f^plan`. **[Assessment]**

### 7.3 Mapping to body (the balance model)

| Body channel | Driven by | Mechanism | Typical tuning (h = half-life) |
|---|---|---|---|
| **Body "up" axis** (pelvis→chest COM line) | `−f̂^plan` (apparent vertical), **time-advanced** by the anticipation lead `τ_lead` (0.15–0.3 s, more for experts); blended with the deck normal by κ ≈ 0.75–0.9 | `timed_spring_damper` toward the future target, so the body starts leaning *before* the board turns. Real surfers initiate with head and shoulders, then hips, then the board. | h 0.12–0.2 s |
| **Inertial lag** | `f^dist` (unplanned) | Mass-spring: COM offset `x'' = −k(x − 0) − c x' − m⁻¹·f^dist_tangential·gain`. A sudden board deceleration throws the torso forward, then it recovers. | f₀ 1.5–3 Hz, ζ 0.6–1.0 (stability-dependent, §8.3) |
| **Crouch (compression)** | `|f|/g` (g-load) + intent crouch + landing impacts | Higher g-load gives a deeper crouch: `crouch = c_intent + k_g·max(0, |f|/g − 1)`; impulse on landings | h 0.08–0.15 s down, 0.2–0.3 s up (asymmetric) |
| **Weight fore/aft** | intent (trim, pump) + pitch rate | Pelvis offset along the stance axis; front knee flexes more when weighted forward | h 0.15 s |
| **Toe/heel lean** | rail angle relative to apparent gravity | Pelvis offset across the board, knee direction (pole vector) toward the toe or heel side | h 0.1–0.15 s |
| **Upper-body twist** | intent (turn direction leads by τ_lead) + yaw rate ω_y | Twist distributed over pelvis, spine1, spine2, chest (e.g. 15/20/30/35%). The shoulders "open" or "close" into turns before the hips. | h 0.12 s |
| **Arms (counterbalance)** | turn intent (the lead arm points along the intended path, the trailing arm balances) + balance error + lateral `f^dist` | Arm "set" key poses blended + spring offsets on hand targets in chest space; at low stability the arms rise and abduct (windmill). Arms are looser than the torso. | h 0.1–0.25 s, ζ 0.5–0.8 |
| **Head** | gaze target (path ahead, lip, landing point) in W; horizon-level roll | Aim chain over neck and head (40/60%), **roll kept 70–90% level in H**, pitch partly stabilized; leads turns by 0.2–0.4 s | target spring h 0.08–0.12 s |
| **Ankles and knees** | result, not input | Two-bone IK keeps the feet on the anchors while the pelvis follows apparent gravity. Board pitch and roll are absorbed by ankles and knees automatically. | — |

Why this does not look like a passenger. A pure lag model (body reacts only after the board moves) looks like a dummy on a moving platform. A pure board-follow model looks rigid. Splitting planned from unplanned acceleration, so the body leads planned motion and lags disturbances, is what good athletes do and what reads as skill. The anticipation lead time and the disturbance stiffness are the two main knobs for "skill level". **[Assessment]**

---

## 8. From the 500 ms input stream to animation parameters

### 8.1 Playout buffer (recommended)

- Timestamp the incoming samples. Render at `t_play = t_now − D` with **D ≈ 1.0 s** (two samples), configurable. The visualization has no interactive user, so latency costs nothing visually. If an operator UI shows the raw stream, show it delayed by D as well. **[Assessment]**
- This gives:
  1. **Interpolation** between known samples. Use monotone cubic (PCHIP) for continuous values; never step.
  2. **Look-ahead** of 0.5–1.0 s for anticipation, maneuver scheduling and pop-up phase matching.
  3. **Non-causal smoothing** of derived board kinematics (§7.2).
- Underrun (late packet): extrapolate with a decaying velocity (dead-reckoning). When the data arrives, correct through the springs. Never jump. Adapt D slowly if jitter is high, with a time-warp of ±5%.

### 8.2 Signal classes

| Input (from the stream spec) | Class | Mapping |
|---|---|---|
| Immediate reaction / event (e.g. a "bad moment" or "great moment") | **Impulse** | An envelope (attack 50–100 ms, decay 300–800 ms) injected as *force* into the balance springs, or as a maneuver trigger request. Never applied directly to the pose. |
| Accumulated performance P | **Slow state** (minutes) | Selects the maneuver repertoire and intensity, the anticipation lead τ_lead, pose "style" (tighter, more compact), and spring crispness. Pass through a damper with h ≈ 2–5 s. |
| Stability S | **Medium state** (seconds) | Wobble amplitude, damping ratio, reaction latency, recovery-reaction thresholds (§8.3–8.4). Damper with h ≈ 0.5–1 s. |

### 8.3 Stability → wobble without looking robotic

Rules **[Assessment, grounded in the postural-control literature above]**:
1. **Perturb forces, not poses.** Noise enters as a force or torque in the COM spring system, so the body visibly *reacts*: overshoot, recovery, arms. Noise added to joint angles looks like a seizure.
2. **Pink-ish spectrum.** Sum 3–4 octaves of smooth noise (e.g. 0.25, 0.7, 1.8, 4 Hz with amplitudes ∝ 1/f), independent per axis, with random phase. Short-term drift plus long-term correction resembles the Collins–De Luca sway structure.
3. **Amplitude:** `A(S) = A_min + (A_max − A_min)·(1 − S)^2`. Keep `A_min > 0` so even a perfect surfer has micro-adjustments.
4. **Damping and latency degrade with low S:** ζ goes from 1.0 to 0.55 and reaction latency from 80 ms to 220 ms, implemented as a delay line on the feedback error. Low-skill surfers overshoot and correct late; experts are crisp and early.
5. **Real perturbations from the board** (chop in `f^dist`) dominate whenever available. Synthetic noise only fills the gaps.
6. **Asymmetry and variety:** different half-lives per limb, slight left/right differences, and maneuver variants chosen without immediate repeats.

### 8.4 Graded recovery (hysteresis on each level)

| Balance error e = ‖COM offset from support‖ / limit | Reaction |
|---|---|
| e < 0.3 | Ankle and hip strategy only (pelvis springs) |
| 0.3–0.6 | **Arm recovery**: additive "arms out" pose weight `w = smoothstep(0.3, 0.6, e)`, deeper crouch, head drops toward the board |
| 0.6–0.85 | **Stumble**: one foot unlocks, steps (an arc trajectory over 0.25–0.35 s), then re-locks to a new anchor. Torso pitch excursion. |
| > 0.85 for > 150 ms, or the planner says "wipeout" | **Fall** → ragdoll (§9) |

### 8.5 Maneuvers: hybrid discrete planning, continuous execution

- **Surf intent planner.** A small state machine per phase (Paddling, PopUp, Riding, DropOut, Wipeout). In Riding it selects maneuvers (trim, pump, bottom turn, cutback, snap, floater, air…) from the repertoire allowed by P and the wave section. The section comes from the wave team, as a query of the wave model. It uses the look-ahead buffer to **commit maneuvers at decision points**.
- **A maneuver is a parameter trajectory, not a clip.** It is a small set of normalized-time curves (Bezier or Hermite in JSON) for crouch, lean, twist, arm set, gaze offset, plus the board command (carve rate, rail). Executing one only moves spring *targets*, so interrupting it mid-way is always continuous.
- **Optional additive clip layers** (e.g. a "snap" arm throw authored by an animator) are phase-locked to the maneuver's normalized time. If interrupted, their weight decays through a spring. Several instances may overlap. Clips are never restarted while visible.
- **Pop-up** is the one genuinely clip-driven action. The planner waits, using look-ahead, for a paddle-cycle phase compatible with the pop-up clip start (e.g. both hands under the chest). It then switches source and **inertializes** (half-life ~0.1 s). Playback rate and variant (clean, knee-first, two-step stumble) follow the quality signal. Foot IK weights fade 0→1 over the last ~150 ms, landing on board anchors that may be deliberately mis-placed for poor pop-ups, followed by a shuffle step.
- **Airs.** The coupling partly inverts: the feet stay locked, but the board's orientation in flight is jointly controlled. Body tuck and extension come from the intent; board rotation comes from the board sim, which should be informed by the body. The **board team needs a hand-grab or "board follows feet" mode.** Hand IK targets lock onto the rail for grabs.

---

## 9. Physics: wipeouts and the ragdoll blend

**Engine:** Jolt (`Ragdoll` + `SwingTwistConstraint`), 12–15 bodies (capsules). Single-threaded wasm build, loaded lazily on the first Riding phase. **[Assessment]**

**Into physics (t = 0):**
1. Build the `SkeletonPose` from the *current final pose* (after IK). Set body velocities from the **last two frames of the animated pose** (finite difference of world bone transforms) plus the board velocity. This is the most important step; without it the character "freezes then drops".
2. **0–0.3 s: protective reaction.** `DriveToPoseUsingMotors` toward a "brace" pose (arms forward and out, chin tucked, knees up) with motor strength decaying from high to medium. This produces Euphoria-style active falling without Euphoria. Mix toward the next, falling pose with an exponential decay, not a fixed time.
3. **In water:** a custom buoyancy and drag force per body from the wave-height query: linear and quadratic drag, plus extra "whitewater tumble" torque when inside the foam region if the wave team provides that. Motor strength stays low (limp but not dead, ~10–20%).
4. **Board:** a separate Jolt body, coupled with a `DistanceConstraint` or rope to the ankle (the leash). Board physics during a wipeout can be ours or the board team's; this must be agreed.
5. **The skinned mesh reads ragdoll transforms** with a per-bone physics weight. Hands and feet can stay partly animated. Use UE's pattern: ramp the weight to 1 quickly, and back to 0 only at recovery.

**Out of physics (recovery):**
1. Once the body is near-stationary or surfacing (and preferably covered by foam, so the camera sees little), choose a recovery or swim clip by the ragdoll's orientation (face up or down, torso yaw). This is pose matching across 3–6 recovery clips.
2. **Inertialize** from the ragdoll pose (offsets recorded per bone, half-life 0.15–0.25 s), or **dead-blend** if the ragdoll velocities are noisy.
3. Return to Paddling through the planner.

**Hit reactions while riding** (lip landing on the back, foam ball): optional v2. An upper-body-only powered ragdoll at high motor strength with a short physics-weight pulse of 0→0.6→0 over about 0.5 s, as in UE Physical Animation.

---

## 10. Proposed runtime architecture

### 10.1 Data flow

```mermaid
flowchart TD
  IN[Performance stream ~2 Hz] --> PB[Playout buffer D≈1 s<br/>PCHIP interp, look-ahead, impulses]
  PB --> PL[Surf intent planner<br/>phase FSM + maneuver selection<br/>commits with look-ahead]
  WAVE[(Wave model query<br/>other team)] --> PL
  PL -->|board commands: carve rate, rail, trim, pump| BS[Board motion sim<br/>fixed 120 Hz, 6DoF<br/>other team / shared]
  WAVE --> BS
  BS --> BK[Board kinematics<br/>centred derivatives → v,a,ω,α<br/>f_B = R_Bᵀ(a_s − g), split plan/dist]
  PL -->|intent curves: crouch, lean, twist, arms, gaze, τ_lead| PC[Parameter controller<br/>springs: timed / tracking / damped<br/>stability → ζ, latency, noise]
  BK --> PC
  PC --> PS[Pose synthesis, local pose buffers<br/>1D crouch blend + additive lean/twist/arm sets<br/>+ phase clips paddle/pop-up + maneuver additives]
  PS --> INZ[Inertialization offsets<br/>decay springs per bone]
  INZ --> FK1[FK in board frame B]
  FK1 --> PEL[Pelvis / COM solve<br/>apparent-gravity up axis, inertial lag,<br/>reachability clamp]
  PEL --> LEG[Leg two-bone IK + foot-to-deck align<br/>anchors from board; foot-lock weights]
  LEG --> SPN[Spine twist/lean distribution]
  SPN --> HEAD[Head/neck aim: world gaze, level horizon]
  HEAD --> ARM[Arms: FK + spring offsets;<br/>two-bone IK when hand targets active]
  ARM --> TW[Twist-bone correction]
  TW --> RAG{Ragdoll active?}
  RAG -->|yes| JOLT[Jolt ragdoll 60 Hz substeps<br/>motors → pose; per-bone physics weight]
  RAG -->|no| SEC
  JOLT --> SEC[Secondary motion<br/>hair springs, shorts verlet, leash rope]
  SEC --> OUT[Write bone locals → Skeleton<br/>renderer updates matrices + skinning]
  OUT --> CAM[Chase camera reads final board/pelvis]
```

### 10.2 Frame update order (inside `requestAnimationFrame`)

```
dt = clamp(now - prev, 0, 1/20)
1  playout.advance(dt)                 // t_play = now - D; sample interpolated inputs + look-ahead window
2  planner.update(t_play, lookahead)   // phase FSM, maneuver commits, intent curves, board commands
3  board.stepFixed(acc += dt, 1/120)   // board sim (other team) → history incl. future states
   board.interpolate(t_play)           // render pose of board
4  kin = boardKinematics(history, t_play)   // centred derivatives, f_B, plan/dist split
5  params = paramController.update(dt, intent, kin, stability, perf)   // all springs
6  pose = synth.sample(params, dt)     // clips + static poses → Float32Array locals
   inertializer.apply(pose, dt)
7  fk(pose → modelB)                   // own FK, flat arrays, no Object3D
8  pelvis → legs IK → spine → head → arms → twist   (each writes locals, incremental FK)
9  if (ragdoll.active) ragdoll.step(dt) and blend
10 secondary.update(dt)                // springs/verlet need final parent transforms; character-space centre
11 writeToBones(pose)                  // quaternion/position on three Bones (only place we touch Object3D)
12 camera.update(dt)                   // after character
13 renderer.render(scene, camera)      // scene.updateMatrixWorld() + skeleton.update() happen here
```

**Notes.**
- Our own FK avoids calling `updateMatrixWorld()` in the middle of the pipeline. The renderer still performs its normal `scene.updateMatrixWorld()` (verified in `WebGLRenderer.render`). **[Verified]**
- Everything is allocation-free: preallocated typed arrays and module-level scratch vectors, the pattern three's own `CCDIKSolver` uses. Garbage-collection pauses are the most likely source of visible hitches. **[Assessment]**
- The board sim and the character must agree on **t_play** and on stance anchors. That is the interface contract with the board/wave team.

### 10.3 Per-frame cost estimate (desktop Chrome, one character)

| Stage | Work | Estimate |
|---|---|---|
| Sampling | ~65 bones × (3–4 clips + ~10 static key poses, static poses pre-baked) | 0.05–0.15 ms |
| Blending + additive + inertialization | ~65 × ~12 quaternion operations | 0.03–0.08 ms |
| FK (twice, incremental) | ~95 bones including hair, shorts and twist bones | 0.03–0.06 ms |
| IK (2 legs + 2 arms + pelvis + aim chain) | analytic | < 0.03 ms |
| Springs (~60 scalar or vector channels) | closed form | < 0.02 ms |
| Secondary (hair 30 joints, shorts 12 particles, leash 24 particles × 8 iterations) | | 0.05–0.12 ms |
| Write to bones + skeleton texture upload | ~95 bones | 0.05 ms |
| **Total (no ragdoll)** | | **≈ 0.25–0.5 ms** |
| Jolt ragdoll (15 bodies, 14 swing-twist constraints, 60 Hz) | only during wipeouts | 0.1–0.3 ms |

All figures are **[Assessment]** and need measurement in experiment E1. Budget: 1 ms target, 2 ms ceiling, so the frame budget stays with water rendering.

### 10.4 Custom code vs library

| Component | Source | Approx. size |
|---|---|---|
| GLTF load, clips, skinning, rendering | three.js r186/r187 (MIT) | — |
| Clip sampler and pose blender (layers, masks, additive, sync by phase) | **custom** (uses `KeyframeTrack.createInterpolant`) | 400–600 LOC |
| Inertialization and dead blending | **custom**, ported from Holden's MIT code | 150 LOC |
| Spring library (damper, critical, under-damped, timed, tracking) | **custom**, ported from Spring-It-On (MIT) | 150 LOC |
| Two-bone IK, foot align, pelvis clamp, aim chain, twist distribution | **custom**, using ozz job parameters as reference | 350–450 LOC |
| Balance model, parameter controller, stability mapping | **custom** (the main creative and tuning work) | 500–800 LOC |
| Playout buffer and planner FSM, maneuver curve player | **custom** | 600–900 LOC |
| Hair spring bones | `@pixiv/three-vrm-springbone` (MIT) | library |
| Shorts verlet, leash rope | **custom** | 200 LOC |
| Ragdoll, wipeout physics | `jolt-physics` (MIT) + custom buoyancy and drag | 400 LOC glue |
| Debug tooling (frame overlay for B/S/H frames, `f` vector, COM, support polygon; parameter sliders; signal scope) | **custom**, lil-gui | essential; budget it |

### 10.5 Asset requirements this architecture implies (hand-off to the character investigation)

- A humanoid rig with **twist bones** (upper arm and forearm ×2, thigh), toe bones, and ideally eye bones; hair bones in 4–8 chains; 2–3 hem bones per shorts panel. Mixamo's 65-bone rig has no twist bones; it is acceptable for prototypes only. **[Assessment]**
- **Static key poses**, authored as single-frame clips on the same skeleton: a crouch triplet (tall, mid, deep); lean deltas (toe, heel, fore, aft); twist deltas (open, closed); arm sets (neutral, lead-point, low-balance, high-recovery, grab-rail); stance-mirrored, or mirrored at runtime.
- **Clips:** paddle cycle (2–3 effort variants), duck-dive, pop-up (clean, slow, stumble), maneuver additive accents (snap arm throw, claim), recovery and swim clips (3–6), wipeout brace pose.
- Foot anchors and stance angle are defined on the **board asset** as named empties.

---

## 11. Rejected alternatives (decision log)

| Alternative | Reason rejected |
|---|---|
| `AnimationMixer` as the core of the character pipeline | No blend spaces, masks or inertialization. Under-weight blends fall back to the bind pose. Write-on-change corrupts post-process edits (§1.2). **[Verified]** It remains fine for props. |
| Cross-fades for transitions | Both poses are evaluated, the transition is linear, and velocity is discontinuous at the start of a fade. Inertialization is cheaper and keeps velocity continuity (Bollo 2018). |
| Fully clip-based state machine (maneuver = clip) | Requirement violation: discrete clip restarts, visible snapping when interrupted at 500 ms cadence, and a combinatorial explosion of maneuver × stability × board-state clips. |
| Motion matching / learned motion matching | Needs a large surfing mocap database that does not exist and is impractical to capture (Xsens-on-water is possible but costly). Board-relative constraints and a stability continuum are poorly served by a nearest-neighbour search. JS ecosystem is immature. Revisit for paddling or get-ups only. |
| Fully physics-simulated rider (active ragdoll on a physical board, DReCon-style) | Controllability, determinism and tuning cost. Jitter risk is high. Water interaction would need a fluid-ish board model. Reads "drunk" without a learned controller. Physics is limited to wipeouts. |
| Neural / AI4Animation-style controllers in the browser | Research quality, dataset licensing, WebGPU dependency (the ShoreBreak pipeline is WebGL2). |
| ozz-animation (wasm) as the runtime | The performance gain is irrelevant for one character; adds a toolchain and a data-conversion pipeline. Its design is borrowed instead. |
| Iterative full-body IK libraries (closed-chain-ik, FABRIK/FIK, THREE.IK, CCDIKSolver for legs) | Analytic decomposition is exact and cheaper. THREE.IK is unmaintained (2021). closed-chain-ik targets robotics and its npm release lags the repo. CCD gives poor knee control and jitter. |
| cannon-es, ammo.js | Unmaintained since 2022 on npm (**[Verified]**); weak ragdoll joints. |
| Rapier for ragdolls | No swing/cone limits on spherical joints in the JS API (**[Verified]**); larger wasm (1.17 MB vs 0.75 MB gzip). It is a fallback if the project standardises on Rapier. |
| Cloth simulation for boardshorts, soft-body skin | Cost and tuning are out of proportion to the visual gain on wet, clinging fabric seen from a rear chase camera. |
| Adding noise directly to joint angles for "instability" | Reads as robotic or seizure-like. Perturb the dynamics instead (§8.3). |

---

## 12. Risks

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| The balance model looks "floaty" or "drunk" (springs too soft, wrong ζ) | High / High | Tune against real footage, side by side, frame by frame (E2). Separate planned from unplanned motion. Use asymmetric half-lives. Build tuning UI early. |
| Board-sim accelerations are noisy (double differentiation) and create jitter | High / High | Centred derivatives over the playout buffer; ask the board team for analytic `a` and `ω`; clamp jerk. |
| Knee pop or hyperextension when the pelvis target is out of reach (deep lean plus pitch) | Medium / High | Pelvis reachability clamp plus soft IK (ozz `soften`); limit lean by the stance geometry. |
| The look-ahead delay D conflicts with a product requirement for "live" data | Low–Medium / Medium | D is configurable; at D = 0.5 s we keep one sample of look-ahead; worst case causal mode with tracking springs (reduced anticipation). |
| Candy-wrapper skinning (4 influences, linear blend) in extreme arm twists | Medium / Medium | Twist bones plus procedural distribution; rig requirement (§10.5). |
| Ragdoll entry or exit pops | Medium / High | Velocity seeding; inertialized exit; hide recovery under foam; select recovery clips by matching the ragdoll pose. |
| Pop-up looks canned (one clip) | Medium / Medium | 3 variants, playback-rate modulation, IK landing on varied anchors, inertialized entry at a matched paddle phase. |
| No public board-sport animation references; rely on footage | Certain / Medium | Build a reference library of pro clips (rear-chase angle) as the acceptance test. |
| Garbage-collection hitches from per-frame allocations | Medium / Medium | Allocation-free discipline; Chrome performance profiling in CI. |
| Coupling with the board team (who owns airs, wipeout board physics, stance anchors) | Medium / High | Write an interface contract early: t_play, board pose, analytic kinematics, anchors, air-mode handshake. |

---

## 13. Focused technical experiments

**E1 — Moving-plane rig test (two-bone IK + pelvis + spring counterbalance).** 2–3 days.
Mixamo (prototype-only) character standing on a plane driven by a scripted 6DoF trajectory: a sinusoidal roll/pitch, a 6 m-radius carve at 8 m/s, and step decelerations. Implement the custom pose buffer, analytic leg IK with soften, the pelvis apparent-gravity solve and inertial-lag springs.
*Pass:* feet show zero drift (< 2 mm); no knee pop; lean in the carve within ±5° of `atan(v²/rg)`; on step decelerations the torso visibly lags then recovers without oscillating more than 1.5 cycles; CPU < 0.3 ms per frame (Chrome profiler).

**E2 — Footage-matched carve (believability gate).** 3 days.
Pick 3 rear-angle pro clips (bottom turn, cutback, trim on chop). Hand-key the board trajectory to match the clips roughly, run E1 plus the head-stabilization and arm-counterbalance passes, and render side by side. Compare anticipation lead τ_lead ∈ {0, 0.15, 0.3 s} and κ ∈ {0.6, 0.8, 0.95}.
*Pass:* blind preference test with 3–5 people; record the chosen parameters.

**E3 — 500 ms stream → continuous parameters.** 2 days.
Feed synthetic and recorded streams (with jitter, drops and sudden stability collapses) through the playout buffer, PCHIP, springs and the stability mapping (force-noise plus latency plus ζ). Visualize in a signal scope.
*Pass:* no parameter discontinuities (C¹ continuous) under 300 ms jitter and dropped packets; low stability visibly reads as "struggling, not glitching" in a blind review; recovery levels show no flicker (hysteresis works).

**E4 — Inertialized phase switches.** 2 days.
Paddle cycle → phase-matched pop-up → riding pose space, with forced interrupts at random times; compare cross-fade, inertialization and dead blending.
*Pass:* no visible pop at 0.25× playback; no velocity discontinuity in a plot of hand and head trajectories.

**E5 — Jolt wipeout ragdoll round trip.** 3 days.
`jolt-physics` single-threaded wasm; 15-body ragdoll from the skeleton; velocity-seeded entry; brace motors with decay; simple buoyancy and drag on a flat or sine water height; leash constraint to a board body; recovery by pose-matched clip plus inertialization.
*Pass:* entry keeps momentum (no freeze-then-drop); the ragdoll is stable for 10 s with no explosions or jitter; exit shows no pop; wasm load < 1 MB gzip; step time < 0.3 ms.

Optional E6: three-vrm spring-bone hair with `center` set to the character root, against world-space hair, at 10 m/s board speed. Confirm the center-space choice and tune a relative-wind force.

---

## 14. Source list (checked 2026-11-19)

Packages and repos inspected directly (**[Verified]**):
- three.js r187: https://www.npmjs.com/package/three, https://github.com/mrdoob/three.js. Files: `src/animation/{AnimationMixer,AnimationAction,AnimationUtils,PropertyMixer,KeyframeTrack}.js`, `examples/jsm/animation/CCDIKSolver.js`, `examples/jsm/physics/*`, `examples/jsm/loaders/GLTFLoader.js`, `src/renderers/shaders/ShaderChunk/skinning_vertex.glsl.js`. Compared against r170.
- Jolt: https://github.com/jrouwe/JoltPhysics.js, `jolt-physics@1.1.1` (MIT); demos https://jrouwe.github.io/JoltPhysics.js
- Rapier: https://github.com/dimforge/rapier.js, `@dimforge/rapier3d-compat@0.21.0` (Apache-2.0); joints guide https://rapier.rs/docs/user_guides/rust/joints
- three-vrm spring bones: https://github.com/pixiv/three-vrm, `@pixiv/three-vrm-springbone@3.5.5` (MIT); docs https://pixiv.github.io/three-vrm/docs/modules/three-vrm.html
- ozz-animation: https://github.com/guillaumeblanc/ozz-animation (MIT, 0.17.0); samples https://guillaumeblanc.github.io/ozz-animation/samples
- closed-chain-ik-js: https://github.com/gkjohnson/closed-chain-ik-js (Apache-2.0)
- FIK / fullik: https://github.com/lo-th/fullik (MIT)
- THREE.IK: https://github.com/jsantell/THREE.IK (MIT, unmaintained)
- Holden, Motion-Matching: https://github.com/orangeduck/Motion-Matching (MIT); Spring-It-On: https://github.com/orangeduck/Spring-It-On (MIT)
- cannon-es https://github.com/pmndrs/cannon-es; ammo.js https://github.com/kripken/ammo.js (npm metadata only)

Articles, talks and docs (**[Reported]** or **[Vendor claim]**; see the tables for each claim):
- Bollo, GDC 2018 inertialization: https://gdcvault.com/play/1025165/Inertialization-High-Performance-Animation-Transitions
- Clavet, GDC 2016 motion matching: https://www.gdcvault.com/play/1022985/Motion-Matching-and-The-Road
- Holden articles: https://theorangeduck.com/page/spring-roll-call, https://theorangeduck.com/page/learned-motion-matching, https://theorangeduck.com/page/code-vs-data-driven-displacement, dead blending and simple two-joint IK on the same site *(URLs not re-fetched; site blocked from this sandbox)*
- Unity Animation Rigging: https://docs.unity3d.com/Packages/com.unity.animation.rigging@1.2/manual/ConstraintComponents.html
- Unreal FBIK: https://dev.epicgames.com/documentation/en-us/unreal-engine/control-rig-full-body-ik-in-unreal-engine; Physical animation: https://dev.epicgames.com/documentation/en-us/unreal-engine/physics-driven-animation-in-unreal-engine
- PlayCanvas layer masks and blending: https://blog.playcanvas.com/anim-layer-masks-and-blending, https://developer.playcanvas.com/user-manual/animation/anim-layer-masking
- Rosen GDC 2014: https://gdcvault.com/play/1020049/contactUs; Just Cause 3: https://gdcvault.com/play/1021981/contactUs; Ragdoll Motion Matching: https://gdcvault.com/play/1026712/contactUs
- Postural control and head stabilization: https://link.springer.com/article/10.1007/BF00229788, https://www.doi.org/10.1007/BF00230842
- Surf biomechanics: https://link.springer.com/10.1007/s11044-025-10071-3, https://ojs.ub.uni-konstanz.de/cpa/article/view/6883/6179
- Snowboarding simulation (I3D 2005): https://www.cs.ubc.ca/~van/papers/i3d-2005.pdf
