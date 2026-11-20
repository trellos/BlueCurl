// Spot bathymetry + layout tests (WP2). Numbers derive from contracts ZONES / PATH and SPOT (bathymetry.js).
// GPU parity of BATHY_GLSL vs depthAt is checked in dev/spot.html?parity=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depthAt, headlandS, xBay, xEast, bathyParts, SPOT } from '../src/spot/bathymetry.js';
import { buildLayout, SPOT_CAMERAS, sightTargets, clearOfSightlines } from '../src/spot/layout.js';
import { ZONES, PATH, uToZ } from '../src/contracts.js';
import { PRESETS } from '../src/camera/wide.js';

const range = (a, b, step) => { const o = []; for (let v = a; v <= b + 1e-9; v += step) o.push(v); return o; };
const zone = (key) => ZONES.find((z) => z.key === key);
const zr = (zn) => [uToZ(zn.u0), uToZ(zn.u1)];

test('zone depths on the break lines', () => {
  // outer ~4 m (H up to ~6 m breaks), point ~2.2 m, inside ~1 m — over each zone's crest range
  const cases = [['outer', 3.5, 4.6], ['point', 1.8, 2.6], ['inside', 0.7, 1.3]];
  for (const [key, lo, hi] of cases) {
    const zn = zone(key), [z0, z1] = zr(zn);
    for (const z of range(z0, z1, 3)) {
      const d = depthAt(zn.lineX, z);
      assert.ok(d >= lo && d <= hi, `${key} depth at (${zn.lineX}, ${z.toFixed(0)}) = ${d.toFixed(2)} not in [${lo}, ${hi}]`);
    }
  }
});

test('break zones sit on shallow features surrounded by deeper water; deep water offshore', () => {
  const O = zone('outer'), P = zone('point'), I = zone('inside');
  const zo = (zr(O)[0] + zr(O)[1]) / 2, zp = (zr(P)[0] + zr(P)[1]) / 2, zi = (zr(I)[0] + zr(I)[1]) / 2;
  assert.ok(depthAt(O.lineX, zo) + 3 < depthAt(O.lineX + 50, zo), 'outer reef stands above the sea floor seaward');
  assert.ok(depthAt(O.lineX, zo) + 3 < depthAt(O.lineX, zr(O)[1] + 70), 'outer reef has deep water to the north');
  assert.ok(depthAt(P.lineX, zp) + 1.5 < depthAt(P.lineX + 35, zp), 'point shelf drops off seaward');
  assert.ok(depthAt(I.lineX, zi) + 0.8 < depthAt(I.lineX - 18, zi), 'inside sandbar has a trough behind it');
  for (const z of range(-180, 180, 12)) {
    const d = depthAt(400, z);
    assert.ok(d >= 20 && d <= 32, `~25 m by x=400 (z=${z}): ${d.toFixed(1)}`);
    assert.ok(depthAt(PATH[0].x, z) > d, 'deeper toward the horizon spawn');
  }
});

test('land above water: headland and beach', () => {
  for (const [x, z] of [[SPOT.tipX - 10, SPOT.tipZ], [SPOT.headX - 10, SPOT.headZ + 15], [20, 60], [0, 150], [-60, 90]]) {
    assert.ok(depthAt(x, z) < -5, `headland (${x}, ${z}) is land: ${depthAt(x, z).toFixed(1)}`);
  }
  assert.ok(depthAt(SPOT.tipX + 6, SPOT.tipZ) > 0, 'water just off the tip');
  assert.ok(Math.abs(xEast(SPOT.tipZ) - SPOT.tipX) < 2, 'tip position');
  for (const z of [120, 140, 160]) {
    const xe = xEast(z);
    assert.ok(depthAt(xe - 10, z) < -25 && depthAt(xe + 5, z) > 0, `~30 m east cliff at z=${z}: ${depthAt(xe - 10, z).toFixed(1)}`);
  }
  for (const z of range(SPOT.beachZ0, SPOT.beachZ1, 6)) {
    assert.ok(Math.abs(xBay(z)) < 4, `beach line near x=0 at z=${z}: ${xBay(z).toFixed(1)}`);
    assert.ok(depthAt(-7, z) < -0.3, `beach dry at (-7, ${z})`);
    assert.ok(depthAt(7, z) > 0.3, `water at (7, ${z})`);
  }
});

test('continuity: no underwater cliffs away from the headland', () => {
  const h = 0.6;
  let worst = 0, at = null;
  for (let x = -25; x <= 560; x += 2) {
    for (let z = -280; z <= 280; z += 2) {
      const d = depthAt(x, z);
      assert.ok(Number.isFinite(d), `finite at (${x}, ${z})`);
      if (d < 0.3 || headlandS(x, z) > -10) continue;
      const g = Math.hypot(depthAt(x + h, z) - depthAt(x - h, z), depthAt(x, z + h) - depthAt(x, z - h)) / (2 * h);
      if (g > worst) { worst = g; at = [x, z]; }
    }
  }
  assert.ok(worst < 0.8, `max underwater slope ${worst.toFixed(3)} at ${at}`);
  let jump = 0;
  for (let x = -40; x <= 130; x += 0.4) for (let z = 0; z <= 200; z += 5) jump = Math.max(jump, Math.abs(depthAt(x + 0.4, z) - depthAt(x, z)));
  assert.ok(jump < 4, `max change per 0.4 m: ${jump.toFixed(2)} m`);
});

test('bathyParts agrees with depthAt', () => {
  for (const [x, z] of [[180, 60], [100, 0], [33, -80], [-70, 90], [70, 57], [-200, -300], [900, 900]]) {
    assert.ok(Math.abs(bathyParts(x, z).depth - depthAt(x, z)) < 1e-9);
  }
});

