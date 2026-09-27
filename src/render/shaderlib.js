import * as THREE from 'three';

export const LAMP_N = 10;

/** Uniform objects shared by reference across every patched material. */
export const G = {
  uTime: { value: 0 },
  uLampPos: { value: Array.from({ length: LAMP_N }, () => new THREE.Vector4()) },
  uLampCol: { value: Array.from({ length: LAMP_N }, () => new THREE.Vector4()) },
  uFogColor: { value: new THREE.Color(0.006, 0.012, 0.016) },
  uFogDensity: { value: 0.03 },
  uWaterAbsorb: { value: new THREE.Vector3(0.32, 0.105, 0.075) },
  uWaterScatter: { value: new THREE.Color(0.0, 0.018, 0.028) },
  uReflect: { value: 0 },
  uCaustic: { value: 1 },
  uBakeScale: { value: 1 },
  uAmbient: { value: new THREE.Color(0.01, 0.014, 0.018) },
  // player flashlight: spot cone from the camera
  uFlPos: { value: new THREE.Vector3() },
  uFlDir: { value: new THREE.Vector3(0, 0, -1) },
  uFlOn: { value: 0 },
};

export const GLSL_COMMON = /* glsl */ `
#define LAMP_N ${LAMP_N}
uniform float uTime;
uniform vec4 uLampPos[LAMP_N];
uniform vec4 uLampCol[LAMP_N];
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uWaterAbsorb;
uniform vec3 uWaterScatter;
uniform float uReflect;
uniform float uCaustic;
uniform float uBakeScale;
uniform vec3 uAmbient;
uniform vec3 uFlPos;
uniform vec3 uFlDir;
uniform float uFlOn;
varying vec3 vWPos;
varying vec3 vWNrm;

float wr_hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float wr_noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(wr_hash(i + vec3(0,0,0)), wr_hash(i + vec3(1,0,0)), f.x),
                 mix(wr_hash(i + vec3(0,1,0)), wr_hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(wr_hash(i + vec3(0,0,1)), wr_hash(i + vec3(1,0,1)), f.x),
                 mix(wr_hash(i + vec3(0,1,1)), wr_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float wr_fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * wr_noise(p); p *= 2.03; a *= 0.5; }
  return s;
}
float wr_caustic(vec2 p, float t) {
  // the iteration is only well-behaved far from the origin (as in the original tileable caustic)
  p -= 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return min(pow(abs(c), 8.0), 3.0);
}
float wr_waterPath(vec3 c, vec3 p) {
  float d = length(p - c);
  if (c.y >= 0.0 && p.y >= 0.0) return 0.0;
  if (c.y < 0.0 && p.y < 0.0) return d;
  if (c.y >= 0.0) return d * (-p.y) / max(c.y - p.y, 1e-4);
  return d * (-c.y) / max(p.y - c.y, 1e-4);
}
vec3 wr_medium(vec3 col, vec3 p) {
  vec3 c = cameraPosition;
  float d = length(p - c);
  // reflection pass: the mirrored camera sees only the air above the surface
  if (uReflect > 0.5) return mix(col, uFogColor, 1.0 - exp(-uFogDensity * uFogDensity * d * d));
  float wl = wr_waterPath(c, p);
  float al = max(d - wl, 0.0);
  vec3 T = exp(-uWaterAbsorb * wl);
  float fa = 1.0 - exp(-uFogDensity * uFogDensity * al * al);
  if (c.y >= 0.0) {
    col = col * T + uWaterScatter * (1.0 - T);
    col = mix(col, uFogColor, fa);
  } else {
    col = mix(col, uFogColor, fa);
    col = col * T + uWaterScatter * (1.0 - T);
  }
  return col;
}
`;

const VERT_DECL = /* glsl */ `
varying vec3 vWPos;
varying vec3 vWNrm;
#ifdef ENV_BAKED
attribute vec3 bake;
attribute float cmask;
varying vec3 vBake;
varying float vCMask;
#endif
`;

const VERT_BODY = /* glsl */ `
#include <project_vertex>
{
  vec4 wp4 = vec4(transformed, 1.0);
  vec3 wn = objectNormal;
  #ifdef USE_INSTANCING
    wp4 = instanceMatrix * wp4;
    wn = mat3(instanceMatrix) * wn;
  #endif
  vWPos = (modelMatrix * wp4).xyz;
  vWNrm = normalize(mat3(modelMatrix) * wn);
  #ifdef ENV_BAKED
    vBake = bake;
    vCMask = cmask;
  #endif
}
`;

