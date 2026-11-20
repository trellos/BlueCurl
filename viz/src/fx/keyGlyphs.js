// BlueCurl Swell — key-flock letters (WP15): a thin block stroke font for the key names the guitar mapper produces
// ('C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B' + ' major' / ' minor') and the bird slots along
// it. Pure, no three.js.
//
// Glyph units: cap height 1, baseline y = 0, x from 0 to the glyph width. Each glyph is a list of polylines
// (strokes). Corners are chamfered (block letters, no curves) so a few birds per stroke still read.

/** Stroke glyphs. w = advance width (without the gap). */
export const GLYPHS = {
  A: { w: 0.66, s: [[[0, 0], [0.33, 1], [0.66, 0]], [[0.13, 0.38], [0.53, 0.38]]] },
  B: { w: 0.6, s: [[[0, 0], [0, 1], [0.44, 1], [0.54, 0.9], [0.54, 0.62], [0.44, 0.52], [0, 0.52]],
    [[0.44, 0.52], [0.6, 0.42], [0.6, 0.1], [0.5, 0], [0, 0]]] },
  C: { w: 0.6, s: [[[0.6, 1], [0.12, 1], [0, 0.88], [0, 0.12], [0.12, 0], [0.6, 0]]] },
  D: { w: 0.62, s: [[[0, 0], [0, 1], [0.4, 1], [0.62, 0.78], [0.62, 0.22], [0.4, 0], [0, 0]]] },
  E: { w: 0.56, s: [[[0.56, 1], [0, 1], [0, 0], [0.56, 0]], [[0, 0.52], [0.44, 0.52]]] },
  F: { w: 0.56, s: [[[0.56, 1], [0, 1], [0, 0]], [[0, 0.52], [0.44, 0.52]]] },
  G: { w: 0.62, s: [[[0.6, 1], [0.12, 1], [0, 0.88], [0, 0.12], [0.12, 0], [0.62, 0], [0.62, 0.46], [0.32, 0.46]]] },
  // accidentals + minor: sharp is a raised, smaller hash; flat is a lowercase b with a full ascender
  '#': { w: 0.44, s: [[[0.13, 0.36], [0.15, 1.0]], [[0.3, 0.36], [0.32, 1.0]], [[0, 0.56], [0.44, 0.56]], [[0, 0.82], [0.44, 0.82]]] },
  b: { w: 0.44, s: [[[0, 1], [0, 0], [0.34, 0], [0.44, 0.1], [0.44, 0.48], [0.34, 0.58], [0, 0.58]]] },
  m: { w: 0.66, s: [[[0, 0], [0, 0.58]], [[0, 0.48], [0.1, 0.58], [0.25, 0.58], [0.33, 0.5], [0.33, 0]],
    [[0.33, 0.5], [0.41, 0.58], [0.56, 0.58], [0.66, 0.48], [0.66, 0]]] },
};
export const GLYPH_GAP = 0.2;

/** Key name ('E major', 'C minor', 'F# minor', 'Bb major', 'C♯ minor', 'Cm', 'A') → label ('E', 'Cm', 'F#m', 'Bb', …). */
export function keyLabel(name) {
  const s = String(name ?? '').trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  const m = /^([A-Ga-g])([#b]?)\s*(.*)$/.exec(s);
  if (!m) return '';
  const rest = m[3].toLowerCase();
  const minor = /^(m|min|minor|-)\b/.test(rest) || rest === 'm';
  return m[1].toUpperCase() + m[2] + (minor ? 'm' : '');
}

const segLen = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const polyLen = (p) => { let L = 0; for (let i = 1; i < p.length; i++) L += segLen(p[i - 1], p[i]); return L; };

/**
 * Lay out a label: strokes in label units (cap height 1), horizontally centred on x = 0, vertically centred on the
 * cap height (y ∈ [-0.5, 0.5]). Returns { strokes: [[x,y]...][], width, length }. Unknown characters are skipped.
 */
export function layoutLabel(label) {
  const strokes = [];
  let x = 0, first = true;
  for (const ch of String(label)) {
    const g = GLYPHS[ch];
    if (!g) continue;
    if (!first) x += GLYPH_GAP;
    first = false;
    for (const st of g.s) strokes.push(st.map(([px, py]) => [x + px, py]));
    x += g.w;
  }
  const width = x, cx = width / 2;
  for (const st of strokes) for (const p of st) { p[0] -= cx; p[1] -= 0.5; }
  let length = 0;
  for (const st of strokes) length += polyLen(st);
  return { strokes, width, length };
}

/** Point at arc length d along polyline p. */
function along(p, d, out) {
  for (let i = 1; i < p.length; i++) {
    const L = segLen(p[i - 1], p[i]);
    if (d <= L || i === p.length - 1) {
      const u = L > 0 ? Math.min(1, Math.max(0, d / L)) : 0;
      out[0] = p[i - 1][0] + (p[i][0] - p[i - 1][0]) * u; out[1] = p[i - 1][1] + (p[i][1] - p[i - 1][1]) * u;
      return out;
    }
    d -= L;
  }
  out[0] = p[0][0]; out[1] = p[0][1];
  return out;
}

/**
 * n bird slots along the label's strokes: each stroke gets a share proportional to its length (largest remainder,
 * at least 2 so both ends are marked when n allows) and its birds sit evenly from end to end.
 * Returns { pts: Float32Array(2n) (label units), width, length, spacing (label units between neighbours) }.
 */
export function labelSlots(label, n) {
  const L = layoutLabel(label);
  const pts = new Float32Array(2 * Math.max(0, n));
  const ns = L.strokes.length;
  if (!ns || n <= 0) return { pts, width: L.width, length: L.length, spacing: 0, n: 0 };
  const lens = L.strokes.map(polyLen);
  const minPer = n >= 2 * ns ? 2 : n >= ns ? 1 : 0;
  const count = lens.map(() => minPer);
  let left = n - minPer * ns;
  const want = lens.map((l) => (l / L.length) * left);
  const fl = want.map(Math.floor);
  fl.forEach((f, i) => { count[i] += f; left -= f; });
  const order = want.map((w, i) => [w - fl[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < left; k++) count[order[k % ns][1]]++;
  const tmp = [0, 0];
  let j = 0;
  for (let s = 0; s < ns; s++) {
    const c = count[s];
    for (let k = 0; k < c; k++) {
      along(L.strokes[s], c > 1 ? (lens[s] * k) / (c - 1) : lens[s] / 2, tmp);
      pts[2 * j] = tmp[0]; pts[2 * j + 1] = tmp[1]; j++;
    }
  }
  return { pts, width: L.width, length: L.length, spacing: L.length / Math.max(1, n - ns), n: j };
}
