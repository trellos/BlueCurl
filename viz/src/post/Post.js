// HDR post chain: scene -> MSAA half-float target -> high-threshold bloom (4 levels) -> grade
// (exposure, vibrance/saturation, AgX "punchy" or ACES filmic tonemap, sRGB) -> canvas or target,
// optionally into a scissored viewport (picture-in-picture).
//
// The soft-knee threshold downsample and the separable 5-tap Gaussian are from ShoreBreak
// src/post/Post.js (DOWN, BLUR, gauss3), Copyright (c) 2026 Christopher Canavan, MIT License.
// The AgX curve is three.js's (tonemapping_pars_fragment, MIT, based on Filament / Blender / iolite).
// See viz/THIRD_PARTY.md. No phone-camera artefacts (lens dirt, rolling shutter, sensor noise, CA).
import * as THREE from 'three';
import { FullscreenPass, makeShader, floatRT } from '../core/gpu.js';

const DOWN = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uFirst;
in vec2 vUv;
vec3 pre(vec3 c) {
  // guard: a NaN/Inf/negative pixel must never bloom (D3D's min() maps NaN to the other operand -> 250 -> a white
  // flash); then clamp the HDR input so a sun disc cannot flood the frame
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  c = clamp(c, vec3(0.0), vec3(250.0));
  if (uFirst < 0.5) return c;
  float br = max(c.r, max(c.g, c.b));
  float knee = uThreshold * 0.6;
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float w = max(soft, br - uThreshold) / max(br, 1e-4);
  return c * w;
}
void main() {
  vec2 t = uTexel;
  vec3 a = pre(texture(uSrc, vUv + t * vec2(-1.0, -1.0)).rgb);
  vec3 b = pre(texture(uSrc, vUv + t * vec2(1.0, -1.0)).rgb);
  vec3 c = pre(texture(uSrc, vUv + t * vec2(-1.0, 1.0)).rgb);
  vec3 d = pre(texture(uSrc, vUv + t * vec2(1.0, 1.0)).rgb);
  vec3 e = pre(texture(uSrc, vUv).rgb);
  gl_FragColor = vec4((a + b + c + d) * 0.125 + e * 0.5, 1.0);
}`;

const BLUR = /* glsl */ `
uniform sampler2D uSrc;
uniform vec2 uStep;
uniform vec3 uW;
in vec2 vUv;
void main() {
  vec3 s = texture(uSrc, vUv).rgb * uW.x
         + (texture(uSrc, vUv + uStep).rgb + texture(uSrc, vUv - uStep).rgb) * uW.y
         + (texture(uSrc, vUv + 2.0 * uStep).rgb + texture(uSrc, vUv - 2.0 * uStep).rgb) * uW.z;
  gl_FragColor = vec4(s, 1.0);
}`;

const GRADE = /* glsl */ `
uniform sampler2D uHDR;
uniform sampler2D uB0, uB1, uB2, uB3;
uniform vec4 uBloomW;        // weights of the 4 bloom levels
uniform float uBloom;        // overall bloom strength
uniform float uExposure;
uniform vec3 uWhite;         // white balance / grade tint (multiplier)
uniform float uSaturation;
uniform float uVibrance;     // extra saturation for low-saturation colours
uniform float uContrast;     // display-space contrast around 0.5
uniform float uLook;         // AgX look strength (0 = base, 1 = punchy)
uniform int uTonemap;        // 0 AgX, 1 ACES (Hill fit), 2 none (clamp)
in vec2 vUv;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