test('terrain never blocks the break zones from the camera poses', () => {
  const targets = sightTargets(6).filter((t) => t[1] < 1);
  for (const [name, cam] of Object.entries(SPOT_CAMERAS)) {
    const [cx, cy, cz] = cam.pos;
    assert.ok(cy + depthAt(cx, cz) > 8, `${name} camera at least 8 m above ground`);
    for (const t of targets) {
      for (let i = 1; i < 92; i++) {
        const s = i / 100, x = cx + (t[0] - cx) * s, y = cy + (t[1] - cy) * s, z = cz + (t[2] - cz) * s;
        const clear = y + depthAt(x, z);
        assert.ok(clear > 2, `${name}: terrain within ${clear.toFixed(1)} m of the sightline to ${t[3]} (${t[0]}, ${t[2].toFixed(0)}) at (${x.toFixed(0)}, ${z.toFixed(0)})`);
      }
    }
  }
});

test('default camera frames all three zones, point at 180-230 m, sun in frame, PiP corner clear', () => {
  const { pos, target, fov } = SPOT_CAMERAS.default;
  const sub = (a, b) => a.map((v, i) => v - b[i]), norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const f = norm(sub(target, pos)), r = norm([-f[2], 0, f[0]]);
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const th = Math.tan(fov / 2 * Math.PI / 180), asp = 16 / 9;
  const ndc = (d) => { const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2]; return [(d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / (z * th * asp), (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / (z * th), z]; };
  for (const zn of ZONES) {
    for (const z of range(...zr(zn), 6)) {
      const [sx, sy, sz] = ndc(sub([zn.lineX, 0.5, z], pos));
      assert.ok(sz > 0 && Math.abs(sx) < 0.93 && sy > -0.93 && sy < 0.9, `${zn.key} z=${z.toFixed(0)} in frame (${sx.toFixed(2)}, ${sy.toFixed(2)})`);
      assert.ok(!(sx > 1 / 3 && sy < -1 / 3), `${zn.key} z=${z.toFixed(0)} not under the PiP`);
    }
  }
  const P = zone('point'), [p0, p1] = zr(P);
  const dPt = Math.hypot(P.lineX - pos[0], (p0 + p1) / 2 - pos[2]);
  assert.ok(dPt >= 180 && dPt <= 230, `point ${dPt.toFixed(0)} m from the camera`);
  const el = 6 * Math.PI / 180, az = 108 * Math.PI / 180;      // sky/skyModel.js SUN
  const [sx, sy] = ndc([Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)]);
  assert.ok(Math.abs(sx) < 0.9 && sy < 0.9 && sy > -0.2, `sun in frame (${sx.toFixed(2)}, ${sy.toFixed(2)})`);
});

test('camera mirrors match WP7 presets; default stands on the headland', () => {
  for (const k of ['lineup', 'point']) {
    assert.deepEqual(SPOT_CAMERAS[k].pos, PRESETS[k].position, k);
    assert.deepEqual(SPOT_CAMERAS[k].target, PRESETS[k].target, k);
    assert.equal(SPOT_CAMERAS[k].fov, PRESETS[k].fov, k);
  }
  const [cx, , cz] = SPOT_CAMERAS.default.pos;
  assert.ok(depthAt(cx, cz) < 0 && headlandS(cx, cz) > 0, 'default camera stands on the headland');
});

test('sea stacks stand out of every front path, against the headland', () => {
  const { stacks } = buildLayout();
  assert.ok(stacks.length >= 3, `stacks: ${stacks.length}`);
  for (const s of stacks) {
    const inFrontPath = s.z < 36 || s.x >= 66;        // fronts fade only for z > ~36 once x < 66
    assert.ok(!inFrontPath && ((s.x < 62 && s.z > 45) || s.z > 150), `stack at (${s.x}, ${s.z}) is in a front's path`);
    assert.ok(headlandS(s.x, s.z) > -3, `stack at (${s.x}, ${s.z}) touches the headland base`);
  }
  for (const r of buildLayout().rocks) {
    const wet = depthAt(r.x, r.z) > -0.3;
    assert.ok(!wet || (r.x < 64 && r.z > 40) || r.z > 150, `wet boulder at (${r.x.toFixed(0)}, ${r.z.toFixed(0)}) in a front's path`);
  }
});

test('layout: deterministic, palm count, props clear of sightlines and break lines', () => {
  const a = buildLayout(), b = buildLayout();
  assert.deepEqual(a, b);
  assert.ok(a.palms.length >= 20 && a.palms.length <= 40, `palms: ${a.palms.length}`);
  const cams = Object.values(SPOT_CAMERAS), targets = sightTargets(6);
  for (const p of a.palms) assert.ok(clearOfSightlines(p.x, p.z, 5.5 * p.scale, p.y + (p.variant ? 10.5 : 14) * p.scale, cams, targets, 0.5), `palm at ${p.x.toFixed(0)},${p.z.toFixed(0)}`);
  for (const s of a.stacks) assert.ok(clearOfSightlines(s.x, s.z, s.r, s.y + s.h, cams, targets, 0.5), `stack at ${s.x},${s.z}`);
  for (const r of a.rocks) assert.ok(clearOfSightlines(r.x, r.z, 0.5 * Math.max(r.sx, r.sz), r.y + r.sy, cams, targets, 0.2), `rock at ${r.x.toFixed(0)},${r.z.toFixed(0)}`);
  for (const zn of ZONES) {
    const [z0, z1] = zr(zn);
    for (const p of [...a.rocks, ...a.stacks]) {
      const onLine = Math.abs(p.x - zn.lineX) < 14 && p.z > z0 && p.z < z1;
      assert.ok(!onLine, `prop on the ${zn.key} break line at ${p.x.toFixed(0)},${p.z.toFixed(0)}`);
    }
  }
});
