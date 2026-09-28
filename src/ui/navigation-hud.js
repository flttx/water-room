// The map uses the same world coordinates and tile boundaries as the level shell.
const MAP_PIXELS_PER_METER = 4;
const MAP_WIDTH_METERS = 80;

export class NavigationHud {
  constructor() {
    const get = (id) => document.getElementById(id);
    this.root = get('hud-navigation');
    this.route = get('hud-route');
    this.direction = get('hud-direction');
    this.arrow = get('hud-direction-arrow');
    this.action = get('hud-direction-action');
    this.target = get('hud-route-target');
    this.status = get('hud-route-status');
    this.canvas = get('hud-map');
    this.ctx = this.canvas.getContext('2d');
    this.base = document.createElement('canvas');
  }

  setLevel(level) {
    this.level = level;
    this.mapKey = null;
    this.base.width = Math.ceil(level.W * level.tile * MAP_PIXELS_PER_METER);
    this.base.height = Math.ceil(level.H * level.tile * MAP_PIXELS_PER_METER);
  }

  hide() { this.root.hidden = true; }

  update(nav, player, difficulty, monsters = []) {
    if (difficulty === 'hard' || !nav || !player || !this.level) { this.hide(); return; }
    this.root.hidden = false;
    const map = difficulty === 'easy';
    this.route.hidden = !map;
    this.direction.hidden = map;
    const reachable = nav.status !== 'unreachable' && nav.target;
    let action = '';
    if (!reachable) action = '暂无路线';
    else if (nav.action === 'breathe') action = '换气';
    else if (nav.status === 'arrived') action = nav.target.kind === 'valve' ? '按住 E' : '继续前进';
    else if (nav.status === 'waiting' && nav.distance < 3) action = '等待闸门';
    else if (nav.waypoint?.mode === 'under' && player.pos.y > nav.waypoint.y + 0.7) action = '下潜';
    else if (player.underwater && nav.waypoint?.mode !== 'under') action = '上浮';
    else if (player.inWater && ['ground', 'climb'].includes(nav.waypoint?.mode)) action = '空格攀上';

    this.action.textContent = action;
    const showArrow = reachable && action !== '等待闸门' && action !== '换气' && nav.status !== 'arrived';
    this.arrow.toggleAttribute('hidden', !showArrow);
    if (nav.waypoint && showArrow) {
      const dx = nav.waypoint.x - player.pos.x, dz = nav.waypoint.z - player.pos.z;
      const angle = Math.atan2(dx, -dz) + player.yaw;
      this.arrow.style.transform = `rotate(${angle}rad)`;
      const a = Math.atan2(Math.sin(angle), Math.cos(angle));
      const direction = Math.abs(a) < Math.PI / 4 ? '向前' : Math.abs(a) > Math.PI * 3 / 4 ? '向后' : a > 0 ? '向右' : '向左';
      this.direction.setAttribute('aria-label', action || `${direction}沿通道前进`);
    } else this.direction.setAttribute('aria-label', action || '前进方向');

    if (!map) return;
    const name = reachable ? nav.target.name : '暂时无法规划路线';
    const distance = Number.isFinite(nav.distance) ? Math.ceil(nav.distance) : 0;
    this.target.textContent = reachable ? `下一站 · ${name}` : name;
    this.status.textContent = action || `沿路线前进 · ${distance} 米`;
    const nearby = this._draw(nav, player, monsters);
    this.canvas.setAttribute('aria-label', `${reachable ? `逃生路线：前往${name}，沿途约${distance}米` : '当前位置暂无可通行路线'}；附近地图，上方为北，红色菱形为怪物${nearby.length ? `：${nearby.join('、')}` : '，当前范围内无怪物'}`);
  }

