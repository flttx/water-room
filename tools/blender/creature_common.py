"""Shared helpers for the procedural creature generators (Blender 5.2, headless).

Geometry is accumulated in plain Python lists (MeshBuilder) and turned into a
single skinned mesh at the end. Everything is deterministic.

Axis convention (Blender space): head faces -Y, body extends to +Y, up +Z.
glTF export (+Y up) maps Blender (x, y, z) -> three.js (x, z, -y), so the
head ends up facing three.js +Z.
"""
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

FPS = 30


# --------------------------------------------------------------------------
# small math helpers
# --------------------------------------------------------------------------
def clamp(x, a, b):
    return a if x < a else b if x > b else x


def lerp(a, b, t):
    return a + (b - a) * t


def lerp3(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def smoothstep(e0, e1, x):
    if e1 == e0:
        return 1.0 if x >= e1 else 0.0
    t = clamp((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def gauss(x):
    return math.exp(-x * x)


def spow(x, p):
    """sign-preserving power"""
    return math.copysign(abs(x) ** p, x)


def srgb(c):
    """sRGB (0..1) tuple -> linear RGBA"""
    out = []
    for v in c[:3]:
        v = clamp(v, 0.0, 1.0)
        out.append(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4)
    return (out[0], out[1], out[2], 1.0)


def mix_col(a, b, t):
    t = clamp(t, 0.0, 1.0)
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(4))


def spline(table, x):
    """Cubic Hermite through (x, y) points with finite-difference tangents."""
    n = len(table)
    if x <= table[0][0]:
        return table[0][1]
    if x >= table[-1][0]:
        return table[-1][1]
    i = 0
    while i < n - 2 and x > table[i + 1][0]:
        i += 1
    x0, y0 = table[i]
    x1, y1 = table[i + 1]
    h = x1 - x0
    t = (x - x0) / h

    def tang(j):
        if j == 0:
            return (table[1][1] - table[0][1]) / (table[1][0] - table[0][0])
        if j == n - 1:
            return (table[-1][1] - table[-2][1]) / (table[-1][0] - table[-2][0])
        return (table[j + 1][1] - table[j - 1][1]) / (table[j + 1][0] - table[j - 1][0])

    m0, m1 = tang(i), tang(i + 1)
    t2, t3 = t * t, t * t * t
    return ((2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m0
            + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m1)


def nose(s, tip, start):
    """Elliptic nose falloff: 1 at s>=start, 0 at s==tip (tip < start)."""
    if s >= start:
        return 1.0
    u = (s - start) / (tip - start)
    return math.sqrt(max(0.0, 1.0 - u * u))


def stations(segments):
    """segments: list of (s0, s1, ds[, cluster]) -> sorted unique station list.
    cluster='start' packs stations towards s0 (cosine)."""
    out = []
    for seg in segments:
        s0, s1, ds = seg[:3]
        mode = seg[3] if len(seg) > 3 else None
        n = max(1, int(round(abs(s1 - s0) / ds)))
        for k in range(n + 1):
            u = k / n
            if mode == 'start':
                u = 1.0 - math.cos(u * math.pi / 2)
            out.append(s0 + (s1 - s0) * u)
    out.sort()
    res = []
    for s in out:
        if not res or abs(s - res[-1]) > 1e-4:
            res.append(s)
    return res


def bspline2(u):
    u = abs(u)
    if u <= 0.5:
        return 0.75 - u * u
    if u <= 1.5:
        return 0.5 * (1.5 - u) ** 2
    return 0.0


def chain_weights(s, n, spacing, prefix='spine_'):
    """Smooth (quadratic B-spline) weights over a uniform bone chain along s.
    Bone i spans [i*spacing, (i+1)*spacing]; kernels centred at bone mid points."""
    u = s / spacing - 0.5
    base = int(math.floor(u))
    w = {}
    for i in range(base - 1, base + 3):
        b = bspline2(u - i)
        if b <= 1e-6:
            continue
        j = min(max(i, 0), n - 1)
        name = f'{prefix}{j:02d}'
        w[name] = w.get(name, 0.0) + b
    return w


def blend_weights(wa, wb, t):
    out = {}
    for k, v in wa.items():
        out[k] = out.get(k, 0.0) + v * (1.0 - t)
    for k, v in wb.items():
        out[k] = out.get(k, 0.0) + v * t
    return out


def finalize_weights(w, maxn=4):
    items = sorted(((v, k) for k, v in w.items() if v > 1e-4), reverse=True)[:maxn]
    tot = sum(v for v, _ in items)
    if tot <= 0:
        return {}
    return {k: v / tot for v, k in items}


# --------------------------------------------------------------------------
# mesh builder
# --------------------------------------------------------------------------
class MeshBuilder:
    def __init__(self, material_names):
        self.materials = list(material_names)
        self.mat_index = {n: i for i, n in enumerate(self.materials)}
        self.V = []
        self.C = []
        self.W = []
        self.F = []
        self.FM = []
        self.sharp = []

    def v(self, co, col=(1.0, 1.0, 1.0, 1.0), w=None):
        self.V.append((float(co[0]), float(co[1]), float(co[2])))
        self.C.append(col)
        self.W.append(w or {})
        return len(self.V) - 1

    def f(self, idx, mat):
        self.F.append(tuple(idx))
        self.FM.append(self.mat_index[mat])

    def loft(self, rings, closed=True, mat=None, matfn=None):
        """rings: list of equal-length vertex index lists."""
        for i in range(len(rings) - 1):
            a, b = rings[i], rings[i + 1]
            n = len(a)
            for k in range(n if closed else n - 1):
                k2 = (k + 1) % n
                m = matfn(i, k) if matfn else mat
                self.f((a[k], a[k2], b[k2], b[k]), m)

    def fan(self, ring, center, mat):
        n = len(ring)
        for k in range(n):
            self.f((ring[k], ring[(k + 1) % n], center), mat)

    # ---------------- primitives ----------------
    def sphere(self, center, radii, frame, seg, rings, mat, col, w, squash_back=0.0):
        """UV ellipsoid. frame = (ax, ay, az) orthonormal Vectors; az = pole axis."""
        ax, ay, az = frame
        c = Vector(center)
        top = self.v(c + az * radii[2], col, w)
        rows = []
        for r in range(1, rings):
            ph = math.pi * r / rings
            z = math.cos(ph)
            rr = math.sin(ph)
            if z < 0:
                z *= (1.0 - squash_back)
            row = []
            for k in range(seg):
                a = 2 * math.pi * k / seg
                p = c + ax * (rr * math.cos(a) * radii[0]) + ay * (rr * math.sin(a) * radii[1]) + az * (z * radii[2])
                row.append(self.v(p, col, w))
            rows.append(row)
        bot = self.v(c - az * radii[2] * (1.0 - squash_back), col, w)
        for k in range(seg):
            self.f((top, rows[0][(k + 1) % seg], rows[0][k]), mat)
        self.loft(rows, True, mat)
        for k in range(seg):
            self.f((bot, rows[-1][k], rows[-1][(k + 1) % seg]), mat)

    def horn(self, base, direction, length, radius, bend, mat, col_fn, w, sides=5, segs=4, twist=0.0,
             embed=0.15, flat=1.0):
        """Curved tapered cone (tooth / spike / knob). bend: Vector added * L * u^2."""
        d = Vector(direction).normalized()
        bend = Vector(bend)
        ref = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
        e1 = d.cross(ref).normalized()
        e2 = d.cross(e1).normalized()
        b = Vector(base)
        rings = []
        us = [-embed] + [k / segs for k in range(segs)]
        for j, u in enumerate(us):
            uc = max(u, 0.0)
            cp = b + d * (length * u) + bend * (length * uc * uc)
            r = radius * (1.0 - clamp(u, 0.0, 1.0)) ** 0.85 if u > 0 else radius
            ring = []
            for k in range(sides):
                a = 2 * math.pi * k / sides + twist
                p = cp + e1 * (math.cos(a) * r) + e2 * (math.sin(a) * r * flat)
                ring.append(self.v(p, col_fn(u), w))
            rings.append(ring)
        tip = self.v(b + d * length + bend * length, col_fn(1.0), w)
        bc = self.v(b - d * (length * embed), col_fn(0.0), w)
        self.loft(rings, True, mat)
        self.fan(rings[-1], tip, mat)
        self.fan(list(reversed(rings[0])), bc, mat)

    # ---------------- build ----------------
    def build(self, name, bone_names, color_name='Color', mat_colors=None):
        """mat_colors: {material_name: fn(co, vertex_col) -> rgba} overrides the colour of every
        face corner that uses that material (colours are stored per corner, linear float)."""
        mat_colors = mat_colors or {}
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.V, [], self.F)
        me.update(calc_edges=True)
        for mname in self.materials:
            me.materials.append(bpy.data.materials[mname])
        me.polygons.foreach_set('material_index', self.FM)
        me.polygons.foreach_set('use_smooth', [True] * len(self.F))

        # consistent outward normals per connected piece
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()

        # sharp edges
        if self.sharp:
            key = {}
            for e in me.edges:
                a, b = e.vertices
                key[(min(a, b), max(a, b))] = e.index
            attr = me.attributes.get('sharp_edge') or me.attributes.new('sharp_edge', 'BOOLEAN', 'EDGE')
            vals = [False] * len(me.edges)
            for a, b in self.sharp:
                idx = key.get((min(a, b), max(a, b)))
                if idx is not None:
                    vals[idx] = True
            attr.data.foreach_set('value', vals)

        # vertex colours (linear float, face-corner domain so materials can override per face)
        nl, npoly = len(me.loops), len(me.polygons)
        lv = [0] * nl
        me.loops.foreach_get('vertex_index', lv)
        pm, ls, lt = [0] * npoly, [0] * npoly, [0] * npoly
        me.polygons.foreach_get('material_index', pm)
        me.polygons.foreach_get('loop_start', ls)
        me.polygons.foreach_get('loop_total', lt)
        flat = [0.0] * (4 * nl)
        cache = {}
        for pi in range(npoly):
            fn = mat_colors.get(self.materials[pm[pi]])
            for li in range(ls[pi], ls[pi] + lt[pi]):
                vi = lv[li]
                if fn is None:
                    c = self.C[vi]
                else:
                    c = cache.get((vi, pm[pi]))
                    if c is None:
                        c = cache[(vi, pm[pi])] = fn(self.V[vi], self.C[vi])
                flat[4 * li:4 * li + 4] = (c[0], c[1], c[2], c[3] if len(c) > 3 else 1.0)
        ca = me.color_attributes.new(color_name, 'FLOAT_COLOR', 'CORNER')
        ca.data.foreach_set('color', flat)
        me.color_attributes.active_color = ca
        try:
            me.color_attributes.render_color_index = me.color_attributes.find(color_name)
        except Exception:
            pass
        me.validate(clean_customdata=False)
        me.update()

        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        groups = {bn: ob.vertex_groups.new(name=bn) for bn in bone_names}
        # batch by (bone, weight) to limit API calls
        buckets = {}
        for vi, w in enumerate(self.W):
            fw = finalize_weights(w)
            if not fw:
                raise RuntimeError(f'vertex {vi} of {name} has no weights')
            for bn, val in fw.items():
                buckets.setdefault((bn, round(val, 5)), []).append(vi)
        for (bn, val), idxs in buckets.items():
            groups[bn].add(idxs, val, 'REPLACE')
        return ob


# --------------------------------------------------------------------------
# scene / materials / armature
# --------------------------------------------------------------------------
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = FPS
    sc.frame_start = 0
    sc.frame_end = 60


def make_material(name, base=(0.8, 0.8, 0.8, 1.0), rough=0.5, metallic=0.0, vcol=None,
                  emission=None, strength=0.0, alpha=1.0, double_sided=False, spec=0.5):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = base
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metallic
    if 'Specular IOR Level' in bsdf.inputs:
        bsdf.inputs['Specular IOR Level'].default_value = spec
    if vcol:
        vc = nt.nodes.new('ShaderNodeVertexColor')
        vc.layer_name = vcol
        vc.location = (-400, 200)
        nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])
    if emission is not None:
        bsdf.inputs['Emission Color'].default_value = emission
        bsdf.inputs['Emission Strength'].default_value = strength
    if alpha < 1.0:
        bsdf.inputs['Alpha'].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            pass
    m.use_backface_culling = not double_sided
    m.diffuse_color = base
    return m