// Tile zone colouring + grime for the environment shell
const ENV_ALBEDO = /* glsl */ `
{
  float y = vWPos.y;
  vec3 n = normalize(vWNrm);
  bool wall = abs(n.y) < 0.5;
  vec3 above = vec3(0.84, 0.86, 0.80);
  vec3 below = vec3(0.36, 0.66, 0.72);
  vec3 tint = mix(above, below, smoothstep(0.1, -0.5, y));
  if (wall) {
    // dark blue waterline band, white coping, decorative band on tall walls
    tint = mix(tint, vec3(0.10, 0.22, 0.34), step(abs(y + 0.05), 0.24));
    tint = mix(tint, vec3(0.16, 0.34, 0.40), step(abs(y - 1.72), 0.1));
    tint = mix(tint, vec3(0.16, 0.34, 0.40), step(abs(y + 3.4), 0.12));
  } else if (n.y > 0.5 && y > 0.3) {
    tint *= vec3(0.93, 0.92, 0.86);
  } else if (n.y < -0.5) {
    tint *= vec3(0.9, 0.9, 0.86);
  }
  vec3 p = vWPos;
  float g = wr_fbm(p * 0.35 + vec3(3.1, 0.0, 7.7));
  float streak = wr_noise(vec3((p.x + p.z) * 2.3, p.y * 0.18, 0.0));
  float grime = smoothstep(0.45, 0.9, g) * 0.55;
  if (wall) grime += smoothstep(0.55, 1.0, streak) * 0.35 * smoothstep(-1.0, 3.0, y);
  if (n.y < -0.5) grime += smoothstep(0.5, 0.85, wr_fbm(p * 0.22)) * 0.5;
  // algae / scum near the waterline
  float wl = 1.0 - smoothstep(0.0, 0.9, abs(y - 0.1));
  vec3 scum = vec3(0.45, 0.55, 0.38);
  diffuseColor.rgb *= tint;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * scum, wl * 0.6 * (0.5 + 0.5 * g));
  diffuseColor.rgb *= 1.0 - clamp(grime, 0.0, 0.75) * vec3(0.95, 0.9, 0.8);
  // patches of missing tiles show dark concrete
  float hole = wr_fbm(p * 0.6 + vec3(11.0));
  if (hole > 0.74 && y > -2.0) diffuseColor.rgb = vec3(0.13, 0.13, 0.12) * (0.7 + g * 0.6);
}
`;

