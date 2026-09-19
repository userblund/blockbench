#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const parser = require(path.resolve(__dirname, '../plugins/haraganzito_glb_parser.js'));

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/haraganzito_route_metrics.js <model.glb>');
  process.exit(2);
}

function mul(a,b) {
  const o = new Array(16).fill(0);
  for (let c=0;c<4;c++) for (let r=0;r<4;r++) {
    for (let k=0;k<4;k++) o[c*4+r] += a[k*4+r] * b[c*4+k];
  }
  return o;
}
function transform(m,v) {
  return [
    m[0]*v[0] + m[4]*v[1] + m[8]*v[2] + m[12],
    m[1]*v[0] + m[5]*v[1] + m[9]*v[2] + m[13],
    m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]
  ];
}
function normalize4(q) {
  const n = Math.hypot(q[0],q[1],q[2],q[3]) || 1;
  return q.map(v=>v/n);
}
function quatMatrix(q) {
  const [x,y,z,w] = normalize4(q);
  return [
    1-2*(y*y+z*z), 2*(x*y+z*w),   2*(x*z-y*w),   0,
    2*(x*y-z*w),   1-2*(x*x+z*z), 2*(y*z+x*w),   0,
    2*(x*z+y*w),   2*(y*z-x*w),   1-2*(x*x+y*y), 0,
    0,0,0,1
  ];
}
function trs(t,q,s) {
  const m = quatMatrix(q);
  m[0]*=s[0];m[1]*=s[0];m[2]*=s[0];
  m[4]*=s[1];m[5]*=s[1];m[6]*=s[1];
  m[8]*=s[2];m[9]*=s[2];m[10]*=s[2];
  m[12]=t[0];m[13]=t[1];m[14]=t[2];
  return m;
}
function lerp(a,b,u) { return a.map((v,i)=>v+(b[i]-v)*u); }
function nlerp(a,b,u) {
  let bb=b.slice();
  let dot=0; for(let i=0;i<4;i++) dot += a[i]*bb[i];
  if(dot<0) bb=bb.map(v=>-v);
  return normalize4(lerp(a,bb,u));
}
function sample(s,t,path) {
  const xs=s.input;
  if (!xs.length) return path==='rotation'?[0,0,0,1]:path==='scale'?[1,1,1]:[0,0,0];
  if (t<=xs[0]) return s.output[0].slice();
  if (t>=xs[xs.length-1]) return s.output[xs.length-1].slice();
  let hi=1; while (hi<xs.length && xs[hi]<t) hi++;
  const lo=hi-1, u=(t-xs[lo])/((xs[hi]-xs[lo])||1);
  if (s.interpolation==='STEP') return s.output[lo].slice();
  if (s.interpolation!=='LINEAR') throw new Error('Unsupported interpolation: '+s.interpolation);
  return path==='rotation' ? nlerp(s.output[lo],s.output[hi],u) : lerp(s.output[lo],s.output[hi],u);
}

const bytes = fs.readFileSync(file);
const buffer = bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
const glb = parser.parseGLB(buffer);
const prim = glb.meshes[0]?.primitives[0];
if (!prim) throw new Error('No first primitive');
const pos = prim.attributes.POSITION || [];
const joints = prim.attributes.JOINTS_0 || [];
const weights = prim.attributes.WEIGHTS_0 || [];
const skin = glb.skins[0];
if (!skin) throw new Error('No skin');

