// BlueCurl Swell — analytic wave foam (WP4b). Fragment-stage GLSL.
//
// Foam is a pure function of (break phase, position, t): no persistence texture (contracts determinism rule).
//   envelope  — from wave coordinates: tau (unclamped age since the column started breaking, in Tb units), sigma
//               relative to the profile landmarks (crest / lip tip / trough), xi (m, + shoreward), H, curl, mush.
//   detail    — foamNoise (viz/src/water/foamNoise.js: R coarse lumps, G fine lumps, B lace F1, A ridges),
//               sampled in WORLD space (trailing foam / carpets stay where the bore left them) or in the wave frame
//               (xi, z) with a two-phase flow cross-fade for the churning bore. Never along the crest, so the
//               texture does not slide sideways with the peel.
//
// Components:
//   lip line   tau 0.06…0.66   bright line on the lip tip while it throws (feathering over the crest on walls)
//   spill      mush            whitewater spilling down the upper face from the start of the break
//   bore       tau 0.5…2       the exploding whitewater after the plunge, covering crest → trough, fading by tau 2
//   trail      behind crest    deposited where the bore passed (tau at that moment = tau − |xi|/(|vx|·Tb)),
//                              decays in place over uFoamTune.y s, streaky, faded before the mesh's back edge
//   carpet     tau 0.9…2.6     streaky carpets on the re-forming swell
import { SIGMA_CREST, SIGMA_LIP, SIGMA_TROUGH } from './keyframes.js';

const f = (v) => { const s = String(v); return /[.eE]/.test(s) ? s : s + '.0'; };