const LAMP_LOOP = /* glsl */ `
{
  #ifdef ENV_BAKED
    reflectedLight.indirectDiffuse += vBake * uBakeScale * material.diffuseColor;
    // baked light doubles as a soft occlusion term for the specular loop
    float specOcc = smoothstep(0.0, 0.06, dot(vBake * uBakeScale, vec3(0.3333)));
  #else
    reflectedLight.indirectDiffuse += uProbe * material.diffuseColor;
    float specOcc = 1.0;
  #endif
  for (int i = 0; i < LAMP_N; i++) {
    vec4 lp = uLampPos[i];
    vec4 lc = uLampCol[i];
    if (lp.w <= 0.0) continue;
    vec3 lpos = (viewMatrix * vec4(lp.xyz, 1.0)).xyz;
    vec3 Lv = lpos - geometryPosition;
    float d = length(Lv);
    if (d > lp.w) continue;
    vec3 L = Lv / d;
    float ndl = saturate(dot(geometryNormal, L));
    float win = saturate(1.0 - pow(d / lp.w, 4.0));
    float att = win * win / (d * d * 0.09 + 1.0);
    if (lp.y > 0.0 && vWPos.y < 0.0) att *= exp(-0.2 * -vWPos.y);
    else if (lp.y < 0.0 && vWPos.y > 0.0) att *= 0.2;
    vec3 irr = lc.rgb * att * ndl;
    #ifdef ENV_BAKED
      // lc.w is the brightness change relative to the bake; never remove more light than was baked
      vec3 dd = max(irr * BRDF_Lambert(material.diffuseContribution) * lc.w, -vBake * uBakeScale * material.diffuseColor);
    #else
      vec3 dd = irr * BRDF_Lambert(material.diffuseContribution);
    #endif
    reflectedLight.directDiffuse += dd;
    reflectedLight.directSpecular += irr * BRDF_GGX(L, geometryViewDir, geometryNormal, material) * specOcc;
  }
  if (uFlOn > 0.0) {
    vec3 fp = (viewMatrix * vec4(uFlPos, 1.0)).xyz;
    vec3 fdir = normalize((viewMatrix * vec4(uFlDir, 0.0)).xyz);
    vec3 Lv = fp - geometryPosition;
    float d = length(Lv);
    vec3 L = Lv / max(d, 1e-3);
    float c = dot(-L, fdir);
    float cone = smoothstep(0.86, 0.95, c) * 0.75 + smoothstep(0.965, 0.992, c) * 0.6;
    // the beam travels through water on its way out as well
    vec3 irr = vec3(1.0, 0.92, 0.78) * 7.0 * uFlOn * cone / (1.0 + d * d * 0.03) * saturate(dot(geometryNormal, L));
    irr *= exp(-uWaterAbsorb * wr_waterPath(uFlPos, vWPos));
    reflectedLight.directDiffuse += irr * BRDF_Lambert(material.diffuseContribution);
    reflectedLight.directSpecular += irr * BRDF_GGX(L, geometryViewDir, geometryNormal, material);
  }
  #ifdef ENV_BAKED
  if (vCMask > 0.01) {
    vec3 n = normalize(vWNrm);
    vec2 cp = abs(n.y) > 0.5 ? vWPos.xz : vec2(vWPos.x + vWPos.z, vWPos.y * 1.6);
    float c = wr_caustic(mod(cp * 0.55, 6.2831853), uTime * 0.55);
    float lightHere = dot(vBake * uBakeScale, vec3(0.3333)) + 0.02;
    reflectedLight.indirectDiffuse += material.diffuseColor * c * vCMask * lightHere * uCaustic * vec3(0.75, 0.95, 1.0) * 2.2;
  }
  #endif
}
`;

/**
 * Patch a MeshStandardMaterial so it uses the game's lamp loop, water absorption and fog.
 * opts.env: use baked vertex lighting, caustics and procedural tile tinting.
 * opts.albedo: extra GLSL applied to diffuseColor after color_fragment.
 */
export function patchMaterial(material, opts = {}) {
  const env = !!opts.env;
  material.defines = material.defines || {};
  if (env) material.defines.ENV_BAKED = '';
  material.fog = false;
  const key = `wr-${env ? 'env' : 'std'}-${opts.tiles ? 't' : ''}-${opts.key || ''}`;
  material.customProgramCacheKey = () => key;
  // per-material light probe for moving objects; defaults to the shared ambient
  const probe = opts.probe || G.uAmbient;
  material.userData.probe = probe;
  material.onBeforeCompile = (shader) => {
    for (const k of Object.keys(G)) shader.uniforms[k] = G[k];
    shader.uniforms.uProbe = probe;
    if (opts.uniforms) Object.assign(shader.uniforms, opts.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}${opts.vertDecl || ''}`)
      .replace('#include <project_vertex>', VERT_BODY + (opts.vertBody || ''));
    if (opts.vertTransform) {
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${opts.vertTransform}`);
    }
    let fs = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_COMMON}uniform vec3 uProbe;\n${env ? 'varying vec3 vBake; varying float vCMask;' : ''}${opts.fragDecl || ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${opts.tiles ? ENV_ALBEDO : ''}${opts.albedo || ''}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${LAMP_LOOP}${opts.lighting || ''}`)
      .replace('#include <fog_fragment>', 'gl_FragColor.rgb = wr_medium(gl_FragColor.rgb, vWPos);');
    if (opts.emissive) fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${opts.emissive}`);
    // opts.after: { chunkName: glsl } appended after that fragment chunk; opts.vertReplace: { chunkName: glsl } replaces a vertex chunk
    for (const [chunk, code] of Object.entries(opts.after || {})) fs = fs.replace(`#include <${chunk}>`, `#include <${chunk}>\n${code}`);
    for (const [chunk, code] of Object.entries(opts.vertReplace || {})) shader.vertexShader = shader.vertexShader.replace(`#include <${chunk}>`, code);
    shader.fragmentShader = fs;
  };
  material.needsUpdate = true;
  return material;
}
