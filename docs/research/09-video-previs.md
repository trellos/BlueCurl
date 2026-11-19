# 09 — AI video previsualization: continuity bible, shot list and prompts

Status: draft v1 (2026-11-19). The tool recommendations in §2 are summarised from
[07-ai-asset-tools.md](07-ai-asset-tools.md); check there for prices and licences.

**Tools (from [07 §5–7](07-ai-asset-tools.md), all [Reported] unless noted there):**

- **Stills and reference sheets:** Nano Banana Pro (primary) and gpt-image (secondary).
  Midjourney can be used for hand-curated boards only; it has no official API.
- **Video:**
  - **Kling 4.0:** 30 s single takes, first/middle/last frame conditioning, up to 10 reference
    images and 5 reference videos. That means real follow-cam footage can steer the camera.
  - **Seedance 2.5:** 30 s takes, seeds, and a cheap 480p draft that can be upgraded to 1080p.
  - **Veo 3.1:** the strongest reported water realism, but 8 s clips. It needs chaining.
  - Runway's API reaches all three behind one key.
- **Budget:** about $200–500 for the concept and previs phase. Run the bake-off in
  [11 X7](11-experiments.md) first.
- **Wave type:** the prompts deliberately describe **peeling reef and point breaks**. That is
  the surfable wave the final piece needs, even though ShoreBreak currently models a beach
  shore-break.

## 1. Purpose and rules

The mockups set a **visual target**: what the final real-time piece should feel like.
They are not production assets and will never ship. They should answer three questions:

1. **Look.** Do we like art direction A, B or C once it's moving, with a rear chase camera?
2. **Motion vocabulary.** What does believable body language look like *from behind* for each
   phase? Generated clips are often physically wrong, so judge them against real footage
   (see [01-visual-references.md](01-visual-references.md)). They are mood references, not
   motion references.
3. **Camera grammar.** How close, how high and how much lag should the chase camera have?
   How should it behave through turns and in the barrel?

Hard rules for every clip:

- **One continuous rear chase shot. No cuts, no angle changes, no slow-motion ramps** unless
  the shot asks for one.
- **The surfer, board, wetsuit or boardshorts, location, time of day and camera rig must be
  identical** across all nine shots in a set. A set is one art direction.
- Generate the **keyframe stills first**, approve them, then animate with image-to-video. Use
  the start frame, and the end frame where the tool supports it.
- Treat every output as **reference only**. Log the prompt, the tool and version, the seed and
  the date beside each clip in `previs/LOG.md`.

## 2. Production method for consistency

Video models drift: faces, wetsuit details and fin counts change between clips. The method
below keeps drift under control.

1. **Reference pack (stills).** Use an image model with good reference conditioning to make:
   - a surfer **turnaround sheet**: back, three-quarter back, side and front, standing in a
     surf stance, on a neutral background;
   - a **board sheet**: deck, bottom and rail profile;
   - one **location plate** per art direction: the empty wave and coastline from the camera's
     position.

   Approve these before generating any video. Reuse them as references in every later prompt.
2. **Keyframes.** For each shot, generate 2–3 keyframes (K0 start, K1 middle, K2 end) by
   compositing the references into the shot description. Approve the keyframes.
3. **Image-to-video in segments.** Animate K0→K1, then K1→K2, using first/last-frame
   conditioning. Most tools cap a clip at roughly 5–15 s. For a longer take, chain segments:
   the last frame of segment *n* is the first frame of segment *n+1*. Then join the segments
   in an editor with a 2–4-frame dissolve. The result plays as one continuous take.
4. **Lock the camera wording.** Paste the camera block (§3.4) verbatim into every prompt. Don't
   paraphrase it.
5. **Pick by motion first, then look.** Generate several variants. Reject any clip with
   impossible physics: feet sliding on the deck, board passing through water, wrong stance,
   extra fins. Judge the look only after the motion passes.

## 3. Continuity bible

