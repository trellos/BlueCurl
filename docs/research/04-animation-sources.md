# 04 — Surfing animation sources, video-to-mocap, and surfing biomechanics

Investigation 4 (animation sources) + biomechanics part of Investigation 5.
Checked: **2026-11-19**. Author role: animation director / mocap specialist.

> **How the sources were checked.** This session could reach GitHub (licence files, READMEs)
> but no other web host, so vendor pages, papers and stores could not be opened directly.
> Everything marked **[Verified]** was read in a GitHub licence or README file on 2026-11-19.
> Everything else comes from search-result snippets. Those are labelled **[Reported]**
> (third-party or paper) or **[Vendor claim]**. **[Assessment]** marks my professional judgment.
> The shared web-search budget ran out before the last few checks. Items still marked
> *unverified* are listed in §12.

---

## 0. TL;DR

1. **No off-the-shelf source has believable surfing animation.** The few surf packs (a 10-clip UE pack, a 22-clip CGTrader pack, static pose packs) are keyframed placeholders. No public 3D mocap dataset contains real surfing. Skate and snowboard mocap exists but is mostly old or of limited relevance. **[Reported]/[Assessment]**
2. **Video-to-mocap of real surfing works only in part.** Current world-grounded HMR (human mesh recovery) can give usable *reference/blocking* for the body on clear, close, high-resolution footage of trim, pumping, bottom turns and cutbacks. It fails or degrades on spray-hidden top turns, barrels, aerial rotations and wipeouts. Every published "foot contact" prior assumes a static ground, which is wrong on a moving board. The good news is that **we do not need the hard part (global trajectory)**. We only need *body relative to board*, plus gravity direction. **[Assessment]**
3. **Licensing narrows the field.** GVHMR, PromptHMR, SMPLer-X, Motion-X, LAFAN1, Bandai Namco and AMASS are non-commercial **[Verified]**. WHAM, TRAM and 4D-Humans have MIT code but depend on the non-commercial SMPL body model **[Verified README]**. The commercially usable state-of-the-art options as of Nov 2026 are **NVIDIA GEM-X** (Apache-2.0 code, SOMA body model Apache-2.0, ViPE camera solver Apache-2.0, weights under NVIDIA Open Model License **[Verified code / Reported weights]**) and **Meta SAM 3D Body** (SAM License, which permits commercial use, plus MHR body model under Apache-2.0) **[Verified]**.
4. **Recommended strategy (hybrid).** Capture a real surfer on a **surfskate in a bowl, plus land pop-ups and bench paddling**, with an IMU suit and a board tracker. Use **video-derived body-in-board motion** from wave-pool footage as reference and blocking. Author aerials, wipeouts and edge cases in **Cascadeur**. Drive everything at runtime with a **procedural board-frame layer**: foot-lock IK, centre-of-mass (COM) lean from board acceleration, upper-body lead, arm counterbalance, and ragdoll for wipeouts.
5. **Can we avoid hand-authoring every maneuver?** Yes for most of the riding core: about 25–40 base clips plus a procedural layer. No for aerials, wipeouts and underwater/recovery, which stay mostly authored (Cascadeur-assisted). See §10.

---

## 1. Core principle: split board motion from body-in-board motion

Every animation asset in BlueCurl must exist as two independent channels:

| Channel | Content | Who drives it at runtime |
|---|---|---|
| **(a) Board 6DoF** `T_W←B(t)` | Board position and orientation in world/wave space | Surf physics / wave-relative board controller, from the performance stream |
| **(b) Body-in-board** `P_B(t)` | Skeleton pose expressed in the **board frame B** | Animation graph + procedural layer, parented under the board |

**Board frame convention (proposal):** origin on the deck surface at the stringer, midway between the standard foot positions. +X toward the nose, +Y along the deck normal, Z = X × Y. Units are metres, matching ShoreBreak (y-up). Body clips store the hips/root transform *relative to B*. Planted feet are constant in B.

**Why the two cannot be fully independent [Assessment].** In real surfing the body motion is *caused* by board and wave forces: lean comes from centripetal load, compression from g-load, and stumbles from sudden deceleration. So the two channels are stored and authored independently but **coupled at runtime by a procedural layer** that reads the board's acceleration in B:

- Effective gravity in the board frame is `f_B = R_B←W · (g − a_board)`. The body's COM is kept over the support polygon (the feet) *along f_B*. This gives correct lean in carves without authoring every lean angle.
- Banked-turn lean ≈ `atan(v²/(r·g))`. Example: 8 m/s on a 5 m radius gives v²/r ≈ 12.8 m/s² (≈1.3 g), so the lean is ≈53° from vertical. That is why pros "lay over" in bottom turns, and the clips must allow that range. **[Assessment, derived from basic physics]**
- Compression (knee/hip flexion) is scaled by the normal load `|f_B·Y|`.

**Extraction per source type**

| Source | How to get (a) the board | How to get (b) body-in-B | Main error and fix |
|---|---|---|---|
| Keyframe (Cascadeur/Blender) | Animate a `board` control as parent of the rig root. Export the board track as reference only. | Bake the rig with root relative to `board`. Export the body clip with the board removed. | None. Author directly in B. |
| Mocap suit on surfskate/balance trainer | Add a prop IMU on the deck (Xsens MVN supports props **[Assessment]**), a phone logging IMU+video taped to the deck, or derive it from the feet: deck normal ≈ mean of the two foot-sole normals, yaw ≈ the line between the heels. | `P_B = T_B←W · P_W` per frame. | IMU drift. Re-anchor feet: zero velocity in B during contact, then IK. |
| Video (HMR) | Separate board estimation: segment the board (SAM-family masks), detect nose/tail/fin/rail keypoints, solve PnP/silhouette fit against a known board model. Rigid-object smoothing. Cross-check against feet (the deck plane must touch both soles). | HMR in **camera frame** (do not trust world trajectory). `P_B = T_B←C · P_C`. Gravity from the HMR gravity estimate or the horizon. | Board pose error propagates fully into body-in-B and makes feet slide on the deck. Fix: enforce contact in B plus IK; low-pass the board pose. |
| Commercial pack with a board bone (e.g. ActorCore skate pack with "Smart Accessory" board sync **[Vendor claim]**) | Read the board bone. | Re-parent the skeleton under the board bone and bake. | Pack-specific rig conventions. |
| Pack without a board (in-place) | Infer the board from the feet (as for the suit). | Same as above. | Feet may not be coplanar. Clean up. |
| Text-to-motion | The "ground" is treated as the deck. Only static-support motions make sense. | Root relative to the ground plane. | Models know nothing about boards (§5). |

**Runtime in Three.js [Assessment]:** `boardObject3D` (driven by physics) → child `riderRoot` → skinned mesh. `AnimationMixer` plays body clips in B. A post-mixer procedural pass applies COM lean, two-bone foot IK to deck contacts, a head/shoulder look-ahead, arm counterbalance, and spring-damper secondary motion. Wipeouts switch to a physics ragdoll (Rapier/Jolt WASM), blended from the last animated pose.

---

## 2. Commercial animation libraries

