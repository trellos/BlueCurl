# 06 — Environments (Inv. 6) and sky, atmosphere, lighting (Inv. 7)

Status: draft v1, 2026-11-19. Author role: technical art direction (environments and lighting).
Scope: the four launch locations, the distant-scenery architecture, sky and atmosphere,
image-based lighting, shadows, wet materials, tone mapping, and the **lighting contract with
the water (ShoreBreak) team**. Ocean and wave rendering are out of scope.

**How claims were checked (2026-11-19).** This sandbox could reach npm, unpkg and
github.com only. I read ShoreBreak's code directly (commit `11c8c05`, 2026-09-20), three.js
r186 sources on unpkg, and npm metadata and READMEs. Vendor pages (Fab, Cesium, Blockade Labs,
World Labs, Copernicus, DGT, GEBCO, Poly Haven, SpeedTree) could not be fetched directly, so
those claims come from web-search snippets of the official pages and are labelled
**[Vendor claim]** or **[Reported]**. The session's web-search budget ran out before I could
re-check the Fab EULA's web-distribution clause, ambientCG and BlenderKit. Those rows are
marked *not re-verified 2026*.

---

## 0. TL;DR

1. **Exploit the offshore view.** At 1440p with a 50–60° vertical field of view, 1 m spans about
   3 px at 500 m, 0.7–0.8 px at 2 km and 0.15 px at 10 km. Beyond about 2 km only silhouette,
   tone and haze can be seen. Beyond about 12 km, low reef islands sink below the horizon
   because of Earth's curvature. Spend the polygons and textures on the 200 m–2 km band, and
   none on land closer than 200 m (rocks or reef only).
2. **Environment = data, not code.** A *location preset* (JSON) drives one generic runtime:
   - a far band of horizon-profile strips, which is ShoreBreak's `Backdrop` panorama technique
     made data-driven and fed from real DEMs;
   - a mid band of DEM or lidar-derived cliff and beach meshes, instanced building boxes and
     vegetation impostors;
   - a sky and atmosphere provider;
   - haze, cloud and water-tint hints.

   Adding a location means a build-time bake plus a JSON file, with no new shaders.
3. **Sky: build a "sky provider" that writes ShoreBreak's existing sky interface.** ShoreBreak's
   sky is a measured lookup table (LUT) fitted to *one* phone clip with *one* sun position
   (about 66° elevation). It cannot produce golden hour or Portugal storm light. Bake a physical
   atmosphere into the same uniforms (`uSkyLut`, `uSkyTex`, `uSunColor`, `uSkyAmb`) plus a 2D
   sky-view texture and a PMREM environment map. The atmosphere can come from
   `@takram/three-atmosphere` (MIT, GLSL/WebGL) or a small Hillaire-2020 port. Then apply a
   per-preset art-direction correction on top. Clouds are 2D layers plus relightable cloud
   cards. Reject volumetric clouds.
4. **Lighting contract.** Keep ShoreBreak's *relative* scene-linear units, not photometric lux.
   Half-float cannot hold a physical sun, and its calibration is already in these units. Use
   one sun, one sky and one haze function. The surfer and board render **into ShoreBreak's
   HDR opaque target before its water pass**, so that water refracts submerged legs and rails,
   contact light applies and whitewater depth-tests against the surfer. Post-processing is
   **one chain, owned by the water team**. BlueCurl supplies a "cinema" look profile (tone
   curve plus 3D LUT, no phone ISP emulation).
5. **Surfer lighting.** Use these pieces:
   - a three.js `DirectionalLight` equal to `uSunColor` (verified: same Lambert convention);
   - a tight 2048² shadow map on surfer and board (no cascaded shadow maps);
   - a PMREM of the shared sky with the sun disc suppressed and the *sea* in the lower
     hemisphere;
   - a mirrored-sun "sea glitter" fill plus a foam-driven upward fill for water bounce;
   - `MeshPhysicalMaterial` clearcoat as the water film, driven by a per-region wetness state.

---

## 1. What ShoreBreak already does (read from source)

| Area | What the code does | Implication for us |
|---|---|---|
| Sky dome (`src/sky/Sky.js`) | Back-faced sphere at infinity (`gl_Position = p.xyww`). Colour comes from `skyRadiance()` or the explore-mode model, plus a sun disc at `uSunColor × 400`, limb-darkened. It also draws a contrail and a small airliner at fixed angles copied from the reference clip. **[Verified]** | The look is hand-fitted to one clip. The contrail and airliner are clip artefacts and must be switchable per preset. |
| Sky data (`src/core/look.js`) | `SKY_DV`: 15 display-linear medians by image row above the horizon, mapped to elevation through the clip camera (vfov 64°, pitch −10.85°), "unsaturated" by `SAT = 1.35`, plus two rows extrapolated toward the zenith. **[Verified]** | The sky is **measurement, not model**. It has no sun-elevation parameter, so a golden-hour or overcast sky cannot be derived from it. |
| All-azimuth model (`src/sky/skyModel.js`) | Sun lobe `1 + 4.05·exp(−g/0.7)` normalised at azimuth 0. Per-channel exponents. Aureole terms. A thin procedural cirrus veil (`highCloud`). **[Verified]** | A good template for the *shape* of a correction layer, but tied to the one sun position. |
| Sun and ambient (`src/config.js`, `look.js`) | `sun.dir = [0.26, 0.91, −0.31]` (≈66° elevation), colour `(1, .95, .91)`, intensity 2.1. `LIGHT.skyAmb = (0.32, 0.36, 0.425)`, fitted to the phone's lifted shadows (sun:sky ≈ 1.6:1). **[Verified]** | These are the units of the contract (§B8). |
| Lighting convention (`glsl/common.js`) | `uSunColor` is irradiance: `albedo·uSunColor·NoL/π`. `skyAmbient(N) = mix(ground(0.13,0.12,0.11), uSkyAmb, 0.62+0.38·N.y)` is irradiance/π. **[Verified]** | Maps exactly onto three.js (§B8). |
| Water reflections (`glsl/water.js` `skyRefl`) | A **256×1 float LUT indexed by √sin(elevation)** (`look.js skyTexture`), times an azimuth gain, mixed toward a flat cloud tint by `gCloudAmount`. **[Verified]** | **Reflections cannot show azimuthal structure** (cloud shapes, sunset band, headlands). A cinematic sky with clouds needs the water team to switch to a 2D sky-view texture (§B2). |
| Haze (`src/beach/haze.js`) | `landHaze(d) = 1 − exp(−max(d−60,0)/7400 − 0.055·(1−exp(−d/480)))`, toward the horizon sky colour at that azimuth. **[Verified]** | Extinction of about 7.4 km e-fold plus a 5.5% near veil, i.e. clear Mediterranean air. Must become a preset parameter. |
| Backdrop (`src/beach/Backdrop.js`) | (a) Two instanced rows of box buildings (400 + 310 instances × 3 passes) with a procedural facade shader: windows, shutters and balconies band-limited to pixel footprint, reveal shadows from the real sun direction. (b) 280 palms: trunks plus four crossed alpha cards each, with procedural fronds in the fragment shader. (c) **Far panorama: four layers of vertical strips at 8.6–10.5 km radius.** Each layer's silhouette is elevation(azimuth) built on the CPU from fbm and ridge noise, at 1440 segments, about 2.9k triangles per layer. Each layer has a *virtual* haze distance (3.6–30 km). No discard, so early-z works. **[Verified]** | This is the right far-band technique. It is hard-coded to Nice in a `LAYERS` constant. We generalise it (§A8). |
| Render targets (`src/main.js`) | `rtOpaque` (HalfFloat, MSAA 2–4, depth texture): sky, beach and seabed. `ContactLight` horizon occlusion runs on its depth. Back-face pass. Copy into `rtMain`, then water (which samples `uOpaqueColor`/`uOpaqueDepth` for refraction). Whitewater particles depth-test against `rtMain` depth. Then `Post`. All targets use `NoColorSpace` (linear). **No three.js shadow maps, env maps or tone mapping are used anywhere** (grep). **[Verified]** | The integration seam: add surfer and board to the opaque pass (§B8). |
| Post (`src/post/Post.js`, `Exposure.js`) | Composite → bloom (half and quarter resolution) → sun probe → GRADE (phone lens glare with veil, 6-ray star and ghosts; exposure; `phoneLook` saturation 1.07, shoulder 0.58, per-channel clip; sRGB OETF) → ISP emulation (luma sharpen, 4:2:0 chroma low-pass, a "maroon dash" codec artefact, dither) → FXAA. Auto-exposure: a 16×16 centre-weighted log meter targeting log2(0.38), clamped to **−0.5…+0.4 EV**, τ 0.65/1.6 s. **[Verified]** | The phone look is the opposite of our cinematic target. The narrow auto-exposure range suits a fixed noon scene but not backlit golden hour. |
| Minor inconsistency | `look.js` says the post applies saturation ×1.35, but `Post.params.saturation = 1.07`. **[Verified]** | Calibration constants are look-specific. Changing the grade changes the effective sky colour, so the look profile and sky LUT must be versioned together. |

