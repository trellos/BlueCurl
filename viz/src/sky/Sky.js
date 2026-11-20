// Sky dome at infinity + a prefiltered environment map of the same sky (for PBR reflections).
// The dome vertex shader (xyww trick, view rotation only) is from ShoreBreak src/sky/Sky.js,
// Copyright (c) 2026 Christopher Canavan, MIT License (see viz/THIRD_PARTY.md).
//
// WP14 day cycle: the dome reads the shared (per-frame) sky uniforms. The environment map is a cache, so it is a
// function of a QUANTISED day phase only (ENV_STEPS per cycle): updateEnv(renderer, phase) rebuilds it when the
// quantised step changes, from sunAt(step / ENV_STEPS) written into its own uniform copy (cloud drift frozen at
// uTime 0), never from the frame count or the time it happens to be rebuilt → captures stay byte-identical on resume.
// Targets (cube, PMREM) are allocated once and reused.
import * as THREE from 'three';
import { SKY_GLSL, applySun } from './skyModel.js';
import { sunAt } from './dayCycle.js';

/** Environment-map rebuilds per day cycle (64 measures @120 bpm → one every 0.25 s, ~1 ms GPU each at 128²). */
export const ENV_STEPS = 512;
/** Quantised env step of a phase (step ENV_STEPS ≡ 0: the wrap reuses the same map). */
export const envStep = (phase) => ((Math.round(phase * ENV_STEPS) % ENV_STEPS) + ENV_STEPS) % ENV_STEPS;

const VERT = /* glsl */ `
out vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const FRAG = SKY_GLSL + /* glsl */ `
uniform float uDisc;
in vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  gl_FragColor = vec4(bcSky(d, uDisc), 1.0);
}`;

const SKY_KEYS = ['uSunDir', 'uSunColor', 'uSunGlow', 'uSkyAmb', 'uSkyTune', 'uTime', 'uSkyZen', 'uSkyHzSun', 'uSkyHzMid',
  'uSkyHzAnti', 'uSkyMidSun', 'uSkyMidAnti', 'uCloudSun', 'uCloudAnti', 'uCloudHi', 'uSkyMisc'];

export class Sky {
  /** shared: uniforms object holding the SKY_GLSL uniforms (uSunDir, uSunColor, uSkyAmb, uSkyTune, uTime, …). */
  constructor(shared) {
    this.shared = shared;
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...shared, uDisc: { value: 1 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'sky';
    this.envMap = null;
    this.envStep = -1;
    this.envBuilds = 0;
  }

  _envSetup(size) {
    if (this._env) return this._env;
    // own copy of every sky uniform (values cloned), so the env map never sees the per-frame state
    const u = {};
    for (const k of SKY_KEYS) if (this.shared[k]) u[k] = { value: this.shared[k].value.clone ? this.shared[k].value.clone() : this.shared[k].value };
    u.uTime = { value: 0 };
    u.uDisc = { value: 0.02 };
    const mat = this.material.clone();
    mat.uniforms = u;
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(this.mesh.geometry, mat));
    const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
    const cam = new THREE.CubeCamera(1, 10, rt);
    this._env = { u, mat, scene, rt, cam, pmrem: null, pmremRT: null };
    return this._env;
  }

  /**
   * Render the sky at day phase `phase` (clouds, disc dimmed to avoid fireflies) into a cube map and prefilter it
   * with PMREM. Returns the PMREM texture (same texture object on every rebuild).
   */
  buildEnvMap(renderer, phase = 0.06, size = 128) {
    const E = this._envSetup(size);
    applySun(E.u, sunAt(phase));
    E.cam.update(renderer, E.scene);
    if (!E.pmrem) E.pmrem = new THREE.PMREMGenerator(renderer);
    E.pmremRT = E.pmrem.fromCubemap(E.rt.texture, E.pmremRT);
    this.envMap = E.pmremRT.texture;
    this.envBuilds++;
    return this.envMap;
  }

  /** Rebuild the env map if the quantised step of `phase` changed. Returns true when it rebuilt. */
  updateEnv(renderer, phase) {
    const k = envStep(phase);
    if (k === this.envStep && this.envMap) return false;
    this.envStep = k;
    this.buildEnvMap(renderer, k / ENV_STEPS);
    return true;
  }

  update(t) { /* uTime is shared; nothing per frame */ }

  dispose() {
    if (this._env) { this._env.rt.dispose(); this._env.mat.dispose(); this._env.pmremRT?.dispose(); this._env.pmrem?.dispose(); }
    this.material.dispose();
  }
}
