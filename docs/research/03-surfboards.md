# Investigation 3: Surfboard assets

Checked 2026-11-19. Labels follow `_brief.md`: **[Verified]**, **[Vendor claim]**, **[Reported]**, **[Assessment]**.

**Method and limits.** I cloned and read the code of BoardCAD LE, boardcad-java, tinyshaper, surfboard-cad and three.js (r186, r187 and dev). I checked three.js and glTF tooling versions on npm and PyPI. I also built a throw-away volume check in my scratch directory (§4.7). This session could not reach shape3d.com, cgtrader.com, turbosquid.com, fab.com, pyzelsurfboards.com, the Swaylocks forum (for direct fetches), the Sketchfab API or the BoardCAD docs on github.io. For those sites the data comes from search-engine snippets and is labelled **[Reported]**. Partway through, the shared web-search budget ran out, so a few numbers are marked **[Assessment]** with a note to verify. I could not inspect preview images; Sketchfab pages were only readable as metadata.

---

## 0. TL;DR recommendation

1. **Generate the board procedurally.** Write our own TypeScript geometry kernel. It is driven by a compact *BoardSpec* of about 40 shaper parameters: outline, rocker, foil, deck dome, bottom contours, rail band, tail type, fins, plug, pad and finish.
   - **Build time:** Node runs the kernel and emits GLB files with LODs, a fixed UV layout and the anchor empties, so artists can paint and bake in Blender or Substance.
   - **Run time:** the same kernel loads in the browser and answers analytic queries such as deck height and normal under a foot, rail lines, buoyancy centre and fin positions.
2. **Use bought models and real shaper files only as references and validation targets**, not as shipped assets. Marketplace models are generic and often have wrong proportions. They carry no stance metadata, and their licences vary (NoAI tags, single-use terms).
3. **Most of the realism comes from materials, not geometry.** Spend the art time on these surface cues:
   - finish: sanded vs gloss clearcoat;
   - resin laps and pinlines;
   - stringer visibility;
   - backlit foam translucency at the rails;
   - wax, traction pad with a visible kick;
   - heel dents;
   - wetness;
   - a leash rope simulated with verlet integration.
   These are what a rear chase camera actually sees: deck, tail pad, leash, and the rails and bottom in carves and wipeouts.
4. **Do not port BoardCAD code.** It is GPL (§2.1), and a port would put copyleft obligations on the shipped web bundle. Use BoardCAD as an external tool to view, convert and export STL for validation, and reimplement the concepts clean-room.

---

## 1. Board types: real geometry

### 1.1 Measurement conventions shapers use

