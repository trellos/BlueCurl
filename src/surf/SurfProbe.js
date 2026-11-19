import * as THREE from 'three';
import { FullscreenPass, makeShader, floatRT } from '../core/gpu.js';
import { WATER_PRELUDE } from '../water/WaterSurface.js';

// Rendered water height at N world points, evaluated by the water mesh's own vertex function
// (waterParts: breakers + FFT wind sea + shallow-water residual), so the board sits on exactly the
// surface that is drawn. The horizontal chop displacement is inverted by fixed-point iteration (the
// mesh vertex at undisplaced xz is drawn at xz + chop.xz). Read back synchronously: one tiny
// readPixels per frame (a pipeline stall on a real GPU; see docs/SURF-SPIKE.md).
// Output per point: (height, breaker-only elevation, chop weight, 1).
export const PROBE_N = 16;
export class SurfProbe {
  constructor(shared) {
    this.pts = Array.from({ length: PROBE_N }, () => new THREE.Vector2());
    this.uniforms = { ...shared, uPts: { value: this.pts } };
    this.target = floatRT(PROBE_N, 1);
    this.data = new Float32Array(PROBE_N * 4);
    this.pass = new FullscreenPass(makeShader(WATER_PRELUDE() + /* glsl */ `
      uniform vec2 uPts[${PROBE_N}];
      void main() {
        int i = int(gl_FragCoord.x);
        vec2 world = uPts[i];
        vec2 xz = world, gm, gc; vec3 ch; vec4 info; float paw, y;
        y = waterParts(xz, uTime, .02, gm, ch, gc, info, paw);
        xz = world - ch.xz;
        y = waterParts(xz, uTime, .02, gm, ch, gc, info, paw);
        xz = world - ch.xz;
        y = waterParts(xz, uTime, .02, gm, ch, gc, info, paw);
        gl_FragColor = vec4(y + ch.y, gBrkEta, info.w, 1.0);
      }`, this.uniforms));
  }
  /** pts: array of [x, z] (<= PROBE_N); returns heights (Float32Array view, stride 4) */
  sample(renderer, pts) {
    for (let i = 0; i < PROBE_N; i++) {
      const p = pts[Math.min(i, pts.length - 1)];
      this.pts[i].set(p[0], p[1]);
    }
    const prev = renderer.getRenderTarget();
    this.pass.render(renderer, this.target);
    renderer.readRenderTargetPixels(this.target, 0, 0, PROBE_N, 1, this.data);
    renderer.setRenderTarget(prev);
    return this.data;
  }
}
