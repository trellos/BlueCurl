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

URL parameters:

| Parameter | Values / meaning |
|---|---|
| `preset` | `B` Golden Hour, `D` Soft Overcast, `studio` |
| `cam` | `chase`, `orbit`, `side`, `front`, `top`; `orbit=az,el,dist[,h]` places the orbit camera around the board |
| `seek=<s>` | deterministic re-simulation to time s; `paused`; `capture` hides the UI |
| `stream` | `off`, `cruise`, `escalating`, `struggling`, `wipeout` (500 ms packets); `seed=<n>` |
| `script` | scripted maneuvers, e.g. `script=2:bottomTurn,8:cutback,15:topTurn,20:pump` |
| `phase=paddle` | start prone and paddling; `popupAt=<s>` auto pop-up |
| `torture` | pose tests: `deepCrouch`, `twistArmsOut`, `aerialTuck` |
| `stance=goofy`, `stability=<0..1>`, `debug` (overlays + scope) | |

Keys: space pause, `.` step one frame, `p` PNG, `c` chase/orbit, `h` HUD.

Acceptance metrics (deterministic, in the browser console or via `tools/shot.mjs --eval`):
`__lab.metrics({ seconds: 24, stream: 'off', script: [[2, 'bottomTurn'], [8, 'cutback']] })` returns
foot contact error (mm), rider CPU per frame, body lean vs `atan(v²/rg)`, body-vs-board lead, steps
and falls.

Layout:

| Path | Contents |
|---|---|
| `src/core` | fixed-step clock, seeded noise, springs |
| `src/camera` | rear chase camera |
| `src/look` | lighting presets |
| `src/stage` | stand-in sea |
| `src/surfsim` | stand-in wave face, board motion (planner + perturbations) |
| `src/boardkit` | procedural board, anchors, deck queries, ShoreBreak frame conversion |
| `src/rider` | rig / pose buffers / FK, key poses, IK, balance controller, paddle and pop-up clips |
| `src/stream` | 500 ms performance-stream simulator |
| `src/debug` | HUD, overlays, signal scope, metrics |
| `tools/` | headless capture, Blender conversion |

Assets: see `ASSETS.md`. Lab log and measurements: `docs/research/README.md` (Lab log).
