// Shared look helpers for spot materials: a warm back/rim light term so silhouettes facing the low dawn sun
// glow (stylised, GTA-ish), added as emissive in MeshStandardMaterial shaders.
import * as THREE from 'three';

export function createRimUniforms(sunDir) {
  return {
    uSunDir: { value: sunDir.clone().normalize() },
    uRimColor: { value: new THREE.Color(0xffb46a) },
    uRimStrength: { value: 1.0 },
  };
}

/** Patch a MeshStandardMaterial shader (inside onBeforeCompile) with the rim term. */
export function patchRim(sh, rimU) {
  if (!rimU) return;
  Object.assign(sh.uniforms, rimU);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
uniform vec3 uSunDir; uniform vec3 uRimColor; uniform float uRimStrength;`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  vec3 vdir = normalize(vViewPosition);
  float ndv = clamp(dot(normal, vdir), 0.0, 1.0);
  float back = clamp(dot(-vdir, sunV), 0.0, 1.0);              // looking toward the sun
  float edge = pow(1.0 - ndv, 3.0);
  float facing = smoothstep(-0.25, 0.5, dot(normal, sunV));
  totalEmissiveRadiance += uRimColor * diffuseColor.rgb * uRimStrength * edge * facing * (0.25 + 0.75 * back);
}`);
}