  _draw(nav, player, monsters) {
    const ctx = this.ctx, level = this.level;
    if (!ctx) return [];
    const w = this.canvas.width, h = this.canvas.height;
    const pixelRatio = w / (this.canvas.clientWidth || w / 2);
    const scale = w / MAP_WIDTH_METERS;
    const ox = w / 2 - player.pos.x * scale, oz = h / 2 - player.pos.z * scale;
    const mapKey = [...level.dynamicOpen].join(',');
    if (this.mapKey !== mapKey) {
      this.mapKey = mapKey;
      const base = this.base.getContext('2d');
      if (!base) return [];
      base.fillStyle = '#02080b';
      base.fillRect(0, 0, this.base.width, this.base.height);
      const cell = level.tile * MAP_PIXELS_PER_METER;
      for (let z = 0; z < level.H; z++) for (let x = 0; x < level.W; x++) {
        if (level.solid(x, z)) continue;
        base.fillStyle = level.deckTop(x, z) !== null ? '#718c82' : level.isWater(x, z) ? '#254a53' : '#59746f';
        base.fillRect(x * cell, z * cell, cell, cell);
      }
      // Draw only real boundaries, including columns and closed door panels.
      base.strokeStyle = '#a6b9b0';
      base.lineWidth = 1;
      base.beginPath();
      for (let z = 0; z < level.H; z++) for (let x = 0; x < level.W; x++) {
        if (level.solid(x, z)) continue;
        const left = x * cell, top = z * cell;
        if (level.solid(x, z - 1)) { base.moveTo(left, top); base.lineTo(left + cell, top); }
        if (level.solid(x, z + 1)) { base.moveTo(left, top + cell); base.lineTo(left + cell, top + cell); }
        if (level.solid(x - 1, z)) { base.moveTo(left, top); base.lineTo(left, top + cell); }
        if (level.solid(x + 1, z)) { base.moveTo(left + cell, top); base.lineTo(left + cell, top + cell); }
      }
      base.stroke();
      // Raised landings and stair risers are also part of the building shell.
      base.strokeStyle = '#8ba49b';
      base.beginPath();
      for (let z = 0; z < level.H; z++) for (let x = 0; x < level.W; x++) {
        if (level.solid(x, z) || level.isWater(x, z)) continue;
        for (const [dx, dz] of [[1, 0], [0, 1]]) {
          if (level.solid(x + dx, z + dz) || level.isWater(x + dx, z + dz)) continue;
          if (Math.abs(level.floor(x, z) - level.floor(x + dx, z + dz)) < 0.1) continue;
          if (dx) { base.moveTo((x + 1) * cell, z * cell); base.lineTo((x + 1) * cell, (z + 1) * cell); }
          else { base.moveTo(x * cell, (z + 1) * cell); base.lineTo((x + 1) * cell, (z + 1) * cell); }
        }
      }
      base.stroke();
    }
    ctx.fillStyle = '#02080b';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, ox, oz, this.base.width / MAP_PIXELS_PER_METER * scale, this.base.height / MAP_PIXELS_PER_METER * scale);
    const x = (v) => ox + v * scale, z = (v) => oz + v * scale;
    if (nav.path.length) {
      ctx.beginPath();
      ctx.moveTo(x(player.pos.x), z(player.pos.z));
      for (let i = nav.pathIndex ?? 0; i < nav.path.length; i++) {
        const p = nav.path[i];
        ctx.lineTo(x(p.x), z(p.z));
      }
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#f0a64a';
      ctx.stroke();
    }
    const nearby = new Set();
    for (const monster of monsters) {
      const px = x(monster.pos.x), pz = z(monster.pos.z);
      if (px < 0 || pz < 0 || px > w || pz > h) continue;
      nearby.add(monster.name);
      const radius = (monster.small ? 2 : 3) * pixelRatio;
      ctx.beginPath();
      ctx.moveTo(px, pz - radius); ctx.lineTo(px + radius, pz); ctx.lineTo(px, pz + radius); ctx.lineTo(px - radius, pz); ctx.closePath();
      ctx.fillStyle = '#ff7974';
      ctx.fill();
      ctx.strokeStyle = '#270d13';
      ctx.lineWidth = pixelRatio;
      ctx.stroke();
      // A small chevron distinguishes creatures above/below the player's floor.
      if (!monster.small && Math.abs(monster.pos.y - player.pos.y) > 3) {
        const dy = monster.pos.y > player.pos.y ? -1 : 1;
        ctx.beginPath();
        ctx.moveTo(px - pixelRatio, pz + dy * (radius + pixelRatio));
        ctx.lineTo(px, pz + dy * (radius + pixelRatio * 2));
        ctx.lineTo(px + pixelRatio, pz + dy * (radius + pixelRatio));
        ctx.strokeStyle = '#ffaaa4'; ctx.stroke();
      }
    }
    if (nav.target) {
      ctx.beginPath();
      ctx.arc(x(nav.target.x), z(nav.target.z), 3 * pixelRatio, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffe3bd';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(x(player.pos.x), z(player.pos.z));
    ctx.rotate(-player.yaw);
    ctx.scale(pixelRatio / 2, pixelRatio / 2);
    ctx.beginPath();
    ctx.moveTo(0, -8); ctx.lineTo(5.5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5.5, 6); ctx.closePath();
    ctx.fillStyle = '#f5f5df';
    ctx.fill();
    ctx.restore();
    return [...nearby];
  }
}