export const FOAM_GLSL = /* glsl */ `
#ifndef WV_FOAM
#define WV_FOAM
uniform sampler2D uFoamTex;
uniform vec4 uFoamTune;     // x tile (m), y trail decay (s), z coverage gain, w lip-line gain
#define WV_SIG_CREST ${f(SIGMA_CREST)}
#define WV_SIG_LIP ${f(SIGMA_LIP)}
#define WV_SIG_TROUGH ${f(SIGMA_TROUGH)}

float wvCov(float env, float n, float soft) { return smoothstep(1.0 - env, 1.0 - env + soft, n); }

// two-phase flow cross-fade (no visible reset): texture drifts along dir at speed spd (tile units / s)
vec4 wvFlowTex(vec2 q, vec2 dir, float spd, float t) {
  float p0 = fract(t * 0.35), p1 = fract(t * 0.35 + 0.5);
  float w0 = 1.0 - abs(2.0 * p0 - 1.0);
  vec4 a = texture(uFoamTex, q + dir * spd * p0 / 0.35);
  vec4 b = texture(uFoamTex, q + dir * spd * p1 / 0.35 + vec2(0.37, 0.61));
  return mix(b, a, w0);
}

/**
 * Foam coverage 0..1 and (out) lip-line strength (for extra brightness).
 * tauU: unclamped break age in Tb units (<0 before the break); sg: sigma; xi, yl: local cross-section (m);
 * H column height; curl, mush shape; Tb s; vx crest speed (m/s, negative); P world position; xiMin back edge of
 * the mesh (local xi, m); N shading normal; alpha front fade; t sim time. shade: brightness relief; height: foam relief height 0..1 (bump).
 */
float wvFoam(float tauU, float sg, float xi, float yl, float H, float curl, float mush, float Tb, float vx,
             vec3 P, vec3 N, float xiMin, float alpha, float t, out float lipLine, out float shade, out float height) {
  lipLine = 0.0; shade = 1.0; height = 0.0;
  float Hg = smoothstep(0.2, 0.9, H) * alpha;
  if (Hg <= 0.0 || tauU < -0.05) return 0.0;
  float tile = uFoamTune.x;

  // ---- envelopes (wave coordinates)
  float wThrow = smoothstep(0.06, 0.22, tauU) * (1.0 - smoothstep(0.66, 0.8, tauU));   // lip open until it lands (~0.78)
  float dl = (sg - WV_SIG_LIP + 0.004) / 0.017;
  float lip = wThrow * exp(-dl * dl);
  float feather = wThrow * (1.0 - curl) * smoothstep(WV_SIG_LIP - 0.08, WV_SIG_LIP, sg) * (1.0 - smoothstep(WV_SIG_LIP, WV_SIG_LIP + 0.02, sg));
  float spill = mush * smoothstep(0.0, 0.25, tauU) * (1.0 - smoothstep(0.85, 1.25, tauU))
              * smoothstep(WV_SIG_CREST - 0.03, WV_SIG_CREST + 0.03, sg) * (1.0 - smoothstep(WV_SIG_LIP + 0.05, WV_SIG_LIP + 0.22, sg));
  float Ib = smoothstep(0.68, 0.86, tauU) * (1.0 - smoothstep(1.2, 2.05, tauU));
  float front = smoothstep(WV_SIG_CREST - 0.07, WV_SIG_CREST, sg);
  float boreS = front * (1.0 - smoothstep(WV_SIG_TROUGH, WV_SIG_TROUGH + 0.09, sg));
  // the impact explodes first around the landing lip / trough, then the whole roller is white
  float bore = Ib * boreS * mix(1.0, 0.75 + 0.25 * smoothstep(WV_SIG_LIP - 0.05, WV_SIG_LIP + 0.1, sg), 1.0 - smoothstep(0.8, 0.98, tauU));
  // impact band: the lip tip, its underside and the landing line are white from the moment it touches down
  // (hides the crease where the thrown lip meets the face)
  float impact = smoothstep(0.72, 0.82, tauU) * (1.0 - smoothstep(1.05, 1.35, tauU))
               * smoothstep(WV_SIG_LIP - 0.06, WV_SIG_LIP - 0.02, sg) * (1.0 - smoothstep(WV_SIG_TROUGH - 0.12, WV_SIG_TROUGH - 0.04, sg));
  bore = max(bore, impact);
  // trail: deposited behind the crest where the bore passed, decaying in place
  float back = max(-xi, 0.0);
  float tauH = tauU - back / (max(abs(vx), 3.0) * Tb);
  float dep = smoothstep(0.55, 0.8, tauH) * (1.0 - smoothstep(1.3, 2.3, tauH));
  float trail = dep * exp(-(tauU - tauH) * Tb / uFoamTune.y) * (1.0 - front) * smoothstep(xiMin, xiMin + 8.0, xi);
  float carpet = smoothstep(0.9, 1.25, tauU) * (1.0 - smoothstep(1.7, 2.6, tauU)) * smoothstep(xiMin, xiMin + 8.0, xi);

  float sumE = lip + feather + spill + bore + trail + carpet;
  if (sumE < 1e-3) return 0.0;

  // ---- detail. Bore: wave frame, biplanar — (xi, z) where the surface is flat, (height, z) where it is steep or
  // folded (a single (xi, z) projection streaks across the plunge)
  float wy = smoothstep(0.15, 0.6, N.y * N.y);
  vec2 dir = normalize(vec2(-0.6, 0.25));
  vec4 nbA = wvFlowTex(vec2(xi * 0.85, P.z) / tile, dir, 0.22, t);
  vec4 nbB = wvFlowTex(vec2(yl * 1.1 + 3.7, P.z) / tile, dir, 0.22, t + 0.9);
  vec4 nb = mix(nbB, nbA, wy);
  vec2 wq = P.xz / tile;                                      // world anchored (trail, carpets)
  vec4 nw = texture(uFoamTex, wq * vec2(0.35, 1.1) + vec2(0.013, 0.004) * t);   // stretched along the travel (x)
  vec4 nf = texture(uFoamTex, wq * 2.7 + vec2(0.31, 0.17));
  vec4 nc = texture(uFoamTex, wq * 0.21 + vec2(0.71, 0.29));  // coarse: density variation / rafts

  float g = uFoamTune.z;
  float nBore = 0.5 * nb.r + 0.35 * nb.g + 0.15 * nf.g;
  // bore: dense lumpy cover while young; as it ages it thins into connected lace (webs between the cells) that
  // fades in opacity — never shrinking to isolated flecks
  float envB = clamp((bore + spill) * g, 0.0, 1.0);
  float ragged = envB * (0.7 + 0.45 * nc.r + 0.25 * nf.r);         // ragged, feathered outline
  float dense = wvCov(clamp(ragged * 1.3, 0.0, 1.0), nBore + 0.12, 0.45);   // solid while young, holes only as it thins
  float laceB = smoothstep(0.35, 0.8, 1.0 - nb.a * 0.8 + 0.25 * nb.g + 0.45 * (nc.g - 0.5) + 0.2 * (nf.r - 0.5));
  float cBore = max(dense * smoothstep(0.35, 0.75, envB), laceB * smoothstep(0.0, 0.5, envB) * 0.85);
  // trail / carpets: fixed lace shape, opacity follows the envelope and the coarse rafts
  float nStreak = 0.55 * (1.0 - nw.a) + 0.25 * nw.b + 0.2 * nf.g;
  float lace = smoothstep(0.45, 0.8, nStreak);
  float fpatch = smoothstep(0.15, 0.75, nc.r * 0.7 + nw.r * 0.3);
  float cTrail = lace * clamp(trail * g * (0.55 + 0.45 * fpatch) * 1.2, 0.0, 1.0);
  float cCarpet = lace * clamp(carpet * g * 0.45 * fpatch, 0.0, 1.0);
  float cLip = clamp((lip * 0.9 + feather * 0.6) * (0.75 + 0.35 * bcVnoise(vec2(P.z * 0.9, t * 1.3))) * g, 0.0, 1.0);   // along-crest only (no rope)
  lipLine = cLip * uFoamTune.w;
  float c = max(max(cBore, cTrail), max(cCarpet, cLip));
  // relief height (0..1): lumps stand up in dense whitewater, lace is flat
  height = cBore * (0.3 + 0.7 * nBore) * smoothstep(0.3, 0.8, envB) + 0.25 * max(cTrail, cCarpet) * nStreak;
  float sB = 0.6 + 0.5 * nBore, sT = 0.8 + 0.3 * nStreak;
  shade = c > 0.0 ? (cBore * sB + max(cTrail, cCarpet) * sT + cLip) / max(cBore + max(cTrail, cCarpet) + cLip, 1e-3) : 1.0;
  return clamp(c * Hg, 0.0, 1.0);
}
#endif
`;
