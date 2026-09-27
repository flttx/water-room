// Tripo driver for the creature models. The API key is loaded by client.mjs and never printed.
// Usage:
//   node tools/tripo/gen.mjs concepts <asset> <count> [imageModel]   text-to-image concept sheets
//   node tools/tripo/gen.mjs model <asset> <conceptKey> [tag]         image-to-model (textured GLB)
//   node tools/tripo/gen.mjs rigcheck <asset> <modelKey>              free riggability check
//   node tools/tripo/gen.mjs rig <asset> <modelKey> <rigType> [anim...] auto-rig, then bake preset animations
// State: tools/tripo/<asset>/state.json; images in concepts/, raw GLBs in raw/.
import fs from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTask, waitTask, download, outputUrl, redact } from './client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL_VERSION = 'v3.1-20260211';
const TEXTURE_VERSION = 'v3.5-20260815';
const RIG_VERSION = 'v2.5-20260210';

const STUDIO = 'single isolated creature, centered, plain flat light grey studio background, no ground, no water, no shadow on the background, soft even diffuse lighting, strong three-dimensional volume, extremely detailed, photorealistic 3D render';

const ASSETS = {
  colossus: {
    prompt: `A colossal Lovecraftian cephalopod god, only the head and the massive upper body, upright, a huge bulbous wrinkled octopus-like mantle head with deep folds, a cluster of about a dozen round bulging eyes of different sizes spread over the upper face, every eye with a bright glowing amber-orange iris and a black slit pupil, a gaping vertical maw ringed with rows of long needle teeth below the eyes, a dense curtain of many thin short tentacles hanging from the lower face and chin like a beard, a thick barrel-shaped trunk below the head with heavy ridges and folds, ending in the thick roots of short coiled tentacle bases at the bottom, wet slimy dark olive-grey skin with dark red veins, a pale mottled underside, barnacles and old scars, front view, symmetrical, the whole creature visible from the top of the head to the bottom of the trunk, ${STUDIO}`,
    neg: 'long tentacles, long arms, legs, wings, human body, humanoid, hands, water, sea, ground, rocks, text, watermark, cropped, cut off, multiple creatures, cartoon, toy, low quality, blurry',
    size: '1728x3072',
    chatSize: '1024x1536',
    faces: 70000,
  },
  leviathan: {
    prompt: `An enormous deep-sea serpent leviathan, exact side view profile facing left, the entire long straight body visible from the snout to the tail tip laid out perfectly horizontally, a huge armoured skull-like head with a long underslung jaw full of long crooked fangs, small pale milky eyes, a long thick eel-like body of even thickness with a ridge of jagged spines along the back, a long slowly tapering tail, dark slate-black scarred skin with a paler grey belly, rows of small round photophore spots along the flanks, a mix of gulper eel, viperfish and oarfish, ${STUDIO}`,
    neg: 'coiled, curled, bent body, S-shape, loop, legs, arms, wings, fins like a dragon, water, sea, ground, text, watermark, cropped, cut off, multiple creatures, cartoon, toy, low quality, blurry',
    size: '3456x1152',
    chatSize: '1536x1024',
    faces: 40000,
  },
  crab: {
    prompt: `A gigantic abyssal spider crab monster, full body, eight extremely long thin jointed walking legs spread wide and symmetric around a small body, every leg bent high at the knee and planted on the ground, two long slender claws folded in front of the face, a spiky armoured pear-shaped carapace crusted with barnacles, pale sponges and hanging strands of rotten seaweed, a cluster of small glowing milky eyes on short stalks at the front, bone-white and rust-red mottled shell, front three-quarter view from slightly above, the whole creature visible including every leg tip, ${STUDIO}`,
    neg: 'missing legs, cropped legs, extra legs, short legs, water, sea, ground, rocks, sand, text, watermark, cropped, cut off, multiple creatures, cartoon, toy, low quality, blurry',
    size: '3072x1728',
    chatSize: '1536x1024',
    faces: 60000,
  },
  angler: {
    prompt: `A gigantic deep-sea anglerfish monster, exact side view profile facing left, the entire body visible, a huge head with an enormous gaping underbite mouth full of long glassy crooked needle fangs, a long lure rod arching forward from the forehead ending in a round bulb, small dead milky eyes, a bloated round body tapering into a short tail with ragged translucent fins, pectoral fins spread, dark black-brown wrinkled leathery skin with pale scars and lateral line pores, ${STUDIO}`,
    neg: 'cute, cartoon, toy, coiled, water, sea, ground, text, watermark, cropped, cut off, multiple creatures, low quality, blurry',
    size: '3072x1728',
    chatSize: '1536x1024',
    faces: 40000,
  },
  whale: {
    prompt: `A colossal rotting undead whale carcass that is still swimming, exact side view profile facing left, the whole long body visible from the blunt head to the tail flukes laid out horizontally, a sperm-whale-like square head with a narrow lower jaw lined with teeth, large patches of skin torn away revealing the curved rib cage and the spine, pale grey decaying blubber hanging in ragged strips, colonies of pale bone worms and anemones growing on the exposed bones, a milky dead eye, pectoral flippers, ${STUDIO}`,
    neg: 'coiled, curled, bent body, skeleton only, bones only, legs, arms, water, sea, ground, text, watermark, cropped, cut off, multiple creatures, cartoon, toy, low quality, blurry',
    size: '3456x1152',
    chatSize: '1536x1024',
    faces: 50000,
  },
};

