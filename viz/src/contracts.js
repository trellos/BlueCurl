// BlueCurl Swell — shared contracts. Owned by the orchestrator. Every package builds against this file.
// Change requests go through the orchestrator (record in viz/LOG.md). Plain ES module, no three.js import.
//
// WORLD: metres / seconds. +X = east (seaward, sunrise), +Y = up, +Z = north (along the coast).
// Waves travel toward -X. Default camera sits on the northern headland looking roughly east/south-east,
// so screen-left ≈ south (-Z), screen-right ≈ north (+Z).
//
// DETERMINISM RULES (all packages):
//  - No Math.random / Date.now / performance.now in simulation or visuals. Use hash01() / mulberry32().
//  - Simulation advances only in fixed steps of DT via step(t, dt). Visual state must be a pure
//    function of (sim state at t, t): no per-frame accumulation with frame dt (no GPU ping-pong foam,
//    no dt-integrated particles). Particles = analytic trajectories from seeded emitter events.
//  - state(t) = f(cfg, input log). Seeking = reset() + replay steps (sim-only, no rendering).

export const DT = 1 / 120;                 // fixed simulation step (s)
export const STEP_TOL = 0.01 * DT;         // tolerance when converting seconds -> steps (never 1e-9)
export const stepsFor = (sec) => Math.max(0, Math.floor(sec / DT + 0.5 + STEP_TOL));

// ---------------------------------------------------------------- swell front geometry
// A front is a straight crest line parallel to Z spanning FRONT_Z0..FRONT_Z0+FRONT_W, moving toward -X.
// Crest coordinate u ∈ [0,1] (0 = south end, 1 = north end). Sampled in NCOLS columns.
// Layout compacted ×0.6 on 2026-11-20 (LOG.md) so waves read at a useful size from the wide camera.
export const FRONT_Z0 = -156;
export const FRONT_W = 312;
export const NCOLS = 128;                  // column c sits at u = (c + 0.5) / NCOLS (cell centres)
export const uToZ = (u) => FRONT_Z0 + u * FRONT_W;
export const zToU = (z) => (z - FRONT_Z0) / FRONT_W;
/** lane l of L lanes (left→right on screen = south→north) → crest coordinate u. */
export const laneToU = (lane, lanes = 8) => (lane + 0.5) / lanes;

// ---------------------------------------------------------------- spot / zones
// Swell reaches outer → point → inside. Each zone breaks the columns of a front inside its crest range.
// Energy that passes through a zone (or what's left after breaking) re-forms smaller toward the inside.
export const ZONES = [
  { key: 'outer',  lineX: 180, u0: zToU(18),   u1: zToU(138),  Hscale: 2.0, Hbreak: 3.0,  vPeel: 9, Tb: 2.0, retain: 0.35, peelBias: -1 },
  { key: 'point',  lineX: 100, u0: zToU(-72),  u1: zToU(54),   Hscale: 1.3, Hbreak: 0.9,  vPeel: 8, Tb: 2.6, retain: 0.40, peelBias: -1 },
  { key: 'inside', lineX: 33,  u0: zToU(-141), u1: zToU(-21),  Hscale: 0.7, Hbreak: 0.45, vPeel: 5, Tb: 3.0, retain: 0.0,  peelBias: 0 },
];
// Land: beach at x≈0 for z∈[-156,-12] (the bay). Northern headland (the point), ~30 m cliff on its
// east face, land for roughly x < 66 and z > 36, tip near (70, 57). Palms on the headland and around the bay.
// Outer reef: shallow reef patch around x 155..200, z 24..132. Point: rock shelf along the headland's
// south face. Inside: sandbar x 24..48, z -138..-24. The straight crest runs into the headland north of
// z≈36 once x < 66: the terrain hides it there; the sim tapers those columns.

// ---------------------------------------------------------------- crest travel path
// Crest x as a function of (t - tPoint), where tPoint = time the crest reaches the point line.
// Times before 0 are scaled by cfg.travel / 14 (travel = horizon→point seconds). Monotone cubic interp.
export const PATH = [
  { x: 600, t: -14 },   // horizon spawn (fade in over first 2 s)
  { x: 180, t: -5.5 },  // outer reef line
  { x: 100, t: 0 },     // point line  (tPoint lands on the beat grid)
  { x: 33,  t: 13 },    // inside line (slower crest in the bay → longer point peels / rides; review round 1)
  { x: 0,   t: 19 },    // shore (fade out, front dies)
];

