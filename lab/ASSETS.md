# Surf Lab assets manifest

Every third-party file the lab loads, with source and licence. Development placeholders are marked;
nothing here is cleared for a public release unless the licence column says so.

| File | What | Source | Licence | Status |
|---|---|---|---|---|
| `public/assets/hdri/blouberg_sunrise_2_1k.hdr` | Golden-hour HDRI (subject IBL for preset B) | Poly Haven "Blouberg Sunrise 2" (Greg Zaal), via the three.js r186 examples (`examples/textures/equirectangular/`) | CC0 1.0 | OK to ship |
| `public/assets/characters/rocketbox_male_adult_01.glb` | Placeholder rigged human (Male_Adult_01) | Microsoft Rocketbox avatar library, https://github.com/microsoft/Microsoft-Rocketbox, converted with `tools/blender/rocketbox_to_glb.py` | MIT (see `ROCKETBOX_LICENSE.md`; keep the copyright notice) | Development placeholder (dated quality, clothed, no twist bones) |

Generated in code (no third-party data): the board (`src/boardkit`), its textures (stringer, wax,
wax bumps, pad grooves), the overcast sky (CIE overcast formula), the procedural golden-hour sky
(three.js `Sky`, MIT) and the studio environment (three.js `RoomEnvironment`, MIT).
