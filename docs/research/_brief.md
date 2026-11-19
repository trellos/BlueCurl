# Shared research brief (for research contributors)

Project "BlueCurl": a realistic, real-time 3D surfing visualization in the browser
(Three.js + TypeScript, GLB/glTF assets, PBR materials, desktop Chrome first).
An autonomous surfer is driven by an external performance-data stream (an update
every ~500 ms) through four externally controlled phases: Paddling, Pop up,
Riding, Drop out. Poor performance -> stumbles, missed waves, wipeouts; excellent
performance -> increasingly spectacular pro-level surfing. Runs indefinitely.
The camera is a continuous rear chase camera directly behind the surfer.

Visual target: realistic sports cinematography, NOT stylized. Functional reference
is Barton Lynch Pro Surfing (Steam app 1776170) but with far more natural animation,
physical interaction and cinematic polish. Real pro surfing footage is the primary
reference. Avoid uncanny humans, robotic animation, gamey FX, generic environments.

Out of scope for us: ocean/wave rendering. A separate team is evaluating ShoreBreak
(https://github.com/cryptomanavan/ShoreBreak, MIT): Three.js r186, WebGL2 (not WebGPU),
plain ES modules + custom GLSL ShaderMaterials, metres, y-up, +z inland. It already has
its own sky (a measured sky-colour LUT fitted to a phone reference clip, not a physical
atmosphere model), an HDR half-float scene-linear buffer, custom post (bloom, sun glare,
auto-exposure meter, a "phone look" tone shoulder + saturation + sRGB OETF), procedural
beach/rocks/palms. It is a beach shore-break (Nice-like), not a peeling surf break.

Rules for this research:
- Research, don't implement. Do not download large asset libraries, sign up, or buy anything.
  Small checks (reading a LICENSE file, `npm view`, `pip download --no-deps` metadata,
  curl -I on a URL, cloning a small public repo to read code) are fine. Put any temp
  files in your own scratch dir, never in the repo.
- Today is 2026-11-19. Your training knowledge may be stale: search for the CURRENT state
  (2025-2026) of tools, prices and licences; note the date you checked.
- Label every important claim: **[Verified]** (you checked a primary source yourself:
  licence text, pricing page, repo code, a file you inspected), **[Vendor claim]**
  (marketing/docs statements not independently tested), **[Reported]** (third-party
  reviews, forum posts, papers), **[Assessment]** (your expert judgment).
- Give source URLs for everything. Give licence and cost wherever known.
- Be critical. The final criterion is visual believability, not technical novelty.
  Record rejected alternatives with the reason (we keep a decision log).
- Write in clear, compact markdown with tables where useful. No fluff.
