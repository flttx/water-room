import * as THREE from 'three';
import { sphereClear, PoseGuard } from './collision.js';
import { DECK_BOTTOM } from '../level/level.js';

const corner = new THREE.Vector3();
function boxClear(level, lo, hi) {
  for (let z = Math.floor(lo.z / 2); z <= Math.floor(hi.z / 2); z++) for (let x = Math.floor(lo.x / 2); x <= Math.floor(hi.x / 2); x++) {
    if (level.solid(x, z) || lo.y < level.floor(x, z) || hi.y > level.ceil(x, z)) return false;
    const deck = level.deckTop?.(x, z);
    if (deck != null && hi.y > DECK_BOTTOM && lo.y < deck) return false;
  }
  return true;
}

/** Collision samples use the same four bone weights as the rendered surface. */
export class RigSurface {
  constructor(rig, groupForNode = () => 0) {
    this.rig = rig;
    const g = rig.mesh.geometry, p = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    this.nodes = rig.mesh.skeleton.bones.map((b) => rig.nodes.indexOf(b));
    this.matrices = this.nodes.map(() => new THREE.Matrix4());
    this.groups = new Map();
    this.samples = [];
    const cells = new Map();
    const seen = new Set();
    for (let v = 0; v < p.count; v++) {
      const bones = [], weights = [];
      let dominant = 0;
      for (let k = 0; k < 4; k++) {
        bones.push(si.getComponent(v, k)); weights.push(sw.getComponent(v, k));
        if (weights[k] > weights[dominant]) dominant = k;
      }
      const xyz = [p.getX(v), p.getY(v), p.getZ(v)];
      const key = [...xyz, ...bones, ...weights].join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const group = groupForNode(this.nodes[bones[dominant]]);
      const sample = { xyz, bones, weights };
      this.samples.push(sample);
      if (!this.groups.has(group)) this.groups.set(group, []);
      this.groups.get(group).push(sample);
      const cellKey = [group, ...xyz.map((v) => Math.floor(v / 0.065))].join(',');
      if (!cells.has(cellKey)) cells.set(cellKey, { group, samples: [], bones: new Set(), rest: new THREE.Box3(), box: new THREE.Box3(), version: -1 });
      const cell = cells.get(cellKey);
      cell.samples.push(sample); cell.rest.expandByPoint(corner.set(...xyz));
      for (let k = 0; k < 4; k++) if (weights[k]) cell.bones.add(bones[k]);
    }
    this.cells = [...cells.values()];
    this.version = -1;
  }

  prepare() {
    const rig = this.rig;
    if (this.version === rig.poseVersion) return;
    this.version = rig.poseVersion;
    this.nodes.forEach((n, i) => {
      this.matrices[i].multiplyMatrices(rig.root.matrix, rig.cur[n]).multiply(rig.restInv[n]);
    });
  }

  clear(level, group = null) {
    this.prepare();
    for (const cell of this.cells) {
      if (group !== null && cell.group !== group) continue;
      if (cell.version !== this.version) {
        cell.box.makeEmpty();
        const lo = cell.rest.min, hi = cell.rest.max;
        // A weighted skin point lies inside the union's convex hull. This broad phase is conservative.
        for (const bone of cell.bones) for (let c = 0; c < 8; c++) {
          corner.set(c & 1 ? hi.x : lo.x, c & 2 ? hi.y : lo.y, c & 4 ? hi.z : lo.z).applyMatrix4(this.matrices[bone]);
          cell.box.expandByPoint(corner);
        }
        cell.box.expandByScalar(0.036); cell.version = this.version;
      }
      if (boxClear(level, cell.box.min, cell.box.max)) continue;
      for (const { xyz: [x, y, z], bones, weights } of cell.samples) {
        let px = 0, py = 0, pz = 0;
        for (let k = 0; k < 4; k++) {
          const w = weights[k];
          if (!w) continue;
          const m = this.matrices[bones[k]].elements;
          px += (m[0] * x + m[4] * y + m[8] * z + m[12]) * w;
          py += (m[1] * x + m[5] * y + m[9] * z + m[13]) * w;
          pz += (m[2] * x + m[6] * y + m[10] * z + m[14]) * w;
        }
        if (!sphereClear(level, px, py, pz, 0.035)) return false;
      }
    }
    return true;
  }

  guard(level) {
    const rig = this.rig;
    return new PoseGuard([rig.root, ...rig.nodes], () => this.clear(level), () => {
      rig.root.updateMatrix();
      rig.driven.fill(0);
      rig.pose();
    }, rig.scale);
  }
}