def make_armature(name, bones):
    """bones: list of dict(name, head, tail, parent, connect)."""
    arm = bpy.data.armatures.new(name + '_data')
    ob = bpy.data.objects.new(name, arm)
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.edit_bones
    for b in bones:
        e = eb.new(b['name'])
        e.head = Vector(b['head'])
        e.tail = Vector(b['tail'])
        e.roll = b.get('roll', 0.0)
        e.use_deform = True
    for b in bones:
        if b.get('parent'):
            e = eb[b['name']]
            e.parent = eb[b['parent']]
            e.use_connect = bool(b.get('connect', False))
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in ob.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    return ob


def attach_mesh(mesh_ob, arm_ob):
    mesh_ob.parent = arm_ob
    mod = mesh_ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm_ob
    mod.use_vertex_groups = True


def arm_rot_to_local(arm_ob, bone_name, q_arm):
    """Rotation given in armature (rest) space about the bone head -> pose basis."""
    r = arm_ob.data.bones[bone_name].matrix_local.to_3x3().to_quaternion()
    return r.inverted() @ q_arm @ r


def axis_angle(axis, ang):
    return Quaternion(Vector(axis).normalized(), ang)


def reset_pose(arm_ob):
    for pb in arm_ob.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)


def apply_pose(arm_ob, rots):
    reset_pose(arm_ob)
    for bn, q in rots.items():
        arm_ob.pose.bones[bn].rotation_quaternion = q
    bpy.context.view_layer.update()