// ---------------------------------------------------------------- runtime config (tunable, logged)
// Mutate only through input.setConfig(key, value) so changes enter the input log (deterministic replay).
export const DEFAULT_CFG = {
  seed: 1,
  bpm: 120,
  bars: 8,                 // interval in bars: 2 | 8 | 16  → seconds = bars * 4 * 60 / bpm (4 / 16 / 32 s @120)
  barsOptions: [2, 8, 16],
  travel: 14,              // s, horizon → point line
  setSize: 3,              // fronts per set (clamped so a set fits inside the interval)
  setSpacing: 2.5,         // s between fronts in a set
  commitLead: 3.0,         // s before a zone's tBreak when its ZoneBreak is frozen (riders plan on it)
  energyHalfLife: 20,      // s, per-column energy decay while waiting on the water
  laneSigma: 0.8,          // gaussian spill in lanes
  ambient: { amp: 0.22, period: 12, amp2: 0.12, period2: 17 },
  pip: { enabled: true, onTakeoff: true, onBarrel: true, minHeight: 0.3, maxConcurrent: 1,
         holdAfterRide: 1.5, size: 1 / 3, corner: 'auto' },   // 'auto' = per camera preset (WP7)
  camera: 'lineup',        // wide presets: lineup | point | cliff (key C)
  cameraPush: 0.6,         // 0..1: how far the wide view eases toward an active break, then back (0 = static)
  hud: true,
  // milestone 2 (guitar + beat + birds)
  beat: { volume: 0.7, mute: false, maxLevel: 8, entryMeasures: 4 },   // audio volume/mute are output-only (no sim effect)
  guitar: { key: 'C major' },  // display/log only: lane mapping happens before the input log (see GuitarMapper)
  birds: { perNote: 1, flock: 16, max: 96 },
};
export const intervalSec = (cfg) => cfg.bars * 4 * 60 / cfg.bpm;

// ---------------------------------------------------------------- input API
/**
 * @typedef {Object} InputEvent  — entries of the input log (the replay record)
 * @property {number} seq     monotonically increasing
 * @property {number} t       sim time (s), quantised to the step it applies on
 * @property {'on'|'off'|'cfg'} type
 * @property {number} [id]    impulse id ('on'/'off')
 * @property {number} [lane]  @property {number} [lanes] 8 | 15
 * @property {number} [u]     crest coordinate = laneToU(lane, lanes)
 * @property {number} [scale] @property {number} [velocity]   strength = scale * velocity (keyboard: 1.0, Shift = soft 0.4)
 * @property {number} [duration] optional, known at 'off' (or given up-front by a harness)
 * @property {string} [key]   @property {*} [value]   ('cfg')
 *
 * InputBus (src/input/input.js):
 *   impulse({ lane, lanes=8, scale=1, velocity=1, duration=null, time=null }) → id
 *   release(id, time=null)          setConfig(key, value, time=null)
 *   drainUntil(t) → InputEvent[]    (events with ev.t <= t, in seq order, each returned once)
 *   log (array) · load(log) · reset() (rewind drain cursor) · bindKeyboard(target) (keys 1–8, Shift=soft,
 *   I = cycle bars, [ ] = bpm ∓5, , . = travel ∓1, S = cycle setSize 1..4, P = pip toggle).
 *   Live events get t = next step boundary so they apply on the next sim step (visible next frame).
 *   Exposed as window.bluecurl = { impulse, release, setConfig } for the Tuninator harness.
 */

