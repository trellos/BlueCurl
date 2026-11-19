# Rocketbox FBX -> GLB (headless Blender via `pip install bpy`). Usage: python rocketbox_to_glb.py <fbx> <texdir> <out.glb>
import bpy, sys, os, mathutils
fbx, texdir, out = sys.argv[-3:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx)  # default axes: bone frames preserved as in FBX
arm = [o for o in bpy.data.objects if o.type=='ARMATURE'][0]
mesh = [o for o in bpy.data.objects if o.type=='MESH'][0]
for o in list(bpy.data.objects):
    if o.type=='EMPTY': bpy.data.objects.remove(o)
for o in bpy.data.objects: o.animation_data_clear()
for a in list(bpy.data.actions): bpy.data.actions.remove(a)
bpy.context.scene.frame_set(0)
# reset pose to rest
for pb in arm.pose.bones:
    pb.matrix_basis = mathutils.Matrix.Identity(4)
bpy.context.view_layer.update()
# check rest == bind: modifier-evaluated vs raw
dg = bpy.context.evaluated_depsgraph_get()
ev = mesh.evaluated_get(dg).to_mesh()
mx = max((a.co - b.co).length for a,b in zip(ev.vertices, mesh.data.vertices))
print('max deviation rest-deformed vs undeformed (local units):', mx)
mesh.evaluated_get(dg).to_mesh_clear()

# --- weight stats & limit to 4
names = {g.index:g.name for g in mesh.vertex_groups}
used=set(); counts={}; dropped_max=0; dropped_sum=0; nchanged=0
for v in mesh.data.vertices:
    ws = sorted([(g.weight,g.group) for g in v.groups if g.weight>0], reverse=True)
    counts[len(ws)] = counts.get(len(ws),0)+1
    tot = sum(w for w,_ in ws)
    if len(ws)>4:
        d = sum(w for w,_ in ws[4:])/tot; dropped_max=max(dropped_max,d); dropped_sum+=d; nchanged+=1
    for w,g in ws: used.add(names[g])
print('influence count histogram', sorted(counts.items()))
print('verts >4 infl', nchanged, 'max dropped weight frac %.4f'%dropped_max, 'mean dropped(among changed) %.4f'%(dropped_sum/max(nchanged,1)))
print('unnormalized verts', sum(1 for v in mesh.data.vertices if abs(sum(g.weight for g in v.groups)-1)>1e-3))
print('bones with no weights:', [b.name for b in arm.data.bones if b.name not in used])
bpy.context.view_layer.objects.active = mesh
for o in bpy.data.objects: o.select_set(o==mesh)
bpy.ops.object.vertex_group_clean(group_select_mode='ALL', limit=0.0001)
bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)

# --- apply transforms: unparent, apply, reparent
mw = mesh.matrix_world.copy()
mesh.parent = None; mesh.matrix_world = mw
for o in (arm, mesh):
    for x in bpy.data.objects: x.select_set(x==o)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
mesh.parent = arm; mesh.matrix_parent_inverse = mathutils.Matrix.Identity(4)
mod = [m for m in mesh.modifiers if m.type=='ARMATURE'][0]; mod.object = arm
arm.name = 'Bip01'; arm.data.name = 'Bip01_Armature'; mesh.name = 'Body'; mesh.data.name='Body'
bpy.context.view_layer.update()
co = [v.co for v in mesh.data.vertices]
print('bbox min', [round(min(c[i] for c in co),4) for i in range(3)], 'max', [round(max(c[i] for c in co),4) for i in range(3)])
# verify still bound correctly
dg = bpy.context.evaluated_depsgraph_get(); ev = mesh.evaluated_get(dg).to_mesh()
print('post-apply max deviation (m):', max((a.co - b.co).length for a,b in zip(ev.vertices, mesh.data.vertices)))
mesh.evaluated_get(dg).to_mesh_clear()
# bone scale check
for b in arm.data.bones:
    s = b.matrix_local.to_scale()
    if max(abs(x-1) for x in s)>1e-4: print('non-unit bone scale', b.name, s)

# --- materials
def img(name):
    i = bpy.data.images.load(os.path.join(texdir, name)); return i
def build(mat, color, normal=None, alpha=False):
    mat.use_nodes = True; nt = mat.node_tree; nt.nodes.clear()
    outn = nt.nodes.new('ShaderNodeOutputMaterial'); bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs[0], outn.inputs[0])
    t = nt.nodes.new('ShaderNodeTexImage'); t.image = img(color)
    nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Metallic'].default_value = 0.0
    bsdf.inputs['Roughness'].default_value = 1.0 if alpha else 0.6
    if alpha: bsdf.inputs['Specular IOR Level'].default_value = 0.15
    if normal:
        n = nt.nodes.new('ShaderNodeTexImage'); n.image = img(normal); n.image.colorspace_settings.name='Non-Color'
        nm = nt.nodes.new('ShaderNodeNormalMap'); nt.links.new(n.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs[0], bsdf.inputs['Normal'])
    if alpha:
        r = nt.nodes.new('ShaderNodeMath'); r.operation='ROUND'   # glTF exporter -> alphaMode MASK, cutoff 0.5
        nt.links.new(t.outputs['Alpha'], r.inputs[0]); nt.links.new(r.outputs[0], bsdf.inputs['Alpha'])
        mat.use_backface_culling = False
    else:
        mat.use_backface_culling = True
mats = {m.name:m for m in mesh.data.materials}
build(mats['m002_body'], 'm002_body_color.jpg', 'm002_body_normal.jpg')
build(mats['m002_head'], 'm002_head_color.jpg', 'm002_head_normal.jpg')
build(mats['m002_opacity'], 'm002_hair_color_alpha.png', alpha=True)
mats['m002_opacity'].name = 'm002_hair'
for i in list(bpy.data.images):
    if i.users == 0: bpy.data.images.remove(i)
# per-material vertex/face counts
import collections
fc = collections.Counter(p.material_index for p in mesh.data.polygons)
print('faces per material', {mesh.data.materials[k].name:v for k,v in fc.items()})
arm.data.pose_position = 'REST'
bpy.ops.wm.save_as_mainfile(filepath=out.replace('.glb','.blend'))
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True, use_selection=False,
    export_skins=True, export_influence_nb=4, export_all_influences=False, export_animations=False,
    export_morph=False, export_image_format='AUTO', export_texcoords=True, export_normals=True,
    export_tangents=False, export_materials='EXPORT', export_rest_position_armature=True,
    export_def_bones=False, export_apply=False, export_extras=False, export_cameras=False, export_lights=False)
print('EXPORTED', out, os.path.getsize(out))