def bake_action(arm_ob, name, duration, pose_fn, bones):
    """Key rotation_quaternion of `bones` every frame from pose_fn(t)->{bone: Quaternion}
    and push the action onto its own NLA track named `name`."""
    ad = arm_ob.animation_data or arm_ob.animation_data_create()
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    ad.action = act
    nframes = int(round(duration * FPS))
    prev = {}
    for f in range(nframes + 1):
        t = f / FPS
        rots = pose_fn(t)
        for bn in bones:
            pb = arm_ob.pose.bones[bn]
            q = rots.get(bn, Quaternion()).copy()
            if bn in prev and prev[bn].dot(q) < 0:
                q.negate()
            prev[bn] = q
            pb.rotation_quaternion = q
            pb.keyframe_insert('rotation_quaternion', frame=f, group=bn)
    ad.action = None
    track = ad.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 0, act)
    strip.name = name
    reset_pose(arm_ob)
    return act


def export_glb(path, arm_ob):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for tr in arm_ob.animation_data.nla_tracks:
        tr.mute = False
        tr.is_solo = False
    reset_pose(arm_ob)
    bpy.context.scene.frame_set(0)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials='EXPORT',
        export_vertex_color='MATERIAL',
        export_all_vertex_colors=False,
        export_image_format='AUTO',  # 'NONE' also disables vertex-colour detection
        export_skins=True,
        export_influence_nb=4,
        export_def_bones=False,
        export_leaf_bone=False,
        export_rest_position_armature=True,
        export_animations=True,
        export_animation_mode='NLA_TRACKS',
        export_force_sampling=True,
        export_optimize_animation_size=True,
        export_optimize_animation_keep_anim_armature=False,
        export_reset_pose_bones=True,
        export_anim_slide_to_zero=True,
        export_morph=False,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
    )


