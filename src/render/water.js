import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { G, GLSL_COMMON } from './shaderlib.js';
import { makeWaterNormal } from './textures.js';

const RIPPLE_N = 16;

const WaterShader = {
  name: 'WaterSurface',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    tNormal: { value: null },
    uRipples: { value: [] },
    uHasRefl: { value: 1 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWPos;
    varying vec3 vWNrm;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWPos = wp.xyz;
      vWNrm = vec3(0.0, 1.0, 0.0);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */ `
    ${GLSL_COMMON}
    #define RIPPLE_N ${RIPPLE_N}
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform vec4 uRipples[RIPPLE_N];
    uniform float uHasRefl;
    varying vec4 vUv;

    vec3 surfaceNormal(out float foam) {
      vec2 p = vWPos.xz;
      vec2 n1 = texture2D(tNormal, p * 0.085 + vec2(uTime * 0.011, uTime * 0.007)).xy * 2.0 - 1.0;
      vec2 n2 = texture2D(tNormal, p * 0.23 - vec2(uTime * 0.016, -uTime * 0.012)).xy * 2.0 - 1.0;
      vec2 n3 = texture2D(tNormal, p * 0.6 + vec2(-uTime * 0.03, uTime * 0.021)).xy * 2.0 - 1.0;
      vec2 d = n1 * 0.13 + n2 * 0.09 + n3 * 0.04;
      foam = 0.0;
      for (int i = 0; i < RIPPLE_N; i++) {
        vec4 r = uRipples[i];
        if (r.w <= 0.0) continue;
        float age = uTime - r.z;
        if (age < 0.0 || age > 5.0) continue;
        vec2 dv = p - r.xy;
        float dist = length(dv) + 1e-4;
        float k = dist - age * 1.7;
        float env = exp(-k * k * 2.2) * exp(-age * 0.9) * r.w / (1.0 + dist * 0.6);
        d += (dv / dist) * sin(k * 8.0) * env * 0.8;
        foam += env * smoothstep(0.6, 0.0, age) * 0.6;
      }
      return normalize(vec3(d.x, 1.0, d.y));
    }

    void main() {
      float foam;
      vec3 N = surfaceNormal(foam);
      vec3 toCam = cameraPosition - vWPos;
      float dist = length(toCam);
      vec3 V = toCam / dist;
      vec3 col;
      float a;
      if (cameraPosition.y >= 0.0) {
        float cosT = clamp(dot(N, V), 0.0, 1.0);
        float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
        vec4 uvp = vUv;
        uvp.xy += N.xz * 0.9 * uvp.w * 0.06;
        vec3 refl = texture2DProj(tDiffuse, uvp).rgb * uHasRefl;
        // glints of the lamps on the ripples
        vec3 spec = vec3(0.0);
        vec3 lit = vec3(0.0);
        for (int i = 0; i < LAMP_N; i++) {
          vec4 lp = uLampPos[i];
          if (lp.w <= 0.0 || lp.y < 0.0) continue;
          vec3 Lv = lp.xyz - vWPos;
          float ld = length(Lv);
          if (ld > lp.w * 1.6) continue;
          vec3 L = Lv / ld;
          vec3 H = normalize(L + V);
          float ndh = max(dot(N, H), 0.0);
          float att = 1.0 / (1.0 + ld * ld * 0.02);
          spec += uLampCol[i].rgb * (pow(ndh, 900.0) * 2.5 + pow(ndh, 240.0) * 0.05) * att;
          lit += uLampCol[i].rgb * att;
        }
        // glints follow the Fresnel term (dim when looking down into the water) and stay below a
        // couple of units so bloom sparkles instead of fogging the whole frame
        spec = min(spec * (0.12 + F * 4.0), vec3(1.6));
        col = min(refl * F * color, vec3(3.0)) + spec + lit * 0.0015 + foam * lit * 0.06;
        a = clamp(F + 0.06 + foam * 0.2, 0.0, 1.0);
        float fa = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
        col = col * (1.0 - fa) + uFogColor * fa * a;
      } else {
        // seen from below: Snell's window, total internal reflection outside it
        vec3 Nd = -N;
        float cosI = clamp(dot(V, Nd), 0.0, 1.0);
        float sinI = sqrt(1.0 - cosI * cosI);
        float T = smoothstep(0.8, 0.68, sinI);
        float ring = exp(-pow((sinI - 0.74) * 18.0, 2.0));
        vec3 tir = uWaterScatter * 2.2 + vec3(0.0, 0.01, 0.014) * wr_noise(vec3(vWPos.xz * 0.4, uTime * 0.2));
        col = tir * (1.0 - T) + vec3(0.25, 0.45, 0.5) * ring * 0.08;
        a = 1.0 - T * 0.82;
        vec3 Tr = exp(-uWaterAbsorb * dist);
        col = col * Tr + uWaterScatter * (1.0 - Tr) * a;
      }
      gl_FragColor = vec4(col, a);
    }
  `,
};

export class Water {
  constructor(geometry, renderer) {
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    this.scale = 0.5;
    this.reflector = new Reflector(geometry, {
      textureWidth: Math.max(2, Math.floor(size.x * this.scale)),
      textureHeight: Math.max(2, Math.floor(size.y * this.scale)),
      color: 0xb8c4c8,
      clipBias: 0.003,
      multisample: 0,
      shader: WaterShader,
    });
    const mesh = this.reflector;
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    const mat = mesh.material;
    for (const k of Object.keys(G)) mat.uniforms[k] = G[k];
    mat.uniforms.tNormal.value = makeWaterNormal(512);
    this.ripples = Array.from({ length: RIPPLE_N }, () => new THREE.Vector4(0, 0, -99, 0));
    mat.uniforms.uRipples.value = this.ripples;
    this.rippleHead = 0;
    mat.transparent = true;
    mat.depthWrite = true;
    mat.side = THREE.DoubleSide;
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    this.enabled = true;

    // flag the reflection pass so patched materials mirror the camera for fog
    const base = mesh.onBeforeRender;
    mesh.onBeforeRender = (r, scene, camera, ...rest) => {
      if (!this.enabled) return;
      G.uReflect.value = 1;
      try {
        base.call(mesh, r, scene, camera, ...rest);
      } finally {
        G.uReflect.value = 0;
      }
    };
  }

  setReflections(on) {
    this.enabled = on;
    this.reflector.material.uniforms.uHasRefl.value = on ? 1 : 0;
  }

  setSize(w, h) {
    this.reflector.getRenderTarget().setSize(Math.max(2, Math.floor(w * this.scale)), Math.max(2, Math.floor(h * this.scale)));
  }

  addRipple(x, z, strength = 1) {
    const r = this.ripples[this.rippleHead];
    r.set(x, z, G.uTime.value, strength);
    this.rippleHead = (this.rippleHead + 1) % RIPPLE_N;
  }
}