- **Length** is measured tip to tip. **Width** is the maximum width ("wide point"). **N12 / T12** are the nose and tail widths 12″ from the tips (the standard reference points). **Thickness** is the maximum thickness, measured on the stringer. **[Reported]** (e.g. the template comments in [Mtcc/surfboard-cad `templates.js`](https://github.com/Mtcc/surfboard-cad), which say "width at 12″ from nose tip (industry standard)").
- **Rocker** is the height of the bottom above a flat table at the nose and tail tips. Shapers also quote "1-ft" rocker, the height 12″ in from each tip; BoardCAD stores `noseRockerOneFoot` and `tailRockerOneFoot` in `.brd` (`BrdReader.java` cases 39 and 40). **[Verified]** Tip numbers alone do not say where the apex of the bend sits, and boards with identical tip numbers can ride differently ([Surfer's Journal via search](https://www.surfersjournal.com/?p=1394425)). **[Reported]**
- **Volume** is in litres. Volume / (L·W·T) is a useful sanity coefficient. From published specs it lands at **0.52–0.58** (§4.7). **[Verified]** (computed from the published numbers below)

### 1.2 Type table

Imperial values are what shapers publish; the generator works in metres.

| | Shortboard | Fish | Mid-length | Longboard | Step-up | Big-wave gun |
|---|---|---|---|---|---|---|
| Length | 5′10″–6′4″ | 5′2″–6′0″ | 6′8″–8′0″ | 9′0″–9′8″ | 6′6″–7′6″ | 8′6″–10′6″+ |
| Width | 18¼–19¾″ | 19½–21½″ | 20½–22½″ | 22½–23½″ | 18½–19¾″ | 20–21½″ |
| Thickness | 2¼–2⅝″ | 2.3–2.6″ | 2⅝–3″ | 2¾–3¼″ | 2½–2⅞″ | 3¼–3¾″ |
| Volume | 24–32 L | 28–36 L | 42–60 L | 65–85 L | 32–43 L | 60–90 L |
| N12 / T12 | ~11–12″ / ~13¾–14¾″ | ~13½–15″ / ~15–16½″ | ~14½–16½″ / ~14–15½″ | ~17–19″ / ~14½–16″ | ~11–12″ / ~12½–13½″ | ~11½–13½″ / ~11–12½″ |
| Wide point | 0–2″ behind centre | 1–4″ ahead of centre | ~centre | ~centre | 1–3″ ahead of centre | 2–4″ ahead of centre |
| Nose / tail rocker | 4¾–5½″ / 2–2⅝″ | 3½–4¼″ / 1¼–1¾″ | 4–5″ / 2–2½″ | 3½–4½″ / 2–3″ (kick) | 5–6″ / 2½–3″ | 5–6½″ / 2½–3½″ |
| Bottom | single → double concave out the tail, sometimes vee | flat/single → vee or double through the tail | single → double, or slight vee | nose concave (noseriders), rolled vee/belly → flat | single/double with tail vee | slight concave → double; vee in tail |
| Rails | medium-soft fwd, low tucked "down rail" in tail, hard edge last ~⅓ | fuller/boxier mid, hard in tail | high/soft nose → mid tucked → low/hard tail | 50/50 soft, tucked only near tail | lower-volume, tucked | full but refined, tucked |
| Tail | squash, round, rounded pin, swallow | swallow ("fish tail"), notch 3–5″ | round, rounded pin, squash | square/squash/round, often with "hip" | rounded pin | pin |
| Fins | thruster (5-plug common) | twin keels, quad, twin+stabiliser | 2+1, single, 5-fin | single (10″ box) or 2+1 | thruster (larger fins) | thruster or quad, large fins |
| Leash | 6′, ~6–7 mm | 5–6′ | 7–8′ | 9′, calf or ankle | 7′ | 10–12′, ~8–9 mm |

Sources and confidence:

- **Shortboard [Reported]:**
  - Volumes: Surfboard Empire lists 6′0″×18¾×2⅜ at 28.5 L ([calculator](https://surfboardempire.com.au/pages/volume-calculator)). DHD Sweetspot 3 is 6′0″×18¾×2 5/16 at 28 L, and 6′4″×18⅞×2⅜ at 29.5 L ([dhdsurf](https://dhdsurf.com/collections/vault/products/sweetspot-3)).
  - Rocker: about 5″ nose and 2–2.5″ tail is the common blank formula. Examples: a 6′4″ HPSB at 5⅜″/2⅜″, and a 6′1″ at 5 3/16″/2½″ ([Swaylocks rocker measurements](https://forum.swaylocks.com/t/rocker-measurements/48722)).
  - A 6′2″ template: 19.5×2.5, N12 10.75, T12 14.75, rocker 4.75/2.25 ([surfboard-cad templates](https://github.com/Mtcc/surfboard-cad)).
- **Fish [Reported]:** Lost RNF '96 5′6″ is 19.75×2.40 at 29.5 L; the RNF Retro 5′6″ is 20.75×2.40 at 32 L ([realwatersports](https://www.realwatersports.com/collections/lost-round-nose-fish-redux), [surfstation](https://www.surfstationstore.com/products/lost-rnf-twinzer-96er-56-surfboard-futures)). Fish rocker and N12/T12 values are **[Assessment]**.
- **Mid-length [Reported]:**
  - CI Mid 7′6″ is 21¾×2⅞ at 51.8 L, 2+1 or single ([theboardsource](https://theboardsource.com/products/ci-mid-77), [realwatersports](https://www.realwatersports.com/collections/channel-islands-ci-mid)).
  - Harley Ingleby Mid 6, 7′6″, is 21×2¾ at 47.9 L, 5-fin. Rails are described as "high nose rails through to mid tucked and low hard in the tail" ([realwatersports](https://www.realwatersports.com/products/harley-ingleby-mid-6-thunderbolt-red-81)).
  - Mid-length rocker and N12/T12 values are **[Assessment]**.
- **Longboard [Reported]:**
  - CI 9′4″ Noserider is 23⅛×3 ([ridershack](https://ridershack.com/products/channel-islands-94-noserider-traditional-longboard-surfboard)). Stewart California Nose Rider 9′4″ is 23¼×3¼ ([stewart](https://stewartsurfboards.com/collections/california-nose-rider)).
  - G&S 9′4″ Classic Noserider: nose 18″, tail 16″, single fin 9–9.5″ ([iconsofsurf](https://iconsofsurf.com/products/g-s-94-classic-noserider)).
  - Sunova Novalova 9′6″: N12 21 1/16, T12 15 ([sunova](https://sunovasurfboards.com/en/surf/longboards/novalova)).
  - Ocean Magic noserider: 50/50 rails and a flatter nose rocker ([downthelinesurf](https://www.downthelinesurf.co.uk/ocean-magic-om-nose-rider-9-4-longboard-blue.html)).
- **Step-up and gun [Reported]:**
  - Pyzel's standard Padillac table covers about 6′10″–7′2″ at 38–43 L ([pyzel](https://pyzelsurfboards.com/pages/board-model/padillac), via search).
  - Padillac 9′6″ is 21¼×3⅝ at 75.4 L ([oceanmagic](https://www.oceanmagic.co.uk/product/pyzel-padillac-76-red-spray/)). The 9′0″ is 21×3½ at 67.2 L ([triocean](https://trioceansurf.co.uk/?p=50180)). The 10′5″ is 21.5×3.63.
  - FCD describes outer-reef guns as "flatter, thicker, straighter, wide point forward, slight concave to double concave", 8′6″–10′6″ ([fcdsurfboards](https://fcdsurfboards.com/guns-all)).
  - Gun and step-up rocker values are **[Assessment]** (typical published blank rockers; verify against a shaper file).

### 1.3 Fins

| Setup | Placement (measured to trailing edge of fin base) | Toe | Cant | Source |
|---|---|---|---|---|
| Thruster, sides | 11–11½″ from tail, 1–1¼″ off rail (6′0″) | ⅛–⅜″ over base (~2–5°) | 5–7° (2–8° range) | [Swaylocks 38255](https://forum.swaylocks.com/t/help-needed-with-thruster-fin-placement/38255), [40718](https://forum.swaylocks.com/t/fin-set-up-thruster/40718), [45262](https://forum.swaylocks.com/t/fin-trailing-edge-from-rail/45262) **[Reported]** |
| Thruster, centre | 3⅛–3½″ from tail, on stringer | 0 | 0 | same **[Reported]** |
| Quad, rears | ~4½″ from tail, ~2″ off rail | ⅛″ | ~3.5° (about 5° less than fronts) | [Swaylocks 36226](https://forum.swaylocks.com/t/quad-fin-predicament/36226) **[Reported]** |
| 2+1 (8′6″ example) | box rear 4″ from tail; side plugs 12¾″ from tail, 1¼″ off rail | ¼″ | 5–7° | [Swaylocks 13944](https://forum.swaylocks.com/t/fin-placement/13944) **[Reported]** |
| Single (longboard) | 10″ box, fin trailing edge ~4–7″ from tail (slides) | 0 | 0 | **[Assessment]** |
| Twin keel (fish) | keels close to rail, trailing edge ~1–2″ ahead of swallow-tip line; base ~7–8″, depth ~5–6″ | ~0–⅛″ | 0–4° | **[Assessment]** |
| Twin + stabiliser | twins ~10–11″ from tail; trailer ~2½–3″ deep, 3–4″ from tail | ⅛″ | 4–6° | **[Assessment]** |

- **Typical templates [Assessment, verify against FCS/Futures spec sheets]:**
  - thruster "M" fin: base ~110–115 mm, depth ~112–118 mm, rake ~30–35°;
  - longboard single: 9–10″ deep;
  - gun fins: one size up.
- **Foils [Assessment]:**
  - centre fin: symmetric (50/50), thickness ~7–9% of chord at the base, tapering to ~4 mm at the tip;
  - side fins: flat or slightly concave on the inside, foiled on the outside;
  - quad rears: 80/20 or 70/30 inside foil.
- **Plug systems [Assessment]:** FCS II, Futures (a long box) and glass-on fins look different from below. For BlueCurl's camera this barely matters; model a box or plug footprint in the bottom texture only.

### 1.4 Hardware and surface items

- **Leash plug.** Sits on the stringer, ~3–6″ (75–150 mm) from the tail, usually just ahead of the rear fin or between the fins. The rail-saver loop should be shorter than the distance from plug to rail; ~1.5″ is typical ([gong-galaxy](https://www.gong-galaxy.com/en/blogs/how-to/choose-your-leash), [supboarder](https://supboardermag.com/2020/03/03/supboarder-quick-sup-tip-get-your-sup-leash-string-the-correct-length/)). Placement is **[Assessment]**; the loop guidance is **[Reported]**. Leash length ≈ board length ([redbull](https://www.redbull.com/us-en/surfboard-leash)). **[Reported]**
- **Traction (tail) pad.** Three-piece EVA, about 300–340 mm long by 300–340 mm wide. Kick is 16–30 mm (25 mm typical), with a 7–8 mm centre arch. Groove patterns are diamond, micro-dot or grid. Examples: O&E Owen Wright 300×300, 25 mm kick, 7 mm arch; Dakine Wideload 13×14″, 25 mm kick; Low Tide Tiger 320×330, 30 mm kick; Pro-Lite Wide Ride (fish) 275×337, 16 mm kick ([mydeal](https://www.mydeal.com.au/ocean-and-earth-3-piece-traction-surfboard-grip-owen-wright-tail-pad-3776542), [evo](https://www.evo.com/products/263014-dakine-wideload-traction-pad), [usedsurf](https://usedsurf.com/low-tide-tiger-3-piece-traction-pad/), [evo](https://www.evo.com/products/100768-pro-lite-wide-ride-traction-pad)). **[Reported]** The kick is a visible silhouette element from a rear chase camera, so model it as geometry. **[Assessment]**
- **Wax.** Base coat plus top-coat bumps (1–3 mm, irregular, cross-hatched or circular application). It covers the deck from the pad front to about chest level, plus the rails where hands grab. Longboards are waxed nose to tail and have no pad. **[Assessment]**
- **Stringer.** PU blanks have ⅛″ (3 mm) basswood, balsa or spruce, visible through clear or tinted laminate as a thin line on deck and bottom. EPS/epoxy boards are often stringerless, or carry carbon strips or a perimeter rail band. **[Assessment]**
- **Glass job and lap.** On tinted or coloured boards the bottom laminate wraps ~1–1½″ onto the deck as a "lap" line, cut or free-lap, often with a pinline. **[Assessment]** This is a strong realism cue and the UV/attribute layout must support it (§4.5).
- **Stance (for §6).** The back foot goes over the fins or tail pad. Feet are shoulder-width or slightly wider and centred over the stringer. The front foot sits just behind the midpoint, at roughly 45°, with about a 60/40 back/front weight split ([barefootsurftravel](https://barefootsurftravel.com/?p=9345), [rapturecamps](https://www.rapturecamps.com/learn-to-surf/surf-fundamentals/stance), [naturalnecessity](https://www.naturalnecessity.com.au/blogs/news/your-guide-to-the-perfect-surfing-stance)). **[Reported]** One coaching source disputes "right over the fins" ([ombe](https://ombe.co/guides/the-back-foot-debate-and-how-overthinking-your-surfing-is-ruining-it)).

---

## 2. Shaping software and file formats

| Tool | Licence / cost | Formats | Reuse value for us |
|---|---|---|---|
| **BoardCAD** (original, SourceForge) | GPLv2 per SourceForge listing ([sf.net](https://sourceforge.net/projects/boardcad)) **[Reported]** | `.brd`, imports aps3000/Shape3d/AKU/SurfCAD; exports STEP/DXF/STL | Reference implementation of the shaper data model |
| **BoardCAD LE** ([HavardNJ/boardcad-le](https://github.com/HavardNJ/boardcad-le)) | **GPL v3 or later**, stated in `AboutBox.java`; GPL text embedded in `BezierFit.java`; **no LICENSE file at repo root**. Last commit 2026-02-18, v3.2.2 LE, Java 25 / Gradle **[Verified]** | Reads `.brd` (plain and encrypted `%BRD-1.01/1.02`), `.brd` XML, `.s3d`, `.s3dx`, `.srf`. Writes `.brd`, `.brd` XML, `.s3d`. Exports STL, DXF, PDF, G-code **[Verified]** | **Use as an external tool** (convert shaper files, export STL for validation). Don't port code (GPL). |
| boardcad-java ([hornstein](https://github.com/hornstein/boardcad-java)) | No licence file; last commit 2017-09-29; ships jars and a Jython console **[Verified]** | as above | Historic. Other forks: [maloletniy/Boardcad](https://github.com/maloletniy/Boardcad), [byronsj/boardcad](https://github.com/byronsj/boardcad) **[Verified exist]** |
| **Shape3d X** ([shape3d.com](https://shape3d.com/Products/Shape3dX.aspx)) | Lite free; paid Design and Design Pro. 3D export (STL/OBJ) and 3D layers (swallow tails, channels) are Pro features. Prices not retrieved (site blocked) **[Reported]** | `.s3dx` (XML), `.s3d`; opens `.brd/.srf/.kms/.pbd` **[Reported]** | Industry standard. The Warehouse has >10,000 user boards; licence is per board (some CC-BY-NC); 3D exports sold at ~12 € each **[Reported]** |
| **AKU Shaper** | Free demo mode (measurements, volume); paid full version; new version May 2024 ([swaylocks](https://swaylocks.com/demo-akushaper-for-free)) **[Vendor claim]**. Saved files are "coded" so Shape3d can no longer read them ([swaylocks forum](https://forum.swaylocks.com/t/aku-and-the-man-in-the-street/31796)) **[Reported]** | proprietary | Reject for pipeline use: closed format |
| [Kipre/tinyshaper](https://github.com/Kipre/tinyshaper) | **No licence** (all rights reserved); last commit 2024-10-19 **[Verified]** | `board.json`: cubic Bezier outline, deck and bottom curves, normalised 0..1 **[Verified]** | Idea only: **cosine-spaced slices** `(1−cos(πi/(n−1)))/2` for tip density **[Verified]** |
| [Mtcc/surfboard-cad](https://github.com/Mtcc/surfboard-cad) | **No licence**; React/three; last commit 2026-07-09 **[Verified]** | Parametric templates (N12/T12, wide point, rocker, concave depths) **[Verified]** | Shows the parameter set works. Can't reuse code. |
| [okalex/webshaper](https://github.com/okalex/webshaper) | 2014 p5.js sketch **[Verified]** | — | None |
| [Surf-Shaper](https://www.github.com/Jurajzovinec/Surf-Shaper) | Onshape parametric model → glTF → three.js **[Reported]** | — | Rejected: cloud CAD dependency |
| Board Design Co BRD files on Sketchfab Store ([listing](https://sketchfab.com/3d-models/one-board-quiver-surfboard-a63fe498667248d5930e5d2ba2014c44)) | Paid; "guarantees these files will allow you to make your own surfboard", other uses "encouraged but not guaranteed" **[Verified]** | `.brd` (BoardCAD format) | **Best real-shaper validation target** (5′6″×19¾×2⅜, 28.5 L, single concave → double at the fins) |

I found no maintained open parametric surfboard generator for Blender, OpenSCAD or three.js with a permissive licence. The `gh search repos` queries for "surfboard cad", "surfboard shaping", "surfboard blender", "surfboard openscad", "surfboard three.js" and "boardcad" found only the repos above. **[Verified]**

### 2.1 BoardCAD geometry model (read from code)

- **Board** (`board/BezierBoard.java`):
  - three 2D Bezier splines: **outline** (half-width vs x, `p32`), **bottom/rocker** (`p33`) and **deck** (`p34`);
  - a list of **cross-sections** (`p35`), each a 2D Bezier spline at a station;
  - internal units are **cm**; `FOOT = 30.48`. **[Verified]**
- **Surface evaluation** (`getInterpolatedCrossSection(x)`):
  1. find the two neighbouring slices;
  2. linearly interpolate them;
  3. **scale** the result to the local width (`2·outline(x)`) and thickness (`deck(x) − bottom(x)`);
  4. add `rocker(x)` to z.

  Points on the section are addressed by a parameter `s`, and deck vs bottom are separated by **tangent angle** (deck −90°..90°, bottom 90°..270°). Normals come from finite differences. Volume is the integral of section areas. **[Verified]** (`BezierBoardControlPointInterpolationSurfaceModel.java`)
- **`.brd` format.** Line-based `pNN : value` records:
  - p1 length, p3 thickness, p4 width, p5/p6 nose and tail rocker, p39/p40 one-foot rockers, p45 designer, p50 fins, p51 fin type, p32–p35 curves;
  - plus many CAM fields;
  - fins are a 9-double array: back and front x/y of the side fin, back and front of the centre, depths, splay;
  - encrypted variants use a key hard-coded in the reader. **[Verified]**
- **`.s3dx` format.** XML root `Shape3d_design/Board`:
  - `curveDefTop2` = outline, `curveDefSide0` = bottom, `curveDefSide4` = deck;
  - slices are `Couples_i`, each `Bezier3d` with `Control_points`/`Tangents_1`/`Tangents_2`;
  - a `Protection` flag blocks import. **[Verified]** (from `S3dxReader.java`)

**Assessment.** Ours should be a superset of this model: three longitudinal curves plus normalised cross-sections scaled to local width and thickness. It is simple, shaper-native and cheap to evaluate. BoardCAD's linear blend between hand-drawn slices is fine for CAM, but it gives slope discontinuities between slices that show up in glossy reflections. For rendering, interpolate *parameters* of an analytic section smoothly along the board (C¹/C² splines) rather than blending point sets.

---

## 3. Existing 3D models (quality benchmark)

| Source / model | Type | Tris | Price | Licence | Notes | Status |
|---|---|---|---|---|---|---|
| Sketchfab / Fab: [Studio Lab "Surfboard"](https://sketchfab.com/3d-models/surfboard-d59704245f6545028e5002d0da0ba46b) | generic shortboard-ish | ~5k (2,683 polys / 2,555 verts) | Fab (price not shown) | Fab standard licence; **NoAI** | PBR, "clean topology", non-overlapping UVs, .blend; type, fins and plug unspecified | **[Verified]** page metadata |
| Sketchfab / Fab: [FrancescoMilanese "Surfboard"](https://sketchfab.com/3d-models/surfboard-463dcb0244c148b8a254f9327f384828) | ? | 36.2k | Fab | "Royalty free" | Textured in Substance Painter | **[Verified]** |
| Sketchfab: [nomadssurfing "Shortboard Evo"](https://sketchfab.com/3d-models/shortboard-evo-3cee7547fe9a4f6a8c8e2cb735e1752d) and [series](https://sketchfab.com/nomadssurfing) (Fish Pacifico, Longboard Basuangua, Mini Malibu…) | shortboard; set covers types | 12.7k | not for sale (one "Kudat" downloadable) | not stated | A surf school's board line: probably close to real shapes | **[Verified]** |
| Sketchfab Store: [Board Design Co "One Board Quiver"](https://sketchfab.com/3d-models/one-board-quiver-surfboard-a63fe498667248d5930e5d2ba2014c44) | shortboard | 128.9k (viewer mesh) | paid | "make your own surfboard" | Ships a **.brd**: real shaper geometry, ideal validation reference | **[Verified]** |
| TurboSquid [2425087](https://www.turbosquid.com/3d-models/shortboard-surfboard-3d-model-with-6-custom-designs-included-3d-model-2425087) / [CGTrader twin](https://www.cgtrader.com/3d-models/sports/equipment/shortboard-surfboard-with-6-custom-designs-included) | thruster shortboard, 6 graphics | low-poly | $19 | royalty-free | 4K PBR, fins + leash plug modelled; Blender/Maya | **[Reported]** |
| CGTrader [surfboard set](https://www.cgtrader.com/3d-models/sports/equipment/surfboard-set-3d-model) | funboard, fish, shortboard, longboard | ? | ? | royalty-free | "real world dimensions", fins, leash plug, 4K PBR | **[Reported]** |
| CGTrader [fishboard ×6 graphics](https://www.cgtrader.com/3d-models/sports/equipment/fishboard-surfboard-with-6-graphic-design-variants) | fish | ? | ? | royalty-free | detailed fins | **[Reported]** |
| CGTrader [O'Shea Fish Drive Master 6′0″ (free)](https://cgtrader.com/free-3d-models/sports/equipment/o-shea-fish-drive-master-6-0-surfboard-composite), [Guppy 5′10″](https://cgtrader.com/3d-models/animals/fish/o-shea-guppy-fish-5-10-surfboard-composite) | fish (branded) | ? | free / paid | CGTrader licences | Possibly designer data; check trademark | **[Reported]** |
| Superhive (Blender Market) [PBR surfboard](https://blendermarket.com/products/pbr-surfboard) | generic | ~2.6k polys | $9 single / $29 commercial | royalty-free | | **[Reported]** |
| Fab listings ([1](https://www.fab.com/listings/3f0fcbf2-d523-473c-8077-587255c12b9e), [2](https://fab.com/listings/c44f224d-2928-425d-9d6f-934cf5bdd7da), [3](https://fab.com/listings/5464204b-1d85-4a1f-ba1c-6173d22972d6)) | beach prop / miniature / high-poly (~229k tris, GLB/USDZ) | — | ? | Fab | Mapping of the 229k figure to a specific listing unconfirmed | **[Reported]** |
| [BlenderKit](https://www.blenderkit.com/asset-gallery-detail/7165cd5c-d931-4e91-9da4-bf0700e2bedb/) | SUP only found | — | — | — | No surfboard found | **[Reported]** |
| Poly Haven | — | — | — | CC0 | No surfboard known; not verified (search budget exhausted) | **[Assessment]** |

**Assessment of the benchmark.**

- The "realistic" marketplace boards are 2.6k–36k tris with 4K PBR. That polycount is fine for us, but proportion fidelity is the weak point. Generalist modellers typically get these wrong:
  - uniform thickness with no foil;
  - round, symmetric rails everywhere (no tuck or hard tail edge);
  - no concave or vee;
  - flat or banana rocker;
  - oversized, thick fins;
  - a missing pad kick;
  - toy-like saturated graphics.
- None ships stance anchors, rail lines or buoyancy data.
- The bar to beat is the visual quality of the 4K PBR texture sets, not the meshes. We should buy **one** high-rated model (e.g. TurboSquid 2425087, $19) and **one** Board Design Co `.brd` as benchmarks for an A/B render inside ShoreBreak (Experiment 1). Do not buy them as production assets.
- **Before buying, check:** Fab/TurboSquid/CGTrader licence terms for real-time web delivery (asset extraction from a GLB served to browsers), and the NoAI flags.

---

## 4. Procedural generation approach

### 4.1 Board frame and parameterisation

- **Frame** (glTF-native, matches ShoreBreak's metres and y-up):
  - **+Z = toward nose**, **+Y = deck up**, **+X = left rail** (seen from the tail looking at the nose; right-handed);
  - **origin** = on the stringer, on the **rocker-table plane** (the flat plane the bottom rests on when shapers measure rocker), at the midpoint of tip-to-tip length.

  So `z_tail = −L/2`, `z_nose = +L/2`, and nose rocker = bottom height at `z_nose`.
- **Parameters:**
  - `u ∈ [0,1]`: station, tail → nose;
  - `side ∈ {L,R}`;
  - `s ∈ [0,1]`: arc-length parameter around the half-section: bottom stringer (0) → bottom edge → rail apex → deck shoulder → deck stringer (1).

### 4.2 Longitudinal curves (all C² unless a feature asks for a corner)

All curves are functions of `u`, built from **monotone cubic Hermite (Fritsch–Carlson) splines through shaper-meaningful knots**. This is easier to drive from spec numbers than free Bezier handles, and cannot overshoot.

| Curve | Knots (from spec) | Notes |
|---|---|---|
| **Outline** `w(u)` (half-width) | tail block (tail width at tip), T12, wide point (pos, W/2), N12, nose-tip radius | Tail types change the tail end: **squash** = finite tail block + corner radius; **round** = block → 0 with circular end; **pin** = tangent → 0 with small tip radius; **swallow** = an inner boundary `w_in(u)` > 0 for `u < u_notch` (each half becomes a lobe); **wings/bumps** = C⁰ knots |
| **Rocker** `r(u)` (bottom at stringer) | tail tip, tail 1-ft, apex (pos ≈ 0.45–0.55 from tail, value 0), nose 1-ft, nose tip | Optional "entry/exit" tension. Shapers think in tip plus 1-ft numbers, so use exactly those. |
| **Foil** `t(u)` (thickness) | tail tip, T12 thickness, max thickness (pos, T), N12 thickness, nose tip | Deck curve = `r(u) + t(u)` |
| **Rail apex ratio** `a(u)` | nose (~0.45–0.5), mid (~0.3–0.4), tail (~0.15–0.25) | Height of the max-width point as a fraction of local thickness; 50/50 = 0.5, "down rail" = low |
| **Rail fullness** `p(u)` | 2.0 soft/thin … 3.5 boxy | Superellipse exponent of the rail band |
| **Bottom edge radius** `e(u)` | ~8–12 mm nose → 1–2 mm in the last 30–40% (hard edge) | Rendered as a tight rounded corner, not a mesh crease |
| **Deck dome** `d(u)` | 0 flat … 1 domed | Crown of the deck section |
| **Contours** | list of zones `{type: single/double/vee/belly/channels, uStart, uEnd, depth(u), width}` | Smooth fades in and out |

### 4.3 Cross-section at station u (analytic)

Half-section in local (x ≥ 0 lateral, y up), with `W = w(u)` and `T = t(u)`:

- **Bottom** `y_b(x) = r(u) + C(u, x/W)`, where C is the contour depth profile:
  - single concave: `−D·(1−(x/W_c)²)` inside the concave width;
  - double: two lobes either side of a centre "spine";
  - vee: `+V·(1−x/W)` (the stringer sits lower).

  The bottom edge rolls up into the rail with radius `e(u)`.
- **Deck** `y_d(x) = r(u) + T·[1 − dome·(x/W)^k]` across the deck flat, blending into the rail shoulder.
- **Rail band** (outer ~15–25% of the half-width): a **superellipse quadrant pair** joins bottom edge → apex at height `a·T` → deck shoulder, with exponent `p(u)`. Different exponents above and below the apex give a "down rail" (tight lower curve) vs "50/50".
- **Sampling.** Sample the closed half-profile by **arc length** into M points. Use a fixed distribution with more points in the rail band, because that is where silhouettes and highlights live.

  This makes each `s` value mean the same thing at every station, so `s` lines are continuous along the board. That is what lap lines and UVs need.

**Assessment.** This section model needs ~8 numbers per station, all smooth in `u`, so every reflection on a glossy hull is continuous. That matters more for visual believability than CAD-level freedom.

### 4.4 Mesh construction

- **Grid.**
  - **N stations, cosine-spaced** toward both tips (from tinyshaper), so nose and tail curvature stay smooth.
  - × **M section points** per half; mirror for the other half.
  - At the tips the outline goes to zero: use a pole fan with averaged analytic normals, or end the grid at a small tip radius and close it with a hemispherical cap patch.
  - Swallow tails use the inner boundary: each lobe is its own quad sheet, and the notch wall is a strip that joins the deck and bottom of the inner edge.
- **Normals** come from analytic derivatives (∂P/∂u × ∂P/∂s), not vertex averaging. That avoids seams on the mirror line and faceting in reflections. Tangents come from ∂P/∂u (for anisotropic sanding scratches later).
- **Quad-dominant** by construction: a clean grid, ideal for Blender painting.
- **Suggested resolutions [Assessment]:**

  | LOD | N × M (both halves) | ≈ tris | Use |
  |---|---|---|---|
  | LOD0 | 128 × 2·40 | ~20k | Hero board in the chase camera |
  | LOD1 | 64 × 2·20 | ~5k | Mid distance |
  | LOD2 | 24 × 2·8 | ~0.8k | Far, shadows, reflections |

  JS generation of LOD0 should take ≈ a couple of ms (my estimate, not yet measured; see Experiment 1). With a single hero board, LODs mostly serve shadow passes and distant boards (other surfers, beach props).
- **Fins** are separate meshes:
  - outline template (base, depth, rake, tip radius) as a 2D Bezier;
  - lofted through **foil sections** (NACA-00xx-like symmetric for the centre; flat-inside or 80/20 for the sides), with thickness tapering toward the tip;
  - a rounded tip cap;
  - ~200–600 tris each.

  Fin origin is the base trailing edge on the bottom surface, with local +Y along the span; place it with toe and cant. three.js `LoftGeometry` (present in **r186 and r187** `examples/jsm/geometries/LoftGeometry.js` **[Verified]**) can skin the foil sections. Our own builder gives the same with custom attributes.
- **Traction pad.** A generated mesh: three pieces conforming to the deck (offset along the deck normal by 4–6 mm), arch and kick wedge (25 mm) on the tail piece, a bevelled edge. The diamond grooves come from a normal map.
- **Leash plug.** A small cup ring decal plus a recessed disk mesh (~32 tris). The rail saver and cord are separate (§5.9).

### 4.5 UVs and vertex attributes

- **UV0 (graphics / paint).** Deck and bottom each get a **planform projection** (z → U, x → V, with V scaled so the texel density matches U).
  - They are packed as two horizontal strips in a 4096×2048 atlas: deck strip on top, bottom strip below, rail band split at the rail apex. With fixed real-world scale (e.g. 1 px ≈ 0.6 mm at 4K over 2.8 m), one atlas layout serves every board length up to the longest.
  - Shorter boards just use part of the strip, so graphics are authored in **real-world mm**, independent of board size.
- **UV1 or custom attribute `aSection` (s, u).** The section arc parameter. It lets shaders draw **lap lines, pinlines and resin-tint wrap** as `s` thresholds (e.g. bottom tint up to `s = s_apex + lap`), plus rail wear/dirt masks, with no texture seams.
- **`aThickness`** (local through-thickness along the normal, in metres) feeds the translucency approximation (§5.4). Free from the generator.
- **`aRail`** (distance to the rail apex, normalised) feeds rail spray masks, wear, and wet-band darkening.

### 4.6 Build time vs runtime

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Blender / bpy or Geometry Nodes → GLB | Artist-friendly; Blender is ready for painting | Kernel in Python/GN; can't answer runtime queries without duplicating it in TS; `bpy` 5.3.0 on PyPI exists **[Verified]**, but that is a heavy build dependency | Reject as the kernel; use Blender only for painting/baking on generated GLBs |
| Node script → GLB (same TS kernel) | Deterministic assets, LODs, KTX2 textures, anchors as glTF nodes; artists can paint on the GLB | Spec changes need a rebuild (seconds) | **Yes**, for the visual meshes |
| Runtime three.js generation | Variants on the fly (quiver per surfer, damage morphs); analytic queries available | Artists can't hand-tune that mesh; textures still need fixed UVs | **Yes**, for queries; optional for mesh variants |

**Recommendation: hybrid with a single source of truth.**

- One `boardkit` TypeScript package (ours, permissive licence) contains `BoardSpec → evaluate(u, s) → mesh + anchors`.
- **Build time:** Node runs `boardkit` and writes `board_<id>.glb` with LODs, materials and texture slots, anchor empties, and `extras.bluecurl.board` (the spec plus derived data). Use `three/examples/jsm/exporters/GLTFExporter` or `@gltf-transform/core` 4.5.1 **[Verified]** (npm).
- **Run time:** the game loads the GLB and creates `boardkit.Board(spec)` from the extras, for deck and bottom queries, stance solving and rail lines. Because the code is the same, both paths stay consistent.

### 4.7 Volume calibration (mini-experiment, done)

The prototype is a throw-away Python script in my scratch directory, not committed. It has a monotone Hermite outline through tail block / T12 / wide point / N12 / tip, a similar foil curve, and section area = `k_s · width · thickness`. With **k_s ≈ 0.88** it reproduces published volumes within about ±4%. **[Verified]** (my computation against the published specs above)

| Board (published) | Model | Published | Box coefficient V/(LWT) |
|---|---|---|---|
| 6′0″×18¾×2⅜ shortboard | 27.7 L | 28.5 L | 0.54 |
| 5′6″×19¾×2.4 RNF fish | 28.3 L | 29.5 L | 0.58 |
| 7′6″×21¾×2⅞ CI Mid | 52.9 L | 51.8 L | 0.56 |
| 9′6″×21¼×3⅝ Padillac | 76.5 L | 75.4 L | 0.52 |

**Implication.** The generator should treat **target volume as a constraint**: solve one scalar (rail fullness/dome scale) by bisection so the spec's litres are met. Published L×W×T plus litres then pins down a believable shape.

### 4.8 Recommended BoardSpec parameter set

Authoring is in inches/litres, as shapers publish; storage is in metres.

```jsonc
{
  "schema": "bluecurl.boardspec/1",
  "id": "sb_6-0_thruster_a", "type": "shortboard",          // shortboard|fish|mid|longboard|stepup|gun
  "dims":   { "length": 1.829, "width": 0.4763, "thickness": 0.0603, "volumeL": 28.5 },
  "outline":{ "noseWidth12": 0.292, "tailWidth12": 0.356, "widePointFromCentre": -0.02,
              "noseTipRadius": 0.010, "noseShape": "pointed",          // pointed|round|beak
              "tail": { "type": "squash", "blockWidth": 0.23, "cornerRadius": 0.010,
                        "swallowDepth": 0.0, "wings": [] } },
  "rocker": { "nose": 0.127, "nose12": 0.048, "tail": 0.057, "tail12": 0.024, "apexFromCentre": -0.05 },
  "foil":   { "noseThick12": 0.037, "tailThick12": 0.036, "maxThickFromCentre": 0.0,
              "noseTipThick": 0.012, "tailTipThick": 0.018 },
  "deck":   { "dome": [ [0,0.2], [0.5,0.45], [1,0.3] ] },              // (u, value) knots
  "rails":  { "apexRatio": [ [0,0.22],[0.5,0.32],[1,0.45] ],
              "fullness":  [ [0,2.6],[0.5,2.8],[1,2.3] ],
              "edgeRadius":[ [0,0.0015],[0.35,0.002],[0.6,0.006],[1,0.010] ] },
  "bottom": { "contours": [
              { "type": "single", "u0": 0.30, "u1": 0.85, "depth": 0.004, "width": 0.75 },
              { "type": "double", "u0": 0.0,  "u1": 0.30, "depth": 0.003, "width": 0.80 },
              { "type": "vee",    "u0": 0.0,  "u1": 0.12, "depth": 0.002 } ],
              "noseBelly": 0.0015 },
  "fins":   { "setup": "thruster", "system": "FCS2", "list": [
              { "id": "L1", "fromTail": 0.286, "fromRail": 0.029, "toeDeg": 3, "cantDeg": 6, "template": "M_side" },
              { "id": "R1", "fromTail": 0.286, "fromRail": 0.029, "toeDeg": 3, "cantDeg": 6, "template": "M_side" },
              { "id": "C",  "fromTail": 0.085, "offset": 0.0,    "toeDeg": 0, "cantDeg": 0, "template": "M_centre" } ] },
  "plug":   { "fromTail": 0.10, "offset": 0.0 },
  "pad":    { "model": "3piece_diamond", "fromTail": 0.015, "kick": 0.025, "arch": 0.007 },
  "stringer": { "width": 0.003, "wood": "basswood" },
  "finish": { "resin": "PU_poly", "surface": "sanded", "tint": null, "lap": 0.032, "pinline": null,
              "graphicsSet": "gfx_01" },
  "wear":   { "ageYears": 0.5, "yellowing": 0.15, "heelDents": 0.6, "dings": 0.2 }
}
```

---

## 5. Materials in three.js (MeshPhysicalMaterial)

three.js r187 `MeshPhysicalMaterial` has clearcoat (+ roughness, normal maps), sheen, transmission/thickness/attenuation, iridescence, anisotropy, dispersion and specularIntensity. **[Verified]** (`src/materials/MeshPhysicalMaterial.js`) ShoreBreak is on r186. Our board material must render into its HDR scene-linear buffer and tone mapping, so use standard lit materials plus `onBeforeCompile` injections, not post effects. **[Assessment]**

### 5.1 Hull (foam + laminate) base values [Assessment, to tune in Experiment 1]

| Finish | color | roughness (base) | clearcoat | clearcoatRoughness | ior | Notes |
|---|---|---|---|---|---|---|
| Gloss & polish (PU/poly) | foam white sRGB ~(0.93,0.92,0.88) | 0.45 | 1.0 | 0.02–0.05 | 1.55 | Longboards, retro fish |
| Sanded (PU/poly) | same | 0.45 | 1.0 | **0.25–0.4** + fine anisotropic scratch normal | 1.55 | **Most pro shortboards**: a softer, satin highlight. Getting this right is a big cue. |
| Epoxy / EPS | slightly cooler white, faint bead pattern in albedo/translucency | 0.4 | 1.0 | 0.05–0.3 | 1.55 | Bead texture shows only when backlit |
| Resin tint | tint in base color; clearcoat stays clear | — | 1.0 | as finish | | Masked by `s` lap threshold |
| Opaque / pigment | pigment colour, foam translucency off | | | | | |
| Spray / airbrush | in base colour texture, under the clearcoat | | | | | Soft edges, overspray |

- **Yellowing.** PU blanks yellow with UV exposure. Drive it with `wear.yellowing` as an albedo multiply, stronger on deck and tail. **[Assessment]**

### 5.2 Graphics and logos

Graphics are authored in the UV0 planform atlas at real-world mm, sitting *under* the clearcoat (glassed-in laminates). Do not use `DecalGeometry` (present in r187 **[Verified]**) for static graphics, because we own clean UVs. Keep runtime decals only for dynamic damage if ever needed. Logos must be fictional, not real brands, so we never imitate real brand marks. **[Assessment]**

### 5.3 Stringer

Draw the stringer in the albedo as a 3 mm line (a slightly translucent, warm wood colour). Also cut it out of the translucency mask, because wood blocks backlight: the dark line in a backlit board is a strong cue. **[Assessment]**

### 5.4 Foam translucency against the sun (cheap)

PU foam glows warm when backlit, especially through thin nose and tail rails. This is a hallmark of surf photography when the board is in the lip. **[Assessment]**

- **Do not use** `transmission`. It adds a transmission render pass, gives a glassy refraction look rather than scattering, and risks clashing with ShoreBreak's custom pipeline. **[Assessment]**
- **Use** a Barré-Brisebois style translucency term. This is the same technique as three's `SubsurfaceScatteringShader` example (present in r186/r187 **[Verified]**, GDC 2011 reference in its header). Inject it into the physical material via `onBeforeCompile`:

  ```glsl
  float trans = pow(saturate(dot(V, -(L + N*distort))), power) * scale;
  trans *= exp(-sigma * aThickness) * transMask;          // aThickness from generator, mask removes stringer/pigment/pad
  outgoingLight += sunColor * foamTint * trans;            // foamTint warm (1.0,0.85,0.6)
  ```

  It costs a few ALU per pixel and needs no extra pass. A thicker centre stays dark and the thin rails glow, which is physically plausible.

### 5.5 Wax

- **Layer:** a mask texture (painted per board in deck UV) × a tiling wax-bump normal map (base coat plus top-coat bumps).
- **Look:** roughness 0.7–0.85, clearcoat 0 in waxed areas (wax kills the gloss), albedo slight off-white or tinted (tropical wax colours), dirt accumulation.
- **When wet:** roughness drops to ~0.35 and gets a faint specular sheen.

The normal map can be generated procedurally (Poisson-disk bumps plus cross-hatch strokes) and baked once. **[Assessment]**

### 5.6 Traction pad

- EVA: roughness 0.85–0.95, no clearcoat, `sheen` 0.2 for a soft fuzz.
- Tileable groove normal and AO: diamond (most common), micro-dot or grid, with per-piece UVs aligned to the groove direction.
- Colours: black is most common (dark, so check exposure). When wet, darken albedo by ~15% and reduce roughness slightly. **[Assessment]**

### 5.7 Wetness and water film

- A per-board uniform `wet ∈ [0,1]` driven by state: dry on the beach, wet after paddling, drip-out time.
- Effects: darken porous parts (wax, pad, leash); hull clearcoat roughness slightly up for water-film breakup, plus a scrolling droplet/rivulet normal on the clearcoat normal, masked by the deck slope (water runs off the domed deck toward the rails).
- **Bottom:** always wet while riding, so it is a glossy film. **[Assessment]**

### 5.8 Wear: dents, dings, discolouration

- **Heel and pressure dents.** Clusters of shallow (0.5–2 mm) depressions under the back-foot heel or forward of the pad and under the front foot. Shown via the **clearcoat normal map** (dents show as wobbles in reflections) plus a slight AO.
  - Placement comes from the stance anchors (§6), so dents sit exactly under the feet.
  - Toe-side vs heel-side pattern follows regular vs goofy.
  - Rear-chase viewers see the deck constantly, so this is high value.
- **Rail dings and repairs.** Sanded-patch roughness, yellowed resin repairs.
- **Nose and tail wear.** Slightly dull clearcoat.
- **Sources:** procedural masks in UV space from the generator (anchor positions plus the `aRail` attribute), finished by hand in Blender/Substance on the build-time GLB. **[Assessment]**

### 5.9 Leash

- **Parts:**
  - cuff (ankle strap, ~5 cm wide, neoprene/velcro; a simple mesh with the swivel);
  - urethane cord ~6–8 mm diameter, length ≈ board length, a slightly translucent coloured material;
  - rail-saver strap (webbing, ~10 cm) plus the plug string loop (~1.5″).
- **Simulation:** **verlet chain**, 16–24 points with distance constraints, gravity, a water drag term below the surface (heavy damping) and a buoyancy floor. Collision against the board use simple capsules/planes, plus the ankle.
  - Render as a `TubeGeometry`-style ribbon rebuilt each frame (≤ 24 × 8 verts) or a skinned tube.
  - Pin the ends at `ANC_leash_railsaver` and the back-ankle bone.
- Optional coiled segment near the cuff via a static coil mesh. **[Assessment]**

---

## 6. Attachment interface for the character animation system

### 6.1 Principles

- Every anchor is a **frame** (position plus orientation), in the board frame of §4.1.
- **Static anchors** are baked into the GLB as named empty nodes, computed for a reference surfer (height 1.78 m) so artists and the animation team can inspect them in Blender.
- **Dynamic anchors** come from the runtime `boardkit` API as functions of surfer height, stance, phase and board spec. They are authoritative at runtime, because the deck is curved and stance varies.
- three.js's `GLTFLoader` copies node `extras` into `object.userData` (`assignExtrasToUserData`), and `GLTFExporter` writes `userData` back to extras. **[Verified]** (r187 source) So the schema survives both directions.

### 6.2 glTF node naming convention

```
BOARD_<id>                      root node; extras.bluecurl = { schema, spec, derived, lines }
├─ MESH_hull_LOD0/1/2           hull (single mesh, materials: hull)
├─ MESH_fin_<finId>             one per fin, origin at base trailing edge, +Y along span (out of bottom)
├─ MESH_pad                     traction pad (tail), MESH_pad_front optional
├─ MESH_plug                    leash plug cup
├─ ANC_tip_nose / ANC_tip_tail  tip points; +Z along local tangent of rocker
├─ ANC_foot_back_regular        +Y = deck normal at point, +Z = heel→toe direction of the foot
├─ ANC_foot_front_regular
├─ ANC_foot_back_goofy
├─ ANC_foot_front_goofy
├─ ANC_hand_popup_L / _R        flat-palm deck contact for pop-up (on deck, +Y deck normal)
├─ ANC_hand_rail_L / _R         rail-grab points (at rail apex, +Y outward rail normal)
├─ ANC_chest_paddle             sternum contact for prone paddling (deck surface)
├─ ANC_hips_paddle              pelvis contact for prone paddling
├─ ANC_leash_plug               plug centre (deck surface)
├─ ANC_leash_railsaver          where cord attaches (≈ 3 cm behind plug, above deck)
├─ ANC_fin_<finId>_tip          fin tip (spray emitter / ventilation)
├─ ANC_fin_<finId>_trail        fin base trailing edge
├─ ANC_pivot                    turning pivot (centre of lateral resistance of fins, on bottom)
├─ ANC_cob                      centre of buoyancy (volume centroid)
├─ ANC_com                      board centre of mass (≈ cob, slightly aft with fins)
└─ ANC_contact_bottom_center    lowest bottom point (rocker apex) for waterline queries
```

Orientation convention for all `ANC_*`: local **+Y = surface normal** (outward), local **+Z = "forward" meaning of the anchor** (for feet: heel→toe; for others: toward the nose), +X completes the right-handed frame.

### 6.3 extras schema (root node)

```jsonc
"extras": { "bluecurl": {
  "schema": "bluecurl.board/1",
  "units": "m", "frame": { "forward": "+Z", "up": "+Y", "left": "+X", "origin": "rocker-table plane, stringer, mid-length" },
  "spec": { /* BoardSpec §4.8 */ },
  "derived": {
    "volumeL": 28.4, "massKg": 2.7, "cob": [0, 0.028, -0.06], "com": [0, 0.030, -0.09],
    "lengthOverCurve": 1.86, "tipNose": [0, 0.127, 0.9145], "tipTail": [0, 0.057, -0.9145],
    "referenceSurfer": { "height": 1.78 }
  },
  "lines": {                              // polylines in board frame, K samples, same u for all
    "u":            [/* K values tail→nose */],
    "railApexL":    [[x,y,z], ...], "railApexR": [...],     // max-width line: rail engagement, spray
    "bottomEdgeL":  [...],            "bottomEdgeR": [...],   // release edge: water separation
    "deckShoulderL":[...],            "deckShoulderR": [...], // deck/rail transition: hand grabs, wax edge
    "stringerDeck": [...],            "stringerBottom": [...]
  },
  "zones": {                              // u-ranges on the deck (for contacts / wax / dents)
    "pad": [0.0, 0.17], "backFoot": [0.10, 0.22], "frontFoot": [0.38, 0.58],
    "chestPaddle": [0.55, 0.72], "handPopup": [0.50, 0.65]
  },
  "fins": [ { "id": "L1", "trail": [x,y,z], "tip": [x,y,z], "areaM2": 0.0097, "cantDeg": 6, "toeDeg": 3 } ]
}}
```

Per-anchor node extras, e.g. on `ANC_foot_back_regular`:

```jsonc
{ "bluecurl": { "role": "foot", "foot": "back", "stance": "regular",
                "patch": { "length": 0.27, "width": 0.10 },   // sole footprint for IK contact sampling
                "angleToStringerDeg": 80, "uRange": [0.10, 0.22] } }
```

### 6.4 Runtime API (`boardkit`) used by animation

```ts
board.deckFrame(z: number, x: number): { p: Vec3, n: Vec3 }          // exact deck point+normal (curved deck)
board.bottomFrame(z, x), board.railPoint(z, side, t /*0 bottom edge..1 shoulder*/)
board.footPatchContacts(anchor, sole: {heel:Vec2, ballMed:Vec2, ballLat:Vec2}) // 3 deck heights for foot IK
board.stance(opts: { surferHeight: number, stance: 'regular'|'goofy',
                     mode: 'ride'|'popupLand'|'trim'|'noseride'|'paddle' }): AnchorSet
board.waterline(planeInBoardFrame) -> { wettedRailL: [u0,u1], wettedRailR: [...], wettedArea }
board.finWorldPoints(), board.cob(), board.pivot()
```

### 6.5 Stance and contact rules (defaults; tuning targets for mocap/animation) [Assessment unless noted]

Let `H` be surfer height and `z_t = −L/2` the tail.

- **Facing and side.**
  - **Regular**: left foot forward, toes point to the **right rail (−X)**, which is the toe-side rail.
  - **Goofy**: right foot forward, toes point to **+X**.
  - Feet are centred over the stringer, offset ≤ 2 cm toward the heel side ([naturalnecessity](https://www.naturalnecessity.com.au/blogs/news/your-guide-to-the-perfect-surfing-stance), **[Reported]**).
- **Stance width** (foot centre to foot centre): `w_s = 0.31·H` (range 0.28–0.35·H), i.e. shoulder width to slightly wider ([barefootsurftravel](https://barefootsurftravel.com/?p=9345), **[Reported]** for the qualitative rule; the coefficient is **[Assessment]**).
- **Back foot (ride)** centre at:
  - thruster/quad/twin: `z_t + max(frontFinTrail + 0.01, pad.fromTail + 0.12)`. For a 6′0″ that is ≈ 0.28–0.30 m from the tail, so the ball of the foot sits on the pad arch/kick and the foot is over the fins;
  - single fin / longboard: `z_t + 0.30·L` for trim, and `z_t + fin.fromTail + 0.10` for turning (step-back mode);
  - foot angle to stringer 70–90°.
- **Front foot:** `z_back + w_s`, angle 30–50°, toes forward. Clamp so it stays behind the wide point plus 0.1 m on shortboards.
- **Pop-up landing (`popupLand`):** the back foot often lands 5–10 cm forward of its ride position and shuffles back within ~0.5–1 s. Expose this as a separate anchor set; the animation blends between them. Watching footage of the pop-up phase should confirm this.
- **Noseride (longboard):** the front foot track runs from `z_n − 0.45` to `z_n − 0.10` m, with the cross-step sequence driven by animation. Anchors become a **track** (u-range) rather than points.
- **Paddle (prone):**
  - Rider COM sits over the board CoB, about 2–5 cm aft, so the nose rides just clear of the water;
  - `z_hips = cob.z − 0.03`, `z_chest = z_hips + 0.19·H`, `z_chin ≈ z_hips + 0.34·H`;
  - toes ≈ `z_hips − 0.47·H`, which on shortboards hang just past the tail; that is correct.
- **Hand plants (pop-up):** `z = z_chest − 0.06`, `x = ±max(0.10, w(z) − 0.06)` on the deck. Rail-grab alternatives sit at the rail apex at the same z.
- **Leash:** cuff on the **back-foot ankle** (left for goofy, right for regular), cord anchored at `ANC_leash_railsaver`.
- **Fins (FX):** spray and bubble emitters at `ANC_fin_*_tip` and `_trail`; rail spray along `railApex` and `bottomEdge` where `waterline()` reports engagement. `ANC_pivot` = area-weighted centroid of the fin trailing points, used as the yaw pivot in hard turns.

---

## 7. Procedural vs professionally modelled

| Criterion | Procedural (our kernel + painted textures) | Bought model (marketplace) | Commissioned artist model per type |
|---|---|---|---|
| Shape fidelity | **High by construction** (shaper parameters, volume constraint, validated against .brd/STL) | Variable; frequently wrong foil/rails/rocker **[Assessment]** | High if briefed with spec sheets |
| Surface realism | Depends on texture work, same as others | 4K PBR sets of decent quality **[Reported]** | High |
| Variants (5 types × sizes × quiver) | Free | Buy per type; inconsistent styles | Costly per variant |
| Metadata (anchors, rails, CoB) | Exact, automatic, runtime-queryable | None, manual | Manual |
| UV consistency (shared graphics/wear) | Identical layout across all boards | Different per asset | Possible if specified |
| Licence risk | None (our code) | NoAI flags, web-delivery terms to verify | Contract |
| Effort [Assessment] | Kernel + fins + pad + exporter + anchors: **~2–3 dev-weeks**; materials and shaders: ~1–2 weeks; art texture sets ~1 week | Hours to buy, ~2–4 days per board to fix scale/UV and add anchors | ~1–2 weeks per type plus anchors |

**Recommendation: procedural geometry, hand-authored materials.**

- Buy one or two models plus a real `.brd` purely as benchmarks.
- The risk of procedural boards is a "too-perfect CG" look. Mitigate it with sanded-finish clearcoat roughness, lap lines, stringer, yellowing, heel dents, wax and wetness. These are material tasks either way.

---

## 8. Recommended pipeline

1. **`boardkit` (TypeScript, our licence):**
   - `BoardSpec` → longitudinal Hermite curves → analytic section → surface evaluation;
   - volume solve;
   - grid mesh (LODs), fins, pad, plug;
   - attributes `aSection`, `aThickness`, `aRail`;
   - anchors, lines, zones.
2. **Presets:** five type presets (shortboard 6′0″, fish 5′6″, mid 7′6″, longboard 9′4″, gun 9′6″) taken from published dims (§1.2), checked against volume (§4.7) and visually against a real `.brd` exported to STL with BoardCAD LE.
3. **Build:** a Node script writes `board_<id>.glb` with LODs, anchor empties and `extras.bluecurl`, and runs gltf-transform (meshopt/KTX2).
4. **Art:** in Blender (import GLB), paint graphics, wax masks, wear and dents on the fixed UV0 atlas; templates are generated with stance zones overlaid. Export texture sets only, since geometry stays generated.
5. **Runtime:**
   - load the GLB and build `boardkit.Board` from extras;
   - material = `MeshPhysicalMaterial` plus an `onBeforeCompile` chunk (translucency, lap/pinline from `aSection`, wetness, wax);
   - leash verlet;
   - anchors via `board.stance(...)`.
6. **Validation:** an A/B render against the purchased benchmark and against reference stills from pro footage under ShoreBreak's lighting; a volume check; foot-IK penetration test on the domed deck.

### Rejected alternatives (decision log)

| Alternative | Reason rejected |
|---|---|
| Port BoardCAD's Java geometry to TS | GPL (v2 per SourceForge, v3+ per LE About box; no LICENSE file in LE). A port would make our shipped bundle a derivative work. Its slice-blend model is also CAM-oriented, with C⁰ joins between slices that show in gloss. Use BoardCAD only as an external tool. |
| Shape3d / AKU as the authoring source | Proprietary. 3D export needs paid tiers (Shape3d Design Pro) or closed formats (AKU). Warehouse files carry per-board licences (often NC) and protection flags. |
| Bought marketplace models as production assets | Inconsistent proportions, fixed shapes, no metadata, licence uncertainty (NoAI, web delivery), different UV layouts per board. |
| Blender Geometry Nodes / bpy generator | Duplicates the kernel outside the runtime, so no analytic queries in the browser; an extra toolchain to maintain. |
| NURBS/CAD kernel (OpenCascade.js, Onshape as in Surf-Shaper) | Heavy WASM or cloud dependency; tessellation gives no visual gain over our analytic grid. |
| `transmission` for foam glow | Extra render pass, glassy (refractive) not scattering look, pipeline-integration risk with ShoreBreak's custom HDR chain. |
| `DecalGeometry` for graphics | We own clean UVs; decals add draw calls and seams. Kept only as an option for dynamic damage. |
| Photogrammetry scan of a real board | White gloss surfaces scan poorly without spray; fixed shape; no metadata. Useful only as a validation reference. |
| Physics-library rope for the leash | Overkill; a 20-point verlet chain is cheaper and controllable. |
| Unlicensed GitHub surfboard projects (tinyshaper, surfboard-cad) | No licence, so all rights reserved. Ideas only (cosine slice spacing, N12/T12 parameterisation). |

### Experiments (small, in order)

1. **Kernel fidelity A/B (≈3–4 days).**
   - Build: implement `boardkit` minimal (outline/rocker/foil/section, no swallow) for the 6′0″ shortboard and 9′4″ longboard.
   - Validate: (a) volume within ±3% of spec after the solve; (b) Hausdorff distance vs a BoardCAD-exported STL of a real `.brd` (the Board Design Co file, or a BoardCAD template) < 3 mm; (c) side-by-side renders in ShoreBreak lighting vs the $19 TurboSquid benchmark and pro-footage stills, judged blind by 3 people.
   - Measure: generation time for LOD0 in Chrome.
2. **Backlit foam and finish look (≈2 days).** Translucency `onBeforeCompile` chunk vs `transmission` vs none, with sanded vs gloss clearcoat, under ShoreBreak's sun at low elevation behind the board. Measure GPU ms on the target desktop and compare to reference photos of boards in the lip.
3. **Anchor/IK and leash (≈2–3 days).** Run the stance solver on the 6′0″ and 9′4″ for regular and goofy, with a placeholder rig. Check that foot soles sit on the domed deck (3-point contact, < 3 mm penetration), that hand plants land inside the rails, and that the paddle trim looks right. Also check that a 20-point verlet leash stays stable at 60 fps through a scripted wipeout.

---

## Key references

- BoardCAD LE: https://github.com/HavardNJ/boardcad-le (code read: `board/BezierBoard.java`, `board/readers/*`, `cadcore/*`)
- BoardCAD (SourceForge): https://sourceforge.net/projects/boardcad · boardcad-java: https://github.com/hornstein/boardcad-java
- Shape3d: https://shape3d.com/Products/Shape3dX.aspx · AKU demo: https://swaylocks.com/demo-akushaper-for-free
- tinyshaper: https://github.com/Kipre/tinyshaper · surfboard-cad: https://github.com/Mtcc/surfboard-cad
- three.js r187 (npm `three@0.187.0`): `LoftGeometry`, `DecalGeometry`, `SubsurfaceScatteringShader`, `MeshPhysicalMaterial`, `GLTFLoader.assignExtrasToUserData`
- Fin placement threads: https://forum.swaylocks.com/t/help-needed-with-thruster-fin-placement/38255, https://forum.swaylocks.com/t/fin-set-up-thruster/40718, https://forum.swaylocks.com/t/quad-fin-predicament/36226
- Rocker: https://forum.swaylocks.com/t/rocker-measurements/48722
- Benchmarks: Sketchfab models listed in §3; TurboSquid 2425087.
