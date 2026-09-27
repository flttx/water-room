"""The Hunter - ~29 m eel/lamprey-like leviathan with skeleton + animations.

Run:  blender -b --factory-startup --python tools/blender/hunter.py
Writes public/models/hunter.glb and preview PNGs in tools/blender/previews/.
Pass `-- --no-render` after the script to skip previews.

Blender space: head faces -Y, body along +Y, up +Z  (three.js: head +Z, up +Y).
`s` below = Blender Y = distance behind the head joint (three.js z = -s).
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import creature_common as cc  # noqa: E402
from creature_common import (clamp, gauss, lerp, mix_col, nose, smoothstep, spline, spow, srgb)  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils import noise as mnoise  # noqa: E402

N3 = mnoise.noise

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, 'public', 'models', 'hunter.glb')
PREV = os.path.join(HERE, 'previews')
RENDER = '--no-render' not in sys.argv

PI = math.pi
N = 52                      # body ring vertices (multiple of 4)
NSP = 20                    # spine bones
SP = 1.3                    # spine spacing (m)
S_TIP = -3.2                # snout tip
S_NOSE = -2.3               # where the snout starts rounding
S_CHIN = -3.45              # lower jaw tip (juts past the snout)
HINGE_S, HINGE_Z = 0.7, -0.45
S_BODY_END = 25.9
S_TAIL_TIP = 26.05
S_FIN_END = 26.7
S_JAW_END = 1.3             # lower jaw ends just behind the hinge, tucked into the throat

MATS = ['hunter_skin', 'hunter_mouth', 'hunter_teeth', 'hunter_eye', 'hunter_glow', 'hunter_fin']
SPINE = [f'spine_{i:02d}' for i in range(NSP)]
BONES = SPINE + ['jaw', 'fin_L', 'fin_R']

# ---------------------------------------------------------------- profiles
R_T = [(-3.2, 0.80), (-2.3, 0.95), (-1.0, 1.15), (0.5, 1.32), (1.7, 1.45), (3.0, 1.56), (5.0, 1.67),
       (7.0, 1.70), (9.0, 1.63), (12.0, 1.42), (15.0, 1.12), (18.0, 0.82), (21.0, 0.52), (23.5, 0.30),
       (25.0, 0.18), (25.9, 0.12)]
KX_T = [(-4.0, 1.0), (6.0, 1.0), (14.0, 0.84), (22.0, 0.64), (26.0, 0.58)]
ZM_T = [(-3.2, -0.24), (-2.4, -0.36), (-1.2, -0.43), (0.0, -0.46), (0.7, -0.45), (1.8, -0.45)]
TOP_T = [(-3.2, 0.20), (-2.5, 0.47), (-1.9, 0.70), (-1.0, 0.95), (0.0, 1.15), (0.9, 1.29), (1.7, 1.45),
         (2.5, 1.53)]
WL_T = [(-3.2, 0.72), (-2.3, 0.94), (-1.2, 1.10), (0.0, 1.22), (0.8, 1.30), (1.7, 1.43), (2.5, 1.52)]
JB_T = [(-3.45, -0.62), (-3.0, -0.98), (-2.2, -1.40), (-1.2, -1.72), (-0.2, -1.84), (0.7, -1.76),
        (1.5, -1.58), (2.2, -1.45)]


def R(s):
    return spline(R_T, s)


def KX(s):
    return spline(KX_T, s)


def zm(s):
    return spline(ZM_T, s)


def nf(s):
    return nose(s, S_TIP, S_NOSE)


def beta(s):
    return smoothstep(0.15, 1.35, s)


def HB(s):
    """depth factor of the lower body half: deep, heavy throat behind the jaw."""
    return 0.93 + 0.30 * (1 - smoothstep(1.0, 6.0, s))


def dome_top(s):
    z0 = zm(s)
    return z0 + (spline(TOP_T, s) - z0) * nf(s) ** 0.55


def lip_w(s):
    return spline(WL_T, s) * nf(s)


E_DOME = 2 / 2.8


def tube_xz(s, th):
    r = R(s)
    w = r * KX(s)
    sn, cs = math.sin(th), math.cos(th)
    if cs >= 0:
        e, h = 2 / 2.3, r
    else:
        e, h = 2 / 2.9, HB(s) * r
    return w * spow(sn, e), h * spow(cs, e)


def dome_xz(s, th):
    z0 = zm(s)
    return lip_w(s) * spow(math.sin(th), E_DOME), z0 + (dome_top(s) - z0) * abs(math.cos(th)) ** E_DOME


def palate_xz(s, t):
    w = lip_w(s)
    return w * math.cos(PI * t), zm(s) + 0.17 * nf(s) * math.sin(PI * t) ** 0.7


def jaw_params(s):
    wl0 = spline(WL_T, s)
    nfo = nose(s, S_CHIN, -2.45)
    nfi = nose(s, -3.25, -2.35)
    zr = zm(s) + 0.07
    jb = spline(JB_T, s)
    wo = (wl0 + 0.21) * nfo
    wi = (wl0 + 0.035) * nfi
    zob = zr - 0.03 - (zr - 0.03 - jb) * nfo ** 0.5
    zib = zr - 0.03 - max(0.0, zr - 0.03 - jb - 0.26) * nfi ** 0.6
    g = smoothstep(0.25, 1.2, s)
    if g > 0:
        wb = 0.955 * R(s) * KX(s)
        bb = -0.955 * HB(s) * R(s)
        wo = lerp(wo, wb, g)
        zob = lerp(zob, bb, g)
        wi = lerp(wi, wb - 0.16, g)
        zib = lerp(zib, bb + 0.30, g)
    return wo, wi, zr, zob, zib


EO, EI = 2 / 2.4, 2 / 3.4


def cavity_halfwidth(s, z):
    """inner jaw cavity half width at height z (closed pose)."""
    wo, wi, zr, zob, zib = jaw_params(s)
    top = zr - 0.03
    if z >= top:
        return wi
    if z <= zib:
        return 0.0
    u = (top - z) / (top - zib)
    return wi * max(0.0, 1 - u ** (1 / EI)) ** EI


def inside_upper_head(x, s, z, margin=0.03):
    if s < S_TIP or s > 1.5:
        return False
    z0 = zm(s)
    top = dome_top(s)
    if z <= z0 or z >= top + margin:
        return False
    u = (z - z0) / (top - z0)
    hw = lip_w(s) * max(0.0, 1 - u ** (1 / E_DOME)) ** E_DOME
    return abs(x) < hw + margin


# ---------------------------------------------------------------- feature tables
rng = random.Random(1337)
mnoise.seed_set(7)

GILLS = [2.0 + 0.36 * k for k in range(5)]

# eyes: (s, theta(+left, from dorsal midline), radius) - irregular cluster under a heavy brow
EYES = [(-1.95, 1.02, 0.115), (-1.60, 0.80, 0.085), (-1.34, 1.16, 0.068),
        (-1.90, -1.04, 0.110), (-1.52, -0.83, 0.090), (-1.28, -1.13, 0.062)]

TUBERCLES = []
for side in (1, -1):
    s = -1.0
    while s < 5.0:       # two knobbly rows along the skull / nape
        TUBERCLES.append((s + rng.uniform(-0.08, 0.08), side * (0.50 + rng.uniform(-0.06, 0.06)),
                          rng.uniform(0.08, 0.12), rng.uniform(0.04, 0.07)))
        s += rng.uniform(0.34, 0.50)
    s = -2.6
    while s < -0.2:      # row above the upper lip
        TUBERCLES.append((s, side * (1.30 + rng.uniform(-0.05, 0.05)), rng.uniform(0.07, 0.1),
                          rng.uniform(0.025, 0.045)))
        s += rng.uniform(0.3, 0.42)
s = -0.9
while s < 2.6:           # medial crest knobs
    TUBERCLES.append((s, rng.uniform(-0.04, 0.04), rng.uniform(0.09, 0.14), rng.uniform(0.05, 0.08)))
    s += rng.uniform(0.38, 0.5)

# scars: segments in (s, angle) space, angle signed (+left)
SCARS = [((2.6, 0.30), (5.2, 1.05)), ((3.0, 0.20), (5.5, 0.95)), ((3.4, 0.12), (5.8, 0.85)),   # claw rake
         ((7.5, -0.5), (10.5, -1.3)), ((-0.6, -0.2), (0.9, -0.75)), ((12.0, 0.9), (13.6, 1.5)),
         ((15.5, -0.2), (17.0, -0.9)), ((-2.2, 0.35), (-1.3, 0.1))]

BACK = srgb((0.40, 0.46, 0.52))
FLANK = srgb((0.62, 0.67, 0.70))
BELLY = srgb((0.82, 0.81, 0.74))
BLOTCH = srgb((0.13, 0.16, 0.20))
SICK = srgb((0.72, 0.72, 0.55))
SCAR = srgb((0.88, 0.85, 0.80))
GILL_DARK = srgb((0.09, 0.02, 0.03))


def mottle(p):
    # frequencies kept low enough that every feature spans >= 3 vertices (ring spacing ~0.17 m)
    q = Vector((p[0], p[1] * 0.6, p[2]))
    return (N3(q * 0.42) + 0.5 * N3(q * 0.95 + Vector((3.1, 1.7, 5.2)))
            + 0.22 * N3(q * 1.9 + Vector((7.3, 2.1, 0.4))))


def skin_color(p, zn, dark=0.0, pale=0.0):
    base = mix_col(BELLY, FLANK, smoothstep(-0.75, -0.2, zn))
    base = mix_col(base, BACK, smoothstep(0.0, 0.75, zn))
    pv = Vector(p)
    m = mottle(pv)
    backw = smoothstep(-0.45, 0.25, zn)
    blot = smoothstep(0.02, 0.30, m) * backw          # soft-edged dark blotches, back + upper flank
    base = mix_col(base, BLOTCH, 0.8 * blot)
    sp = N3(pv * 1.6 + Vector((11.0, 3.0, 5.0)))
    spots = smoothstep(0.22, 0.45, sp) * smoothstep(-0.5, 0.3, zn) * 0.55
    base = mix_col(base, BLOTCH, spots)
    sick = smoothstep(0.05, 0.45, N3(pv * 0.22 + Vector((2.0, 9.0, 4.0))))
    base = mix_col(base, SICK, 0.35 * sick * (1 - blot))
    fine = 1.0 + 0.07 * N3(pv * 2.2)
    base = (base[0] * fine, base[1] * fine, base[2] * fine, 1.0)
    base = mix_col(base, SCAR, pale)
    base = mix_col(base, GILL_DARK, dark)
    return base


def seg_dist(p, a, b):
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0.0, 1.0)
    return math.hypot(px - ax - dx * t, py - ay - dy * t)


def surface_features(s, x, z, rr):
    """Displacement (m, along outward normal) + colour modifiers for skin at (x,s,z).
    rr = local body radius."""
    a = math.atan2(x, z)          # signed angle from dorsal midline (+left)
    aa = abs(a)
    d = 0.0
    dark = 0.0
    pale = 0.0
    # gill slits: 5 per side, curved, lengthening backwards, groove + overlapping rear flap
    if 1.6 < s < 4.0:
        for k, sk in enumerate(GILLS):
            a0 = 1.18 - 0.03 * k
            a1 = 2.02 + 0.03 * k
            wa = smoothstep(a0 - 0.1, a0 + 0.08, aa) * (1 - smoothstep(a1 - 0.08, a1 + 0.1, aa))
            sl = sk + 0.24 * (aa - PI / 2) + 0.05 * math.sin(3.0 * aa + k)
            u = (s - sl)
            d += wa * (-0.075 * gauss(u / 0.05) + 0.04 * gauss((u - 0.1) / 0.06))
            dark = max(dark, wa * gauss(u / 0.045))
    # myomere chevrons on flanks
    if s > 3.6:
        ph = (s + 0.5 * abs(z)) / 0.95
        d += (0.012 * rr * math.sin(2 * PI * ph) * smoothstep(0.35, 0.8, aa) * (1 - smoothstep(2.3, 2.8, aa))
              * smoothstep(3.6, 5.0, s))
    # dorsal keel (in front of the dorsal fin)
    d += 0.06 * rr * gauss(a / 0.17) * smoothstep(1.2, 2.6, s) * (1 - smoothstep(8.0, 9.2, s))
    # tubercles
    for (ts, ta, tr, th) in TUBERCLES:
        du = s - ts
        if abs(du) > 0.4:
            continue
        dv = (a - ta) * rr
        g = gauss(math.hypot(du, dv) / tr)
        d += th * g
        pale = max(pale, 0.25 * g)
    # scars
    for (p0, p1) in SCARS:
        if min(p0[0], p1[0]) - 0.3 < s < max(p0[0], p1[0]) + 0.3:
            dd = seg_dist((s, a * rr), (p0[0], p0[1] * rr), (p1[0], p1[1] * rr))
            g = gauss(dd / 0.03)
            pale = max(pale, 0.8 * g)
            d -= 0.015 * g
    # lumpy organic noise (no sub-vertex-frequency detail: it aliases into streaky shading)
    d += 0.022 * rr * N3(Vector((x, s * 0.8, z)) * 1.1)
    d += 0.008 * N3(Vector((x, s, z)) * 2.4)
    return d, dark, pale


def eye_features(s, x, z):
    d = 0.0
    dark = 0.0
    for (es, eth, er) in EYES:
        ex, ez = dome_xz(es, eth)
        dist = math.sqrt((s - es) ** 2 + (x - ex) ** 2 + (z - ez) ** 2)
        if dist > 4 * er:
            continue
        # sunken socket with a swollen fleshy rim
        d += 0.06 * gauss((dist - 1.6 * er) / (0.5 * er)) - 0.05 * gauss(dist / (1.1 * er))
        dark = max(dark, 0.9 * gauss(dist / (1.9 * er)))
    for side in (1, -1):
        # heavy brow ridge over each eye cluster, sloping down to the snout
        for (bs, bth, amp, rad) in ((-1.75, 0.72, 0.11, 0.2), (-1.2, 0.80, 0.08, 0.2), (-2.3, 0.62, 0.06, 0.16)):
            bx, bz = dome_xz(bs, side * bth)
            dist = math.sqrt(((s - bs) / 1.9) ** 2 + (x - bx) ** 2 + (z - bz) ** 2)
            d += amp * gauss(dist / rad)
        # nostril pits
        nx, nzz = dome_xz(-2.85, side * 0.45)
        dn = math.sqrt((s + 2.85) ** 2 + (x - nx) ** 2 + (z - nzz) ** 2)
        d -= 0.05 * gauss(dn / 0.06)
        dark = max(dark, 0.7 * gauss(dn / 0.07))
    # medial frown groove between the brows
    d -= 0.035 * gauss(x / 0.12) * gauss((s + 1.7) / 0.5) * smoothstep(0.3, 0.8, z)
    return d, dark


def spine_w(s):
    """smooth spine weights; head (s<0.8) fully on spine_00."""
    w = cc.chain_weights(s, NSP, SP)
    t = smoothstep(0.8, 2.0, s)
    return cc.blend_weights({'spine_00': 1.0}, w, t)


# ---------------------------------------------------------------- body
def ring_points(s):
    """returns list of (x, z, is_palate) for the main loft at station s."""
    b = beta(s)
    pts = []
    for k in range(N):
        th = -PI / 2 + 2 * PI * k / N
        tx, tz = tube_xz(s, th)
        if b >= 1.0:
            pts.append((tx, tz, False))
            continue
        if k <= N // 2:
            hx, hz = dome_xz(s, th)
            pal = False
        else:
            t = (k - N // 2) / (N // 2)
            hx, hz = palate_xz(s, t)
            pal = True
        pts.append((lerp(hx, tx, b), lerp(hz, tz, b), pal))
    return pts


def build_body(mb):
    ss = cc.stations([(S_TIP + 0.02, S_NOSE, 0.09, 'start'), (S_NOSE, 1.7, 0.1), (1.7, 3.8, 0.048),
                      (3.8, 20.0, 0.17), (20.0, S_BODY_END, 0.13)])
    rings = []
    info = []
    for s in ss:
        pts = ring_points(s)
        b = beta(s)
        rr = R(s)
        # centre of the ring for normals / zn
        ztop = max(p[1] for p in pts)
        zbot = min(p[1] for p in pts)
        zc = 0.5 * (ztop + zbot) if b < 1 else 0.0
        ring = []
        rinfo = []
        for k in range(N):
            x, z, pal = pts[k]
            xp, zp, _ = pts[(k - 1) % N]
            xn, zn_, _ = pts[(k + 1) % N]
            tx, tz = xn - xp, zn_ - zp
            ln = math.hypot(tx, tz) or 1.0
            nx, nz = -tz / ln, tx / ln
            # displacement weight: full on skin, none deep in the mouth
            dw = 1.0 if not pal else b ** 2
            if k in (0, N // 2) and b < 0.5:
                dw = 0.0
            d, dark, pale = surface_features(s, x, z, rr)
            if s < 0.8:
                de, dk = eye_features(s, x, z)
                d += de
                dark = max(dark, dk)
            d *= dw
            px, pz = x + nx * d, z + nz * d
            half = (ztop - zbot) * 0.5 if b < 1 else (rr if z >= 0 else HB(s) * rr)
            zn = (z - zc) / max(half, 1e-3) if b < 1 else z / max(half, 1e-3)
            if pal and b < 1:
                zn = min(zn, -0.2)
            col = skin_color((x, s, z), clamp(zn, -1, 1), dark * dw, pale * dw)
            ring.append(mb.v((px, s, pz), col, spine_w(s)))
            rinfo.append((x, z, pal))
        rings.append(ring)
        info.append((s, rinfo))

    def matfn(i, k):
        s0, r0 = info[i]
        s1, r1 = info[i + 1]
        if k < N // 2:
            return 'hunter_skin'
        sc = 0.5 * (s0 + s1)
        k2 = (k + 1) % N
        xc = 0.25 * (r0[k][0] + r0[k2][0] + r1[k][0] + r1[k2][0])
        zc = 0.25 * (r0[k][1] + r0[k2][1] + r1[k][1] + r1[k2][1])
        if beta(sc) >= 0.999:
            return 'hunter_skin'
        if sc < 0.2:
            return 'hunter_mouth'
        wo, wi, zr, zob, zib = jaw_params(sc)
        if sc < 1.1 and zc < zr - 0.03 and abs(xc) < 0.93 * wi:
            return 'hunter_mouth'
        return 'hunter_skin'

    mb.loft(rings, True, matfn=matfn)
    # sharp upper lip line
    for i in range(len(rings) - 1):
        if info[i + 1][0] < 0.35:
            for k in (0, N // 2):
                mb.sharp.append((rings[i][k], rings[i + 1][k]))
    # snout cap
    r0 = rings[0]
    cx = 0.0
    cz = sum(mb.V[i][2] for i in r0) / N
    tip = mb.v((cx, S_TIP - 0.01, cz + 0.02), skin_color((0, S_TIP, cz), 0.3), {'spine_00': 1.0})
    mb.fan(list(reversed(r0)), tip, 'hunter_skin')
    # tail cap
    rl = rings[-1]
    tail = mb.v((0.0, S_TAIL_TIP, 0.0), skin_color((0, S_TAIL_TIP, 0), 0.0), spine_w(S_TAIL_TIP))
    mb.fan(rl, tail, 'hunter_skin')


# ---------------------------------------------------------------- lower jaw
def jaw_ring(s):
    wo, wi, zr, zob, zib = jaw_params(s)
    pts = []
    MO, MI = 22, 16
    top_o = zr - 0.03
    for j in range(MO + 1):
        ph = PI * j / MO
        pts.append((wo * spow(math.cos(ph), EO), top_o - (top_o - zob) * abs(math.sin(ph)) ** EO, 0))
    pts.append((-(wo - 0.035), zr + 0.005, 1))
    pts.append((-(wi + 0.03), zr + 0.012, 1))
    top_i = zr - 0.03
    for j in range(MI + 1):
        ph = PI - PI * j / MI
        pts.append((wi * spow(math.cos(ph), EI), top_i - (top_i - zib) * abs(math.sin(ph)) ** EI, 2))
    pts.append((wi + 0.03, zr + 0.012, 1))
    pts.append((wo - 0.035, zr + 0.005, 1))
    return pts


JAW_GLOW = []


def build_jaw(mb):
    ss = cc.stations([(S_CHIN + 0.02, -2.45, 0.08, 'start'), (-2.45, S_JAW_END, 0.1)])
    rings = []
    tags = None
    jw = {'jaw': 1.0}
    for s in ss:
        pts = jaw_ring(s)
        tags = [p[2] for p in pts]
        M = len(pts)
        zr = zm(s) + 0.07
        ring = []
        for j, (x, z, tag) in enumerate(pts):
            if tag == 0:
                xp, zp, _ = pts[j - 1] if j > 0 else pts[-1]
                xn, zn_, _ = pts[(j + 1) % M]
                tx, tz = xn - xp, zn_ - zp
                ln = math.hypot(tx, tz) or 1.0
                nx, nz = tz / ln, -tx / ln
                if nx * x + nz * (z - zr) < 0:
                    nx, nz = -nx, -nz
                d = 0.02 * N3(Vector((x, s * 0.8, z)) * 1.3)
                # bony knobs along the lower jaw edge
                a = math.atan2(abs(x), -(z - zr))
                d += 0.05 * gauss((a - 0.95) / 0.12) * (0.5 + 0.5 * math.sin(s * 5.0)) * smoothstep(-3.2, -2.6, s) \
                    * (1 - smoothstep(0.2, 0.9, s))
                x, z = x + nx * d, z + nz * d
                zn = clamp((z - zr) / 0.9 + 0.35, -1.0, 0.2)
                col = skin_color((x, s, z), zn)
            elif tag == 1:
                col = mix_col(skin_color((x, s, z), 0.0), srgb((0.35, 0.25, 0.25)), 0.5)
            else:
                col = srgb((0.2, 0.05, 0.05))
            ring.append(mb.v((x, s, z), col, jw))
        rings.append(ring)

    def matfn(i, k):
        k2 = (k + 1) % len(tags)
        return 'hunter_mouth' if max(tags[k], tags[k2]) == 2 else 'hunter_skin'

    mb.loft(rings, True, matfn=matfn)
    s0 = ss[0]
    wo, wi, zr, zob, zib = jaw_params(s0)
    c0 = mb.v((0.0, S_CHIN, 0.5 * (zr + zob)), skin_color((0, S_CHIN, zr), -0.2), jw)
    mb.fan(list(reversed(rings[0])), c0, 'hunter_skin')
    s1 = ss[-1]
    wo, wi, zr, zob, zib = jaw_params(s1)
    c1 = mb.v((0.0, s1 + 0.05, 0.5 * (zr + zob)), skin_color((0, s1, zr), -0.2), jw)
    mb.fan(rings[-1], c1, 'hunter_skin')

    # photophores along the jaw flank
    for side in (1, -1):
        for k in range(6):
            s = -2.7 + k * 0.48 + rng.uniform(-0.05, 0.05)
            wo, wi, zr, zob, zib = jaw_params(s)
            ph = 0.62
            x = side * wo * spow(math.cos(ph), EO)
            z = zr - 0.03 - (zr - 0.03 - zob) * abs(math.sin(ph)) ** EO
            n = Vector((side * 0.85, 0, -0.5)).normalized()
            JAW_GLOW.append((Vector((x, s, z)), n, 0.045, {'jaw': 1.0}))


# ---------------------------------------------------------------- cheek membranes
def build_membranes(mb):
    SF, SB = -0.95, 0.66
    NS, NT = 12, 6
    col = srgb((0.30, 0.10, 0.10))
    for side in (1, -1):
        rows = []
        for i in range(NS + 1):
            u = i / NS
            row = []
            for j in range(NT + 1):
                t = j / NT
                s = lerp(SF + 0.45 * math.sin(PI * t), SB, u)
                wo, wi, zr, zob, zib = jaw_params(s)
                up = Vector((side * (lip_w(s) - 0.14), s, zm(s) + 0.02))
                lo = Vector((side * (wi - 0.04), s, zr - 0.14))
                p = up.lerp(lo, t)
                p.x -= side * 0.10 * math.sin(PI * t)
                row.append(mb.v(p, col, {'spine_00': 1 - t, 'jaw': t}))
            rows.append(row)
        mb.loft(rows, False, 'hunter_mouth')


# ---------------------------------------------------------------- teeth
TOOTH_COL = [srgb((0.80, 0.76, 0.62)), srgb((0.93, 0.91, 0.84))]


def tooth_col(u):
    return mix_col(TOOTH_COL[0], TOOTH_COL[1], clamp(u, 0, 1))


def curve_points(fn, s0, s1, n=400):
    pts = [fn(s0 + (s1 - s0) * i / n) for i in range(n + 1)]
    out = [(pts[0], 0.0)]
    acc = 0.0
    for i in range(1, len(pts)):
        acc += (pts[i] - pts[i - 1]).length
        out.append((pts[i], acc))
    return out


def sample_along(curve, spacing, jitter):
    total = curve[-1][1]
    res = []
    d = spacing * 0.4
    j = 0
    while d < total:
        while j < len(curve) - 1 and curve[j + 1][1] < d:
            j += 1
        res.append(curve[j][0].copy())
        d += spacing * (1 + rng.uniform(-jitter, jitter))
    return res


def build_teeth(mb):
    up_w = {'spine_00': 1.0}
    jw = {'jaw': 1.0}
    n_up = n_lo = 0
    for side in (1, -1):
        # ---- upper teeth: along the upper lip, pointing down into the jaw cavity
        cur = curve_points(lambda s: Vector((side * max(0.0, lip_w(s) - 0.075), s, zm(s) + 0.03)), S_TIP + 0.012, 0.2)
        for p in sample_along(cur, 0.155, 0.3):
            s = p.y
            if -3.0 < s < -2.2:
                L = rng.uniform(0.42, 0.62)
            elif s <= -3.0:
                L = rng.uniform(0.18, 0.3)
            else:
                L = lerp(0.36, 0.14, smoothstep(-2.2, 0.2, s)) * rng.uniform(0.65, 1.3)
            wo, wi, zr, zob, zib = jaw_params(s)
            L = min(L, 0.8 * (p.z - zib))
            d = Vector((-side * 0.28 + rng.uniform(-0.1, 0.1), 0.22 + rng.uniform(-0.1, 0.12), -1.0))
            ok = False
            for _ in range(8):
                tipp = p + d.normalized() * L * 1.05 + Vector((0, 0.1 * L, 0))
                if abs(tipp.x) < cavity_halfwidth(tipp.y, tipp.z) - 0.04 and L > 0.07:
                    ok = True
                    break
                L *= 0.82
            if not ok:
                continue
            rad = 0.03 + 0.07 * L
            mb.horn(p, d, L, rad, Vector((-side * 0.05, 0.12, 0.0)), 'hunter_teeth', tooth_col, up_w,
                    sides=5, segs=3, twist=rng.uniform(0, 6.28), embed=0.25)
            n_up += 1
        # ---- lower teeth: along the jaw rim, pointing up outside the upper lip
        def rim(s):
            wo, wi, zr, zob, zib = jaw_params(s)
            return Vector((side * 0.5 * (wo + wi), s, zr + 0.01))
        cur = curve_points(rim, S_CHIN + 0.03, 0.15)
        for p in sample_along(cur, 0.15, 0.3):
            s = p.y
            if s < -3.05:
                L = rng.uniform(0.45, 0.66)
                d = Vector((side * 0.12 + rng.uniform(-0.08, 0.08), -0.18, 1.0))
                bend = Vector((0, 0.22, 0))
            else:
                L = lerp(0.34, 0.13, smoothstep(-3.0, 0.15, s)) * rng.uniform(0.6, 1.35)
                if rng.random() < 0.12:
                    L *= 1.6
                d = Vector((side * 0.10 + rng.uniform(-0.08, 0.08), 0.15 + rng.uniform(-0.1, 0.1), 1.0))
                bend = Vector((side * 0.02, 0.14, 0))
            ok = False
            for _ in range(8):
                bad = False
                for f in (0.35, 0.7, 1.0):
                    q = p + d.normalized() * L * f + bend * L * f * f
                    if inside_upper_head(q.x, q.y, q.z, 0.05):
                        bad = True
                        break
                if not bad and L > 0.07:
                    ok = True
                    break
                L *= 0.82
            if not ok:
                continue
            rad = 0.03 + 0.07 * L
            mb.horn(p, d, L, rad, bend, 'hunter_teeth', tooth_col, jw, sides=5, segs=3,
                    twist=rng.uniform(0, 6.28), embed=0.25)
            n_lo += 1
    print(f'[hunter] teeth upper={n_up} lower={n_lo}')


# ---------------------------------------------------------------- eyes / photophores
def head_surface(s, th):
    x, z = dome_xz(s, th)
    return Vector((x, s, z))


def build_eyes(mb):
    col = srgb((0.93, 0.90, 0.70))
    for (es, eth, er) in EYES:
        p = head_surface(es, eth)
        e = 0.01
        dp_s = head_surface(es + e, eth) - head_surface(es - e, eth)
        dp_t = head_surface(es, eth + e) - head_surface(es, eth - e)
        n = dp_s.cross(dp_t).normalized()
        if n.dot(Vector((p.x, 0, p.z - zm(es)))) < 0:
            n = -n
        ax = dp_s.normalized()
        ay = n.cross(ax).normalized()
        c = p - n * (er * 0.35)
        mb.sphere(c, (er, er, er * 0.95), (ax, ay, n), 14, 8, 'hunter_eye', col, {'spine_00': 1.0})


def build_photophores(mb):
    col = srgb((0.6, 1.0, 0.95))
    spots = list(JAW_GLOW)
    for side in (1, -1):
        s = 4.2
        while s < 23.2:
            rr = R(s)
            th = side * (PI / 2 - 0.10)
            x, z = tube_xz(s, th)
            n = Vector((side * 1.0, 0, 0.1)).normalized()
            spots.append((Vector((x, s, z)), n, 0.03 + 0.03 * math.sqrt(rr / 1.7), spine_w(s)))
            s += 0.62 * (0.75 + 0.25 * rr / 1.7)
        s = 5.0
        while s < 19.5:
            rr = R(s)
            th = side * (PI / 2 + 0.95)
            x, z = tube_xz(s, th)
            n = Vector((x, 0, z)).normalized()
            spots.append((Vector((x, s, z)), n, 0.022 + 0.02 * math.sqrt(rr / 1.7), spine_w(s)))
            s += 0.9
    for (p, n, r, w) in spots:
        ax = Vector((0, 1, 0))
        ax = (ax - n * ax.dot(n)).normalized()
        ay = n.cross(ax)
        mb.sphere(p - n * r * 0.35, (r * 1.25, r, r), (ax, ay, n), 6, 3, 'hunter_glow', col, w)
    print(f'[hunter] photophores={len(spots)}')


# ---------------------------------------------------------------- fins
FIN_MEM = srgb((0.24, 0.29, 0.34))
FIN_RAY = srgb((0.58, 0.62, 0.64))
FIN_EDGE = srgb((0.16, 0.19, 0.23))
TEARS = [(15.2, 0.16, 0.55, 1), (21.3, 0.12, 0.4, 1), (18.4, 0.14, 0.5, -1)]


def build_median_fin(mb, sign, s0, hfun):
    ss = cc.stations([(s0, S_FIN_END, 0.09)])
    ray = 0.45
    NR = 5
    rows = []
    for s in ss:
        if s <= S_BODY_END:
            zb = (R(s) if sign > 0 else HB(s) * R(s)) - 0.06 * R(s)
        else:
            zb = 0.0
        h = hfun(s)
        top = zb + h
        if s > 24.9:
            u = (s - 24.9) / (S_FIN_END - 24.9)
            top = (R(24.9) + hfun(24.9)) * math.sqrt(max(0.0, 1 - u * u))
            top = max(top, zb + 0.02)
        rayph = math.cos(2 * PI * ((s - s0) / ray + 0.3 * math.sin(0.83 * s) + 0.15 * math.sin(2.1 * s)))
        edge = top - 0.12 * h * (1 - rayph) * 0.5 - 0.05 * h * (1 + N3(Vector((s * 1.3, 5.0, sign))))
        for (ts, tw, depth, tsign) in TEARS:
            if tsign == sign:
                edge -= depth * h * gauss((s - ts) / tw)
        edge = max(edge, zb + 0.03)
        row = []
        for j in range(NR + 1):
            v = j / NR
            z = lerp(zb, edge, v)
            x = 0.022 * rayph * v ** 0.7
            c = mix_col(FIN_MEM, FIN_RAY, 0.75 * smoothstep(0.55, 0.95, rayph))
            c = mix_col(c, FIN_EDGE, smoothstep(0.7, 1.0, v) * 0.5)
            c = mix_col(skin_color((0, s, sign * zb), 0.6 * sign), c, smoothstep(0.0, 0.25, v))
            row.append(mb.v((x, s, sign * z), c, spine_w(s)))
        rows.append(row)
    mb.loft(rows, False, 'hunter_fin')


FIN_ROOT_S = 3.95
FIN_INFO = {}


def build_pectorals(mb):
    NRAY = 7
    SUB = 3
    NRAD = 9
    lengths = [3.5, 3.25, 2.9, 2.45, 1.95, 1.5, 1.05]
    for side, bn in ((1, 'fin_L'), (-1, 'fin_R')):
        rr = R(FIN_ROOT_S)
        x0, z0 = tube_xz(FIN_ROOT_S, side * (PI / 2 + 0.42))
        root = Vector((x0 - side * 0.06, FIN_ROOT_S, z0))
        d0 = Vector((side * 0.80, 0.38, -0.30)).normalized()
        d1 = Vector((side * 0.20, 0.96, -0.10)).normalized()
        nrm = d0.cross(d1).normalized()
        if nrm.z < 0:
            nrm = -nrm
        dmid = (d0 + d1).normalized()
        FIN_INFO[bn] = (root.copy(), dmid.copy())
        cols = []
        NA = (NRAY - 1) * SUB
        for a in range(NA + 1):
            f = a / NA
            ri = a // SUB
            fr = (a % SUB) / SUB
            if ri >= NRAY - 1:
                ri, fr = NRAY - 2, 1.0
            L = lerp(lengths[ri], lengths[ri + 1], fr) * (1 - 0.16 * math.sin(PI * fr))
            dirv = d0.slerp(d1, f) if hasattr(d0, 'slerp') else (d0.lerp(d1, f)).normalized()
            base = root + Vector((0, 0.13 * a / SUB, 0.0))
            is_ray = (a % SUB) == 0
            col = []
            for i in range(NRAD + 1):
                u = i / NRAD
                r = L * u
                p = base + dirv * r + nrm * (0.18 * math.sin(PI * u) * (0.3 + f)) \
                    + nrm * (0.02 if is_ray else 0.0) * u
                c = mix_col(FIN_MEM, FIN_RAY, 0.8 if is_ray else 0.0)
                c = mix_col(c, FIN_EDGE, smoothstep(0.75, 1.0, u) * 0.5)
                c = mix_col(skin_color((p.x, p.y, p.z), 0.0), c, smoothstep(0.0, 0.2, u))
                wf = smoothstep(0.02, 0.45, r)
                w = cc.blend_weights(spine_w(base.y), {bn: 1.0}, wf)
                col.append(mb.v(p, c, w))
            cols.append(col)
        mb.loft(cols, False, 'hunter_fin')


# ---------------------------------------------------------------- materials / rig
MOUTH_LIP = srgb((0.36, 0.07, 0.08))
MOUTH_DEEP = srgb((0.045, 0.006, 0.01))


def mouth_color(co, _col):
    """wet dark-red flesh fading to near black down the throat."""
    x, s, z = co
    t = smoothstep(-2.9, 0.6, s)
    c = mix_col(MOUTH_LIP, MOUTH_DEEP, t ** 0.8)
    f = 1.0 + 0.3 * N3(Vector((x * 3.0, s * 5.0, z * 3.0)))        # rugae-like streaks
    return (c[0] * f, c[1] * f, c[2] * f, 1.0)


def make_materials():
    # every material reads the 'Color' attribute (-> glTF COLOR_0, baseColorFactor 1) so the
    # three.js result (baseColorFactor * COLOR_0) matches the Blender preview exactly.
    cc.make_material('hunter_skin', base=(1, 1, 1, 1), rough=0.45, vcol='Color', spec=0.45)
    cc.make_material('hunter_mouth', base=(1, 1, 1, 1), rough=0.3, vcol='Color', double_sided=True)
    cc.make_material('hunter_teeth', base=(1, 1, 1, 1), rough=0.32, vcol='Color')
    cc.make_material('hunter_eye', base=(1, 1, 1, 1), rough=0.15, vcol='Color',
                     emission=srgb((1.0, 0.93, 0.66)), strength=2.5)
    cc.make_material('hunter_glow', base=(1, 1, 1, 1), rough=0.3, vcol='Color',
                     emission=srgb((0.25, 1.0, 0.88)), strength=4.0)
    cc.make_material('hunter_fin', base=(1, 1, 1, 1), rough=0.55, vcol='Color', alpha=0.82, double_sided=True)


def make_rig():
    """All bones point Blender +Z (roll 0): bone axes X=+X, Y=+Z(up), Z=-Y(forward), which the
    +Y-up glTF conversion turns into an IDENTITY rest rotation for every joint in three.js."""
    up = (0, 0, 0.6)

    def b(name, head, parent=None):
        return dict(name=name, head=tuple(head), tail=tuple(Vector(head) + Vector(up)), parent=parent)

    bones = [b(SPINE[i], (0, i * SP, 0), SPINE[i - 1] if i else None) for i in range(NSP)]
    bones.append(b('jaw', (0, HINGE_S, HINGE_Z), 'spine_00'))
    for bn in ('fin_L', 'fin_R'):
        bones.append(b(bn, FIN_INFO[bn][0], 'spine_03'))
    return cc.make_armature('hunter_rig', bones)


# ---------------------------------------------------------------- animation
RIG = None


def fin_q(side, flap, sweep):
    q = cc.axis_angle((0, 1, 0), -side * flap) @ cc.axis_angle((0, 0, 1), side * sweep)
    return cc.arm_rot_to_local(RIG, 'fin_L' if side > 0 else 'fin_R', q)


def jaw_q(deg):
    return cc.arm_rot_to_local(RIG, 'jaw', cc.axis_angle((1, 0, 0), math.radians(deg)))


def swim_pose(t, T=2.0):
    rots = {}
    lam = 15.5
    w = 2 * PI * t / T

    def lat(s):
        amp = 0.16 + 1.35 * (max(s, 0.0) / 26.0) ** 1.5
        return amp * math.sin(2 * PI * s / lam - w)

    prev = 0.0
    for i in range(NSP):
        phi = math.atan2(lat((i + 1) * SP) - lat(i * SP), SP)
        rots[SPINE[i]] = cc.arm_rot_to_local(RIG, SPINE[i], cc.axis_angle((0, 0, 1), -(phi - prev)))
        prev = phi
    rots['jaw'] = jaw_q(4 + 3 * math.sin(w))
    for side in (1, -1):
        rots['fin_L' if side > 0 else 'fin_R'] = fin_q(side, math.radians(20) * math.sin(w + 0.6 * side),
                                                        math.radians(12) * math.sin(w + PI / 2))
    return rots


def idle_pose(t, T=3.0):
    w = 2 * PI * t / T
    rots = {'jaw': jaw_q(1.0 + 8.0 * (0.5 - 0.5 * math.cos(w)))}
    for side in (1, -1):
        rots['fin_L' if side > 0 else 'fin_R'] = fin_q(side, math.radians(7) * math.sin(w + side * 0.8),
                                                        math.radians(5) * math.sin(w + 1.3))
    return rots


def ease_out(x):
    x = clamp(x, 0, 1)
    return 1 - (1 - x) ** 3


def ease_in(x):
    x = clamp(x, 0, 1)
    return x ** 3


def ease_io(x):
    x = clamp(x, 0, 1)
    return x * x * (3 - 2 * x)


def bite_pose(t):
    if t < 0.16:
        a = 58 * ease_out(t / 0.16)
    elif t < 0.24:
        a = 58 + 3 * math.sin(PI * (t - 0.16) / 0.08)
    elif t < 0.36:
        a = 58 * (1 - ease_in((t - 0.24) / 0.12))
    elif t < 0.5:
        a = 4 * math.sin(PI * (t - 0.36) / 0.14)
    else:
        a = 0.0
    k = smoothstep(0.0, 0.16, t) * (1 - smoothstep(0.34, 0.6, t))
    rots = {'jaw': jaw_q(a)}
    for side in (1, -1):
        rots['fin_L' if side > 0 else 'fin_R'] = fin_q(side, math.radians(-8) * k, math.radians(22) * k)
    return rots


def roar_pose(t):
    if t < 0.4:
        a = 56 * ease_out(t / 0.4)
    elif t < 1.55:
        a = 56
    else:
        a = 56 * (1 - ease_io((t - 1.55) / 0.45))
    tremble = smoothstep(0.3, 0.45, t) * (1 - smoothstep(1.45, 1.6, t))
    a += tremble * (2.6 * math.sin(2 * PI * 11 * t) + 1.4 * math.sin(2 * PI * 17.3 * t + 1.0))
    flare = ease_io(t / 0.4) * (1 - ease_io((t - 1.5) / 0.5))
    rots = {'jaw': jaw_q(max(0.0, a))}
    for side in (1, -1):
        vib = tremble * math.radians(3) * math.sin(2 * PI * 9 * t + side)
        rots['fin_L' if side > 0 else 'fin_R'] = fin_q(side, math.radians(26) * flare + vib, math.radians(-24) * flare)
    return rots


# ---------------------------------------------------------------- main
def main():
    global RIG
    cc.reset_scene()
    make_materials()
    mb = cc.MeshBuilder(MATS)
    build_body(mb)
    build_jaw(mb)
    build_membranes(mb)
    build_teeth(mb)
    build_eyes(mb)
    build_photophores(mb)
    build_median_fin(mb, 1, 8.3, lambda s: 0.62 * smoothstep(8.3, 12.5, s) + 0.30 * smoothstep(19.0, 24.5, s))
    build_median_fin(mb, -1, 10.8, lambda s: 0.46 * smoothstep(10.8, 14.5, s) + 0.36 * smoothstep(19.0, 24.5, s))
    build_pectorals(mb)
    print(f'[hunter] verts={len(mb.V)} faces={len(mb.F)} tris~={sum(len(f) - 2 for f in mb.F)}')
    RIG = make_rig()
    body = mb.build('hunter_body', BONES, mat_colors={'hunter_mouth': mouth_color})
    cc.attach_mesh(body, RIG)

    if RENDER:
        os.makedirs(PREV, exist_ok=True)
        cc.setup_render()
        cc.apply_pose(RIG, {})
        cc.render_view(os.path.join(PREV, 'hunter_side.png'), (60, 11.3, 0.3), (0, 11.3, 0.3), res=(1920, 720),
                       ortho=31.5)
        cc.apply_pose(RIG, roar_pose(0.9))
        cc.render_view(os.path.join(PREV, 'hunter_front34_open.png'), (8.0, -10.5, 2.6), (0.0, -0.4, -0.6),
                       res=(1600, 1000), lens=38)
        cc.render_view(os.path.join(PREV, 'hunter_head_side_open.png'), (11.0, -0.8, -0.4), (0.0, -0.8, -0.6),
                       res=(1600, 1000), lens=42)
        cc.apply_pose(RIG, {})
        cc.render_view(os.path.join(PREV, 'hunter_head_closed.png'), (7.5, -8.5, 3.2), (0.0, -0.4, -0.3),
                       res=(1600, 1000), lens=40)
        cc.apply_pose(RIG, swim_pose(0.5))
        cc.render_view(os.path.join(PREV, 'hunter_top_swim.png'), (0, 11.3, 60), (0, 11.3, 0), res=(1920, 900),
                       ortho=32.0, rot=(0.0, 0.0, PI / 2))
        cc.apply_pose(RIG, {})
        cc.remove_render_objects()

    cc.bake_action(RIG, 'Swim', 2.0, swim_pose, BONES)
    cc.bake_action(RIG, 'Idle', 3.0, idle_pose, ['jaw', 'fin_L', 'fin_R'])
    cc.bake_action(RIG, 'Bite', 0.7, bite_pose, ['jaw', 'fin_L', 'fin_R'])
    cc.bake_action(RIG, 'Roar', 2.0, roar_pose, ['jaw', 'fin_L', 'fin_R'])
    cc.export_glb(OUT, RIG)
    print('[hunter] exported', OUT, os.path.getsize(OUT))


main()
