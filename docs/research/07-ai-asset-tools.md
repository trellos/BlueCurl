# 07 — AI-assisted asset production (Inv. 8) and AI video previs tool survey (Inv. 9)

Checked 2026-11-19. Author role: technical artist, deliberately sceptical.
Out of scope / brief only: video-to-mocap and text-to-motion (another researcher), environments/HDRI depth (another researcher).

## 0. How this was verified (read first)

| Channel | Status in this session | Consequence |
|---|---|---|
| Web search | Worked for ~40 queries, then the shared per-turn search budget ran out | Market facts are mostly **[Reported]** (search summaries of third-party articles) |
| WebFetch of vendor pages | **Blocked by the sandbox network allowlist** (ai.google.dev, huggingface.co, kling.ai, meshy.ai, stabmag.com, yardbarker.com, arxiv.org all fail DNS) | I could not open pricing pages or ToS directly |
| raw.githubusercontent.com | Reachable | Licence files and READMEs of open models are **[Verified]** |
| PyPI / npm | Reachable | I downloaded vendor SDK wheels (`pip download --no-deps`) and read the model IDs and parameter schemas. These count as **[Verified]** for "this API exists and accepts parameter X" |

Facts that come from my own prior knowledge and that I could not re-check today are labelled **[Unchecked]**. Treat them as leads to verify, not as findings. Before you spend money, re-check prices and ToS: allow the vendor domains in the session network settings, or have the user check them.

---

## 1. Executive summary

* **Concepts and mood boards are the only category where AI is production-usable today.** For anything that ships as a real-time glTF asset in a *realistic* scene, AI output is at best "usable with cleanup" and is usually worse than CC0 photogrammetry (Poly Haven / ambientCG) or a quick hand-built model. **[Assessment]**
* **The realistic human surfer should not come from AI 3D generation.** AI meshes have no facial or deformation topology, no proper hands, and no hair cards, and their textures carry baked lighting. Use a scan- or parametric-based human (MetaHuman, Character Creator or a scan store; another investigation covers this) plus a conventional rig. **[Assessment]**
* **AI video is a good previs and look-development tool and a bad motion reference.** Current models make convincing *mood* surf shots (light, spray, colour, camera language). They get board-foot contact, stance consistency, wave direction and wake physics wrong often enough that nothing should be copied from them as motion truth. Real pro surf footage remains the motion reference. **[Assessment, supported by Reported evidence in §5.3]**
* **Licensing traps:**
  * All Tencent Hunyuan open weights (3D 2.0/2.1, World 1.0, Video 1.5) exclude the EU, UK and South Korea, including use of *outputs* there. **[Verified]**
  * The FLUX.1/FLUX.2 [dev] and klein 9B weights are non-commercial. **[Verified]**
  * TRELLIS.2 is MIT but depends on NVIDIA nvdiffrast, which is research/evaluation-only. **[Verified]**
  * Sora is gone: the API shut down on 2026-09-24. **[Verified]**
* **This environment cannot generate anything.** It has no image or video API keys, no GPU (4 CPUs, 15 GB RAM), and vendor domains are firewalled. Prompts must go to the user's external tools (§7).

---

## 2. Image generation (concepts, textures, mood boards)

| Tool (current version) | Strengths for BlueCurl | Consistency features | API / automation | Licence / ownership | Cost |
|---|---|---|---|---|---|
| **OpenAI gpt-image-2.6** ("flare" / "sunburst" variants, 2026-11) | Top of blind-vote arenas in Oct–Nov 2026 **[Reported: budgetpixel, teamday]**; strong prompt adherence and text; good edits | Multi-image input and editing | Yes. Model IDs `gpt-image-2`, `gpt-image-2.5-*`, `gpt-image-2.6-flare/sunburst` are in the `openai` 3.55.1 SDK **[Verified]**. Also on Runway's API **[Verified]** | Outputs owned by user per OpenAI ToS **[Unchecked]** | gpt-image-2: $8/M image-in, $30/M image-out tokens **[Reported: the-decoder, dev.to]** |
| **Google Nano Banana family**: Nano Banana Pro = `gemini-3-pro-image`; Nano Banana 2 = `gemini-3.1-flash-image`; 2.1 / Lite | Best value for photoreal; strong multi-reference character consistency **[Reported]** | Up to ~6–14 reference images; sources disagree **[Reported]** | Yes. Model IDs in `google-genai` 3.6.1 **[Verified]**; `nano_banana_2.1` and `gemini_image3_pro` on Runway API **[Verified]** | SynthID invisible watermark **[Unchecked]**; Google claims no ownership **[Unchecked]** | NB2 ≈ $0.067 (1K) / $0.10 (2K) / $0.15 (4K); Pro ≈ $0.134 (1–2K) / $0.24 (4K) **[Reported]** |
| **Midjourney V8.x** (V8.2 default) | Best aesthetics for mood boards and cinematic framing **[Reported]** | V7 Omni-Reference reportedly replaced by a multi-image "Edit model" in V8 **[Reported, weak sources]** | **No official API** (absent from all aggregator SDKs I inspected **[Verified]**). Automating it breaches ToS **[Unchecked]** | Paid plan required. Companies with >$1M revenue need Pro/Mega. Images are public unless Stealth (Pro/Mega) **[Unchecked]** | $10/$30/$60/$120 per month **[Unchecked]** |
| **ByteDance Seedream 5** (lite / flash / pro / pro_layers) | Dense multi-reference composition; layered output variant | Multi-reference | `seedream5_*` on Runway API **[Verified]**; BytePlus ModelArk **[Unchecked]** | ByteDance/BytePlus ToS **[Unchecked]** | not checked |
| **BFL FLUX.2** (pro/flex via API; dev and klein open) | Photoreal; multi-reference editing in one model **[Verified README]** | Multi-reference | BFL API **[Unchecked]**. Open weights run in ComfyUI/diffusers | **klein 4B = Apache-2.0** (commercial OK). **klein 9B and FLUX.2 [dev] = FLUX Non-Commercial** **[Verified: flux2 README]**. FLUX.1 [dev]/Kontext [dev]: weights non-commercial; §2.d says outputs may be used commercially, but §4.a forbids commercial use of "any data produced by the model", an internal contradiction **[Verified: licence text]** | Self-host needs a GPU (klein 4B ~8 GB, dev ~H100 or quantised 4090) **[Verified]** |
| **Ideogram 4.0/4.5**, **Recraft v4.1** | Typography and vector (board logos, decals) | Style refs | On Runway API **[Verified]** | Commercial on paid plans **[Unchecked]** | not checked |
| **Stable Diffusion 3.5 / SDXL** (open) | Huge ControlNet/IP-Adapter ecosystem; used for texture projection in StableGen | IP-Adapter, LoRA | Fully scriptable (ComfyUI, diffusers), seeded, deterministic on fixed hardware | SDXL: CreativeML OpenRAIL++ **[Unchecked]**; SD3.5: Stability Community Licence (free under $1M revenue) **[Verified for SPAR3D, same licence family; SD3.5 Unchecked]** | GPU only |
| **Krea** | Aggregator UI plus realtime canvas; hosts Kling 3.0 etc. **[Reported: Krea docs]** | Depends on model | Has an API **[Reported]** | Depends on model | Kling 3.0 4K: $0.441/s **[Reported]** |
| **Adobe Firefly** | Commercially "safe" training data, Substance integration | n/a | API (enterprise) **[Unchecked]** | IP indemnity on enterprise plans **[Unchecked]** | n/a |