const mat3 LIN709_TO_2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
const mat3 LIN2020_TO_709 = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 color) {
  const mat3 INSET = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
                          vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
                          vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 OUTSET = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
                           vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
                           vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float MINEV = -12.47393, MAXEV = 4.026069;
  color = INSET * (LIN709_TO_2020 * color);
  color = clamp((log2(max(color, 1e-10)) - MINEV) / (MAXEV - MINEV), 0.0, 1.0);
  color = agxContrast(color);
  // look (Blender "Punchy": power 1.35, saturation 1.4), blended by uLook
  float l = dot(color, LUMA);
  vec3 punchy = pow(max(color, 0.0), vec3(1.35));
  float lp = dot(punchy, LUMA);
  punchy = lp + (punchy - lp) * 1.4;
  color = mix(color, punchy, uLook);
  color = OUTSET * color;
  color = pow(max(color, 0.0), vec3(2.2));
  return clamp(LIN2020_TO_709 * color, 0.0, 1.0);
}
// ACES filmic (Stephen Hill's fit)
vec3 rrtOdt(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 aces(vec3 c) {
  const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  return clamp(OUT * rrtOdt(IN * (c / 0.6)), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
bool bad(vec3 c) { return any(isnan(c)) || any(isinf(c)); }
void main() {
  vec3 hdr = texture(uHDR, vUv).rgb;
  if (bad(hdr)) {
    // a non-finite scene pixel: replace it with the mean of its finite neighbours (never black / white dots)
    vec2 px = 1.0 / vec2(textureSize(uHDR, 0));
    vec3 acc = vec3(0.0); float n = 0.0;
    for (int i = 0; i < 8; i++) {
      vec2 o = vec2(float(i % 3) - 1.0, float(i / 3) - 1.0); if (i >= 4) o = vec2(float((i + 1) % 3) - 1.0, float((i + 1) / 3) - 1.0);
      vec3 q = texture(uHDR, vUv + o * px).rgb;
      if (!bad(q)) { acc += q; n += 1.0; }
    }
    hdr = n > 0.0 ? acc / n : vec3(0.0);
  }
  hdr = clamp(hdr, vec3(0.0), vec3(65000.0));
  vec3 bloom = texture(uB0, vUv).rgb * uBloomW.x + texture(uB1, vUv).rgb * uBloomW.y
             + texture(uB2, vUv).rgb * uBloomW.z + texture(uB3, vUv).rgb * uBloomW.w;
  vec3 c = (hdr + bloom * uBloom) * uExposure * uWhite;
  float Y = dot(c, LUMA);
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float sat = (mx - mn) / max(mx, 1e-5);
  c = max(Y + (c - Y) * (uSaturation + uVibrance * (1.0 - sat)), 0.0);
  vec3 m = uTonemap == 0 ? agx(c) : (uTonemap == 1 ? aces(c) : clamp(c, 0.0, 1.0));
  vec3 s = toSRGB(m);
  s = clamp((s - 0.5) * uContrast + 0.5, 0.0, 1.0);
  s += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;              // static dither (deterministic)
  gl_FragColor = vec4(s, 1.0);
}`;

function gauss3(sigma) {
  const w1 = Math.exp(-1 / (2 * sigma * sigma)), w2 = Math.exp(-4 / (2 * sigma * sigma));
  const n = 1 + 2 * w1 + 2 * w2;
  return new THREE.Vector3(1 / n, w1 / n, w2 / n);
}

export const DEFAULT_POST_PARAMS = {
  exposure: 1.0,
  bloom: 0.9, bloomThreshold: 4.0, bloomWeights: [0.30, 0.30, 0.25, 0.25], bloomSigma: 1.2,
  white: [1.0, 1.0, 1.0],
  saturation: 1.15, vibrance: 0.30, contrast: 1.06, look: 1.0,
  tonemap: 'agx',                  // 'agx' | 'aces' | 'none'
  samples: 4,
};

export class Post {
  constructor(renderer, w, h, params = {}) {
    this.renderer = renderer;
    this.params = { ...DEFAULT_POST_PARAMS, ...params };
    this.pDown = new FullscreenPass(makeShader(DOWN, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 }, uFirst: { value: 0 } }));
    this.pBlur = new FullscreenPass(makeShader(BLUR, { uSrc: { value: null }, uStep: { value: new THREE.Vector2() }, uW: { value: new THREE.Vector3(1, 0, 0) } }));
    this.pGrade = new FullscreenPass(makeShader(GRADE, {
      uHDR: { value: null }, uB0: { value: null }, uB1: { value: null }, uB2: { value: null }, uB3: { value: null },
      uBloomW: { value: new THREE.Vector4() }, uBloom: { value: 0 }, uExposure: { value: 1 }, uWhite: { value: new THREE.Vector3(1, 1, 1) },
      uSaturation: { value: 1 }, uVibrance: { value: 0 }, uContrast: { value: 1 }, uLook: { value: 0 }, uTonemap: { value: 0 },
    }));
    this._size = new THREE.Vector2();
    this.resize(w, h);
  }

  resize(w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (this.w === w && this.h === h) return;
    this.w = w; this.h = h;
    [this.hdr, ...(this.levels || []).flatMap((l) => [l.a, l.b])].forEach((r) => r?.dispose());
    this.hdr = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, samples: this.params.samples, depthBuffer: true, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    this.hdr.texture.colorSpace = THREE.NoColorSpace;
    const hf = { type: THREE.HalfFloatType, filter: THREE.LinearFilter };
    this.levels = [];
    let lw = w, lh = h;
    for (let i = 0; i < 4; i++) {
      lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
      this.levels.push({ a: floatRT(lw, lh, hf), b: floatRT(lw, lh, hf) });
    }
  }

  /**
   * Render `scene` through `camera` and grade it into `target` (null = canvas).
   * viewport = {x, y, w, h} in drawing-buffer pixels, origin bottom-left (GL convention), scissored.
   */
  render(scene, camera, target = null, viewport = null) {
    const r = this.renderer, P = this.params;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = true;
    r.setRenderTarget(this.hdr);
    r.render(scene, camera);

    // bloom pyramid: threshold at 1/2, then 1/4, 1/8, 1/16, each blurred
    const du = this.pDown.material.uniforms, bu = this.pBlur.material.uniforms;
    let src = this.hdr.texture, sw = this.w, sh = this.h;
    this.levels.forEach((lv, i) => {
      du.uSrc.value = src; du.uTexel.value.set(1 / sw, 1 / sh);
      du.uThreshold.value = P.bloomThreshold; du.uFirst.value = i === 0 ? 1 : 0;
      this.pDown.render(r, lv.a);
      bu.uW.value.copy(gauss3(P.bloomSigma));
      bu.uSrc.value = lv.a.texture; bu.uStep.value.set(1 / lv.a.width, 0); this.pBlur.render(r, lv.b);
      bu.uSrc.value = lv.b.texture; bu.uStep.value.set(0, 1 / lv.a.height); this.pBlur.render(r, lv.a);
      src = lv.a.texture; sw = lv.a.width; sh = lv.a.height;
    });

    const gu = this.pGrade.material.uniforms;
    gu.uHDR.value = this.hdr.texture;
    gu.uB0.value = this.levels[0].a.texture; gu.uB1.value = this.levels[1].a.texture;
    gu.uB2.value = this.levels[2].a.texture; gu.uB3.value = this.levels[3].a.texture;
    gu.uBloomW.value.set(...P.bloomWeights); gu.uBloom.value = P.bloom;
    gu.uExposure.value = P.exposure; gu.uWhite.value.set(...P.white);
    gu.uSaturation.value = P.saturation; gu.uVibrance.value = P.vibrance; gu.uContrast.value = P.contrast;
    gu.uLook.value = P.look; gu.uTonemap.value = P.tonemap === 'aces' ? 1 : P.tonemap === 'none' ? 2 : 0;

    if (viewport) {
      if (target) {
        target.viewport.set(viewport.x, viewport.y, viewport.w, viewport.h);
        target.scissor.set(viewport.x, viewport.y, viewport.w, viewport.h);
        target.scissorTest = true;
        this.pGrade.render(r, target);
        target.viewport.set(0, 0, target.width, target.height);
        target.scissor.set(0, 0, target.width, target.height);
        target.scissorTest = false;
      } else {
        const pr = r.getPixelRatio();
        r.getSize(this._size);
        r.setViewport(viewport.x / pr, viewport.y / pr, viewport.w / pr, viewport.h / pr);
        r.setScissor(viewport.x / pr, viewport.y / pr, viewport.w / pr, viewport.h / pr);
        r.setScissorTest(true);
        this.pGrade.render(r, null);
        r.setScissorTest(false);
        r.setViewport(0, 0, this._size.x, this._size.y);
        r.setScissor(0, 0, this._size.x, this._size.y);
      }
    } else {
      this.pGrade.render(r, target);
    }
    r.autoClear = prevAutoClear;
    r.setRenderTarget(prevTarget);
  }

  dispose() {
    this.hdr.dispose();
    this.levels.forEach((l) => { l.a.dispose(); l.b.dispose(); });
  }
}
