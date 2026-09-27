"""Clean a rigged Tripo GLB for the game: keep the armature, skin and animations, shrink textures, export a WebP GLB.

blender -b --factory-startup --python tools/blender/tripo_rig_process.py -- <in.glb> <out.glb> <preview_dir>
    [--tex 2048] [--orm 1024] [--tris 0]

The model keeps Tripo's units and orientation; the game places and scales it. The report lists the bones
with their rest heads in glTF axes (x, y=up, z=front) so creature code can find the spine and the jaw.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
src, dst, preview_dir = argv[0], os.path.abspath(argv[1]), os.path.abspath(argv[2])


def opt(name, default):
    flag = f'--{name}'
    return type(default)(argv[argv.index(flag) + 1]) if flag in argv else default


TEX = opt('tex', 2048)
ORM = opt('orm', 1024)
TRIS = opt('tris', 0)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
arms = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
if len(arms) != 1:
    raise SystemExit(f'expected one armature in {src}, found {len(arms)}')
arm = arms[0]


def skinned(o):
    return o.type == 'MESH' and any(m.type == 'ARMATURE' and m.object is arm for m in o.modifiers)


meshes = [o for o in bpy.context.scene.objects if skinned(o)]
if not meshes:
    raise SystemExit(f'no skinned mesh in {src}')
# helper shapes and empties the rigging service leaves in the file
for o in list(bpy.context.scene.objects):
    if o is not arm and o not in meshes:
        bpy.data.objects.remove(o, do_unlink=True)


def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


tris_in = sum(tri_count(o) for o in meshes)
if TRIS and tris_in > TRIS:
    for o in meshes:
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        mod = o.modifiers.new('decimate', 'DECIMATE')
        mod.ratio = TRIS / tris_in
        mod.use_collapse_triangulate = True
        # the decimate must run before the armature deform
        while o.modifiers[0].name != mod.name:
            bpy.ops.object.modifier_move_up(modifier=mod.name)
        bpy.ops.object.modifier_apply(modifier=mod.name)

roles = {}
for o in meshes:
    for slot in o.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes:
            continue
        for node in mat.node_tree.nodes:
            if node.type != 'TEX_IMAGE' or not node.image:
                continue
            role = 'orm'
            for link in node.outputs['Color'].links:
                to = link.to_node
                if to.type == 'BSDF_PRINCIPLED' and link.to_socket.name == 'Base Color':
                    role = 'base'
                elif to.type == 'NORMAL_MAP':
                    role = 'normal'
            roles[node.image.name] = role
for img in bpy.data.images:
    if img.name not in roles or img.size[0] == 0:
        continue
    size = ORM if roles[img.name] == 'orm' else TEX
    if max(img.size) > size:
        img.scale(size, size)

os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
kwargs = dict(filepath=dst, export_format='GLB', use_selection=False, export_apply=False, export_yup=True,
              export_image_format='WEBP', export_texcoords=True, export_normals=True, export_tangents=False,
              export_materials='EXPORT', export_draco_mesh_compression_enable=False,
              export_skins=True, export_animations=True)
try:
    bpy.ops.export_scene.gltf(**kwargs, export_image_quality=88)
except TypeError:
    bpy.ops.export_scene.gltf(**kwargs)


def gl(v):
    return [round(v[0], 4), round(v[2], 4), round(-v[1], 4)]


lo = [math.inf] * 3
hi = [-math.inf] * 3
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        for i in range(3):
            lo[i] = min(lo[i], w[i])
            hi[i] = max(hi[i], w[i])
bones = []
for b in arm.data.bones:
    bones.append({'name': b.name, 'parent': b.parent.name if b.parent else None,
                  'head': gl(arm.matrix_world @ b.head_local), 'tail': gl(arm.matrix_world @ b.tail_local)})
report = {
    'out': dst, 'mb': round(os.path.getsize(dst) / 1e6, 2), 'tris_in': tris_in, 'tris': sum(tri_count(o) for o in meshes),
    'min': [round(lo[0], 3), round(lo[2], 3), round(-hi[1], 3)], 'max': [round(hi[0], 3), round(hi[2], 3), round(-lo[1], 3)],
    'actions': [[a.name, list(a.frame_range)] for a in bpy.data.actions],
    'bones': bones,
    'textures': {n: [roles[n], list(bpy.data.images[n].size)] for n in roles},
}
print('REPORT ' + json.dumps(report))

os.makedirs(preview_dir, exist_ok=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'TEXTURE'
scene.render.resolution_x = 900
scene.render.resolution_y = 900
scene.world = bpy.data.worlds.new('w')
center = Vector([(lo[i] + hi[i]) / 2 for i in range(3)])
extent = max(hi[i] - lo[i] for i in range(3))
cam_data = bpy.data.cameras.new('cam')
cam_data.type = 'ORTHO'
cam_data.ortho_scale = extent * 1.08
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
views = {
    'front': (Vector((0, -1, 0)), (math.pi / 2, 0, 0)),
    'side': (Vector((1, 0, 0)), (math.pi / 2, 0, math.pi / 2)),
    'top': (Vector((0, 0, 1)), (0, 0, 0)),
}
base = os.path.splitext(os.path.basename(dst))[0]
for name, (d, rot) in views.items():
    cam.location = center + d * extent * 2
    cam.rotation_euler = rot
    scene.render.filepath = os.path.join(preview_dir, f'{base}_{name}.png')
    bpy.ops.render.render(write_still=True)
print('PREVIEWS ' + preview_dir)
