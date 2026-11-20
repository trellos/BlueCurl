# Third-party code in BlueCurl Swell (viz/)

## ShoreBreak (this repository's root `src/`)

MIT License, Copyright (c) 2026 Christopher Canavan. Full text: [`../LICENSE`](../LICENSE).

Code was copied (not imported) from ShoreBreak and adapted. Each file carries a header that names its source.

| viz file | ShoreBreak source | changes |
|---|---|---|
| `src/core/gpu.js` | `src/core/gpu.js` | none (header only) |
| `src/water/foamNoise.js` | `src/whitewater/foamNoise.js` | none (header only) |
| `src/water/OceanFFT.js` | `src/water/OceanFFT.js` | cascade constants moved into the file; patch sizes, band edges, wind and fetch are now options (a light offshore dawn breeze) |
| `src/water/waterShading.glsl.js` | `src/glsl/water.js` (CHOP `oceanDisp` / `oceanSlopeLEAN`, WATER_SHADE `roughReflection`, `smithG1`, `shadeWaterFull` transmission: thickness, Beer-Lambert absorption, forward scatter), `src/glsl/common.js` (NOISE, OPTICS) | Reduced to the open-water and lip optics. The phone-clip tuning is removed (facet noise, cat's paws, Poisson glints, maroon dashes, swash, milk, silt, toe, opaque-pass and back-depth passes). The bed is now read from `bcDepth`. A thickness hint is passed in. |
| `src/sky/skyModel.js`, `src/sky/Sky.js` | `src/sky/Sky.js` (dome vertex shader), `src/glsl/common.js` SKY, `src/sky/skyModel.js` (aureole) | New dawn colour model and clouds. An environment map is built with PMREM. |
| `src/post/Post.js` | `src/post/Post.js` (`DOWN` soft-knee threshold, `BLUR`, `gauss3`) | New grade: AgX or ACES, vibrance, exposure. All phone-camera artefacts are dropped (lens glare and dirt, rolling shutter, sensor noise, chroma artefacts, ISP). |

## Components that ShoreBreak itself credits

The adapted code still contains these components:

- **David Hoskins, "Hash without Sine"** (MIT): the `bcHash*` routines in `waterShading.glsl.js`, the sky hash and the post dither hash. See [`../licenses/Hash-without-Sine-MIT.txt`](../licenses/Hash-without-Sine-MIT.txt).
- **Mulberry32** (public domain): bryc's JavaScript implementation of Tommy Ettinger's generator. It appears in `OceanFFT.js` and `foamNoise.js`. See [`../licenses/Mulberry32-Public-Domain.txt`](../licenses/Mulberry32-Public-Domain.txt).

## three.js

MIT, Copyright © 2010-2026 three.js authors. See [`../licenses/three-MIT.txt`](../licenses/three-MIT.txt).

The AgX tone curve in `src/post/Post.js` follows three.js's `tonemapping_pars_fragment`. That code is based on Filament, Blender and the iolite minimal AgX implementation.

The ACES curve in the same file is Stephen Hill's fit.
