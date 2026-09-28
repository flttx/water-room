// Level layout, authored with carve operations on a solid grid.
// One tile = 2 m. x grows east, z grows south. Water surface is y = 0 everywhere.
//
// Legend
//   #  solid tiled rock          P  pillar (solid)
//   .  walkway / dry deck        ,  low service corridor (dry)
//   ^  stair step (height from LIFT)
//   ~  channel water (deep)      O  abyss water (bottomless)
//   -  shallow bath water        l  low crawl water (ceiling just above the surface)
//   u  submerged tunnel          a  air pocket inside a tunnel
//   R  reservoir flats (water)   Q  reservoir basin (deep water)
//   =  catwalk over reservoir water (deck on top, open water beneath)
//   S  start                     C  checkpoint (lantern on adjacent wall)
//   V  valve (mounted on adjacent wall)
//   D  pressure door (opens after the pump-room valve)
//   G  sluice gate (opens after all valves)
//   E  exit corridor             X  exit trigger
// Dry tiles listed in LIFT stand higher than the deck (galleries, stairs, the diving tower).

export const TILE = 2;
export const W = 154;
export const H = 84;

const GALLERY_Y = 3.35;

function build() {
  const g = Array.from({ length: H }, () => Array(W).fill('#'));
  const lift = new Map();
  const rect = (x0, z0, x1, z1, ch) => {
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) g[z][x] = ch;
  };
  const set = (x, z, ch) => { g[z][x] = ch; };
  const raise = (x0, z0, x1, z1, y) => {
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) lift.set(z * W + x, y);
  };
  // n stair tiles starting at (x, z) and climbing along (dx, dz) from the deck to the gallery height;
  // `wide` extends every step sideways
  const stairs = (x, z, dx, dz, n, wide = 1) => {
    for (let i = 0; i < n; i++) {
      const y = 0.6 + ((GALLERY_Y - 0.6) * (i + 1)) / (n + 1);
      for (let k = 0; k < wide; k++) {
        const sx = x + dx * i + (dz ? k : 0), sz = z + dz * i + (dx ? k : 0);
        set(sx, sz, '^');
        raise(sx, sz, sx, sz, y);
      }
    }
  };

  // ===== canal network: walkways first, water afterwards so crossings stay open
  rect(5, 74, 98, 78, '.');   // H1 south canal
  rect(5, 26, 98, 30, '.');   // H2 middle canal
  rect(5, 8, 9, 78, '.');     // V1 west canal
  rect(94, 8, 98, 78, '.');   // V4 east canal
  rect(30, 30, 34, 74, '.');  // V2
  rect(69, 30, 73, 74, '.');  // V3
  rect(5, 8, 39, 12, '.');    // H3 north-west
  rect(64, 8, 98, 12, '.');   // H4 north-east

  rect(6, 75, 97, 77, '~');
  rect(6, 27, 97, 29, '~');
  rect(6, 9, 8, 77, '~');
  rect(95, 9, 97, 77, '~');
  rect(31, 27, 33, 77, '~');
  rect(70, 27, 72, 77, '~');
  rect(6, 9, 39, 11, '~');
  rect(64, 9, 97, 11, '~');

  // ===== the Abyss hall: bottomless water, ring deck broken in places
  rect(39, 6, 64, 23, '#');
  rect(40, 7, 63, 22, 'O');
  rect(39, 13, 39, 21, '.');          // west deck strip
  rect(64, 14, 64, 21, '.');          // east deck strip
  rect(39, 9, 39, 11, 'O');           // joins H3
  rect(64, 9, 64, 11, 'O');           // joins H4
  rect(40, 23, 49, 23, '.');          // south deck, west half
  rect(54, 23, 63, 23, '.');          // south deck, east half
  rect(46, 6, 57, 6, '.');            // gate platform
  rect(47, 5, 49, 5, '.');
  rect(53, 5, 55, 5, '.');
  rect(44, 11, 45, 12, 'P'); rect(58, 11, 59, 12, 'P');
  rect(44, 17, 45, 18, 'P'); rect(58, 17, 59, 18, 'P');
  rect(51, 14, 52, 15, '.');          // lifeguard island
  // neck to the middle canal
  rect(49, 23, 54, 26, '.');
  rect(50, 23, 53, 26, '~');
  // gate + exit corridor
  rect(50, 5, 52, 5, 'G');
  rect(50, 1, 52, 4, 'E');
  set(51, 1, 'X');

  // ===== Grand Lido: olympic pool with a diving tower on a long pier, shallow end to the south
  rect(38, 33, 65, 57, '.');
  rect(40, 35, 63, 55, '~');
  rect(40, 50, 63, 55, '-');
  rect(58, 43, 63, 44, '.');          // pier from the east deck
  stairs(57, 43, -1, 0, 4, 2);        // up toward the tower
  rect(50, 42, 53, 45, '.');          // tower platform
  raise(50, 42, 53, 45, GALLERY_Y);
  for (const [x, z] of [[41, 50], [47, 52], [56, 51], [62, 53]]) set(x, z, 'P');
  rect(50, 30, 53, 34, '~');          // water gate from H2
  rect(34, 44, 39, 46, '~');          // water gate from V2
  rect(64, 38, 69, 40, '~');          // water gate from V3
  rect(44, 31, 45, 32, ',');          // deck doors to H2
  rect(59, 31, 60, 32, ',');
  // south corridor with a checkpoint room down to the south canal
  rect(51, 58, 52, 73, ',');
  rect(49, 64, 54, 67, ',');
  set(49, 65, 'C');
  rect(55, 66, 57, 66, ',');          // storeroom stub
  rect(56, 67, 57, 69, '~');

  // ===== West Tiered Baths (valve 1): a deep plunge pool, shallow tubs and a high gallery
  rect(11, 33, 27, 55, '.');
  rect(19, 35, 26, 53, '~');
  rect(15, 35, 17, 40, '-');
  rect(14, 46, 17, 51, '-');
  rect(11, 33, 12, 54, '.');
  raise(11, 33, 12, 54, GALLERY_Y);    // gallery along the west wall
  stairs(13, 54, 0, -1, 4);            // climbs north from the south floor
  set(11, 34, 'V');
  for (const z of [37, 43, 49]) set(18, z, 'P');
  rect(10, 55, 10, 55, ',');           // door from V1, below the gallery
  rect(26, 44, 31, 46, '~');           // water gate from V2
  rect(20, 56, 20, 57, ',');           // door down to the lockers

  // ===== Locker maze: dry corridors, dead ends and a checkpoint
  rect(12, 58, 27, 58, ',');
  rect(12, 58, 12, 72, ',');
  rect(12, 72, 27, 72, ',');
  rect(16, 58, 16, 68, ',');
  rect(20, 62, 20, 72, ',');
  rect(24, 58, 24, 66, ',');
  rect(16, 62, 19, 62, ',');
  rect(12, 65, 15, 65, ',');
  rect(20, 66, 27, 66, ',');
  rect(21, 69, 27, 69, ',');
  rect(17, 68, 19, 68, ',');
  rect(14, 68, 15, 70, ',');
  rect(21, 60, 23, 64, ',');
  set(23, 60, 'C');
  rect(27, 60, 27, 64, ',');           // dead-end locker row
  rect(25, 60, 26, 60, ',');
  rect(14, 73, 14, 73, ',');
  rect(25, 73, 25, 73, ',');
  rect(28, 66, 29, 66, ',');

  // ===== East Cistern (valve 2): a black pillar forest
  rect(76, 33, 92, 56, '~');
  for (let x = 78; x <= 90; x += 3) {
    for (let z = 36; z <= 53; z += 3) if ((x * 7 + z * 3) % 5 !== 0) set(x, z, 'P');
  }
  rect(76, 33, 92, 33, '.');           // north ledge
  rect(87, 55, 92, 56, '.');           // south-east ledge
  set(92, 56, 'V');
  rect(73, 44, 76, 46, '~');           // water gate from V3
  rect(92, 36, 95, 38, '~');           // water gate from V4
  rect(80, 31, 81, 32, ',');           // door from H2

  // ===== Drain crawl: low water passages under a collapsed floor
  rect(82, 57, 83, 62, 'l');
  rect(77, 62, 91, 63, 'l');
  rect(77, 63, 78, 71, 'l');
  rect(77, 70, 90, 71, 'l');
  rect(89, 71, 90, 74, 'l');
  rect(86, 64, 87, 67, 'u');           // flooded dead end
  rect(73, 66, 76, 67, 'l');           // to V3
  set(79, 69, 'l');                    // turning recess for the entrance guard's body

  // ===== North-east shower gallery: pool under a raised walkway, a fallen slab across the water
  rect(70, 14, 90, 23, '.');
  rect(71, 16, 89, 22, '~');
  rect(70, 14, 88, 15, '.');
  rect(70, 16, 70, 16, '.');
  raise(70, 14, 88, 15, GALLERY_Y);
  raise(70, 16, 70, 16, GALLERY_Y);
  stairs(70, 20, 0, -1, 4);
  set(88, 14, 'C');
  rect(76, 16, 77, 22, 'l');           // collapsed ceiling slab
  rect(79, 23, 81, 26, '~');           // water gate to H2
  set(90, 13, ',');                    // door to H4
  rect(91, 19, 93, 19, ',');           // door to V4

  // ===== North-west service block with a checkpoint and a flooded storeroom
  rect(14, 13, 14, 25, ',');
  rect(15, 18, 23, 18, ',');
  rect(19, 15, 23, 17, ',');
  set(21, 15, 'C');
  rect(24, 18, 24, 25, ',');
  rect(25, 20, 28, 22, '~');

  // ===== Pump room (valve 3) reached through a long flooded tunnel from the west canal
  rect(5, 34, 5, 41, '#');             // west deck of V1 interrupted
  rect(2, 37, 5, 38, 'u');
  rect(2, 5, 3, 36, 'u');
  rect(2, 26, 3, 27, 'a');             // air pockets on the way
  rect(2, 15, 3, 16, 'a');
  rect(1, 30, 1, 34, 'u');             // blind side passage
  rect(1, 1, 3, 4, '~');
  rect(4, 1, 13, 4, ',');
  set(9, 1, 'V');
  set(4, 4, 'C');
  set(11, 5, 'D');
  rect(11, 6, 11, 7, ',');

  // ===== start room
  rect(48, 80, 55, 82, ',');
  rect(51, 79, 52, 79, ',');
  set(51, 81, 'S');

  // ===== broken decks (force swimming)
  rect(26, 74, 29, 74, '~'); rect(41, 78, 45, 78, '~'); rect(60, 74, 63, 74, '~');
  rect(12, 78, 15, 78, '~'); rect(84, 78, 87, 78, '~');
  rect(15, 26, 18, 26, '~'); rect(60, 30, 63, 30, '~'); rect(86, 26, 88, 26, '~');
  rect(36, 30, 40, 30, '~');
  rect(9, 48, 9, 52, '~'); rect(94, 58, 94, 62, '~');
  rect(34, 56, 34, 59, '~'); rect(69, 52, 69, 55, '~');
  rect(9, 18, 9, 21, '~'); rect(94, 28, 94, 30, '~');
  rect(20, 12, 24, 12, '~'); rect(70, 8, 73, 8, '~');

  // ===== dead ends for disorientation
  rect(99, 50, 102, 53, '~');           // east bay
  rect(1, 60, 4, 63, '~');              // west bay
  rect(1, 64, 2, 70, 'u');
  rect(20, 79, 26, 81, '~');            // south sump
  rect(84, 3, 88, 7, '~');              // north bay off H4
  // Optional flooded shortcut: checkpoint corridor -> plant room -> west canal -> lockers.
  // The resident lure-fish guards the shorter crossing; the original routes remain open.
  rect(40, 60, 44, 63, '~');
  rect(45, 61, 50, 61, ',');
  rect(34, 61, 39, 62, '~');
  rect(28, 61, 30, 62, ',');           // climb-out landing into the old locker dead end

  // ===== Underground reservoir: a vaulted dome of black water behind the east bay, catwalks over a deep basin
  const [rx0, rz0, rx1, rz1] = RESERVOIR.dome, [bx0, bz0, bx1, bz1] = RESERVOIR.basin;
  rect(rx0, rz0, rx1, rz1, 'R');
  rect(bx0, bz0, bx1, bz1, 'Q');
  rect(103, 51, 107, 52, 'l');         // culvert from the east bay
  rect(108, 45, 111, 50, '.');         // entry landing
  set(108, 47, 'C');
  rect(112, 47, 127, 47, '=');         // west catwalk, broken in the middle
  rect(119, 47, 120, 47, 'Q');
  rect(128, 44, 133, 49, '=');         // pump deck in the middle of the basin
  rect(131, 33, 131, 43, '=');         // north catwalk, one span fallen
  set(131, 38, 'Q');
  rect(132, 33, 146, 33, '=');
  rect(147, 29, 151, 36, '.');         // valve platform
  set(151, 32, 'V');
  rect(134, 46, 146, 46, '=');         // east catwalk
  rect(139, 46, 140, 46, 'Q');
  rect(147, 43, 151, 49, '.');         // east ledge
  rect(150, 37, 150, 42, '=');         // rim catwalk up to the valve platform
  rect(108, 27, 111, 28, '.');         // collapsed north-west stair landing (dead end)
  for (const [x, z] of [[124, 40], [135, 40], [115, 31], [143, 30], [115, 53], [144, 54], [129, 29], [121, 51], [137, 51], [124, 36], [138, 37]]) {
    rect(x, z, x + 1, z + 1, 'P');
  }

  // pillars along the long canals, on the walkways so the water stays navigable
  for (const z of [20, 44, 66]) { set(5, z, 'P'); set(98, z, 'P'); }
  for (const x of [18, 40, 62, 84]) { set(x, 74, 'P'); set(x, 30, 'P'); }
  for (const z of [38, 56]) { set(30, z, 'P'); set(73, z, 'P'); }

  return { rows: g.map((row) => row.join('')), lift };
}