**Sky ambient vs a PMREM of the same sky (computed).** I integrated ShoreBreak's sky elevation
profile (explore mode, azimuth gain ignored) cosine-weighted over the upper hemisphere. Script:
scratchpad `skyirr.mjs`, which replicates `look.js` exactly.

| | R | G | B | Luminance |
|---|---|---|---|---|
| Physically integrated sky, E/π, up-facing | 0.144 | 0.341 | 0.603 | 0.318 |
| ShoreBreak `uSkyAmb` (fitted) | 0.320 | 0.360 | 0.425 | 0.356 |

**[Verified computation]**. The two have similar luminance, but a PMREM of ShoreBreak's sky is
**much bluer** (B/R 4.2 vs 1.3) than the ambient ShoreBreak uses on its own rocks, sand and
buildings. If the surfer were lit naively by a PMREM of that sky, its shadows would read
cold-blue next to warm-grey beach shadows. The contract must pick **one** source of sky
irradiance for everyone (§B8).

---

# Part A — Environments

## A1. What the offshore camera can actually see

Pixels per metre at 1440p (computed; vfov 50–60°):

| Distance | 50 m | 200 m | 500 m | 1 km | 2 km | 10 km | 25 km |
|---|---|---|---|---|---|---|---|
| px per metre | 28–33 | 7–8 | 2.8–3.3 | 1.4–1.7 | 0.7–0.8 | 0.15 | 0.06 |

- **Earth curvature** (eye 2 m above the sea, standard refraction k = 0.13; the sea horizon is
  at 5.4 km). Hidden height is 1.4 m at 10 km, 6 m at 15 km, 15 m at 20 km and 41 m at 30 km.
  Mountains are barely affected. Low islands, sand cays and palm-fringed reefs beyond about
  12–20 km *sink*, which is a strong realism cue for Indonesia. Model it in the bake by
  subtracting `(d − 5.4 km)²/(2R')` from far terrain. ShoreBreak's sea is flat, and the angular
  horizon dip (≈0.03°, under 1 px) can be ignored. **[Assessment]**
- **Parallax.** The rider moves about 100–300 m per ride. A layer at 10 km shifts up to 1.7°
  (about 45 px), so far layers must not be glued to the camera. Mid-band objects shift tens of
  degrees, so they need real 3D placement. If a far layer sits at a proxy radius `Rp` inside
  the far plane (ShoreBreak: 12 km) but represents distance `Rr`, translate the layer by
  `Δcamera · (1 − Rp/Rr)` to get the correct angular parallax. **[Assessment, derived]**
- **Consequence.** Inside 200 m we need only water, the surfer, spray and the occasional
  rock, reef head, pier or boat. The art lives in silhouette, haze gradient, tone separation
  between layers, the wet band at cliff bases, foam lines on the beach, and sky.

## A2. Real-world elevation and bathymetry