| Source | Surf / board content | Quality signal | Licence / cost | Verdict |
|---|---|---|---|---|
| **Mixamo** (Adobe) | No surf or snowboard found. A "Skateboarding" clip exists; the board is not animated. **[Reported]** | Generic mocap | Free with Adobe ID. Royalty-free in games/films. No redistribution of raw files. Community answers say ML training on Mixamo content is excluded. **[Reported]** ([FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)) | Useful only for beach/idle filler. Not surf. |
| **Reallusion ActorCore / iClone** | No surf. "Skateboard – Flatground Skate Tricks": 26 optical-mocap clips (pushes, ollies, flips, shove-its), by Motion Capture Orlando / Monkey Chow with skater Brian Ortiz. The board is synced via the Smart Accessory system. **[Vendor claim]** ([store](https://www.reallusion.com/ContentStore/iClone/3d-animation/skateboard/default.html)). A 2021-era forum request for surf/snowboard motions got "keyframe it". ([forum](https://forum.reallusion.com/423712/urfingsnowboarding-motions)) | Optical mocap, pro skater | Price not retrieved. ActorCore licence normally allows games. | Best **pipeline reference** for board+body sync. Pushing, bails and stumbles are partly reusable. Trick content is irrelevant. |
| **MoCap Online** | No board-sport pack found. Catalog: Mobility, Ninja, Zombie, etc. Mobility Pro 223+ anims ≈ $99.99. **[Reported]** ([itch](https://mocaponline.itch.io/mobility-pro-animations), [Fab seller](https://www.fab.com/sellers/MoCap%20Online/about)) | Studio mocap | Per-pack, royalty-free | Not relevant except locomotion. |
| **Fab (Epic) — "Jane Gintsar – Surfing Anim Pack"** | 10 anims: paddle, stand up, ride, balance, wipeout, beach poses **[Reported]** ([UE forum](https://forums.unrealengine.com/t/jane-gintsar-surfing-anim-pack/2656037)) | Unknown (likely keyframed); price unknown | Fab standard licence | Placeholder / prototyping only. |
| **CGTrader "Water Surfing Actions"** | Surfer + board + 22 game anims. Also "SUP surfing actions" (25 anims, also on FlippedNormals). **[Reported]** ([link](https://cgtrader.com/3d-models/sports/game/water-surfing-actions)) | Game-style, likely keyframed | ≈ $35 royalty-free **[Reported]** | Cheapest placeholder. Not at our quality bar. **[Assessment]** |
| **TurboSquid / codethislab surfer** | 6 anims (run, enter water, paddle, pop-up, surf). Explicitly "crafted (no motion capture)". **[Reported]** ([link](https://codethislab.com/?p=3844)) | Keyframed | — | Reject. |
| **Unity Asset Store** | "Poses Pack: Sports – Surfing" (static poses, $9.99). "Skateboard Mocap Animation Vol 1" (25 mocap anims, $10, last updated 2015). "Skateboard Animation" (73 in-place). "Snow Board Actions". **[Reported]** | Mixed / old | Unity EULA (Unity-only use restrictions apply to some assets — check per asset) | The poses pack is a cheap reference for silhouettes. The rest are marginal. |
| **Snowboard packs** (CGTrader "snow board animations" 50+ anims, Unity "Snow Board Actions") | Not confirmed as mocap **[Reported]** | Unknown | Per asset | Snowboard stance is sideways like surfing, but turns are edge-on-snow without pumping. Low reuse value. **[Assessment]** |
| **Wakeboard / kite / windsurf** | No animation packs found. Only props (Unity wake package $17.99). **[Reported]** | — | — | None. |
| **Rokoko Motion Library** | "12 free sports animations" (content not inspected) ([link](https://rokoko.com/resources/rokoko-mocap-12-free-sports-animations)) | Suit mocap | Free / marketplace | Check for balance/fall clips. Low expectation. |
| **Kinetix, Truebones** | No surf content known. Could not verify the 2026 status of either. *unverified* | — | — | Not pursued. |
| **Industry precedent** | Ubisoft *Riders Republic* captured skiers and snowboarders on real slopes with Xsens MVN suits **[Vendor claim]** ([Xsens case](https://www.xsens.com/resources/cases/ubisoft-hits-the-slopes-for-the-riders-republic-with-xsens-mvn-suits)). *Sunny Garcia Surfing* (PS2) used video motion capture of real surfers **[Reported]** ([MobyGames](https://www.mobygames.com/game/42034/sunny-garcia-surfing/)). Barton Lynch Pro Surfing: no information on its animation pipeline found. | | | The IMU-suit-on-location approach is proven for board sports. |

**Rejected:** relying on any marketplace surf pack as production animation, because none reach "realistic sports cinematography". **[Assessment]**

---

## 3. Mocap datasets

| Dataset | Surf/board content | Licence | Usable commercially? |
|---|---|---|---|
| **CMU Graphics Lab** | No surfing. Some balance/jumps. | "Free for all uses". May be used in commercial products. **No resale of the data**, even converted. Some repackaged copies are CC BY-NC. **[Reported]** ([mocap.cs.cmu.edu](https://mocap.cs.cmu.edu/resources.php)) | **Yes** (original files). |
| **AMASS** | Aggregates CMU and others. No surfing. | Non-commercial research/education/art only. Commercial use needs a separate licence. **[Reported]** ([licence](https://amass.is.tue.mpg.de/license.html)) | No |
| **HumanML3D** | Text labels on AMASS | Code MIT **[Verified]**. Motion data inherits AMASS non-commercial terms. **[Assessment]** | No (the data) |
| **Motion-X / Motion-X++** | Internet video, whole-body | "Non-commercial Scientific Research" **[Verified]** | No |
| **BEDLAM** | Synthetic training data | MPI non-commercial (licence file not reachable; *unverified*) | Assume No |
| **100STYLE** | 100 locomotion styles, Xsens, 60 fps BVH, 4M+ frames | **CC BY 4.0** **[Reported]** ([page](https://ianxmason.github.io/100style)) | **Yes** (attribution). Useful only for beach walk / board-carry style. |
| **LAFAN1** (Ubisoft) | Locomotion, falls, obstacles | **CC BY-NC-ND 4.0** **[Verified]** | No |
| **Bandai Namco Research Motion 1/2** | Stylised daily actions | **CC BY-NC 4.0** **[Verified]** | No |
| **SSD surfing dataset** (IEEE DataPort, M. Qiu) | **3,200 2D** COCO-17 skeleton clips, 12 surf phases (paddle, take-off, cutback, re-entry, air, air360, barrel, …) **[Reported]** ([DataPort](https://ieee-dataport.org/documents/ssd-dataset-and-benchmark-fine-grained-temporal-phase-segmentation-surfing-sports)) | Licence unknown | 2D only. Useful as a phase taxonomy and timing statistics, not as animation. |
| AthleticsPose, SportsPose | Athletics/sports, no board sports **[Reported]** | Research | No |

**Conclusion:** no public 3D dataset contains real surfing. **[Reported/Assessment]**

---

## 4. Video-to-motion capture (the key question)

### 4.1 Commercial services (status Nov 2026)

| Service | Status / pricing | Output | Licence of output | Surf suitability [Assessment] |
|---|---|---|---|---|
| **Move.ai** (Move One iPhone app; Gen 2 "s2" single-view; multi-cam) | Starter $18/mo (60 credits), Standard $48, Plus $225, Advanced $490. s2 costs 2 or 12 credits per second (the vendor's own pages conflict). Gen 2 may require Advanced. **[Reported]** ([help](https://help.move.ai/en/articles/8851451-move-one-pricing), [docs](https://docs.move.ai/knowledge/move-ai-pricing-plans-credits), [Gen 2](https://www.move.ai/gen-2)) | FBX/BVH | Paid plans commercial | Good on land captures. **Multi-cam** is the most promising commercial route for a *wave-pool shoot with fixed cameras*. Single-view on ocean footage is expected to be poor. No moving-camera claims found. |
| **Rokoko Vision 3.0** (Jul 2026) | Browser, webcam, single or dual camera. Free tier. **[Reported]** ([post](https://www.rokoko.com/insights/introducing-rokoko-vision-3-0)) | FBX/BVH | Paid for commercial | Indoor/webcam oriented. Land-only tests. |
| **DeepMotion Animate 3D** (+ SayMotion text-to-motion) | Free tier non-commercial. Starter ≈ $15/mo with commercial licence. Terms forbid selling the motion as a standalone asset. **[Reported]** | FBX/BVH/GLB | Paid = commercial | Land tests only. |
| **QuickMagic** | ≈ $9.90–11.90/mo entry. Body+hands+face. Browser. **[Reported]** ([iTechGuides](https://www.itechguides.com/products/quickmagic/pricing/)) | FBX etc. | Paid | Cheap land test. |
| **Plask Motion** | Freemium. "MoCap Pro" adds foot lock. Status unclear. **[Reported]** | FBX/BVH | Paid | Low priority. |
| **Autodesk Flow Studio** (formerly Wonder Studio) | Credits: AI MoCap 10 credits/s. Monthly allowances 300 / 2,100 / 6,000 / 12,000. Dollar prices not retrieved. **[Reported]** ([compare](https://www.autodesk.com/products/flow-studio/compare)) | FBX body+hands | Paid tiers commercial | Has a camera track. Worth one test on a surf clip. |
| **RADiCAL** | **Shut down.** Autodesk bought the core tech/IP (Apr 2026). Portal closed 6 Jul 2026. **[Reported]** ([CG Channel](https://www.cgchannel.com/?p=175200)) | — | — | Rejected (gone). |
| **Meshcapade (incl. MoCapade)** | **Acquired by Epic Games, 18 Feb 2026** **[Reported]** ([MPG](https://www.mpg.de/26082348), [80.lv](https://80.lv/articles/ai-motion-capture-startup-meshcapade-now-part-of-epic-games)). Platforms reportedly shut down 18 Apr 2026 (single source). SMPL licensing now handled directly by Max Planck Innovation. | — | — | Rejected (unavailable). |

All of these are trained mostly on ground-contact human motion. They will apply static-ground foot locking, which is wrong on a board (§4.4). **[Assessment]**

### 4.2 Research HMR (human mesh recovery) — capability and licence

| Model | What it does | Code licence | Body-model / weights dependency | Commercial? |
|---|---|---|---|---|
| **GVHMR** (SIGGRAPH Asia 2024; TPAMI 2026) | World-grounded via gravity-view coordinates. Strong baseline: W-MPJPE₁₀₀ 276.5 mm vs WHAM 354.8; RTE 2.0% vs 6.0% **[Reported]** | "Educational, research and non-profit purposes only" **[Verified]** | SMPL/SMPL-X | **No** |
| **WHAM** (CVPR 2024) | World-grounded, foot-contact aware | MIT **[Verified]** | SMPL (registration required), trained via AMASS **[Verified README]** | No without an SMPL commercial licence |
| **TRAM** (ECCV 2024) | Masked DROID-SLAM camera + video transformer | MIT **[Verified]** | SMPL + third-party licences **[Verified README]** | No without SMPL licence |
| **4D-Humans / HMR 2.0** | Per-frame HMR + tracking | MIT **[Verified]** | SMPL | No without SMPL licence |
| **PromptHMR** (Meshcapade) | Promptable HMR | Non-commercial scientific research **[Verified]** | SMPL-X | **No** |
| **SMPLer-X** | Whole-body | S-Lab Licence 1.0, non-commercial **[Verified]** | SMPL-X | **No** |
| **CameraHMR** | Camera-aware HMR | Licence file not found (*unverified*; assume MPI non-commercial) | SMPL | Assume No |
| **NVIDIA GENMO / GEM-SMPL** (ICCV 2025) | Unified estimation + generation | NVIDIA OneWay **Noncommercial** **[Verified]** | SMPL | **No** |
| **NVIDIA GEM-X** (updated 2026-10-21) | Body Pose (image), **temporal Body Motion with camera + world output**, hand pose. Moving camera via **ViPE**. Optional Contact/IK post-process. EMDB-2: W-MPJPE₁₀₀ 267.2, RTE 2.45%, foot sliding 4.22 mm (better than GVHMR on W-MPJPE) **[Verified README]** | **Apache-2.0** (+ OpenMDW-1.1 file exceptions) **[Verified]** | **SOMA body model: Apache-2.0** **[Verified]**. ViPE: Apache-2.0 **[Verified]**. ViTPose: Apache-2.0 **[Verified]**. Weights: NVIDIA Open Model License, "ready for commercial use" **[Reported]** | **Yes (likely)** — confirm the weights licence. **Top candidate.** |
| **Meta SAM 3D Body** (Nov 2025) | SOTA single-image HMR incl. feet and hands. **Per-frame** (needs temporal handling) | **SAM License** — broad grant, no non-commercial clause; trade-control / ITAR restrictions only **[Verified]** | **MHR (Momentum Human Rig): Apache-2.0**, ships FBX LODs, SMPL conversion tool **[Verified]**. Backbone DINOv3: DINOv3 License, permissive grant **[Verified]** | **Yes.** Second candidate. |
| SAM-Body4D (arXiv 2512.08406) | Training-free video extension of SAM 3D Body. Identity-consistent masklets, occlusion recovery **[Reported]** | not checked | via SAM 3D Body | Check |
| World-coordinate retargeting via SAM 3D Body (arXiv 2512.21573) | Per-frame 3DB + skeleton lock + sliding-window smoothing + **soft foot-ground contact** to recover root trajectory, no SLAM **[Reported]** | not checked | MHR | Check. Its ground-contact prior must be re-targeted to the board (§4.4). |
| OnlineHMR (CVPR 2026), FlowHMR (arXiv 2610.03691, physically plausible), HumanMM (CVPR 2025, multi-shot) | Newer world-grounded variants; FlowHMR reports a better physics-tracking success rate than GVHMR **[Reported]** | not checked | mostly SMPL | Watch list |
| SAM4Dcap (arXiv 2602.13760) | MHR → OpenSim marker trajectories for biomechanics **[Reported]** | — | MHR | Interesting for joint-angle analysis |

**SMPL commercial licence:** sold by Max Planck Innovation (after the Meshcapade/Epic deal). Previously listed at €1,500/yr (micro) and €25,000/yr (SME); the price may have changed. **[Reported]** ([Meshcapade page](https://meshcapade.com/assets/body-models)). **[Assessment]:** Whether retargeted joint rotations extracted via a non-commercial model are "derivative" is a legal grey zone. Do not ship data derived from GVHMR/PromptHMR/SMPLer-X/GENMO. Use GEM-X or SAM 3D Body for anything that might ship. GVHMR may appear only in an internal, legal-approved comparison, if at all.

### 4.3 Prior surfing pose-estimation work

- **Simulating surfing with optimal control: sensor fusion for biomechanical analysis** (*Multibody System Dynamics*, 2025). River wave, 7 experienced surfers, **10 IMUs** + 3D HPE joint angles (13 DoF), fused in an optimal-control simulation. "No established biomechanical model exists for surfing." Optical mocap cannot be used, so only RGB + IMU are available. Rear vs front leg joint moments/angles differ by **up to 47%**. **[Reported]** ([Springer](https://link.springer.com/article/10.1007/s11044-025-10071-3))
- **PETRA '23**: evaluation of open-source 2D pose estimators on river-wave surfers (2D only). **[Reported]** ([ACM](https://dl.acm.org/doi/pdf/10.1145/3594806.3596570))
- **FAU MSc thesis "Tracking and Feedback in Surfing: A 3D Pose Estimation Approach"** (2024). Fine-tunes models incl. MotionBERT for river-wave surfing. **[Reported]** ([PDF](https://www.mad.tf.fau.de/files/2024/11/MA_Thesis_master_IM.pdf))
- **SSD dataset** (2D surf phases, §3). US patent "System and methods for surfer pose estimation" (wake-surfing). **[Reported]**
- **Industry:** Flowstate runs AI move recognition at surf parks, with a "Surfing Foundation Model" (Flowstate AI 4.1) **[Vendor claim]** ([Wavepool Mag](https://wavepoolmag.com/ai-move-recognition-surf-park-wave-pool/)). A possible **footage/data partner**. A hobby project uses YOLO-Pose/RTMO for 2D surf tracking **[Reported]**.
- **Gap:** no published monocular **3D world-grounded** evaluation on ocean surfing, and no board 6DoF tracking work found. **[Reported]**

### 4.4 Surfing-specific difficulties [Assessment unless noted]

| Difficulty | Effect on HMR | Mitigation |
|---|---|---|
| **Moving camera** (boat, jet-ski, drone, panning telephoto) | World-trajectory methods need SLAM/ViPE. Water has no static texture, so SLAM latches onto the shoreline or fails on open-water backgrounds. | **Don't need world trajectory.** Use camera-frame pose + board pose. Gravity from the horizon. |
| **Moving support (board)** | Every contact prior (WHAM, GEM-X Contact/IK, 2512.21573) assumes stationary feet = zero world velocity. On a board moving at up to ~9 m/s this **corrupts root motion or produces foot-skate artefacts**. | **Disable contact post-processing.** Re-impose contact as zero velocity *in board frame B*. |
| **Feet/board occlusion by water, foam, spray** | Feet are usually visible on the deck in trim. Rails and fins are submerged in turns. Spray hides the whole body in top turns and re-entries. | Use clips where the feet are visible. Infer feet from the board pose. Treat spray frames as gaps and in-fill (Cascadeur AI inbetweening). |
| **Small subject** (beach telephoto: surfer often < 150 px tall) | HMR accuracy collapses below ~200–300 px. | 4K telephoto/drone; wave-pool shoots where the camera can be close. |
| **Motion blur, 25–30 fps broadcast** | Fast rotations (snaps, airs) smear limbs. | ≥ 120 fps, 1/1000 s shutter for our own shoots. |
| **Wetsuits (black, low texture), backlight/glare** | Limb boundaries and twist ambiguity; left/right swaps. | Bright rash vests / boardshorts in commissioned shoots. |
| **Rear-follow views** (matching our chase camera) | Front/back and depth ambiguity worst from behind. Torso twist is hard to see. | Pair rear-follow with a side-on angle. Multi-view where possible. |
| **Global trajectory** | Unreliable on water (no stationary contact). | Not required. The board trajectory comes from our own physics. |

**Can foot-to-board contact be recovered?** Partly. With a separately estimated board pose, contact can be **enforced** (the feet are almost always planted on the deck while riding, apart from airs and stumbles). That is more robust than estimating it. **[Assessment]**

**Can the board's 6DoF be estimated separately?** Not off the shelf. FoundationPose (NVIDIA) is the generic 6D tracker, but it is designed around RGB-D and a known CAD model or reference views. TAO/Isaac weights are under different NVIDIA licences, and the code is under the NVIDIA Source Code License. **[Reported]** ([NGC](https://catalog.ngc.nvidia.com/orgs/nvidia/tao/models/foundationpose)). Practical path: a known board CAD model + per-frame mask (SAM-family) + 4–6 keypoints (nose, tail, rails at wide point, fin cluster) from a small fine-tuned detector + PnP / silhouette fit + rigid smoothing + a feet-on-deck constraint. Board shape is simple and symmetric, so expect **nose/tail flips** and **roll ambiguity** under spray. About two engineer-weeks to prototype. **[Assessment]**

### 4.5 Verdict on video-to-mocap for surfing [Assessment]

- **Feasible as reference and blocking for body-in-board motion** on clear, high-resolution, ≥60 fps footage of trim, pumping, bottom turns, cutbacks, and paddling/pop-up. Expect jitter, foot slide on the deck, and torso-twist errors. Budget roughly **30–60% of frames needing animator correction**, with Cascadeur/Blender cleanup on every clip.
- **Not feasible as a primary source** for top turns in spray, barrels (backlit, occluded), aerial rotations, wipeouts, underwater, or anything from small/blurred broadcast footage.
- **Footage rights:** WSL/broadcast/YouTube clips are copyrighted, and downloading often breaches platform terms. Use them for *internal evaluation only* after a legal check. Production data should come from **commissioned wave-pool shoots** or licensed stock. **[Assessment]**

---

## 5. AI motion generation (text-to-motion)

| Model / product | Licence / cost | Surf ability [Assessment] |
|---|---|---|
| MDM (MIT), MoMask (MIT), T2M-GPT (Apache-2.0), MotionGPT (MIT) **[Verified code licences]** | Trained on HumanML3D/AMASS, so **non-commercial data**; weights inherit that risk | No surf in training data. Will produce mimed "surf pose" on flat ground at best. |
| **Tencent HY-Motion 1.0** (Dec 2025; 1.0B / Lite 0.46B; DiT + flow matching; ~24–26 GB VRAM) | Community licence: **does not apply in the EU, UK and South Korea**; licensees over **1M MAU** must request a licence; acceptable-use policy; notice file required **[Verified License.txt]** | Most capable open model. Still ground-based. **The territorial exclusion is a blocker if BlueCurl ships in the EU/UK.** |
| NVIDIA GEM-X / GENMO | GENMO non-commercial **[Verified]**. GEM-X is estimation-focused. | — |
| DeepMotion SayMotion | $9 / $39 / $83 per mo (annual) **[Reported]** | Generic; no surf. |
| Uthana | Stopped new subscriptions Aug 2026; per-second self-serve pricing **[Reported]** | Generic. |
| Cascadeur Motion Generation (diffusion, "Root Motion" renamed in 2026.2) and AI inbetweening (up to 120 frames) **[Reported]** | Included in Cascadeur | **Useful**: fills between authored key poses. Not a maneuver generator. |
| Kinetix | *unverified* | — |

**Verdict:** text-to-motion cannot produce believable surf maneuvers in 2026. It is not trained on surfing, has no board/water dynamics, and its training data are mostly non-commercial. It is rejected for the riding families and only optional for beach/idle filler. A two-hour HY-Motion probe (outside EU/UK use) is optional. **[Assessment]**

---

## 6. Authoring tools and capture hardware

### 6.1 Authoring

| Tool | Relevance | Cost / licence |
|---|---|---|
| **Cascadeur** (Nekki) | AutoPhysics (COM/momentum-correct trajectories), AutoPosing, AI inbetweening (2025.x), diffusion Motion Generation (2026.1), animation layers + BVH import (2026.2, Aug 2026) **[Reported]**. **The best fit for aerials, landings, wipeouts and stumbles**, where ballistic plausibility matters most. | Indie ≈ $19/mo (or annual) for revenue < $100k/yr. Free tier is non-commercial. Yearly Pro/Indie becomes **perpetual after one year**. Plans reportedly restructured 2026-11-04. Re-check. **[Reported]** ([plans](https://cascadeur.com/plans)) |
| **Blender** + Rigify / Auto-Rig Pro | Main glTF/GLB export path for Three.js. ARP has a robust retarget ("Remap") and game export. | Blender free (GPL). ARP ≈ $40 one-time (*unverified*). |
| **Maya / MotionBuilder** | Industry-standard HumanIK retarget, Story editor, mocap cleanup | Maya ≈ $2k/yr; MotionBuilder ≈ $2k/yr (*unverified, prior knowledge*). Only if the team already uses them. |

### 6.2 Capture hardware (capturing a real surfer)

| System | Outdoors | Water | Price | Notes |
|---|---|---|---|---|
| **Rokoko Smartsuit Pro II** | Yes (built-in hotspot, onboard recording) **[Vendor claim]** | No | ≈ $2,295–2,745 **[Reported]** | Magnetic sensitivity near steel ramps and rebar. |
| **Xsens MVN Link/Awinda** (Movella) | Proven on location (Riders Republic, motocross) **[Vendor claim]** | Suits not waterproof | Quote-only | Highest quality IMU suit. Supports props. Rental houses exist. |
| **Movella DOT** (ex-Xsens DOT) | Yes | **IP68** **[Reported]** | n/a | Sparse IMUs under a wetsuit + sparse-IMU-to-pose ML. **Research route**, not production. |
| **Perception Neuron 3** | Interference-prone outdoors **[Reported]** | No | ≈ $1.5k **[Reported]** | Budget option. |
| **Sony mocopi** | 6 sensors | No | ≈ $450 **[Reported]** | Too sparse for lower-body nuance. OK for a first trial. |
| **Optical studio** (Vicon/OptiTrack) | Indoors only | No | Day rate (*unverified*) | Best for pop-ups, paddling-on-bench, falls onto crash mats. |
| **Move.ai multi-cam / Move One** | Yes | Cameras can film water | §4.1 | Multi-cam at a wave pool is the only "real wave" markerless option. |

### 6.3 Practical capture substitutes for real surfing [Assessment, supported by coaching sources]

- **Surfskate (Carver/YOW-type trucks) in a skate bowl or on banks.** Reproduces pumping (compression/extension with rail-to-rail rotation), bottom-turn compression under *real* centripetal load, cutbacks and snaps. Coaches describe the same kinetic chain (eyes → shoulders → hips → knees → ankles) on surfskate and wave **[Reported]** ([Rapture surfskate](https://www.rapturecamps.com/learn-to-surf/surfskate-training/bottom-turn-surfskate)). Differences: truck pivot instead of fin/rail, no water drag, a smaller board, and a "stance width" set by the skate deck.
- **Land pop-up on a real board on a mat** (optionally on a balance cushion). Forsyth et al. found dry-land simulated aerials reproduced **100% of the critical landing features for a frontside air but only 60% for an air reverse** **[Reported]**. Expect land captures to be good for simple motions and weaker for rotational ones.
- **Paddling on a raised bench/box** with the board on top, so the arms can reach below deck level. Optical mocap works.
- **Indoor balance trainers** (Indo-board style): balance-recovery micro-motions only.
- **Standing-wave machines (FlowRider)**: real water load, but the board/technique differs (flowboarding). Mostly reference.
- **Wave pool (multi-cam, high-fps, close angles, repeatable waves)**: the only real-wave source. Same surfer, same wave, many takes, all angles.

---

## 7. Retargeting and cleanup

| Tool | Notes | Licence |
|---|---|---|
| Rokoko Studio Live for Blender | Retargeting between arbitrary rigs | **LGPL-3.0** **[Verified]**, free |
| Auto-Rig Pro (Blender) | Remap retarget, IK/FK, glTF/FBX export | Paid (*unverified price*) |
| Expy Kit (Blender) | Rig conversion/retarget | Free (*licence unverified*) |
| Cascadeur | Imports FBX/BVH onto its rig; physics cleanup | §6.1 |
| MotionBuilder / Maya HumanIK | Industry standard | §6.1 |
| MHR → SMPL conversion; SOMA interop | For SAM 3D Body / GEM-X outputs to standard skeletons | Apache-2.0 **[Verified]** |
| Daniel Holden Motion-Matching reference | Runtime matching on board-frame features | MIT **[Verified]** |

**Foot-contact cleanup in the board frame [Assessment]:** (1) transform to B; (2) contact = low foot velocity and low height in B; (3) lock planted feet to their mean B position; (4) two-bone IK for the legs with knee pole from the source; (5) blend the hips to keep the COM over the feet along `f_B`; (6) export clips with root in B. The same IK runs at runtime in Three.js (custom two-bone IK or `CCDIKSolver`).

---

## 8. Biomechanics of surfing (evidence-based)

Peer-reviewed surfing kinematics are **sparse**. Most technique detail comes from coaching literature. Labels matter here.

### 8.1 Time budget and speeds
- Competition time: **paddling 54 ± 6%**, stationary 28%, **wave riding 8 ± 2%**, paddling for a wave 4%. Average **maximum speed 33.4 ± 6.5 km/h (~9.3 m/s)** (Farley 2012, GPS + HR). The 2018 update (41 competitors): paddling 44%, stationary 42%. **[Reported]** ([PubMed 21986691](https://pubmed.ncbi.nlm.nih.gov/21986691/), [PubMed 29912078](https://pubmed.ncbi.nlm.nih.gov/29912078/))
- Training session: paddling 42.6%, riding 2.5%. Recreational surfers: paddling 47%, riding 8.1%. **[Reported]**
- **Implication:** paddling is on screen far more than any maneuver, so it deserves the highest-fidelity cycle work. **[Assessment]**

### 8.2 Paddling
- Paddling bouts: return to the line-up ≈ 64 s, general ≈ 15 s, **sprint to catch a wave ≈ 7 s** (mean) **[Reported]**.
- Cadence **rises with water velocity**, along with O₂ cost and **board roll and yaw**. The middle deltoid activates earlier at higher speed (Nessler et al. 2019) **[Reported]** ([PDF](https://www.csusm.edu/surfresearch/documents/sharp-2019.pdf)). Animate stroke-coupled board roll/yaw, increasing with effort.
- On lower-volume boards cadence is unchanged; surfers compensate with **longer, deeper strokes** **[Reported]** ([PDF](https://www.csusm.edu/surfresearch/documents/board-volume.pdf)).
- Sprint paddling: **pull-phase characteristics** are associated with faster 15 m sprint times (Sports Biomechanics, 2025) **[Reported]** ([T&F](https://www.tandfonline.com/doi/pdf/10.1080/14763141.2025.2549137)).
- Coaching / animation notes **[Assessment]**: alternating crawl-like strokes; chest raised (thoracic extension) and head up to look at the wave; feet together, legs relaxed, toes near the tail. Relaxed vs sprint differ mainly in **stroke length/depth, chest height and tempo**. Absolute surfer stroke rates were not retrieved (gap). A placeholder range is about 40–60 strokes/min relaxed and 70–90 sprint (*unverified*). Validate on footage.

### 8.3 Pop-up
- Lab simulated pop-up (23 male surfers, force plate + 3D mocap): **1.20 ± 0.19 s** total, ≈ **60% push-up phase, 40% reach/landing**. Duration is inversely related to skeletal muscle mass % (r = −0.50). **No dominant/non-dominant side differences** (Borgonovo-Santos et al. 2021, *Sensors*) **[Reported]** ([MDPI](https://www.mdpi.com/1424-8220/21/5/1783))
- **Time-to-pop-up** (chest leaves the plate → front-foot contact): **0.62 ± 0.09 s** on force plate; in water ≈ **0.59–0.66 s** (stronger vs weaker groups). Males are significantly quicker (Parsonage, Secomb et al. 2018 *Sports*; 2020 JSCR) **[Reported]** ([MDPI](https://doi.org/10.3390/sports6020053), [JSCR](https://www.ovid.com/jnls/nsca-jscr/fulltext/10.1519/jsc.0000000000002377~upper-body-strength-measures-and-pop-up-performance-of))
- Eurich et al. 2010 (JSCR) compared sexes; a case value of ~1.3 s start-to-stabilisation is cited secondarily **[Reported]**.
- **Animation timing [Assessment]:** pro pop-up ≈ 0.5–0.7 s from chest lift to front-foot plant, then ≈ 0.3–0.5 s settle. Novice/awkward ≈ 1.2–2 s with knee-first or staggered placement. The pop-up is a plyometric push-up: hands plant under the chest/ribs, explosive elbow extension, hips drive up and through, feet land near-simultaneously.

### 8.4 Stance (coaching consensus; **[Reported]**, non-peer-reviewed)
- Regular (left foot forward) vs goofy. About shoulder-width stance.
- **Back foot over the fins/tail pad** for performance surfing. Front foot near or just behind the midpoint over the stringer.
- Foot angles: back foot ~perpendicular to the stringer; front foot ~30–60° toward the nose (sources range 15–90°).
- Starting weight split ≈ 60/40 back/front; more front-foot weight for trim speed, more back-foot weight for pivot and braking.
- Advanced surfers' foot placement is dynamic: the back foot slides to the pad for pivots. ([Barefoot](https://barefootsurftravel.com/?p=9345), [Ombe](https://ombe.co/guides/the-back-foot-debate-and-how-overthinking-your-surfing-is-ruining-it))
- River-wave study: front and rear leg kinematics/moments differ by **up to 47%**, so **legs are not mirror images**. **[Reported]**

### 8.5 Speed generation (pumping)
- **No peer-reviewed surfboard pumping study found** (gap). Analogues: skateboard half-pipe pumping (crouch at the low point, extend upright on inclines) and pump-foil / windsurf pumping (thrust scales with frequency × amplitude). **[Reported]** ([arXiv 2603.14434](https://arxiv.org/abs/2603.14434))
- Coaching model **[Reported/Assessment]**: rise up the face (unweight near the top), then **compress and drive down the face**, using gravity. Pumps alternate rail-to-rail with small upper-body rotations. Timing is synced to the wave face, not to a fixed cadence. Arms swing with the rotation.
- **Animation:** pump cycle ≈ 0.6–1.2 s, knee-flexion amplitude bigger for pros, with board roll alternating in phase with compression. *unverified numbers* — measure from footage.

### 8.6 Turn mechanics
- Sequence: **compression → rail engagement → rotation → extension** **[Reported, coaching]**.
- **Head and eyes lead; shoulders and hips follow.** Where the eyes look sets the arc (a head locked on the lip gives a short, steep, stalled arc). **Opening the shoulders too early** reduces the rail compression needed for acceleration. **Backside bottom turns need full-body rotation** and head commitment **[Reported]** ([Seabreeze](https://www.seabreeze.com.au/Articles/Surfing/The-Bottom-Turn-Where-Speed-Comes-From), [Stab / Dane Reynolds](https://stabmag.com/news/how-to-bottom-turn-with-dane-reynolds/), [The Inertia](https://www.theinertia.com/surf/5-common-mistakes-surfers-make-with-their-bottom-turn/)).
- Rail engagement: toe pressure for a frontside (toe-side) rail, heel pressure for backside. Deeper rail means more arc and more speed consumed. "No rail = skid" **[Reported]**.
- **Pivot / top turns / snaps:** weight shifts to the back foot over the fins, the board pivots, the upper body rotates through and the arms throw; extension releases the fins in spray. **[Assessment from coaching]**
- **Lean:** physics sets lean from speed and radius (§1). At pro bottom-turn speeds the lean is 40–60° from vertical, with the inside hand often near or dragging the face. **[Assessment]**
- **Arms:** the leading arm points toward the target/exit; the trailing arm counterbalances or drags (laybacks, backside grab-rail). Arm throw initiates rotation in snaps. **[Assessment, coaching]**

### 8.7 Aerials and landings
- Frontside air landings show **higher loading rates** than air-reverse landings (less time to dissipate). The **trail (rear) limb** loads more than the lead limb. Lead-ankle dorsiflexion range and trail-hip extensor mobility predict lower risk. **Trail-limb knee valgus** is associated with successful frontside air landings (Forsyth et al., J Sports Sci 2021; SJMSS 2020) **[Reported]** ([UOW](https://ro.uow.edu.au/test2021/3705), [ECU](https://ro.ecu.edu.au/ecuworkspost2013/8039))
- **Animation:** land with deep flexion absorbing ~0.15–0.3 s, rear knee collapsing inward, arms out wide for balance. Rotations are driven by the shoulders before take-off. **[Assessment]**

### 8.8 Relaxed vs high-performance [Assessment]
| Aspect | Relaxed / average | Pro high-performance |
|---|---|---|
| Stance height | Taller, knees ~20–40° flexion | Low; knees 60–100°+ in turns |
| Turn arcs | Long, shallow lean | Tight, 40–60° lean, vertical |
| Upper body | Quiet, arms low | Aggressive rotation, arm throws |
| Rail-to-rail | Slow, few | Fast, many, pump-linked |
| Head | Looks ahead / down | Locks onto the next section/lip early |
| Failure modes | Late weight shift, stiff legs, arms flailing | Over-rotation, catching a rail, landing off-centre |

**Missing evidence (gaps):** peer-reviewed joint angles for bottom/top turns, absolute surfer stroke rates, and COM trajectories on real waves. The 2025 river-wave optimal-control paper is the closest (full text not accessible here).

---

## 9. Animation taxonomy

Legend. **Tech**: A = authored keyframe (Cascadeur/Blender), M = mocap (suit/optical, land/surfskate/bench), V = video-derived (HMR reference), P = procedural, IK = runtime IK, R = ragdoll/physics, H = hybrid. **Risk**: L / M / H / VH (believability risk × effort).

### 9.1 Paddling (body prone on board; the board frame is the support)

| Family | Description | Key biomechanics | Tech | Source candidates | Risk |
|---|---|---|---|---|---|
| Relaxed paddle | Steady alternating strokes, line-up return | Chest moderately raised, long reach, legs together and relaxed; board roll/yaw coupled to strokes | M + P (stroke-phase-locked board roll, speed-scaled cadence) | Bench-paddling mocap; wave-pool video reference | M |
| Powerful / sprint paddle | Catching a wave, ~7 s bursts | Higher cadence, deeper pull, chest higher, more board roll | M (same session, sprint takes) + P blend by effort | Same | M |
| Missed / inefficient strokes | Poor performance: slips, short strokes, out of rhythm | Shallow catch, hand slips, broken rhythm, head bob | A (additive) on top of the M cycle; P noise on timing | Cascadeur additive layers | M |
| Looking toward the approaching wave | Head/torso turn over the shoulder | Neck rotation + thoracic twist, one arm pausing | P (look-at with spine distribution) + M pose | Mocap; procedural look | L |
| Adjusting position on board | Scoot forward/back, sit-up to straddle, turn board | Hands on rails, hip slides; straddle-sit with eggbeater legs to spin | M (on bench/board on mat) + A for the in-water leg part | Mocap + authored | M |
| Accelerating to catch the wave | Last 2–3 strokes, board pitches down the face | Max effort, chest arch, then hands to rails | M + P (pitch from board state) | Mocap; video for timing | M |

### 9.2 Pop-up

| Family | Description | Key biomechanics | Tech | Source candidates | Risk |
|---|---|---|---|---|---|
| Hands planting | Hands under chest/ribs on deck | Elbows in, palms flat by lower ribs | M (land on real board) + IK hand-to-deck | Land mocap | L |
| Torso rising | Explosive push-up | ~60% of a 1.2 s simulated pop-up; elbow extension, hips drive | M | Land mocap; Borgonovo-Santos/Parsonage timing | M |
| Feet moving into position | Feet swing through to stance | Near-simultaneous plant; front foot lands last at ~0.6 s (pro) | M + IK foot targets in B | Land mocap | M |
| Smooth transition to standing | Settle into trim crouch | Absorb board pitch; arms out; head up | M + P (COM along f_B) | Mocap; video ref | M |
| Awkward / unstable pop-up | Knee-first, staggered feet, late, wobbly | 1.2–2 s; asymmetric; arms windmill | M (performed badly on purpose) + P balance noise | Mocap with a novice/actor | M |

### 9.3 Riding (all stored in board frame B)

| Family | Description | Key biomechanics | Tech | Source candidates | Risk |
|---|---|---|---|---|---|
| Neutral trim | Cruising along the face | Mid stance, slight crouch, front-weighted for speed, arms relaxed | M (surfskate cruising) + P (COM along f_B, micro-balance) | Surfskate mocap; V reference | L |
| Crouching | Lower stance for speed/section | Deeper hip/knee flexion; hands forward | M + P (blend by compression param) | Surfskate | L |
| Pumping | Speed generation | Compression/extension synced to the face + rail-to-rail roll + small rotations | M (surfskate pumping is very close) + P (phase-locked to board roll) | Surfskate mocap; V on wave-pool clips | M |
| Bottom turn | Compression at the bottom, rail set, rotate, extend up the face | Head/eyes lead, shoulders hold then open, 40–60° lean, deep compression; toe rail FS / heel rail BS | M (bowl carve under real g-load) + P (lean from v²/r) + V reference for timing | Surfskate bowl; wave-pool video | M–H |
| Top turn / snap | Redirect at the lip | Back-foot pivot over fins, arm throw, upper-body rotation leads, extension in spray | M (surfskate snap) + A polish + P | Surfskate; Cascadeur | H |
| High-line | Trim high on the face (planing at speed) | Taller, forward weight, eyes down-line | M + P | Surfskate | L |
| Cutback / roundhouse | Turn back toward the breaking curl, then rebound | Long rotation, rear-arm lead, rail change mid-turn; roundhouse adds a rebound off the foam | M (surfskate carve-back) + A + P | Surfskate; V | H |
| Rail-to-rail transitions | Edge switches | Ankle/knee lateral shift, hips cross over the board centreline | P (driven by board roll) + M base | Procedural | M |
| Barrel riding | Stalled/crouched in the tube | Deep crouch, trailing hand dragging (FS), grab-rail (BS), head up and forward | A + M (static crouch holds on balance trainer) + P | Cascadeur; balance-trainer mocap; video silhouettes only | H |
| Re-entry | Vertical hit in the lip and back down | Vertical approach, hard pivot, absorb on return | A + M (surfskate vert/bank) | Cascadeur; surfskate on a steep bank | H |
| Aerials | Launch, air, rotate, land | Shoulders pre-rotate, knees tuck, grab optional; landing on rear limb with valgus, deep absorb | A (Cascadeur AutoPhysics) + P landing IK | Cascadeur; dry-land simulated aerials (trampoline/airbag) for reference | VH |
| Landings | Touch-down and absorb | 0.15–0.3 s deep flexion, arms wide; rear limb loads more | A + P (spring compression from impact velocity) | Cascadeur | H |
| Stumbling | Loss of balance, recoverable | Arms windmill, stance widens, hips drop, one foot slides | P (perturbation response) + M (balance-trainer stumbles) | Balance-trainer / surfskate mocap | M |
| Balance recovery | Return to trim after a stumble | Arms in, COM back over feet, foot re-plant | P (spring back to target pose) + M | Same | M |

### 9.4 Drop out and recovery

| Family | Description | Key biomechanics | Tech | Source candidates | Risk |
|---|---|---|---|---|---|
| Controlled kickout | Exit over the back of the wave | Back-foot pivot up and over, step off or lie down on board | M (surfskate end-of-ride hop) + A | Mocap + Cascadeur | M |
| Diving through / over the wave | Duck-dive (shortboard) or dive off board | Push the nose under, knee/foot on the tail, body flat | A (underwater) + M (land block-out) | Cascadeur | H |
| Falling off board | Lose footing, fall to the side/back | Ballistic; arms protective | A + R (active ragdoll) | Cascadeur; Rapier/Jolt ragdoll | H |
| Wipeout | Violent fall + being churned | Tumbling, limbs flailing, water drag | R (heavily damped buoyant ragdoll) + A key poses | Physics; Cascadeur | VH |
| Resurfacing | Rise to surface, gasp, head shake | Arms sweep, head up, breath | A + P (buoyancy) | Cascadeur | M |
| Swimming to board | Freestyle/breaststroke to board (leash) | Head-up freestyle | A or swim mocap (most swim mocap is mimed on land — poor) | Cascadeur | M |
| Remounting | Hands on rails/tail, kick up, slide on | Kick, press, slide, re-center | M (on board on mat/bench) + A water legs | Mocap + authored | M |
| Returning to paddling | Settle prone, start strokes | Shift COM, first strokes | M transition into the paddle cycle | Mocap | L |

---

## 10. Ranked shortlist (top 8)

| # | Source / technique | Role | Cost (est.) | Licence |
|---|---|---|---|---|
| 1 | **Own capture of a real surfer**: surfskate in a bowl + land pop-ups + bench paddling + balance-trainer stumbles, with an IMU suit and a board tracker/phone | Base clips for ~60% of the riding/paddle/pop-up taxonomy | Suit ≈ $2.3–2.7k (Rokoko) or rental; surfer talent ≈ $300–800/day; bowl access (*unverified*) | **Owned outright** |
| 2 | **Cascadeur** (AutoPhysics, AutoPosing, AI inbetweening, layers) | Aerials, landings, wipeouts, barrel, re-entries; cleanup and gap-fill | Indie ≈ $19/mo (< $100k revenue) or Pro; perpetual after 1 year **[Reported]** | Commercial with paid plan |
| 3 | **Procedural board-frame layer** (in-house Three.js): COM along f_B, foot-lock IK, look-ahead head/shoulders, arm counterbalance, compression from g-load, stumble springs | Makes a small clip set read as continuous, physically coupled surfing | Engineering time (≈ 4–8 weeks) | Own |
| 4 | **NVIDIA GEM-X** (+ ViPE) on commissioned wave-pool / licensed footage, with in-house board 6DoF estimation | Body-in-board reference/blocking of real-wave maneuvers, timing data | GPU hours (≈ $10–50 per test batch) + ~2 weeks engineering for board tracking | Apache-2.0 code; weights NVIDIA Open Model License **[Reported]** — confirm |
| 5 | **Meta SAM 3D Body (+ SAM-Body4D / sliding-window smoothing)** | Second opinion / per-frame refinement; high-quality feet and hands; MHR rig in FBX | GPU time | SAM License + MHR Apache-2.0 **[Verified]** |
| 6 | **Wave-pool multi-camera shoot** (Move.ai multi-cam or open multi-view triangulation) | The only real-water source with good geometry; repeatable waves | Pool session ≈ $1–5k (*unverified*) + crew + Move.ai Plus/Advanced $225–490/mo for one month | Own footage; Move.ai paid output commercial |
| 7 | **Physics ragdoll** (Rapier / Jolt WASM) with water drag/buoyancy | Wipeouts, falls, underwater tumbling | Engineering | Rapier Apache-2.0 / Jolt MIT (*unverified here*) |
| 8 | **Commercial libraries for filler**: Mixamo (free) / 100STYLE (CC BY) for beach locomotion; ActorCore skate pack as board-sync pipeline reference; CGTrader surf pack ($35) as a throw-away placeholder | Prototyping and non-surf filler | $0–~$100 | Royalty-free / CC BY |

**Rejected (decision log):**
- Marketplace surf packs as final animation: game-style quality.
- Text-to-motion for maneuvers: no surf data, no board dynamics; HY-Motion is also excluded in the EU/UK.
- GVHMR / PromptHMR / SMPLer-X / GENMO / Motion-X / AMASS-derived data for shipping: non-commercial licences.
- WHAM / TRAM / 4D-Humans for shipping without an SMPL commercial licence.
- RADiCAL and Meshcapade MoCapade: services closed.
- In-water IMU suit capture as the primary source: suits not waterproof; sparse-IMU ML is research-grade.
- Single-view phone apps on ocean footage as primary: small subject, moving camera, wrong ground prior.

### Answer: can we avoid hand-authoring every maneuver? [Assessment]

**Yes, mostly, but not by finding finished surf animation.** The viable path is to *build* a compact board-frame library:
- About 25–40 base clips from surfskate/land capture, refined against video-derived references.
- Parameterised by compression, lean, rotation phase and rail.
- Animated continuously by a procedural layer that reads board dynamics.

This covers paddling, pop-up, trim, pumping, bottom turns, high-line, rail-to-rail, cutbacks, stumbles and recovery. Roughly **30–40% of families still need authored work**: aerials, landings, re-entries/snaps polish, barrel postures, duck-dives, wipeouts and underwater (Cascadeur plus ragdoll). Video-to-mocap reduces authoring time by giving real-wave timing and poses, but it does not replace an animator.

---

## 11. Cheapest risk-reducing experiments

| # | Experiment | Cost | Success criterion |
|---|---|---|---|
| **E1** | **Video-HMR bake-off on 5 × 10 s clips** (wave-pool rear-follow, wave-pool side-on, beach telephoto side-on, drone high-rear, one top turn in spray). Run **GEM-X motion-video** (`--camera-mode vipe`, Contact/IK **off** and **on**) and **SAM 3D Body** per frame + smoothing. Overlay on video. Measure jitter, left/right swaps, feet-to-deck consistency. Internal evaluation only; check footage rights or use own clips. | ~1 GPU-day ($10–50) + 3 engineer-days | ≥ 70% of frames usable after light smoothing on the two close clips (trim, pump, bottom turn). Clearly report where it fails. |
| **E2** | **Board 6DoF + body-in-board replay**: on the best E1 clip, estimate the board pose (mask + 4–6 keypoints + PnP with a generic shortboard model), convert to `P_B`, then replay in Three.js on a board driven by a *different* synthetic trajectory with the procedural COM/IK layer. | ~1–2 engineer-weeks | An animator judges the decoupled replay as believable (no foot skate, plausible lean). This validates the whole decomposition. |
| **E3** | **One-day surfskate + land capture**: rent/buy Rokoko Smartsuit Pro II (or a mocopi ≈ $450 as an ultra-cheap pilot), phone IMU taped to the deck, intermediate–advanced surfer. Takes: pump, FS/BS carves, cutback, snap, pop-ups (good/bad), bench paddling, stumbles. Retarget in Blender, convert to B, play in Three.js. | ≈ $0.5–3k + 1 day talent + 3–5 days cleanup | ≥ 10 clips reach "believable" with ≤ 1 day cleanup each. |
| **E4** | **Cascadeur maneuver timing test**: an animator builds one frontside air reverse (with landing) and one wipeout-to-ragdoll hand-off, using AutoPhysics + inbetweening against video reference. | Trial/free tier for the test (commercial licence ≈ $19/mo later) + 3 animator-days | Each under 2 days and approved in a blind review against real footage. Gives the authoring cost per family. |
| **E5** (optional) | **Commercial single-view mocap sanity check**: run Move One s2, QuickMagic, Flow Studio and DeepMotion on the same E1 wave-pool clip and on a land pop-up. | Mostly free credits; < $100 | Decides whether any paid service beats GEM-X for surf footage (expected: no on water, yes on land). |

E1 + E2 retire the "video-to-mocap" risk. E3 retires the "can we capture surf-like motion cheaply" risk. E4 prices the authored residue.

---

## 12. Open items (could not be verified this session)

Unverified because the hosts were unreachable and the search budget was exhausted:
- ActorCore skate pack price; Kinetix and Truebones 2026 status.
- BEDLAM and CameraHMR licence files; Expy Kit licence; Auto-Rig Pro, Maya and MotionBuilder prices.
- The GEM-X weights' NVIDIA Open Model License text (Hugging Face blocked).
- Move.ai s2 credit rate (vendor pages conflict); Flow Studio dollar prices; the Cascadeur plan change of 2026-11-04.
- Absolute paddling stroke rates and joint angles for turns (full papers needed: Nessler 2019, Minahan 2025, *Multibody System Dynamics* 2025).
- Whether BlueCurl is a commercial product and its ship territories. This decides SMPL/HY-Motion/GVHMR relevance.

Primary sources for verification: [GEM-X repo](https://github.com/NVlabs/gem-x), [SAM 3D Body repo](https://github.com/facebookresearch/sam-3d-body), [MHR repo](https://github.com/facebookresearch/MHR), [GVHMR LICENSE](https://github.com/zju3dv/GVHMR/blob/main/LICENSE), [HY-Motion License.txt](https://github.com/Tencent-Hunyuan/HY-Motion-1.0/blob/master/License.txt), [LAFAN1 licence](https://github.com/ubisoft/ubisoft-laforge-animation-dataset/blob/master/license.txt), [Bandai Namco dataset](https://github.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset), [Motion-X licence](https://github.com/IDEA-Research/Motion-X/blob/main/LICENSE), [PromptHMR licence](https://github.com/yufu-wang/PromptHMR/blob/main/LICENSE), [SMPLer-X licence](https://github.com/caizhongang/SMPLer-X/blob/main/LICENSE), [GENMO licence](https://github.com/NVlabs/GENMO/blob/main/LICENSE), [Rokoko Blender plugin](https://github.com/Rokoko/rokoko-studio-live-blender).
