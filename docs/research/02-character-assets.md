# 02 — Surfer character assets (realistic rigged humans for three.js)

Investigation 2 · checked 2026-11-19 · labels: **[Verified]** = I read the primary source (licence file, repo, code) myself;
**[Vendor claim]**, **[Reported]** (third-party/forum/search-engine excerpt), **[Assessment]** (my judgment).

> **Method caveat (read first).** In this session, vendor websites (metahuman.com, unrealengine.com, fab.com, reallusion.com,
> daz3d.com, cgchannel.com) could not be fetched: the sandbox network blocks them. GitHub and npm could be reached, so every
> open-source licence below is **[Verified]**. Commercial licence wording comes from search-engine excerpts of the vendor pages,
> so it is labelled **[Reported]** even where the quote is word-for-word. The web-search budget also ran out before I could
> check the TurboSquid/CGTrader licence text, Avaturn, the Unity Asset Store, VRoid and the Meshy/Rodin output terms. Those
> are marked "not verified in this pass". **Before any money is spent or anything ships, a human should re-read the five
> licences marked ⚠ in §3 directly.**

---

## 0. TL;DR

* **No vendor asset that looks good is clearly licensed for shipping a raw, extractable GLB to anonymous browsers.** The
  realistic tools (Reallusion, Daz, Fab/Epic content, marketplace stock) either require you to *take measures to stop end users
  extracting the model* or have not stated a position. A browser GLB can always be extracted, at minimum with a WebGL frame
  capture. The only sources with no such condition are the **open ones**: MakeHuman/MPFB2 (CC0), Anny (Apache-2.0), Meta MHR
  (Apache-2.0) and Microsoft Rocketbox (MIT). They look worse straight out of the box, so the realism has to come from our own
  texturing and sculpting.
* **MetaHuman** has the best anatomy and deformation for $0 (under $1M revenue). Since UE 5.6 (June 2025) it is officially
  allowed "with any engine or creative software" **[Reported]**. Two things are still open: whether serving it as a raw GLB to
  the public is allowed, and the Blender→GLB pipeline (export is officially Maya/Houdini; Blender goes through the free GPL
  "Character DNA" add-on). Grooms are not part of the DCC export.
* **Recommended:** a one-week **bake-off** between MetaHuman and Character Creator 5, both exported to GLB, testing the
  deep-crouch, twist and arms-out poses in three.js r186. The **primary candidate for milestone 1 is MetaHuman**, with a written
  licence confirmation from Epic requested in parallel. To make the licence risk zero over time (and for interchangeable
  surfers), build an **owned "BlueCurl body"** on an open topology (MPFB2/Anny, CC0/Apache): a commissioned scan or sculpt plus
  our own textures, sharing one skeleton and one corrective-shape set.

---

## 1. What the surfer actually needs (requirements lens)