// ---------------------------------------------------------------- swell state (src/sim/swell.js)
/**
 * @typedef {Object} ZoneBreak   frozen at tBreak - cfg.commitLead; immutable afterwards
 * @property {string} zone  @property {number} zi    index into ZONES
 * @property {number} tBreak     time the peak column starts breaking (tau = 0)
 * @property {number} uPeak  @property {number} u0  @property {number} u1   crest coords (zone extent)
 * @property {-1|0|1} dir        peel direction along u (0 = A-frame, peels both ways)
 * @property {number} vPeel      m/s along the crest
 * @property {number} Tb         s, local break duration (tau 0 → 1)
 * @property {number} peelLen    m from the peak the peel runs before it stops (beyond: shoulder never breaks)
 * @property {number} backLen    m behind the peak (against dir) that crumbles slowly
 * @property {boolean} closeout  whole zone range breaks almost at once
 * @property {number} sections   1 = clean peel, 2..3 = sectiony (chunks fold together)
 * @property {number} H  @property {number} steep  @property {number} curl  @property {number} mush   (peak values, 0..1 except H in m)
 * @property {{size:number, steepness:number, barrelTime:number, peelLength:number}} quality
 *
 * @typedef {Object} FrontState
 * @property {number} id  @property {number} set  @property {number} k   (index within set)
 * @property {number} tSpawn  @property {number} tPoint
 * @property {number} x       crest world x at current t       @property {number} vx  (m/s, negative)
 * @property {number} alpha   0..1 visibility (horizon fade-in / shore fade-out)
 * @property {Float32Array} cols   NCOLS*4: [H (m), steep, curl, mush] per column — current, incl. shoaling & break losses
 * @property {Float32Array} energy NCOLS: accumulated energy per column
 * @property {Float32Array} glow   NCOLS: 0..1 recent-impulse pulse per column (drives shimmer)
 * @property {ZoneBreak[]} breaks  committed zone breaks, in zone order
 * @property {boolean} target  currently receiving impulses
 *
 * Swell: constructor(cfg) · reset() · step(t, dt, events) · fronts: FrontState[] (alive, by id)
 *   · impulses: ImpulseFx[] (ring, last ~10 s) · events: SwellEvent[] (ring) · schedule {intervalSec, nextPointT}
 * ImpulseFx  { id, t, u, lane, lanes, strength, frontId, precharge:boolean, x, z, jump:boolean }  (x,z = where it
 *            landed; precharge → the front has not spawned yet, show the hit as a glow at the horizon x)
 * Extra fields (WP3): front.charge (total deposited), front.travel, front.tLine[zi], front.tShore; zb.stats; swell.targetId.
 * SwellEvent { t, type:'spawn'|'commit'|'break'|'die', frontId, zone? }
 */

// ---------------------------------------------------------------- break timing (shared JS; GLSL mirror in src/wave/profile.glsl.js)
/** Time column u starts breaking in zone break zb, or Infinity if it never does. */
export function breakStartTime(zb, u) {
  if (u < zb.u0 || u > zb.u1) return Infinity;
  const ds = (u - zb.uPeak) * FRONT_W;
  if (zb.closeout) return zb.tBreak + Math.abs(ds) / 80;        // near-simultaneous
  let s = zb.dir === 0 ? Math.abs(ds) : ds * zb.dir;
  if (s < 0) {                                                   // behind the peak: slow crumble
    const back = -s;
    return back > zb.backLen ? Infinity : zb.tBreak + back / (0.5 * zb.vPeel);
  }
  if (s > zb.peelLen) return Infinity;
  if (zb.sections > 1) {                                         // chunks fold fast: smooth monotone staircase
    const seg = zb.peelLen / zb.sections, w = (2 * Math.PI) / seg;
    return zb.tBreak + (s - 0.75 * Math.sin(w * s) / w) / zb.vPeel;
  }
  return zb.tBreak + s / zb.vPeel;
}
// Discontinuities left by design (peel end, backLen end, zone edges u0/u1): the sim tapers cols H/curl
// toward 0 there so the jump in tau is invisible. Profile at tau = 2 equals tau = -1 (re-formed swell).
/**
 * Local break phase of column u at time t: the most recent zone whose start time has passed wins.
 * tau < 0 → unbroken swell; 0..1 steepen/throw/plunge/collapse; 1..2 whitewater re-forming to swell; capped at 2.
 * Returns { tau, zi, tStart } (zi = -1 if never broken yet).
 */
