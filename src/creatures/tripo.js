import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { patchMaterial } from '../render/shaderlib.js';

// Creature bodies modelled with Tripo (image-to-model) and cleaned up in Blender by
// tools/blender/tripo_process.py: one mesh per file in metres, with base colour, ORM and normal maps.

const FILES = { colossus: 'models/colossus.glb', leviathan: 'models/leviathan.glb' };

/**
 * Load the creature meshes. A model that fails to load is left out and its creature falls back
 * to its sculpted body. Resolves to { name: { geometry, material } }.
 */
export async function loadCreatureModels() {
  const loader = new GLTFLoader();
  const out = {};
  await Promise.all(Object.entries(FILES).map(async ([name, file]) => {
    try {
      const gltf = await loader.loadAsync(import.meta.env.BASE_URL + file);
      let mesh = null;
      gltf.scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
      if (!mesh) throw new Error(`${file} has no mesh`);
      out[name] = { geometry: mesh.geometry, material: mesh.material };
    } catch (err) {
      console.warn(`creature model "${name}" unavailable, using the sculpted body`, err);
    }
  }));
  return out;
}

// Rigged bodies: Tripo auto-rig (v2.5) plus a baked swim/walk clip, cleaned up by
// tools/blender/tripo_rig_process.py. Tripo units and orientation; the creature code places, scales and poses them.
const RIGGED = {
  crab: 'models/crab.glb',
  angler: 'models/angler.glb',
  whale: 'models/whale.glb',
  leviathanRig: 'models/leviathan_rig.glb',
};

/**
 * Load the skinned creature models. A model that fails to load is left out and its creature
 * falls back (or stays away). Resolves to { name: { scene, animations, mesh } }.
 */
export async function loadRiggedModels() {
  const loader = new GLTFLoader();
  const out = {};
  await Promise.all(Object.entries(RIGGED).map(async ([name, file]) => {
    try {
      const gltf = await loader.loadAsync(import.meta.env.BASE_URL + file);
      let mesh = null;
      gltf.scene.traverse((o) => { if (!mesh && o.isSkinnedMesh) mesh = o; });
      if (!mesh) throw new Error(`${file} has no skinned mesh`);
      out[name] = { scene: gltf.scene, animations: gltf.animations, mesh };
    } catch (err) {
      console.warn(`rigged model "${name}" unavailable`, err);
    }
  }));
  return out;
}

const FRAG_DECL = /* glsl */ `
uniform vec3 uTint;
uniform vec3 uRim;
`;

const RIM_LIGHT = /* glsl */ `
{
  float ndv = saturate(dot(geometryNormal, geometryViewDir));
  reflectedLight.indirectSpecular += uRim * pow(1.0 - ndv, 3.0);
}
`;

/**
 * Wet skin from a loaded glTF material, lit by the game's lamps, light probe, water and fog.
 * o: { key, probe, rim, tint, roughness, uniforms, vertDecl, vertTransform, vertReplace, fragDecl, albedo, emissive }.
 * o.albedo runs with the texture colour still in diffuseColor, before the tint darkens it.
 */
export function modelSkin(src, o = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map: src.map,
    normalMap: src.normalMap,
    normalScale: src.normalScale ? src.normalScale.clone() : new THREE.Vector2(1, 1),
    roughnessMap: src.roughnessMap,
    roughness: o.roughness ?? 0.6,
    metalness: 0,
  });
  src.dispose();
  const u = {
    uTint: { value: new THREE.Color(...(o.tint || [1, 1, 1])) },
    uRim: o.rim || { value: new THREE.Color(0.004, 0.012, 0.014) },
    ...o.uniforms,
  };
  patchMaterial(mat, {
    key: `model-${o.key}`,
    probe: o.probe,
    uniforms: u,
    vertDecl: o.vertDecl,
    vertTransform: o.vertTransform,
    vertReplace: o.vertReplace,
    fragDecl: FRAG_DECL + (o.fragDecl || ''),
    albedo: `${o.albedo || ''}\ndiffuseColor.rgb *= uTint;\n`,
    lighting: RIM_LIGHT,
    emissive: o.emissive,
  });
  mat.userData.u = u;
  return mat;
}

/** Dispose a model skin together with the textures it took over from the glTF material. */
export function disposeModelSkin(mat) {
  for (const t of [mat.map, mat.normalMap, mat.roughnessMap]) if (t) t.dispose();
  mat.dispose();
}

const _ray = new THREE.Raycaster();

/** First hit of a ray on a mesh with an identity transform: { pos, normal } in mesh space, or null. */
export function castOnto(mesh, origin, dir) {
  _ray.set(origin, dir);
  const hit = _ray.intersectObject(mesh, false)[0];
  return hit ? { pos: hit.point.clone(), normal: hit.face.normal.clone() } : null;
}