| Need | Why it matters here | Implication |
|---|---|---|
| Believable **back, shoulders, glutes, hamstrings and calves** | The camera is a rear chase camera most of the time | Back-side anatomy and the body normal/albedo detail count for more than the face. A 4K **body** texture set is more valuable than the face rig. |
| Deformation in **deep crouch, torso twist, arms out, aerial tuck** | Surfing poses sit at the edge of joint limits, where linear-blend skinning (three.js's only skinning mode) breaks: candy-wrapper forearms, collapsing knees and hips, flat glutes, shoulder pinching | **Twist bones** (forearm, upper arm, thigh) plus **runtime corrective blend shapes** driven by joint angles (§6.1) |
| Little clothing | Boardshorts or a wetsuit/rash vest only. The skin covers most of the frame | The quality of the skin material, **wetness** and SSS matters more than the clothing library |
| Interchangeable surfers | Variety over an indefinite run | Same skeleton and same topology across variants, so animations, correctives and boardshorts are reused |
| Browser delivery | The GLB is downloadable by anyone | Licence must permit public distribution of mesh and textures, or the asset must be owned outright |

**[Verified] three.js r186 constraints** (read in the `three@0.186.0` npm tarball, the same revision ShoreBreak uses):
* `GLTFLoader` maps only `JOINTS_0`/`WEIGHTS_0` to `skinIndex`/`skinWeight`, so the limit is **4 influences per vertex**.
  `JOINTS_1`/`WEIGHTS_1` are ignored (`examples/jsm/loaders/GLTFLoader.js`, attribute table around line 2280). MetaHuman heads use **12** influences at LOD0 **[Reported, Epic LOD spec]** and must be reduced to the top 4 and renormalised.
* Bone matrices are read from a **`boneTexture`** (`skinning_pars_vertex.glsl.js`, `texelFetch`), so there is no practical
  uniform-based bone limit. 150–250 bones are fine; 700+ face joints are wasteful but they work.
* Morph targets are packed into a `DataArrayTexture` (`WebGLMorphtargets.js`). Memory is `verts × (1–3 attrs) × 16 B × N targets`
  (Float32). Example: 25k verts with position and normal × 40 correctives ≈ 32 MB of VRAM. That is acceptable, but sparse
  correctives should be split onto a sub-mesh or limited in count.
* Skinning is linear-blend only. There is no dual-quaternion skinning in core.
* Materials: `GLTFLoader` supports clearcoat, sheen, transmission, volume, specular, IOR, anisotropy, `KHR_texture_basisu`
  (KTX2), Draco, `EXT/KHR_meshopt_compression` and `KHR_mesh_quantization`. There is **no `KHR_materials_diffuse_transmission`**
  and **no built-in skin SSS**. Only a simple thickness-based `examples/jsm/shaders/SubsurfaceScatteringShader.js` exists, so
  skin needs a custom shader (§6.2). That suits ShoreBreak, which already uses custom ShaderMaterials.
* Tooling: `@gltf-transform/cli` 4.5.1 **[Verified, npm]** handles KTX2 (UASTC for normals, ETC1S for the rest), meshopt
  (preferred over Draco for skinned and morphed meshes) and resizing.

---

## 2. Candidate comparison

### 2a. Visual and rig quality

| Candidate | Anatomical realism | From behind (back/shoulders/legs) | Deformation (shoulder/back/hip/knee) | Skeleton | Extreme athletic poses | Skin material and maps | Hair |
|---|---|---|---|---|---|---|---|
| **Epic MetaHuman** (UE 5.6+/5.7 MetaHuman Creator in-engine) | Excellent. The parametric body is built from scan data **[Vendor claim]** | Good. Body anatomy is plausible, but the body textures are less detailed than the head; muscle definition is soft **[Assessment]** | Very good *in UE* thanks to RBF/pose-space body correctives in the body DNA. Outside UE they must be **evaluated or baked**; OpenRigLogic (MIT) can evaluate the DNA **[Verified repo]** | UE-style `metahuman_base_skel`. Twist bones and many helper/corrective joints. Face LOD0 has 713 joints **[Reported, Epic spec]**. Retargets easily to UE Manny, and to Mixamo via retargeting | Good. Correctives were designed for a wide range of motion **[Assessment]** | Head: albedo/normal/cavity/roughness plus animated wrinkle maps. Body: albedo/normal/roughness. Unreal's SSS profile is not exported | Strand grooms (UE only) plus card LODs. **Grooms are not in the DCC export** **[Verified, OpenRigLogic README]** |
| **Reallusion CC5** (+SkinGen, HD morphs, Headshot 3) | Very good. HD bases with "up to 16x" detail **[Vendor claim]**. Many athletic morph packs (paid) | Very good. Strong back/shoulder muscle morphs and detail normals **[Assessment]** | Good. Twist bones (2 per limb segment in UE skeleton **[Reported]**). Corrective expressions/morphs exist; the quality of pose-driven correctives is unverified | ~100–108 bones for CC3+ **[Vendor claim, manual]**, `CC_Base_*` naming. Has a UE-renamed export profile. Mixamo via retarget | Good with correctives; knees and hips need checking **[Assessment]** | SkinGen layered skin: albedo, normal, roughness, SSS mask, micro-normal, cavity. Exports as PBR textures | Cards (game-ready). Plenty of short and wet-capable styles |
| **Daz Genesis 9** | Very good in Daz | Good | Mediocre after export. Forum reports of game-engine skinning problems, twist-bone fixes and broken finger bones in UE/Unity **[Reported]**. JCMs (correctives) do not export cleanly **[Assessment]** | Daz-specific. Needs bridges and fixes | Fine in Daz, risky in engine | Good textures | Cards, dForce strands |
| **MakeHuman / MPFB2** (Blender) | Fair to good shape space. The default skin looks "MakeHuman-generic" **[Assessment]** | Fair. Needs custom sculpt and normals for muscle detail | Fair. Plain LBS weights with no correctives | `game_engine` 53 bones (UE-ish names), `mixamo` 52, `default` 163, Rigify **[Verified rig JSONs]**. **No twist bones** in the game rigs | Needs added twist bones plus correctives | Basic albedo. Our own textures required | Cards (CC0 community packs) |
| **Anny** (NAVER, 2025–26) | MakeHuman-derived parametric body with anthropometric controls **[Verified README]** | As MPFB | LBS. 104-bone compact rig **[Verified README]** | 104 bones; also SMPL-X/SOMA topologies | Base only | None (geometry model) | None |
| **Meta MHR (Momentum Human Rig)** | High-fidelity parametric body, 7 LODs, **neural pose correctives** **[Verified README]** | No textures; grey body | Strong: pose-corrective blendshapes shipped as `corrective_blendshapes_lod?.npz` **[Verified README]** | 204 pose params; GLB export with 4 influences in their three.js web viewer **[Verified README]** | Good base | None | None |
| **3D Scan Store** animation-ready body scans | Excellent (real scans, athletic males and females) **[Vendor claim]** | **Excellent**, real back anatomy | Not rigged ("ready for rigging") **[Reported]**. Rig and correctives are our job | None. We add one | Depends on our rig | Scan albedo/normal/displacement | Usually none or short |
| **Renderpeople / AXYZ rigged** | Good scans | Good, but mostly clothed archviz people | Basic skinning for crowds **[Assessment]** | 3ds Max/UE/Unity variants **[Reported]** | Poor (not built for it) | Baked textures | Baked or scan hair |
| **Microsoft Rocketbox** | Fair (2010s game quality) | Fair | Fair | 3ds Max Biped-style; Unity humanoid fix scripts **[Verified README]** | Poor to fair | Basic | Cards (look dated) |
| **AI generators** (Meshy, Tripo, Rodin, Hunyuan3D, TRELLIS) | Poor to fair. Lumpy anatomy, clothing fused to the body, no edge flow **[Assessment]** | Poor | Auto-rig without twist bones or correctives. Fine at ~30k tris for simple motions **[Reported]** | Generic humanoid | Breaks | Baked lighting in albedo is common | Fused to the head mesh |
| **Mixamo characters** | Stylised / low-fi | Poor | Basic | Mixamo, 52–65 bones | Poor | Basic | Cards |
| **Marketplace "surfer" models** (CGTrader/Superhive/TurboSquid) | Variable, mostly low-poly | Variable | Max Biped / Rigify, no correctives **[Reported]** | Mixed | Poor | Variable | Variable |

### 2b. Pipeline, budget, licence and diversity

| Candidate | Clothing (boardshorts / wetsuit / rash vest / swimwear) | Polycount (hero LOD0) / texture memory | GLB path | Licence and cost | **Web-redistribution risk** | Diversity |
|---|---|---|---|---|---|---|
| **MetaHuman** | Parametric "Outfit Assets" since 5.6. Fab has a parametric one-piece swimsuit **[Reported]**. Boardshorts/wetsuit would be our own, skinned to the body. Outfits are separate meshes, but **not included in the DCC export package** **[Verified, OpenRigLogic README]** | Head ~24k verts at LOD0 **[Reported, Epic spec]**. Body LOD0 ~30k unique verts **[Reported, forum]**. ~55–60k tris for body and head before stripping. Textures 4K head + body ≈ 60–100 MB VRAM with KTX2 **[Assessment]** | UE 5.6+ → *Export > DCC Export* (head + body DNA + textures) → Blender via Poly Hammer **Character DNA** add-on (GPL-3, free, OpenRigLogic-based) **[Verified repo]** → bake/strip the face rig → GLB. **Unproven end to end.** | UE EULA covers MetaHuman from 5.6. Free under $1M/yr revenue **[Reported]**. MetaHuman-specific content restrictions removed from the content-licence addendum **[Reported, Epic changelog excerpt]**. AI-training restrictions removed in EULA update 22 (Oct 2026) **[Reported]** | ⚠ **Medium–unknown.** "Any engine" is clear; serving a **raw GLB** publicly is not addressed, and the EULA distinguishes content "in source format". One 2026 blog asserts the opposite of the "any engine" reading (conflicting) **[Reported]** | Excellent: all ages, sexes, body types, skin tones, hair |
| **CC5** | Large clothing library (separate meshes, auto-conform). Swimwear packs exist; wetsuit/boardshorts available or made in Marvelous Designer | CC3+ base: 14,046 body polys, 17,683 with eyes/teeth **[Vendor claim, manual]**. HD subdivision levels much higher; export a game-level LOD (~20–40k tris) **[Assessment]** | CC5 → FBX (also OBJ/USD) **[Reported]** → Blender → GLB. **No native GLB export found** **[Reported]** | CC5 ≈ **$299**, Deluxe ≈ **$499** (perpetual), subscriptions since Jan 2026 **[Reported]**. Content packs extra. Standard Licence now includes the former "Extended" export rights **[Reported]** | ⚠ **Medium.** The EULA *allows* "games, applications, web services" but **6.3 requires measures to prevent access to the 3D models**, and the base topology and rig remain Reallusion property. No in-app character generator without an Enterprise licence (see §3) | Very good (morph packs, SkinGen, Headshot) |
| **Daz G9** | Huge library | 25k+ base, heavy | Daz → Diffeomorphic/Bridge → Blender → GLB (painful) | Interactive Licence ≈ **$50 per product**, needed for the base figure and every morph/outfit **[Reported, forums]** | ❌ **High.** The EULA reportedly bars distributing a product "from which the content can be separately exported, extracted or de-compiled" **[Reported]** | Very good |
| **MPFB2 / MakeHuman** | CC0 system clothes are basic. Boardshorts/wetsuit we model ourselves (MHCLO proxies fit any body) | ~13–19k verts (with helpers removed ~13k) **[Assessment]**. Our own textures | Blender → glTF (native exporter) | **CC0 assets, GPL-3 code, output unrestricted** **[Verified LICENSE.md]** | ✅ **None** | Good shape space; skin and hair need our own work |
| **Anny** | None | MakeHuman topology (triangulated) | Python → mesh → Blender → GLB | **Apache-2.0** code; data CC0 (from MPFB2). The SMPL-X topology option is **non-commercial** **[Verified README/LICENSE]** | ✅ None (avoid the `smplx` topology) | Wide age/anthropometry range |
| **Meta MHR** | None | LOD0–6 | Built-in three.js web viewer exports **GLB with armature, 4 influences** **[Verified README]** | **Apache-2.0** **[Verified LICENSE]** (asset release tarball not separately inspected) | ✅ Low | Shape space 45 params |
| **3D Scan Store** | Scans in underwear/swimwear-like states suit surfers; no outfits | High-res scan + retopo; we bake 4K maps | Our rig → Blender → GLB | ~**£69.99** model + **Business Commercial Single Project £499.99** **[Reported, vendor page excerpt]** | ⚠ **Unknown.** Licence text not obtained | Limited by purchase (packs of 5 M / 5 F) |
| **Renderpeople / AXYZ** | Fixed baked clothing (business/casual) | 20–100k | FBX → GLB | ~$79 per rigged model **[Reported]** | ⚠ Unknown; excludes ML/CV **[Reported]** | Good, but wrong wardrobe |
| **Rocketbox** | Fixed clothing (115 characters, incl. professions) | Low-poly + LODs | FBX → Blender → GLB | **MIT** **[Verified LICENSE.md]** | ✅ None | Good (115 characters, adults and children) |
| **AI generators** | Fused | Varies | GLB native | TRELLIS.2 code **MIT** **[Verified]**. Hunyuan3D 2.1: "**does not apply in the European Union, United Kingdom and South Korea**" **[Verified LICENSE]**. Meshy/Tripo/Rodin output terms: not verified in this pass | Varies | Random |
| **Mixamo** | Fixed | Low | FBX → GLB | Free with an Adobe ID; "embedded, not raw files" **[Reported, Adobe staff on forum]** | ⚠ Medium | Low (stylised) |
| **SMPL / SMPL-X / STAR / SUPR** | None | ~7–10k verts | Python | **Non-commercial research** **[Reported, MPI licence pages]**. SMPL commercial licence was via Meshcapade (€1.5k–25k/yr, conflicting figures **[Reported]**) and is now via Max Planck Innovation after **Epic acquired Meshcapade (announced 18 Feb 2026)** **[Reported, mpg.de]** | ❌ for our use | Shape only |

---

## 3. Licence analysis: the "extractable GLB" trap

A three.js app sends the GLB (or any custom container) to every visitor's browser, and the GPU receives plain vertex buffers.
**Any** protection (encryption, a custom binary format, a vertex-quantisation shuffle) only stops casual right-click-save,
**not** a WebGL capture tool (Spector.js, RenderDoc on Chrome). Every licence that requires "preventing extraction" is
therefore satisfied at best by *reasonable effort*, and never with certainty. **[Assessment]**

| Source | Relevant clause (as found) | Reading for a public web app |
|---|---|---|
| ⚠ **Reallusion Content EULA** §6.3 ([EULA](https://www.reallusion.com/Content/EULA/EULA.htm), [ActorCore EULA](https://actorcore.reallusion.com/eula)) | *"Member shall take all reasonable and industry-standard measures to incorporate 3D Models within your creations to prevent other parties from gaining access to such 3D Models."* **[Reported, search excerpt of both EULAs, identical wording]**. Software EULA: you may export generated models *"and include them in games, applications, web services, or other interactive projects"*, but *"the unique topology and character rigs of CC Avatar … generated from Character Creator's Base Model are the property of Reallusion"* **[Reported]** ([AP EULA](https://www.reallusion.com/Content/EULA/AP/EULA_AP.htm)). Staff on the forum: *"the end user should not be able to access the actual character models"*, and in-game character generators are not permitted without Enterprise **[Reported]** ([forum](https://discussions.reallusion.com/t/clarification-on-eula-for-using-character-creator-with-custom-assets-and-edited-morphs-in-game-with-character-customization-system/14770)) | Web use is **contemplated**. We must obfuscate/encrypt and serve without a direct asset URL. A runtime "mix-and-match surfer" built from CC content parts would count as a **character generator → Enterprise**. Pre-baked, fixed surfers are fine. **Get written confirmation for WebGL.** |
| ⚠ **MetaHuman / UE EULA** ([licence page](https://www.metahuman.com/license), [UE EULA](https://www.unrealengine.com/eula/unreal), [content licence changelog](https://www.unrealengine.com/eula-change-log/content)) | MetaHuman page: *"MetaHumans can be used with any engine or creative software"*; included in the standard UE licence; free under $1M revenue **[Reported]**. UE EULA: assets *"developed using Engine Code"* such as character models are **non-engine products**, royalty-free if they *"do not include any Engine Code … and do not include Starter Content in source format"* **[Reported]**. Content licence changelog: the MetaHuman-specific restrictions were deleted from the addendum, and an exception was added to the UE-Only restriction in §5(c)(iii) **[Reported]**. Coverage: [CG Channel, 4 Jun 2025](https://www.cgchannel.com/2025/06/you-can-now-sell-metahumans-or-use-them-in-unity-or-godot/). Contrary claim: [StraySpark 2026 blog](https://www.strayspark.studio/blog/metahuman-2026-web-app-shutdown-migration-guide) | Usable in three.js **in principle**. Unclear: (a) whether a raw GLB counts as distributing content "in source format", (b) any anti-extraction duty. A single blog claims distribution needs `.mhpkg` packaging (that is probably the Fab *selling* format, not game shipping **[Assessment]**). **Ask Epic in writing.** |
| ⚠ **Fab Standard License** ([fab.com/eula](https://www.fab.com/eula)) | Official summary: commercial use in projects is allowed; you may not *"resell or redistribute the asset … on a standalone basis"*. A secondary source says buyers *"must restrict end users from extracting or using the Content outside the Project"* **[Reported, Licenseware wiki paraphrase]** | Applies to any Fab marketplace character, outfit or hair (incl. MetaHuman outfits bought on Fab). Same trap as Reallusion. |
| ❌ **Daz EULA** ([blog](https://www.daz3d.com/blog/daz-3d-interactive-license)) | Interactive Licence needed when 3D data ships in an app; content *"must remain embedded"*. Standard EULA bars any product *"from which the content can be separately exported, extracted or de-compiled into any re-distributable form or format"* **[Reported, forum quote]** | The strictest wording. A browser GLB fails it. **Reject.** |
| ⚠ **Sketchfab Store** ([licenses](https://sketchfab.com/licenses)) | Standard: royalty-free, no credit needed, no resale. Editorial: newsworthy uses only, and no making the material available *"so that third parties can download, extract, or redistribute it as a stand-alone item"* **[Reported]** | Editorial is out. Standard: confirm. CC-BY models: allowed with attribution, but quality is low. |
| ⚠ **Mixamo** ([FAQ thread](https://community.adobe.com/t5/mixamo-discussions/mixamo-faq-licensing-royalties-ownership-eula-and-tos/td-p/13234775)) | Games allowed; raw character/animation files may not be distributed on their own **[Reported]** | Embedded in an app is arguably fine; irrelevant for the hero character anyway. |
| ✅ **MPFB2** ([LICENSE.md](https://github.com/makehumancommunity/mpfb2/blob/master/LICENSE.md)) | *"These assets have been released under CC0 1.0 Universal."* / *"the MakeHuman team makes no claim whatsoever over output such as: Exports to files (FBX, OBJ, DAE, MHX2...)"* **[Verified]** | Clean. Third-party community assets (clothes, hair) carry their own CC licences; check each. |
| ✅ **Anny** ([repo](https://github.com/naver/anny)) | Code Apache-2.0; `data/mpfb2` CC0; *"A 'smplx' topology can be downloaded for non-commercial use only"* **[Verified]** | Clean if we stay on the `anny` topology. |
| ✅ **MHR** ([repo](https://github.com/facebookresearch/MHR)) | *"MHR is licensed under the Apache Software License 2.0"* **[Verified]** | Clean. (I did not open the downloadable asset tarball's notices; quick check needed.) |
| ✅ **Rocketbox** ([repo](https://github.com/microsoft/Microsoft-Rocketbox)) | MIT licence; *"November 2020 License Update: The library of avatars is now released under MIT License."* **[Verified]** | Clean (keep the copyright notice). |
| ❌ **MB-Lab** ([license.txt](https://github.com/animate1978/MB-Lab)) | *"The default license for models generated by the software is AGPL 3 … the models must be distribuited under AGPL 3"* **[Verified]**. Last commit June 2024 **[Verified]** | AGPL propagates to the shipped GLB (and arguably the app). **Reject.** |
| ❌ **SMPL family** ([SMPL-X licence](https://smpl-x.is.tue.mpg.de/modellicense.html), [STAR](https://github.com/ahmedosman/STAR), [SUPR](https://github.com/ahmedosman/SUPR)) | Non-commercial research only **[Reported]** | Reject (and not needed). |
| ❌ **Hunyuan3D 2.1** ([LICENSE](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1)) | *"THIS LICENSE AGREEMENT DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND SOUTH KOREA"* **[Verified]** | Reject for an EU-facing (Nice reference) product. |

**Owned-asset path.** A character we commission (work-for-hire scan or sculpt, with a model release from the scanned person)
built on CC0/Apache topology carries **no third-party restriction at all**. This is the only path that removes the trap rather
than managing it. **[Assessment]**

---

## 4. Notes per source (short)

* **MetaHuman (UE 5.6/5.7).** Creator now runs inside the engine; the cloud web app is being retired **[Reported]**.
  Parametric body from scan data plus parametric Outfit Assets that refit to body shape **[Vendor claim]**. Since 5.6, export is
  via *Character Export Tool → DCC Export* (head DNA + body DNA + textures as a zip) or as Skeletal Mesh assets
  **[Reported, Epic docs]** ([doc](https://dev.epicgames.com/documentation/metahuman/metahuman-creator-export-tool-in-unreal-engine)).
  Official DCC targets are Maya and Houdini; for Blender use **Character DNA** by Poly Hammer (formerly "Meta-Human DNA add-on",
  now free, GPL-3, "1-to-1 integration of the MetaHuman face board and body correctives via OpenRigLogic") **[Verified README]**
  ([repo](https://github.com/poly-hammer/meta-human-dna-addon)). Epic open-sourced **OpenRigLogic** (DNA + RigLogic, MIT,
  © 2026) **[Verified]** ([repo](https://github.com/EpicGames/OpenRigLogic)), which means the body-corrective logic is
  documented and portable. We could reimplement a JS evaluator for the *body* correctives, or bake them to morph targets.
  Grooms: the Maya/Houdini Groom Exporter writes Alembic *into* UE **[Reported]**. Getting **cards** out for the web means
  rebuilding hair cards (Blender, GS-Curves/HairTool) or buying card hair. Face: strip to roughly LOD2–3 (4 influences, ARKit-52
  blendshapes if needed); the rear camera rarely sees it. Known pain: parametric outfit missing in DCC export, deformation
  differences in Blender **[Reported, UE forums]**.
* **Reallusion CC5** (released 27 Aug 2025 **[Reported]**). HD bases, ActorMIXER, new HD morphs; "MetaHuman-friendly"
  **[Vendor claim]**. Best "artist-friendly" realistic-body tool. Exports FBX/OBJ/USD, so we do the GLB conversion ourselves.
  SkinGen layers give the best ready-made skin maps of any candidate. Content (morph packs, swimwear) is where the cost grows.
  ActorCore/AccuRIG are useful for **animation and rigging**, not as the hero source.
* **Daz G9.** Good renders, but the engine export is a known struggle (twist-bone and finger fixes; correctives lost) and has
  the strictest anti-extraction wording. Rejected.
* **MPFB2 / MakeHuman.** The licence-clean base (verified). Game rigs have no twist bones. We would add `upperarm_twist`,
  `lowerarm_twist` and `thigh_twist` and author 15–30 correctives. Realism lives or dies by our sculpt and textures.
* **Anny** (NAVER, Apache-2.0, v0.3 in Feb 2026). A cleaner, triangulated MakeHuman body with a 104-bone rig and broad
  anthropometrics. Good **identity generator** for interchangeable surfers.
* **Meta MHR** (Nov 2025, Apache-2.0). The most interesting open **deformation** source: LOD0–6 and pose-corrective blendshapes,
  plus a three.js viewer that exports GLB with 4 influences. Its correctives come from an MLP (sparse activation) **[Verified README]**,
  so for runtime use we would *sample* them into a fixed set of joint-angle-driven morph targets. No textures and no hair.
* **SOMA-X** (NVlabs, Apache-2.0, active Nov 2026) **[Verified]**. A unifying body layer over MHR/Anny/SMPL. Useful only as tooling.
* **3D Scan Store.** Real athletic bodies, which is exactly what a rear camera on a near-naked surfer benefits from. Unrigged,
  and the commercial licence is expensive per project with web terms unverified. Best used as **reference or bake source** if
  the licence permits; otherwise commission our own scan.
* **Renderpeople / AXYZ.** Archviz crowd people (clothed, posed). The wrong use case. Rejected for the hero.
* **Rocketbox.** MIT, 115 characters, dated. Fine for **beach crowd / background** or as a placeholder in pipeline tests.
* **AI 3D** (Meshy, Tripo, Rodin/Hyper3D, Hunyuan3D, TRELLIS). Output is a single fused shell with baked lighting, poor
  anatomy and auto-rigs without twist or correctives **[Assessment]**. At the camera distance of a surf shot, the silhouette and
  deformation in crouch would read as "game NPC". Possible use: concept blockouts and props only.
* **Ready Player Me.** Acquired by Netflix in Dec 2025; services shut down 31 Jan 2026 **[Reported]**
  ([TechCrunch](https://techcrunch.com/2025/12/19/netflix-acquires-gaming-avatar-maker-ready-player-me/)). Stylised anyway. Rejected.
* **VRoid.** Anime. Rejected (not researched further).
* **Human Generator** (Blender add-on, ~$128 commercial **[Reported]**). Realistic in Cycles. The output/game-redistribution
  licence was not found ([FAQ](https://help.humgen3d.com/faq)). Not shortlisted until the licence is read.
* **Marketplace surfers** (CGTrader, Superhive, TurboSquid, Free3D). Low-poly, Max-Biped/Rigify rigs, no correctives; some
  carry editorial-only or no-AI licences **[Reported]**. Rejected for the hero.

---

## 5. Ranked shortlist (top 5)

| # | Candidate | Why | Est. cost | Key risk |
|---|---|---|---|---|
| **1** | **MetaHuman** (UE 5.6/5.7 → DCC export → Blender Character DNA → GLB) | Best anatomy and body correctives; one shared skeleton and topology across all variants; huge diversity; free; "any engine" licence since 2025 | **$0** licence (<$1M rev). ~2–3 TA-weeks for the pipeline. Hair cards: $0–300 or 1 week of work | ⚠ Raw-GLB distribution not explicitly addressed. Unproven Blender→GLB route. Grooms not exported. 12→4 influences. Corrective evaluation in JS |
| **2** | **Reallusion CC5** (+SkinGen, athletic morphs, swimwear) | Best ready-made skin maps and back musculature; mature FBX export; clothing as separate meshes; fast iteration | **$299–499** + **$150–600** content packs **[Reported]** | ⚠ §6.3 anti-extraction duty; base topology and rig owned by Reallusion; no runtime mix-and-match without Enterprise |
| **3** | **Owned "BlueCurl body"**: commissioned scan of a real surfer-build athlete (model release, work-for-hire), retopologised onto **MPFB2/Anny** topology, rigged with twist bones and correctives (optionally sampled from MHR) | Zero licence risk; exactly our anatomy (lean surfer back and shoulders); our topology means interchangeable surfers via shape space | **€6k–15k** for the first hero (scan session €0.5–2k + retopo/rig/texture/correctives 3–6 artist-weeks). **€2–4k** per extra variant **[Assessment]** | Schedule and artist quality; no face-rig sophistication (acceptable for a rear camera) |
| **4** | **MPFB2 / Anny base + in-house sculpt and texturing** (no scan) | Free, licence-clean, parametric variety from day 1; good for the pipeline before #3 lands | **$0** + 2–4 artist-weeks | "MakeHuman look" unless the sculpt and skin are strong; must add twist bones and correctives |
| **5** | **3D Scan Store animation-ready body scan** (commercial licence) as the mesh *or* as the bake source for #3/#4 | Real athletic back/legs detail at a known price | **~£570 per character** (model + Business Commercial Single Project) **[Reported]** | ⚠ Web-distribution wording unknown. Unrigged |

**Strategic reading [Assessment].** #1 and #2 are fastest to a beautiful milestone. #3 and #4 are the only routes with no
licence risk, and they also give us **our own shape space**: one topology, one skeleton, one boardshort, one corrective set,
with N identities. The plan below uses #1 (or #2) to set the visual bar, and #3/#4 to own the production asset.

---

## 6. Technical recipes (apply to whichever source wins)

### 6.1 Corrective blend shapes driven from joint angles (three.js)
* **Order is right in three.js:** morph targets are applied in bind space *before* skinning, so a pose-space corrective is
  authored in rest pose and skinned afterwards. That is standard PSD (pose-space deformation) behaviour.
* **Driver:** after `mixer.update()` and before render, compute each driver bone's local rotation relative to its rest pose and
  decompose it into **swing (2D) and twist (1D)**. For hinge-like joints (knee, elbow) use the single flexion angle with a
  smoothstep ramp. For ball joints (shoulder, hip, spine) use a small **RBF** over the swing direction (Gaussian or thin-plate,
  4–8 sample poses per joint). Write the results to `mesh.morphTargetInfluences[i]`.
* **Starter set (~20–30 shapes) [Assessment]:** knee bend 90°/150° (deep crouch), hip flexion 90°/120° (glute stretch, groin
  crease), hip abduction, spine twist ±45° (oblique bulge, back skin slide), spine flexion (lat and back stretch), shoulder
  raise 90°/150°, shoulder forward/back (scapula: pecs, deltoid, traps), elbow 90°/140°, wrist. Mirror left and right.
* **Helper bones in JS** (cheaper than shapes): procedural twist distribution (forearm twist = 0.5 × hand twist), glute/knee
  "volume keeper" bones driven by angle. Both are trivial in a per-frame update.
* **Sources of correctives:** MetaHuman body DNA (evaluate with OpenRigLogic offline, then bake to shapes) · CC5 corrective
  morphs · MHR corrective blendshapes (sample the MLP at our driver poses) · our own sculpts.
* Keep correctives on a **body-only sub-mesh** to limit morph-texture VRAM.

### 6.2 Skin and wet skin (three.js, custom shader)
* SSS: **pre-integrated skin** (curvature + N·L LUT) plus a cheap **wrap/thickness transmission** term for backlit ears,
  fingers and calves against the sun. A screen-space SSS blur is optional and costly. The `SubsurfaceScatteringShader` in
  three.js examples is a starting point only.
* Maps: albedo, normal (+ tiled micro-normal), roughness, cavity/AO, thickness, curvature, and a **wetness mask** (or
  procedural: wetter low on the body after a duck-dive).
* **Wet skin [Assessment]:** wetness *w* darkens albedo (×0.7–0.85 in linear, less for dark skin), drops roughness to
  ~0.15–0.25, adds a **clearcoat-like water film** (second specular lobe, IOR 1.33), scrolls a droplet/rivulet normal map
  downward in body space, and dries back over ~20–40 s out of the water. Specular occlusion from cavity is essential or the
  wet skin looks plastic.
* Must be lit by ShoreBreak's sky LUT, exposure and tone curve: a shared lighting include, not a stock `MeshPhysicalMaterial` look.

### 6.3 Hair
* **Cards only** (strands are not viable in WebGL2 at this quality). Use alpha-to-coverage with MSAA, or alpha-hash plus
  temporal smoothing if a TAA exists. Surfers' short, wet or clumped hair is actually *easier*. Wet look: fewer, thicker
  clumped cards, darker albedo, lower roughness, stronger anisotropic highlight (`KHR_materials_anisotropy` is supported), and
  drip clumps at the tips. Long hair: 3–6 spring bones (verlet) driven by head acceleration and wetness (wet = heavier, more damping).

### 6.4 Clothing
* **Wetsuit / rash vest:** treat as a "second skin". Same topology region offset from the body, weights transferred from the
  body, **hide the body faces underneath** (no poke-through in crouch). Neoprene: sheen/roughness ~0.4–0.6 dry, ~0.2 wet,
  panel-seam normals.
* **Boardshorts:** skinned to pelvis and thighs plus **4–8 extra "hem/flap" bones** driven by damped springs (verlet) from
  thigh velocity and wind/water. Wet = heavier, cling morph (a corrective shape that sucks the fabric to the thighs). Cloth
  simulation on the GPU is not needed. Authoring: Marvelous Designer or Blender cloth → retopo ~2–4k tris → skin.
* Swimwear (female): skinned, no sim; cling correctives as for the body.

### 6.5 Budgets (hero, desktop Chrome) [Assessment]
* LOD0 30–60k tris (body ~25–40k + hair cards 5–15k + clothing 2–6k). LOD1 at ~50% for wide shots.
* Textures: body 4K albedo/normal/ORM (KTX2: UASTC for normal, ETC1S/UASTC for the rest), head 2K–4K, hair 2K. About
  60–100 MB of VRAM per surfer. GLB download ~8–20 MB with meshopt + KTX2.
* Skeleton ~70–120 bones after stripping the face rig and IK/virtual bones. 4 influences.

---

## 7. Recommended paths

### 7.1 Milestone 1: one excellent surfer
1. **Week 1 bake-off** (experiments E1–E4 below): MetaHuman vs CC5, same athletic male, same 6 test poses, both in three.js r186
   with the same skin shader and lighting. Judge from the **rear chase-camera framing only**.
2. **Default pick: MetaHuman** unless the bake-off shows the Blender→GLB path is unworkable, or the body (back and shoulders)
   reads worse than CC5. In parallel, **email Epic licensing** (and Reallusion, if CC5 stays in the race) with the exact
   question: *"three.js web app; the character mesh and textures are delivered to the browser as glTF; is this permitted, and
   what protection is required?"* Log the answers in the decision log.
3. Strip the face to a mid LOD, bake body correctives to ~25 morph targets with a JS RBF driver, add JS twist distribution,
   build boardshorts with 6 spring bones, wet-skin shader and card hair.
4. If Epic's answer is negative or vague, M1 still stands as an **internal demo**, and the public build switches to path 7.2.

### 7.2 Interchangeable surfers (production)
* **Own the base:** "BlueCurl body" on **MPFB2/Anny topology** (CC0/Apache), one skeleton (UE-style names, with twist bones,
  so it retargets to MetaHuman/Manny/Mixamo animation), one corrective set, one boardshort/wetsuit set (MHCLO-style fitting).
* Identities come from **shape parameters** (Anny anthropometrics) plus 4–6 texture sets (skin tones, tattoos, tan lines) plus
  hair-card variants plus gender variants (two base meshes). Correctives are re-solved per identity offline: same drivers,
  delta transfer.
* The hero quality bar comes from a **commissioned scan** (male and female athletes), retopologised to this topology.
  Optional: 3D Scan Store bodies as bake sources if their licence permits.

---

## 8. Rejected alternatives (decision log)

| Option | Reason |
|---|---|
| Daz Genesis 8/9 | EULA forbids products from which content can be extracted **[Reported]**; per-product interactive licences; poor engine export (twist and fingers, correctives lost) |
| MB-Lab | Generated models are AGPL-3 **[Verified]**; unmaintained since 06/2024 |
| SMPL / SMPL-X / STAR / SUPR | Non-commercial research licences; commercial SMPL route in flux after Epic bought Meshcapade (Feb 2026) **[Reported]**; untextured |
| Meshcapade platform | Acquired by Epic; consumer services reportedly offline since Apr 2026 **[Reported, single source]** |
| Renderpeople / AXYZ rigged | Archviz crowd people; wrong wardrobe and pose range; real-time redistribution terms unverified |
| Mixamo characters | Stylised and low-fidelity; raw-file restriction. (Mixamo *animations* are a separate question.) |
| Ready Player Me | Shut down 31 Jan 2026 after the Netflix acquisition **[Reported]**; stylised |
| VRoid | Anime style |
| AI generators (Meshy, Tripo, Rodin, Hunyuan3D, TRELLIS) | Fused clothing and anatomy, baked light, rigs without twist or correctives; Hunyuan3D licence excludes EU/UK/KR **[Verified]**. Use for blockouts and props only |
| Marketplace "surfer" models | Low-poly, Biped rigs, inconsistent licences (some editorial-only or no-AI) |
| Human Generator | Not rejected on quality; **parked** until the output licence is read |
| Rocketbox for the hero | Dated quality. **Kept** for background beachgoers and pipeline smoke tests (MIT) |

---

## 9. Proposed small experiments

| ID | Experiment | Pass criterion | Effort |
|---|---|---|---|
| **E1** | MetaHuman athletic male: UE 5.7 → DCC Export → Blender (Character DNA add-on) → GLB (gltf-transform meshopt + KTX2). Load in three.js r186 | Loads; ≤120 bones after strip; 4 influences without visible face/neck artefacts; ≤20 MB GLB | 2–3 d |
| **E2** | Same as E1 for a CC5 athletic male (FBX → Blender → GLB) with SkinGen maps | Same | 1–2 d |
| **E3** | **Pose torture test**, both candidates: deep crouch (knee 140°, hip 120°), bottom-turn torso twist 45° with arms out, aerial tuck, paddling arm at full reach, pop-up push. Render from the rear chase camera at 3 distances | No candy-wrapping, knee/hip collapse or shoulder pinch visible at chase distance, *with* LBS + twist bones, before correctives | 1 d |
| **E4** | Corrective prototype: bake 6 correctives (knee, hip flex, shoulder raise, spine twist), drive with a JS RBF, A/B toggle | Visible improvement in E3 poses; < 0.3 ms/frame CPU | 2 d |
| **E5** | Wet-skin shader on the winner in ShoreBreak lighting (sky LUT, auto-exposure): dry vs wet vs drying | Reads as wet skin, not plastic; matches phone-footage stills | 2 d |
| **E6** | Boardshorts with 6 spring bones + cling corrective; paddling and crouch loop | No intersection in crouch; flaps settle believably | 2 d |
| **E7** | Open-topology spike: MPFB2 + Anny body → add twist bones → GLB; sample 5 MHR correctives onto it via a surface-transfer test | Shows the owned-base route is technically sound | 2–3 d |
| **E8** | Licence confirmations: written questions to Epic (MetaHuman raw glTF on web), Reallusion (WebGL + §6.3 measures), 3D Scan Store (web distribution), Human Generator (output licence) | Written answers filed in the decision log | 1 h + wait |
| **E9** | Extraction reality check: load the GLB through a custom encrypted container; try a Spector.js capture | Documents that protection is only "reasonable effort" (input for the licence answers) | 0.5 d |

---

## 10. Sources

Primary sources inspected (repos and code, 2026-11-19):
[MPFB2 LICENSE.md](https://github.com/makehumancommunity/mpfb2/blob/master/LICENSE.md) ·
[MB-Lab license.txt](https://github.com/animate1978/MB-Lab/blob/master/license.txt) ·
[naver/anny](https://github.com/naver/anny) ·
[facebookresearch/MHR](https://github.com/facebookresearch/MHR) ([paper](https://arxiv.org/abs/2511.15586)) ·
[NVlabs/SOMA-X](https://github.com/NVlabs/SOMA-X) ·
[EpicGames/OpenRigLogic](https://github.com/EpicGames/OpenRigLogic) ·
[poly-hammer/meta-human-dna-addon](https://github.com/poly-hammer/meta-human-dna-addon) ·
[microsoft/Microsoft-Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) ·
[microsoft/TRELLIS.2](https://github.com/microsoft/TRELLIS.2) ·
[Tencent-Hunyuan/Hunyuan3D-2.1 LICENSE](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1) ·
three.js 0.186.0 npm tarball (`GLTFLoader.js`, `skinning_pars_vertex.glsl.js`, `WebGLMorphtargets.js`) ·
`@gltf-transform/cli` 4.5.1 (npm).

Secondary sources (search excerpts; vendor pages not fetchable from this sandbox):
[MetaHuman licence](https://www.metahuman.com/license) ·
[UE EULA](https://www.unrealengine.com/eula/unreal) · [UE EULA changelog](https://www.unrealengine.com/eula-change-log/unreal) ·
[Epic content licence changelog](https://www.unrealengine.com/eula-change-log/content) ·
[CG Channel: MetaHumans in Unity/Godot (Jun 2025)](https://www.cgchannel.com/2025/06/you-can-now-sell-metahumans-or-use-them-in-unity-or-godot/) ·
[Epic: MetaHuman LOD specs](https://dev.epicgames.com/documentation/metahuman/platform-support-and-lod-specifications-for-metahumans) ·
[Epic: Character export tool](https://dev.epicgames.com/documentation/metahuman/metahuman-creator-export-tool-in-unreal-engine) ·
[Epic: Groom exporter](https://dev.epicgames.com/documentation/metahuman/groom-exporter) ·
[Epic: parametric clothing](https://dev.epicgames.com/documentation/metahuman/creating-parametric-clothing-for-metahuman) ·
[UE forum: 5.6 body conform / LOD0 verts](https://forums.unrealengine.com/t/is-metahuman-5-6-body-conform-feature-broken-in-the-public-release/2540575?page=2) ·
[UE forum: DCC export missing outfit](https://forums.unrealengine.com/t/metahuman-dcc-export-to-maya-ue-5-6-parametric-outfit-missing-after-import-body/2661156) ·
[StraySpark 2026 MetaHuman blog (conflicting view)](https://www.strayspark.studio/blog/metahuman-2026-web-app-shutdown-migration-guide) ·
[Fab EULA](https://www.fab.com/eula) · [Licenseware Fab wiki](https://wiki.licenseware.io/wiki/fab-and-epic-content-licensing/) ·
[Reallusion Content EULA](https://www.reallusion.com/Content/EULA/EULA.htm) · [Reallusion Software EULA](https://www.reallusion.com/Content/EULA/AP/EULA_AP.htm) ·
[Reallusion content policy](https://www.reallusion.com/license/content.html) ·
[CC3+ base specs](https://manual.reallusion.com/Character-Creator-4/Content/ENU/4.0/05_Character/CC3-Plus-Characters.htm) ·
[CG Channel: CC5 release](https://www.cgchannel.com/2025/08/reallusion-releases-character-creator-5/) ·
[Digital Production: Reallusion licences 2026](https://digitalproduction.com/2026/01/14/reallusion-expands-licences-for-iclone-and-character-creator/) ·
[Daz Interactive License blog](https://www.daz3d.com/blog/daz-3d-interactive-license) ·
[Daz forum: G9 skinning for game engines](https://www.daz3d.com/forums/discussion/comment/7992701) ·
[MakeHuman licence FAQ](https://static.makehumancommunity.org/about/license.html) ·
[SMPL-X model licence](https://smpl-x.is.tue.mpg.de/modellicense.html) · [Meshcapade body models](https://meshcapade.com/assets/body-models) ·
[MPG: Epic acquires Meshcapade](https://www.mpg.de/26082348/max-planck-spin-off-draws-epic-games-to-tuebingen) ·
[3D Scan Store animation-ready scans](https://www.3dscanstore.com/animation-ready-body-scans) ·
[Renderpeople rigged](https://renderpeople.com/3d-people/eric-rigged-004/) ·
[Mixamo FAQ thread](https://community.adobe.com/t5/mixamo-discussions/mixamo-faq-licensing-royalties-ownership-eula-and-tos/td-p/13234775) ·
[Sketchfab licences](https://sketchfab.com/licenses) ·
[StraySpark AI auto-rig comparison 2026](https://www.strayspark.studio/blog/ai-auto-rigging-showdown-2026-tripo-meshy-cascadeur-mixamo) ·
[TechCrunch: Netflix acquires Ready Player Me](https://techcrunch.com/2025/12/19/netflix-acquires-gaming-avatar-maker-ready-player-me/) ·
[Human Generator (Superhive)](https://superhivemarket.com/products/humgen3d) ·
[CGTrader surfer-swimmer](https://www.cgtrader.com/3d-models/character/clothing/surfer-swimmer).

Not verified in this pass (network/search limits): TurboSquid & CGTrader licence text, Unity Asset Store sports characters,
Avaturn, VRoid terms, Meshy/Tripo/Rodin output-ownership terms, AXYZ (Chaos) licence, Human Generator output licence.
Hosts to allow for a verification pass: `www.metahuman.com`, `www.unrealengine.com`, `www.fab.com`, `www.reallusion.com`,
`www.daz3d.com`, `www.3dscanstore.com`, `help.humgen3d.com`.
