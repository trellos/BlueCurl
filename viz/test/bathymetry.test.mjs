// Spot bathymetry + layout tests (WP2). GPU parity of BATHY_GLSL is checked in dev/spot.html?parity=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depthAt, headlandS, xBay, xEast, bathyParts } from '../src/spot/bathymetry.js';
import { buildLayout, SPOT_CAMERAS, sightTargets, clearOfSightlines } from '../src/spot/layout.js';
import { ZONES, uToZ } from '../src/contracts.js';

const range = (a, b, step) => { const o = []; for (let v = a; v <= b + 1e-9; v += step) o.push(v); return o; };
const zone = (key) => ZONES.find((z) => z.key === key);

test('zone depths on the break lines', () => {
  const cases = [['outer', 40, 220, 3.0, 4.0], ['point', -120, 90, 1.5, 2.6], ['inside', -230, -40, 0.6, 1.4]];
  for (const [key, z0, z1, lo, hi] of cases) {
    const x = zone(key).lineX;
    for (const z of range(z0, z1, 5)) {
      const d = depthAt(x, z);
      assert.ok(d >= lo && d <= hi, `${key} depth at (${x}, ${z}) = ${d.toFixed(2)} not in [${lo}, ${hi}]`);
    }
  }
});

test('break zones sit on shallow features surrounded by deeper water', () => {
  assert.ok(depthAt(300, 130) + 4 < depthAt(380, 130), 'outer reef stands above the surrounding sea floor');
  assert.ok(depthAt(300, 130) + 4 < depthAt(300, 330), 'outer reef has deep water to the north');
  assert.ok(depthAt(165, -40) + 1.5 < depthAt(215, -40), 'point shelf drops off seaward');
  assert.ok(depthAt(55, -140) + 0.8 < depthAt(25, -140), 'inside sandbar has a trough behind it');
  for (const z of range(-300, 300, 20)) {
    const d = depthAt(600, z);
    assert.ok(d >= 25 && d <= 40, `depth at x=600, z=${z}: ${d.toFixed(1)}`);
    assert.ok(depthAt(1000, z) > d, 'deeper offshore');
  }
});

test('land above water: headland and beach', () => {
  for (const [x, z] of [[40, 150], [60, 100], [100, 92], [90, 75], [20, 80], [0, 250], [-100, 150]]) {
    assert.ok(depthAt(x, z) < -5, `headland (${x}, ${z}) is land: ${depthAt(x, z).toFixed(1)}`);
  }
  assert.ok(depthAt(40, 150) < -20 && depthAt(40, 260) < -33, 'bluff ~35-40 m in the north-west of the headland');
  for (const z of [200, 230, 260]) {
    const xe = xEast(z);
    assert.ok(depthAt(xe - 12, z) < -30 && depthAt(xe + 6, z) > 0, `~35 m east cliff at z=${z}`);
  }
  assert.ok(depthAt(122, 95) > 0 && depthAt(108, 95) < -5, 'tip near (115, 95)');
  for (const z of range(-260, -20, 10)) {
    assert.ok(Math.abs(xBay(z)) < 6, `beach line near x=0 at z=${z}: ${xBay(z).toFixed(1)}`);
    assert.ok(depthAt(-10, z) < -0.3, `beach dry at (-10, ${z})`);
    assert.ok(depthAt(10, z) > 0.3, `water at (10, ${z})`);
  }
});

test('continuity: no underwater cliffs away from the headland', () => {
  const h = 1.0;
  let worst = 0, at = null;
  for (let x = -40; x <= 900; x += 3) {
    for (let z = -450; z <= 450; z += 3) {
      const d = depthAt(x, z);
      assert.ok(Number.isFinite(d), `finite at (${x}, ${z})`);
      if (d < 0.3 || headlandS(x, z) > -15) continue;
      const g = Math.hypot(depthAt(x + h, z) - depthAt(x - h, z), depthAt(x, z + h) - depthAt(x, z - h)) / (2 * h);
      if (g > worst) { worst = g; at = [x, z]; }
    }
  }
  assert.ok(worst < 0.7, `max underwater slope ${worst.toFixed(3)} at ${at}`);
  // and no jumps anywhere (the headland cliff is steep but continuous)
  let jump = 0;
  for (let x = -60; x <= 200; x += 0.5) for (let z = 0; z <= 300; z += 7) jump = Math.max(jump, Math.abs(depthAt(x + 0.5, z) - depthAt(x, z)));
  assert.ok(jump < 4, `max change per 0.5 m: ${jump.toFixed(2)} m`);
});

test('bathyParts agrees with depthAt', () => {
  for (const [x, z] of [[300, 100], [165, 0], [55, -100], [40, 150], [115, 95], [-200, -300], [900, 900]]) {
    assert.ok(Math.abs(bathyParts(x, z).depth - depthAt(x, z)) < 1e-9);
  }
});

test('terrain never blocks the break zones from the camera poses', () => {
  const targets = sightTargets(10).filter((t) => t[1] < 1);
  for (const [name, cam] of Object.entries(SPOT_CAMERAS)) {
    const [cx, cy, cz] = cam.pos;
    assert.ok(cy + depthAt(cx, cz) > 10, `${name} camera at least 10 m above ground`);
    assert.ok(depthAt(cx, cz) < 0, `${name} camera stands on land`);
    for (const t of targets) {
      for (let i = 1; i < 92; i++) {
        const s = i / 100, x = cx + (t[0] - cx) * s, y = cy + (t[1] - cy) * s, z = cz + (t[2] - cz) * s;
        const clear = y + depthAt(x, z);
        assert.ok(clear > 2, `${name}: terrain within ${clear.toFixed(1)} m of the sightline to ${t[3]} (${t[0]}, ${t[2]}) at (${x.toFixed(0)}, ${z.toFixed(0)})`);
      }
    }
  }
});

test('layout: deterministic, palm count, props clear of sightlines', () => {
  const a = buildLayout(), b = buildLayout();
  assert.deepEqual(a, b);
  assert.ok(a.palms.length >= 20 && a.palms.length <= 40, `palms: ${a.palms.length}`);
  const cams = Object.values(SPOT_CAMERAS), targets = sightTargets(10);
  for (const p of a.palms) assert.ok(clearOfSightlines(p.x, p.z, 5.5 * p.scale, p.y + (p.variant ? 10.5 : 14) * p.scale, cams, targets, 0.5), `palm at ${p.x.toFixed(0)},${p.z.toFixed(0)}`);
  for (const s of a.stacks) assert.ok(clearOfSightlines(s.x, s.z, s.r, s.y + s.h, cams, targets, 0.5), `stack at ${s.x},${s.z}`);
  for (const r of a.rocks.slice(0, 60)) assert.ok(clearOfSightlines(r.x, r.z, 0.5 * Math.max(r.sx, r.sz), r.y + r.sy, cams, targets, 0.2), `rock at ${r.x.toFixed(0)},${r.z.toFixed(0)}`);
  // inside the zone crest ranges there are no props at all on the water
  for (const zn of ZONES) {
    const z0 = uToZ(zn.u0), z1 = uToZ(zn.u1);
    for (const p of [...a.rocks, ...a.stacks]) {
      const onLine = Math.abs(p.x - zn.lineX) < 20 && p.z > z0 && p.z < z1;
      assert.ok(!onLine, `prop on the ${zn.key} break line at ${p.x.toFixed(0)},${p.z.toFixed(0)}`);
    }
  }
});
