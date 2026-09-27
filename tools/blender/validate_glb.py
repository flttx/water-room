"""Inspect a GLB (JSON chunk only + accessor min/max) and print a validation report.

Usage: python tools/blender/validate_glb.py public/models/hunter.glb [more.glb ...]
Exit code 1 if a hard check fails.
"""
import json
import math
import os
import struct
import sys

COMP = {5120: 'b', 5121: 'B', 5122: 'h', 5123: 'H', 5125: 'I', 5126: 'f'}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def load(path):
    with open(path, 'rb') as fh:
        data = fh.read()
    magic, ver, length = struct.unpack_from('<4sII', data, 0)
    assert magic == b'glTF' and ver == 2, 'not a glTF 2 binary'
    off = 12
    js, binc = None, None
    while off < length:
        clen, ctype = struct.unpack_from('<II', data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(chunk.decode('utf-8'))
        elif ctype == 0x004E4942:
            binc = chunk
        off += 8 + clen
    return js, binc


def read_acc(g, binc, idx):
    a = g['accessors'][idx]
    bv = g['bufferViews'][a['bufferView']]
    n = NCOMP[a['type']]
    fmt = COMP[a['componentType']]
    size = struct.calcsize(fmt)
    stride = bv.get('byteStride', size * n)
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    out = []
    for i in range(a['count']):
        out.append(struct.unpack_from('<' + fmt * n, binc, base + i * stride))
    return out


# ---- quaternion / matrix helpers (glTF: quat = x,y,z,w; column-major 4x4)
def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def qrot(q, v):
    p = qmul(qmul(q, (v[0], v[1], v[2], 0.0)), (-q[0], -q[1], -q[2], q[3]))
    return p[:3]


def world_trs(g):
    parent = {}
    for i, n in enumerate(g['nodes']):
        for c in n.get('children', []):
            parent[c] = i
    cache = {}

    def get(i):
        if i in cache:
            return cache[i]
        n = g['nodes'][i]
        t = n.get('translation', [0, 0, 0])
        r = n.get('rotation', [0, 0, 0, 1])
        s = n.get('scale', [1, 1, 1])
        if 'matrix' in n:
            raise RuntimeError('matrix nodes not supported')
        if i in parent:
            pt, pr, ps = get(parent[i])
            ts = (t[0] * ps[0], t[1] * ps[1], t[2] * ps[2])
            wt = tuple(pt[k] + qrot(pr, ts)[k] for k in range(3))
            wr = qmul(pr, r)
            wsc = tuple(ps[k] * s[k] for k in range(3))
        else:
            wt, wr, wsc = tuple(t), tuple(r), tuple(s)
        cache[i] = (wt, wr, wsc)
        return cache[i]

    return get, parent


def report(path):
    g, binc = load(path)
    ok = True
    name = os.path.basename(path)
    print(f'==== {name}  ({os.path.getsize(path)} bytes)')
    nodes = g['nodes']
    get, parent = world_trs(g)
    print('nodes:', ', '.join(f"{i}:{n.get('name')}" for i, n in enumerate(nodes)))
    for r in g['scenes'][g.get('scene', 0)]['nodes']:
        n = nodes[r]
        print(f"  scene root '{n.get('name')}': T={n.get('translation', [0, 0, 0])} R={n.get('rotation', [0, 0, 0, 1])}"
              f" S={n.get('scale', [1, 1, 1])}")
    nonid = [n.get('name') for n in nodes if 'rotation' in n and max(abs(c) for c in n['rotation'][:3]) > 1e-5]
    print('  nodes with non-identity local rest rotation:', nonid or 'none')
    print('materials:', [m.get('name') for m in g.get('materials', [])])
    for m in g.get('materials', []):
        pbr = m.get('pbrMetallicRoughness', {})
        extra = []
        if m.get('alphaMode'):
            extra.append(f"alphaMode={m['alphaMode']}")
        if m.get('doubleSided'):
            extra.append('doubleSided')
        if 'emissiveFactor' in m:
            st = m.get('extensions', {}).get('KHR_materials_emissive_strength', {}).get('emissiveStrength', 1.0)
            extra.append(f"emissive={[round(c, 3) for c in m['emissiveFactor']]}x{st}")
        print(f"  {m.get('name')}: baseColor={[round(c, 3) for c in pbr.get('baseColorFactor', [1, 1, 1, 1])]}"
              f" rough={pbr.get('roughnessFactor', 1.0)} metal={pbr.get('metallicFactor', 1.0)} {' '.join(extra)}")

    tris = 0
    skinned = 0
    bmin = [1e9] * 3
    bmax = [-1e9] * 3
    for ni, n in enumerate(nodes):
        if 'mesh' not in n:
            continue
        mesh = g['meshes'][n['mesh']]
        if 'skin' in n:
            skinned += 1
        print(f"mesh node '{n.get('name')}' mesh='{mesh.get('name')}' skin={n.get('skin')}")
        for pi, p in enumerate(mesh['primitives']):
            mode = p.get('mode', 4)
            if 'indices' in p:
                cnt = g['accessors'][p['indices']]['count']
            else:
                cnt = g['accessors'][p['attributes']['POSITION']]['count']
            t = cnt // 3 if mode == 4 else 0
            tris += t
            pa = g['accessors'][p['attributes']['POSITION']]
            for k in range(3):
                bmin[k] = min(bmin[k], pa['min'][k])
                bmax[k] = max(bmax[k], pa['max'][k])
            mat = g['materials'][p['material']]['name'] if 'material' in p else None
            print(f"  prim{pi}: mat={mat} tris={t} verts={pa['count']} attrs={sorted(p['attributes'].keys())}")
            if 'JOINTS_1' in p['attributes']:
                print('  !! more than 4 influences exported')
                ok = False
    print(f'total triangles: {tris}   skinned mesh nodes: {skinned}')
    print('bbox (accessor min/max, mesh local == three.js space when node TRS identity):')
    print(f'  min {[round(v, 3) for v in bmin]}  max {[round(v, 3) for v in bmax]}'
          f'  size {[round(bmax[k] - bmin[k], 3) for k in range(3)]}')

    # skins
    for si, sk in enumerate(g.get('skins', [])):
        joints = [nodes[j].get('name') for j in sk['joints']]
        print(f'skin {si}: {len(joints)} joints: {joints}')
        ibm = read_acc(g, binc, sk['inverseBindMatrices']) if 'inverseBindMatrices' in sk else None
        spines = [j for j in sk['joints'] if nodes[j].get('name', '').startswith('spine_')]
        print('  rest joint world positions (three.js space):')
        for j in sk['joints']:
            wt, wr, _ = get(j)
            nm = nodes[j].get('name')
            print(f"    {nm:9s} pos=({wt[0]:+.3f}, {wt[1]:+.3f}, {wt[2]:+.3f})  "
                  f"worldrot=({wr[0]:+.3f},{wr[1]:+.3f},{wr[2]:+.3f},{wr[3]:+.3f})")
        # spine chain checks
        prev = None
        for j in spines:
            wt, wr, _ = get(j)
            if prev is not None:
                d = math.dist(prev, wt)
                if abs(d - (math.dist(get(spines[0])[0], get(spines[1])[0]))) > 1e-3:
                    print(f'  !! non-uniform spine spacing at {nodes[j]["name"]}: {d:.4f}')
                    ok = False
            prev = wt
        # inverse bind sanity: IBM * joint world == identity (translation part)
        if ibm:
            worst = 0.0
            for k, j in enumerate(sk['joints']):
                m = ibm[k]
                wt, wr, _ = get(j)
                # apply IBM (column-major) to joint world origin -> should be ~0
                x = m[0] * wt[0] + m[4] * wt[1] + m[8] * wt[2] + m[12]
                y = m[1] * wt[0] + m[5] * wt[1] + m[9] * wt[2] + m[13]
                z = m[2] * wt[0] + m[6] * wt[1] + m[10] * wt[2] + m[14]
                worst = max(worst, abs(x), abs(y), abs(z))
            print(f'  IBM consistency (max |IBM*jointOrigin|): {worst:.2e}')
            if worst > 1e-3:
                ok = False

    # animations
    for a in g.get('animations', []):
        dur = 0.0
        tgt = {}
        for ch in a['channels']:
            smp = a['samplers'][ch['sampler']]
            inp = g['accessors'][smp['input']]
            dur = max(dur, inp['max'][0])
            nn = nodes[ch['target']['node']].get('name')
            tgt.setdefault(nn, []).append(ch['target']['path'])
        keys = g['accessors'][a['samplers'][0]['input']]['count'] if a['samplers'] else 0
        print(f"anim '{a.get('name')}': duration={dur:.4f}s channels={len(a['channels'])} keys/ch~{keys}")
        print('   targets:', ', '.join(f"{k}[{'/'.join(v)}]" for k, v in tgt.items()))

    # head direction: vertex with max z should be near the snout (small |x|), tail at min z
    print(f'head check: bbox max z = {bmax[2]:+.3f} (snout), min z = {bmin[2]:+.3f} (tail) ->',
          'HEAD +Z OK' if bmax[2] > 0 > bmin[2] and abs(bmax[2]) < abs(bmin[2]) else 'CHECK')
    if not (bmax[2] > 0 > bmin[2]):
        ok = False
    return ok


def main():
    paths = sys.argv[1:]
    good = True
    for p in paths:
        good &= report(p)
        print()
    sys.exit(0 if good else 1)


if __name__ == '__main__':
    main()
