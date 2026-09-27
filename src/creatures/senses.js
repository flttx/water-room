// Shared perception helpers for every creature: how visible the player is, line of sight and awareness gain.

export const AWARE_SUSPICIOUS = 0.3;
export const AWARE_CHASE = 1.0;

/**
 * How conspicuous the player is to a watcher at `from` (roughly 0.05..3).
 * Light at the player's tile, stance, the flashlight (worse when shone at the watcher) and movement.
 */
export function exposure(player, lightGrid, level, from) {
  const tx = player.tileX, tz = player.tileZ;
  const lum = lightGrid[tz * level.W + tx] || 0;
  let v = 0.16 + 0.84 * Math.min(1, lum / 0.45);
  if (level.isDark(tx, tz)) v *= 0.7;
  if (player.crouch) v *= 0.5;
  if (player.mode === 'under') v *= 0.75;
  else if (player.mode === 'surface') v *= 0.85;
  if (player.flashlight) {
    const cp = Math.cos(player.pitch);
    const lx = -Math.sin(player.yaw) * cp, ly = Math.sin(player.pitch), lz = -Math.cos(player.yaw) * cp;
    const dx = from.x - player.pos.x, dy = from.y - player.pos.y, dz = from.z - player.pos.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const facing = (lx * dx + ly * dy + lz * dz) / d;
    v *= 1.4 + Math.max(0, facing) * 1.6;
  }
  v *= 0.55 + 0.45 * Math.min(1, player.speed / 3) + (player.sprint ? 0.25 : 0);
  return v;
}

/** Effective sight range: the water surface scatters light, murk limits sight below it. */
export function sightRange(base, eyeY, targetY) {
  const a = eyeY < 0, b = targetY < -0.15;
  if (a !== b) return base * 0.6;
  if (a && b) return base * 0.75;
  return base;
}

/**
 * Distance to target if it is inside the view cone and range with a clear line, else -1.
 * Anything closer than 4 m is noticed regardless of facing.
 */
export function sight(level, eye, fwd, cosHalf, range, target) {
  const dx = target.x - eye.x, dy = target.y - eye.y, dz = target.z - eye.z;
  const d = Math.hypot(dx, dy, dz);
  if (d > range) return -1;
  if (d > 4 && (dx * fwd.x + dy * fwd.y + dz * fwd.z) / d < cosHalf) return -1;
  if (!level.segmentClear(eye.x, eye.y, eye.z, target.x, target.y, target.z, 0.6)) return -1;
  return d;
}

/** Awareness gained per second while the player is in view. */
export function awarenessRate(vis, d, range) {
  const near = Math.max(0, 1 - d / range);
  return 1.6 * vis * Math.pow(near, 1.2) + (d < 5 ? 1.5 : 0);
}