const nodes=glb.nodes;
function worldMatrices(animation,t) {
  const cache=new Array(nodes.length), visiting=new Uint8Array(nodes.length);
  function local(i) {
    const n=nodes[i], base=n.local || {};
    let tt=(base.translation||[0,0,0]).slice();
    let rr=(base.rotation||[0,0,0,1]).slice();
    let ss=(base.scale||[1,1,1]).slice();
    if(animation) for(const ch of animation.channels) if(ch.targetNode===i) {
      const v=sample(animation.samplers[ch.sampler],t,ch.path);
      if(ch.path==='translation') tt=v;
      else if(ch.path==='rotation') rr=v;
      else if(ch.path==='scale') ss=v;
    }
    return trs(tt,rr,ss);
  }
  function rec(i) {
    if(cache[i]) return cache[i];
    if(visiting[i]) throw new Error('Node cycle');
    visiting[i]=1;
    const p=nodes[i].parent;
    cache[i]=p==null ? local(i) : mul(rec(p),local(i));
    visiting[i]=0;
    return cache[i];
  }
  for(let i=0;i<nodes.length;i++) rec(i);
  return cache;
}
function skinMatrices(animation,t) {
  const worlds=worldMatrices(animation,t);
  return skin.joints.map((nodeIndex,j)=>mul(worlds[nodeIndex],skin.inverseBindMatrices[j]));
}
function deform(v,mats,rigid) {
  const js=joints[v], ws=weights[v];
  if(rigid) {
    let best=0, bestW=-1;
    for(let k=0;k<ws.length;k++) if(ws[k]>bestW){bestW=ws[k];best=js[k];}
    return transform(mats[best],pos[v]);
  }
  const out=[0,0,0];
  for(let k=0;k<js.length;k++) if(ws[k]!==0) {
    const p=transform(mats[js[k]],pos[v]), w=ws[k];
    out[0]+=w*p[0];out[1]+=w*p[1];out[2]+=w*p[2];
  }
  return out;
}
function sampleTimes(animation) {
  const times=[0];
  for(const s of animation.samplers) for(const t of s.input) times.push(t);
  times.sort((a,b)=>a-b);
  const u=[]; for(const t of times) if(!u.length || Math.abs(t-u[u.length-1])>1e-9) u.push(t);
  const out=[];
  for(let i=0;i<u.length;i++){ out.push(u[i]); if(i+1<u.length) out.push((u[i]+u[i+1])/2); }
  return out;
}
function evaluate(animation) {
  const times=sampleTimes(animation);
  let sum=0,max=0,maxRMSE=0,worstTime=0;
  for(const t of times) {
    const mats=skinMatrices(animation,t);
    let e=0,maxV=0;
    for(let v=0;v<pos.length;v++) {
      const a=deform(v,mats,false), b=deform(v,mats,true);
      const dx=a[0]-b[0],dy=a[1]-b[1],dz=a[2]-b[2];
      const d2=dx*dx+dy*dy+dz*dz;
      e+=d2; if(d2>maxV) maxV=d2;
    }
    if(!Number.isFinite(e)) throw new Error('Non-finite route error at '+(animation?.name||'bind')+' t='+t);
    const rmse=Math.sqrt(e/pos.length);
    sum+=e;
    if(e>max){max=e;worstTime=t;}
    if(rmse>maxRMSE) maxRMSE=rmse;
  }
  return {samples:times.length,sumErrorSquared:sum,maxSampleErrorSquared:max,meanSampleErrorSquared:sum/times.length,maxRMSE,worstTime};
}

const influenceStats={vertices:pos.length,nonRigidVertices:0,minDominantWeight:1,maxDominantWeight:0,meanDominantWeight:0};
for(let v=0;v<pos.length;v++){
  const mx=Math.max(...weights[v]);
  if(mx<0.999999999) influenceStats.nonRigidVertices++;
  influenceStats.minDominantWeight=Math.min(influenceStats.minDominantWeight,mx);
  influenceStats.maxDominantWeight=Math.max(influenceStats.maxDominantWeight,mx);
  influenceStats.meanDominantWeight+=mx;
}
influenceStats.meanDominantWeight/=pos.length;

const results=glb.animations.map(a=>({
  name:a.name,
  duration:Math.max(0,...a.samplers.flatMap(s=>s.input||[])),
  ...evaluate(a)
}));
const report={
  schema:'haraganzito.route.metrics.v1',
  source:parser.summarize(glb),
  influenceStats,
  routes:{
    rigidDominantBone:{
      status:'measured_lossy',
      definition:'Idealized single-dominant-joint skinning using the GLB inverse-bind matrices and sampled GLB animations.',
      animations:results,
      aggregate:{
        totalSampleErrorSquared:results.reduce((s,r)=>s+r.sumErrorSquared,0),
        maxAnimationErrorSquared:Math.max(...results.map(r=>r.maxSampleErrorSquared)),
        maxAnimationRMSE:Math.max(...results.map(r=>r.maxRMSE))
      }
    },
    fullWeightedReference:{
      status:'representational_reference',
      definition:'Full JOINTS_0 + WEIGHTS_0 + inverse-bind + animation reconstruction from the original GLB.',
      expectedErrorSquared:0
    }
  },
  classification:{
    rigidDominantBone:'not_exact_for_this_GLB',
    fullWeightedReference:'exact_reconstruction_in_the_reference_representation',
    vanillaBedrockRuntimeSupport:'not_determined_by_this_tool'
  }
};
console.log(JSON.stringify(report,null,2));
