import bpy
import json
import math
import os
import sys
from mathutils import Matrix, Quaternion, Vector

SCHEMA_VERSION = 1


def arg_path():
    if "--" not in sys.argv:
        raise RuntimeError("Missing bridge arguments. Expected: blender --background --python rigged_gltf_bridge.py -- input.glb output.json")
    args = sys.argv[sys.argv.index("--") + 1:]
    if len(args) != 2:
        raise RuntimeError("Expected exactly 2 arguments: input.glb output.json")
    return os.path.abspath(args[0]), os.path.abspath(args[1])


def v3(v):
    return [float(v.x), float(v.y), float(v.z)]


def q4(q):
    return [float(q.x), float(q.y), float(q.z), float(q.w)]


def mat16(m):
    return [float(m[r][c]) for r in range(4) for c in range(4)]


def decompose_matrix(m):
    loc, rot, scale = m.decompose()
    return {
        "translation": v3(loc),
        "rotation": q4(rot),
        "scale": v3(scale),
    }


def relative_bone_matrix(bone):
    if bone.parent:
        return bone.parent.matrix_local.inverted() @ bone.matrix_local
    return bone.matrix_local.copy()


def find_base_color_image(material):
    if not material or not material.use_nodes or not material.node_tree:
        return None
    bsdf = next((n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf:
        return None
    socket = bsdf.inputs.get('Base Color')
    if not socket or not socket.is_linked:
        return None
    link = socket.links[0]
    node = link.from_node
    if node.type == 'TEX_IMAGE':
        return node.image
    return None


def save_image(image, output_dir, index):
    if image is None:
        return None
    name = os.path.basename(image.filepath or image.name or f"texture_{index}.png")
    stem, _ = os.path.splitext(name)
    if not stem:
        stem = f"texture_{index}"
    path = os.path.join(output_dir, f"{index:02d}_{stem}.png")
    try:
        image.save(filepath=path)
    except Exception:
        # Packed images and formats unsupported by save() are copied through Blender's image API.
        old_path = image.filepath_raw
        try:
            image.filepath_raw = path
            image.file_format = 'PNG'
            image.save()
        finally:
            image.filepath_raw = old_path
    return path if os.path.isfile(path) else None


def import_gltf(filepath):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    result = bpy.ops.import_scene.gltf(
        filepath=filepath,
        import_pack_images=True,
        loglevel=0,
    )
    if 'FINISHED' not in result:
        raise RuntimeError(f"Blender glTF import failed: {result}")


def collect_armature():
    armatures = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
    if not armatures:
        raise RuntimeError("No armature was created by Blender's glTF importer.")
    armatures.sort(key=lambda o: (0 if any(m.type == 'ARMATURE' and m.object == o for mesh in bpy.data.objects if mesh.type == 'MESH' for m in mesh.modifiers) else 1, o.name))
    return armatures[0]


def mesh_objects_for_armature(armature):
    meshes = []
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue
        if any(mod.type == 'ARMATURE' and mod.object == armature for mod in obj.modifiers):
            meshes.append(obj)
    if not meshes:
        # Fallback to children, then all meshes.
        meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and (o.parent == armature or o.parent is None)]
    if not meshes:
        raise RuntimeError("No mesh using the imported armature was found.")
    return meshes


def export_texture_set(meshes, output_dir):
    textures = {}
    counter = 0
    for obj in meshes:
        materials = obj.data.materials
        for mat in materials:
            image = find_base_color_image(mat)
            if not image:
                continue
            key = image.as_pointer()
            if key in textures:
                continue
            path = save_image(image, output_dir, counter)
            textures[key] = {
                "path": path,
                "name": image.name,
                "width": int(image.size[0]),
                "height": int(image.size[1]),
            }
            counter += 1
    return [v for v in textures.values() if v["path"]]


def serialize_bones(armature):
    bones = []
    for b in armature.data.bones:
        local = relative_bone_matrix(b)
        d = decompose_matrix(local)
        bones.append({
            "name": b.name,
            "parent": b.parent.name if b.parent else None,
            "matrix_local": mat16(local),
            "translation": d["translation"],
            "rotation": d["rotation"],
            "scale": d["scale"],
            "head": v3(b.head_local),
            "tail": v3(b.tail_local),
            "length": float(b.length),
            "use_connect": bool(b.use_connect),
        })
    return bones


def serialize_mesh(obj, armature, texture_lookup):
    inv_armature = armature.matrix_world.inverted()
    mesh = obj.data
    mesh.calc_loop_triangles()

    vertices = []
    for v in mesh.vertices:
        world = obj.matrix_world @ v.co
        local = inv_armature @ world
        vertices.append(v3(local))

    uv_layer = mesh.uv_layers.active
    polys = []
    for poly in mesh.polygons:
        uv = []
        for li in poly.loop_indices:
            if uv_layer:
                uvv = uv_layer.data[li].uv
                uv.append([float(uvv.x), float(1.0 - uvv.y)])
            else:
                uv.append([0.0, 0.0])
        polys.append({
            "vertices": [int(i) for i in poly.vertices],
            "uv": uv,
            "material_index": int(poly.material_index),
        })

    # Map Blender vertex-group indices to imported bone names.
    group_names = {g.index: g.name for g in obj.vertex_groups}
    weights = []
    bad_vertices = 0
    min_sum = float('inf')
    max_sum = 0.0
    for v in mesh.vertices:
        items = []
        total = 0.0
        for g in v.groups:
            name = group_names.get(g.group)
            if not name:
                continue
            w = float(g.weight)
            if w <= 0:
                continue
            items.append({"bone": name, "weight": w})
            total += w
        items.sort(key=lambda x: x["weight"], reverse=True)
        weights.append(items)
        min_sum = min(min_sum, total)
        max_sum = max(max_sum, total)
        if not items or abs(total - 1.0) > 1e-3:
            bad_vertices += 1

    material_names = []
    for mat in mesh.materials:
        material_names.append(mat.name if mat else None)

    return {
        "name": obj.name,
        "vertices": vertices,
        "polys": polys,
        "weights": weights,
        "materials": material_names,
        "object_matrix_world": mat16(obj.matrix_world),
        "armature_matrix_world": mat16(armature.matrix_world),
        "diagnostics": {
            "vertex_count": len(vertices),
            "polygon_count": len(polys),
            "bad_weight_vertices": int(bad_vertices),
            "weight_sum_min": 0.0 if min_sum == float('inf') else min_sum,
            "weight_sum_max": max_sum,
        },
    }


def group_fcurves(action):
    result = {}
    for fc in action.fcurves:
        path = fc.data_path
        if not path.startswith('pose.bones['):
            continue
        try:
            bone_name = path.split('pose.bones[', 1)[1].split(']', 1)[0].strip('"')
        except Exception:
            continue
        prop = fc.array_index
        if 'location' in path:
            channel = 'location'
        elif 'rotation_quaternion' in path:
            channel = 'rotation_quaternion'
        elif 'rotation_euler' in path:
            channel = 'rotation_euler'
        elif 'scale' in path:
            channel = 'scale'
        else:
            continue
        result.setdefault(bone_name, {}).setdefault(channel, {})[prop] = fc
    return result


def sample_fcurve(group, frame, defaults):
    out = list(defaults)
    for idx, fc in group.items():
        out[int(idx)] = float(fc.evaluate(frame))
    return out


def serialize_actions(armature):
    actions = []
    fps = float(bpy.context.scene.render.fps or 24.0)
    bones = {b.name: b for b in armature.data.bones}

    for action in bpy.data.actions:
        groups = group_fcurves(action)
        if not groups:
            continue
        start, end = action.frame_range
        bone_channels = {}
        for bone_name, channels in groups.items():
            if bone_name not in bones:
                continue
            times = set()
            for fc_map in channels.values():
                for fc in fc_map.values():
                    times.update(float(k.co.x) for k in fc.keyframe_points)
            if not times:
                continue
            ordered = sorted(times)
            payload = []
            for frame in ordered:
                loc = sample_fcurve(channels.get('location', {}), frame, [0.0, 0.0, 0.0])
                quat = sample_fcurve(channels.get('rotation_quaternion', {}), frame, [0.0, 0.0, 0.0, 1.0])
                if not channels.get('rotation_quaternion') and channels.get('rotation_euler'):
                    eul = sample_fcurve(channels.get('rotation_euler', {}), frame, [0.0, 0.0, 0.0])
                    quat = list(Quaternion((1, 0, 0, 0)).to_euler().to_quaternion())
                    quat = list(__import__('mathutils').Euler(eul, 'XYZ').to_quaternion())
                scale = sample_fcurve(channels.get('scale', {}), frame, [1.0, 1.0, 1.0])
                payload.append({
                    "frame": float(frame),
                    "time": float((frame - start) / fps),
                    "location": loc,
                    "rotation": quat,
                    "scale": scale,
                })
            bone_channels[bone_name] = payload
        if bone_channels:
            actions.append({
                "name": action.name,
                "start_frame": float(start),
                "end_frame": float(end),
                "fps": fps,
                "bones": bone_channels,
            })
    return actions


def validate(data):
    bones = {b['name'] for b in data['bones']}
    missing_weight_bones = set()
    for mesh in data['meshes']:
        for weights in mesh['weights']:
            for item in weights:
                if item['bone'] not in bones:
                    missing_weight_bones.add(item['bone'])
    if missing_weight_bones:
        raise RuntimeError('Weights reference missing bones: ' + ', '.join(sorted(missing_weight_bones)))
    if not data['textures']:
        data['warnings'].append('No Base Color image was found in Blender materials.')
    return data


def main():
    input_path, output_path = arg_path()
    out_dir = os.path.dirname(output_path)
    os.makedirs(out_dir, exist_ok=True)
    textures_dir = os.path.join(out_dir, 'textures')
    os.makedirs(textures_dir, exist_ok=True)

    import_gltf(input_path)
    armature = collect_armature()
    meshes = mesh_objects_for_armature(armature)

    textures = export_texture_set(meshes, textures_dir)
    texture_lookup = {t['name']: t for t in textures}

    data = {
        "schema": "blockbench-rigged-gltf-bridge",
        "schema_version": SCHEMA_VERSION,
        "source": os.path.basename(input_path),
        "blender_version": bpy.app.version_string,
        "fps": float(bpy.context.scene.render.fps or 24.0),
        "armature": {
            "name": armature.name,
            "matrix_world": mat16(armature.matrix_world),
        },
        "bones": serialize_bones(armature),
        "meshes": [serialize_mesh(m, armature, texture_lookup) for m in meshes],
        "textures": textures,
        "animations": serialize_actions(armature),
        "warnings": [],
    }
    data = validate(data)

    with open(output_path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

    print(json.dumps({
        "status": "ok",
        "output": output_path,
        "bones": len(data['bones']),
        "meshes": len(data['meshes']),
        "textures": len(data['textures']),
        "animations": len(data['animations']),
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f"[Rigged glTF Bridge] ERROR: {exc}", file=sys.stderr)
        raise
