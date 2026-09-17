#!/usr/bin/env python3
"""BabelAI lossless gate: validate a rigged GLB and refuse lossy Bedrock conversion."""
import argparse, io, json, math, struct
from pathlib import Path
import numpy as np
from PIL import Image

C={5120:('b',1),5121:('B',1),5122:('h',2),5123:('H',2),5125:('I',4),5126:('f',4)}
N={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}

def load_glb(p):
    d=Path(p).read_bytes();
    if d[:4]!=b'glTF' or struct.unpack_from('<I',d,4)[0]!=2: raise ValueError('GLB v2 requerido')
    total=struct.unpack_from('<I',d,8)[0]
    if total!=len(d): raise ValueError('GLB truncado')
    q=12; g=None; b=b''
    while q<len(d):
        ln,k=struct.unpack_from('<II',d,q); q+=8; c=d[q:q+ln]; q+=ln
        if k==0x4e4f534a:g=json.loads(c.decode())
        elif k==0x004e4942:b=c
    if g is None: raise ValueError('JSON GLB ausente')
    return g,b

def acc(g,b,i):
    a=g['accessors'][i]; bv=g['bufferViews'][a['bufferView']]; fmt,w=C[a['componentType']]; n=N[a['type']]
    stride=bv.get('byteStride',w*n); base=bv.get('byteOffset',0)+a.get('byteOffset',0); end=base+max(0,a['count']-1)*stride+w*n
    if end>len(b): raise ValueError(f'accessor {i} fuera de BIN')
    x=np.array([struct.unpack_from('<'+fmt*n,b,base+j*stride) for j in range(a['count'])])
    if a['type']=='MAT4':x=x.reshape((-1,4,4),order='F')
    if a.get('normalized'):
        if a['componentType']==5120:x=np.maximum(x/127,-1)
        elif a['componentType']==5121:x=x/255
        elif a['componentType']==5122:x=np.maximum(x/32767,-1)
        elif a['componentType']==5123:x=x/65535
    return x

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('glb'); ap.add_argument('-o','--output',required=True); a=ap.parse_args()
    g,b=load_glb(a.glb); nodes=g.get('nodes',[]); meshes=g.get('meshes',[]); skins=g.get('skins',[])
    r={'source':{'bytes':Path(a.glb).stat().st_size,'nodes':len(nodes),'meshes':len(meshes),'skins':len(skins),'animations':len(g.get('animations',[]))},'errors':[],'warnings':[],'checks':{}}
    for i in range(len(g.get('accessors',[]))):
        try:acc(g,b,i)
        except Exception as e:r['errors'].append(str(e))
    if len(meshes)!=1:r['warnings'].append(f'meshes={len(meshes)}; exact gate currently targets one mesh')
    if len(skins)!=1:r['errors'].append(f'skins={len(skins)}; rigged source requires exactly one')
    if meshes:
        ps=meshes[0].get('primitives',[])
        if len(ps)!=1:r['errors'].append(f'primitives={len(ps)}; exact gate requires one')
        elif ps[0].get('mode',4)!=4:r['errors'].append('primitive mode is not TRIANGLES')
        else:
            at=ps[0].get('attributes',{}); need=['POSITION','NORMAL','TEXCOORD_0','JOINTS_0','WEIGHTS_0']; miss=[x for x in need if x not in at]
            if miss:r['errors'].append('missing attributes: '+','.join(miss))
            else:
                pos=acc(g,b,at['POSITION']).astype(float); uv=acc(g,b,at['TEXCOORD_0']).astype(float); j=acc(g,b,at['JOINTS_0']).astype(int); w=acc(g,b,at['WEIGHTS_0']).astype(float); ix=acc(g,b,ps[0]['indices']).reshape(-1).astype(int)
                sums=w.sum(1); sj=len(skins[0]['joints']); badsum=int(np.count_nonzero(np.abs(sums-1)>1e-4)); badj=int(np.count_nonzero((j<0)|(j>=sj))); badw=int(np.count_nonzero(w<0))
                r['checks']['mesh']={'vertices':len(pos),'triangles':len(ix)//3,'position_finite':bool(np.isfinite(pos).all()),'uv_finite':bool(np.isfinite(uv).all())}
                r['checks']['weights']={'sum_min':float(sums.min()),'sum_max':float(sums.max()),'bad_sum':badsum,'bad_joint':badj,'bad_negative':badw,'influences_gt_1e-4':{str(k):int(np.count_nonzero((w>1e-4).sum(1)==k)) for k in range(1,5)}}
                if badsum:r['errors'].append(f'{badsum} invalid weight sums')
                if badj:r['errors'].append(f'{badj} invalid joint indices')
                if badw:r['errors'].append(f'{badw} negative weights')
                if not np.isfinite(pos).all() or not np.isfinite(uv).all():r['errors'].append('NaN/Inf in geometry or UV')
                if ix.size and (ix.min()<0 or ix.max()>=len(pos)):r['errors'].append('triangle index out of range')
                if ix.size%3:r['errors'].append('index count not divisible by 3')
    if len(skins)==1:
        s=skins[0]; ib=acc(g,b,s['inverseBindMatrices']) if 'inverseBindMatrices' in s else None
        if ib is None:r['errors'].append('inverseBindMatrices missing')
        else:
            r['checks']['skin']={'joints':len(s['joints']),'inverse_identity_max':max(float(np.max(np.abs(np.linalg.inv(m)@m-np.eye(4)))) for m in ib),'joint_names':[nodes[i].get('name',f'node_{i}') for i in s['joints']]}
            parents={};
            for i,n in enumerate(nodes):
                for c in n.get('children',[]):
                    if c in parents:r['errors'].append(f'node {c} has multiple parents')
                    parents[c]=i
    imgs=[]
    for i,img in enumerate(g.get('images',[])):
        z={'index':i,'embedded':'bufferView' in img}
        if 'bufferView' in img:
            bv=g['bufferViews'][img['bufferView']]; raw=b[bv.get('byteOffset',0):bv.get('byteOffset',0)+bv['byteLength']]
            try:
                im=Image.open(io.BytesIO(raw)); z.update({'format':im.format,'size':list(im.size),'mode':im.mode})
            except Exception as e:r['errors'].append(f'image {i}: {e}')
        imgs.append(z)
    r['checks']['images']=imgs
    anims=[]
    for ai,x in enumerate(g.get('animations',[])):
        interp=set(); dur=0; ch=len(x.get('channels',[]))
        for c in x.get('channels',[]):
            s=x['samplers'][c['sampler']]; interp.add(s.get('interpolation','LINEAR')); t=acc(g,b,s['input']).reshape(-1); dur=max(dur,float(t[-1]) if len(t) else 0)
        anims.append({'name':x.get('name',f'Animation_{ai}'),'channels':ch,'duration':dur,'interpolation':sorted(interp)})
        if interp-{'LINEAR'}:r['errors'].append(f"animation {anims[-1]['name']} uses {sorted(interp-{'LINEAR'})}")
    r['checks']['animations']=anims
    r['target_gate']={'lossless':False,'reason':'Standard Bedrock entity geometry is bone-transform based and has no direct arbitrary JOINTS_0/WEIGHTS_0 skinning representation.'}
    r['warnings'].append('Approximate dominant-bone, rigid-face, voxel, or deprecated-poly_mesh fallback is forbidden by this pipeline.')
    r['status']='PASS_SOURCE_VALIDATION' if not r['errors'] else 'FAIL_SOURCE_VALIDATION'; r['lossless_ready']=False
    Path(a.output).write_text(json.dumps(r,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps({'status':r['status'],'errors':len(r['errors']),'warnings':len(r['warnings']),'lossless_ready':False},ensure_ascii=False))
    return 0 if not r['errors'] else 2
if __name__=='__main__':raise SystemExit(main())
