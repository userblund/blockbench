#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const parser = require(path.resolve(__dirname, '../plugins/haraganzito_glb_parser.js'));

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/haraganzito_bind_space_check.js <model.glb>');
  process.exit(2);
}

const bytes = fs.readFileSync(file);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const glb = parser.parseGLB(buffer);
const skin = glb.skins?.[0];
if (!skin) throw new Error('No skin');
const primitive = glb.meshes?.[0]?.primitives?.[0];
if (!primitive) throw new Error('No first primitive');

function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      for (let k = 0; k < 4; k++) {
        o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
      }
    }
  }
  return o;
}

function identity() {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
}

function transpose(m) {
  return [
    m[0],m[4],m[8],m[12],
    m[1],m[5],m[9],m[13],
    m[2],m[6],m[10],m[14],
    m[3],m[7],m[11],m[15]
  ];
}

function invert(m) {
  const a = [
    [m[0],m[4],m[8],m[12]],
    [m[1],m[5],m[9],m[13]],
    [m[2],m[6],m[10],m[14]],
    [m[3],m[7],m[11],m[15]]
  ];
  const inv = [
    [1,0,0,0],
    [0,1,0,0],
    [0,0,1,0],
    [0,0,0,1]
  ];
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let row = col + 1; row < 4; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-14) throw new Error('Singular matrix');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [inv[col], inv[pivot]] = [inv[pivot], inv[col]];
    const d = a[col][col];
    for (let j = 0; j < 4; j++) {
      a[col][j] /= d;
      inv[col][j] /= d;
    }
    for (let row = 0; row < 4; row++) {
      if (row === col) continue;
      const f = a[row][col];
      for (let j = 0; j < 4; j++) {
        a[row][j] -= f * a[col][j];
        inv[row][j] -= f * inv[col][j];
      }
    }
  }
  const out = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[c * 4 + r] = inv[r][c];
  return out;
}

function maxAbsDiff(a, b) {
  let e = 0;
  for (let i = 0; i < 16; i++) e = Math.max(e, Math.abs(a[i] - b[i]));
  return e;
}

function normalize4(q) {
  const n = Math.hypot(q[0],q[1],q[2],q[3]) || 1;
  return q.map(v => v / n);
}

function quatMatrix(q) {
  const [x,y,z,w] = normalize4(q);
  return [
    1-2*(y*y+z*z), 2*(x*y+z*w), 2*(x*z-y*w), 0,
    2*(x*y-z*w), 1-2*(x*x+z*z), 2*(y*z+x*w), 0,
    2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y), 0,
    0,0,0,1
  ];
}

function trs(t, q, s) {
  const m = quatMatrix(q);
  m[0]*=s[0]; m[1]*=s[0]; m[2]*=s[0];
  m[4]*=s[1]; m[5]*=s[1]; m[6]*=s[1];
  m[8]*=s[2]; m[9]*=s[2]; m[10]*=s[2];
  m[12]=t[0]; m[13]=t[1]; m[14]=t[2];
  return m;
}

function lerp(a,b,u) {
  return a.map((v,i)=>v+(b[i]-v)*u);
}

function nlerp(a,b,u) {
  let bb = b.slice();
  let dot = a.reduce((s,v,i)=>s+v*bb[i],0);
  if (dot < 0) bb = bb.map(v=>-v);
  return normalize4(lerp(a,bb,u));
}

function sample(sampler, t, pathName) {
  const xs = sampler.input;
  if (!xs.length) return pathName === 'rotation' ? [0,0,0,1] : pathName === 'scale' ? [1,1,1] : [0,0,0];
  if (t <= xs[0]) return sampler.output[0].slice();
  if (t >= xs[xs.length-1]) return sampler.output[xs.length-1].slice();
  let hi = 1;
  while (hi < xs.length && xs[hi] < t) hi++;
  const lo = hi - 1;
  const u = (t - xs[lo]) / ((xs[hi]-xs[lo]) || 1);
  if ((sampler.interpolation || 'LINEAR') === 'STEP') return sampler.output[lo].slice();
  if ((sampler.interpolation || 'LINEAR') !== 'LINEAR') throw new Error('Unsupported interpolation: ' + sampler.interpolation);
  return pathName === 'rotation' ? nlerp(sampler.output[lo], sampler.output[hi], u) : lerp(sampler.output[lo], sampler.output[hi], u);
}

function nodeParentMap(nodes) {
  const parents = {};
  nodes.forEach((node, index) => (node.children || []).forEach(child => parents[child] = index));
  return parents;
}

const parents = nodeParentMap(glb.nodes);

function findLCA(a,b) {
  const ancestors = new Set();
  let cursor = a;
  while (cursor != null) {
    ancestors.add(cursor);
    cursor = parents[cursor];
  }
  cursor = b;
  while (cursor != null) {
    if (ancestors.has(cursor)) return cursor;
    cursor = parents[cursor];
  }
  return null;
}