**Verdict [Assessment]:**
* For **photoreal concept stills with consistent surfer, board and location**, use **Nano Banana Pro/2.1** (Gemini app, AI Studio or Flow) or **gpt-image-2.6** (ChatGPT). Both take several references and edit conversationally.
* Add **Midjourney V8** only for hand-curated mood-board aesthetics. It is not part of a reproducible pipeline.
* For a self-hosted, licence-clean open model, the only fully commercial FLUX.2 weight is **klein 4B (Apache-2.0)**.

---

## 3. Image-to-3D / text-to-3D

### 3.1 Tools

| Tool | Status (Nov 2026) | Topology / UV / PBR | Control | API / scriptability | Licence | Notes |
|---|---|---|---|---|---|---|
| **Tripo** (VAST) | Model `v3.5-20260815`; API v3; official Python SDK `tripo3d` 1.0.0 (2026-10-14) **[Verified: SDK]** | `smart_lowpoly` (with `quad`, `face_limit`, `bake`, `smart_uv`), `mesh_uv`, `mesh_segment`, `pbr` flag **[Verified: SDK]**; "cleanest topology" in third-party roundups **[Reported]** | `model_seed` and `texture_seed` (reproducible), `face_limit`, geometry and texture quality tiers **[Verified]** | **Best scriptability in the category**: async Python client; rig (`biped`/`quadruped`, spec `mixamo` or `tripo`); preset retargets (idle, walk, run, …); `image_to_splat` **[Verified]** | Paid tiers grant commercial use **[Unchecked]** | Strongest candidate for automated props |
| **Meshy 6** | All-rounder: widest export set, remesh, auto-rig plus animation library, retexture **[Reported]** | Quad remesh, target polycount, PBR **[Reported]** | Seeds and polycount **[Unchecked]** | REST API (no official PyPI/npm SDK found **[Verified absence]**) | Free tier outputs CC BY 4.0; paid tiers private **[Unchecked]** | Good for texture variations of an existing mesh |
| **Rodin Gen-2** (Hyper3D / Deemos) | Highest fidelity in most roundups; quad mode; quality tiers **[Reported]**; "most repair-heavy" for print **[Reported]** | Quad and tri modes, PBR | Polycount tiers | REST API **[Unchecked]** | Commercial on paid plans **[Unchecked]** | Hero props (if any) |
| **Hunyuan3D 2.1** (open) / **3.x** (cloud) | 2.1 open weights, June 2025: 3.3B shape + 2B PBR paint; needs 10 GB (shape) / 29 GB (shape+texture) VRAM **[Verified: README]**. 3.x is Tencent-cloud only **[Unchecked]** | PBR paint model | Seeds (open) | Self-host or Tencent API | **Tencent Hunyuan Community Licence: "DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND SOUTH KOREA"**, and you "must not use … Output … outside the Territory". Also a 1M MAU cap and a ban on using outputs to improve other models **[Verified: LICENSE]** | **Rejected if anyone on the team or the deployment is in the EU/UK** (the reference location is Nice). Legally unusable there |
| **Microsoft TRELLIS.2** (open, 4B) | O-Voxel representation; PBR; GLB export with `decimation_target`, `remesh`, `texture_size` 4096; 512³ in ~3 s, 1536³ in ~60 s on H100; **needs ≥24 GB GPU** **[Verified: README]** | Remeshed triangles, PBR, alpha; output meshes carry hidden interior shells **[Verified: StableGen README]** | Seeds via pipeline | Python; ComfyUI nodes exist | Code and weights **MIT** **[Verified]**. **Caveat:** its render/bake path uses NVIDIA nvdiffrast, licensed "non-commercially … for research or evaluation purposes only" **[Verified: nvdiffrast LICENSE]**. Treat as a grey zone for production use | Best open option on quality **[Reported]**; cannot run here (no GPU) |
| **Sparc3D / Hitem3D** | High-res sparse-cube geometry, commercial front end Hitem3D **[Unchecked]** | High geometric detail, dense triangles | — | Web/API **[Unchecked]** | Unchecked | Watch-list |
| **Stability SPAR3D / SF3D** | 2025-era fast single-image 3D; behind 2026 SOTA **[Assessment]** | Low-poly UV'd output | — | Python | Stability Community Licence: free under $1M annual revenue; registration required; outputs owned by user **[Verified]** | Rejected: outdated quality |
| **CSM, Luma Genie** | Little 2026 activity found **[Unchecked]** | — | — | — | — | Not evaluated further |
| **StableGen** (Blender add-on) | Orchestrates TRELLIS.2 (mesh), SkinTokens (rig), SDXL / Qwen-Image (texture views), Marigold / StableDelight (PBR maps), LATO.2 (low-poly retopo); batch "Scene Queue"; glTF/FBX export **[Verified: README]** | Projection texturing from scene cameras, baked to UV PBR | Seeded diffusion | Blender plus ComfyUI server, so it can be scripted | **GPL-3.0** add-on (fine for internal tool use; outputs are not GPL) **[Verified]**; each sub-model has its own licence | The most complete open, self-hostable pipeline. Needs an 8–16+ GB GPU |

