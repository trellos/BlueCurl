# 08 — Art direction: three realistic proposals

Status: v1, 2026-11-19. Lead art direction document. The references are in
[01-visual-references.md](01-visual-references.md). The lighting and rendering feasibility
rests on [06-environments-and-lighting.md](06-environments-and-lighting.md).

## 1. Shared principles (all proposals)

These hold whichever proposal we pick. They come from studying real surf cinematography and
from the camera constraint: a continuous rear chase.

1. **The camera behaves like a real, physically present operator.** Think of a stabilised
   water-housing or jet-ski follow-cam. Starting spec (from [01 §2.2](01-visual-references.md)):
   - 4–7 m behind the surfer, stretching at speed and tightening in the barrel;
   - lens 1.6–2.5 m above the water, so the head never crosses the horizon; about 1 m for
     paddling;
   - 40–50° vertical FOV, with no fisheye;
   - horizon level, passing only 15–30% of board roll;
   - about 0.3–0.5 s yaw lag, which makes the camera swing wide in bottom turns and reveal the
     wave face.

   Note that real media has almost no *continuous* rear-chase footage: it combines follow-cam
   proximity with drone stability. Every surf game's camera complaint is the same: too close,
   can't read the wave.
   - No impossible moves: no instant re-framing, no orbiting during a turn, no game-style FOV
     punch.
   - Real follow-cam footage has water on the housing, occasional spray hits and slight bob.
     Use these as a *sparing* cinematic signature, never as a constant overlay.
2. **Read the body from behind.** At chase distance the surfer is mostly a silhouette with a
   lit back. What sells the shot is the **posture and weight**: stance width, knee flexion,
   shoulder line and arm carriage. The **back's specular response** matters too: wet skin or
   wet neoprene catching the sky. Faces barely matter. Spend modelling, texture and animation
   effort on the back, shoulders, glutes, hamstrings, calves, feet on the deck and the hands.
3. **Contact is the believability test.** Feet locked to a slightly dented, waxed deck; the
   board's rail line cutting the water; spray leaving the rail on the right frame; the
   surfer's shadow on the board. When contact is wrong, everything looks fake regardless of
   rendering quality.
4. **Light is mostly the sky and the sea, not the sun alone.** At sea the surfer is lit by:
   - the sun;
   - a huge sky dome;
   - a bright, moving water surface **from below**: sun glitter, foam and blue bounce.

   Uplight from the water on arms, chest and the board's bottom is one of the most
   recognisable cues in real footage, and the cheapest one to get right.
5. **Restraint in effects.** Spray, droplets and flares are used the way nature and a good
   lens produce them. No bloom bath, no stylised speed lines, no particle "juice".
6. **One coherent grade per location and time of day.** It's authored as a 3D LUT on top of a
   neutral filmic tone curve shared with the water renderer. Grades are art direction, not
   per-asset tweaks.
7. **Realism first, variety second.** All three proposals use the same assets, shaders and
   runtime. They differ in data: the location preset, sun and sky, wardrobe, grade and camera
   tuning.

## 2. Proposal A — "Tropical Clarity"

*Hawaii North Shore, Mentawai and Uluwatu-like reef breaks. Late morning or early
afternoon.*

| Aspect | Direction |
|---|---|
| **Emotional tone** | Freedom, vitality, joy, effortless mastery. The postcard you wish were your life. |
| **Lighting** | Sun at 35–55° elevation, ideally behind one of the camera's shoulders, so the surfer's back and the wave face are frontally lit. Avoid true noon (flat, game-like). Crisp shadows, saturated sky, bright blue bounce light from the water. |
| **Water** (water team) | Turquoise over reef, cobalt offshore, a luminous green-turquoise lip when the sun shines through it. Clean, glassy surface with light offshore texture. |
| **Colour grade** | Near-neutral filmic curve, slightly warm highlights, natural +5–10% saturation, cyan-blue shadows that are never crushed. Whites (foam) stay just below clipping. |
| **Camera** | Standard rig: 4 m behind, 1.5 m up, 35 mm. The horizon sits in the upper third. The wave wall fills one side of the frame. |
| **Environment** | Green volcanic ridges 1–3 km away with soft blue aerial perspective. Palm-fringed beach as a thin band. Cumulus building over the mountains. Indonesian variant: jungle islands, reef visible through the water, warmer and more humid haze. |
| **Character** | Shirtless, boardshorts, sun-tanned, wet hair. The hardest wardrobe for realism because the back skin and muscle deformation are fully exposed. A rash-vest option reduces risk. |
| **Hero moments** | The translucent barrel (Shot 5), spray backlit through the lip, drops falling from the lip into the frame. |
| **Real-time feasibility** | **Rendering cost low; believability risk highest.** One sun, one tight shadow map, sky IBL, water-bounce fill. Translucency of the lip is the water team's main investment. |
| **Main risk** | Midday clarity exposes every flaw: skin shading, deformation, contact. A clean bright look can slide into "video game" if the grade and sky are not carefully authored. |

