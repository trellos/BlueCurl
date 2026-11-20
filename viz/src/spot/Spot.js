// BlueCurl Swell — the spot (owner WP2): headland with cliff, palms, bay beach, sea floor zones, sun + fill.
// Water is NOT rendered here (WP1's ocean covers it); depthAt()/BATHY_GLSL in bathymetry.js feed its tint.
import * as THREE from 'three';
import { buildLayout } from './layout.js';
import { createTerrain } from './terrain.js';
import { Palms } from './palms.js';
import { createBoulders, createStacks } from './rocks.js';
import { createRimUniforms, patchRim } from './look.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Default sun direction (toward the sun): ~6° elevation, ~12° south of east. */
export function defaultSunDir() {
  const el = THREE.MathUtils.degToRad(6), az = THREE.MathUtils.degToRad(-12);
  return new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
}

function createBushes(records, rimU) {
  const group = new THREE.Group();
  group.name = 'spot-bushes';
  let tris = 0;
  const mk = (recs, cluster, palette) => {
    if (!recs.length) return;
    // a bush = a few overlapping faceted blobs (reads as foliage, not as a boulder)
    const parts = cluster.map(([d, r, x, y, z]) => new THREE.IcosahedronGeometry(r, d).translate(x, y, z));
    const geo = mergeGeometries(parts);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true });
    mat.onBeforeCompile = (sh) => patchRim(sh, rimU);
    const im = new THREE.InstancedMesh(geo, mat, recs.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const c = new THREE.Color();
    recs.forEach((r, i) => {
      e.set(0, r.yaw, 0); q.setFromEuler(e); s.set(r.r, r.h, r.r * 0.85); p.set(r.x, r.y, r.z);
      m4.compose(p, q, s); im.setMatrixAt(i, m4);
      const k = Math.floor(r.shade * palette.length) % palette.length;
      c.set(palette[k]); im.setColorAt(i, c);
    });
    im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
    group.add(im);
    tris += (geo.attributes.position.count / 3) * recs.length;
  };
  mk(records.filter((b) => !b.far), [[1, 0.62, 0, 0.3, 0], [0, 0.5, 0.6, 0.18, 0.3], [0, 0.48, -0.5, 0.15, -0.35], [0, 0.42, 0.1, 0.12, 0.7]],
    [0x7fae3c, 0x93b844, 0x6c9e36, 0xb0b04e, 0x88a640]);
  mk(records.filter((b) => b.far), [[1, 0.85, 0, 0.3, 0], [0, 0.5, 0.5, 0.55, 0.2]], [0x3f7f30, 0x4a8c34, 0x356f2c, 0x5a9a3a]);
  return { group, tris };
}

export class Spot {
  constructor(app) {
    this.app = app;
    const scene = app.scene;
    const sunDir = (app.sunDir && app.sunDir.isVector3) ? app.sunDir.clone().normalize() : defaultSunDir();
    this.sunDir = sunDir;
    this.group = new THREE.Group();
    this.group.name = 'spot';
    this.rimU = createRimUniforms(sunDir);

    this.layout = buildLayout();
    this.terrain = createTerrain(this.rimU);
    this.group.add(this.terrain);
    this.palms = new Palms(this.layout.palms, this.rimU);
    this.group.add(this.palms.group);
    const boulders = createBoulders(this.layout.rocks, this.rimU);
    this.group.add(boulders.mesh);
    const stacks = createStacks(this.layout.stacks, this.rimU);
    this.group.add(stacks.group);
    const bushes = createBushes(this.layout.bushes, this.rimU);
    this.group.add(bushes.group);
    this.triangles = {
      terrain: this.terrain.geometry.index.count / 3,
      palms: this.palms.tris, boulders: boulders.tris, stacks: stacks.tris, bushes: bushes.tris,
    };
    this.triangles.total = Object.values(this.triangles).reduce((a, b) => a + b, 0);

    // --- lights: low warm sun (shadow-casting, map rendered once: the spot is static) + sky/ground fill
    const sun = new THREE.DirectionalLight(0xffc68a, 3.0);
    const focus = new THREE.Vector3(60, 0, 20);
    sun.position.copy(focus).addScaledVector(sunDir, 900);
    sun.target.position.copy(focus);
    sun.castShadow = true;
    const sc = sun.shadow.camera;
    sc.left = -340; sc.right = 340; sc.top = 110; sc.bottom = -110; sc.near = 300; sc.far = 1700;
    sun.shadow.mapSize.set(4096, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = true;
    this.sun = sun;
    const hemi = new THREE.HemisphereLight(0xa9c4e8, 0x6b5a3e, 1.15);
    this.hemi = hemi;
    this.group.add(sun, sun.target, hemi);
    if (app.renderer && !app.renderer.shadowMap.enabled) {
      app.renderer.shadowMap.enabled = true;
      app.renderer.shadowMap.type = THREE.PCFShadowMap;
    }
    scene.add(this.group);
  }

  update(t) { this.palms.update(t); }

  dispose() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this.group.removeFromParent();
  }
}