### 3.2 Honest quality picture **[Assessment]**

* **What works:** organic, closed, mid-frequency shapes (rocks, driftwood, coral lumps, generic beach props, buckets, coolers). Silhouettes are convincing at mid-distance.
* **What fails:**
  * Thin structures (palm fronds, fins, leashes, fences).
  * Precise CAD-like curves. A surfboard's rails, rocker and foil come out lumpy or asymmetric.
  * Human anatomy for close-up use.
  * Clean edge loops for deformation.
* **Textures:** albedo maps usually carry baked shading and highlights. "PBR" roughness and metal maps are estimates. A photoreal Three.js scene with a measured sky exposes this immediately.
* **Typical cleanup per prop** (my estimate for an experienced artist): 30–120 min. That covers delighting and repainting the albedo, decimating or retopologising to budget, fixing UV islands, removing interior shells, setting real-world scale and pivot, and LODs. By comparison, a Poly Haven CC0 scan needs about 10 minutes (decimate plus LOD).

---

## 4. Textures/materials, auto-rigging, motion, panoramas, worlds

### 4.1 Texture / material generation

| Option | Use | Licence | Verdict **[Assessment]** |
|---|---|---|---|
| **Poly Haven / ambientCG** (CC0 scanned PBR) | Sand, wet sand, rock, concrete, wood | CC0 **[Unchecked; well-established]** | **First choice for realism** |
| **Adobe Substance 3D Sampler** (Image-to-Material, AI upscale/delight) | Photo to tileable PBR set (e.g. a phone photo of local sand or rock) | Adobe subscription **[Unchecked]** | Best "AI-assisted" route for custom materials |
| Image model (gpt-image / Nano Banana / FLUX klein 4B) tileable prompts → normal/roughness via Materialize or Sampler | Decals, board deck graphics, wetsuit and boardshort prints | Per model above | Production-usable for **graphics/decals**; cleanup needed for **surfaces** |
| Meshy / Tripo retexture; StableGen projection | Texture variations on a fixed mesh (e.g. wetsuit colourways) | Per tool | Usable with cleanup |

### 4.2 Auto-rigging

