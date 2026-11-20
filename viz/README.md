# BlueCurl Swell (prototype)

A surf-fantasy music visualizer: notes (keys 1–8 or a guitar via [Tuninator](https://github.com/trellos/Tuninator)) add energy to swell fronts that roll in from the horizon and break at a fictional east-facing point at dawn. Every note throws up a massive splash and a bird that circles and flies off into the dawn. A synthesized surf/tropical beat grows from a metronome (level 1) to a full groove (level 8) with how much you play, and the number of riders in the water (three surfers, two dolphins, two seals and a sea turtle) follows the beat level. A picture-in-picture follow cam opens on every ride.

Docs: [DESIGN.md](DESIGN.md) (what and why), [PLAN.md](PLAN.md) (packages, status, known issues), [LOG.md](LOG.md) (decisions and defaults, newest last), [src/contracts.js](src/contracts.js) (shared interfaces).

## Run
```
cd viz
npm install
npm run dev          # http://localhost:5180/
```
Add `?demo=demo/demo-basic.json` to the URL to play the scripted demo (~92 s, five sets with distinct characters). `demo/demo-intervals.json` switches the interval 4 → 16 → 32 s while playing. `demo/demo-beat.json` ramps the beat 1 → 8 → 1 (riders join and leave; bird flocks at 10/12/14 s).

Click or press any key once so the browser allows audio (the beat).

### Guitar
The app asks for guitar input on load: it opens the microphone straight away, or (if the browser wants a gesture first) shows a prompt and opens it on your first click or key. **G** toggles it; `?guitar=0` skips the ask; `?guitar=mock` plays a scripted phrase instead. While the mic is on, a pluck from the number keys is not re-detected as a guitar note (same pitch class within 0.7 s). Lanes 1–8 = one octave of the current key (starts C major, octave C3–C4 = low E fret 8). Non-diatonic notes do nothing. A tonic above/below the octave moves the octave; any other note sets the octave it is in. A three-note chord that is not in the key switches the key (C → Cm switches, C → Dm does not). The HUD shows key, octave and the last note → lane. Tip: headphones or a DI keep the beat out of the guitar mic.

### Beat
4/4 at the HUD tempo. Each measure the level moves one step toward the number of notes played in the previous measure (0–1 = metronome, 8+ = full). Each step up brings one more rider out (4 measures to reach the lineup); each step down sends the last one in. Change the level on exactly the downbeat a rider reaches the lineup and a flock of birds bursts out of them.

## Keys
| key | action |
|---|---|
| 1–8 | note impulse on lanes 1–8 (left → right = south → north) + a plucky synth note at that scale step in the guitar's current key/octave. Shift = soft note |
| G | guitar microphone on/off (Tuninator) |
| M | beat mute |
| I | cycle the interval (2 / 8 / 16 bars = 4 / 16 / 32 s at 120 bpm) |
| [ ] | bpm −/+ 5 (also the tempo slider in the HUD) |
| , . | travel time −/+ 1 s |
| S | set size 1–4 |
| P | picture-in-picture on/off |
| C | camera preset: lineup (default, eases toward active breaks) / point / cliff |
| H | HUD (fps, GPU ms, fronts, energies, wave parameters, interval) |
| Space | pause |

Harness API for Tuninator: `window.bluecurl.impulse({ lane, lanes: 8 | 15, scale, velocity, duration, time })`, `window.bluecurl.release(id)`, `window.bluecurl.setConfig(key, value)`, `window.bluecurl.guitarNote({ midi | midis, rms })` (runs a note through the guitar mapper). Everything is deterministic: state = f(config, input log).

## Tests and capture
```
npm test                                                     # 157 node tests
node tools/gen-demo-beat.mjs                                 # regenerate demo-beat + print the level per measure
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

### Day, key flock, fish
The sun rises in front of the lineup and sets behind the camera once every 64 measures (128 s at 120 bpm; it follows the tempo), then comes back up through the same twilight. When the guitar changes key, a flock of birds flies across the sky spelling it ('E', 'Cm', 'F#m'). Each step up of the beat sends a fish swimming right through the shallows under the headland, each step down one swimming left; after 4 beats they head into deeper water.

## Milestone 3 media
- `m3-day-cycle-720p.mp4`: demo-beat over one full day (130 s, silent). `m3-day-cycle-sheet.jpg`: sunrise, noon, afternoon, twilight from it.
- `m3-key-flock-E.jpg`: the key changed to E major. `m3-fish-t4.jpg`: two fish under the water in the shallows (beat rising).

## Milestone 2 media
- `m2-note-splash-t15.jpg`: one note → a splash erupting in the lineup, its bird climbing out.
- `m2-rider-entering-t5.jpg`: the beat rose, Pudge swims in (PiP).
- `m2-flock-pip-t12.jpg`: the level changed on the downbeat Pudge reached the lineup → a flock bursts out (PiP).
- `m2-demo-beat-720p.mp4`: demo-beat (56 s, silent: captures have no audio): level 1→8→1, riders join and leave, flocks at 10/12/14 s.

Performance: median GPU 6.9 ms per frame at 1920×1080 with every system on, at the busiest moment of the demo (RTX 5050 laptop, timer queries).
