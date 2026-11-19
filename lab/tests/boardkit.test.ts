import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Board } from '../src/boardkit/board.ts';
import { SHORTBOARD_6_0 } from '../src/boardkit/spec.ts';
import { buildHullGeometry } from '../src/boardkit/mesh.ts';

const b = new Board(SHORTBOARD_6_0);

test('volume is within 6% of the published 28.5 L', () => {
  const v = b.derived.volumeL;
  console.log('volume L', v.toFixed(2), 'cob', b.derived.cob.toArray().map((x) => x.toFixed(3)));
  assert.ok(Math.abs(v - 28.5) / 28.5 < 0.06, `volume ${v}`);
});

test('dimensions: max width, thickness, rocker', () => {
  let wMax = 0;
  for (let i = 0; i <= 400; i++) wMax = Math.max(wMax, 2 * b.halfWidth(i / 400));
  assert.ok(Math.abs(wMax - SHORTBOARD_6_0.dims.width) < 0.003, `width ${wMax}`);
  assert.ok(Math.abs(b.rocker(1) - 0.127) < 1e-6);
  assert.ok(Math.abs(b.rocker(0) - 0.057) < 1e-6);
  const tc = b.deckHeight(0, 0) - b.bottomHeight(0, 0);
  assert.ok(Math.abs(tc - SHORTBOARD_6_0.dims.thickness) < 0.006, `centre thickness ${tc}`);
});

test('deckFrame normal is unit, points up at the centre and outward near the rail', () => {
  const f = b.deckFrame(0, 0);
  assert.ok(Math.abs(f.n.length() - 1) < 1e-9);
  assert.ok(f.n.y > 0.99);
  const r = b.deckFrame(0, 0.22);
  assert.ok(r.n.x > 0.2, `left-rail normal x ${r.n.x}`);
});

test('stance anchors: back foot over the fins, stance width ~0.31 H', () => {
  const s = b.stance(1.8, 'regular');
  const fromTail = s.back.position.z + b.L / 2;
  assert.ok(fromTail > 0.27 && fromTail < 0.32, `back foot ${fromTail}`);
  const w = s.front.position.z - s.back.position.z;
  assert.ok(w > 0.5 && w < 0.6, `stance width ${w}`);
  // regular: toes point to the right rail (-X)
  const toe = new THREE.Vector3(0, 0, 1).applyQuaternion(s.back.quaternion);
  assert.ok(toe.x < -0.9);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(s.back.quaternion);
  assert.ok(up.y > 0.99);
});

test('hull winding agrees with the analytic normals', () => {
  const g = buildHullGeometry(b);
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const idx = g.index!;
  const a = new THREE.Vector3(), bb = new THREE.Vector3(), c = new THREE.Vector3(), fn = new THREE.Vector3(), vn = new THREE.Vector3();
  let bad = 0;
  const tris = idx.count / 3;
  for (let t = 0; t < tris; t++) {
    const i0 = idx.getX(3 * t), i1 = idx.getX(3 * t + 1), i2 = idx.getX(3 * t + 2);
    a.fromBufferAttribute(p, i0); bb.fromBufferAttribute(p, i1); c.fromBufferAttribute(p, i2);
    fn.crossVectors(bb.sub(a), c.sub(a));
    if (fn.lengthSq() < 1e-16) continue;
    vn.fromBufferAttribute(n, i0);
    if (fn.dot(vn) < 0) bad++;
  }
  console.log('tris', tris, 'flipped', bad);
  assert.ok(bad / tris < 0.01, `${bad} of ${tris} flipped`);
});

import { pointSBtoBC, pointBCtoSB, poseSBtoBC } from '../src/boardkit/shorebreak.ts';
test('ShoreBreak frame conversion: axes and round trip', () => {
  // SB +x (nose) -> BC +Z ; SB +z (right rail) -> BC -X
  const o = pointSBtoBC(new THREE.Vector3(0, 0, 0), b);
  const nose = pointSBtoBC(new THREE.Vector3(1, 0, 0), b).sub(o);
  const right = pointSBtoBC(new THREE.Vector3(0, 0, 1), b).sub(o);
  assert.ok(nose.distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-9);
  assert.ok(right.distanceTo(new THREE.Vector3(-1, 0, 0)) < 1e-9);
  const p = new THREE.Vector3(0.3, 0.05, -0.1);
  assert.ok(pointBCtoSB(pointSBtoBC(p, b), b).distanceTo(p) < 1e-9);
  // a world pose: same physical point maps to the same world point
  const qSB = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 1.1, -0.3));
  const pSB = new THREE.Vector3(5, 1, -2);
  const pose = poseSBtoBC(pSB, qSB, b);
  const local = new THREE.Vector3(0.4, 0.02, 0.1); // a point in SB board coords
  const wSB = local.clone().applyQuaternion(qSB).add(pSB);
  const wBC = pointSBtoBC(local, b).applyQuaternion(pose.quaternion).add(pose.position);
  assert.ok(wSB.distanceTo(wBC) < 1e-9);
});
