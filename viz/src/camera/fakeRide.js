// BlueCurl Swell — fake-ride driver (WP7 test fixture; keep it). Enabled with ?fakeride=1 (point breaks only) or
// ?fakeride=all (every zone). ?fakewave=1 also draws a debug patch of the wave surface around the primary ride
// (from field.sampleFront) while the real wave mesh is not there.
//
// For every committed ZoneBreak it rides, a stand-in rider (names/kinds from contracts.RIDERS, id = 100 + RIDERS id)
// takes off just ahead of the peak shortly after tBreak, runs down the line a few metres ahead of the breaking
// section (pumping up and down the face), optionally sits in the tube for a while (curly breaks), and kicks out
// where the peel stops. It emits RideEvents { t, type: 'takeoff'|'barrel'|'rideEnd', riderId, frontId, zi, outcome }
// into this.events and exposes RiderState-like objects in this.riders. Everything is a function of the swell
// state and t (deterministic); the marker meshes are posed in update(t).
import * as THREE from 'three';
import { RIDERS, FRONT_W, uToZ, breakStartTime, hash01, ambientHeight } from '../contracts.js';
import * as field from '../wave/field.js';
import * as KF from '../wave/keyframes.js';

const SIGMA_LIP = KF.SIGMA_LIP ?? 44 / 95;
const SIGMA_TROUGH = KF.SIGMA_TROUGH ?? 76 / 95;
export const FAKE_ID0 = 100;
const TAKEOFF_DELAY = 0.35;     // s after tBreak
const AFTER = 1.2;              // s the marker stays (paddling over the back) after rideEnd
const MAX_RIDE = 14;            // s

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const s = clamp((x - a) / (b - a), 0, 1); return s * s * (3 - 2 * s); };

/** Distance (m, along the peel direction) the breaking section has travelled from the peak at time t. */
export function breakFront(zb, dir, t) {
  const uAt = (s) => zb.uPeak + (dir * s) / FRONT_W;
  if (!(breakStartTime(zb, uAt(0)) <= t)) return -Infinity;
  let lo = 0, hi = Math.max(1, zb.peelLen);
  if (breakStartTime(zb, uAt(hi)) <= t) return hi;
  for (let i = 0; i < 28; i++) { const m = 0.5 * (lo + hi); if (breakStartTime(zb, uAt(m)) <= t) lo = m; else hi = m; }
  return lo;
}

export class FakeRides {
  constructor(app, { all = false, wave = false } = {}) {
    this.app = app;
    this.all = all;
    this.group = new THREE.Group();
    this.group.name = 'fakeRides';
    this.markers = RIDERS.map((r) => this._marker(r));
    for (const m of this.markers) this.group.add(m);
    app.scene?.add(this.group);
    this.wave = wave ? this._wavePatch() : null;
    if (this.wave) app.scene?.add(this.wave);
    this.reset();
  }

  reset() {
    this.events = [];
    this.riders = [];
    this.rides = [];
    this._done = new Set();
    this._k = 0;
  }