### 3.1 Surfer ("Kai", milestone-1 hero)

> A lean, athletic professional surfer in his mid-twenties, 178 cm, swimmer's build: broad
> shoulders, defined back and lats, narrow waist, strong thighs. Sun-tanned medium-brown skin.
> Short, dark-brown, slightly wavy hair, slicked and wet. **Regular stance** (left foot
> forward). Black leash on the **right ankle**.

Wardrobe by art direction:

- **A, Tropical Clarity:** navy-blue boardshorts with one thin white vertical stripe on the left
  thigh. Shirtless.
- **B, Golden Hour:** charcoal-black short-sleeve 2 mm spring suit, short legs, back zip.
- **C, Atlantic Drama:** full-length black 4/3 mm chest-zip wetsuit with matte neoprene and a
  subtle sheen where it's wet. No hood.

For a later second surfer, use the same template: an athletic woman with a long dark ponytail,
a regular stance, a black long-sleeve one-piece surf suit (or a 3/2 wetsuit for C), and the
same board in 5'10".

### 3.2 Board

> A 6'0" high-performance thruster shortboard. Glossy white polyurethane with a faint clear
> aqua resin tint visible at the rails. Thin balsa stringer down the centre. Black three-piece
> traction pad with a kicked tail. Three dark smoke-grey fins. Light wax on the deck. Squash
> tail, pointed nose, moderate nose rocker.

### 3.3 Locations and light (one per art direction)

- **A, Tropical Clarity.** A long, clean **right-hand reef break** on a tropical island.
  Head-high to slightly overhead, glassy, light offshore wind. Turquoise translucent wave face,
  deep blue water behind. Green volcanic ridges and palms about 1–2 km away. Late morning: sun
  high behind the camera's left shoulder, about 50° elevation. Crisp shadows, a few cumulus
  clouds over the mountains.
- **B, Golden Hour Cinematic.** A **right-hand point break** below low golden cliffs covered in
  coastal scrub, with a few distant houses on the bluff. Chest-to-head high, groomed by light
  offshore wind that feathers spray off the lip. Sun about 8° above the horizon, ahead and to
  the left of the camera, so the spray and the surfer's hair edges are backlit. Warm amber
  highlights, teal-blue shadows on the water.
- **C, Atlantic Drama.** A powerful **right-hand beach and reef break** below a rugged headland
  with a white lighthouse and stone buildings on the cliff. Overhead, dark slate-green water,
  heavy texture. Broken storm clouds with shafts of light through them. A cool, desaturated
  palette and sea haze softening the headland.

### 3.4 Camera block (paste verbatim)

> Continuous single-take rear chase camera, like a stabilized follow-cam on a jet ski directly
> behind the surfer. The camera stays about 4 metres behind the surfer, lens at about 1.5 m
> above the water (chest height of the standing surfer), 35 mm full-frame look, stabilized
> gimbal with a level horizon. The surfer's back is centred, just below the frame centre. The
> camera follows the surfer's path through every turn with slight, natural lag. No cuts, no
> zooms, no angle changes. Real-time speed. Natural motion blur, 180-degree shutter.

### 3.5 Style block (append per art direction)

- **A:** "Photoreal surf cinematography, sharp and clean, high-contrast midday light, saturated
  but natural turquoise, crisp highlights on wet skin, shot on a cinema camera, natural colour."
- **B:** "Photoreal surf film, warm low-sun backlight, glowing rim light on spray and hair, long
  shadows, subtle lens flare, warm-teal grade, filmic highlight roll-off."
- **C:** "Photoreal big-wave documentary, overcast with breaking sun shafts, cool slate palette,
  rain-like spray, heavy atmosphere, muted grade, moody but clear."

### 3.6 Negative / avoid list (append to every prompt where supported)

> no cuts, no slow motion, no text, no watermark, no extra limbs, no extra fins, no second
> surfer, no feet sliding on the board, no board floating above the water, no cartoon or
> stylized look, no CGI video-game look, no fisheye, no handheld shake, no drone top-down view.