| Tool | What it does | Licence / cost | Verdict |
|---|---|---|---|
| **Mixamo** (Adobe) | Humanoid auto-rig plus a large mocap library; FBX output | Free with an Adobe ID; royalty-free use **[Unchecked]** | Fine for prototypes. Rig is basic (no twist bones, limited fingers) |
| **Reallusion AccuRIG 2** | Free humanoid auto-rig with finger and pose tools; exports FBX/USD | Free **[Unchecked]** | Better than Mixamo for realistic proportions |
| **Tripo rig / retarget** | Biped/quadruped rig, `mixamo` skeleton spec, preset animations **[Verified: SDK]** | Paid credits | Convenient for AI meshes only |
| **Meshy auto-rig plus animation library** | Humanoid rig plus presets **[Reported]** | Paid | Same |
| **UniRig → SkinTokens** (VAST, SIGGRAPH '25) | Learned skeleton plus skinning for arbitrary meshes. SkinTokens claims "98–133% improvement in skinning accuracy" over UniRig **[Vendor claim]** | **MIT** **[Verified]** | Research grade. Not a substitute for hand-weighting a hero human |
| **Auto-Rig Pro** (Blender, non-AI) | Production humanoid rig, retargeting, glTF/FBX export | Paid add-on, roughly $40 **[Unchecked]** | **Recommended for the hero surfer** if we rig in Blender |
| **Anything World** | Rig and animate arbitrary models via API (PyPI package last updated 2024-11 **[Verified]**) | Paid | Stagnant; not needed |
| **Cascadeur** | AutoPosing plus AutoPhysics (physically plausible keyframing) | Freemium / indie licence **[Unchecked]** | Interesting for authoring pop-up and wipeout motions by hand (see the other researcher's motion report) |

### 4.3 Motion (pointer only)

Video-to-mocap and text-to-motion are covered by the other researcher. For context:
* **Text-to-motion** models have essentially no surf-specific training data. **[Assessment]**
* **Video-to-mocap from real pro footage** is the AI route most likely to matter for BlueCurl. **[Assessment]**
* **Do not run mocap extraction on AI-generated surf video.** You would be baking hallucinated physics into the animation. **[Assessment]**

### 4.4 Panoramas / HDRI (brief)

* **Blockade Labs Skybox AI** still exists. Its JS SDK on npm was last updated in 2023 **[Verified]**, and its HDR export is synthesised from LDR **[Unchecked]**.
* AI "HDRIs" lack a physically correct sun intensity and dynamic range. They are fine for *mood references* and **not viable for lighting**. **[Assessment]**
* ShoreBreak already owns the sky via a measured LUT. For IBL use real CC0 HDRIs (Poly Haven) or a capture.

### 4.5 3D worlds / Gaussian splats (brief)

* **What exists:**
  * World Labs **Marble** generates explorable worlds and exports Gaussian splats and meshes **[Unchecked]**.
  * **HunyuanWorld 1.0** is open but carries the same EU/UK/KR exclusion **[Verified: LICENSE]**.
  * Tripo has `image_to_splat` **[Verified: SDK]**.
* **Why it doesn't fit:**
  * Splats are not relightable.
  * They don't match a PBR/glTF scene under a dynamic sun.
  * They need an extra renderer in Three.js.
* **Verdict:** reference or distant-backdrop experiments only. **[Assessment]**

---

## 5. AI video generation for previs (Investigation 9 survey)

### 5.1 Model table

"Runway API" means the model is callable through Runway's developer API, which in late 2026 routes to many third-party models. I verified every Runway-API parameter below by reading `runwayml` 5.28.0 (2026-11-16): `types/image_to_video_create_params.py` **[Verified]**.

| Model | Max single clip | Resolution | Start/end frame (image-to-video) | Reference / character consistency | Seed | API | Cost (reported) | Notes |
|---|---|---|---|---|---|---|---|---|
| **Kling 4.0** (Kuaishou; Flash on 2026-09-28, global launch 2026-10-15/19) | **30 s single pass** **[Reported]** | 4K and 1080p 10-bit HDR **[Reported]**; Runway API tiers `auto_720p` / `auto_1080p` **[Verified]** | **First plus optional middle and last frames** **[Verified: Runway SDK]** | **Up to 10 reference images** (characters, objects, styles) **plus up to 5 reference videos (≤30 s total) for style, motion or camera** **[Verified]** | no | Runway API `kling_4`, `kling_4_flash` **[Verified]**; Kling's own API status for 4.0 unclear **[Reported]** | not found | Best candidate for **long continuous rear-chase takes** |
| **Kling 3.0** (Feb 2026) / 3.0 Turbo | 15 s **[Reported]** | Native 4K **[Reported]**; Runway API 4K variant **[Verified]** | First frame | Omni "O3" variants accept references **[Verified]** | no | Many (Runway, Krea, Atlas, fal) | Pro ≈ $0.17/s; 4K ≈ $0.44/s (Krea); Turbo ≈ $0.11–0.14/s **[Reported]** | Wave/foam tests rated well: foam direction and backlit spray **[Reported: oakgen]** |
| **ByteDance Seedance 2.5** (FORCE conf. June; release late July 2026) | **30 s single pass**; multi-turn extension **[Reported: ByteDance blog via search]** | 480p, 720p, 1080p, **4K** **[Verified: Runway SDK]** | **First/last keyframes OR reference images (cannot mix)** **[Verified]** | Up to ~50 multimodal refs **[Reported, conflicting]** | **yes** **[Verified]** | Runway API `seedance2_5`; Jimeng/Doubao; BytePlus later **[Reported]** | ~$1–2 per 30 s clip (estimate) **[Reported]** | **480p "draft" mode can be upgraded to 1080p with the same content within 7 days** **[Verified]**, which is ideal for cheap iteration. `mov` output **[Verified]**. Seedance 2.0 led the Artificial Analysis T2V-with-audio arena **[Reported]** |
| **Google Veo 3.1** (+ Fast, Lite) | 4/6/8 s per generation (Runway API) **[Verified]**; Flow "extend" chains longer **[Unchecked]** | 720p/1080p **[Verified]** | **First and last frame** **[Verified: Runway SDK and google-genai `last_frame`]** | `reference_images` in `GenerateVideosConfig` **[Verified: google-genai 3.6.1]** | **yes** | Gemini API / Vertex (`veo-3.1-generate-preview`, `veo-3.1-lite-generate-001` in SDK **[Verified]**), Runway, fal | Standard ≈ $0.40/s; Lite ≈ $0.05/s **[Reported: teamday]** | Strongest reported realism for water, fog and light **[Reported]**. A mid-2025 Veo 3 "surfing gorilla" clip was judged convincing on the wave face by surf media **[Reported: Stab, The Inertia]** |
| **Google Gemini Omni Flash** (I/O 2026-05-19; v1.2) | 3–15 s (v1.2) **[Verified: Runway SDK]** | Up to 3840×2160 options **[Verified]** | Image-to-video and video-to-video editing | Conversational multimodal editing **[Reported]** | no | Gemini API `gemini-omni-flash-preview`, `gemini-omni-1.1/1.2-flash` **[Verified: SDK]**; Runway | ≈ $0.10/s preview **[Reported]** | Useful for "change X in this clip" iterations |
| **Runway Gen-4.5** (Dec 2025) + **Aleph 2** (video-to-video) + Act-Two | 2–10 s **[Verified]** | 1280×720-class ratios **[Verified]** | First frame | Gen-4 References (image model) | **yes** | Runway API; official Python and TS SDKs | Credits **[Unchecked]** | **Only model with HDR10/HLG/ProRes/EXR ACEScg output** **[Verified]**, useful for grading. Runway admits causality failures **[Vendor statement]** |
| **Alibaba Wan 3.0** (closed beta 2026-08-06) / **Wan 2.2** (open) | Wan 3.0: 30 s **[Reported]**. Wan 2.2: ~5 s, 720p@24 fps **[Verified: README]** | Wan 3.0 up to 1080p **[Verified: Runway SDK]** | Keyframe first/last OR references **[Verified]** | Reference videos ≤15 s **[Verified]** | no | Runway API `wan3`, `wan3_prime`; Alibaba Model Studio | — | **Wan 3.0 weights are closed** **[Reported: Morphic, JXP, eWeek]**. Wan 2.2 is **Apache-2.0** **[Verified]**; its 5B model runs on a 4090, A14B needs 80 GB **[Verified]** |
| **Lightricks LTX-2.5** (open) | Default 121 frames at 24 fps (~5 s); duration head optional **[Verified: README]** | Up to 3840×2176 **[Verified]** | Keyframe pipeline **[Verified]** | IC-LoRA | yes (local) | Self-host (22B; fp8 and offload options) | Free if <$10M revenue | **LTX-2.x Community Licence: commercial entities with ≥$10M annual revenue need a paid licence** **[Verified]**. Best self-hostable option, but no GPU is available here |
| **MiniMax Hailuo 3** | not checked | Adaptive ratios **[Verified]** | yes | Refs plus reference videos (lite/highspeed) **[Verified]** | no | Runway API **[Verified]** | — | Not evaluated |
| **Luma Ray** | `lumaai` SDK 1.21.0 (2026-04) lists only `ray-2` / `ray-flash-2` **[Verified]**; Ray3 HDR exists in Dream Machine **[Unchecked]** | — | yes | — | — | Luma API | — | Deprioritised: could not verify current state |
| **HappyHorse 1.0** | — | — | — | — | — | Runway API `happyhorse_1_0` **[Verified]** | — | Topped the AA no-audio T2V arena in April 2026 **[Reported]** |
| **Pika** | — | — | — | — | — | — | — | Consumer/effects-oriented **[Unchecked]**; not recommended |
| **OpenAI Sora 2** | — | — | — | — | — | **Shut down.** App closed 2026-04-26; `openai` SDK marks the Videos API "scheduled to permanently shut down on September 24, 2026" **[Verified: SDK; Reported: OpenAI help centre, Axios]** | — | **Rejected** |

### 5.2 Licensing of video outputs **[Unchecked unless stated]**

* Paid tiers of Kling, Runway, Google (Flow/Gemini/Vertex), Seedance (Jimeng/BytePlus) and Hailuo generally grant commercial use of outputs. Free tiers are watermarked and/or non-commercial.
* Google embeds SynthID.
* Purely AI-generated footage is likely **not copyrightable** in the US (US Copyright Office AI report, 2025). This doesn't matter for internal previs, but it does matter if previs is ever published.
* Do **not** prompt with real pro surfers' names or likenesses. That raises right-of-publicity issues, and the FLUX licence explicitly bans "digital replica" infringement **[Verified for FLUX]**.

### 5.3 How well do they render SURFING? (evidence)

* **No rigorous surf-specific benchmark exists.** Several searches found none. **[Reported: absence]**
* **Physics-benchmark baseline.** Physion-Eval (arXiv 2603.19607, March 2026) found that **83.3% of exocentric generated videos contain at least one human-identifiable physical glitch** in physics-critical scenarios. Leading MLLM critics mostly fail to detect them, so automated QA of AI previs isn't reliable either. **[Reported]**
* **Surf media verdicts.**
  * The 2025 Veo 3 "surfing gorilla" clip was called "super capable on the face and in the barrel" (Stab, 2025-07-08). The Inertia said it was "obviously not real, but not because it looks fake".
  * A SURFER/Yardbarker roundup called most AI surf clips "laughably unrealistic".
  * Swellnet commenters noted channels pumping out AI surf videos that many viewers can't tell from real.
  * Conclusion: *short, wide, well-lit* surf clips can pass; detailed ones often don't. **[Reported]**
* **Water tests.** In a 20-prompt Kling 3.0 vs Veo 3.1 test, Kling's ocean-wave clip scored 8.5 vs 8.0: foam matched wave direction and spray caught backlight realistically. A separate Iceland wave test praised Kling's sense of weight. **[Reported: oakgen.ai and others; vendor-adjacent blogs, small samples]**
* **Generic water failures** are well documented: water flowing uphill, a jet-skier's wake appearing *in front* of him, broken oar/reflection interaction. Water displacement is one of the most-reported failure categories. **[Reported: the-decoder, invideo FAQ, unite.ai]**
* **Brand artefacts.** Training data is full of logo-covered surf gear, so models invent brand lettering on boards and wetsuits unless told not to. **[Reported: Morphic]**

**Expected failure modes for our shots [Assessment]:**
1. Board-foot contact drift and feet sinking into the deck.
2. Stance flipping (regular to goofy) between clips.
3. Fins and leash appearing or disappearing.
4. The board morphing in length or outline.
5. The surfer riding *in front of* the whitewater, or the wave peeling the wrong way relative to the turn.
6. Spray and wake that don't follow the rail.
7. Hands and fingers during the pop-up.
8. The paddle stroke cadence becoming noodly.
9. Wipeouts: bodies merging with the board or water.

Two further issues are specific to us:
* **Defaults vs our wave.** Models default to barrelling, peeling point-break waves and to beach-side or drone angles. ShoreBreak is a *shore-break*, and our camera is a **continuous low rear chase**, which appears far less often in training data (water-housing or jet-ski follow-cam footage). Expect weaker prompt adherence for exactly our camera.
* **Contact physics is where AI previs is least trustworthy.** This is also the thing BlueCurl must get right, so AI previs should define **look, light, framing and pacing**, never **body mechanics**.

### 5.4 Long takes

* **Native long takes:** Kling 4.0 and Seedance 2.5 do **30 s in one pass** **[Reported]**. Wan 3.0 also claims 30 s **[Reported]**.
* **Everything else** needs chaining: last frame of clip N becomes first frame of clip N+1, where supported. Joins show identity drift and motion discontinuities. **[Assessment]**
* **An indefinitely running chase cam cannot be previs'd as one continuous AI shot.** Target 10–30 s representative beats per phase.

---

## 6. This environment's capabilities (checked 2026-11-19)

* **Env-var names only** (values never printed): `GH_TOKEN`, `GITHUB_TOKEN`, `CLOUDSDK_AUTH_ACCESS_TOKEN`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, plus harness tokens. There are **no image/video vendor keys** (OpenAI, Gemini, Replicate, fal, Runway, Kling, Luma, BFL, Stability).
* **gcloud** is installed and has an access token, but no project is configured. Using Vertex AI (Veo/Imagen) would need a billed project with the APIs enabled. That is outside the "don't sign up or buy" rule, so I did not try it.
* **Hardware:** no GPU (`nvidia-smi` absent), 4 CPUs, 15 GB RAM. **No local diffusion or 3D generation is feasible.**
* **Network:** vendor domains are blocked by the sandbox allowlist (ai.google.dev, huggingface.co, kling.ai, meshy.ai). GitHub raw, PyPI and npm work. API keys alone would therefore not be enough; hosts would also need to be allowlisted.
* **Useful local tools:**
  * `ffmpeg` (frame extraction for start-frame chaining, contact sheets, comparison grids).
  * Python 3 and Node 22.
  * `bpy` 5.3.0 on PyPI (headless Blender), which makes scripted cleanup feasible: import, decimate, scale and pivot fixes, glTF export.
  * `@gltf-transform` via npm for compression and LOD.
* **Practical implication:** the lead writes prompts and reference specs, the user runs them in external tools, and outputs come back into the repo for review and logging.

---

## 7. Recommendations for the user's external tools

### 7.1 Which tools

| Purpose | Primary | Secondary | Why |
|---|---|---|---|
| **(a) Concept stills / mood boards / character + board sheets** | **Nano Banana Pro** (Gemini app or AI Studio) | **gpt-image-2.6** (ChatGPT); **Midjourney V8** for pure mood | Multi-reference consistency and conversational edits; photoreal; cheap per image **[Reported]**. MJ for aesthetics only |
| **(b) Video previs** | **Kling 4.0** (long takes; first/middle/last frames; 10 refs plus reference *videos*, so real chase-cam footage can steer the camera) | **Seedance 2.5** (30 s, keyframes, seed, cheap 480p drafts) and **Veo 3.1** (water realism, first/last frame, seed; 8 s) | Best fit for continuous chase-cam beats plus consistency controls **[Verified params / Reported quality]** |
| One account for A/B tests | **Runway API/app** (routes Kling 4, Seedance 2.5, Veo 3.1, Gemini Omni, Wan 3, Hailuo 3 behind one key) **[Verified: SDK]** | fal.ai | One bill, one script, comparable outputs |

### 7.2 Consistency recipe (surfer / board / environment / camera)

1. **Write a "previs bible" in the repo**, as JSON plus reference images:
   * **Surfer sheet:** front, side, back and ¾ views; wetsuit or boardshorts colourway; hair; skin tone; build. No real person's likeness.
   * **Board sheet:** outline, deck and bottom, fin setup (thruster), leash on the *back* foot, colour, no logos.
   * **Stance:** state it explicitly (e.g. "regular-foot: left foot forward") in every prompt.
   * **Environment plate:** beach, headland, sun azimuth and elevation, time of day, water colour. Match the ShoreBreak reference clip.
   * **Camera spec:** "continuous rear chase camera, 2–4 m behind the surfer, lens ~1 m above the water, 28–35 mm equivalent, slight lag and roll, no cuts".
2. **Generate the sheets** with Nano Banana Pro or gpt-image using multi-reference input. Iterate until locked, then freeze them as files.
3. **Make start frames** for each shot with the same image model, feeding the sheets as references. Fix lighting and camera *in the still* first.
4. **Run image-to-video from the start frame**, also passing the sheets as references (Kling 4: `references`; Seedance 2.5: refs *or* keyframes, not both).
   * Where supported, pass **real** rear-chase surf footage as a Kling 4 reference video for camera language only.
5. **Chain shots.** Extract the last frame (`ffmpeg -sseof -0.1 -i shotN.mp4 -frames:v 1 shotN_last.png`), clean it in the image tool if it has drifted, and use it as the next first frame. Use last-frame targets (Veo, Kling, Seedance, Wan) to land on planned poses.
6. **Log seeds.** Same seed plus same inputs gives "similar results" only (Runway docs) **[Verified]**, not bit-exact. Log model ID and version, seed, prompt, reference file hashes and output path in `previs/log.jsonl` so any shot can be regenerated or replaced.
7. **Use a fixed prompt template** per phase (Paddling / Pop up / Riding / Drop out). Change only the action clause.
8. **Budget for retries.** Plan a 3–10× regeneration ratio, and reject any clip with stance flips or broken board contact.

---

## 8. Asset-type matrix

Quality scale: production-usable / usable with cleanup / reference only / not viable.

| Asset type | Best AI option today | Realistic AI quality | Better non-AI alternative | Verdict **[Assessment]** |
|---|---|---|---|---|
| **Rigged human character** (realistic surfer) | Tripo/Meshy image-to-3D plus auto-rig; StableGen (TRELLIS.2 + SkinTokens) | **Not viable** for a realistic close chase cam (topology, face, hands, hair, baked lighting) | Scan- or parametric-based human (MetaHuman / Character Creator / scan store) plus Auto-Rig Pro or AccuRIG | **Non-AI.** AI only for concept sheets |
| **Clothing variations** (wetsuits, boardshorts, rash vests) | Image model for prints and colourways; Meshy/Tripo retexture; StableGen projection | **Usable with cleanup** (textures only) | Marvelous Designer / hand-modelled garment plus Substance | AI for print and colour variants on a hand-made garment |
| **Surfboard models** | Image-to-3D (Tripo/Rodin) | **Reference only** (lumpy rails, asymmetric outline, fins fused) | Parametric Blender model from outline, rocker and thickness curves (a few hours; trivially variable) | **Non-AI geometry**; AI for deck graphics and decals (production-usable) |
| **Vegetation** (palms, dune grass) | Image-to-3D, splats | **Not viable** (thin fronds, no alpha cards, no wind setup) | Procedural or card-based palms (ShoreBreak already has some), SpeedTree, CC0 scans | **Non-AI** |
| **Rocks** | Tripo / Rodin / TRELLIS.2 (TRELLIS.2 excluded where nvdiffrast's licence bites) | **Usable with cleanup** (best AI category) | Poly Haven / ambientCG CC0 photogrammetry | **Prefer CC0 scans**; AI as fallback for specific shapes |
| **Coastal terrain** | World generators (Marble, HunyuanWorld) | **Reference only** (splats not relightable; HunyuanWorld licence-excluded in the EU/UK) | Real DEM / heightfield plus Gaea/Houdini plus CC0 materials | **Non-AI** |
| **Background scenery** (headlands, town, hills) | Image-generated matte painting on cards or skydome layers; splats for experiments | **Usable with cleanup** (must be colour-matched to ShoreBreak's sky LUT; static lighting) | Photo plates / own photography; low-poly terrain plus CC0 textures | **Viable AI niche**, if graded to match. Test it |
| **HDRI environments** | Skybox AI etc. | **Reference only** (fake dynamic range, wrong sun energy) | Poly Haven CC0 HDRIs, own capture; ShoreBreak's measured sky | **Non-AI** |
| **Skeletal animations** | Video-to-mocap from *real* footage (other researcher); text-to-motion | Mocap from real footage: usable with cleanup. Text-to-motion for surfing: **not viable** | Mocap capture plus hand-keyed animation (Cascadeur) | See the motion report. **Never** mocap AI-generated video |
| **Reference footage / video mockups** | Kling 4.0, Seedance 2.5, Veo 3.1 | **Usable for previs** (look, light, camera, pacing); **reference only** for motion and contact | Real pro surf footage (primary reference per the brief) | **Use AI for previs, real footage for motion truth** |
| **Concept images / mood boards** | Nano Banana Pro, gpt-image-2.6, Midjourney V8 | **Production-usable** (for their purpose) | Photo boards from real footage stills | **Use AI** |
| **PBR textures** | Substance Sampler image-to-material; image-model tileables plus map derivation | **Usable with cleanup** | CC0 scanned PBR (Poly Haven, ambientCG) | **CC0 first**, AI-assisted for custom or local materials and decals |

---

## 9. Favoured reproducible workflows

1. **Previs shot pipeline (manual generation, scripted bookkeeping).**
   * Bible JSON → prompt templates → user generates in Kling / Seedance / Veo.
   * Outputs are dropped into `previs/raw/`.
   * A small script (ffmpeg) builds contact sheets, extracts last frames for chaining, and appends to `log.jsonl`.
   * Replacing a shot means re-running from its logged inputs.
2. **Prop pipeline (if the user later provides an API key and allowlisted host).**
   * Tripo Python SDK: `image_to_model(model_seed, texture_seed, face_limit)` → `smart_lowpoly(quad, bake, smart_uv)`.
   * Headless `bpy` script: scale, pivot, interior-shell removal, LOD.
   * `gltf-transform` for compression, then a Three.js turntable under ShoreBreak lighting.
   * Fully scriptable from Claude Code, seeded, and replaceable per asset.
3. **Self-hosted open pipeline (only on a rented 24 GB+ GPU).** StableGen / ComfyUI with TRELLIS.2, SDXL or Qwen-Image, Marigold and LATO.2. Before any shipped use, check the licence of each component (nvdiffrast).
4. **Concept pipeline.** Nano Banana Pro / gpt-image sessions seeded from the frozen sheets. Every accepted image is saved with its prompt and reference list next to it.

## 10. Rejected tools (decision log)

| Tool | Reason |
|---|---|
| OpenAI Sora 2 | Discontinued. API shut down 2026-09-24 **[Verified]** |
| Hunyuan3D 2.x open, HunyuanWorld 1.0, HunyuanVideo 1.5 | Licence excludes the EU/UK/South Korea, including use of outputs there; ban on using outputs to train other models **[Verified]**. Unacceptable risk for a project modelled on Nice |
| FLUX.1 [dev], Kontext [dev], FLUX.2 [dev], klein 9B weights | Non-commercial weight licences; contradictory output clause in FLUX.1 [dev] **[Verified]**. Use the BFL API or klein 4B (Apache) instead |
| Stability SPAR3D / SF3D | Outdated quality; Community Licence capped at $1M revenue **[Verified]** |
| Midjourney as a *pipeline* tool | No official API; not scriptable or reproducible. Keep for manual mood boards only |
| AI HDRI generators (Skybox AI etc.) for lighting | Not physically based; ShoreBreak owns the sky anyway |
| AI-generated hero human (any image-to-3D) | Not viable for a realistic close chase cam |
| Text-to-motion for surf manoeuvres | No surf training data; robotic results expected (defer to the motion report) |
| Mocap extraction from AI video | Bakes hallucinated physics into the animation |
| Luma Ray, Pika, CSM, Luma Genie | Could not verify the 2026 state; no evidence they beat Kling / Seedance / Veo. Revisit only if a test shows otherwise |
| TRELLIS.2 / LTX-2.5 / Wan 2.2 self-hosting *here* | No GPU in this environment (legitimate elsewhere, subject to licence notes) |

## 11. Cost estimate (previs + concept phase)

All figures are **[Assessment]** built on **[Reported]** prices. Re-check them before buying.

| Item | Assumption | Estimate |
|---|---|---|
| Concept stills | ~300 generations via Nano Banana Pro / gpt-image at ~$0.07–0.20 each, or a $20–30/mo consumer plan | $20–60 |
| Midjourney (optional) | 1 month Standard | ~$30 |
| Video exploration | ~1,500 s generated at draft or cheap tiers (Seedance 480p draft, Veo Lite $0.05/s, Kling Turbo ~$0.11–0.14/s) | $75–225 |
| Video finals | ~300 s at $0.15–0.45/s (Kling Pro / 4K, Veo 3.1 Standard) | $45–135 |
| 3D trial | 1 month Tripo or Meshy plus credits (if Experiment 3 runs) | $20–60 |
| **Total** | | **≈ $200–500; recommend a $750 cap** |

## 12. Proposed experiments

1. **Surf realism bake-off.** Use one locked start frame (rear chase, mid-face bottom turn, regular stance) and one prompt.
   * Run it through Kling 4.0, Seedance 2.5, Veo 3.1, Gemini Omni 1.2 and Gen-4.5, with 3 seeds each and 8–10 s clips.
   * Score blind on: board-foot contact, stance consistency, wave peel vs turn direction, spray/wake following the rail, camera-spec adherence, identity drift.
   * Cost ~$30–60. Decides the previs tool.
2. **Long-take continuity.** Make a 60 s ride two ways:
   * (a) 2 × 30 s Kling 4.0 / Seedance 2.5 joined by last-frame chaining;
   * (b) 8 × 8 s Veo 3.1 chained the same way.
   * Judge join visibility and drift. This tells us how far beyond one clip AI previs can go.
3. **Prop pipeline vs non-AI.** Take a rock, a beach cooler and a surfboard through Tripo v3.5 (API, seeded) → bpy cleanup → glTF, and time it.
   * Compare against a Poly Haven rock and a parametric Blender board in Three.js under ShoreBreak lighting.
   * Record cleanup minutes and blind believability ratings.
4. **Concept consistency.** Make a surfer and board sheet, then 10 varied shots each in Nano Banana Pro and gpt-image-2.6. Count identity, board and stance errors. This decides the concept tool and the reference-sheet format.

## Sources

Primary or quasi-primary, inspected directly:
- Tencent Hunyuan3D-2.1 licence: https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2.1/main/LICENSE (same territory clause in Hunyuan3D-2, HunyuanWorld-1.0, HunyuanVideo-1.5 LICENSE files); README https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1
- TRELLIS.2 README and licence: https://github.com/microsoft/TRELLIS.2 ; nvdiffrast licence: https://github.com/NVlabs/nvdiffrast/blob/main/LICENSE.txt
- FLUX.2 README (licence table): https://github.com/black-forest-labs/flux2 ; FLUX.1 [dev] licence: https://github.com/black-forest-labs/flux/blob/main/model_licenses/LICENSE-FLUX1-dev
- Wan 2.2 README and Apache licence: https://github.com/Wan-Video/Wan2.2
- LTX-2 README and LTX-2.x Community Licence: https://github.com/Lightricks/LTX-2 (LICENSE-2_x)
- Stability Community Licence (SPAR3D): https://github.com/Stability-AI/stable-point-aware-3d/blob/main/LICENSE.md
- UniRig / SkinTokens (MIT): https://github.com/VAST-AI-Research/UniRig , https://github.com/VAST-AI-Research/SkinTokens
- StableGen (GPL-3.0): https://github.com/sakalond/StableGen
- SDKs inspected: `runwayml` 5.28.0, `google-genai` 3.6.1, `openai` 3.55.1, `tripo3d` 1.0.0, `lumaai` 1.21.0 (https://pypi.org/project/runwayml/ , /google-genai/ , /openai/ , /tripo3d/ , /lumaai/); npm `@blockadelabs/sdk`, `@runwayml/sdk`, `@fal-ai/client`

Reported (third-party, via search; not opened directly):
- Sora shutdown: https://help.openai.com/en/articles/20001152-what-to-know-about-the-sora-app-discontinuation , https://www.axios.com/2026/03/24/openai-discontinue-sora-video-app , https://the-decoder.com/openai-sets-two-stage-sora-shutdown-with-app-closing-april-2026-and-api-following-in-september/
- Kling 4.0: https://kling.ai/blog/kling40-kling-visual-realism-creative-control-introducing-storytelling , https://aiweekly.co/alerts/kuaishous-kling-ships-kling-40-flash-to-annual-subscribers-30-second-4khdr-ai ; Kling 3.0 pricing: https://docs.krea.ai/api-reference/video/kling-30.md , https://www.atlascloud.ai/blog/guides/kling-3-0-review
- Seedance 2.5: https://seed.bytedance.com/en/blog/one-take-creation-flexible-referencing-introducing-seedance-2-5 , https://thenextweb.com/news/bytedance-seedance-2-5-ai-video-4k-30-seconds , https://technode.com/2026/07/31/bytedance-launches-seedance-2-5-video-generation-model/
- Gemini Omni: https://techcrunch.com/2026/05/19/googles-gemini-omni-turns-images-audio-and-text-into-video-and-thats-just-the-start/ , https://thenextweb.com/news/google-gemini-omni-flash-video-model-io-2026
- Runway Gen-4.5: https://runwayml.com/research/introducing-runway-gen-4.5
- Wan 3.0 closed: https://morphic.com/resources/models/wan-3-0 , https://www.jxp.com/wan/blog/is-wan-3-0-open-source , https://eweek.com/news/alibaba-wan3-ai-video-documents-apac-china/
- Video price table: https://www.teamday.ai/blog/best-ai-video-models-2026 ; AA arena: https://artificialanalysis.ai/video/leaderboard/text-to-video
- Image rankings/prices: https://budgetpixel.com/learn/best-ai-image-generators , https://www.teamday.ai/blog/best-ai-image-models-2026 , https://community.openai.com/t/introducing-gpt-image-2-available-today-in-the-api-and-codex/1379479 , https://the-decoder.com/openais-chatgpt-images-2-0-thinks-before-it-generates-adding-reasoning-and-web-search-to-image-creation/ , https://tech-insider.org/how-to-use-nano-banana-2-api-2026/
- Midjourney V8: https://docs.midjourney.com/docs/models , https://www.issoh.co.jp/md/tech/11424
- 3D tool roundups (vendor-adjacent): https://www.3daistudio.com/3d-generator-ai-comparison-alternatives-guide/best-image-to-3d-tools-2026 , https://sorceress.games/blog/bench-an-image-to-3d-model-generator-browser-8-models , https://www.krea.ai/blog/best-ai-3d-model-generators-2026
- Surf and physics evidence: https://stabmag.com/stabcinema/ai-officially-rips-harder-than-you/ , https://www.theinertia.com/surf/ai-generated-surfing-gorilla-rips/ , https://www.yardbarker.com/surfing/articles/the_best_worst_ai_generated_surf_clips/s1_17305_42387677 , https://swellnet.com/comment/1018348 , https://arxiv.org/abs/2603.19607 (Physion-Eval) , https://oakgen.ai/blog/kling-3-vs-veo-3-1-tested , https://morphic.com/resources/videos/surfing-stock-footage , https://the-decoder.com/ai-video-generators-like-openais-sora-dont-grasp-basic-physics-study-finds/
