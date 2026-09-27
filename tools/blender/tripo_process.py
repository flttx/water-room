"""Clean a raw Tripo GLB for the game: join meshes, place it in metres, shrink textures, export a WebP GLB and render previews.

blender -b --factory-startup --python tools/blender/tripo_process.py -- <in.glb> <out.glb> <preview_dir>
    [--yaw 0] [--pivot x,y,z] [--size 0] [--tex 2048] [--orm 1024] [--tris 0]

--yaw     degrees about the up axis, applied first, so the creature faces glTF +Z
--pivot   point (glTF axes, raw units, after yaw) that becomes the origin
--size    scale so the longest bounding-box side is this many metres
"""
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:]
src, dst, preview_dir = argv[0], argv[1], argv[2]


def opt(name, default):
    flag = f'--{name}'
    return type(default)(argv[argv.index(flag) + 1]) if flag in argv else default


YAW = opt('yaw', 0.0)
PIVOT = [float(v) for v in opt('pivot', '0,0,0').split(',')]
SIZE = opt('size', 0.0)
TEX = opt('tex', 2048)
ORM = opt('orm', 1024)
TRIS = opt('tris', 0)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes:
    raise SystemExit(f'no mesh in {src}')
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
# drop empties left over from the import hierarchy
for o in list(bpy.context.scene.objects):
    if o is not obj:
        bpy.data.objects.remove(o, do_unlink=True)
obj.parent = None

# glTF (x, y, z) is Blender (x, -z, y); transform the mesh data directly (imported objects use quaternion mode)
obj.data.transform(Matrix.Rotation(math.radians(YAW), 4, 'Z'))
obj.data.transform(Matrix.Translation((-PIVOT[0], PIVOT[2], -PIVOT[1])))
if SIZE:
    obj.data.update()
    obj.data.transform(Matrix.Scale(SIZE / max(obj.dimensions), 4))
obj.data.update()


def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


tris_in = tri_count(obj)
if TRIS and tris_in > TRIS:
    mod = obj.modifiers.new('decimate', 'DECIMATE')
    mod.ratio = TRIS / tris_in
    mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=mod.name)

# texture roles from the material graph
roles = {}
for slot in obj.material_slots:
    mat = slot.material
    if not mat or not mat.use_nodes:
        continue
    for node in mat.node_tree.nodes:
        if node.type != 'TEX_IMAGE' or not node.image:
            continue
        role = 'orm'
        for link in node.outputs['Color'].links:
            to = link.to_node
            name = link.to_socket.name
            if to.type == 'BSDF_PRINCIPLED' and name == 'Base Color':
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
kwargs = dict(filepath=dst, export_format='GLB', use_selection=False, export_apply=True, export_yup=True,
              export_image_format='WEBP', export_texcoords=True, export_normals=True, export_tangents=False,
              export_materials='EXPORT', export_draco_mesh_compression_enable=False, export_animations=False)
try:
    bpy.ops.export_scene.gltf(**kwargs, export_image_quality=88)
except TypeError:
    bpy.ops.export_scene.gltf(**kwargs)

# bounds in glTF axes (x, y=up, z=front)
bb = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
lo = [min(v[i] for v in bb) for i in range(3)]
hi = [max(v[i] for v in bb) for i in range(3)]
report = {
    'out': dst, 'mb': round(os.path.getsize(dst) / 1e6, 2), 'tris_in': tris_in, 'tris': tri_count(obj),
    'min': [round(lo[0], 3), round(lo[2], 3), round(-hi[1], 3)], 'max': [round(hi[0], 3), round(hi[2], 3), round(-lo[1], 3)],
    'textures': {n: [roles[n], list(bpy.data.images[n].size)] for n in roles},
}
print('REPORT ' + json.dumps(report))

# previews: workbench with textures, orthographic front (+Z in glTF = -Y in Blender) and side
os.makedirs(preview_dir, exist_ok=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'TEXTURE'
scene.render.resolution_x = 900
scene.render.resolution_y = 900
scene.render.film_transparent = False
world = bpy.data.worlds.new('w')
scene.world = world
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
    'q34': (Vector((0.7, -0.7, 0.25)).normalized(), None),
}
base = os.path.splitext(os.path.basename(dst))[0]
for name, (d, rot) in views.items():
    cam.location = center + d * extent * 2
    if rot:
        cam.rotation_euler = rot
    else:
        cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(preview_dir, f'{base}_{name}.png')
    bpy.ops.render.render(write_still=True)
print('PREVIEWS ' + preview_dir)