// The reservoir dome and its deep basin, and where its residents live (tile coordinates)
export const RESERVOIR = {
  dome: [108, 26, 151, 59],
  basin: [113, 29, 146, 56],
  crab: [117, 35, 143, 51],
  angler: [141, 52],
  whale: { cx: 129.5, cz: 43.5, rx: 12, rz: 8.5 },
  jellies: [
    [[112, 57], [148, 57], [148, 52], [140, 49], [126, 48], [114, 49]],
    [[114, 27], [138, 27], [140, 34], [121, 34], [111, 35]],
  ],
};

const built = build();
export const MAP = built.rows;
export const LIFT = built.lift;

// Rooms with raised ceilings: [x0, z0, x1, z1, ceilingY]. 22 marks the Abyss hall.
export const HALLS = [
  [39, 6, 64, 23, 22],
  [11, 33, 27, 55, 12],
  [76, 33, 92, 56, 14],
  [38, 33, 65, 57, 14],
  [49, 23, 54, 26, 12],
  [70, 14, 90, 23, 9],
  [1, 1, 13, 4, 4.5],
  [48, 80, 55, 82, 3.6],
  [49, 64, 54, 67, 4.2],
  [108, 26, 151, 59, 32],
];

// Tile rectangle of the Abyss hall and the centre column of its sluice gate
export const ABYSS = { x0: 39, z0: 6, x1: 64, z1: 23, gateX: 51 };

