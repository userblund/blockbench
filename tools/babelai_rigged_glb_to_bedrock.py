#!/usr/bin/env python3
"""Autonomous GLB -> Minecraft Bedrock entity converter.

Targets skinned GLB models with one mesh/skin/material and converts the smooth
skinning into a Bedrock polymesh skeleton using dominant face weights.
Preserves embedded base-color texture and GLTF animations.
"""
from __future__ import annotations

import io, json, math, struct, sys, uuid, zipfile
from pathlib import Path
from collections import defaultdict
import numpy as np
from PIL import Image
from scipy.spatial.transform import Rotation

COMP = {5120: ('b',1,True), 5121: ('B',1,False), 5122: ('h',2,True), 5123: ('H',2,False), 5125: ('I',4,False), 5126: ('f',4,True)}
TYPE_N = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT2':4,'MAT3':9,'MAT4':16}

def read_glb(path):
    data = Path(path).read_bytes()
    if data[:4] != b'glTF': raise ValueError('El archivo no es un GLB válido')
    version,total = struct.unpack_from('<II', data, 4)
    if version != 2 or total != len(data): raise ValueError('GLB v2 inválido o truncado')
    pos=12; gltf=None; blob=b''
    while pos < len(data):
        length,kind=struct.unpack_from('<II',data,pos); pos+=8
        chunk=data[pos:pos+length]; pos+=length
        if kind == 0x4E4F534A: gltf=json.loads(chunk.decode('utf-8'))
        elif kind == 0x004E4942: blob=chunk
    if gltf is None: raise ValueError('GLB sin JSON')
    return gltf,blob

def accessor_reader(gltf,blob):
    def read(index):
        acc=gltf['accessors'][index]; bv=gltf['bufferViews'][acc['bufferView']]
        fmt,item_size,_=COMP[acc['componentType']]; n=TYPE_N[acc['type']]
        base=bv.get('byteOffset',0)+acc.get('byteOffset',0); packed=item_size*n; stride=bv.get('byteStride',packed)
        out=[]
        for i in range(acc['count']):
            vals=list(struct.unpack_from('<'+fmt*n,blob,base+i*stride))
            if acc.get('normalized'):
                ct=acc['componentType']
                if ct==5120: vals=[max(v/127.0,-1.0) for v in vals]
                elif ct==5121: vals=[v/255.0 for v in vals]
                elif ct==5122: vals=[max(v/32767.0,-1.0) for v in vals]
                elif ct==5123: vals=[v/65535.0 for v in vals]
            out.append(vals)
        arr=np.asarray(out)
        if acc['type'].startswith('MAT'):
            s=int(math.sqrt(n)); arr=arr.reshape((-1,s,s),order='F')
        return arr
    return read

def clean_name(s):
    x=''.join(c if (c.isalnum() or c in '._-') else '_' for c in s.strip())
    return x or 'bone'

def fmtv(x,digits=6):
    x=float(x)
    return 0.0 if abs(x)<5e-10 else round(x,digits)

def mat_sans_scale(m):
    A=m[:3,:3]; scales=np.linalg.norm(A,axis=0)
    rot=A@np.diag(1.0/np.maximum(scales,1e-12)); u,_,vt=np.linalg.svd(rot); rot=u@vt
    if np.linalg.det(rot)<0: u[:,-1]*=-1; rot=u@vt
    out=np.eye(4); out[:3,:3]=rot; out[:3,3]=m[:3,3]
    return out,scales

def euler_xyz_deg(m):
    return Rotation.from_matrix(m[:3,:3]).as_euler('XYZ',degrees=True)

def animation_data(gltf,read):
    result={}
    for anim in gltf.get('animations',[]):
        name=anim.get('name') or f'Animation_{len(result)}'; channels=defaultdict(dict); max_t=0.0
        for ch in anim.get('channels',[]):
            samp=anim['samplers'][ch['sampler']]; interp=samp.get('interpolation','LINEAR')
            if interp!='LINEAR': raise ValueError(f'Animación {name}: interpolación {interp} no soportada')
            times=read(samp['input']).reshape(-1); vals=read(samp['output']); node=ch['target']['node']; path=ch['target']['path']
            channels[node][path]=(times,vals)
            if len(times): max_t=max(max_t,float(times[-1]))
        result[name]=(max_t,channels)
    return result

