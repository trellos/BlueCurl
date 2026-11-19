// Lab sea: a placeholder water surface displaced on the GPU by the analytic stand-in wave face.
// Not the wave renderer. A single camera-following grid, dense in the centre (~0.3 m) and
// stretched to ~2 km at the edges, snapped to the centre spacing so it does not swim.

import * as THREE from 'three';
import { waveGLSL, type WaveFace } from '../surfsim/waveFace.ts';

const SEGS = 400;
const NEAR = 60; // m covered by the linear part of the half grid
const FAR = 2400; // m added at the edge by the quartic stretch
const SNAP = NEAR / (SEGS / 2);

export class Sea {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshPhysicalMaterial;
  private uniforms = {
    uWaveH: { value: 1.8 },
    uFaceTan: { value: 0.65 },
    uBackL: { value: 9 },
    uChop: { value: 0.03 },
    uTime: { value: 0 },
    uOffset: { value: new THREE.Vector2() },
  };

  constructor() {
    const g = new THREE.PlaneGeometry(2, 2, SEGS, SEGS);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const sx = pos.getX(i);
      const sz = pos.getZ(i);
      const m = (u: number) => Math.sign(u) * (NEAR * Math.abs(u) + FAR * Math.pow(Math.abs(u), 4));
      pos.setXYZ(i, m(sx), 0, m(sz));
    }
    g.computeBoundingSphere();
    g.boundingSphere!.radius = 1e5;

    this.material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0.012, 0.05, 0.055),
      roughness: 0.1,
      metalness: 0,
      ior: 1.333,
      specularIntensity: 1,
    });
    const U = this.uniforms;
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>\nuniform vec2 uOffset;\n${waveGLSL}`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `vec2 wxz = position.xz + uOffset;
          float e = 0.08;
          float hC = wHeight(wxz.x, wxz.y);
          float hX = wHeight(wxz.x + e, wxz.y) - wHeight(wxz.x - e, wxz.y);
          float hZ = wHeight(wxz.x, wxz.y + e) - wHeight(wxz.x, wxz.y - e);
          vec3 objectNormal = normalize(vec3(-hX / (2.0 * e), 1.0, -hZ / (2.0 * e)));`,
        )
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = vec3(position.x, hC, position.z);`,
        );
    };
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'lab_sea';
  }

  update(wave: WaveFace, t: number, focus: THREE.Vector3, env: THREE.Texture | null): void {
    if (this.material.envMap !== env) {
      this.material.envMap = env;
      this.material.needsUpdate = true;
    }
    const U = this.uniforms;
    U.uWaveH.value = wave.p.height;
    U.uFaceTan.value = Math.tan((wave.p.faceAngleDeg * Math.PI) / 180);
    U.uBackL.value = wave.p.backLength;
    U.uChop.value = wave.p.chop;
    U.uTime.value = t;
    const ox = Math.round(focus.x / SNAP) * SNAP;
    const oz = Math.round(focus.z / SNAP) * SNAP;
    U.uOffset.value.set(ox, oz);
    this.mesh.position.set(ox, 0, oz);
  }
}

/** Studio stage: neutral grey floor that catches shadows. */
export function makeStudioFloor(): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(30, 96).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x8a8a88, roughness: 0.9 }),
  );
  m.receiveShadow = true;
  m.name = 'studio_floor';
  return m;
}