// Areas kept deliberately unlit: [x0, z0, x1, z1]
export const DARK_ZONES = [
  [1, 1, 5, 41],
  [74, 35, 93, 56],
  [73, 57, 93, 73],
  [12, 64, 19, 72],
  [25, 20, 28, 22],
  [99, 48, 103, 55],
  [35, 26, 46, 30],
  [84, 1, 90, 7],
  [1, 58, 5, 70],
  [40, 60, 50, 63],
  [18, 78, 27, 82],
  [103, 50, 151, 59],
  [108, 26, 151, 49],
];

// Painted labels near junctions: [x, z, text]
export const SIGNS = [
  [51, 79, 'B-0'], [30, 78, 'B-2'], [73, 78, 'B-4'], [9, 78, 'A-1'], [94, 78, 'C-1'],
  [34, 30, 'B-7'], [69, 30, 'B-9'], [9, 30, 'A-6'], [94, 30, 'C-6'], [51, 27, 'D-0'],
  [9, 12, 'A-9'], [94, 12, 'C-9'], [14, 13, '泵房←'], [44, 33, '中央泳池'],
  [11, 41, '阶梯浴场'], [81, 32, '东蓄水池'], [20, 58, '更衣室'], [52, 58, '救生站'],
  [74, 66, '排水渠'], [90, 13, '淋浴廊'], [9, 36, '泵房 · 水下'], [108, 45, '地下水库'], [102, 53, '水库→'],
  [50, 61, '更衣室近道'], [28, 61, '救生站近道'],
];

// This entrance guard periodically leaves the junction for the inner drain.
export const DRAIN_LURKER_PATROL = {
  entrance: [78, 66], entryWorld: [155.5, 134], innerWorld: [156.5, 141.5],
};

// Dark water where lure-fish lie in wait: [tx, tz]
export const LURKERS = [
  [27, 21], [80, 40], [88, 49], DRAIN_LURKER_PATROL.entrance, [101, 51], [86, 5], [2, 61], [42, 61],
];

// Tile waypoints of the slow drifting colony's loop through the canals
export const DRIFT_ROUTE = [
  [32, 28], [51, 28], [71, 28], [71, 50], [71, 76], [51, 76], [32, 76], [32, 50],
];