const [cmd, asset, ...rest] = process.argv.slice(2);
const A = ASSETS[asset];
if (!A) throw new Error(`unknown asset ${asset}`);
const dir = path.join(HERE, asset);
await fs.mkdir(path.join(dir, 'concepts'), { recursive: true });
await fs.mkdir(path.join(dir, 'raw'), { recursive: true });
const stateFile = path.join(dir, 'state.json');
const load = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { concepts: {}, models: {} });
const save = (fn) => { const s = load(); fn(s); writeFileSync(stateFile, `${JSON.stringify(s, null, 2)}\n`); };
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${asset} ${redact(msg)}`);

async function concept(idx, model) {
  const key = `${model}_${Date.now().toString(36)}_${idx}`;
  const prompt = `${A.prompt} --no ${A.neg}`;
  const body = model.startsWith('chat_image')
    ? { model, prompt, size: A.chatSize, quality: 'high', output_format: 'png' }
    : { model, prompt, size: A.size, output_format: 'png', watermark: false };
  const taskId = await createTask('text-to-image', body);
  log(`${key} text-to-image ${taskId}`);
  const task = await waitTask(taskId, { timeoutMs: 15 * 60_000 });
  const url = outputUrl(task, ['generated_image_url', 'image_url', 'url']);
  if (!url) throw new Error(`no image url (${Object.keys(task.output ?? {}).join(',')})`);
  const file = await download(url, path.join(dir, 'concepts', key));
  save((s) => { s.concepts[key] = { task_id: taskId, model, file: path.basename(file.path), at: new Date().toISOString() }; });
  log(`${key} -> ${path.basename(file.path)}`);
}

async function model(conceptKey, tag = 'm') {
  const c = load().concepts[conceptKey];
  if (!c) throw new Error(`unknown concept ${conceptKey}`);
  const body = {
    input: c.task_id, model: MODEL_VERSION, texture: true, pbr: true,
    texture_quality: 'detailed', geometry_quality: 'detailed', texture_version: TEXTURE_VERSION, delight: true,
    face_limit: A.faces, texture_alignment: 'original_image',
  };
  const key = `${conceptKey}__${tag}`;
  const taskId = await createTask('image-to-model', body);
  log(`${key} image-to-model ${taskId}`);
  const task = await waitTask(taskId, { timeoutMs: 40 * 60_000, interval: 5000 });
  const url = outputUrl(task, ['pbr_model_url', 'model_url', 'base_model_url']);
  if (!url) throw new Error(`no model url (${Object.keys(task.output ?? {}).join(',')})`);
  const raw = await download(url, path.join(dir, 'raw', `${key}.glb`));
  const prevUrl = outputUrl(task, ['rendered_image_url']);
  const prev = prevUrl
    ? await download(prevUrl, path.join(dir, 'raw', `${key}_preview`)).catch((e) => { log(`preview download failed: ${e.message}`); return null; })
    : null;
  save((s) => { s.models[key] = { task_id: taskId, concept: conceptKey, file: path.basename(raw.path), bytes: raw.bytes, preview: prev ? path.basename(prev.path) : null, credits: task.credits_consumed ?? null, at: new Date().toISOString() }; });
  log(`${key} -> ${path.basename(raw.path)} (${(raw.bytes / 1e6).toFixed(1)} MB)`);
}

async function rigCheck(modelKey) {
  const m = load().models[modelKey];
  if (!m) throw new Error(`unknown model ${modelKey}`);
  const taskId = await createTask('/animations/rig-check', { input: m.task_id });
  const task = await waitTask(taskId, { timeoutMs: 10 * 60_000 });
  log(`${modelKey} rig-check ${JSON.stringify(task.output)}`);
}

async function rig(modelKey, rigType, anims) {
  const m = load().models[modelKey];
  if (!m) throw new Error(`unknown model ${modelKey}`);
  const key = `${modelKey}__${rigType}`;
  const rigId = await createTask('/animations/rig', { input: m.task_id, model: RIG_VERSION, rig_type: rigType, spec: 'tripo', out_format: 'glb' });
  log(`${key} rig ${rigId}`);
  const rigTask = await waitTask(rigId, { timeoutMs: 30 * 60_000, interval: 5000 });
  const rigged = await download(outputUrl(rigTask, ['model_url']), path.join(dir, 'raw', `${key}.glb`));
  save((s) => { (s.rigs ??= {})[key] = { task_id: rigId, model: modelKey, rig_type: rigType, file: path.basename(rigged.path), credits: rigTask.credits_consumed ?? null, at: new Date().toISOString() }; });
  log(`${key} -> ${path.basename(rigged.path)}`);
  if (!anims.length) return;
  const animId = await createTask('/animations/retarget', { input: rigId, animations: anims, out_format: 'glb', bake_animation: true, animate_in_place: true });
  log(`${key} retarget ${anims.join(',')} ${animId}`);
  const animTask = await waitTask(animId, { timeoutMs: 30 * 60_000, interval: 5000 });
  const animated = await download(outputUrl(animTask, ['model_url']), path.join(dir, 'raw', `${key}__anim.glb`));
  save((s) => { s.rigs[key].anim = { task_id: animId, animations: anims, file: path.basename(animated.path), credits: animTask.credits_consumed ?? null }; });
  log(`${key} animated -> ${path.basename(animated.path)}`);
}

try {
  if (cmd === 'concepts') {
    const [count = '2', m = 'seedream_v5'] = rest;
    // image generation allows about one concurrent task, so run them in sequence
    for (let i = 0; i < Number(count); i++) await concept(i, m).catch((e) => log(`concept ${i} FAILED ${e.message}`));
  } else if (cmd === 'model') {
    await model(rest[0], rest[1]);
  } else if (cmd === 'rigcheck') {
    await rigCheck(rest[0]);
  } else if (cmd === 'rig') {
    await rig(rest[0], rest[1], rest.slice(2));
  } else throw new Error(`unknown cmd ${cmd}`);
} catch (e) {
  log(`FAILED ${e.message}`);
  process.exitCode = 1;
}