export function localTau(front, u, t) {
  let best = -1, tStart = Infinity;
  for (const zb of front.breaks) {
    const ts = breakStartTime(zb, u);
    if (ts <= t && (best < 0 || ts > tStart)) { best = zb.zi; tStart = ts; }
  }
  if (best < 0) {                                                // pre-break: approach phase for the next zone
    let next = Infinity, Tb = 2.5;
    for (const zb of front.breaks) { const ts = breakStartTime(zb, u); if (ts < next) { next = ts; Tb = zb.Tb; } }
    return { tau: Number.isFinite(next) ? Math.max(-1, (t - next) / Tb) : -1, zi: -1, tStart: next };
  }
  const zb = front.breaks.find((b) => b.zi === best);
  return { tau: Math.min(2, (t - tStart) / zb.Tb), zi: best, tStart };
}

// ---------------------------------------------------------------- ambient swell (JS + GLSL, identical)
export function ambientHeight(x, z, t, a = DEFAULT_CFG.ambient) {
  const k1 = (2 * Math.PI) / (9.81 * a.period * a.period / (2 * Math.PI));
  const k2 = (2 * Math.PI) / (9.81 * a.period2 * a.period2 / (2 * Math.PI));
  return a.amp * Math.sin(k1 * (x + 0.12 * z) + (2 * Math.PI / a.period) * t)
       + a.amp2 * Math.sin(k2 * (x - 0.3 * z) + (2 * Math.PI / a.period2) * t + 1.3);
}
export const AMBIENT_GLSL = /* glsl */ `
uniform vec4 uAmbient; // amp, period, amp2, period2
float bcAmbient(vec2 xz, float t) {
  float k1 = 6.2831853 / (9.81 * uAmbient.y * uAmbient.y / 6.2831853);
  float k2 = 6.2831853 / (9.81 * uAmbient.w * uAmbient.w / 6.2831853);
  return uAmbient.x * sin(k1 * (xz.x + 0.12 * xz.y) + 6.2831853 / uAmbient.y * t)
       + uAmbient.z * sin(k2 * (xz.x - 0.3 * xz.y) + 6.2831853 / uAmbient.w * t + 1.3);
}`;

// ---------------------------------------------------------------- wave geometry API (src/wave/*, WP4a)
/**
 * profile(tau, sigma, H, shape) → { xi, y, dxi, dy }   cross-section point, metres. sigma ∈ [0,1] runs from the
 *   seaward back (xi ≈ -45) over crest/lip to the shoreward front (xi ≈ +35); xi > 0 = shoreward (world -X).
 *   Overhang allowed (xi non-monotonic in sigma). Ends have y→0 with zero slope so the mesh blends into the ocean.
 *   shape = { steep, curl, mush } ∈ [0,1].
 * field.js:
 *   sampleFront(front, u, sigma, t) → { x,y,z, nx,ny,nz, vx,vy,vz, tau, zi, H }   world, incl. ambient
 *   surfaceHeight(fronts, x, z, t) → y   single-valued sea surface (ambient + front lumps/faces, underside of any lip)
 *   barrel(front, u, t) → null | { x,y,z, r }   tube centre and radius while the lip is thrown over
 *   lip(front, u, t) → { x,y,z }
 * World placement: x = front.x - xi, z = uToZ(u), y = y + ambientHeight(x,z,t). Velocity = d/dt of that.
 */

