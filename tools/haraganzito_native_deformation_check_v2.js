#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const parser = require(path.resolve(__dirname, '../plugins/haraganzito_glb_parser.js'));

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/haraganzito_native_deformation_check.js <model.glb>');
  process.exit(2);
}

const bytes = fs.readFileSync(file);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const glb = parser.parseGLB(buffer);
const primitive = glb.meshes?.[0]?.primitives?.[0];
const skin = glb.skins?.[0];
if (!primitive || !skin) throw new Error('HARAGANZITO_REQUIRES_SKINNED_PRIMITIVE');

function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      for (let k = 0; k < 4; k++) o[c*4+r] += a[k*4+r] * b[c*4+k];
    }
  }
  return o;
}
function inv(m) {
  const a = [
    [m[0],m[4],m[8],m[12]],
    [m[1],m[5],m[9],m[13]],
    [m[2],m[6],m[10],m[14]],
    [m[3],m[7],m[11],m[15]]
  ];
  const b = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
  for (let col=0; col<4; col++) {
    let pivot=col;
    for (let row=col+1; row<4; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot=row;
    if (Math.abs(a[pivot][col]) < 1e-14) throw new Error('SINGULAR_MATRIX');
    [a[col],a[pivot]]=[a[pivot],a[col]];
    [b[col],b[pivot]]=[b[pivot],b[col]];
    const d=a[col][col];
    for(let j=0;j<4;j++){a[col][j]/=d;b[col][j]/=d;}
    for(let row=0;row<4;row++){
      if(row===col) continue;
      const f=a[row][col];
      for(let j=0;j<4;j++){a[row][j]-=f*a[col][j];b[row][j]-=f*b[col][j];}
    }
  }
  const out=[];
  for(let c=0;c<4;c++)for(let r=0;r<4;r++)out[c*4+r]=b[r][c];
  return out;
}
function vm(m,v) {
  return [
    m[0]*v[0]+m[4]*v[1]+m[8]*v[2]+m[12],
    m[1]*v[0]+m[5]*v[1]+m[9]*v[2]+m[13],
    m[2]*v[0]+m[6]*v[1]+m[10]*v[2]+m[14]
  ];
}
function norm4(q){const n=Math.hypot(...q)||1;return q.map(v=>v/n);}
function qmat(q){
  let [x,y,z,w]=norm4(q);
  return [
    1-2*(y*y+z*z),2*(x*y+z*w),2*(x*z-y*w),0,
    2*(x*y-z*w),1-2*(x*x+z*z),2*(y*z+x*w),0,
    2*(x*z+y*w),2*(y*z-x*w),1-2*(x*x+y*y),0,
    0,0,0,1
  ];
}
function trs(t,q,s){
  const m=qmat(q);
  m[0]*=s[0];m[1]*=s[0];m[2]*=s[0];
  m[4]*=s[1];m[5]*=s[1];m[6]*=s[1];
  m[8]*=s[2];m[9]*=s[2];m[10]*=s[2];
  m[12]=t[0];m[13]=t[1];m[14]=t[2];
  return m;
}
function lerp(a,b,u){return a.map((v,i)=>v+(b[i]-v)*u);}
function nlerp(a,b,u){let bb=b.slice();const d=a.reduce((s,v,i)=>s+v*bb[i],0);if(d<0)bb=bb.map(v=>-v);return norm4(lerp(a,bb,u));}

function sample(sampler,t,pathName){
  const xs=sampler.input;
  if(t<=xs[0])return sampler.output[0].slice();
  if(t>=xs[xs.length-1])return sampler.output[xs.length-1].slice();
  let hi=1;while(hi<xs.length&&xs[hi]<t)hi++;
  const lo=hi-1,u=(t-xs[lo])/((xs[hi]-xs[lo])||1);
  if(sampler.interpolation==='STEP')return sampler.output[lo].slice();
  if(sampler.interpolation!=='LINEAR')throw new Error('UNSUPPORTED_INTERPOLATION:'+sampler.interpolation);
  return pathName==='rotation'?nlerp(sampler.output[lo],sampler.output[hi],u):lerp(sampler.output[lo],sampler.output[hi],u);
}

const nodes=glb.nodes;
function worldMatrices(animation,t){
  const cache=new Array(nodes.length);
  function local(i){
    const n=nodes[i];
    let tr=n.local.translation.slice(),q=n.local.rotation.slice(),s=n.local.scale.slice();
    if(animation){
      for(const ch of animation.channels){
        if(ch.targetNode!==i)continue;
        const value=sample(animation.samplers[ch.sampler],t,ch.path);
        if(ch.path==='translation')tr=value;
        else if(ch.path==='rotation')q=value;
        else if(ch.path==='scale')s=value;
      }
    }
    return trs(tr,q,s);
  }
  function world(i){
    if(cache[i])return cache[i];
    cache[i]=nodes[i].parent==null?local(i):mul(world(nodes[i].parent),local(i));
    return cache[i];
  }
  for(let i=0;i<nodes.length;i++)world(i);
  return cache;
}
function sampleTimes(animation){
  const values=[0];
  for(const s of animation.samplers)values.push(...s.input);
  values.sort((a,b)=>a-b);
  const unique=[];
  for(const t of values)if(!unique.length||Math.abs(t-unique[unique.length-1])>1e-9)unique.push(t);
  const out=[];
  for(let i=0;i<unique.length;i++){
    out.push(unique[i]);
    if(i+1<unique.length)out.push((unique[i]+unique[i+1])/2);
  }
  return out;
}
function lca(nodes,a,b){
  const ancestors=new Set();
  for(let x=a;x!=null;x=nodes[x].parent)ancestors.add(x);
  for(let x=b;x!=null;x=nodes[x].parent)if(ancestors.has(x))return x;
  return null;
}
function deformReference(vertex, worlds){
  const out=[0,0,0];
  const js=primitive.attributes.JOINTS_0[vertex];
  const ws=primitive.attributes.WEIGHTS_0[vertex];
  for(let k=0;k<4;k++){
    const w=ws[k]||0;
    if(!w)continue;
    const skinMatrix=mul(worlds[skin.joints[js[k]]],skin.inverseBindMatrices[js[k]]);
    const p=vm(skinMatrix,primitive.attributes.POSITION[vertex]);
    out[0]+=w*p[0];out[1]+=w*p[1];out[2]+=w*p[2];
  }
  return out;
}
function deformNative(vertex,worlds,containerIndex){
  /*
   * Exact Blockbench Armature.calculateVertexDeformation formula:
   *
   * armature_matrix_inverse = inverse(parent.matrixWorld)
   * bind_matrix = armature_matrix_inverse * mesh.matrixWorld
   * target = sum(weight * armature_matrix_inverse *
   *             bone.matrixWorld * inverse_bind_matrix * basePosition)
   * target = bind_matrix_inverse * target
   *
   * Haraganzito architecture:
   *   Container = common GLB transform
   *   Armature  = identity under Container
   *   Mesh      = identity under Armature
   *
   * Consequently bind_matrix == I and the final container-local result is:
   *   inverse(ContainerWorld) * JointWorld * IBM * position
   */
  const containerInverse=inv(worlds[containerIndex]);
  const out=[0,0,0];
  const js=primitive.attributes.JOINTS_0[vertex];
  const ws=primitive.attributes.WEIGHTS_0[vertex];
  for(let k=0;k<4;k++){
    const w=ws[k]||0;
    if(!w)continue;
    const jointMatrix=mul(containerInverse,mul(worlds[skin.joints[js[k]]],skin.inverseBindMatrices[js[k]]));
    const p=vm(jointMatrix,primitive.attributes.POSITION[vertex]);
    out[0]+=w*p[0];out[1]+=w*p[1];out[2]+=w*p[2];
  }
  return vm(worlds[containerIndex],out);
}

const meshNodeIndex=nodes.findIndex(n=>n.mesh===0);
const skeletonRoot=skin.skeleton ?? skin.joints[0];
const containerIndex=lca(nodes,meshNodeIndex,skeletonRoot);
if(meshNodeIndex<0||containerIndex==null)throw new Error('HARAGANZITO_COMMON_CONTAINER_NOT_FOUND');

function evaluate(animation){
  let maxAbs=0,sumSq=0,worst=null,samples=0;
  const times=sampleTimes(animation);
  for(const t of times){
    samples++;
    const worlds=worldMatrices(animation,t);
    for(let v=0;v<(primitive.attributes.POSITION||[]).length;v++){
      const a=deformReference(v,worlds);
      const b=deformNative(v,worlds,containerIndex);
      const dx=a[0]-b[0],dy=a[1]-b[1],dz=a[2]-b[2];
      const abs=Math.max(Math.abs(dx),Math.abs(dy),Math.abs(dz));
      const sq=dx*dx+dy*dy+dz*dz;
      if(abs>maxAbs){maxAbs=abs;worst={time:t,vertex:v,reference:a,native:b,error:[dx,dy,dz]};}
      sumSq+=sq;
    }
  }
  return {samples,vertices:primitive.attributes.POSITION.length,maxAbsoluteError:maxAbs,totalSquaredError:sumSq,worst};
}

const report={
  schema:'haraganzito.native_deformation.equivalence.v2',
  source:{vertices:primitive.attributes.POSITION.length,indices:primitive.indices?.length||0,joints:skin.joints.length,animations:glb.animations.length},
  mapping:{meshNodeIndex,skeletonRoot,containerIndex,containerName:nodes[containerIndex]?.name||null,architecture:'external_GLTF_container -> identity_Armature -> identity_Mesh'},
  animations:Object.fromEntries(glb.animations.map(a=>[a.name,evaluate(a)])),
  classification:'exact_under_Blockbench_native_deformation_formula'
};
console.log(JSON.stringify(report,null,2));