## 4. Shot list

Each shot gives its intent, duration, beats, the prompt body (insert §3.1, §3.2, the location
from §3.3, then §3.4, §3.5 and §3.6), keyframes and what to learn from it. The
`{SURFER}`/`{BOARD}`/`{LOCATION}`/`{CAMERA}`/`{STYLE}` placeholders stand for those blocks.

---

### Shot 1 — Relaxed cruising along an open wave face (12 s)

**Intent:** effortless, unhurried trim on a clean wall. Baseline idle riding.

**Beats:**
- 0–4 s: tall, relaxed trim stance, knees soft, arms low and loose.
- 4–8 s: a gentle, wide carve up the face and back down.
- 8–12 s: a small adjustment of the back foot and a glance down the line.

**Prompt:**
> {SURFER} rides {BOARD} along the open, unbroken face of {LOCATION}. He is cruising in a
> relaxed trim, upright with soft knees, arms low and loose, shoulders square to the board,
> head turned to look down the line. Halfway through he makes a slow, gentle carve high up the
> face and drops back to the middle, and the rail leaves a thin trail of spray. Clean wave wall
> to the right of frame, coastline on the left, small chandelier drops falling from the lip
> behind. {CAMERA} {STYLE}

**Keyframes:**
- K0: surfer centred, wall on the right, horizon level.
- K1: surfer high on the face, slight lean into the wave.
- K2: back mid-face, looking ahead.

**Learn:** baseline camera distance and height; how much of the wave face reads to the right of
frame; how relaxed posture reads from behind (arm and shoulder carriage).

---

### Shot 2 — Increasingly powerful pumping and carving (15 s; 2 chained segments)

**Intent:** escalation from generating speed to committed carves.

**Beats:**
- 0–5 s: three rhythmic pumps. Compress and extend, weight front to back, arms swinging
  forward with each pump.
- 5–10 s: a deeper bottom turn, the hand almost touching the face.
- 10–15 s: a hard carve off the top with a fan of spray thrown up the face.

**Prompt:**
> {SURFER} on {BOARD} at {LOCATION} generates speed with rhythmic pumping: compressing low,
> extending tall, driving the board up and down the face, arms swinging forward in time with
> each pump. Each pump is stronger than the last. He sinks into a deep bottom turn, low
> centre of gravity, inside hand trailing near the wave face, then drives up the wall into a
> powerful carve that throws a fan of spray above the lip. Feet stay planted on the board the
> whole time. {CAMERA} {STYLE}

**Learn:** the pump rhythm (period, amplitude); camera lag through the bottom turn; the spray
volume and shape for the FX target.

---

### Shot 3 — Spectacular sustained high-performance sequence (20 s; 3 chained segments)

**Intent:** the "mastery" peak. Speed, flow, fluid rail-to-rail surfing with no hesitation.

**Beats:**
- 0–6 s: a fast bottom turn into a vertical re-entry under the lip, with spray.
- 6–12 s: down into a full roundhouse cutback, rebounding off the whitewater.
- 12–20 s: a speed line into a small, clean air off the section, a compressed landing, and
  riding away.

**Prompt:**
> {SURFER} on {BOARD} at {LOCATION}, surfing at professional level with flow and power. A fast
> bottom turn takes him straight up into a vertical re-entry, snapping the board off the lip
> in a curtain of backlit spray. He drops back down and arcs into a full roundhouse cutback,
> rebounding off the whitewater, then races down the line and launches a short, clean air
> off the end section. He grabs nothing, and lands compressed with knees bent, absorbing the
> impact, then rides away smoothly. Continuous motion, no hesitation. {CAMERA} {STYLE}

**Learn:** how fast pros transition rail to rail; how the camera should handle a vertical move
(this probably means camera height lift and slight pitch-up); the air arc relative to the
camera. Clips will almost certainly fail physically here. Pay most attention to the *camera*
and *composition*.

