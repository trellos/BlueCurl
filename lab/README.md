# BlueCurl Surf Lab

Browser test bench for the surfer, the board, board motion and the performance stream
(docs/research/10-lab-architecture.md). three.js 0.186.0 (pinned with ShoreBreak), Vite, TypeScript.
Self-contained under `lab/` so it never collides with ShoreBreak's root `package.json` and `src/`.

```bash
cd lab && npm install && npm run dev      # http://127.0.0.1:5199
npm test                                  # boardkit / rider unit tests (node --test)
npm run typecheck
node tools/shot.mjs out/x.png "preset=B&cam=chase&seek=6&paused&capture"   # headless PNG (dev server running)
```

URL parameters: `preset=B|D|studio`, `cam=chase|orbit|side|front|top`, `orbit=az,el,dist[,h]`,
`seek=<s>` (deterministic re-simulation), `paused`, `capture` (hide UI).
Keys: space pause, `.` step one frame, `p` PNG, `c` chase/orbit, `h` HUD.

Layout: `src/core` (clock, springs), `src/camera` (chase), `src/look` (lighting presets),
`src/stage` (stand-in sea), `src/surfsim` (stand-in wave face, board motion), `src/boardkit`
(procedural board), `tools/` (capture, Blender conversion). Assets: see `ASSETS.md`.
