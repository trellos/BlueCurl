// Sky dome at infinity + a prefiltered environment map of the same sky (for PBR reflections).
// The dome vertex shader (xyww trick, view rotation only) is from ShoreBreak src/sky/Sky.js,
// Copyright (c) 2026 Christopher Canavan, MIT License (see viz/THIRD_PARTY.md).
import * as THREE from 'three';
import { SKY_GLSL } from './skyModel.js';

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

export class Sky {
  /** shared: uniforms object holding the SKY_GLSL uniforms (uSunDir, uSunColor, uSkyAmb, uSkyTune, uTime). */
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
  }

  /**
   * Render the sky (clouds, disc dimmed to avoid fireflies) into a cube map and prefilter it with PMREM.
   * Returns the PMREM texture (use as scene.environment / material.envMap).
   */
  buildEnvMap(renderer, size = 256) {
    const scene = new THREE.Scene();
    const mat = this.material.clone();
    mat.uniforms = { ...this.shared, uDisc: { value: 0.02 } };
    scene.add(new THREE.Mesh(this.mesh.geometry, mat));
    const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
    const cam = new THREE.CubeCamera(1, 10, rt);
    cam.update(renderer, scene);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromCubemap(rt.texture);
    pmrem.dispose(); rt.dispose(); mat.dispose();
    this.envMap = env.texture;
    return this.envMap;
  }

  update(t) { /* uTime is shared; nothing per frame */ }
}
