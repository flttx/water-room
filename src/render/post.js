import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const FinalShader = {
  name: 'FinalFX',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uUnder: { value: 0 },
    uDanger: { value: 0 },
    uFade: { value: 0 },
    uHurt: { value: 0 },
    uBreath: { value: 1 },
    uGrain: { value: 0.045 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uSurface: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uUnder, uDanger, uFade, uHurt, uBreath, uGrain, uSurface;
    uniform vec2 uRes;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      // underwater refraction wobble
      uv += uUnder * vec2(sin(uv.y * 22.0 + uTime * 1.7), cos(uv.x * 18.0 + uTime * 1.3)) * 0.0018;
      // water film right after surfacing
      uv += uSurface * vec2(sin(uv.y * 40.0 + uTime * 3.0), sin(uv.x * 35.0 - uTime * 2.0)) * 0.004 * smoothstep(0.2, 0.9, uv.y);
      float r2 = dot(c, c);
      float ca = (0.0012 + uDanger * 0.006 + uUnder * 0.0015) * r2 * 4.0;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * ca).b;
      // vignette, tightened by danger and low breath
      float suffocate = 1.0 - smoothstep(0.0, 0.35, uBreath);
      float vig = smoothstep(0.95 - uDanger * 0.25 - suffocate * 0.45, 0.2 - suffocate * 0.1, length(c * vec2(1.0, 0.85)) * 1.35);
      col *= mix(0.25, 1.0, vig);
      // danger: pulse desaturation toward red-black
      float pulse = 0.5 + 0.5 * sin(uTime * 7.5);
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(lum) * vec3(1.15, 0.8, 0.8), uDanger * 0.35 * (0.6 + 0.4 * pulse));
      col = mix(col, vec3(lum * 0.6, 0.0, 0.0), uHurt);
      // grain
      float g = hash(uv * uRes + fract(uTime * 13.7) * 100.0) - 0.5;
      col += g * uGrain * (0.6 + uDanger);
      col *= 1.0 - uFade;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class Post {
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer;
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: opts.msaa ? 4 : 0 });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.6, 0.5, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.final);
    this.u = this.final.uniforms;
    this.u.uRes.value.copy(size);
  }

  setSize(w, h) {
    this.composer.setSize(w, h);
    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);
    this.u.uRes.value.copy(size);
  }

  setBloom(on) { this.bloom.enabled = on; }

  render(dt) { this.composer.render(dt); }
}