const meshNodeIndex = glb.nodes.findIndex(n => n.mesh === 0);
const skeletonRoot = skin.skeleton ?? skin.joints[0];
const containerNodeIndex = findLCA(meshNodeIndex, skeletonRoot);
if (meshNodeIndex < 0 || containerNodeIndex == null) throw new Error('Could not find skin container');

function worldMatrices(animation, t) {
  const cache = new Array(glb.nodes.length);

  function local(index) {
    const base = glb.nodes[index].local || {};
    let translation = (base.translation || [0,0,0]).slice();
    let rotation = (base.rotation || [0,0,0,1]).slice();
    let scale = (base.scale || [1,1,1]).slice();

    if (animation) {
      for (const channel of animation.channels || []) {
        if (channel.targetNode !== index) continue;
        const sampler = animation.samplers[channel.sampler];
        const value = sample(sampler, t, channel.path);
        if (channel.path === 'translation') translation = value;
        else if (channel.path === 'rotation') rotation = value;
        else if (channel.path === 'scale') scale = value;
      }
    }
    return trs(translation, rotation, scale);
  }

  function world(index) {
    if (cache[index]) return cache[index];
    const localMatrix = local(index);
    cache[index] = parents[index] == null ? localMatrix : mul(world(parents[index]), localMatrix);
    return cache[index];
  }

  for (let i = 0; i < glb.nodes.length; i++) world(i);
  return cache;
}

function sampleTimes(animation) {
  const times = [0];
  for (const sampler of animation.samplers || []) for (const t of sampler.input || []) times.push(t);
  times.sort((a,b)=>a-b);
  const unique = [];
  for (const t of times) if (!unique.length || Math.abs(t-unique[unique.length-1]) > 1e-9) unique.push(t);
  const out = [];
  for (let i=0; i<unique.length; i++) {
    out.push(unique[i]);
    if (i + 1 < unique.length) out.push((unique[i] + unique[i+1]) / 2);
  }
  return out;
}

function evaluateAnimation(animation) {
  const maxPerJoint = new Array(skin.joints.length).fill(0);
  const containerWorld = worldMatrices(animation, 0)[containerNodeIndex];
  const containerInverse = invert(containerWorld);
  const meshWorldAtBind = worldMatrices(null, 0)[meshNodeIndex];
  const meshLocal = mul(containerInverse, meshWorldAtBind);
  const meshLocalInverse = invert(meshLocal);

  const nativeIBMs = skin.inverseBindMatrices.map(ibm => mul(ibm, containerInverse));
  let maxError = 0;
  let worst = null;

  for (const t of sampleTimes(animation)) {
    const worlds = worldMatrices(animation, t);
    const sourceBindContainer = worlds[containerNodeIndex];

    for (let j = 0; j < skin.joints.length; j++) {
      const jointWorld = worlds[skin.joints[j]];
      const rawIBM = skin.inverseBindMatrices[j];
      const gltfLocalSkin = mul(containerInverse, mul(jointWorld, rawIBM));

      /*
       * Blockbench's Armature.calculateVertexDeformation uses:
       *
       *   B^-1 * Aparent^-1 * BoneWorld * NativeIBM * B
       *
       * Here the imported Armature is the root object (Aparent=I) and
       * B is the mesh world matrix, so the native candidate is:
       */
      const blockbenchLocalSkin =
        mul(meshLocalInverse, mul(jointWorld, mul(nativeIBMs[j], meshLocal)));

      const error = maxAbsDiff(gltfLocalSkin, blockbenchLocalSkin);
      maxError = Math.max(maxError, error);
      maxPerJoint[j] = Math.max(maxPerJoint[j], error);
      if (!worst || error > worst.error) {
        worst = {time:t, jointIndex:j, jointNode:skin.joints[j], error};
      }
    }
  }

  return {
    samples: sampleTimes(animation).length,
    meshNodeIndex,
    skeletonRoot,
    containerNodeIndex,
    containerName: glb.nodes[containerNodeIndex]?.name || null,
    meshLocalTransform: meshLocal,
    maxMatrixError: maxError,
    worst,
    maxMatrixErrorByJoint: maxPerJoint
  };
}

const animations = glb.animations.map(evaluateAnimation);
const report = {
  schema: 'haraganzito.bind_space_validation.v1',
  source: {
    vertices: primitive.attributes?.POSITION?.length || 0,
    joints: skin.joints.length,
    animations: glb.animations.length
  },
  mapping: {
    meshNodeIndex,
    skeletonRoot,
    containerNodeIndex,
    containerName: glb.nodes[containerNodeIndex]?.name || null,
    rule: 'nativeIBM = gltfIBM * inverse(containerWorld)'
  },
  animations,
  classification: {
    coordinateSpaceMapping:
      animations.every(a => a.maxMatrixError <= 1e-6)
        ? 'exact_under_blockbench_armature_math'
        : 'mapping_requires_review'
  }
};

console.log(JSON.stringify(report, null, 2));
