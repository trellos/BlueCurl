// BlueCurl Swell — beat patterns (WP11). Pure data: the hits of one 4/4 measure for a level 1..8.
// A measure is 16 sixteenth-steps (step 0 = the downbeat "1", 4 = "2", 8 = "3", 12 = "4"; odd steps = "e"/"a",
// steps 2/6/10/14 = the "&"s). Surf/tropical groove that builds one layer per level:
//   1 metronome   2 + kick   3 + hats   4 backbeat   5 + shaker   6 + congas/bongos   7 + rim/open hats/tom fills
//   8 full groove (clave, 16th hats, syncopated kick, crash every 4 bars, long fill every 4th bar)
// The fill variants depend only on the measure index, so the audio is a pure function of (level, measure).

/** Instrument ids (BeatAudio has a synth voice for each). */
export const INSTRUMENTS = ['clickHi', 'click', 'kick', 'hat', 'ohat', 'clap', 'rim', 'shaker',
  'congaHi', 'congaLo', 'bongo', 'tomHi', 'tomMid', 'tomLo', 'crash', 'clave'];

export const LEVEL_NAMES = ['', 'metronome', 'kick', 'hats', 'backbeat', 'shaker', 'congas', 'fills', 'full groove'];

const EIGHTHS = [0, 2, 4, 6, 8, 10, 12, 14];
const OFFBEATS = [2, 6, 10, 14];

/**
 * Hits of measure `measure` at `level` → [{ step, inst, vel }] sorted by step (vel 0..1).
 * Pure; the same (level, measure) always returns equal arrays.
 */
export function patternHits(level, measure = 0) {
  const L = Math.max(1, Math.min(8, Math.round(level) || 1));
  const m = Math.max(0, measure | 0);
  const H = [];
  const add = (step, inst, vel) => H.push({ step, inst, vel });

  if (L === 1) {                                     // metronome: accented high click on the 1
    add(0, 'clickHi', 1.0);
    for (const s of [4, 8, 12]) add(s, 'click', 0.55);
  } else if (L === 2) {                              // + kick on 1 and 3 (clicks keep the count)
    add(0, 'clickHi', 0.8);
    for (const s of [4, 8, 12]) add(s, 'click', 0.45);
    add(0, 'kick', 0.95); add(8, 'kick', 0.8);
  } else if (L === 3) {                              // + 8th hats (offbeats louder), click only on the 1
    add(0, 'clickHi', 0.55);
    add(0, 'kick', 1.0); add(8, 'kick', 0.85);
    for (const s of EIGHTHS) add(s, 'hat', OFFBEATS.includes(s) ? 0.7 : 0.4);
  } else if (L === 4) {                              // backbeat: clap on 2 and 4
    add(0, 'kick', 1.0); add(8, 'kick', 0.85);
    add(4, 'clap', 0.85); add(12, 'clap', 0.85);
    for (const s of EIGHTHS) add(s, 'hat', OFFBEATS.includes(s) ? 0.7 : 0.4);
  } else {                                           // 5..8 share the core groove
    const fill7 = L === 7 && m % 2 === 1;            // short tom fill on beat 4 of every 2nd bar
    const fill8 = L === 8 && m % 4 === 3;            // long fill over beats 3–4 of every 4th bar
    const fillFrom = fill8 ? 8 : fill7 ? 12 : 16;    // steps >= fillFrom belong to the fill

    // kick
    const kicks = L === 8 ? [[0, 1.0], [6, 0.7], [8, 0.9], [11, 0.6]] : [[0, 1.0], [6, 0.65], [8, 0.85]];
    for (const [s, v] of kicks) if (s < fillFrom || s === 8) add(s, 'kick', v);
    // clap backbeat (L7/L8 fills keep the clap on 2 only)
    add(4, 'clap', 0.85);
    if (12 < fillFrom) add(12, 'clap', 0.85);
    // hats: L5/L6 8ths; L7 closed on the beat + open on the "&"; L8 16ths closed + open "&"
    if (L <= 6) for (const s of EIGHTHS) add(s, 'hat', OFFBEATS.includes(s) ? 0.65 : 0.38);
    else if (L === 7) for (const s of EIGHTHS) add(s, OFFBEATS.includes(s) ? 'ohat' : 'hat', OFFBEATS.includes(s) ? 0.5 : 0.45);
    else for (let s = 0; s < 16; s++) {
      if (s >= fillFrom && s % 2 === 1) continue;
      add(s, OFFBEATS.includes(s) ? 'ohat' : 'hat', OFFBEATS.includes(s) ? 0.5 : (s % 4 === 0 ? 0.42 : 0.26));
    }
    // shaker 16ths (soft, "&"s and "a"s pushed)
    for (let s = 0; s < 16; s++) if (s < fillFrom) add(s, 'shaker', s % 4 === 0 ? 0.32 : s % 2 === 1 ? 0.4 : 0.22);
    // congas / bongos (tumbao-ish: open low tones on "2&" and "4&")
    if (L >= 6) {
      for (const [s, inst, v] of [[2, 'bongo', 0.45], [3, 'congaHi', 0.6], [6, 'congaLo', 0.75], [10, 'bongo', 0.45],
        [11, 'congaHi', 0.6], [14, 'congaLo', 0.75]]) if (s < fillFrom) add(s, inst, v);
    }
    // rim clicks (L7+): "1a", "3&"
    if (L >= 7) for (const s of [3, 10]) if (s < fillFrom) add(s, 'rim', 0.55);
    // clave (L8): son clave 3-2 on the 16 grid
    if (L === 8) for (const s of [0, 3, 6, 10, 12]) if (s < fillFrom) add(s, 'clave', 0.5);
    // crash on the 1 of every 4th bar (L8)
    if (L === 8 && m % 4 === 0) add(0, 'crash', 0.6);
    // fills
    if (fill7) for (const [s, inst] of [[12, 'tomHi'], [13, 'tomHi'], [14, 'tomMid'], [15, 'tomLo']]) add(s, inst, 0.8);
    if (fill8) {
      for (const [s, inst, v] of [[8, 'tomHi', 0.7], [9, 'tomHi', 0.6], [10, 'tomHi', 0.75], [11, 'tomMid', 0.65],
        [12, 'tomMid', 0.8], [13, 'tomMid', 0.7], [14, 'tomLo', 0.9], [15, 'tomLo', 0.95]]) add(s, inst, v);
    }
  }
  H.sort((a, b) => a.step - b.step);
  return H;
}
