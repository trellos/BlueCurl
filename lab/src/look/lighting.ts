// Lighting and look presets. One sun (the only shadow caster, one tight shadow map on surfer
// and board), one IBL, AgX tone mapping. Presets: B Golden Hour, D Soft Overcast, Studio.
//
// HDRIs: CC0 from Poly Haven (redistributed in the three.js examples). For Golden Hour the
// sun direction is measured from the HDRI itself and the environment is rotated so that the
// HDRI sun and the shadow-casting sun agree. The only reachable golden-hour HDRI
// (blouberg_sunrise_2) is shot on land with buildings on the horizon, so it lights the
// subject only; the visible sky and the sea reflection come from a procedural (Preetham) sky
// with the same sun direction. Toggle `subjectIbl` to light the subject from that sky too.

import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

export type PresetId = 'B' | 'D' | 'studio';

export interface LookPreset {
  id: PresetId;
  label: string;
  /** Sun azimuth (deg) in world: 0 = +X (down the line), positive toward -Z (behind the wave). */
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  sunColor: THREE.Color;
  sunIntensity: number;
  envIntensity: number;
  exposure: number;
  shadowRadius: number;
  fogColor: THREE.Color;
  fogDensity: number;
  stage: 'sea' | 'studio';
}

export const PRESETS: Record<PresetId, LookPreset> = {
  B: {
    id: 'B',
    label: 'B Golden Hour',
    sunAzimuthDeg: 28,
    sunElevationDeg: 9,
    sunColor: new THREE.Color(1.0, 0.72, 0.46),
    sunIntensity: 5.5,
    envIntensity: 0.9,
    exposure: 0.85,
    shadowRadius: 2,
    fogColor: new THREE.Color(0.85, 0.66, 0.5),
    fogDensity: 0.0009,
    stage: 'sea',
  },
  D: {
    id: 'D',
    label: 'D Soft Overcast',
    sunAzimuthDeg: -35,
    sunElevationDeg: 48,
    sunColor: new THREE.Color(0.92, 0.95, 1.0),
    sunIntensity: 0.55,
    envIntensity: 1.0,
    exposure: 1.15,
    shadowRadius: 12,
    fogColor: new THREE.Color(0.62, 0.66, 0.68),
    fogDensity: 0.0022,
    stage: 'sea',
  },
  studio: {
    id: 'studio',
    label: 'Studio',
    sunAzimuthDeg: 150,
    sunElevationDeg: 50,
    sunColor: new THREE.Color(1, 0.98, 0.95),
    sunIntensity: 2.4,
    envIntensity: 0.7,
    exposure: 1.0,
    shadowRadius: 5,
    fogColor: new THREE.Color(0.3, 0.3, 0.3),
    fogDensity: 0,
    stage: 'studio',
  },
};

/**
 * CIE standard overcast sky as a float equirect: L(el) = Lz (1 + 2 sin el) / 3,
 * with a faint brighter patch toward the hidden sun and a grey "sea" below the horizon.
 */
