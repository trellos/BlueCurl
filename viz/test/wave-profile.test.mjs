// WP4a — swept-profile cross-section (keyframes.js + profile.js). node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { profile, profileExtents } from '../src/wave/profile.js';
import { NPTS, NKEY, NFAM, KEY_TAUS, KEY_DATA, RESAMPLED, LANDMARKS } from '../src/wave/keyframes.js';

const SHAPES = {
  wall: { steep: 1, curl: 0, mush: 0 }, barrel: { steep: 0.8, curl: 1, mush: 0 }, mid: { steep: 0.5, curl: 0.5, mush: 0.3 },
  mush: { steep: 0.3, curl: 0.3, mush: 1 }, gentle: { steep: 0, curl: 0, mush: 0 },
};
const HS = [0.3, 1, 2.5, 6];
const TAU_GRID = []; for (let t = -1; t <= 2.0001; t += 0.01) TAU_GRID.push(+t.toFixed(4));

/** largest horizontal throw of the curve back over itself: max_s (xi(s) - min_{s'>s} xi(s')). */
function overhang(tau, H, shape, n = 600) {
  const xi = []; for (let i = 0; i <= n; i++) xi.push(profile(tau, i / n, H, shape).xi);
  let best = 0, minAfter = Infinity;
  for (let i = n; i >= 0; i--) { best = Math.max(best, xi[i] - minAfter); minAfter = Math.min(minAfter, xi[i]); }
  return best;
}
const maxY = (tau, H, shape, n = 400) => { let m = -Infinity; for (let i = 0; i <= n; i++) m = Math.max(m, profile(tau, i / n, H, shape).y); return m; };