## 3. Proposal B — "Golden Hour Cinematic"

*California-like point break below golden bluffs, distant houses on the cliff.
Late afternoon into sunset.*

| Aspect | Direction |
|---|---|
| **Emotional tone** | Beauty, reverie, mastery. "The last wave of the day". Most cinematic, most emotional. |
| **Lighting** | Sun at 3–15° elevation. Riding toward the sun: backlit spray, glowing rim light on hair, shoulders and the board's rails, the surfer's back in luminous shadow lit by the sky and the sea. Riding away from the sun: a warm, raking key light on the back with long shadows. The **constantly changing angle to the sun** is a gift: every turn changes the light. |
| **Water** | Gold specular path toward the sun, deep teal faces in shadow, warm-tinted foam. |
| **Colour grade** | Filmic (AgX-like) highlight roll-off, warm amber highlights, cool teal shadows, slightly lifted and soft. Gentle halation and bloom only on spray and specular sun path. Avoid "Instagram teal-orange": keep skin hues natural. |
| **Camera** | Same rig, sometimes a slightly longer-lens feel (40–50 mm, 5–6 m) to compress the backlit spray. Controlled lens flare when the sun is within about 15° of the frame. |
| **Environment** | Golden sandstone bluffs with coastal scrub, a few houses and a road as small lights and boxes (exploit distance), eucalyptus and cypress silhouettes, marine layer haze near the horizon. |
| **Character** | 2 mm spring suit or 3/2 full suit: black neoprene with a wet sheen. Rim light on wet hair and wetsuit edges reads beautifully. |
| **Hero moments** | Rooster-tail spray fan against the sun (Shot 2/3), silhouette re-entry, golden barrel exit. |
| **Real-time feasibility** | **Medium.** It needs: correct HDR handling and exposure that adapts as the camera turns into or away from the sun; spray particles with forward-scattering phase (cheap but must be authored); a good sky model at low sun (physical atmosphere); and rim/translucency on skin and hair. |
| **Main risk** | Over-grading into kitsch. Silhouetted back-light hides body detail, which is a mixed blessing. Exposure "pumping" when turning toward or away from the sun must be smooth, like a real camera's auto-exposure. |

## 4. Proposal C — "Atlantic Power"

*Portugal-like rugged headland with lighthouse and stone village. Broken storm light.*

| Aspect | Direction |
|---|---|
| **Emotional tone** | Awe, scale, commitment, seriousness. Nature is bigger than the surfer. |
| **Lighting** | Overcast or broken cloud: soft, directional sky light from a bright cloud gap; occasional moving sun shafts and cloud shadows sweeping across the sea and cliffs. Low contrast on the body, high contrast in the sky. |
| **Water** | Dark slate-green faces, heavy wind texture, lots of foam streaks, mist and spray hanging in the air. |
| **Colour grade** | Cool, muted (−15–25% saturation), slightly lifted blacks, preserving texture in foam. Greens pushed toward grey-teal. Sun-shaft moments warm up locally. |
| **Camera** | Slightly further and higher (5–6 m, 1.8–2 m) to show scale. Spray hits on the "housing" more often, matching the documentary feel. |
| **Environment** | Dark schist and granite headlands, a white lighthouse, stone and whitewashed buildings, a hazy layered coastline receding into mist. Dramatic stratocumulus and cumulonimbus. |
| **Character** | 4/3 full wetsuit, optional hood. |
| **Hero moments** | A large drop under a dark sky with a sun shaft on the wave face; a wipeout swallowed by whitewater (Shot 9). |
| **Real-time feasibility** | **Medium-high.** **The most forgiving for the character.** Soft light hides skin-shading limitations, and black neoprene hides deformation problems. Contact shadows are soft and cheap. The hard part is the **sky**: dramatic clouds need a good 2D cloud system and relightable cloud cards; volumetric clouds are too expensive. Mist and spray volume can be faked with screen-space layers and particles. |
| **Main risk** | Grey and dull if the sky lacks drama and the light lacks direction. Big-wave scale is a water-team problem. Less "joyful" than the brief's emphasis on freedom and natural beauty. |

## 5. Comparison and recommendation

| Criterion | A Tropical Clarity | B Golden Hour | C Atlantic Power |
|---|---|---|---|
| Fit to the brief (freedom, beauty, mastery) | ★★★ | ★★★ | ★★ |
| Forgiveness of character flaws | ★ | ★★ | ★★★ |
| Cinematic distinctiveness | ★★ | ★★★ | ★★★ |
| Rendering risk / cost | low | medium | medium |
| Dependency on water renderer quality | very high (clear water shows everything) | medium (glare hides detail) | medium (foam, texture) |
| Variety over an indefinite run | ★★ | ★★★ (angle to sun changes constantly) | ★★ |

**A fourth option from the reference study: D "Soft Overcast".** Evidence: Mentawai under high
cloud (IMG-24), an overcast Oʻahu barrel (IMG-34), fog surf (IMG-65). This is a tropical or
temperate location under high, thin cloud: soft teal water, no sparkle, soft speculars, the
sky dome doing the lighting. It is **the cheapest look to make believable** (no hard contact
shadows to get wrong), and it reads as a real camera because games rarely ship overcast.
Adopt it as a **weather variant** of any location and as the engineering baseline.