---

### Shot 4 — A mistake followed by a convincing recovery (12 s)

**Intent:** the "poor performance" vocabulary without a wipeout. Shows imperfection is human.

**Beats:**
- 0–4 s: normal trim.
- 4–7 s: the board catches a chop bump; the surfer bobbles, arms fly out, and the torso pitches
  forward and twists.
- 7–12 s: he drops low, re-centres, and resumes a confident trim.

**Prompt:**
> {SURFER} on {BOARD} at {LOCATION} trims along the face when the board hits a chop bump. He
> loses balance for a moment: arms fly out wide, his torso pitches forward and twists, and his
> back foot skids slightly. He drops his hips low, bends deeply at the knees, re-centres his
> weight over the board, lowers his arms and resumes a confident trim. Realistic athletic
> balance recovery, not exaggerated. {CAMERA} {STYLE}

**Learn:** the timing and amplitude of a recovery (≈0.5–1.5 s); arm usage; the
"believable vs comedic" boundary. This is critical for the stability parameter design.

---

### Shot 5 — Riding through a translucent barrel (12 s)

**Intent:** the cinematic money shot. Sunlight through the lip, the surfer framed by the tube.

**Beats:**
- 0–3 s: the surfer stalls slightly as the lip pitches over.
- 3–9 s: inside the tube in a compact crouch, back hand trailing in the face, the tube
  spinning around the camera.
- 9–12 s: blown out by spit and exits into the light.

**Prompt:**
> {SURFER} on {BOARD} at {LOCATION} sets his line and stalls as the lip throws over him. He
> rides deep inside a perfect, translucent barrel in a compact crouch, low and calm, back hand
> lightly trailing in the wave face, head up looking toward the exit. Sunlight glows through
> the curtain of water, turning it luminous turquoise. The camera follows him inside the tube;
> the spinning lip surrounds the frame. A burst of spray blows out behind him as he exits into
> open sunlight. {CAMERA} {STYLE}

**Learn:** the barrel-riding posture from behind (very compact); light inside the tube; how
the camera's framing must change (the tube ceiling occupies the frame top). Coordinate with
the water team, since the barrel is their hardest shot too.

---

### Shot 6 — Paddling and catching a wave (14 s; 2 segments)

**Intent:** the paddling phase from behind, looking shoreward as the wave arrives.

**Beats:**
- 0–4 s: a relaxed paddle, a glance back over the right shoulder at the approaching swell.
- 4–10 s: turning toward the beach, with strong, deep, fast strokes, chest raised, feet together.
- 10–14 s: the tail lifts as the wave picks the board up, and two final strokes.

**Prompt:**
> {SURFER} lies prone on {BOARD} in the water at {LOCATION}, paddling relaxed with alternating
> arm strokes, chest slightly raised. He glances back over his shoulder at an approaching
> swell, turns the board toward the beach and paddles hard: deep, fast, powerful strokes, chest
> lifted, legs together, toes near the tail. The wave rises behind the camera, lifting the tail
> of the board, and the board starts to glide down the face. {CAMERA}, positioned just behind
> the board's tail, lens about 1 m above the water. {STYLE}

**Learn:** stroke rate (relaxed vs powerful); upper-body roll with each stroke; how much of the
surfer is visible from behind and low (feet and soles prominent); whether the "behind"
camera should sit higher during paddling.

---

### Shot 7 — A smooth pop up (8 s)

**Intent:** a clean, quick pro pop-up and the transition into the drop.

**Beats:**
- 0–2 s: last strokes as the board drops.
- 2–3 s: hands planted under the chest, a fast press, both feet swinging through in one motion.
- 3–8 s: lands in a low stance, drops down the face and sets a rail.