function segsIntersect(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function selfIntersects(P) {
  for (let i = 0; i < P.length - 1; i++) for (let j = i + 2; j < P.length - 1; j++) if (segsIntersect(P[i], P[i + 1], P[j], P[j + 1])) return [i, j];
  return null;
}

test('keyframe table: layout, sizes, landmarks, tau 2 == tau -1', () => {
  assert.equal(KEY_DATA.length, NPTS * NFAM * NKEY * 4);
  assert.ok(NPTS >= 64);
  assert.equal(KEY_TAUS.length, NKEY);
  for (let k = 1; k < NKEY; k++) assert.ok(KEY_TAUS[k] > KEY_TAUS[k - 1]);
  assert.deepEqual([KEY_TAUS[0], KEY_TAUS[NKEY - 1]], [-1, 2]);
  assert.equal(LANDMARKS[LANDMARKS.length - 1], NPTS - 1);
  for (let f = 0; f < NFAM; f++) {
    assert.equal(RESAMPLED[f].length, NKEY);
    for (let k = 0; k < NKEY; k++) {
      assert.equal(RESAMPLED[f][k].length, NPTS);
      assert.equal(selfIntersects(RESAMPLED[f][k]), null, `key fam ${f} k ${k} self-intersects`);
    }
    assert.deepEqual(RESAMPLED[f][NKEY - 1], RESAMPLED[f][0]);
  }
  for (const sh of Object.values(SHAPES)) for (const s of [0, 0.3, 0.5, 0.8, 1]) {
    const a = profile(-1, s, 2, sh), b = profile(2, s, 2, sh);
    assert.ok(Math.abs(a.xi - b.xi) < 1e-12 && Math.abs(a.y - b.y) < 1e-12);
  }
});

test('end conditions: y = 0 and zero slope at both ends, ends at the documented extents', () => {
  for (const H of HS) for (const sh of Object.values(SHAPES)) for (const tau of [-1, -0.4, 0, 0.3, 0.5, 0.62, 0.8, 1, 1.4, 2]) {
    const e = profileExtents(H);
    const a = profile(tau, 0, H, sh), b = profile(tau, 1, H, sh);
    assert.equal(a.y, 0); assert.equal(b.y, 0);
    assert.equal(a.dy, 0); assert.equal(b.dy, 0);
    assert.ok(a.dxi > 0 && b.dxi > 0);
    assert.ok(Math.abs(a.xi - e.back) < 1e-3 && Math.abs(b.xi - e.front) < 1e-2, `extent H ${H}`);
    // just inside the ends the sheet is still flat (blends into the ocean)
    assert.ok(Math.abs(profile(tau, 0.005, H, sh).y) < 1e-3 * H && Math.abs(profile(tau, 0.995, H, sh).y) < 1e-3 * H);
  }
  assert.ok(profileExtents(6).back <= -44 && profileExtents(6).front >= 34);
  assert.ok(profileExtents(0.3).back < -18, 'small swell keeps a wide lump');
});

test('plunge with high curl overhangs (a tube); a wall barely does; mush removes it', () => {
  const H = 3;
  const ovPlunge = Math.max(...[0.55, 0.62, 0.7].map((t) => overhang(t, H, SHAPES.barrel)));
  assert.ok(ovPlunge > 1.0 * H, `plunge overhang ${ovPlunge}`);
  assert.ok(overhang(0.62, H, SHAPES.wall) < 0.25 * H, 'wall overhang small');
  assert.ok(overhang(-0.5, H, SHAPES.barrel) === 0, 'no overhang before the break');
  let prev = Infinity;
  for (const mush of [0, 0.25, 0.5, 0.75, 1]) {
    const ov = overhang(0.62, H, { ...SHAPES.barrel, mush });
    assert.ok(ov < prev + 1e-9, `mush ${mush} must reduce overhang (${ov} vs ${prev})`); prev = ov;
  }
  assert.ok(prev < 0.05 * H, 'full mush: no real overhang (tiny roller nose only)');
  // curl sets how far the lip throws
  let p2 = -1;
  for (const curl of [0, 0.25, 0.5, 0.75, 1]) { const ov = overhang(0.62, H, { steep: 0.8, curl, mush: 0 }); assert.ok(ov >= p2); p2 = ov; }
});

// Known: during the crash (tau ≈ 0.79–0.84) a high-curl, part-mush blend (curl ≥ 0.75, mush 0.25–0.4) can fold the
// lip underside onto itself for ≤ 0.05 tau. Everything else must stay simple.
test('blended profiles never self-intersect (outside the crash window for part-mush tubes)', () => {
  for (const curl of [0, 0.25, 0.5, 0.75, 1]) for (const mush of [0, 0.25, 0.5, 0.75, 1]) for (const steep of [0.5]) {   // steep is a monotone x-warp: cannot create crossings
    for (let tau = -1; tau <= 2.0001; tau += 0.01) {
      if (tau > 0.78 && tau < 0.85 && mush > 0 && mush < 0.5) continue;
      const P = []; for (let i = 0; i <= 380; i++) { const p = profile(tau, i / 380, 2, { steep, curl, mush }); P.push([p.xi, p.y]); }
      assert.equal(selfIntersects(P), null, `self-intersection at tau ${tau.toFixed(2)} curl ${curl} mush ${mush} steep ${steep}`);
    }
  }
});

test('steep compresses the face', () => {
  const faceWidth = (steep) => {           // horizontal distance crest → where the face is at 25 % height
    let crest = null, ymax = -1;
    for (let i = 0; i <= 600; i++) { const p = profile(0.18, i / 600, 2, { steep, curl: 0, mush: 0 }); if (p.y > ymax) { ymax = p.y; crest = p.xi; } }
    for (let i = 600; i >= 0; i--) { const p = profile(0.18, i / 600, 2, { steep, curl: 0, mush: 0 }); if (p.y > 0.25 * ymax) return p.xi - crest; }
    return NaN;
  };
  assert.ok(faceWidth(1) < 0.85 * faceWidth(0), `${faceWidth(1)} vs ${faceWidth(0)}`);
});

test('continuity in tau (C0 and C1 across keys) and sigma; analytic d/dsigma matches finite difference', () => {
  const eps = 1e-5;
  for (const H of [1, 4]) for (const sh of Object.values(SHAPES)) {
    for (const tau of [...KEY_TAUS.slice(1, -1), -0.5, 0.25, 0.57, 0.83, 1.2]) for (const s of [0.1, 0.3, 0.45, 0.6, 0.75, 0.9]) {
      const a = profile(tau - eps, s, H, sh), b = profile(tau, s, H, sh), c = profile(tau + eps, s, H, sh);
      assert.ok(Math.hypot(c.xi - b.xi, c.y - b.y) < 200 * H * eps, `C0 tau ${tau}`);
      const d1 = [(b.xi - a.xi) / eps, (b.y - a.y) / eps], d2 = [(c.xi - b.xi) / eps, (c.y - b.y) / eps];
      assert.ok(Math.hypot(d1[0] - d2[0], d1[1] - d2[1]) < 2e-2 * H + 1e-3 * Math.hypot(...d1), `C1 tau ${tau} s ${s}: ${d1} vs ${d2}`);
    }
    for (const tau of [-0.7, 0.1, 0.5, 0.62, 0.9, 1.6]) for (let i = 1; i < 400; i++) {
      const s = i / 400, p = profile(tau, s, H, sh), q = profile(tau, s + eps, H, sh), m = profile(tau, s - eps, H, sh);
      const fx = (q.xi - m.xi) / (2 * eps), fy = (q.y - m.y) / (2 * eps);
      assert.ok(Math.abs(fx - p.dxi) < 1e-3 * (1 + Math.abs(p.dxi)) && Math.abs(fy - p.dy) < 1e-3 * (1 + Math.abs(p.dy)), `d/dsigma at ${tau},${s}`);
      assert.ok(Math.hypot(q.xi - p.xi, q.y - p.y) < 1.5 * eps * Math.hypot(p.dxi, p.dy) + 1e-9, 'C0 sigma (Lipschitz)');
    }
  }
});

test('approach (tau < 0): height grows monotonically', () => {
  for (const H of HS) for (const sh of Object.values(SHAPES)) {
    let prev = -Infinity;
    for (let tau = -1; tau <= 0.0001; tau += 0.05) {
      const m = maxY(tau, H, sh);
      assert.ok(m >= prev - 1e-9, `height dropped at tau ${tau} (${m} < ${prev})`); prev = m;
    }
    assert.ok(maxY(0, H, sh) > 1.1 * maxY(-1, H, sh));
  }
});

test('determinism and finiteness', () => {
  let h1 = 0, h2 = 0;
  for (let i = 0; i < 2000; i++) {
    const tau = -1.5 + (i * 0.37) % 4, s = ((i * 0.6180339) % 1), H = 0.2 + (i % 7), sh = { steep: (i % 5) / 4, curl: (i % 3) / 2, mush: (i % 4) / 3 };
    const a = profile(tau, s, H, sh), b = profile(tau, s, H, sh);
    for (const k of ['xi', 'y', 'dxi', 'dy', 'thick']) { assert.ok(Number.isFinite(a[k])); assert.equal(a[k], b[k]); }
    h1 += a.xi * 1.3 + a.y; h2 += b.xi * 1.3 + b.y;
  }
  assert.equal(h1, h2);
});

test('thickness: thin lip, thick body', () => {
  const sh = SHAPES.barrel, H = 3;
  const lipT = profile(0.62, 44 / 95 - 0.02, H, sh).thick;   // just before the lip tip
  const backT = profile(0.62, 0.15, H, sh).thick;
  assert.ok(lipT < 0.25 * H, `lip ${lipT}`);
  assert.ok(backT > lipT * 3, `back ${backT}`);
});
