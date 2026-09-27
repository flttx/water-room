import * as THREE from 'three';
import { pointsMaterial } from '../render/fx.js';

// Additive light only loses energy through water and fog; it must not add the medium's own colour.
export const ADD_MEDIUM = /* glsl */ `
vec3 wr_addMedium(vec3 col, vec3 p) { return wr_medium(col, p) - wr_medium(vec3(0.0), p); }
`;

/**
 * Additive glow sprites for bioluminescence (lures, bells, photophores).
 * Positions, colours and sizes (world metres) are written on the CPU each frame.
 */
export class GlowPoints {
  constructor(max, { core = 0.9, halo = 0.5, renderOrder = 2 } = {}) {
    this.max = max;
    this.n = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    this.size = new THREE.BufferAttribute(new Float32Array(max), 1);
    for (const a of [this.pos, this.col, this.size]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('gcol', this.col);
    g.setAttribute('gsize', this.size);
    g.setDrawRange(0, 0);
    this.material = pointsMaterial({
      uniforms: { uCore: { value: core }, uHalo: { value: halo } },
      vertex: /* glsl */ `
        attribute vec3 gcol;
        attribute float gsize;
        varying vec3 vCol;
        void main() {
          vWPos = position;
          vWNrm = vec3(0.0, 1.0, 0.0);
          vec4 mv = viewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(gsize * uPx / max(-mv.z, 0.1), 0.0, 700.0);
          vCol = gcol;
        }
      `,
      fragment: /* glsl */ `${ADD_MEDIUM}
        uniform float uCore;
        uniform float uHalo;
        varying vec3 vCol;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r = length(c) * 2.0;
          if (r > 1.0) discard;
          float a = exp(-r * r * 5.0) * uHalo + exp(-r * r * 70.0) * uCore;
          gl_FragColor = vec4(wr_addMedium(vCol * a, vWPos), 1.0);
        }
      `,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
  }

  set(i, x, y, z, r, gr, b, size) {
    this.pos.array[i * 3] = x;
    this.pos.array[i * 3 + 1] = y;
    this.pos.array[i * 3 + 2] = z;
    this.col.array[i * 3] = r;
    this.col.array[i * 3 + 1] = gr;
    this.col.array[i * 3 + 2] = b;
    this.size.array[i] = size;
  }

  /** Upload the first n sprites. */
  upload(n) {
    this.n = Math.min(n, this.max);
    this.points.geometry.setDrawRange(0, this.n);
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
    this.size.needsUpdate = true;
  }

  dispose() {
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