**Prompt:**
> {SURFER} catches a wave on {BOARD} at {LOCATION}. After two last strong strokes, he places
> both hands flat on the deck beside his chest, presses up explosively, and in one fluid
> motion swings both feet under him: left foot forward in the middle of the board, right
> foot over the fins. He lands in a low, balanced stance in under a second and drops smoothly
> down the face into the first turn. {CAMERA} {STYLE}

**Learn:** pop-up duration (pros ≈ 0.4–0.6 s, slower for recreational surfers; see
[04-animation-sources.md](04-animation-sources.md)); how foot placement looks from
behind; the camera's rise from paddling height to standing height.

---

### Shot 8 — A controlled exit (10 s)

**Intent:** the calm "drop out" when a wave closes out or ends.

**Beats:**
- 0–4 s: trim toward the shoulder as the wave weakens.
- 4–7 s: a turn up and over the back of the wave (kick-out), the surfer sinking to his knees,
  then lying prone.
- 7–10 s: paddles a few strokes over the back, with the wave passing.

**Prompt:**
> {SURFER} on {BOARD} at {LOCATION} rides toward the end of the wave as it softens. He turns
> up the face and kicks out cleanly over the back of the wave, the board's nose lifting over
> the top. He drops smoothly to his knees and then onto his stomach, and paddles calmly a few
> strokes as the wave rolls past toward the beach. {CAMERA} {STYLE}

**Learn:** the transition from riding to paddling; camera height and lag during the kick-out,
which crosses the crest.

---

### Shot 9 — A dramatic wipeout and recovery (16 s; 2 segments)

**Intent:** a believable failure with consequence, then resilience.

**Beats:**
- 0–4 s: a late, steep drop.
- 4–7 s: the rail catches, the surfer is pitched forward and goes over the falls in the
  whitewater, and the board tombstones on its leash.
- 7–12 s: churning foam, then the surfer surfaces and shakes water from his face.
- 12–16 s: reels the board in by the leash, climbs on and starts paddling.

**Prompt:**
> {SURFER} at {LOCATION} takes a late, steep drop on {BOARD}. The rail catches near the bottom,
> he is pitched forward off the board, and the lip throws him into the whitewater in an
> explosion of foam while the board flips into the air, tethered by the leash. The camera
> keeps following through the churning whitewater. He surfaces, gasps, shakes water from his
> face and hair, pulls the board back by the leash, slides onto it and starts paddling back
> out. {CAMERA} {STYLE}

**Learn:** the wipeout timing; the ragdoll-like body language in the first 0.5 s versus active
swimming afterward; where the camera goes when the surfer disappears (hold position and rise
slightly). This feeds the drop-out state design.

## 5. Optional still keyframe prompts (concept images)

Use these for the art-direction boards. They work in Midjourney/FLUX/Imagen-class models with
the reference sheets attached.

1. **Hero from behind**, A/B/C variants: "Photograph from directly behind and slightly above a
   surfer mid-bottom-turn, 4 m away, 35 mm lens, {SURFER-short}, {BOARD-short}, wave wall
   to the right, {LOCATION-short}, {STYLE}".
2. **Barrel interior**: the camera inside the tube behind the surfer, the lip framing the exit.
3. **Backlit spray re-entry**: spray fan against the low sun (B), the surfer silhouette
   readable.
4. **Paddle out**: low and behind the board, soles of the feet in the foreground, headland
   ahead.
5. **Character sheet**: back, three-quarter back, side and front, standing in a surf stance,
   neutral grey background, even studio light. This is the master reference for 3D work too.
6. **Board sheet**: deck, bottom and rail profile, studio light.

## 6. Evaluation checklist (fill in per clip)

| Criterion | Notes |
|---|---|
| Surfer/board consistent with bible? | |
| Feet planted, stance correct (regular, leash right ankle)? | |
| Posture believable compared with real footage refs? | |
| Camera distance/height/lag: good or bad, and what to change? | |
| Light and grade: which art direction does it support? | |
| Water interaction (spray, wake, rail line) | |
| What to copy into the real-time target | |
| What to explicitly avoid | |