function makeOvercastSky(sunDir: THREE.Vector3): THREE.DataTexture {
  const W = 256;
  const H = 128;
  const data = new Float32Array(W * H * 4);
  const d = new THREE.Vector3();
  for (let j = 0; j < H; j++) {
    // three's equirect lookup: v = asin(y)/pi + 0.5 (row 0 = bottom with flipY false)
    const el = ((j + 0.5) / H - 0.5) * Math.PI;
    for (let i = 0; i < W; i++) {
      const az = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
      d.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
      let L: number;
      let tint = [0.93, 0.96, 1.0];
      if (el > 0) {
        L = (1 + 2 * Math.sin(el)) / 3;
        const g = Math.max(0, d.dot(sunDir));
        L *= 1 + 0.35 * Math.pow(g, 8);
      } else {
        // sea and haze below the horizon
        const k = Math.min(1, -el / 0.25);
        L = 0.33 * (1 - k) + 0.06 * k;
        tint = [0.62, 0.72, 0.74];
      }
      const o = (j * W + i) * 4;
      const Lz = 1.6;
      data[o] = Lz * L * tint[0];
      data[o + 1] = Lz * L * tint[1];
      data[o + 2] = Lz * L * tint[2];
      data[o + 3] = 1;
    }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Azimuth (radians, from +X toward +Z) and elevation of the brightest texel of an equirect HDR. */
function findHdrSun(tex: THREE.DataTexture): { az: number; el: number } {
  const img = tex.image as { data: Float32Array | Uint16Array; width: number; height: number };
  const { width: W, height: H } = img;
  const src = img.data;
  const half = src instanceof Uint16Array;
  let best = -1;
  let bi = 0;
  let bj = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const o = (j * W + i) * 4;
      const r = half ? THREE.DataUtils.fromHalfFloat(src[o]) : src[o];
      const g = half ? THREE.DataUtils.fromHalfFloat(src[o + 1]) : src[o + 1];
      const b = half ? THREE.DataUtils.fromHalfFloat(src[o + 2]) : src[o + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (l > best) {
        best = l;
        bi = i;
        bj = j;
      }
    }
  }
  // HDRLoader output has flipY = true: image row 0 is the top of the panorama.
  const v = tex.flipY ? 1 - (bj + 0.5) / H : (bj + 0.5) / H;
  const u = (bi + 0.5) / W;
  // three equirect: u = atan(dir.z, dir.x) / (2 pi) + 0.5, v = asin(dir.y) / pi + 0.5
  return { az: (u - 0.5) * 2 * Math.PI, el: (v - 0.5) * Math.PI };
}

export class Lighting {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  preset: LookPreset = PRESETS.B;
  sunDir = new THREE.Vector3();
  private envs = new Map<PresetId, { env: THREE.Texture; bg: THREE.Texture | THREE.Color; rotY: number }>();
  private pmrem: THREE.PMREMGenerator;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  /** Half-size of the shadow frustum box around the subject (m). */
  shadowHalfSize = 1.6;
  readonly sky = new Sky();
  /** Environment for the sea (sky only, no land) per preset. */
  seaEnv: THREE.Texture | null = null;
  private seaEnvs = new Map<PresetId, THREE.Texture>();
  subjectIbl: 'hdri' | 'sky' = 'hdri';

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.015;
    const c = this.sun.shadow.camera;
    c.near = 0.1;
    c.far = 30;
    scene.add(this.sun, this.sun.target);
    // A dim hemisphere fill is off by default (IBL does the fill); kept for debugging.
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 0);
    scene.add(this.hemi);
  }

  async load(): Promise<void> {
    const hdr = await new HDRLoader().loadAsync(`${import.meta.env.BASE_URL}assets/hdri/blouberg_sunrise_2_1k.hdr`);
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    const s = findHdrSun(hdr);
    const B = PRESETS.B;
    // Rotate the environment about Y so the HDRI sun lands at the preset azimuth.
    // Sun azimuth convention here: angle from +X toward -Z, i.e. atan2(-z, x).
    // HDR az is atan2(z, x). A Y rotation by r maps az -> az - r (three rotates the lookup).
    const want = -(B.sunAzimuthDeg * Math.PI) / 180; // as atan2(z, x)
    const rotY = s.az - want;
    B.sunElevationDeg = Math.max(4, (s.el * 180) / Math.PI);
    this.envs.set('B', { env: this.pmrem.fromEquirectangular(hdr).texture, bg: hdr, rotY });
    this.sky.scale.setScalar(5000);
    this.sky.name = 'sky';
    this.sky.visible = false;
    const su = this.sky.material.uniforms;
    su.turbidity.value = 4;
    su.rayleigh.value = 1.2;
    su.mieCoefficient.value = 0.006;
    su.mieDirectionalG.value = 0.86;
    su.cloudCoverage.value = 0.25;
    su.cloudDensity.value = 0.3;
    su.showSunDisc.value = 1;
    this.scene.add(this.sky);
    this.refreshSky(B);

    const D = PRESETS.D;
    const dDir = sunVector(D.sunAzimuthDeg, D.sunElevationDeg, new THREE.Vector3());
    const sky = makeOvercastSky(dDir);
    this.envs.set('D', { env: this.pmrem.fromEquirectangular(sky).texture, bg: sky, rotY: 0 });
    this.seaEnvs.set('D', this.envs.get('D')!.env);

    const room = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.envs.set('studio', { env: room, bg: new THREE.Color(0.32, 0.33, 0.34), rotY: 0 });
  }

  apply(id: PresetId): LookPreset {
    const p = PRESETS[id];
    this.preset = p;
    const e = this.envs.get(id);
    if (e) {
      const useSky = id === 'B';
      this.scene.environment = useSky && this.subjectIbl === 'sky' ? this.seaEnvs.get('B')! : e.env;
      this.scene.background = useSky ? null : e.bg;
      this.scene.environmentRotation.set(0, useSky && this.subjectIbl === 'sky' ? 0 : e.rotY, 0);
      this.scene.backgroundRotation.set(0, e.rotY, 0);
      this.sky.visible = useSky;
      this.seaEnv = this.seaEnvs.get(id) ?? null;
    }
    this.scene.environmentIntensity = p.envIntensity;
    this.scene.backgroundIntensity = id === 'B' ? 1 : 1;
    this.renderer.toneMappingExposure = p.exposure;
    this.sun.color.copy(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    this.sun.shadow.radius = p.shadowRadius;
    this.scene.fog = p.fogDensity > 0 ? new THREE.FogExp2(p.fogColor.getHex(), p.fogDensity) : null;
    sunVector(p.sunAzimuthDeg, p.sunElevationDeg, this.sunDir);
    return p;
  }

  setSun(azDeg: number, elDeg: number): void {
    this.preset.sunAzimuthDeg = azDeg;
    this.preset.sunElevationDeg = elDeg;
    sunVector(azDeg, elDeg, this.sunDir);
    if (this.preset.id === 'B') {
      this.refreshSky(this.preset);
      this.apply('B');
    }
  }

  /** Re-render the procedural sky into a PMREM for the sea reflection (and optional subject IBL). */
  private refreshSky(p: LookPreset): void {
    sunVector(p.sunAzimuthDeg, p.sunElevationDeg, this.sunDir);
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    const s = new THREE.Scene();
    const sk = new Sky();
    sk.material.uniforms = this.sky.material.uniforms;
    sk.scale.setScalar(1000);
    s.add(sk);
    // the Preetham model is meaningless below the horizon: close it with a dark sea hemisphere
    const ground = new THREE.Mesh(
      new THREE.SphereGeometry(400, 64, 32, 0, Math.PI * 2, Math.PI / 2 - 0.004, Math.PI / 2 + 0.004),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.02, 0.045, 0.05), side: THREE.BackSide }),
    );
    s.add(ground);
    const old = this.seaEnvs.get('B');
    this.seaEnvs.set('B', this.pmrem.fromScene(s, 0.02).texture);
    old?.dispose();
  }

  /** Keep the tight shadow frustum centred on the subject (board + rider). */
  follow(subject: THREE.Vector3): void {
    const c = this.sun.shadow.camera;
    const h = this.shadowHalfSize;
    c.left = -h;
    c.right = h;
    c.top = h;
    c.bottom = -h;
    c.updateProjectionMatrix();
    this.sun.target.position.copy(subject);
    this.sun.position.copy(subject).addScaledVector(this.sunDir, 12);
    this.sun.target.updateMatrixWorld();
  }
}

/** Unit vector toward the sun. Azimuth from +X toward -Z (behind the wave), elevation up. */
export function sunVector(azDeg: number, elDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return out.set(Math.cos(el) * Math.cos(az), Math.sin(el), -Math.cos(el) * Math.sin(az));
}