# --------------------------------------------------------------------------
# preview rendering
# --------------------------------------------------------------------------
_render_objs = []


def setup_render(bg=(0.035, 0.05, 0.065), key=4.0):
    sc = bpy.context.scene
    try:
        sc.render.engine = 'BLENDER_EEVEE'
    except Exception:
        sc.render.engine = 'BLENDER_EEVEE_NEXT'
    try:
        sc.eevee.taa_render_samples = 32
    except Exception:
        pass
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'AgX'
    world = bpy.data.worlds.new('preview_world')
    world.use_nodes = True
    bgn = world.node_tree.nodes.get('Background')
    bgn.inputs['Color'].default_value = (bg[0], bg[1], bg[2], 1.0)
    bgn.inputs['Strength'].default_value = 1.0
    sc.world = world

    def light(name, kind, energy, loc, rot, size=None, color=(1, 1, 1)):
        ld = bpy.data.lights.new(name, kind)
        ld.energy = energy
        ld.color = color
        if size is not None:
            ld.size = size
        ob = bpy.data.objects.new(name, ld)
        ob.location = loc
        ob.rotation_euler = rot
        sc.collection.objects.link(ob)
        _render_objs.append(ob)
        return ob

    light('key', 'SUN', key, (0, 0, 30), (math.radians(35), math.radians(-25), math.radians(20)),
          color=(0.95, 0.97, 1.0))
    light('fill', 'SUN', key * 0.35, (0, 0, -30), (math.radians(150), math.radians(30), math.radians(-120)),
          color=(0.55, 0.75, 0.9))
    light('rim', 'SUN', key * 0.5, (0, 0, 30), (math.radians(-60), 0, math.radians(180)),
          color=(0.7, 0.9, 1.0))
    cam_data = bpy.data.cameras.new('preview_cam')
    cam = bpy.data.objects.new('preview_cam', cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    _render_objs.append(cam)
    return cam


def render_view(path, cam_loc, target, res=(1600, 900), ortho=None, lens=35.0, up='Y', rot=None):
    sc = bpy.context.scene
    cam = sc.camera
    cam.location = Vector(cam_loc)
    if rot is not None:
        cam.rotation_euler = rot
    else:
        d = Vector(target) - Vector(cam_loc)
        cam.rotation_euler = d.to_track_quat('-Z', up).to_euler()
    if ortho:
        cam.data.type = 'ORTHO'
        cam.data.ortho_scale = ortho
    else:
        cam.data.type = 'PERSP'
        cam.data.lens = lens
    cam.data.clip_start = 0.1
    cam.data.clip_end = 500
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.filepath = path
    sc.render.image_settings.file_format = 'PNG'
    bpy.context.view_layer.update()
    bpy.ops.render.render(write_still=True)


def remove_render_objects():
    for ob in _render_objs:
        bpy.data.objects.remove(ob, do_unlink=True)
    _render_objs.clear()