def build_entity(glb_path,out_path,identifier='wery:haraganzito',display_name='Haraganzito'):
    gltf,blob=read_glb(glb_path); read=accessor_reader(gltf,blob)
    meshes=gltf.get('meshes',[]); skins=gltf.get('skins',[])
    if len(meshes)!=1 or len(skins)!=1: raise ValueError(f'Se requiere 1 mesh y 1 skin; encontró {len(meshes)} mesh y {len(skins)} skins')
    prims=meshes[0].get('primitives',[])
    if len(prims)!=1 or prims[0].get('mode',4)!=4: raise ValueError('Se requiere una única primitiva de triángulos')
    prim=prims[0]; attrs=prim['attributes']; required={'POSITION','TEXCOORD_0','JOINTS_0','WEIGHTS_0'}
    missing=sorted(required-attrs.keys())
    if missing: raise ValueError('Faltan atributos GLTF: '+', '.join(missing))
    pos=read(attrs['POSITION']).astype(float); uv=read(attrs['TEXCOORD_0']).astype(float)
    joints=read(attrs['JOINTS_0']).astype(int); weights=read(attrs['WEIGHTS_0']).astype(float); idx=read(prim['indices']).astype(int).reshape(-1)
    normals=read(attrs['NORMAL']).astype(float) if 'NORMAL' in attrs else None
    if len(idx)%3: raise ValueError('Índices no múltiplo de 3')

    mat=gltf.get('materials',[{}])[prim.get('material',0)]; tex_idx=mat.get('pbrMetallicRoughness',{}).get('baseColorTexture',{}).get('index')
    if tex_idx is None: raise ValueError('El GLB no contiene baseColorTexture')
    image_idx=gltf['textures'][tex_idx]['source']; img=gltf['images'][image_idx]
    if 'bufferView' not in img: raise ValueError('La textura base no está embebida; se requiere GLB autocontenido')
    bv=gltf['bufferViews'][img['bufferView']]; start=bv.get('byteOffset',0); tex_bytes=blob[start:start+bv['byteLength']]
    tex=Image.open(io.BytesIO(tex_bytes)).convert('RGBA'); tex_w,tex_h=tex.size
    material_name='entity' if tex.getchannel('A').getextrema()==(255,255) else 'entity_alphatest'

    skin=skins[0]; skin_joints=skin['joints']; joint_index={n:i for i,n in enumerate(skin_joints)}
    ibm=read(skin['inverseBindMatrices']); bind_world=np.linalg.inv(ibm)
    parents={}
    nodes=gltf.get('nodes',[])
    for ni,node in enumerate(nodes):
        for c in node.get('children',[]): parents[c]=ni
    bone_info={}
    for k,node_i in enumerate(skin_joints):
        bw,_=mat_sans_scale(bind_world[k]); pnode=parents.get(node_i)
        if pnode in joint_index: parent_world=mat_sans_scale(bind_world[joint_index[pnode]])[0]; local=np.linalg.inv(parent_world)@bw
        else: local=bw
        bone_info[node_i]={'name':clean_name(nodes[node_i].get('name') or f'bone_{k}'),'world':bw,'world_rot':bw[:3,:3],'pivot':bw[:3,3]*16.0,'local_rot':euler_xyz_deg(local),'parent_node':pnode if pnode in joint_index else None}

    by_bone=defaultdict(list)
    for f in range(0,len(idx),3):
        vs=idx[f:f+3]; scores=defaultdict(float)
        for v in vs:
            for c in range(4): scores[int(joints[v,c])]+=float(weights[v,c])
        by_bone[max(scores.items(),key=lambda kv:kv[1])[0]].append(tuple(map(int,vs)))

    bones_json=[]; all_p=[]
    for k,node_i in enumerate(skin_joints):
        bi=bone_info[node_i]; bobj={'name':bi['name'],'pivot':[fmtv(x) for x in bi['pivot']],'rotation':[fmtv(x) for x in bi['local_rot']]}
        if bi['parent_node'] is not None: bobj['parent']=bone_info[bi['parent_node']]['name']
        faces=by_bone.get(k,[])
        if faces:
            invr=bi['world_rot'].T; pmap={}; positions=[]; nrm=[]; uvs=[]; polys=[]
            def getv(v):
                if v not in pmap:
                    p=pos[v]; lp=bi['world'][:3,3]+invr@(p-bi['world'][:3,3]); positions.append([fmtv(x*16.0) for x in lp])
                    nn=invr@normals[v] if normals is not None else np.array([0.,1.,0.]); nn=nn/max(np.linalg.norm(nn),1e-12); nrm.append([fmtv(x) for x in nn])
                    uvs.append([fmtv(uv[v,0],8),fmtv(uv[v,1],8)]); pmap[v]=len(positions)-1
                return pmap[v]
            for a,c,d in faces:
                ia,ic,id=getv(a),getv(c),getv(d); polys.append([[ia,ia,ia],[ic,ic,ic],[id,id,id]])
            bobj['poly_mesh']={'normalized_uvs':True,'positions':positions,'normals':nrm,'uvs':uvs,'polys':polys}; all_p.extend(positions)
        bones_json.append(bobj)

    all_p=pos*16.0; mn=all_p.min(axis=0); mx=all_p.max(axis=0); ext=mx-mn; center=(mx+mn)/2
    geometry={'format_version':'1.21.0','minecraft:geometry':[{'description':{'identifier':'geometry.haraganzito','texture_width':tex_w,'texture_height':tex_h,'visible_bounds_width':fmtv(max(ext[0],ext[2])),'visible_bounds_height':fmtv(ext[1]),'visible_bounds_offset':[fmtv(center[0]),fmtv(center[1]),fmtv(center[2])]},'bones':bones_json}]}

    anims={}; info=animation_data(gltf,read)
    for aname,(length,channels) in info.items():
        bones={}
        for node_i,paths in channels.items():
            if node_i not in joint_index: continue
            b=bone_info[node_i]; out={}; bind_euler=b['local_rot']
            if 'rotation' in paths:
                times,vals=paths['rotation']; keys={}
                for t,q in zip(times,vals):
                    e=Rotation.from_quat(q).as_euler('XYZ',degrees=True); delta=(e-bind_euler+180.0)%360.0-180.0; keys[f'{float(t):.6f}']=[fmtv(x,6) for x in delta]
                out['rotation']=keys
            if 'translation' in paths:
                times,vals=paths['translation']; node_parent=parents.get(node_i); bind_t=np.zeros(3)
                if node_parent in joint_index: bind_t=(np.linalg.inv(bind_world[joint_index[node_parent]])@bind_world[joint_index[node_i]])[:3,3]
                keys={}
                for t,v in zip(times,vals):
                    delta=((np.asarray(v,float)-bind_t)/100.0)*16.0; keys[f'{float(t):.6f}']=[fmtv(x,6) for x in delta]
                out['position']=keys
            if 'scale' in paths:
                times,vals=paths['scale']
                if np.max(np.abs(vals-1.0))>1e-5: out['scale']={f'{float(t):.6f}':[fmtv(x,6) for x in v] for t,v in zip(times,vals)}
            if out: bones[b['name']]=out
        key=aname.lower().replace(' ','_').replace('-','_')
        anims[key]={'format_version':'1.8.0','animations':{f'animation.har_ganzito.{key}':{'loop':key in {'idle','walk','sprint'},'animation_length':fmtv(length,6),'bones':bones}}}

    ident_name=identifier.split(':',1)[1]; bp_uuid,rp_uuid,bpm,rpm=[str(uuid.uuid4()) for _ in range(4)]
    controller={'format_version':'1.10.0','animation_controllers':{'controller.animation.har_ganzito':{'initial_state':'default','states':{
        'default':{'animations':['har_idle'],'transitions':[{'jump_start':'query.is_jumping'},{'sprint':'query.is_sprinting'},{'walk':'query.is_moving'}]},
        'walk':{'animations':['har_walk'],'transitions':[{'jump_start':'query.is_jumping'},{'sprint':'query.is_sprinting'},{'default':'!query.is_moving'}]},
        'sprint':{'animations':['har_sprint'],'transitions':[{'jump_start':'query.is_jumping'},{'walk':'query.is_moving && !query.is_sprinting'},{'default':'!query.is_moving'}]},
        'jump_start':{'animations':['har_jump_start'],'transitions':[{'jump':'!query.is_on_ground'},{'default':'query.is_on_ground && !query.is_jumping'}]},
        'jump':{'animations':['har_jump'],'transitions':[{'jump_land':'query.is_on_ground'}]},
        'jump_land':{'animations':['har_jump_land'],'transitions':[{'default':'query.is_on_ground && !query.is_moving'},{'walk':'query.is_on_ground && query.is_moving'},{'sprint':'query.is_on_ground && query.is_sprinting'}]},
    }}}}
    bp={'format_version':2,'header':{'name':f'{display_name} BP','description':'Autonomous GLB -> Bedrock conversion','uuid':bp_uuid,'version':[1,0,0],'min_engine_version':[1,21,0]},'modules':[{'type':'data','uuid':bpm,'version':[1,0,0]}]}
    entity={'format_version':'1.21.0','minecraft:entity':{'description':{'identifier':identifier,'is_spawnable':True,'is_summonable':True,'is_experimental':False},'components':{'minecraft:type_family':{'family':['haraganzito','mob']},'minecraft:health':{'value':20,'max':20},'minecraft:collision_box':{'width':float(max(ext[0],ext[2])/16.0),'height':float(ext[1]/16.0)},'minecraft:physics':{'has_gravity':True,'has_collision':True},'minecraft:movement':{'value':0.1},'minecraft:navigation.walk':{'can_path_over_water':False,'avoid_water':True},'minecraft:movement.basic':{},'minecraft:jump.static':{'jump_power':0.42},'minecraft:behavior.random_stroll':{'priority':6,'speed_multiplier':1.0},'minecraft:behavior.look_at_player':{'priority':7,'look_distance':8,'probability':0.02},'minecraft:behavior.random_look_around':{'priority':8}}}}
    rp={'format_version':2,'header':{'name':f'{display_name} RP','description':'Autonomous GLB -> Bedrock conversion','uuid':rp_uuid,'version':[1,0,0],'min_engine_version':[1,21,0]},'modules':[{'type':'resources','uuid':rpm,'version':[1,0,0]}]}
    client={'format_version':'1.10.0','minecraft:client_entity':{'description':{'identifier':identifier,'materials':{'default':material_name},'textures':{'default':f'textures/entity/{ident_name}'},'geometry':{'default':'geometry.haraganzito'},'animations':{'har_idle':'animation.har_ganzito.idle','har_walk':'animation.har_ganzito.walk','har_sprint':'animation.har_ganzito.sprint','har_jump':'animation.har_ganzito.jump','har_jump_start':'animation.har_ganzito.jump_start','har_jump_land':'animation.har_ganzito.jump_land','controller':'controller.animation.har_ganzito'},'scripts':{'animate':['controller']},'render_controllers':['controller.render.har_ganzito']}}}
    render={'format_version':'1.8.0','render_controllers':{'controller.render.har_ganzito':{'geometry':'Geometry.default','materials':[{'*':'Material.default'}],'textures':['Texture.default']}}}

    bp_files={'manifest.json':json.dumps(bp,indent=2),f'entities/{ident_name}.json':json.dumps(entity,indent=2)}
    rp_files={'manifest.json':json.dumps(rp,indent=2),f'entity/{ident_name}.entity.json':json.dumps(client,indent=2),'render_controllers/render_controllers.json':json.dumps(render,indent=2),'animation_controllers/har_ganzito.controller.json':json.dumps(controller,indent=2),'models/entity/haraganzito.geo.json':json.dumps(geometry,separators=(',',':')),f'textures/entity/{ident_name}.png':None}
    for n,payload in anims.items(): rp_files[f'animations/har_ganzito.{n}.animation.json']=json.dumps(payload,separators=(',',':'))
    def pack(files):
        bio=io.BytesIO()
        with zipfile.ZipFile(bio,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
            for name,content in files.items(): z.writestr(name,tex_bytes if content is None else content,compress_type=zipfile.ZIP_STORED if content is None else zipfile.ZIP_DEFLATED)
        return bio.getvalue()
    bp_zip=pack(bp_files); rp_zip=pack(rp_files); out=Path(out_path); out.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z: z.writestr('Haraganzito_BP.mcpack',bp_zip,compress_type=zipfile.ZIP_STORED); z.writestr('Haraganzito_RP.mcpack',rp_zip,compress_type=zipfile.ZIP_STORED)
    report={'source':str(glb_path),'vertices':len(pos),'triangles':len(idx)//3,'bones':len(skin_joints),'animations':list(info.keys()),'texture':{'width':tex_w,'height':tex_h,'bytes':len(tex_bytes),'source_image':image_idx},'face_distribution':{str(k):len(v) for k,v in sorted(by_bone.items())},'geometry_model_units':'GLB meters -> Bedrock 1/16-meter model units','skinning':'dominant-face bone approximation'}
    Path(str(out)+'.report.json').write_text(json.dumps(report,indent=2),encoding='utf-8'); return report

if __name__=='__main__':
    if len(sys.argv)<3: print('Uso: python babelai_rigged_glb_to_bedrock.py input.glb output.mcaddon [identifier]'); raise SystemExit(2)
    print(json.dumps(build_entity(sys.argv[1],sys.argv[2],sys.argv[3] if len(sys.argv)>3 else 'wery:haraganzito'),indent=2))
