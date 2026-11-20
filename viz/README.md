# BlueCurl Swell (prototype)

A surf-fantasy music visualizer: notes add energy to swell fronts that roll in from the horizon and break at a fictional east-facing point at dawn. Two surfers, two dolphins and two seals ride them, and a picture-in-picture follow cam opens on every ride.

Docs: [DESIGN.md](DESIGN.md) (what and why), [PLAN.md](PLAN.md) (packages, status, known issues), [LOG.md](LOG.md) (decisions and defaults, newest last), [src/contracts.js](src/contracts.js) (shared interfaces).

## Run
```
cd viz
npm install
npm run dev          # http://localhost:5180/
```
Add `?demo=demo/demo-basic.json` to the URL to play the scripted demo (~92 s, five sets with distinct characters). `demo/demo-intervals.json` switches the interval 4 → 16 → 32 s while playing.

## Keys
| key | action |
|---|---|
| 1–8 | note impulse on lanes 1–8 (left → right = south → north). Shift = soft note |
| I | cycle the interval (2 / 8 / 16 bars = 4 / 16 / 32 s at 120 bpm) |
| [ ] | bpm −/+ 5 |
| , . | travel time −/+ 1 s |
| S | set size 1–4 |
| P | picture-in-picture on/off |
| C | camera preset: lineup (default, eases toward active breaks) / point / cliff |
| H | HUD (fps, GPU ms, fronts, energies, wave parameters, interval) |
| Space | pause |

Harness API for Tuninator: `window.bluecurl.impulse({ lane, lanes: 8 | 15, scale, velocity, duration, time })`, `window.bluecurl.release(id)`, `window.bluecurl.setConfig(key, value)`. Everything is deterministic: state = f(config, input log).

## Tests and capture
```
npm test                                                     # 105 node tests
node test/wave-parity.mjs                                    # GPU vs JS wave profile parity (headless Chrome)
node tools/shot.mjs --name x --demo demo/demo-basic.json --times 12,36 --w 1920 --h 1080
node tools/capture.mjs --name final-demo-basic --demo demo/demo-basic.json --from 0 --to 92 --fps 30 --w 1920 --h 1080 --video
node tools/demo-report.mjs demo/demo-basic.json              # wave parameters per front/zone
node tools/rides-report.mjs demo/demo-basic.json             # every ride
```
Captures are resumable (they restart from the first unfinished segment) and byte-identical across restarts under `--angle vulkan` (the default).

## Milestone 1 media ([media/](media/))
- `front-approaching-t28.jpg`: charged fronts rolling in, the outer reef starting to break, Kai pulling in (PiP).
- `wave-breaking-pip-t36.jpg`: the barrel set breaking at the point (the camera has eased in), Moana in the PiP.
- `south-peak-t66.jpg`, `closeout-t82.jpg`: the one-sided set and the erratic close-out set.
- `demo-basic-720p.mp4`: the full scripted demo (92 s). The 1080p original is produced by the capture command above.

Performance: median GPU 6.9 ms per frame at 1920×1080 with every system on, at the busiest moment of the demo (RTX 5050 laptop, timer queries).
