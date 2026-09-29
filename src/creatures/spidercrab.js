import * as THREE from 'three';
import { GlowPoints } from './glow.js';
import { modelSkin, disposeModelSkin } from './tripo.js';
import { Rig } from './rig.js';
import { attackClear, PoseGuard } from './collision.js';
import { RigSurface } from './rig-collision.js';
import { exposure, sightRange, sight, awarenessRate, AWARE_SUSPICIOUS, AWARE_CHASE } from './senses.js';
import { DECK_TOP, DECK_BOTTOM } from '../level/level.js';
import { mulberry32 } from '../render/textures.js';
import { patchMaterial } from '../render/shaderlib.js';

// A forty-metre spider crab stalking the reservoir basin on stilt legs, its body a dripping roof over the
// catwalks. Two pale eyes light whatever it looks at; it cannot see straight down, so the safest place in the
// dome is right under it. It kills with its forelegs, a stab from above that a catwalk slab stops.
// The body is the rigged Tripo model (public/models/crab.glb, front +x, up +y). Tripo left the second pair of
// legs unrigged, so they are rebound at load onto spare bones with virtual joints; every leg is a two-bone IK
// chain whose foot is planted on footholds picked from the map.

const S = 44;
const BODY_Y = 0.2;
// walking legs: hip bone, knee bone, rest foot tip (model units). Even entries are on the -z side, odd on +z;
// neighbours on the same side are two entries apart.
const WALK = [
  ['bone_32', 'bone_35', [0.333, 0, -0.222]], ['bone_38', 'bone_41', [0.333, 0, 0.222]],
  ['bone_20', 'bone_23', [0.082, 0.005, -0.49]], ['bone_26', 'bone_29', [0.082, 0.005, 0.49]],
  ['3_Right_Limb_1', '3_Right_Limb_4', [-0.174, 0, -0.43]], ['bone_15', 'bone_18', [-0.174, 0, 0.43]],
  ['bone_2', 'bone_4', [-0.33, 0.003, -0.24]], ['bone_6', 'bone_8', [-0.33, 0.003, 0.24]],
];
const NW = WALK.length;
// forelegs: spare hip and knee bones and the side (sign of z); joints are virtual pivots, z times the side
const FORE = [['0_Left_Limb_0', '1_Left_Limb_0', -1], ['0_Right_Limb_0', '2_Left_Limb_0', 1]];
const FORE_HIP = [0.07, 0.114, 0.15];
const FORE_KNEE = [0.205, 0.2, 0.28];
const FORE_TIP = [0.28, 0, 0.375];
// bones hanging loose under the root, carrying scraps of the legs
const STRAYS = ['bone_111', '0_Left_Limb_0', '0_Right_Limb_0', '1_Left_Limb_0', '1_Right_Limb_0', '2_Left_Limb_0', '2_Right_Limb_0', '3_Left_Limb_0'];
const BODY_BONE = '3_Right_Limb_0';
const MOUTHPARTS = ['bone_44', 'bone_51', 'bone_58', 'bone_64'];
const EYES = [new THREE.Vector3(0.1, 0.236, -0.026), new THREE.Vector3(0.1, 0.236, 0.026)];
const MOUTH = new THREE.Vector3(0.16, 0.12, 0);
// east end of the basin, facing west (world metres)
const HOME = [282, 92];

const SPEED = { patrol: 1.8, suspicious: 1.4, chase: 4.2, search: 2.2, feed: 0 };
const TURN = { patrol: 0.3, suspicious: 0.4, chase: 0.5, search: 0.4, feed: 0.2 };
const SIGHT = 36;
const COS_VIEW = 0.6;
const BLIND_R = 7;
const WP_CLEAR = 8;
const PATH_CLEAR = 7;
const MAX_SWING = 4;
const WALK_KNEE_LIFT = 1.2;
const STAB_WIND = 0.6;
const STAB_HIT = 0.25;
const CATCH_R = 2.0;
const EYE_COL = [0.8, 0.95, 1.0];
const RAGE_COL = [1.0, 0.25, 0.15];

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _pick = new THREE.Vector3();
const _q = new THREE.Quaternion();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (x) => { const k = clamp(x, 0, 1); return k * k * (3 - 2 * k); };
const lerp = (a, b, k) => a + (b - a) * k;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Distance from p to the segment ab. */
function segDist(p, a, b) {
  const ex = b.x - a.x, ey = b.y - a.y, ez = b.z - a.z;
  const l2 = ex * ex + ey * ey + ez * ez || 1e-12;
  const k = clamp(((p.x - a.x) * ex + (p.y - a.y) * ey + (p.z - a.z) * ez) / l2, 0, 1);
  return Math.hypot(p.x - a.x - ex * k, p.y - a.y - ey * k, p.z - a.z - ez * k);
}

export class SpiderCrab {
  constructor({ scene, level, lampSys, audio, water, fx, lightGrid, model }) {
    this.level = level;
    this.audio = audio;
    this.water = water;
    this.fx = fx;
    this.lightGrid = lightGrid;
    this.rand = mulberry32(4242);
    this.events = [];
    this.onCatch = null;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    const [cx0, cz0, cx1, cz1] = level.reservoir.crab;
    this.box = [cx0 * 2 + 4, cz0 * 2 + 4, (cx1 + 1) * 2 - 4, (cz1 + 1) * 2 - 4];
    const [dx0, dz0, dx1, dz1] = level.reservoir.dome;
    this.pillars = [];
    for (let z = dz0; z <= dz1; z++) {
      for (let x = dx0; x <= dx1; x++) if (level.ch(x, z) === 'P') this.pillars.push([x * 2, z * 2, x * 2 + 2, z * 2 + 2]);
    }
    const [ax, az] = level.worldCenter(...level.reservoir.angler);
    this.anglerBox = [ax - 5.8, az - 8.4, ax + 5.8, az + 8.4];
    this._buildWaypoints();

    this.probe = { value: new THREE.Color(0.006, 0.01, 0.012) };
    this.rim = { value: new THREE.Color(0.008, 0.014, 0.018) };
    this.bodyMat = modelSkin(model.mesh.material, { key: 'crab', probe: this.probe, rim: this.rim, tint: [0.72, 0.74, 0.78], roughness: 0.4 });
    model.mesh.material = this.bodyMat;
    const rig = new Rig(model, S);
    this.rig = rig;
    this.group.add(rig.root);
    this.bodyBone = rig.bone(BODY_BONE);
    this.mouthparts = MOUTHPARTS.map((n) => rig.bone(n));
    const V = (a, side = 1) => new THREE.Vector3(a[0], a[1], a[2] * side);
    this.legs = WALK.map(([hip, knee, tip], i) => this._leg(rig.leg(rig.bone(hip), rig.bone(knee), V(tip)), false, i % 2 ? 1 : -1));
    for (const [hip, knee, side] of FORE) {
      this.legs.push(this._leg(rig.leg(rig.bone(hip), rig.bone(knee), V(FORE_TIP, side), V(FORE_HIP, side), V(FORE_KNEE, side)), true, side));
    }
    this._rebind();
    this.surface = new RigSurface(rig, (node) => {
      const i = this.legs.findIndex(({ ik }) => node === ik.hip || node === ik.knee || rig.under(node, ik.hip) || rig.under(node, ik.knee));
      return i + 1;
    });
    this.poseGuard = this.surface.guard(level);
    this.bodyGuard = new PoseGuard([rig.root], () => this.surface.clear(level, 0), () => {
      rig.root.updateMatrix(); rig.driven.fill(0); rig.pose();
    }, 12);
    this.legs.forEach((L, i) => {
      const { hip, knee } = L.ik;
      const nodes = rig.nodes.filter((_, n) => n === hip || n === knee || rig.under(n, hip) || rig.under(n, knee));
      L.guard = new PoseGuard(nodes, () => this.surface.clear(level, i + 1), () => {
        rig.driven.fill(0); rig.pose();
      }, S, false);
    });

    this.glow = new GlowPoints(4, { core: 1.1, halo: 0.5 });
    this.group.add(this.glow.points);
    this.eyeGeometry = new THREE.SphereGeometry(1, 20, 12);
    this.eyeMaterial = new THREE.MeshStandardMaterial({ color: 0x171a19, roughness: 0.5 });
    this.irisMaterial = new THREE.MeshStandardMaterial({ color: 0x8fa9a6, emissive: 0x779a99, emissiveIntensity: 0.45, roughness: 0.45 });
    this.pupilMaterial = new THREE.MeshStandardMaterial({ color: 0x010303, roughness: 0.65 });
    for (const material of [this.eyeMaterial, this.irisMaterial, this.pupilMaterial]) patchMaterial(material, { key: 'crab-eye', probe: this.probe });
    this.eyes = EYES.map(() => {
      const eye = new THREE.Group();
      const ball = new THREE.Mesh(this.eyeGeometry, this.eyeMaterial);
      ball.scale.set(0.23, 0.19, 0.14);
      const iris = new THREE.Mesh(this.eyeGeometry, this.irisMaterial);
      iris.scale.set(0.14, 0.115, 0.035); iris.position.z = 0.11;
      const pupil = new THREE.Mesh(this.eyeGeometry, this.pupilMaterial);
      pupil.scale.set(0.032, 0.09, 0.012); pupil.position.z = 0.145;
      eye.add(ball, iris, pupil); this.group.add(eye);
      return eye;
    });
    this.eyeCol = [...EYE_COL];
    this.eyeLamp = lampSys.add({ type: 'creature', x: 0, y: -500, z: 0, color: this.eyeCol, intensity: 0, range: 12 });
    this.gazeLamp = lampSys.add({ type: 'creature', x: 0, y: -500, z: 0, color: this.eyeCol, intensity: 0, range: 8 });
    this.voice = audio.createCreatureVoice('hunter');
    this.voice.setPosition(0, -400, 0);

    this.hub = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.focus = new THREE.Vector3();
    this.lastSeen = new THREE.Vector3();
    this.eye = new THREE.Vector3();
    this.fwd = new THREE.Vector3(1, 0, 0);
    this.gazeHit = new THREE.Vector3();
    this.mouth = new THREE.Vector3();
    this.foreT = [new THREE.Vector3(), new THREE.Vector3()];
    this.foreTip = [new THREE.Vector3(), new THREE.Vector3()];
    this.prevTip = [new THREE.Vector3(), new THREE.Vector3()];
    this._stab = { s: 0, phase: 'wind', t: 0, kind: 'water', done: false, aim: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3() };
    this._order = WALK.map((_, i) => i);
    const n = this.wp.length;
    this._dist = new Float32Array(n);
    this._prev = new Int16Array(n);
    this._done = new Uint8Array(n);
    this.reset();
  }