  _marker(r) {
    const g = new THREE.Group();
    const col = new THREE.Color(r.color);
    const mat = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5, roughness: 0.5 });
    if (r.kind === 'surfer') {
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.1, 4, 10), mat);
      body.position.y = 0.85;
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 2.1),
        new THREE.MeshStandardMaterial({ color: 0xf6f1e4, emissive: 0x403a30, roughness: 0.4 }));
      board.position.y = 0.05;
      g.add(body, board);
    } else {
      const len = r.kind === 'dolphin' ? 2.4 : 1.6, rad = r.kind === 'dolphin' ? 0.32 : 0.38;
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(rad, len - 2 * rad, 4, 10), mat);
      body.rotation.x = Math.PI / 2;
      body.position.y = 0.2;
      g.add(body);
      if (r.kind === 'dolphin') {
        const fin = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.5, 6), mat);
        fin.position.set(0, 0.6, -0.1);
        g.add(fin);
      }
    }
    g.visible = false;
    return g;
  }

  _wavePatch() {
    const NU = 72, NS = 56;
    const geo = new THREE.PlaneGeometry(1, 1, NU - 1, NS - 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1d6f74, roughness: 0.25, metalness: 0, side: THREE.DoubleSide,
      transparent: true, opacity: 0.92 });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.visible = false;
    m.userData = { NU, NS };
    return m;
  }

  _zones() { return this.all ? [0, 1, 2] : [1]; }

  _start(front, zb, t) {
    const busy = new Set(this.rides.filter((r) => !r.gone).map((r) => r.ri));
    let ri = (this._k + Math.floor(hash01(front.id, zb.zi, 11) * RIDERS.length)) % RIDERS.length;
    for (let i = 0; i < RIDERS.length && busy.has(ri); i++) ri = (ri + 1) % RIDERS.length;
    if (busy.has(ri)) return;
    this._k++;
    const R = RIDERS[ri];
    const dir = zb.dir || (hash01(front.id, zb.zi, 3) < 0.5 ? -1 : 1);
    const vPeel = Math.max(1, zb.vPeel);
    const tStart = t;
    // end: where the peel stops (or a short ride on a close-out)
    let tEnd;
    if (zb.closeout) tEnd = tStart + 2.2;
    else {
      tEnd = tStart + MAX_RIDE;
      // the rider runs out of wave where the peel stops or the zone ends
      const uEdge = dir > 0 ? Math.max(zb.u0, zb.u1) : Math.min(zb.u0, zb.u1);
      const sLimit = Math.min(zb.peelLen, Math.abs(uEdge - zb.uPeak) * FRONT_W);
      const L0 = 3 + 1.1 * Math.max(0.5, zb.H);
      for (let tt = tStart; tt < tStart + MAX_RIDE; tt += 0.1) {
        const sb = breakFront(zb, dir, tt);
        if (sb >= zb.peelLen - 1e-6 || sb + L0 >= sLimit + 2) { tEnd = tt + 0.6; break; }
      }
      tEnd = Math.max(tEnd, tStart + 3);
      if (Number.isFinite(front.tShore)) tEnd = Math.min(tEnd, front.tShore - 1.5);
    }
    let tB0 = Infinity, tB1 = Infinity;
    if (!zb.closeout && zb.curl >= 0.3 && tEnd - tStart > 3) {
      const bt = clamp((zb.quality && zb.quality.barrelTime) || 1.5, 1.4, 3.2);
      tB0 = tStart + Math.max(1.4, 0.3 * (tEnd - tStart));
      tB1 = Math.min(tB0 + bt, tEnd - 0.8);
    }
    const ride = {
      ri, riderId: FAKE_ID0 + R.id, frontId: front.id, zi: zb.zi, zb, dir, vPeel, tStart, tEnd, tB0, tB1,
      H: zb.H, phase: hash01(front.id, zb.zi, 5) * 6.28, ended: false, barrelSent: false, gone: false,
      rs: { id: FAKE_ID0 + R.id, kind: R.kind, name: R.name, color: R.color, fake: true, state: 'TAKEOFF', style: null,
        action: 'pop', actionT: 0, pos: { x: 0, y: 0, z: 0 }, fwd: { x: 0, y: 0, z: dir }, up: { x: 0, y: 1, z: 0 },
        speed: vPeel, frontId: front.id, zi: zb.zi, u: zb.uPeak, sigma: 0.6 },
    };
    this.rides.push(ride);
    this._emit({ t, type: 'takeoff', riderId: ride.riderId, frontId: front.id, zi: zb.zi });
  }

  _emit(ev) { this.events.push(ev); if (this.events.length > 64) this.events.splice(0, this.events.length - 64); }

  step(t, dt, swell) {
    const fronts = (swell && swell.fronts) || [];
    // 1. new rides
    for (const f of fronts) {
      for (const zb of f.breaks || []) {
        if (!this._zones().includes(zb.zi)) continue;
        const key = f.id * 8 + zb.zi;
        if (this._done.has(key)) continue;
        if (t >= zb.tBreak + TAKEOFF_DELAY) { this._done.add(key); this._start(f, zb, t); }
      }
    }
    // 2. advance rides
    for (const ride of this.rides) {
      if (ride.gone) continue;
      const front = fronts.find((f) => f.id === ride.frontId);
      if (!front || t >= ride.tEnd + AFTER) { ride.gone = true; continue; }
      this._pose(ride, front, t);
      if (!ride.barrelSent && t >= ride.tB0) {
        ride.barrelSent = true;
        this._emit({ t, type: 'barrel', riderId: ride.riderId, frontId: ride.frontId, zi: ride.zi });
      }
      if (!ride.ended && t >= ride.tEnd) {
        ride.ended = true;
        this._emit({ t, type: 'rideEnd', riderId: ride.riderId, frontId: ride.frontId, zi: ride.zi,
          outcome: ride.zb.closeout ? 'closeout' : 'kickout' });
      }
    }
    this.rides = this.rides.filter((r) => !r.gone);
    this.riders = this.rides.map((r) => r.rs);
  }

  _pose(ride, front, t) {
    const { zb, dir } = ride, rs = ride.rs, H = Math.max(0.5, zb.H);
    const tr = Math.min(t, ride.tEnd);
    const sb = Math.max(0, breakFront(zb, dir, tr));
    const L0 = 3 + 1.1 * H;                                  // ahead of the breaking section
    const Lb = -0.4 * ride.vPeel * zb.Tb;                    // inside the tube (behind where the lip started)
    const wT = Number.isFinite(ride.tB0) ? smooth(ride.tB0 - 0.5, ride.tB0, tr) * (1 - smooth(ride.tB1, ride.tB1 + 0.5, tr)) : 0;
    const s = sb + L0 + (Lb - L0) * wT;
    const lo = Math.min(zb.u0, zb.u1), hi = Math.max(zb.u0, zb.u1);
    const u = clamp(zb.uPeak + (dir * s) / FRONT_W, lo, hi);
    const osc = Math.sin(6.2832 * (tr - ride.tStart) / 2.8 + ride.phase);
    const sigma = SIGMA_LIP + (SIGMA_TROUGH - SIGMA_LIP) * (0.5 + 0.22 * osc * (1 - wT));
    let p;
    if (field.sampleFront) {
      p = field.sampleFront(front, u, sigma, t);
      if (wT > 0 && field.barrel) {
        const b = field.barrel(front, u, t);
        if (b) { const by = b.y - 0.55 * b.r; p = { ...p, x: p.x + (b.x - p.x) * wT, y: p.y + (by - p.y) * wT, z: b.z }; }
      }
    } else {
      const x = front.x - 0.4 * H, z = uToZ(u);
      p = { x, y: 0.5 * H + ambientHeight(x, z, t), z, nx: 0, ny: 1, nz: 0 };
    }
    if (t > ride.tEnd) {                                    // kicked out: drift over the back of the wave
      const k = (t - ride.tEnd) / AFTER;
      p = { ...p, x: p.x + 4 * k, y: p.y + 0.4 * Math.sin(k * 3) };
    }
    const dOsc = Math.cos(6.2832 * (tr - ride.tStart) / 2.8 + ride.phase);
    const fx = -0.35 * dOsc * (1 - wT), fz = dir, fl = Math.hypot(fx, fz);
    rs.pos.x = p.x; rs.pos.y = p.y; rs.pos.z = p.z;
    rs.fwd.x = fx / fl; rs.fwd.y = 0; rs.fwd.z = fz / fl;
    rs.up.x = p.nx ?? 0; rs.up.y = p.ny ?? 1; rs.up.z = p.nz ?? 0;
    rs.u = u; rs.sigma = sigma; rs.speed = ride.vPeel;
    const kind = rs.kind;
    if (t >= ride.tEnd) { rs.state = 'KICKOUT'; rs.style = null; rs.action = 'kickout'; }
    else if (t - ride.tStart < 0.6) { rs.state = 'TAKEOFF'; rs.style = null; rs.action = 'pop'; }
    else {
      rs.state = 'RIDE';
      rs.style = wT > 0.5 ? 'tube' : kind === 'surfer' ? 'carve' : kind === 'dolphin' ? 'porpoise' : 'cruise';
      rs.action = wT > 0.5 ? 'crouch' : osc > 0.6 ? 'lipHit' : osc < -0.6 ? 'bottomTurn' : 'trim';
    }
    rs.actionT = ((tr - ride.tStart) / 2.8) % 1;
  }

  /** Pose the markers (and the debug wave patch) for render time t. */
  update(t) {
    for (const m of this.markers) m.visible = false;
    for (const ride of this.rides) {
      const m = this.markers[ride.ri], rs = ride.rs;
      m.visible = true;
      m.position.set(rs.pos.x, rs.pos.y, rs.pos.z);
      const up = new THREE.Vector3(rs.up.x, rs.up.y, rs.up.z).lerp(new THREE.Vector3(0, 1, 0), 0.5).normalize();
      const fwd = new THREE.Vector3(rs.fwd.x, rs.fwd.y, rs.fwd.z);
      fwd.addScaledVector(up, -fwd.dot(up)).normalize();
      const side = new THREE.Vector3().crossVectors(up, fwd).normalize();
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, up, fwd));
      if (rs.style === 'tube') m.scale.set(1, 0.7, 1); else m.scale.set(1, 1, 1);
    }
    if (this.wave) this._updateWave(t);
  }

  _updateWave(t) {
    const ride = this.rides[0];
    const front = ride && (this.app.swell?.fronts || []).find((f) => f.id === ride.frontId);
    this.wave.visible = !!(front && field.sampleFront);
    if (!this.wave.visible) return;
    const { NU, NS } = this.wave.userData, pos = this.wave.geometry.attributes.position;
    const u0 = ride.rs.u - 60 / FRONT_W, u1 = ride.rs.u + 60 / FRONT_W;
    for (let j = 0; j < NS; j++) {
      const sg = j / (NS - 1);
      for (let i = 0; i < NU; i++) {
        const u = u0 + ((u1 - u0) * i) / (NU - 1);
        const p = field.sampleFront(front, u, sg, t);
        pos.setXYZ(j * NU + i, p.x, p.y, p.z);
      }
    }
    pos.needsUpdate = true;
    this.wave.geometry.computeVertexNormals();
  }

  dispose() {
    this.app.scene?.remove(this.group);
    if (this.wave) this.app.scene?.remove(this.wave);
  }
}