// ---------------------------------------------------------------- riders (src/riders/*, WP6)
/**
 * @typedef {'ASHORE'|'ENTER'|'LINEUP'|'POSITION'|'TAKEOFF'|'RIDE'|'KICKOUT'|'CLOSEOUT'|'RETURN'|'LEAVE'} RiderStateName
 *   ASHORE = not in the water (RiderViews hides it); ENTER = swimming/paddling out to the lineup; LEAVE = heading out
 *   of the scene (surfers to the beach, animals out to sea), becomes ASHORE when it gets there.
 * @typedef {Object} RiderState
 * @property {number} id  @property {'surfer'|'dolphin'|'seal'} kind  @property {string} name
 * @property {RiderStateName} state
 * @property {'cruise'|'carve'|'tube'|'porpoise'|'breach'|null} style
 * @property {string} action   animation cue: idle|paddle|swim|pop|trim|bottomTurn|lipHit|cutback|crouch|kickout|wipe|jump|dive|roll
 * @property {boolean} tube    true while inside the barrel (WP6a)
 *   (Riders also exposes `rides`: a log of completed rides. Riders depends on swell.js pathSpline/pathEval + front.travel.)
 * @property {number} actionT  0..1 progress of the action
 * @property {{x:number,y:number,z:number}} pos  @property {{x:number,y:number,z:number}} fwd  @property {{x:number,y:number,z:number}} up
 * @property {number} speed  @property {number|null} frontId  @property {number} zi  @property {number} u  @property {number} sigma
 * Riders: constructor(cfg) · reset() · step(t, dt, swell, beat) · riders: RiderState[]
 *   · events: RideEvent[] (ring) RideEvent { t, type:'takeoff'|'barrel'|'rideEnd', riderId, frontId, zi, outcome?:'kickout'|'closeout' }
 *
 * Presence (milestone 2): the number of riders in the water follows the beat. Wanted count = beat.level (1..8);
 * riders join in ENTRY_ORDER and leave last-in-first-out. At t = 0 (level 1) ENTRY_ORDER[0] is already in the lineup.
 * A joining rider leaves ASHORE at the downbeat the level rose and reaches the lineup exactly cfg.beat.entryMeasures
 * measures later (measure length at that time). A leaving rider finishes any ride first, then takes the same time
 * to get out. A rider still ENTERing when asked to leave turns round.
 * Extra RiderState fields: present:boolean (false only when ASHORE), enterT, arriveT (planned lineup arrival).
 * Extra RideEvent types: 'enter' | 'arrive' | 'leave' | 'gone' | 'flock'.
 *   'flock' { t, riderId, pos:{x,y,z} }: the beat level changed (up or down) on the very downbeat this rider
 *   arrived at the lineup (arrival measure index = enter measure index + entryMeasures) → Fx releases a bird flock.
 */
export const RIDERS = [
  { id: 0, kind: 'surfer',  name: 'Kai',   color: 0xff4d2e, zones: ['outer', 'point'] },
  { id: 1, kind: 'surfer',  name: 'Moana', color: 0xffc21a, zones: ['point', 'inside'] },
  { id: 2, kind: 'dolphin', name: 'Flip',  color: 0x6f8fa8, zones: ['point', 'outer'] },
  { id: 3, kind: 'dolphin', name: 'Echo',  color: 0x7d97ad, zones: ['inside', 'point'] },
  { id: 4, kind: 'seal',    name: 'Pudge', color: 0x4a3b30, zones: ['inside'] },
  { id: 5, kind: 'seal',    name: 'Gus',   color: 0x5a4a3c, zones: ['inside', 'point'] },
  { id: 6, kind: 'surfer',  name: 'Noa',   color: 0x2ee6c8, zones: ['inside', 'point'] },
  { id: 7, kind: 'turtle',  name: 'Honu',  color: 0x6b7a3a, zones: ['inside', 'point'] },
];
/** Order riders join the water as the beat level rises (level N → the first N of these are in). */
export const ENTRY_ORDER = [0, 2, 4, 1, 7, 3, 5, 6];

// ---------------------------------------------------------------- guitar input (src/input/guitar*.js, WP10)
/**
 * Lanes 1..8 = one octave of the current key's scale: 1 = low tonic, 2..7 = scale degrees, 8 = high tonic.
 * GuitarMapper (pure, no DOM; src/input/guitarMap.js):
 *   new GuitarMapper({ tonicPc = 0, mode = 'major', lowRoot = GUITAR.initialLowRoot })
 *   .note(midi) → lane 1..8 | null   (null: not in the key — does nothing). Updates the octave (lowRoot) per the rules.
 *   .chord(midis[], { root?: pc, quality? }) → { keyChanged: boolean, lanes: number[] }
 *   .state → { tonicPc, mode, lowRoot, name: 'C major' }
 * Octave rules: lowRoot is a MIDI number with pitch class tonicPc; the octave is lowRoot..lowRoot+12.
 *   - tonic == lowRoot → lane 1; tonic == lowRoot+12 → lane 8; tonic above lowRoot+12 → lowRoot = midi−12, lane 8;
 *     tonic below lowRoot → lowRoot = midi, lane 1.
 *   - non-tonic diatonic note → lowRoot = the tonic at or below it (octave containing the note); lane = degree+1.
 * Key change: a chord of ≥ 3 detected pitches (voices; the same pitch class in two octaves counts twice) whose pitch
 *   classes are not all in the current key → the key becomes the chord's root + mode (major chord → major key, minor
 *   chord → natural minor; other/unknown quality → keep the current mode). lowRoot = the new tonic at or below the
 *   chord's lowest note. Diatonic chords never change the key (C major: C → Cm switches, C → Dm does not).
 * GuitarInput (src/input/guitar.js): new GuitarInput(app, { recognizer? }) wraps tuninator's createRecognizer, maps
 *   Notes to app.input.impulse / release, logs key changes as cfg 'guitar.key' ('C minor'). start() needs a user gesture.
 *   app.guitar.status = { state:'off'|'starting'|'listening'|'error', message, key, lowRoot, last:{ name, lane, t } }
 */