  _leg(ik, fore, side) {
    const dx = ik.T0.x - ik.H0.x, dz = ik.T0.z - ik.H0.z, r = Math.hypot(dx, dz);
    return {
      ik, fore, side, len: (ik.a + ik.b) * S, restR: r * S, hx: dx / r, hz: dz / r,
      hipW: new THREE.Vector3(), want: new THREE.Vector3(), idle: new THREE.Vector3(),
      foot: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(),
      swing: -1, dur: 1, peak: 0, prevY: 0, rip: 0, reach: 0, err: 0, pr: 0,
      safeFoot: new THREE.Vector3(), frameFoot: new THREE.Vector3(), hasSafeFoot: false, idleBase: null,
    };
  }

  /**
   * Tripo skinned the second pair of legs onto stray bones and onto the neighbouring leg: move every vertex that
   * lies on a foreleg to that foreleg's bones, and every stray-skinned leg scrap to the leg it lies on.
   */
  _rebind() {
    const rig = this.rig, mesh = rig.mesh, g = mesh.geometry;
    const pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const bones = mesh.skeleton.bones;
    const skinOf = (i) => bones.indexOf(rig.nodes[i]);
    const legOf = new Int8Array(bones.length).fill(-1);
    const segs = [];
    const addSeg = (a, b, node, leg) => {
      const bone = skinOf(node);
      if (bone < 0) return;
      segs.push({ a, b, bone, leg });
      legOf[bone] = leg;
    };
    this.legs.forEach((L, li) => {
      const { ik } = L;
      if (L.fore) {
        addSeg(ik.H0, ik.K0, ik.hip, li);
        addSeg(ik.K0, ik.T0, ik.knee, li);
        return;
      }
      // the chain from the hip down to the last bone, which ends at the foot tip
      for (let k = ik.hip; k >= 0;) {
        const next = rig.parent.indexOf(k);
        addSeg(rig.restHead(k), next >= 0 ? rig.restHead(next) : ik.T0.clone(), k, li);
        k = next;
      }
    });
    const stray = new Uint8Array(bones.length), spare = new Uint8Array(bones.length);
    for (const n of STRAYS) {
      const b = skinOf(rig.bone(n));
      if (b >= 0) stray[b] = 1;
    }
    for (const L of this.legs) {
      if (!L.fore) continue;
      for (const node of [L.ik.hip, L.ik.knee]) {
        const b = skinOf(node);
        if (b >= 0) spare[b] = 1;
      }
    }
    const body = skinOf(this.bodyBone);
    const nL = this.legs.length, dist = new Float32Array(nL), near = new Int16Array(nL);
    const p = new THREE.Vector3();
    let moved = 0;
    for (let v = 0; v < pos.count; v++) {
      p.fromBufferAttribute(pos, v);
      let d = 0, dw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(v, k);
        if (w > dw) { dw = w; d = si.getComponent(v, k); }
      }
      dist.fill(Infinity);
      for (const s of segs) {
        const e = segDist(p, s.a, s.b);
        if (e < dist[s.leg]) { dist[s.leg] = e; near[s.leg] = s.bone; }
      }
      let best = 0;
      for (let l = 1; l < nL; l++) if (dist[l] < dist[best]) best = l;
      const own = legOf[d], fore = best >= NW;
      let to = -1;
      if (own >= 0 && own < NW && fore && dist[own] - dist[best] > 0.012) to = near[best];
      else if (stray[d] && dist[best] < 0.06) to = near[best];
      else if (own < 0 && fore && dist[best] < 0.025) to = near[best];
      if (to >= 0) {
        si.setXYZW(v, to, 0, 0, 0);
        sw.setXYZW(v, 1, 0, 0, 0);
        moved++;
      } else {
        // the spare bones now swing a foreleg: nothing else may hang on them
        for (let k = 0; k < 4; k++) if (spare[si.getComponent(v, k)]) si.setComponent(v, k, body);
      }
      // Distal skin must follow its own limb. The auto-rig also blended foot
      // tips with the opposite leg and mouth, stretching skin across the basin.
      // Keep hip transitions and the weights between bones within the same leg.
      if (Math.abs(p.z) > 0.2 && dist[best] < 0.06) {
        for (let k = 0; k < 4; k++) {
          if (sw.getComponent(v, k) > 0 && legOf[si.getComponent(v, k)] !== best) si.setComponent(v, k, near[best]);
        }
      }
    }
    si.needsUpdate = true;
    sw.needsUpdate = true;
    this.rebound = moved;
  }

  // ------------------------------------------------------------------ navigation graph

  /** Horizontal distance from (x, z) to the nearest pillar. */
  _clear(x, z) {
    let best = Infinity;
    for (const [x0, z0, x1, z1] of this.pillars) best = Math.min(best, Math.hypot(x - clamp(x, x0, x1), z - clamp(z, z0, z1)));
    return best;
  }

  /** Does the body fit along a to b, keeping r from every pillar? The start point is not tested. */
  _segClear(ax, az, bx, bz, r) {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
    for (let i = 1; i <= n; i++) if (this._clear(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n) < r) return false;
    return true;
  }

  /** A 4 m grid of body positions clear of the pillars, linked to their neighbours where the body fits between. */
  _buildWaypoints() {
    const [X0, Z0, X1, Z1] = this.box;
    this.wp = [];
    for (let z = Z0; z <= Z1 + 1e-6; z += 4) {
      for (let x = X0; x <= X1 + 1e-6; x += 4) if (this._clear(x, z) >= WP_CLEAR) this.wp.push([x, z]);
    }
    this.links = this.wp.map(() => []);
    for (let i = 0; i < this.wp.length; i++) {
      for (let j = i + 1; j < this.wp.length; j++) {
        const [ax, az] = this.wp[i], [bx, bz] = this.wp[j];
        if (Math.hypot(bx - ax, bz - az) < 6 && this._segClear(ax, az, bx, bz, PATH_CLEAR)) {
          this.links[i].push(j);
          this.links[j].push(i);
        }
      }
    }
  }

  _nearestWp(x, z, reachable) {
    let best = 0, bd = Infinity, any = 0, ad = Infinity;
    this.wp.forEach(([wx, wz], i) => {
      const d = Math.hypot(wx - x, wz - z);
      if (d < ad) { ad = d; any = i; }
      if (d < bd && (!reachable || this._segClear(x, z, wx, wz, PATH_CLEAR - 1))) { bd = d; best = i; }
    });
    return bd < Infinity ? best : any;
  }

  /** Shortest waypoint path from a to b (Dijkstra), or null. */
  _route(a, b) {
    const n = this.wp.length, dist = this._dist, prev = this._prev, done = this._done;
    dist.fill(Infinity);
    prev.fill(-1);
    done.fill(0);
    dist[a] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || u === b) break;
      done[u] = 1;
      for (const v of this.links[u]) {
        const d = dist[u] + Math.hypot(this.wp[v][0] - this.wp[u][0], this.wp[v][1] - this.wp[u][1]);
        if (d < dist[v]) { dist[v] = d; prev[v] = u; }
      }
    }
    if (dist[b] === Infinity) return null;
    const path = [];
    for (let v = b; v >= 0; v = prev[v]) path.unshift(v);
    return path;
  }

  _nextPatrol() {
    for (let k = 0; k < 20; k++) {
      const i = Math.floor(this.rand() * this.wp.length);
      if (Math.hypot(this.wp[i][0] - this.hub.x, this.wp[i][1] - this.hub.z) > 16) return i;
    }
    return Math.floor(this.rand() * this.wp.length);
  }

  // ------------------------------------------------------------------ public

  reset() {
    this.rand = mulberry32(4242);
    this.frameDt = null;
    this.poseGuard.ready = false;
    this.bodyGuard.ready = false;
    for (const L of this.legs) { L.hasSafeFoot = false; L.guard.ready = false; L.idleBase = null; }
    this.events.length = 0;
    this.state = 'patrol';
    this.stateT = 0;
    this.awareness = 0;
    this.heardT = 99;
    this.seenT = 99;
    this.scanT = 0;
    this.scanH = 0;
    this.pause = 2;
    this.stab = null;
    this.tap = null;
    this.tapCool = 4;
    this.stabCool = 0;
    this.gaitSlow = 1;
    this.blockedT = 0;
    this.retreatT = 0;
    this.retreatDir = new THREE.Vector3(1, 0, 0);
    this.rage = 0;
    this.nearK = 0;
    this.spd = 0;
    this.gazeOff = 0;
    this.gazePitch = -0.45;
    this.tracking = false;
    this.hub.set(HOME[0], 0, HOME[1]);
    this.vel.set(0, 0, 0);
    this.h = -Math.PI / 2;
    this.fwd.set(Math.sin(this.h) * Math.cos(this.gazePitch), Math.sin(this.gazePitch), Math.cos(this.h) * Math.cos(this.gazePitch));
    this.bob = BODY_Y;
    this.pitch = 0;
    this.roll = 0;
    this.patrolWp = this._nextPatrol();
    this.focus.copy(this.hub);
    this.lastSeen.copy(this.hub);
    const r = this.rig.root;
    r.position.set(this.hub.x, this.bob, this.hub.z);
    r.rotation.set(0, this.h - Math.PI / 2, 0, 'YZX');
    this.rig.begin();
    // plant every foot where it would step to standing still
    for (const L of this.legs) { L.swing = -1; L.foot.set(1e4, 0, 1e4); }
    for (let i = 0; i < NW; i++) {
      const L = this.legs[i];
      this._home(L, this.rig.root.matrix, 5, 0);
      L.foot.copy(L.want);
      const at = this._pickFoot(L, i, null);
      if (at) L.foot.copy(at);
      else L.foot.y = this._ground(L.foot.x, L.foot.z);
      L.prevY = L.foot.y;
    }
    this._fore(0, 0, null);
    this._pose(0);
    for (let s = 0; s < 2; s++) {
      const L = this.legs[NW + s];
      L.idleBase = this.foreT[s].clone().applyMatrix4(this.rig.rootInv);
      L.idleBase.y -= 0.05 + 0.02 * Math.sin(s * 2.1);
      L.idleBase.x -= 0.03 * Math.cos(s * 2.1);
      L.idleBase.z -= 0.03 * Math.sin(s * 2.1) * L.side;
    }
    if (!this.poseGuard.reset() || !this.bodyGuard.reset()) throw new Error('crab initial pose does not fit terrain');
    for (const L of this.legs) L.guard.reset();
    for (let s = 0; s < 2; s++) this.prevTip[s].copy(this.foreTip[s]);
    this.voice.setState('patrol');
  }

  get chasing() { return this.state === 'chase'; }

  get threat() {
    if (this.state === 'chase' || this.state === 'feed') return 1;
    if (this.state === 'suspicious') return 0.5 + 0.3 * Math.min(1, this.awareness);
    if (this.state === 'search') return 0.5;
    return this.nearK * 0.4;
  }

  get disturb() {
    if (!this.group.visible || this.spd < 0.3) return null;
    return { x: this.hub.x, z: this.hub.z, r: 22, amount: 0.3 };
  }

  /** It hears footfalls and splashes around its body, through air and water alike. */
  hear(x, y, z, r, loud) {
    if (this.state === 'feed') return;
    const reach = r * 1.2, d = Math.hypot(x - this.hub.x, z - this.hub.z);
    if (d > reach) return;
    this.awareness = Math.min(1.5, this.awareness + (loud ? 0.5 : 0.25) * (1 - (d / reach) * 0.5));
    this.focus.set(x, y, z);
    this.heardT = 0;
  }

  update(dt, t, { player, whale = null }) {
    this.frameDt = dt;
    for (const L of this.legs) this.rig.toWorld(L.ik.knee, L.ik.T0, L.frameFoot);
    this.events.length = 0;
    const previousX = this.hub.x, previousZ = this.hub.z;
    const p = player.pos;
    const far = Math.hypot(p.x - this.hub.x, p.z - this.hub.z);
    this.group.visible = far < 120;
    this.nearK = clamp(1 - far / 40, 0, 1);
    this._look(dt, t, player);
    this._think(dt);
    this._steer(dt);
    let bodyTravel = this._place(dt, t);
    this.rig.rootInv.copy(this.rig.root.matrix).invert();
    this._gait(dt, player, whale);
    this._fore(dt, t, player);
    // Render culling must not leave the safe pose behind while the body walks.
    for (let s = 0; s < 2; s++) this.prevTip[s].copy(this.foreTip[s]);
    this.rig.begin();
    this._pose(t);
    let travel;
    if (this.surface.clear(this.level)) {
      this.poseGuard.reset(); travel = 1;
    } else {
      // A blocked body must still let the legs finish stepping. Retry their
      // world-space goals at the last safe body position before sweeping.
      this.poseGuard.apply(0);
      this._syncPose();
      for (const L of this.legs) L.guard.reset();
      this.rig.begin();
      this._pose(t);
      travel = this.poseGuard.constrain();
      this.bodyGuard.reset();
      bodyTravel = 0;
    }
    this._syncPose();
    if (travel < 1 || bodyTravel < 1) {
      this.blockedT += dt;
      this.vel.multiplyScalar(0.5);
      for (let i = 0; i < NW; i++) {
        const L = this.legs[i];
        this.rig.toWorld(L.ik.knee, L.ik.T0, L.foot);
        L.safeFoot.copy(L.foot);
      }
    } else this.blockedT = 0;
    if (travel === 1 && bodyTravel === 1 && this.retreatT <= 0) {
      const dx = previousX - this.hub.x, dz = previousZ - this.hub.z;
      if (Math.hypot(dx, dz) > 0.001) this.retreatDir.set(dx, 0, dz).normalize();
    }
    if (this.blockedT > 0.5) {
      this.retreatT = 2;
      this.blockedT = 0;
      this.patrolWp = this._nextPatrol();
    }
    if (this.retreatT > 0) {
      this.retreatT -= dt;
    }
    this._tips();
    this._hit(player);
    this._effects(dt, t, player);
  }

  // ------------------------------------------------------------------ senses and behaviour

  _look(dt, t, player) {
    const rig = this.rig, p = player.pos, e = this.eye;
    rig.toWorld(this.bodyBone, EYES[0], _a);
    rig.toWorld(this.bodyBone, EYES[1], _b);
    e.addVectors(_a, _b).multiplyScalar(0.5);
    const range = sightRange(SIGHT, e.y, p.y);
    // Acquire with the view cone, then keep watching a visible moving player.
    // Occlusion and the shelter directly underneath still break sight.
    const seen = !player.frozen && Math.hypot(p.x - this.hub.x, p.z - this.hub.z) > BLIND_R
      ? sight(this.level, e, this.fwd, this.tracking ? -1 : COS_VIEW, range, p) : -1;
    this.tracking = seen >= 0;
    // the gaze sweeps the water ahead while it patrols, and locks on whatever it is after otherwise
    let offT = 0.6 * Math.sin(t * 0.3), pitchT = -0.45 + 0.1 * Math.sin(t * 0.37);
    if (this.tracking || (this.state !== 'patrol' && this.state !== 'feed')) {
      const f = this.tracking ? p : this.focus, dx = f.x - e.x, dz = f.z - e.z;
      offT = wrapAngle(Math.atan2(dx, dz) - this.h);
      pitchT = clamp(Math.atan2(f.y - e.y, Math.hypot(dx, dz)), -1.2, 0.3);
      if (!this.tracking && this.state === 'search' && this.scanT > 0) offT += 0.4 * Math.sin(t * 0.9);
    }
    const k = 1 - Math.exp(-dt * (this.tracking ? 12 : 2));
    this.gazeOff = wrapAngle(this.gazeOff + wrapAngle(offT - this.gazeOff) * k);
    this.gazePitch += (pitchT - this.gazePitch) * k;
    const gy = this.h + this.gazeOff, cp = Math.cos(this.gazePitch);
    this.fwd.set(Math.sin(gy) * cp, Math.sin(this.gazePitch), Math.cos(gy) * cp);
    this._gazeHit();
    if (this.state === 'feed') return;

    if (seen >= 0) {
      let vis = exposure(player, this.lightGrid, this.level, e);
      // caught in the light of its eyes
      if (this.gazeHit.distanceTo(p) < 5) vis *= 2;
      this.awareness = Math.min(1.5, this.awareness + awarenessRate(vis, seen, range) * dt * 0.9);
      this.seenT = 0;
      if (this.awareness > 0.15) this.focus.copy(p);
      this.lastSeen.copy(p);
    } else {
      this.awareness = Math.max(0, this.awareness - dt * (this.state === 'chase' ? 0.09 : 0.15));
    }
    // a foreleg feeling its way brushes the swimmer
    if (!this.stab && !player.frozen) {
      for (const tip of this.foreTip) {
        if (tip.distanceTo(p) < 1.5) {
          this.awareness = Math.min(1.5, this.awareness + dt * 1.5);
          this.focus.copy(p);
        }
      }
    }
    if (player.frozen) this.awareness = Math.min(this.awareness, 0.2);
  }

  /** Where the eyes' light falls: the catwalk it crosses, the water, or the floor; at most 40 m away. */
  _gazeHit() {
    const e = this.eye, f = this.fwd, lv = this.level;
    if (f.y > -0.02) { this.gazeHit.copy(e).addScaledVector(f, 40); return; }
    let d = (DECK_TOP - e.y) / f.y;
    _c.copy(e).addScaledVector(f, d);
    if (d > 40 || lv.ch(Math.floor(_c.x / 2), Math.floor(_c.z / 2)) !== '=') {
      d = -e.y / f.y;
      _c.copy(e).addScaledVector(f, d);
      const fl = lv.floor(Math.floor(_c.x / 2), Math.floor(_c.z / 2));
      if (fl > 0 && fl < 900) d = (fl - e.y) / f.y;
      d = Math.min(40, d);
    }
    this.gazeHit.copy(e).addScaledVector(f, d);
  }

  _think(dt) {
    this.stateT += dt;
    this.heardT += dt;
    this.seenT += dt;
    const aw = this.awareness;
    switch (this.state) {
      case 'patrol':
        if (aw >= AWARE_CHASE) this._setState('chase');
        else if (aw >= AWARE_SUSPICIOUS) this._setState('suspicious');
        break;
      case 'suspicious':
        if (aw >= AWARE_CHASE) this._setState('chase');
        else if (aw < 0.15) this._setState('patrol');
        else if (this.stateT > 14) { this.awareness *= 0.5; this._setState('patrol'); }
        break;
      case 'chase':
        if (this.seenT > 5 && this.heardT > 3) { this.awareness = 0.6; this._setState('search'); }
        break;
      case 'search':
        if (aw >= AWARE_CHASE) this._setState('chase');
        else if (this.scanT > 8) { this.awareness = Math.min(aw, 0.2); this._setState('patrol'); }
        break;
      case 'feed':
        if (this.stateT > 5) { this.awareness = 0; this._setState('patrol'); }
        break;
      default:
        break;
    }
  }

  _setState(s) {
    const prev = this.state;
    if (prev === s) return;
    this.state = s;
    this.stateT = 0;
    this.scanT = 0;
    if (s === 'chase') {
      this.events.push({ type: 'spotted', source: 'crab' });
      this.voice.roar();
      this.stabCool = Math.max(this.stabCool, 1.2);
    } else if (s === 'suspicious') {
      this.events.push({ type: 'suspicious', source: 'crab' });
      this.voice.click();
    } else if (s === 'search') {
      if (prev === 'chase') this.events.push({ type: 'lost', source: 'crab' });
    } else if (s === 'patrol') {
      this.patrolWp = this._nextPatrol();
      this.pause = 1.5;
    }
    this.voice.setState(s === 'chase' || s === 'feed' ? 'chase' : s === 'search' ? 'search' : s === 'suspicious' ? 'suspicious' : 'patrol');
  }

  /** Walk the body toward the state's goal through the pillar forest; it sidles, facing what it watches. */
  _steer(dt) {
    const st = this.state, hub = this.hub;
    const [X0, Z0, X1, Z1] = this.box;
    let gx = hub.x, gz = hub.z, arrive = 2, spd = SPEED[st];
    if (st === 'patrol') {
      arrive = 0;
      if (this.pause > 0) { this.pause -= dt; spd = 0; }
      [gx, gz] = this.wp[this.patrolWp];
      if (Math.hypot(gx - hub.x, gz - hub.z) < 3) {
        this.pause = 3 + this.rand() * 4;
        this.patrolWp = this._nextPatrol();
      }
    } else if (st === 'suspicious') {
      gx = this.focus.x; gz = this.focus.z; arrive = 10;
    } else if (st === 'chase') {
      gx = this.focus.x; gz = this.focus.z; arrive = 9;
    } else if (st === 'search') {
      gx = this.lastSeen.x; gz = this.lastSeen.z; arrive = 4;
      if (this.scanT > 0 || Math.hypot(gx - hub.x, gz - hub.z) < 6 || this.stateT > 15) {
        if (this.scanT === 0) this.scanH = this.h;
        this.scanT += dt;
        spd = 0;
      }
    }
    gx = clamp(gx, X0, X1);
    gz = clamp(gz, Z0, Z1);
    if (this._clear(gx, gz) < WP_CLEAR - 0.5) [gx, gz] = this.wp[this._nearestWp(gx, gz, false)];
    // straight there if the body fits, else along the waypoint graph to the furthest node in view
    let tx = gx, tz = gz;
    if (!this._segClear(hub.x, hub.z, gx, gz, PATH_CLEAR)) {
      const path = this._route(this._nearestWp(hub.x, hub.z, true), this._nearestWp(gx, gz, false));
      if (path) {
        let pick = path[0];
        for (const i of path) if (this._segClear(hub.x, hub.z, this.wp[i][0], this.wp[i][1], PATH_CLEAR)) pick = i;
        [tx, tz] = this.wp[pick];
      }
    }
    const dx = tx - hub.x, dz = tz - hub.z, dl = Math.hypot(dx, dz);
    const distance = st === 'chase' || st === 'suspicious'
      ? Math.hypot(this.focus.x - hub.x, this.focus.z - hub.z) : Math.hypot(gx - hub.x, gz - hub.z);
    const slow = clamp((distance - arrive) / 6, 0, 1);
    let wx = dl > 0.01 ? dx / dl : 0, wz = dl > 0.01 ? dz / dl : 0;
    for (const [x0, z0, x1, z1] of this.pillars) {
      const cx = clamp(hub.x, x0, x1), cz = clamp(hub.z, z0, z1), d = Math.hypot(hub.x - cx, hub.z - cz);
      if (d > 9 || d < 1e-3) continue;
      const k = ((9 - d) / 9) * 0.8;
      wx += ((hub.x - cx) / d) * k;
      wz += ((hub.z - cz) / d) * k;
    }
    if (this.retreatT > 0) { wx = this.retreatDir.x; wz = this.retreatDir.z; }
    const want = (this.retreatT > 0 ? 1.5 : spd * slow) * this.gaitSlow, wl = Math.hypot(wx, wz) || 1;
    const k = Math.min(1, dt * 0.8);
    this.vel.x += ((wx / wl) * want - this.vel.x) * k;
    this.vel.z += ((wz / wl) * want - this.vel.z) * k;
    hub.x = clamp(hub.x + this.vel.x * dt, X0, X1);
    hub.z = clamp(hub.z + this.vel.z * dt, Z0, Z1);
    this.spd = Math.hypot(this.vel.x, this.vel.z);

    let hw = this.h;
    const fx = this.focus.x - hub.x, fz = this.focus.z - hub.z;
    if ((st === 'suspicious' || st === 'chase' || st === 'feed') && Math.hypot(fx, fz) > 3) hw = Math.atan2(fx, fz);
    else if (st === 'search' && this.scanT > 0) hw = this.scanH + 1.3 * Math.sin(this.scanT * 0.6);
    else if (st !== 'patrol' && dl > 0.5 && want > 0.1) hw = Math.atan2(dx, dz);
    const rate = TURN[st] * this.gaitSlow * dt;
    this.h = wrapAngle(this.h + clamp(wrapAngle(hw - this.h), -rate, rate));
  }

  /** Body pose from the feet: it sways, sinks a little while legs are lifted and tilts to the footholds. */
  _place(dt, t) {
    let front = 0, back = 0, zp = 0, zn = 0, swinging = 0;
    for (let i = 0; i < NW; i++) {
      const L = this.legs[i], y = L.swing >= 0 ? L.to.y : L.foot.y;
      if (i < 2) front += y / 2;
      else if (i >= NW - 2) back += y / 2;
      if (i % 2) zp += y / 4;
      else zn += y / 4;
      if (L.swing >= 0) swinging++;
    }
    const bobT = Math.max(BODY_Y - 0.25, BODY_Y + 0.2 * Math.sin(t * 0.6) - 0.15 * (swinging / MAX_SWING));
    const pitchT = clamp(Math.atan((front - back) / 29) * 0.5, -0.05, 0.05) - (this.stab && this.stab.phase !== 'feed' ? 0.03 : 0);
    const rollT = clamp(-Math.atan((zp - zn) / 40) * 0.5, -0.05, 0.05);
    const k = Math.min(1, dt * 1.5);
    this.bob += (bobT - this.bob) * k;
    this.pitch += (pitchT - this.pitch) * k;
    this.roll += (rollT - this.roll) * k;
    const r = this.rig.root;
    r.position.set(this.hub.x, this.bob, this.hub.z);
    r.rotation.set(this.roll, this.h - Math.PI / 2, this.pitch, 'YZX');
    const travel = this.bodyGuard.ready ? this.bodyGuard.constrain() : 1;
    if (this.bodyGuard.ready) this._syncPose();
    return travel;
  }

  _syncPose() {
    const r = this.rig.root;
    this.hub.x = r.position.x; this.hub.z = r.position.z; this.bob = r.position.y;
    this.roll = r.rotation.x; this.h = r.rotation.y + Math.PI / 2; this.pitch = r.rotation.z;
  }

  // ------------------------------------------------------------------ legs

  _ground(x, z) {
    const f = this.level.floor(Math.floor(x / 2), Math.floor(z / 2));
    // The IK tip sits inside the foot mesh; reserve room for the skin below it.
    return f > 900 ? 0 : f + 0.4;
  }

  /** The leg's hip in the world and where its foot wants to be: out along its rest direction, led by the walk. */
  _home(L, M, stride, lead) {
    const hip = L.hipW.copy(L.ik.H0).applyMatrix4(M);
    const sh = Math.sin(this.h), ch = Math.cos(this.h);
    const dx = L.hx * sh - L.hz * ch, dz = L.hx * ch + L.hz * sh;
    // as far out as the leg comfortably reaches down to the ground there
    let R = L.restR;
    for (let it = 0; it < 2; it++) {
      const dy = hip.y - this._ground(hip.x + dx * R, hip.z + dz * R);
      R = clamp(Math.sqrt(Math.max(0, (0.88 * L.len) ** 2 - dy * dy)), 0.25 * L.restR, L.restR);
    }
    let ox = this.vel.x * lead, oz = this.vel.z * lead;
    const ol = Math.hypot(ox, oz), om = 0.6 * stride;
    if (ol > om) { ox *= om / ol; oz *= om / ol; }
    L.want.set(hip.x + dx * R + ox, 0, hip.z + dz * R + oz);
  }

  _gait(dt, player, whale) {
    const M = this.rig.root.matrix, chase = this.state === 'chase', vis = this.group.visible;
    const stride = chase ? 7 : 5, lead = chase ? 0.7 : 0.9;
    const lv = this.level, p = player.pos;
    // feet in the air: lift, carry, set down
    for (let i = 0; i < NW; i++) {
      const L = this.legs[i];
      if (L.swing < 0) continue;
      L.swing += dt / L.dur;
      const k = Math.min(1, L.swing);
      const sk = L.overDeck ? smooth((k - L.liftEnd) / (L.lowerStart - L.liftEnd)) : smooth((k - 0.15) / 0.7);
      const y = L.overDeck
        ? k < L.liftEnd ? lerp(L.from.y, L.peak, smooth(k / L.liftEnd))
          : k > L.lowerStart ? lerp(L.peak, L.to.y, smooth((k - L.lowerStart) / (1 - L.lowerStart))) : L.peak
        : lerp(L.from.y, L.to.y, smooth(k)) + (L.peak - Math.max(L.from.y, L.to.y)) * Math.sin(Math.PI * k) ** 2;
      L.foot.set(lerp(L.from.x, L.to.x, sk), y, lerp(L.from.z, L.to.z, sk));
      if (vis) {
        if ((L.prevY < 0) !== (y < 0) && lv.isWater(Math.floor(L.foot.x / 2), Math.floor(L.foot.z / 2))) this._splash(L.foot, y > L.prevY ? 0.5 : 0.7);
        else if (y < 0 && (L.rip -= dt) < 0) {
          L.rip = 0.3;
          this.water.addRipple(L.foot.x, L.foot.z, 0.3);
        }
      }
      L.prevY = y;
      if (k >= 1) {
        L.swing = -1;
        L.foot.copy(L.to);
        const near = clamp(1 - Math.hypot(p.x - L.foot.x, p.z - L.foot.z) / 25, 0, 1);
        if (L.foot.y < 0) {
          if (vis) this.fx.bubbles.spawn(L.foot.x, L.foot.y + 0.5, L.foot.z, 8, 1.2, 1.4);
          player.shake = Math.max(player.shake, 0.12 * near);
        } else {
          player.shake = Math.max(player.shake, 0.25 * near);
        }
      }
    }
    // planted feet: how far each has fallen behind
    let swinging = 0, maxErr = 0;
    for (let i = 0; i < NW; i++) {
      const L = this.legs[i];
      this._home(L, M, stride, lead);
      if (L.swing >= 0) { swinging++; L.pr = -1; continue; }
      L.reach = L.hipW.distanceTo(L.foot) / L.len;
      L.err = Math.hypot(L.foot.x - L.want.x, L.foot.z - L.want.z);
      maxErr = Math.max(maxErr, L.err);
      let pr = L.err / stride;
      if (L.frameFoot.y > this._ground(L.frameFoot.x, L.frameFoot.z) + 0.5) pr += 2;
      if (L.reach > 0.97) pr += 1 + (L.reach - 0.97) * 20;
      if (whale && L.foot.y < 0 && whale.clearance(L.foot.x, L.foot.z) < 2.5) pr += 1;
      L.pr = pr;
    }
    // the most urgent step first; never more than four feet up, never two neighbours on one side
    this._order.sort((a, b) => this.legs[b].pr - this.legs[a].pr);
    for (const i of this._order) {
      if (swinging >= MAX_SWING) break;
      const L = this.legs[i];
      if (L.pr <= 1) break;
      if ((i >= 2 && this.legs[i - 2].swing >= 0) || (i + 2 < NW && this.legs[i + 2].swing >= 0)) continue;
      if (this._step(L, i, whale)) swinging++;
    }
    // it slows down rather than let a foot drag
    this.gaitSlow = clamp(2 - maxErr / stride, 0.3, 1);
  }

  _step(L, i, whale) {
    const settling = L.frameFoot.y > this._ground(L.frameFoot.x, L.frameFoot.z) + 0.5;
    const to = this._pickFoot(L, i, whale);
    if (!to) return false;
    L.from.copy(L.frameFoot);
    L.foot.copy(L.from);
    L.to.copy(to);
    let peak = Math.max(L.from.y, L.to.y) + (settling ? 0.3 : 3);
    L.overDeck = this._crossesDeck(L.from, L.to);
    if (L.overDeck) peak = Math.max(peak, DECK_TOP + 2.5);
    L.peak = peak;
    L.dur = (this.state === 'chase' ? 0.6 : 1.0) * (1 + (peak - Math.min(L.from.y, L.to.y)) / 12) * (0.9 + 0.2 * this.rand());
    L.dur = Math.max(L.dur, L.from.distanceTo(L.to) * 1.9 / (this.state === 'chase' ? 10 : 6));
    if (L.overDeck) {
      const rise = peak - L.from.y, fall = peak - L.to.y, carry = Math.max(0.01, Math.hypot(L.from.x - L.to.x, L.from.z - L.to.z));
      const distance = rise + carry + fall;
      L.liftEnd = rise / distance; L.lowerStart = (rise + carry) / distance;
      L.dur = Math.max(L.dur, distance * 1.9 / 10);
    }
    L.swing = 0;
    L.prevY = L.foot.y;
    L.rip = 0;
    return true;
  }

  /**
   * Best foothold near where the foot wants to be: on the floor or the basin bottom, never on a catwalk, a pillar
   * or the anglerfish, within reach, with the leg clear of catwalk edges and pillars and out of the whale's way.
   */
  _pickFoot(L, i, whale) {
    const lv = this.level, hip = L.hipW, w = L.want, B = this.anglerBox;
    let best = null, bestS = Infinity;
    const pose = L.hasSafeFoot ? L.guard._snapshot() : null;
    const rig = this.rig;
    for (let c = 0; c < (L.hasSafeFoot ? 33 : 17); c++) {
      let x = w.x, z = w.z, off = 0;
      if (c > 16) {
        const ring = c <= 24 ? 4 : 8, a = (c % 8) * (Math.PI / 4);
        x = L.safeFoot.x + Math.cos(a) * ring;
        z = L.safeFoot.z + Math.sin(a) * ring;
        off = Math.hypot(x - w.x, z - w.z);
      } else if (c > 0) {
        const ring = c <= 8 ? 2.5 : 5, a = (c % 8) * (Math.PI / 4) + (c > 8 ? Math.PI / 8 : 0);
        x += Math.cos(a) * ring;
        z += Math.sin(a) * ring;
        off = ring;
      }
      const tx = Math.floor(x / 2), tz = Math.floor(z / 2);
      if (lv.ch(tx, tz) === '=' || lv.solid(tx, tz)) continue;
      const fy = lv.floor(tx, tz) + 0.4;
      if (fy > 900) continue;
      if (x > B[0] && x < B[2] && z > B[1] && z < B[3]) continue;
      const reach = Math.hypot(x - hip.x, fy - hip.y, z - hip.z) / L.len;
      if (reach > 0.98) continue;
      let s = off;
      if (reach > 0.93) s += (reach - 0.93) * 400;
      // where the leg passes the catwalk height it should not be right at a deck
      if (fy < DECK_TOP && hip.y > DECK_TOP) {
        const f = (DECK_TOP - fy) / (hip.y - fy);
        for (let g = 0; g <= 2; g++) {
          const u = (f * g) / 2;
          if (this._deckNear(x + (hip.x - x) * u, z + (hip.z - z) * u)) s += 6;
        }
      }
      if (this._pillarOn(x, z, hip.x, hip.z) || this._pillarOn(L.foot.x, L.foot.z, x, z)) continue;
      if (whale && fy < 0) {
        const wc = whale.clearance(x, z);
        if (wc < 4) s += (4 - wc) * 4;
      }
      for (let j = 0; j < NW; j++) {
        if (j === i) continue;
        const o = this.legs[j], q = o.swing >= 0 ? o.to : o.foot;
        if (Math.hypot(q.x - x, q.z - z) < 3) s += 5;
      }
      if (s < bestS && pose) {
        rig.reach(L.ik, _a.set(x, fy, z).applyMatrix4(rig.rootInv), WALK_KNEE_LIFT);
        rig.pose();
        if (!this.surface.clear(lv, i + 1)) continue;
      }
      if (s < bestS) {
        bestS = s;
        best = _pick.set(x, fy, z);
      }
    }
    if (pose) {
      L.guard.objects.forEach((o, j) => { o.position.copy(pose[j].p); o.quaternion.copy(pose[j].q); o.scale.copy(pose[j].s); });
      rig.driven.fill(0); rig.pose();
    }
    return best;
  }

  _deckNear(x, z) {
    const lv = this.level, d = (dx, dz) => lv.ch(Math.floor((x + dx) / 2), Math.floor((z + dz) / 2)) === '=';
    return d(0, 0) || d(1, 0) || d(-1, 0) || d(0, 1) || d(0, -1);
  }

  _pillarOn(ax, az, bx, bz) {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 1.5));
    for (let k = 0; k <= n; k++) {
      if (this.level.ch(Math.floor((ax + ((bx - ax) * k) / n) / 2), Math.floor((az + ((bz - az) * k) / n) / 2)) === 'P') return true;
    }
    return false;
  }

  _crossesDeck(a, b) {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z)));
    for (let k = 0; k <= n; k++) {
      if (this.level.ch(Math.floor((a.x + ((b.x - a.x) * k) / n) / 2), Math.floor((a.z + ((b.z - a.z) * k) / n) / 2)) === '=') return true;
    }
    return false;
  }

  _splash(at, size) {
    _c.set(at.x, 0, at.z);
    this.audio.splash(size, _c);
    this.water.addRipple(at.x, at.z, 0.8);
    this.fx.bubbles.spawn(at.x, -0.3, at.z, 6, 1, 1.2);
  }

  // ------------------------------------------------------------------ forelegs

  /** Forelegs: held out ahead, now and then tapping the deck or the water; in a chase, a stab from above. */
  _fore(dt, t, player) {
    const M = this.rig.root.matrix, lv = this.level;
    this.tapCool -= dt;
    this.stabCool -= dt;
    for (let s = 0; s < 2; s++) {
      const L = this.legs[NW + s], T0 = L.idleBase || L.ik.T0, ph = s * 2.1;
      L.idle.set(
        T0.x + 0.03 * Math.cos(t * 0.4 + ph),
        T0.y + 0.05 + 0.02 * Math.sin(t * 0.5 + ph),
        T0.z + 0.03 * Math.sin(t * 0.4 + ph) * L.side,
      ).applyMatrix4(M);
      this.foreT[s].copy(L.idle);
    }
    if (!player) return;
    const p = player.pos, calm = this.state === 'patrol' || this.state === 'suspicious';

    if (!this.stab && !this.tap && calm && this.tapCool <= 0) {
      this.tapCool = 6 + this.rand() * 6;
      const s = this.rand() < 0.5 ? 0 : 1, I = this.foreT[s];
      const tx = Math.floor(I.x / 2), tz = Math.floor(I.z / 2), ch = lv.ch(tx, tz);
      if (!lv.solid(tx, tz)) {
        const kind = ch === '=' ? 'deck' : lv.isWater(tx, tz) ? 'water' : 'dry';
        const y = kind === 'deck' ? DECK_TOP + 0.1 : kind === 'water' ? -0.4 : lv.floor(tx, tz) + 0.1;
        this.tap = { s, t: 0, y, kind, sounded: false };
      }
    }
    if (this.tap) {
      const tp = this.tap;
      tp.t += dt;
      const k = Math.min(1, tp.t / 0.9), T = this.foreT[tp.s];
      T.y = lerp(T.y, tp.y, Math.sin(Math.PI * k));
      if (!tp.sounded && k >= 0.5) {
        tp.sounded = true;
        if (tp.kind === 'deck') this.audio.lurkerSnap(T);
        else if (tp.kind === 'water') {
          this.audio.splash(0.35, T);
          this.water.addRipple(T.x, T.z, 0.6);
        }
      }
      if (k >= 1 || this.stab || !calm) this.tap = null;
    }

    if (!this.stab && this.state === 'chase' && this.stabCool <= 0 && this.seenT < 1.5 && !player.frozen) {
      const dx = p.x - this.hub.x, dz = p.z - this.hub.z;
      const ahead = dx * Math.sin(this.h) + dz * Math.cos(this.h);
      const lat = -dx * Math.cos(this.h) + dz * Math.sin(this.h);
      const s = lat >= 0 ? 1 : 0, L = this.legs[NW + s];
      _a.copy(L.ik.H0).applyMatrix4(M);
      if (ahead > -2 && _a.distanceTo(p) < 0.9 * L.len) {
        const st = this._stab;
        st.s = s;
        st.phase = 'wind';
        st.t = 0;
        st.done = false;
        st.aim.copy(p);
        this.stab = st;
        this.tap = null;
        this.voice.growl();
        this.events.push({ type: 'stab', source: 'crab', x: p.x, y: p.y, z: p.z });
      }
    }
    const st = this.stab;
    if (!st) return;
    st.t += dt;
    const T = this.foreT[st.s];
    if (st.phase === 'wind') {
      // rear up over the swimmer, tracking it
      if (!player.frozen) st.aim.lerp(p, Math.min(1, dt * 3));
      _a.copy(this.legs[NW + st.s].ik.H0).applyMatrix4(M);
      _b.copy(st.aim);
      _b.y += 7;
      _c.subVectors(_a, _b).setY(0);
      const l = _c.length();
      if (l > 1e-3) _b.addScaledVector(_c, 2 / l);
      T.lerp(_b, smooth(st.t / STAB_WIND));
      if (st.t >= STAB_WIND) {
        st.phase = 'strike';
        st.t = 0;
        st.from.copy(T);
        this._strikeTarget(st);
      }
    } else if (st.phase === 'strike') {
      const k = Math.min(1, st.t / STAB_HIT);
      T.lerpVectors(st.from, st.to, k * k);
      if (k >= 1) st.done = true;
    } else if (st.phase === 'recover') {
      const k = st.t < 0.4 ? 0 : smooth((st.t - 0.4) / 0.8);
      _b.copy(T);
      T.lerpVectors(st.from, _b, k);
      if (st.t >= 1.2) {
        this.stab = null;
        this.stabCool = 2.5;
      }
    } else if (st.phase === 'feed') {
      if (this.state !== 'feed') this.stab = null;
      else T.lerp(this.mouth, smooth(st.t / 0.8));
    }
  }

  /** Down through where the swimmer was: onto the slab of a catwalk, the floor, or a little way into the water. */
  _strikeTarget(st) {
    const lv = this.level, to = st.to.copy(st.aim);
    to.y -= 1;
    const tx = Math.floor(to.x / 2), tz = Math.floor(to.z / 2);
    if (lv.ch(tx, tz) === '=') {
      to.y = DECK_TOP + 0.3;
      st.kind = 'deck';
    } else if (!lv.isWater(tx, tz)) {
      to.y = Math.max(to.y, lv.floor(tx, tz) + 0.3);
      st.kind = 'dry';
    } else {
      st.kind = 'water';
    }
    to.y = Math.max(to.y, -1.5);
  }

  /** Did the striking tip pass through the swimmer this frame? A catwalk overhead shields it. */
  _hit(player) {
    const st = this.stab;
    if (!st || st.phase !== 'strike') return;
    const p = player.pos;
    const shielded = this.level.ch(player.tileX, player.tileZ) === '=' && p.y < DECK_BOTTOM;
    const from = this.prevTip[st.s], to = this.foreTip[st.s];
    _a.subVectors(to, from);
    const u = clamp(_b.subVectors(p, from).dot(_a) / (_a.lengthSq() || 1), 0, 1);
    _b.copy(from).addScaledVector(_a, u);
    if (!player.frozen && !shielded && segDist(p, from, to) < CATCH_R
      && attackClear(this.level, from, _b) && attackClear(this.level, _b, p)) {
      st.phase = 'feed';
      st.t = 0;
      this.events.push({ type: 'catch', source: 'crab' });
      this._setState('feed');
      if (this.onCatch) this.onCatch({ source: 'crab', maw: this.mouth.clone(), grab: p.clone() });
      return;
    }
    if (!st.done) return;
    const tip = this.foreTip[st.s];
    if (st.kind === 'water') {
      this.audio.splash(1, tip);
      this.water.addRipple(tip.x, tip.z, 1.5);
      this.fx.bubbles.spawn(tip.x, Math.min(-0.3, tip.y), tip.z, 14, 1.2, 1.5);
    } else {
      this.audio.lurkerSnap(tip);
    }
    player.shake = Math.max(player.shake, 0.5 * clamp(1 - Math.hypot(p.x - tip.x, p.z - tip.z) / 20, 0, 1));
    st.phase = 'recover';
    st.t = 0;
    st.from.copy(tip);
  }

  // ------------------------------------------------------------------ pose and effects

  _pose(t) {
    const rig = this.rig;
    for (let i = 0; i < this.legs.length; i++) {
      const L = this.legs[i];
      this._reachLeg(L, L.fore ? this.foreT[i - NW] : L.foot);
    }
    const chew = this.state === 'feed' ? 0.25 : 0;
    this.mouthparts.forEach((b, k) => {
      rig.bend(b, _q.setFromAxisAngle(Z_AXIS, 0.12 * Math.sin(t * 5 + k * 1.7) + chew * Math.sin(t * 11 + k)));
    });
    rig.pose();
    for (let i = 0; i < this.legs.length; i++) this._fitLeg(i);
    for (let i = 0; i < this.legs.length; i++) {
      const L = this.legs[i];
      if (!L.guard.ready) continue;
      // The body has moved since the saved local leg pose. Grounded feet must be
      // replanted in world space before sweeping an independently moving leg.
      L.guard._copy(L.guard.goal);
      L.guard.apply(0);
      const previousFits = L.guard.clear();
      L.guard.apply(1);
      if (!previousFits && L.guard.clear()) { L.guard.reset(); continue; }
      if (L.guard.constrain() === 1) continue;
      const target = L.fore ? this.foreT[i - NW] : L.foot;
      rig.toWorld(L.ik.knee, L.ik.T0, target);
      L.safeFoot.copy(target);
      if (!L.fore) L.swing = -1;
    }
    // Some imported skin vertices blend across adjacent legs. Recheck those
    // shared patches after all independent leg sweeps have been resolved.
    for (let i = 0; i < this.legs.length; i++) this._fitLeg(i);
    this._tips();
  }

  /** Bound corrections by the previous rendered tip, including collision recovery. */
  _reachLeg(L, target) {
    _a.copy(target);
    if (this.frameDt !== null && L.hasSafeFoot) {
      const distance = L.frameFoot.distanceTo(_a);
      const speed = L.fore && this.stab ? 80 : 10;
      _a.lerpVectors(L.frameFoot, _a, Math.min(1, speed * this.frameDt / (distance || 1)));
    }
    this.rig.reach(L.ik, _a.applyMatrix4(this.rig.rootInv), L.fore ? 0.9 : WALK_KNEE_LIFT);
  }

  /** Try alternate footholds with the complete posed thigh and shin, not just the foot. */
  _fitLeg(i) {
    const rig = this.rig, L = this.legs[i], target = L.fore ? this.foreT[i - NW] : L.foot;
    const clear = () => this.surface.clear(this.level, i + 1);
    if (clear()) { rig.toWorld(L.ik.knee, L.ik.T0, L.safeFoot); L.hasSafeFoot = true; return; }
    const wanted = target.clone(), hip = L.ik.H0.clone().applyMatrix4(rig.root.matrix);
    const tryAt = (p) => {
      const tx = Math.floor(p.x / 2), tz = Math.floor(p.z / 2);
      if (this.level.solid(tx, tz) || (!L.fore && this.level.deckTop(tx, tz) !== null)) return false;
      if (!L.fore && _a.copy(p).applyMatrix4(rig.rootInv).z * L.side < L.ik.H0.z * L.side) return false;
      this._reachLeg(L, p);
      rig.pose();
      if (!clear()) return false;
      rig.toWorld(L.ik.knee, L.ik.T0, L.safeFoot); target.copy(L.safeFoot); L.hasSafeFoot = true;
      if (!L.fore) L.swing = -1;
      return true;
    };
    const dx = wanted.x - hip.x, dz = wanted.z - hip.z;
    for (const factor of [1, 0.85, 0.7, 0.55, 0.4]) for (const angle of [0, 0.2, -0.2, 0.45, -0.45, 0.8, -0.8, 1.2, -1.2]) {
      const x = hip.x + (dx * Math.cos(angle) - dz * Math.sin(angle)) * factor;
      const z = hip.z + (dz * Math.cos(angle) + dx * Math.sin(angle)) * factor;
      for (const lift of L.fore ? [0, 2, 4, 6] : [0, 1.5, 3]) {
        const y = L.fore ? Math.max(wanted.y + lift, this._ground(x, z)) : this._ground(x, z) + lift;
        if (tryAt(new THREE.Vector3(x, y, z))) return;
      }
    }
    if (L.hasSafeFoot && tryAt(L.safeFoot.clone())) return;
    // The whole-pose guard retains the last valid pose if no foothold is reachable this frame.
    this._reachLeg(L, wanted);
    rig.pose();
  }

  _tips() {
    const rig = this.rig;
    for (let s = 0; s < 2; s++) {
      const L = this.legs[NW + s];
      rig.toWorld(L.ik.knee, L.ik.T0, this.foreTip[s]);
    }
    rig.toWorld(this.bodyBone, MOUTH, this.mouth);
  }

  _effects(dt, t, player) {
    const vis = this.group.visible;
    const rageT = this.state === 'chase' || this.state === 'feed' ? 1
      : this.state === 'suspicious' || this.state === 'search' ? 0.5 * Math.min(1, this.awareness) : 0;
    this.rage += (rageT - this.rage) * Math.min(1, dt * 2);
    const c = this.eyeCol;
    for (let k = 0; k < 3; k++) c[k] = lerp(EYE_COL[k], RAGE_COL[k], this.rage);
    if (vis) {
      const flick = 0.9 + 0.1 * Math.sin(t * 7.3) * Math.sin(t * 3.1);
      this.rig.toWorld(this.bodyBone, EYES[0], _a);
      this.rig.toWorld(this.bodyBone, EYES[1], _b);
      this.eye.addVectors(_a, _b).multiplyScalar(0.5);
      for (let k = 0; k < 2; k++) {
        this.rig.toWorld(this.bodyBone, EYES[k], _a);
        const eye = this.eyes[k];
        eye.position.copy(_a);
        eye.lookAt(_b.copy(this.eye).addScaledVector(this.fwd, this.tracking ? this.eye.distanceTo(player.pos) : 30));
        _a.addScaledVector(eye.getWorldDirection(_c), 0.16);
        this.glow.set(k * 2, _a.x, _a.y, _a.z, c[0] * flick, c[1] * flick, c[2] * flick, 0.16);
        this.glow.set(k * 2 + 1, _a.x, _a.y, _a.z, c[0] * 0.12, c[1] * 0.12, c[2] * 0.12, 2);
      }
      this.irisMaterial.color.setRGB(...c).multiplyScalar(0.28);
      this.irisMaterial.emissive.setRGB(...c).multiplyScalar(0.2);
      this.glow.upload(4);
      const e = this.eye, g = this.gazeHit;
      Object.assign(this.eyeLamp, { x: e.x, y: e.y, z: e.z, intensity: 1.0 * flick });
      Object.assign(this.gazeLamp, { x: g.x, y: g.y + 0.8, z: g.z, intensity: 1.4 * flick });
      // the body drips onto the water beneath it
      if (this.rand() < dt * 2) {
        const x = this.hub.x + (this.rand() - 0.5) * 12, z = this.hub.z + (this.rand() - 0.5) * 12;
        if (this.level.isWater(Math.floor(x / 2), Math.floor(z / 2))) this.water.addRipple(x, z, 0.15);
      }
    } else {
      this.glow.upload(0);
      for (const l of [this.eyeLamp, this.gazeLamp]) { l.y = -500; l.intensity = 0; }
    }
    this.probe.value.setRGB(0.006 + 0.01 * c[0], 0.01 + 0.012 * c[1], 0.012 + 0.014 * c[2]);
    this.voice.setPosition(this.eye.x, this.eye.y, this.eye.z);
    this.voice.setSpeed(this.spd / SPEED.chase);
    this.voice.update(dt);
    if (player.frozen && this.state === 'feed') player.shake = Math.max(player.shake, 0.2);
  }

  dispose() {
    this.group.removeFromParent();
    this.rig.mesh.geometry.dispose();
    this.rig.mesh.skeleton.dispose();
    disposeModelSkin(this.bodyMat);
    this.glow.dispose();
    this.eyeGeometry.dispose();
    for (const material of [this.eyeMaterial, this.irisMaterial, this.pupilMaterial]) material.dispose();
    this.voice.dispose();
    for (const l of [this.eyeLamp, this.gazeLamp]) { l.y = -500; l.intensity = 0; }
  }
}