| Source | Resolution | Coverage relevant to us | Licence and cost | Notes |
|---|---|---|---|---|
| **Copernicus DEM GLO-30** | 30 m (DSM) | Global (all four) | Free, worldwide, perpetual. Attribution "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the EU and ESA". Modified data must carry "produced using Copernicus WorldDEM-30 © DLR e.V. …" plus a no-liability statement. Earlier exclusions (Armenia, Azerbaijan) were lifted in the 2023_1 release. **[Vendor claim, via search of licence PDF and dataspace page]** | Best default for the far band. It is a *surface* model, so forest canopy is included, which is fine for silhouettes. Release 2024_1 is current on Earth Engine. [licence PDF](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf), [dataspace](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM) |
| SRTM 1″ / NASADEM | 30 m | 60°N–56°S | US public domain **[Assessment, not re-verified]** | Older (2000), with voids on steep terrain. GLO-30 supersedes it. |
| ALOS AW3D30 (JAXA) | 30 m | Global | Free with attribution, commercial use allowed per JAXA terms **[Assessment, not re-verified 2026]** | Useful cross-check where GLO-30 has artefacts in Indonesian cloud-belt areas. |
| **USGS 3DEP lidar DEMs** | 1 m (some 1/3″) | California coast: good. Hawaii: partial. | US public domain **[Assessment]** | For California bluffs and cliffs in the mid band. Via The National Map, OpenTopography or AWS. |
| **NOAA NCEI CUDEM Hawaii** | 1/9″ (≈3 m) topobathy | Hawaiian Islands, including 2013 USACE Oahu topobathy lidar | US government data, no explicit licence wording found **[Reported]** | **Land and near-shore seabed in one grid.** Gives the water team a real reef and sand bathymetry for tint hints. [NCEI metadata](https://www.ncei.noaa.gov/metadata/geoportal/rest/metadata/item/gov.noaa.ngdc.mgg.dem:199919/html), [data.gov](https://catalog.data.gov/dataset/continuously-updated-digital-elevation-model-cudem-1-9-arc-second-resolution-bathymetric-t) |
| **Portugal DGT LiDAR** (Centro de Dados, cdd.dgterritorio.gov.pt) | MDT/MDS 50 cm, LAZ point clouds | Mainland Portugal; islands unclear | **CC BY 4.0**, free download; STAC API announced Dec 2025 **[Vendor claim, DGT webinar deck 2025-07]** | Also a 2 m coastal-zone DTM (2014–15) on dados.gov.pt. Excellent for Ericeira or Nazaré cliffs. [DGT deck](https://www.dgterritorio.gov.pt/sites/default/files/ficheiros-artigos/Apresentacoes/2025/5-Webinar_LiDAR_15jul2025.pdf), [GMT tutorial](https://www.generic-mapping-tools.org/GMTjl_doc/tutorials/dgt_lidar/tut_dgt_lidar.html), [2 m coastal DTM](https://dados.gov.pt/en/datasets/modelo-digital-do-terreno-resolucao-2-m-zonas-costeiras-de-portugal-continental-2014-2015) |
| Indonesia DEMNAS (BIG) | ≈8 m | Indonesia | Requires registration on the Tanah Air portal; **licence text not found** **[Reported]** | Use GLO-30 unless DEMNAS terms are clarified. |
| **GEBCO 2025/2026 grid** | 15″ (≈450 m) | Global ocean and land | **Public domain**, acknowledgement requested ("GEBCO Compilation Group (2025) GEBCO 2025 Grid", doi:10.5285/37c52e96-24ea-67ce-e063-7086abc05f29) **[Vendor claim]** | Too coarse for surf zones. Only for deep-water colour hints and swell-refraction context. [GEBCO 2025](https://www.gebco.net/gebco2025-grid), [terms](https://www.gebco.net/data-products/gridded-bathymetry/terms-of-use) |
| EMODnet bathymetry (Portugal) | ≈115 m, plus HR survey patches | European seas | CC BY 4.0 **[Assessment]** | Hint only. |

**Resolution needed.** The far band needs ≥ 30 m (30 m at 10 km is 0.24 px). The mid band
(cliffs at 0.3–2 km) needs 1–5 m: lidar where it exists, otherwise art-sculpted detail on top
of GLO-30.

**Build-time pipeline (proposed; all tools free).**
1. `gdalwarp` (GDAL, MIT/X) clips the DEM and reprojects it to a local metric frame centred
   on the break. Use a custom transverse-Mercator or ENU projection, then rotate so that
   ShoreBreak's +z points inland and x runs along the shore.
2. **Horizon-profile bake (far band).** A Node or Python script ray-marches the heightfield from
   2–3 representative camera positions in the line-up. For each azimuth (0.1–0.25°) and each
   depth band (2–5, 5–12, 12–30 km) it records the maximum elevation angle, applying the
   curvature and refraction correction. It also records the distance of that silhouette point
   (for haze) and a land-cover class sampled there (ESA WorldCover or simple slope/height
   rules). Output: `horizon.bin`, a float16 array of N azimuths × M layers × {elevation,
   distance, class}. This is exactly what `Backdrop.js` consumes, but measured rather than
   produced by `fbm1`.
3. **Mid-band meshes.** Use a lidar or DEM tile, 2–5 km wide, around the visible coast.
   - Simplify with RTIN or Delatin: `@mapbox/martini` (ISC) or `delatin` (ISC) **[Assessment]**,
     or decimate in Blender, with error tolerance scaled by distance from the line-up.
     Cliffs need a vertical re-mesh, because heightfields smear overhangs.
   - Hand-finish in Blender. BlenderGIS (GPL-3 add-on; its output is unencumbered) imports
     GeoTIFF, SRTM and OSM.
   - Export GLB and compress with `@gltf-transform/core` 4.5.1 (MIT, verified on npm)
     using meshopt.
   - Bake textures to KTX2/Basis.
4. QGIS is used only for inspection. Record the attribution strings in `CREDITS.md` for each
   location.

Presets are art-direction suggestions, not replicas. Real DEMs give believable geomorphology
(drainage, fluted ridges, cliff strata spacing). Artists may still composite, rescale or
re-site features, for example by moving a headland closer for composition. **[Assessment]**

## A3. Photogrammetry and 3D Tiles

| Option | Verdict | Why |
|---|---|---|
| **Google Photorealistic 3D Tiles** (Map Tiles API) | **Reject**, both at runtime and as a build-time source | The policies prohibit pre-fetching, indexing, storing or caching content except under narrow conditions. They also prohibit offline use and geodata extraction, and the ToS §3.2.3 forbids storing, rehosting or bulk-downloading tiles. Google's FAQ calls programmatically reading heights from the imagery "derivative" and prohibited. The Google logo and attributions must be shown. **[Vendor claim, policy pages via search]**: [policies](https://developers.google.com/maps/documentation/tile/policies), [FAQ](https://cloud.google.com/blog/products/maps-platform/commonly-asked-questions-about-our-recently-launched-photorealistic-3d-tiles). Visually, at grazing sea-level views the mesh melts (blobby trees, smeared vertical cliffs), baked shadows fight our sun, and coverage of remote Indonesian coast is poor. **[Assessment]** |
| **Cesium ion** (World Terrain, OSM Buildings, Google tiles proxied) | Reject for runtime | The Community tier is personal and non-commercial (evaluation allowed). Commercial is about $149/month for individuals and $524/month for teams **[Vendor claim via search, figures inconsistent across Cesium pages]**. Google tiles via ion are SaaS-only. Bing assets cannot be combined with Google tiles. It also pulls in a streaming globe architecture we do not need. [pricing](https://cesium.com/platform/cesium-ion/pricing/), [attribution guide](https://cesium.com/learn/ion/content-usage-and-attribution-guide/) |
| **OpenStreetMap** (building footprints, land use) | **Use as a placement guide** | ODbL: rendered images are "Produced Works" requiring attribution. A shipped derived database (footprints baked into a GLB) arguably triggers share-alike for *that data*. Mitigate by using OSM only to drive density maps and procedural placement, and by attributing "© OpenStreetMap contributors". **[Assessment]** Coverage: California and Hawaii good, Portugal good, Indonesia sparse. |
| Own photogrammetry (drone or phone) | Not now | Requires travel. Licence-clean, but baked lighting and grazing-angle quality are the same issues as above. |

## A4. Asset libraries and vegetation

| Source | Licence and cost (2026) | Fit |
|---|---|---|
| **Poly Haven** | CC0 (the Kloofendal HDRI page states CC0; ShoreBreak already ships Poly Haven textures under CC0, per its `THIRD_PARTY_NOTICES.md` **[Verified]**) | Rock, sand and cliff textures, HDRIs, a few models. Little tropical vegetation. |
| **ambientCG** | CC0 *(not re-verified 2026)* | Textures: rock, cliff, sand, ground, plaster. Good for triplanar cliff sets. |
| **Fab / Quixel Megascans** | The free claim of about 17k Megascans ended at the end of 2024. From 2025 they are paid listings under the Fab Standard License with Personal tier (buyer under $100k gross revenue in the last 12 months) and Professional tier. Both grant the same rights, usable "in any tool or engine". Buyers since 1 Jan 2025 were reportedly refunded to Epic balance. **[Vendor claim / Reported]** ([Fab licences doc](https://dev.epicgames.com/documentation/en-us/fab/licenses-and-pricing-in-fab), [transition FAQ](https://forums.unrealengine.com/t/quixel-to-fab-transition-faqs/2033839)) | Best scanned cliffs, rocks and plants. **Open question:** whether the Standard License's protection clause for distributed products is satisfied by GLB in a browser, where assets are trivially extractable. *Not re-verified (search budget); needs a legal read before use.* Use for impostor *baking* (only pixels ship), which is lower risk. |
| BlenderKit | Free tier plus paid "Full plan". Royalty-free licence allows use in games but not redistribution of raw assets *(not re-verified 2026)* | Palms and tropical plants. Same extraction question. |
| **SpeedTree** (Unity) | Indie about $19/month for organisations under $100k revenue; Pro under $1M; Enterprise by quote. Exports FBX, OBJ, USD and Alembic; "custom engines" allowed. **[Vendor claim]** ([Unity support](https://support.unity.com/hc/en-us/articles/15723241438228-What-is-the-difference-between-SpeedTree-Indie-Pro-Library-and-Enterprise), [product](https://unity.com/products/speedtree)) | Best for *baking* palm, pandanus, banyan and scrub impostor atlases. The library is a paid add-on. |
| ShoreBreak's own generators (`tools/vendor/date-palm.js`, `ashore-leaf.js`) | MIT (repo) **[Verified present]** | Procedural date palm. A coconut-palm variant is a small extension. |

**Impostors.** From offshore, the view elevation over vegetation is about 0–5° and the azimuth
range is about ±40°. Full octahedral impostors (Ryan Brucks' technique) are overkill.

- **Mid band (≥ 200 m, 2–40 px tall).** Use instanced view-facing billboards that pick from
  **8–16 azimuth frames**: a "hemi-strip" impostor with albedo, normal and depth atlases, lit by
  our sun and sky. The normal atlas makes palms and jungle re-light correctly when the sun
  changes.
- **Beyond about 1.5 km.** Vegetation is texture on the terrain: a canopy albedo and normal
  macro map plus a silhouette-roughening displacement of the ridge.
- **Libraries.** `agargaro/octahedral-impostor` ("three.ez", MIT, marked "wip", 71 stars, no
  releases) **[Verified, GitHub page]** is worth reading but not depending on. Several other
  three.js impostor demos exist on the forum **[Reported]**. Writing our own 1D-azimuth impostor
  is about 300 lines plus a Blender or three.js bake script. **[Assessment]**
- **Wind.** Vertex sway of billboards is invisible beyond about 500 m. Fake it with slow
  frame-blend shimmer.

## A5. AI-generated panoramas and 3D worlds

| Tool | Status, licence and cost | Verdict |
|---|---|---|
| **Blockade Labs Skybox AI** | Plans page lists about $60/month (8K export, freelancer) and about $140/month (16K, "commercial licensing", API). Third-party listings conflict. In 2024 CG Channel reported that HDR/EXR exports were *not* true HDR, and that Blockade holds a perpetual licence over generated content. **[Vendor claim / Reported]** ([plans](https://skybox.blockadelabs.com/plans), [CG Channel 2024](https://www.cgchannel.com/2024/04/blockade-labs-launches-skybox-ai-2)) | **Concept and matte-painting source only.** LDR means it cannot light the scene. Baked sun and haze will not match ours, the horizon height and lens geometry are imprecise, and the sea in the lower half fights ShoreBreak's water. |
| **World Labs Marble** | Worlds as Gaussian splats. PLY splat export is free. HQ GLB mesh export costs 3,500 credits (≈$2.80) via the API. Commercial rights and HQ export need **Pro** (reported about $35/month). **[Vendor claim]** ([API pricing](https://docs.worldlabs.ai/api/pricing), [export](https://docs.worldlabs.ai/marble/export/gaussian-splat/index.md)) | Worlds are walkable spaces of tens of metres, not 2–30 km coastlines. Possibly a mid-band *vignette* (a beach shack cluster), but lighting is baked. Not for v1. |
| **Spark** (`@sparkjsdev/spark`, by World Labs) | **MIT, v2.4.0 (2026-10-20), WebGL2**, three ≥ 0.180, "98%+ WebGL2 support", PLY/SPZ/SPLAT/KSPLAT/SOG formats, per-splat colour editing via a shader graph. Spark 2.0 adds a LoD splat tree, a paged LRU and a streaming `.RAD` format (vendor claims 100M+ splats). **[Verified npm and README; LoD claims are Vendor claims]** ([blog](https://www.worldlabs.ai/blog/spark-2.0)) | The only viable splat renderer for ShoreBreak's WebGL2. (three.js's own `examples/jsm/objects/GaussianSplat.js` imports `three/webgpu`, so it is **WebGPU-only** **[Verified r186]**.) |
| **HunyuanWorld 1.0** (Tencent) | The community licence's "Territory" **excludes the EU, UK and South Korea**, and use there is "unlicensed". Licence needed above 1M MAU. Outputs may not be used to improve other AI models. **[Verified, LICENSE]** ([repo](https://github.com/Tencent-Hunyuan/HunyuanWorld-1.0)) | **Reject.** Any EU team member, user or viewer is a problem. |
| Generic image generation for matte cards | See [07-ai-asset-tools.md](07-ai-asset-tools.md) for tools and licences | Fine for *painted texture detail* on far-layer strips: rock strata, vegetation patches, distant villages. Paint at the correct sun direction or keep it lighting-neutral. |

**Gaussian splats as distant backdrops: assessment.**

- **Cost.** About 1–2M splats at 1440p means per-frame sorting (Spark does this) plus heavy
  translucent overdraw near the horizon. Expect 1.5–4 ms on a mid-range desktop GPU.
  **[Assessment, unmeasured]**
- **Problems.**
  - Radiance is baked, so the scene does not relight with our sun or preset.
  - It does not inherit our haze unless we recolour splats via Spark's shader graph.
  - Splats do not write clean depth, so ShoreBreak's refraction and contact passes, which rely
    on `rtOpaque` depth, would mis-handle them.
  - At 2–30 km a splat world has *less* information than a 30 m DEM silhouette with a painted
    texture.
- **Verdict.** Rejected for far bands. Possibly an experiment for a hero mid-band set piece
  (Uluwatu temple cliff).

## A6. HDRI environments

Candidates from Poly Haven (CC0, unclipped; slugs from Poly Haven pages, not downloaded):

| HDRI | Use |
|---|---|
| [blouberg_sunrise_1](https://polyhaven.com/a/blouberg_sunrise_1), [blouberg_sunrise_2](https://polyhaven.com/a/blouberg_sunrise_2) | South African beach at sunrise, 16K. Golden-hour reference and IBL test (California). |
| ["Saltwater Skies" vault](https://polyhaven.com/vaults/beach) | Collection of South African beach HDRIs. Vault items are released progressively. **[Vendor claim]** |
| [venice_sunset](https://polyhaven.com/a/venice_sunset) | Sea and town at sunset (tagged "ocean"). Portugal-evening grading reference. |
| [kloofendal_43d_clear](https://polyhaven.com/a/kloofendal_43d_clear), [kloofendal_48d_partly_cloudy](https://polyhaven.com/a/kloofendal_48d_partly_cloudy), [kloofendal_38d_partly_cloudy](https://polyhaven.com/a/kloofendal_38d_partly_cloudy) | Clear and partly-cloudy midday skies, 22 EV, CC0. Hawaii and Indonesia sky-plate and IBL reference. |
| [fouriesburg_mountain_midday](https://polyhaven.com/a/fouriesburg_mountain_midday), [quarry_cloudy](https://polyhaven.com/a/quarry_cloudy) | Cumulus skies for cloud-card extraction (Portugal). |

Poly Haven HDRIs are captured on land. None I found is an open-ocean capture. **[Reported]**

**Why a bare HDRI backdrop looks fake at sea level.**

1. **Horizon mismatch.** The HDRI's horizon (camera height and tilt at capture, lens
   calibration) never exactly coincides with ShoreBreak's sea vanishing line. A 0.2° error is
   about 5 px of "floating" coast.
2. **Wrong lower hemisphere.** Sand, grass or rocks occupy the region the water plane covers,
   and their reflection will not appear in the water.
3. **Zero parallax.** Everything in an HDRI is at infinity. Within 1–2 km the beach visibly
   fails to slide as the surfer travels 200 m.
4. **Fixed sun and haze.** These must match our sun direction, colour and haze exactly, or the
   surfer's shadow direction contradicts the sky.
5. **Reflection mismatch.** ShoreBreak's water reflects an elevation LUT, not the HDRI's
   clouds, so the sky and its reflection disagree.
6. **Resolution and size.** 1440p at 55° needs about 26 px/°, and a 16K equirect gives 45 px/°.
   A 16K EXR is hundreds of MB, and 8K is soft. **[Assessment]**

**Use HDRIs** as calibration references (radiance ratios, sun:sky ratio, horizon colour) and
as the **upper-hemisphere cloud plates** for 2D cloud layers (crop above about 3°, remove the
sun, blend into the procedural sky's horizon band). Do not use them as the backdrop or as the
surfer's IBL unless the same image is also the displayed sky. The `GroundedSkybox` addon is a
ground-projection trick for land scenes and does not apply here.

## A7. Layered distant scenery: techniques

- **Horizon-profile strips** (ShoreBreak `Backdrop` far panorama). Cheapest and best. Add a
  per-layer **2D detail texture in azimuth × elevation space**, about 4096×64–256 per layer,
  painted or AI-assisted: strata, gullies, vegetation, distant villages. Add slope-aware
  shading from a baked normal (ridge-facing-sun brightening). Add per-layer haze from the
  *real* distance. Vertical strips with no discard keep early-z.
- **Matte-painting cards at several depths.** Use only where the silhouette itself carries
  painted detail (Portuguese hilltop town, lighthouse, temple). Alpha-tested or alpha-to-coverage
  cards, placed at true depth and parallax-corrected (§A1).
- **Low-poly terrain with aerial perspective** (mid band). Use DEM or lidar meshes with
  triplanar cliff textures (ambientCG or Poly Haven CC0, or baked Megascans). Add a **wet,
  dark splash band** of 2–6 m at the cliff base with white foam lines (a key realism cue), a
  vegetation canopy macro map on top, and haze per vertex.
- **Procedural headlands.** Use domain-warped ridged fbm for silhouettes, as ShoreBreak does,
  plus strata banding for cliffs (sandstone California, layered limestone and flysch Portugal,
  limestone Uluwatu). Use these only where no DEM-derived shape is wanted.
- **Instanced vegetation impostors** (§A4). Instanced buildings use ShoreBreak's
  facade-shader approach (boxes plus procedural windows, band-limited by pixel footprint),
  generalised with a per-preset style palette: white render and terracotta roofs for Portugal,
  stucco and glass for California, thatch and timber warungs for Indonesia.
- **Beach strip.** A coastline-spline ribbon mesh with dry, wet and swash colour bands and
  foam lines from the water team's shore model, plus palm or scrub impostors behind.

## A8. Proposed environment architecture

### A8.1 Depth bands

| Band | Content | Technique | Budget (desktop, 1440p60) |
|---|---|---|---|
| **Near, 0–50 m** | Water (ShoreBreak), surfer, board, spray. Optional reef heads or rocks (Indonesia reef, Portugal rocks). | Scanned rock GLB (1–3 instances, 5–20k triangles each) with ShoreBreak's `RockWetness`-style wetness. Reef is mostly **bathymetry plus water tint** (water team), not geometry. | ≤ 4 draws, ≤ 60k tris, ≤ 16 MB |
| **Near-mid, 50–200 m** | Usually open water. Optional pier, moored boat, channel marker, lineup buoy. | Simple GLB props, hazed. | ≤ 3 draws, ≤ 30k tris |
| **Mid, 200 m–2 km** | Beach, cliffs and bluffs, rock platforms, vegetation, buildings, lighthouse. | DEM or lidar mesh chunks (meshopt) with triplanar CC0 textures and macro maps. Beach ribbon. Instanced azimuth impostors (2–20k). Instanced facade boxes. Cards for hero silhouettes. | ≤ 20 draws, ≤ 400k tris, ≤ 64 MB |
| **Far, 2–30 km** | Headlands, mountains, islands. | 3–5 horizon-profile strip layers (one merged mesh) with azimuth-elevation detail textures, real-distance haze, curvature sinking, parallax-corrected anchor. | 1–2 draws, ≈12k tris, ≤ 8 MB |
| **Sky** | Atmosphere, sun, clouds. | Sky-view LUT dome, 2D cloud layers, 4–12 relightable cloud cards (§B2). | 2–3 draws, ≤ 12 MB |
| **Total environment** | | | **≤ 30 draw calls, ≤ 500k tris, ≤ 100 MB GPU textures (KTX2/BC7), ≤ 25 MB download per location, ≤ 1.5 ms GPU** **[Assessment]** |

### A8.2 Location preset (data contract)

```ts
interface LocationPreset {
  id: 'hawaii-northshore' | 'california-pointbreak' | 'portugal-ericeira' | 'indonesia-reef' | string;
  geo: { lat: number; lon: number; shoreNormalAzDeg: number };  // real sun position + world rotation
  frame: { breakOrigin: [number, number]; lineupBox: [number, number, number, number] }; // ShoreBreak frame (x along shore, +z inland)
  time: { date: string; localTime: string; driftMinutesPerHour?: number };  // sun from ephemeris, or override:
  sunOverride?: { elevationDeg: number; azimuthDeg: number };
  atmosphere: { turbidity: number; ozone?: number; aerosolScaleHeightM: number; aerosolAlbedo: number;
                hazeEfoldM: number; nearVeil: number; hazeTint: [number, number, number] };
  skyLook: { exposureEV: number; tintMul: [number, number, number]; horizonDesat: number; zenithDeepen: number }; // art correction
  clouds: { layers: CloudLayer[]; cards: CloudCardSet; shadowCoverage: number; shadowScaleM: number; windDirDeg: number };
  far: { horizonBin: string; layers: { albedo: [number, number, number]; detailTex: string; detailStrength: number }[] };
  mid: { meshes: string[]; materials: Record<string, MaterialRef>; wetBandM: number;
         vegetation: { atlas: string; densityMap: string; species: SpeciesRef[] };
         buildings?: { densityMap: string; style: 'pt-white-terracotta' | 'ca-stucco' | 'id-warung' | 'hi-lowrise'; storeys: [number, number] };
         cards?: CardRef[] };
  near?: { props: PropRef[] };
  waterHints: { deepColor: [number, number, number]; shallowColor: [number, number, number]; clarityM: number;
                bed: 'sand' | 'reef' | 'rock' | 'mixed'; bathymetry?: string; foamTint?: [number, number, number] };
  grade: { lut: string; lutStrength: number; aeRangeEV: [number, number] };
  credits: string[];   // DEM, OSM and asset attributions
}
```

Runtime modules contain no location-specific code:
- **`SkyProvider`**: the atmosphere bake, which produces the shared uniforms and textures (§B1).
- **`HorizonLayers`**: a generalisation of `Backdrop`'s panorama.
- **`MidBand`**: GLB chunks, impostor field and facade instancer.
- **`CloudLayers`**.
- **`HazeParams`**.

A location is a build-time bake (DEM to `horizon.bin`, mid GLB, KTX2 atlases) plus this JSON.

### A8.3 Four launch presets (art direction)

| | **Hawaii** (North Shore Oʻahu-like) | **California** (Malibu/Rincon-like point) | **Portugal** (Ericeira/Nazaré-like) | **Indonesia** (Uluwatu/Mentawai-like) |
|---|---|---|---|---|
| Far | Fluted, green Koʻolau-style ridges at 8–15 km with clouds capping the peaks. A second range fainter. | Santa Monica Mountains-style chaparral ridges, 5–20 km, warm grey-ochre. | Low rolling hills, a headland with lighthouse (Nazaré fort) at 3–6 km. | Jungle islands at 5–20 km, partly sunk below the horizon; volcano cone very faint. |
| Mid | Sand beach with lava-rock points, ironwood and coconut palms, low houses. | Sandstone bluffs, coastal sage scrub, sand, PCH-style houses and lights. | 20–60 m schist/limestone cliffs, white houses with terracotta roofs on the cliff top, a harbour wall. | Limestone cliff with jungle on top, a temple silhouette, a bamboo warung cluster, a white-sand cove. |
| Near | Turquoise over sand and reef (bathymetry). | Kelp patches (dark slicks), rocks. | Rocks, a moored fishing boat. | Shallow reef visible through water. |
| Sun and time | 10:00–14:00, high sun, often **backlit** from over the land (north-facing shore). | **Golden hour**, sun low over the sea **behind the camera**, so cliffs are front-lit gold. | Late afternoon; dramatic cumulus, **cloud shadows on the sea**, crepuscular rays. | Late afternoon, warm humid haze, sun low. |
| Haze (e-fold; Koschmieder V ≈ 3.9 × e-fold) | 12–15 km, slight blue | 4–8 km, warm (marine layer) | 4–6 km, grey-blue sea-spray haze | 2.5–5 km, warm and desaturated |
| Clouds | Trade-wind cumulus, mostly over the land | Clear, or a thin marine-layer bank on the horizon | Cumulus congestus or stratocumulus, cloud shadows | Scattered cumulus, high cirrus |
| Water hint | Deep (0.01, 0.12, 0.20); shallow turquoise; clarity 25 m | Deep green-blue; clarity 8 m | Deep slate (0.02, 0.09, 0.12); clarity 6 m | Deep (0.01, 0.10, 0.16); shallow cyan over reef; clarity 20 m |

Water colours are hints in ShoreBreak's `uDeepColor` units (`main.js` default
`(0.017, 0.16, 0.22)` **[Verified]**). The water team owns the final values.

Sun azimuth relative to the chase camera decides the look more than any asset. A **backlit**
surfer gives rim light, translucent lips and a glittering sea. **Front-lit** gives saturated
colour and a flat look. Presets should choose time and sun deliberately, not from the real
clock. Real ephemeris is optional. **[Assessment]**

---

# Part B — Sky, atmosphere and lighting

## B1. Procedural atmospheric scattering

| Option | Status (2026-11) | Pros | Cons | Verdict |
|---|---|---|---|---|
| ShoreBreak measured LUT | In use | Fitted to a real phone clip | One sun position; display-referred data | Keep as the **calibration target** for the Nice preset only |
| three.js `Sky` addon (Preetham) | `examples/jsm/objects/Sky.js`, WebGL. `SkyMesh` is the WebGPU/TSL twin. **[Verified r186]** | Trivial | Single-scattering analytic fit. Known oversaturated or yellow horizon at low sun, poor twilight, nothing below the horizon, arbitrary units, no aerial perspective. **[Reported / Assessment]** | Reject |
| Hosek-Wilkie analytic | No three.js addon | Better than Preetham | Same structural limits (sky only, no aerial perspective) | Reject |
| **`@takram/three-atmosphere`** (Bruneton precomputed) | **MIT**, v0.19.1 (2026-05-06). **GLSL, WebGL** ("WebGPU is not supported… planned"). three ≥ 0.170; React and R3F optional; `postprocessing` ≥ 6.36.7 needed only for `AerialPerspectiveEffect`. **[Verified npm and README]** | Mature physically based sky. `SkyMaterial`, `SunDirectionalLight` (CPU transmittance), `SkyLightProbe` (SH irradiance). The `PrecomputedTexturesGenerator` runs incrementally over frames, or textures load from file. Real sun position via `astronomy-engine`. | **Fixed ECEF frame** (needs `worldToECEFMatrix` set from lat/lon). Horizon artefact only reduced by a workaround. No light shafts. Its aerial perspective is a `postprocessing` `EffectComposer` effect, which conflicts with ShoreBreak's own post. 0.x API churn. No published benchmarks. **[Vendor claim]** | **Recommended source of radiance**, used *only* for its precomputed textures plus `SkyMaterial` and probes. Do not adopt its post-process path. |
| Hillaire 2020 (sky-view and aerial-perspective LUTs) | No maintained WebGL three.js library; reference implementations exist | Cheap per-frame LUTs (transmittance 256×64, multi-scattering 32², sky-view about 192×108, aerial-perspective froxels 32³), so the sun can move freely. Sub-millisecond on console-class GPUs per the paper. **[Reported]** | About 400 lines of GLSL to port and validate | **Fallback** if takram's ECEF coupling or dependency weight is a problem |

**Recommendation: `SkyProvider`.** It owns the atmosphere and runs only when the preset loads
or the sun moves (optional slow drift, re-baked about every 2 s and amortised). It writes:

1. **Sky dome:** a **sky-view texture** (azimuth × elevation, 256×128 HalfFloat, √-elevation
   mapping, as ShoreBreak already does for reflections) with the sun disc and aureole added
   analytically.
2. **ShoreBreak's existing interface:**
   - `uSkyLut[18]` (elevation profile at the camera's main azimuth);
   - `uSkyTex` 256×1;
   - the azimuth-gain fit, *or*, preferably, the water team samples the 2D sky-view texture
     directly;
   - `uSunDir`;
   - `uSunColor` (transmittance × solar irradiance, scaled to contract units);
   - `uSkyAmb` (from the irradiance probe; see §B4 on the colour issue).
3. **PMREM** for surfer and board IBL (§B4).
4. **Haze colour function:** horizon in-scatter by azimuth, plus preset extinction.

On top of this sits a per-preset **art-direction correction** (`skyLook`: tint multipliers,
horizon desaturation, zenith deepening, exposure). A physical sky is the starting point, but
the target is footage, and real camera footage of tropical skies is more cyan and less
gradated than a clean Bruneton render. **[Assessment]**

**Dynamic sun.** It is supported, but the product runs indefinitely in one location per
session. Use a fixed sun per preset with an optional slow drift. Do not run a day-night cycle.

## B2. Clouds

| Approach | Cost | Quality from offshore | Verdict |
|---|---|---|---|
| **`@takram/three-clouds`** volumetric | **Expensive.** MIT, v0.7.6, GLSL. Needs `postprocessing` `EffectComposer` and the atmosphere's aerial perspective. Vendor numbers: M3 Max on High reaches 92–95 fps *with* temporal upscaling (1/16 of texels ray-marched) and **31 fps without**. 4090 at Ultra reaches 60 fps. Temporal upscaling "prone to ghosting and smearing". **[Vendor claim]** | Excellent | **Reject.** It conflicts with ShoreBreak's deterministic, history-free post, cannot appear in water reflections, and costs several ms on top of the water. |
| **2D layered procedural** (cirrus, altocumulus) in sky-view space | Cheap (<0.1 ms) | Good for high cloud | **Adopt.** ShoreBreak's `highCloud` is a seed. |
| **Relightable cloud cards** (cumulus near the horizon and over land) | Cheap. 4–12 alpha cards with a **6-way lightmap** atlas (light from ±X, ±Y, ±Z baked offline in Blender), blended at runtime by sun direction, with silver lining from forward scattering. | Very good at the 1–20 km apparent distance offshore cumulus sits at | **Adopt** for Hawaii (orographic caps), Portugal and Indonesia. |
| HDRI sky plate (upper hemisphere) | Cheap (one texture) | Photographic, but the sun is fixed and must match | Optional per preset when the preset's sun matches the plate |

**Required for believability.**
- **Cloud shadows on the sea and land** (Portugal especially). Use a shared scrolling 2D
  shadow texture (`uCloudShadow`, world xz) that multiplies `uSunColor` in water, land and
  surfer shaders. This is cheap.
- **Clouds in water reflections.** This requires the water team to sample the 2D sky-view
  texture instead of `uSkyTex` 1D: one texture fetch with a different coordinate, at the same
  cost. It is a request to the water team, not something we can do from outside.

## B3. Haze, distance fog and aerial perspective

- Use **one haze function, shared**. Colour comes from the sky provider's horizon in-scatter at
  the view azimuth (ShoreBreak's `landHazeColor` concept). Amount is
  `1 − exp(−max(d−d0,0)/efold − veil·(1−exp(−d/480)))` with `efold`, `veil` and `d0` from the
  preset. The current Nice values are 7400 m, 0.055 and 60 m. Koschmieder visibility
  V ≈ 3.912·efold.
- Optionally add a **height falloff** for a marine layer (California): haze density
  `∝ exp(−y/H)` with H ≈ 300–600 m, integrated analytically along the ray. This is cheap.
- The **far-sea fade** belongs to the water team, but it must converge to *the same* horizon
  colour. At sea level the horizon line's contrast is (sky horizon radiance) vs (sea
  reflection of the near-horizon sky plus body colour). In hazy presets the line must nearly
  vanish.
- The surfer is within 50 m, so apply a tiny veil (≤1–2%) only so that the surfer's
  saturation sits in the same air as the wave.
- **Reject** takram's `AerialPerspectiveEffect` and froxel aerial perspective. At our scales an
  analytic per-object haze in each shader is exact enough and composes with ShoreBreak's
  passes. **[Assessment]**

## B4. Image-based lighting, reflections and water bounce

**PMREM.**
1. Render the **shared sky dome** (the same shader the viewer sees) into a 128²-per-face cube,
   then call `PMREMGenerator.fromCubemap` or `fromScene`.
2. **Suppress the sun disc and inner aureole** when rendering the cube. Otherwise diffuse IBL
   double-counts the `DirectionalLight` and specular gets fireflies. ShoreBreak's `Sky.js`
   draws the disc unconditionally, so this needs a uniform or define. **[Verified need]**
3. Make the **lower hemisphere the sea**, not ground. ShoreBreak's explore-mode `Sky.js`
   already outputs a sea tone `uDeepColor·1.1 + (0.02, 0.05, 0.06)` below the horizon
   **[Verified]**. Add a Fresnel-weighted reflected-sky term near the horizon.
4. Regenerate only when the sky changes. That costs about 1–3 ms when it happens and nothing
   per frame. **[Assessment]**

**Consistency with ShoreBreak's ambient (the §1 finding).** A sky-derived PMREM gives
irradiance about (0.14, 0.34, 0.60) against ShoreBreak's fitted `uSkyAmb` (0.32, 0.36, 0.43).
Options:
- **(a) Recommended.** Everyone, ShoreBreak land shaders included, takes diffuse sky light from
  the provider's irradiance (SH9 or `uSkyAmb` set from it), with the preset's `skyLook`
  correction applied to that *irradiance* uniformly.
- **(b) Short term.** The surfer uses PMREM for **specular only** and a `HemisphereLight`
  matched to ShoreBreak (`skyColor = π·uSkyAmb`, `groundColor = π·(0.13, 0.12, 0.11)`; three's
  weight is 0.5+0.5·N·up against ShoreBreak's 0.62+0.38, close enough).
- Experiment E1 decides between them.

**Specular on wet skin and board.** Use the PMREM through `MeshPhysicalMaterial`'s base
specular and clearcoat lobes. A crisp horizon line in the environment map gives the essential
horizontal highlight on wet shoulders and the board deck. Keep the PMREM at 256² or above for
the clearcoat (roughness about 0.05). **[Assessment]**

**Water bounce (important).** In footage, the board's underside, the inside of the arms and
the chin are lit from below by the bright sea and whitewater. Cheap layers, all without
shadows:
1. **Sea lower hemisphere in the PMREM.** This is the static part.
2. **Mirrored-sun "glitter" fill.** A second `DirectionalLight` along
   `reflect(−sunDir, up)` with intensity ≈ F_avg × `uSunColor`, where F_avg is about
   0.02–0.08. Raise it for a backlit grazing sun, where the glitter path points at the camera
   and surfer.
3. **Foam bounce.** Raise the hemisphere `groundColor` (or a third upward light) by the local
   whitewater coverage around the board (foam albedo about 0.6–0.9, the water team's
   `uFoam`-type field). Sample it via ShoreBreak's async `SurfaceProbe` or a 1×1 GPU reduction
   read as a uniform. The cost is negligible. **[Assessment]**
4. **Inside a barrel**, the light is green-cyan transmitted through the lip. Tint the
   hemisphere sky colour toward `uDeepColor·k` when the water team reports "in tube". Event
   driven.

## B5. Shadows

| Need | Technique | Cost |
|---|---|---|
| **Sun shadow from surfer and board onto the board, body and feet** (crucial for contact) | One `DirectionalLight` shadow. 2048² map (4096² on high), orthographic frustum fitted to the bounding sphere of surfer plus board (radius about 1.5 m, so about 1.5 mm per texel). PCF with a kernel matched to the physical sun penumbra. | Cheap: the surfer and board (≤ 100k tris) are re-rendered once, ≈0.2–0.4 ms |
| Physical softness | The sun subtends 0.53°, so the penumbra is about **9 mm per metre** of occluder distance. Arm-to-board (about 1 m) gives 1 cm, i.e. crisp. | **PCSS is unnecessary.** A fixed-width PCF is about 0.1 ms. |
| Feet, hands and rails in contact | Screen-space contact shadows (8–16 depth steps along the light direction, on surfer and board pixels only), plus capsule AO under feet. ShoreBreak's `ContactLight` already runs on `rtOpaque` depth, so the surfer gets it free; check its 0.12–1.6 m radius does not over-darken skin. **[Verified it runs on all opaque depth]** | ≈0.1–0.3 ms |
| Shadow **on water** | Real footage: on clear water the surface is mostly reflection, so the surfer's shadow is faint. It is clearly visible on **foam and whitewater** and on the **seabed in clear shallow water** (Hawaii and Indonesia reefs). It shows as slight body darkening in aerated or turbid water. **[Assessment from footage]** | Export `uSurferShadow` (map plus matrix). The water team optionally applies it to foam diffuse, the seabed lighting term and the body in-scatter. One fetch, cheap. |
| Environment shadows (cliffs, buildings, palms) | Analytic or baked (ShoreBreak shades facade reveals analytically) | None at runtime |
| Cascaded shadow maps | **Not needed.** Nothing at km distance needs dynamic shadows. CSM would re-render the environment 3–4 times. | Reject |

## B6. Wet skin, hair and clothing

- **`MeshPhysicalMaterial` layering.** Skin and neoprene are the base. Clearcoat is the
  **water film** (IOR 1.33, `clearcoatRoughness` 0.03–0.1, `clearcoat` = film amount).
  - **Base roughness** goes down with wetness: skin about 0.45 to 0.3; neoprene about 0.6 to
    0.25; boardshorts fabric about 0.8 to 0.5.
  - **Porous darkening** (Lagarde's wet-surface rule): cloth, hair and neoprene albedo
    multiplied by about 0.5–0.7 when saturated; skin about 0.9.
  - **Sheen** on dry neoprene and fabric, fading out when wet.
  - `anisotropy` on hair cards.
  - **[Assessment]** Skin subsurface scattering is not in `MeshPhysicalMaterial`. It belongs to
    the character doc and needs a custom or patched shader.
- **Wetness state.** Use per-region scalars (head and hair, torso, arms, legs, board deck) with
  a two-time-constant model, like ShoreBreak's `RockWetness` (fast surface film, slower damp):
  - **Film** (gloss, clearcoat, drips): τ ≈ 5–20 s after leaving the water.
  - **Damp** (darkening): τ of minutes. In practice a surfer never dries, so
    darkening ≈ 1 always.
  - **Events.** Duck-dive, wipeout or submersion sets everything to 1. Paddling keeps the arms
    and chest at 1. Spray hits add 0.3.
  - **Storage.** A 4–8 float uniform, or a small 64² mask painted in UV space for drips
    running down. Cheap.
- **Droplets and rivulets.** Use a tiled droplet normal map on `clearcoatNormalMap`. Rivulets
  scroll along world −Y (gravity) through a flow-mask UV offset, masked by film wetness.
  Streaming water off elbows and the board tail is particles (the effects doc). Cheap.
- **Wet hair.** Darker, clumped (a geometry or normal variant), stronger and tighter specular,
  and a drip particle emitter for about 10 s after surfacing.
- **Cost.** Physical material with clearcoat, sheen and anisotropy is about 1.5–2× the
  standard material per pixel. The surfer covers under about 10% of the screen. Cheap to
  moderate overall.

## B7. Tone mapping, grading and colour

- **three.js operators (r186):** Linear, Reinhard, Cineon, ACESFilmic, AgX (Filament port) and
  Neutral (Khronos PBR Neutral). **[Verified constants and shader]** three applies tone
  mapping and output colour space **only when rendering to the default framebuffer** (or XR);
  render targets get `NoToneMapping` and the working colour space
  (`WebGLRenderer.js` ≈ L2378–2393). **[Verified]** So our materials rendered into ShoreBreak's
  HalfFloat targets come out scene-linear automatically, which is what we want. Do *not* set
  `renderer.toneMapping`. Tone mapping happens in ShoreBreak's GRADE pass.
- **Character of each operator.**
  - **ACES Filmic** is contrasty, with hue skews: cyan water goes green-ish, and bright skies
    skew yellow or cyan.
  - **AgX** handles bright saturated highlights (sun glitter, backlit spray) gracefully but
    looks flat and grey without a "punchy" look.
  - **Khronos Neutral** preserves base colours up to about 0.8 and compresses only the top.
    It suits products but is too clinical for footage.
  - ShoreBreak's **phoneLook** is a per-max-channel soft shoulder plus saturation plus gamut
    clip. **[Assessment]**
- **Recommendation for the cinematic target.**
  - Add a **"cinema" look profile in ShoreBreak's `Post`**:
    - Keep composite, bloom and the exposure meter.
    - Make lens glare a softer cine-lens veil with fewer ghosts.
    - Apply a tone curve: **AgX base**, copied from three's MIT `tonemapping_pars_fragment`,
      or a custom filmic curve.
    - Add **one `sampler3D` 33³ creative LUT** per preset, authored in DaVinci Resolve from
      log-encoded EXR captures.
    - Add a subtle vignette, a little grain, and dither.
    - **Bypass the ISP emulation** (unsharp mask, 4:2:0 chroma low-pass, maroon dashes).
  - WebGL2 supports 3D textures, and one tap fits ShoreBreak's 16-sampler budget.
  - three's `LUTPass` and `LUTCubeLoader` addons exist **[Verified]**. Use the loader and do
    the sampling in GRADE.
- **Working colour space:** linear Rec.709/sRGB primaries (three's default working space).
  Output is sRGB. Do not attempt P3 for now.
- **Auto-exposure** for cinema:
  - Base EV comes from the preset.
  - The meter allows ±0.5–1 EV (ShoreBreak: −0.5/+0.4), configurable per preset.
  - **Weight the meter toward the surfer's screen rectangle.** Operators expose for the
    athlete, and a backlit golden-hour surfer must not go to silhouette unless directed.

## B8. Proposed lighting contract with the water team

| Item | Proposal |
|---|---|
| **Units** | **ShoreBreak's relative scene-linear units**, kept as they are. The reference noon sun irradiance is `uSunColor = 2.1·(1, 0.95, 0.91)`, and sky radiance at the horizon is about 0.35–0.6. Exposure 1.0 puts diffuse white under the reference sun near the shoulder. **Not physical lux:** a physical sun disc (about 1.6·10⁹ cd/m²) overflows half-float (max 65504). ShoreBreak's disc is `400·uSunColor` ≈ 840, which leaves headroom for bloom. Other presets scale *relative* to this; for example a golden-hour sun ≈ 0.6–1.0 with a warm colour, compensated by preset EV. |
| **three.js mapping** | `DirectionalLight.color·intensity = uSunColor`. Both use `albedo·E·NoL/π`: three's `BRDF_Lambert = diffuse/π`, `irradiance = NoL·light.color`. **[Verified]** Ambient: `AmbientLight` or `HemisphereLight` colour `= π·uSkyAmb`, because ShoreBreak's `skyAmbient()` is irradiance/π. PMREM in the same radiance units with `envMapIntensity = 1`: three's `getIBLIrradiance` multiplies the prefiltered radiance by π, then Lambert divides by π. **[Verified]** |
| **Shared uniforms (one object, owned by `SkyProvider`)** | `uSunDir`, `uSunColor`, `uSkyAmb` (or `uSkySH[9]`), `uSkyLut`, `uSkyTex`, **new** `uSkyView` (2D), `uHaze` (efold, veil, d0, height falloff), `uCloudShadow` (texture plus transform), `uSurferShadow` (map plus matrix), `uExposure` (texture, shared meter). Water-owned and read by us: `uDeepColor`, the foam and whitewater coverage probe, the "in tube" flag. |
| **Ownership** | **BlueCurl environment:** sky provider, haze, clouds, location presets, the environment geometry, and the surfer, board and character lighting and materials. **Water team:** water, whitewater, foam, the far sea, and the **post framework and exposure meter**. BlueCurl contributes the "cinema" look profile and LUTs as data, through a reviewed PR. |
| **Render targets** | All HDR targets HalfFloat, `NoColorSpace` (linear), MSAA as ShoreBreak configures. No three.js tone mapping. One output OETF, in GRADE. |
| **Integration seam (pass order)** | (1) `rtOpaque`: sky, **environment layers, surfer and board** (depth written). Shadow-map pass for the surfer before this. (2) `ContactLight` on `rtOpaque` depth, which now includes the surfer. (3) Water back faces. (4) Copy, then water, which **refracts the submerged legs and rails** from `uOpaqueColor`/`uOpaqueDepth`. (5) Whitewater **and BlueCurl board spray**, depth-tested against `rtMain`. (6) `Post`. |
| **Known seam risks** | (a) Screen-space refraction can sample above-water surfer pixels near the waterline. ShoreBreak's depth-aware refraction should reject them; verify in E4. (b) The water does not reflect the surfer (sky-only reflection). On glassy faces real footage shows a faint reflection. A later water-team option is a cheap planar or SSR approximation. (c) Sampler budget (16) for any new shared textures. |
| **Frame budget, 1440p60 = 16.6 ms** (proposal) | Water and whitewater ≈ 9–10 ms (water team to confirm). Surfer, board and character ≈ 1.5–2. Shadows and contact ≈ 0.5. Environment ≈ 1.5. Sky and IBL ≈ 0.3 (plus amortised PMREM). Post ≈ 1.5. Spray ≈ 1. Slack ≈ 1. **[Assessment]** |

## B9. Spray and droplet lighting

Spray droplets (0.1–2 mm) are Mie scatterers with a **strong forward peak**. A backlit board
spray glows almost white-gold; front-lit spray is matte grey-white. Cheap per-particle shading:

```
L = uSunColor · cloudShadow · T_self · [ w·HG(cosθ, 0.75) + (1−w)·HG(cosθ, −0.2) ] · density
  + skyAmbient(up) · density · 0.8
```

Here θ is the angle between the sun and view directions, w ≈ 0.7, and
`T_self = exp(−k·opticalDepth)`. Approximate optical depth from particle age or size, or from
a cheap thickness, which is the particle depth minus scene depth.

- **Spray rainbow.** When the sun is behind the camera, add a spectral band at 40.6–42.3°
  from the anti-solar point on spray pixels, weighted by density. This is a common, cheap and
  highly believable cue in offshore-wind footage (Hawaii, Portugal).
- **Bloom.** Backlit glitter on spray must exceed the bloom threshold (ShoreBreak 3.0).
- Share this function with the water team's whitewater particles so the two sprays match.

## B10. Cost tiers (desktop GPU, 1080p–1440p at 60 fps) **[Assessment unless noted]**

| Cheap (≤ 0.3 ms each) | Moderate (0.3–2 ms) | Prohibitive (> 3 ms, or breaks the architecture) |
|---|---|---|
| LUT or sky-view sky dome; horizon-profile strips; 2D cloud layers and cloud cards; analytic haze in-shader; sun plus hemisphere plus PMREM lighting (static PMREM); one 2048² surfer shadow map with PCF; contact AO from `ContactLight`; tone curve plus 3D LUT; Henyey-Greenstein (HG) spray shading; wetness uniforms and normal maps; instanced billboard impostors (≤ 20k); cloud-shadow texture | PMREM regeneration (1–3 ms *when it happens*); per-frame Hillaire LUT updates; mid-band terrain 300–400k tris with triplanar; `MeshPhysicalMaterial` with clearcoat, sheen and anisotropy on the surfer; screen-space contact shadows; half-resolution GTAO; camera motion blur; ≤ 1M Gaussian splats | Volumetric clouds without temporal upscaling (takram: **31 fps on M3 Max High** **[Vendor claim]**); CSM over a km-scale scene; ray-marched god rays through spray; full-resolution SSR or planar reflections of the surfer in the water (water team's call); multi-million-splat relit backdrops; Google 3D Tiles streaming; strand hair; screen-space GI or path tracing |

---

## C. Recommendations

1. Build **`SkyProvider`** on `@takram/three-atmosphere`'s precomputed textures, `SkyMaterial`
   and probes (MIT, WebGL). Do not use its post effects. Keep Hillaire as the fallback. Feed
   ShoreBreak's existing sky uniforms plus a new 2D sky-view texture, and add a per-preset
   art correction.
2. Generalise ShoreBreak's **`Backdrop` panorama** into data-driven `HorizonLayers` baked from
   **Copernicus GLO-30**. Use lidar (3DEP, CUDEM, DGT) only for mid-band cliffs.
3. In the mid band, use DEM or lidar meshes with CC0 triplanar materials, **1D-azimuth
   impostors** baked from SpeedTree or procedural plants, and ShoreBreak-style instanced
   facades. Nothing on land inside 200 m.
4. Clouds: 2D layers plus 6-way-lit cards plus a shared cloud-shadow texture. Ask the water
   team for 2D sky-view reflections.
5. Surfer lighting:
   - sun `DirectionalLight` = `uSunColor`;
   - one tight shadow map;
   - a sky PMREM with the sun suppressed and the sea in the lower hemisphere;
   - mirrored-sun and foam bounce fills;
   - physical wet materials driven by a wetness state machine.
6. Adopt the **contract in §B8**. The surfer renders into `rtOpaque`. One post chain, owned by
   the water team, with a BlueCurl "cinema" profile (AgX or filmic, 3D LUT, no ISP emulation,
   surfer-weighted metering).

## D. Rejected alternatives (decision log)

| Alternative | Reason |
|---|---|
| Google Photorealistic 3D Tiles (runtime or bake) | ToS forbids caching, offline use and extraction. Logo requirement. Melted grazing-angle geometry with baked lighting. |
| Cesium ion streaming | Commercial subscription, a globe architecture we do not need, the same grazing-angle issues. |
| Bare HDRI backdrop | Horizon and lower-hemisphere mismatch with the water, zero parallax, fixed sun and haze, reflections disagree, file size. |
| HDRI as surfer IBL when the displayed sky is different | Lighting would contradict the visible sky. |
| three.js `Sky` (Preetham) or Hosek-Wilkie | Poor at low sun, no aerial perspective, arbitrary units. |
| takram `AerialPerspectiveEffect` and post-process lighting | Requires the pmndrs `EffectComposer`, conflicts with ShoreBreak's post, and its post-process lighting is Lambert-only on unlit materials. |
| Volumetric clouds (takram three-clouds) | Multi-ms cost, temporal-upscaling ghosting, not reflected in the water. |
| Gaussian-splat far backdrops (Spark or Marble) | Baked lighting, poor depth integration, cost, and less information than a DEM silhouette at that range. Kept as a mid-band experiment only. |
| three.js core `GaussianSplat` | WebGPU-only (r186). ShoreBreak is WebGL2. |
| HunyuanWorld 1.0 | Licence territory excludes the EU, UK and South Korea. |
| Blockade Skybox AI as a runtime sky | LDR (reported), baked sun, imprecise horizon. Concept and matte source only. |
| Full octahedral impostors | View elevation is almost constant from offshore, so 1D azimuth frames suffice. |
| Cascaded shadow maps or PCSS | Nothing distant needs dynamic shadows. The sun penumbra is about 1 cm at surfer scale. |
| Photometric (lux) units | Half-float overflow and recalibration of ShoreBreak. Relative units suffice. |
| Three.js renderer tone mapping | Not applied to render targets anyway. Tone mapping belongs in the single GRADE pass. |

## E. Small experiments (1–3 days each)

1. **E1 — Ambient consistency (1 day).** In a ShoreBreak fork, place an 18% grey sphere, a
   white card and a skin-albedo sphere on the beach. Light them (a) with
   `HemisphereLight(π·uSkyAmb)` and (b) with a PMREM of ShoreBreak's sky (sun suppressed).
   Compare against the rocks and sand and against the reference clip. Decide contract option
   (a) or (b) in §B4.
2. **E2 — DEM horizon bake (2 days).** Use GLO-30 tiles for North Shore Oʻahu. Bake the
   horizon profiles from a line-up point off Ehukai (≈21.665°N, 158.053°W) into three bands
   with the curvature correction. Replace `Backdrop.LAYERS` with the baked data. Compare
   screenshots with photos from the line-up for silhouette and haze stacking.
3. **E3 — SkyProvider prototype (3 days).** Use takram's `PrecomputedTexturesGenerator` and
   `SkyMaterial` with `worldToECEFMatrix` for Nice. Bake `uSkyLut`, `uSkyTex`, `uSunColor`,
   `uSkyAmb` and the PMREM for sun elevation 66°, then fit the `skyLook` correction until it
   matches ShoreBreak's measured LUT. Re-bake at 8° sun for golden hour. Measure bake time and
   per-frame cost, and confirm three r186 compatibility.
4. **E4 — Surfer integration seam (2–3 days).** Put a stand-in GLB (character and board,
   `MeshPhysicalMaterial`) in `opaqueScene` with sun shadow, PMREM and the two bounce fills.
   Verify:
   - refraction of submerged legs and rails, and waterline artefacts;
   - `ContactLight` behaviour on skin;
   - whitewater depth-testing;
   - GPU time of the shadow pass and materials at 1440p.
5. **E5 — Spray phase shading (1 day).** Use a particle fan with HG two-lobe shading against
   ShoreBreak's whitewater shading, backlit and front-lit, plus the anti-solar rainbow band.
   Judge against footage stills.

## F. Sources (accessed 2026-11-19)

- ShoreBreak (read locally): `src/core/look.js`, `src/sky/Sky.js`, `src/sky/skyModel.js`,
  `src/glsl/common.js`, `src/glsl/water.js`, `src/post/Post.js`, `src/post/Exposure.js`,
  `src/post/ContactLight.js`, `src/config.js`, `src/beach/Backdrop.js`, `src/beach/haze.js`,
  `src/main.js`, `docs/ARCHITECTURE.md`, `THIRD_PARTY_NOTICES.md`.
  https://github.com/cryptomanavan/ShoreBreak (MIT)
- three.js r186 sources via unpkg: `src/constants.js`, `ShaderChunk/common.glsl.js`,
  `lights_physical_pars_fragment`, `lights_pars_begin`, `envmap_physical_pars_fragment`,
  `tonemapping_pars_fragment`, `WebGLRenderer.js`, `examples/jsm/objects/{Sky,SkyMesh,GroundedSkybox,GaussianSplat}.js`,
  `examples/jsm/csm/CSM.js`, `examples/jsm/postprocessing/LUTPass.js`. https://unpkg.com/three@0.186.0/
- npm (`npm view`): `@takram/three-atmosphere` 0.19.1, `@takram/three-clouds` 0.7.6,
  `@takram/three-geospatial` 0.9.1, `@sparkjsdev/spark` 2.4.0, `postprocessing` 6.39.6 (Zlib,
  three < 0.188), `@gltf-transform/core` 4.5.1, `three` 0.187.0 (latest).
- takram READMEs: https://github.com/takram-design-engineering/three-geospatial/tree/main/packages/atmosphere,
  https://github.com/takram-design-engineering/three-geospatial/tree/main/packages/clouds
- Spark: https://unpkg.com/@sparkjsdev/spark@2.4.0/README.md, https://www.worldlabs.ai/blog/spark-2.0, https://sparkjs.dev/docs/new-features-2.0/
- Google Map Tiles policies: https://developers.google.com/maps/documentation/tile/policies;
  FAQ: https://cloud.google.com/blog/products/maps-platform/commonly-asked-questions-about-our-recently-launched-photorealistic-3d-tiles;
  Cesium forum on offline use: https://community.cesium.com/t/how-can-i-download-photorealistic-3d-tiles-for-cesium-js-react-offline-self-hosted/26293
- Cesium pricing: https://cesium.com/platform/cesium-ion/pricing/
- Fab licences: https://dev.epicgames.com/documentation/en-us/fab/licenses-and-pricing-in-fab;
  transition FAQ: https://forums.unrealengine.com/t/quixel-to-fab-transition-faqs/2033839;
  Creative Bloq: https://creativebloq.com/news/the-worlds-biggest-library-of-scanned-assets-for-3d-artists-is-now-free-and-it-seems-that-this-time-its-for-good
- SpeedTree: https://support.unity.com/hc/en-us/articles/15723241438228-What-is-the-difference-between-SpeedTree-Indie-Pro-Library-and-Enterprise, https://unity.com/products/speedtree
- Octahedral impostors: https://github.com/agargaro/octahedral-impostor, https://discourse.threejs.org/t/octahedral-impostors-for-three-js/80318
- Blockade Labs: https://skybox.blockadelabs.com/plans, https://www.cgchannel.com/2024/04/blockade-labs-launches-skybox-ai-2
- World Labs: https://docs.worldlabs.ai/api/pricing, https://docs.worldlabs.ai/marble/export/gaussian-splat/index.md
- HunyuanWorld licence: https://github.com/Tencent-Hunyuan/HunyuanWorld-1.0/blob/main/LICENSE
- Poly Haven: https://polyhaven.com/vaults/beach, https://polyhaven.com/a/blouberg_sunrise_1, https://polyhaven.com/a/kloofendal_38d_partly_cloudy
- Copernicus DEM licence: https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf
- DGT LiDAR: https://www.dgterritorio.gov.pt/sites/default/files/ficheiros-artigos/Apresentacoes/2025/5-Webinar_LiDAR_15jul2025.pdf
- NOAA CUDEM Hawaii: https://www.ncei.noaa.gov/metadata/geoportal/rest/metadata/item/gov.noaa.ngdc.mgg.dem:199919/html
- GEBCO: https://www.gebco.net/gebco2025-grid, https://www.gebco.net/data-products/gridded-bathymetry/terms-of-use
- Hillaire 2020, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique", EGSR (cited from memory **[Reported]**). Bruneton & Neyret 2008, precomputed atmospheric scattering.