export const GUITAR = { initialLowRoot: 48 /* C3 = low E fret 8 */, lowestMidi: 40 /* E2 */ };
export const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };

// ---------------------------------------------------------------- beat (src/beat/*, WP11)
/**
 * 4/4 bar clock at cfg.bpm; a bpm change applies from the next downbeat (the bar in progress keeps its length).
 * Beat (pure sim, src/beat/beat.js): constructor(cfg) · reset() · step(t, dt, events)
 *   .measure (index of the current measure, 0 at t = 0) · .measureT0 · .measureLen (s) · .beatLen (s)
 *   .notes (count of 'on' events in the current measure so far) · .level (1..8, current measure) · .target
 *   .measures: completed { index, t0, t1, notes, target, level } (ring) · .events: BeatEvent[] (ring)
 *   BeatEvent { t, type:'downbeat', index, level, prevLevel, change: -1|0|1 }
 *   barPhase(t) → { measure, beat (0..3), frac } for t within the current/next measure (audio + fx)
 * Level rule: level starts at 1. At each downbeat: target = clamp(notes in the measure that just ended, 1, 8);
 *   level += sign(target − level)  (one step per measure at most).
 * BeatAudio (src/beat/BeatAudio.js): Web Audio synth (surf/tropical groove, 8 patterns, level 1 = metronome with an
 *   accented 1). Output only — never feeds the sim. Scheduled from sim time with a constant latency; silent while
 *   paused and in capture mode.
 * Step order: input → swell → beat → riders(swell, beat) → fx → camera.
 */

// ---------------------------------------------------------------- note splash + birds (src/fx/*, WP12)
/**
 * Every 'on' impulse (ImpulseFx) → a massive splash where it lands + cfg.birds.perNote bird that bursts out of the
 * splash, circles above the lineup for a while (~6–10 s) and then flies away up into the dawn sky ("the note
 * escaping Galatea"). Every riders 'flock' event → cfg.birds.flock birds burst from that rider. All analytic in
 * (t − t0, seed): pure functions of state and t, instanced, capped at cfg.birds.max (oldest culled first).
 */

// ---------------------------------------------------------------- app / systems (src/core/App.js, WP1)
/**
 * Every system: optional step(t, dt) (fixed sim step, deterministic), update(t) (per rendered frame, pure
 * function of state + t), dispose(). Constructed as new X(app).
 * app = { renderer, scene, camera (main view), sunDir (THREE.Vector3), cfg, input, swell, riders,
 *         createPost(w,h) → Post, post (main Post), hud, simTime,
 *         ocean (setWaveHook(glsl, uniforms), fft {disp, slope, uniforms, glsl, L, rot, N}), sky, envMap, sunLight,
 *         waterUniforms (spread into materials using src/water/waterShading.glsl.js), gpuTimer, paused, capture }
 * Post.render(scene, camera, target = null, viewport = null)   viewport = {x,y,w,h} px of the drawing buffer
 * Step order per sim step: input.drainUntil(t) → swell.step → riders.step → fx.step → camera.step
 * Frame: systems.update(t) → camera.render(app) (main view + PiP) → hud.update
 * Test hooks: window.__ready (Promise), window.__advance(sec) → simTime (steps + renders once, sync),
 *   window.__simTime(), window.__loadInput(log), window.__setCfg(k, v)
 * URL: ?capture=1 (no RAF loop, manual stepping, HMR off) ?demo=<path> (load input log) ?t0=<s> (sim-only fast-forward)
 */

// ---------------------------------------------------------------- seeded randomness
export function hash01(a, b = 0, c = 0) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