**Corrections from measured reference colour ([01 §9](01-visual-references.md)):**
- Real tropical water reads **teal/jade, not candy turquoise**. Turquoise appears only where
  light passes *through* the lip.
- Whitewater covers 25–45% of the frame.
- Spray in sports photography is **frozen** (1/1000 s), not motion-blurred.
- Keep saturation honest. Over-saturation is the fastest route to "game".

**Recommendation (revised after the reference study).**

1. **Do not choose one. Build one lighting pipeline that renders all of them as data presets.**
   The architecture in [06](06-environments-and-lighting.md) (sky provider + location preset +
   per-location LUT) already makes this the natural design. The cost of supporting all of them
   is a few presets plus the sky and cloud work, which we need anyway.
2. **Hero look: B, Golden Hour.** It suits the rear chase best: riding toward the sun gives a
   rim-lit silhouette and backlit spray as the brightest element. Silhouettes are forgiving
   for the character, and the constantly changing sun angle adds variety. Requirements: the
   wave should peel roughly toward the sun azimuth for part of each ride, and exposure, bloom
   and glare must be excellent. ShoreBreak already has the beginnings of these.
3. **Engineering baseline: D, Soft Overcast,** with C (Atlantic) as the second location.
   Develop the character, contact and animation first under soft light, where errors are
   animation errors, not lighting errors.
4. **A, Tropical Clarity, comes last, despite looking the most commercial.** Its rendering
   cost is low, but its *believability* risk is the highest: hard sun on bare skin exposes
   every shading, deformation and contact flaw.
5. **Long-run variety:** the visualization runs indefinitely, so add a slow time-of-day and
   weather cycle per location. For example: overcast morning (D) → clearing afternoon (A-like)
   → golden hour (B) → blue hour, then reset.
6. **Milestone-1 wardrobe:** spring suit or 3/2 wetsuit first (B/C/D). Boardshorts and bare skin
   are a switchable variant in the lab. Shirtless becomes a default only once it passes the
   character bake-off ([02](02-character-assets.md) E1–E5).

Confirm the decision after the previs bake-off ([09](09-video-previs.md)). Seeing all three in
motion with the rear chase camera is the real test.

## 6. Achievable vs expensive in real-time browser rendering

Desktop Chrome, WebGL2, Three.js, 1440p at 60 fps. The water renderer has priority on the
frame budget. Costs are approximate ([06 §B10](06-environments-and-lighting.md) has details).

| Visual quality | Status | Approach |
|---|---|---|
| Physical sky with dynamic sun, golden hour, haze | **Achievable, cheap** | Precomputed atmosphere (takram/Hillaire) baked into shared sky LUTs |
| Dramatic clouds | **Achievable, moderate art cost** | 2D layered clouds + relit cloud cards + cloud shadows. **Volumetric clouds: too expensive.** |
| Sun shadow on board and from surfer to board | **Achievable, cheap** | One tight 2048² shadow map following the surfer |
| Soft sky occlusion / contact shadows | **Achievable, moderate** | Baked AO + capsule shadows / SSAO-lite |
| Water bounce light on surfer | **Achievable, cheap** | Lower-hemisphere IBL from the sea + mirrored-sun fill |
| Wet skin, wet neoprene, drying | **Achievable, moderate** | Clearcoat water film + wetness masks + droplet normals |
| Skin subsurface scattering | **Approximate only** | Pre-integrated skin + wrap/thickness transmission. Screen-space SSS: moderate. True SSS: no. |
| Hair | **Cards only** | Wet, clumped short hair is the easiest case. Strand hair: no. |
| Backlit spray, rooster tails, droplets | **Achievable, cheap–moderate** | GPU particles with forward-scattering phase, soft particles, motion stretch, a rainbow term |
| Translucent barrel / lip | Water team. **Moderate–expensive** | Thickness-based transmission in the water shader |
| Motion blur | **Camera blur cheap; per-object moderate** | Velocity buffer for surfer and spray only |
| Depth of field | **Possible but avoid** | A chase cam at 4 m with a 35 mm lens has a deep focus look |
| Lens flare, veiling glare, droplets on lens | **Cheap** | ShoreBreak already has sun glare. Use sparingly. |
| God rays / sun shafts | **Fake cheaply** | Screen-space radial blur from sun occlusion. Volumetric ray marching: too expensive. |
| Surfer reflected in water | **Expensive** | Planar or screen-space reflections compete with the water budget. Skip; real footage rarely shows it clearly. |
| Detailed beach or town geometry | **Unnecessary** | Distance-banded silhouettes, impostors and boxes (exploit the offshore view) |
| Photoreal faces | **Unnecessary** | The rear camera rarely sees the face |
| Cloth simulation of boardshorts | **Cheap approximation** | 4–8 spring bones. A full cloth sim isn't needed. |
