#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function fail(message) {
  console.error('HARAGANZITO V2 CHECK FAILED');
  console.error(message);
  process.exit(1);
}

const file = process.argv[2];
if (!file) fail('Usage: node tools/haraganzito_v2_roundtrip_check.js <model.glb>');

const bytes = fs.readFileSync(file);
const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) {
  fail('Not a GLB 2.0 file');
}

let offset = 12;
let json = null;
let binary = null;
while (offset + 8 <= bytes.length) {
  const chunkLength = dv.getUint32(offset, true);
  const chunkType = dv.getUint32(offset + 4, true);
  const start = offset + 8;
  const end = start + chunkLength;
  if (end > bytes.length) fail('Truncated GLB chunk');
  if (chunkType === 0x4e4f534a) {
    json = JSON.parse(Buffer.from(bytes.slice(start, end)).toString('utf8').replace(/\0+$/, ''));
  } else if (chunkType === 0x004e4942) {
    binary = bytes.slice(start, end);
  }
  offset = (end + 3) & ~3;
}

if (!json || !binary) fail('GLB JSON/BIN chunks missing');

const components = {
  5120: [1, (d, o) => d.getInt8(o)],
  5121: [1, (d, o) => d.getUint8(o)],
  5122: [2, (d, o) => d.getInt16(o, true)],
  5123: [2, (d, o) => d.getUint16(o, true)],
  5125: [4, (d, o) => d.getUint32(o, true)],
  5126: [4, (d, o) => d.getFloat32(o, true)]
};
const componentCounts = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16};

function readAccessor(index) {
  const accessor = json.accessors[index];
  if (!accessor) fail('Missing accessor ' + index);
  if (accessor.sparse) fail('Sparse accessor is not supported by this checker');
  const component = components[accessor.componentType];
  const count = componentCounts[accessor.type];
  if (!component || !count) fail('Unsupported accessor ' + index);
  const view = json.bufferViews[accessor.bufferView];
  if (!view) fail('Missing bufferView ' + accessor.bufferView);

  const dv = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const base = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const stride = view.byteStride || component[0] * count;
  const out = [];

  for (let i = 0; i < accessor.count; i++) {
    const values = [];
    for (let j = 0; j < count; j++) {
      values.push(component[1](dv, base + i * stride + j * component[0]));
    }
    out.push(values);
  }
  return out;
}

const primitive = json.meshes?.[0]?.primitives?.[0];
if (!primitive) fail('First mesh primitive missing');

const positions = readAccessor(primitive.attributes.POSITION);
const joints = readAccessor(primitive.attributes.JOINTS_0);
const weights = readAccessor(primitive.attributes.WEIGHTS_0);
const indices = readAccessor(primitive.indices).map(v => v[0]);
const skin = json.skins?.[0];
if (!skin) fail('Skin missing');

const inverseBindMatrices = readAccessor(skin.inverseBindMatrices);
const animations = json.animations || [];

const candidate = {
  schema: 'haraganzito.candidate.native_blockbench_weighted_armature.v1',
  route: 'native_blockbench_weighted_armature',
  mesh: {
    positions: positions.map(v => v.slice()),
    joints: joints.map(v => v.slice()),
    weights: weights.map(v => v.slice()),
    indices: indices.slice()
  },
  skeleton: {
    joints: skin.joints.map((nodeIndex, boneIndex) => ({
      index: boneIndex,
      nodeIndex,
      name: json.nodes?.[nodeIndex]?.name || ('bone_' + nodeIndex),
      parentNode: json.nodes?.findIndex(node => (node.children || []).includes(nodeIndex)) ?? -1,
      inverseBindMatrix: inverseBindMatrices[boneIndex].map(v => v.slice())
    }))
  },
  animations: animations.map(animation => ({
    name: animation.name || '',
    samplers: animation.samplers.map(sampler => ({
      input: readAccessor(sampler.input),
      output: readAccessor(sampler.output),
      interpolation: sampler.interpolation || 'LINEAR'
    })),
    channels: animation.channels.map(channel => ({
      sampler: channel.sampler,
      targetNode: channel.target?.node ?? null,
      path: channel.target?.path || null
    }))
  }))
};

let maxAbsoluteError = 0;
let weightSumErrorMax = 0;
let indexMismatchCount = 0;
let animationMismatchCount = 0;

for (let i = 0; i < positions.length; i++) {
  for (let j = 0; j < positions[i].length; j++) {
    maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(candidate.mesh.positions[i][j] - positions[i][j]));
  }
  for (let j = 0; j < joints[i].length; j++) {
    maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(candidate.mesh.joints[i][j] - joints[i][j]));
  }
  for (let j = 0; j < weights[i].length; j++) {
    maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(candidate.mesh.weights[i][j] - weights[i][j]));
  }
  const sum = weights[i].reduce((a, b) => a + b, 0);
  weightSumErrorMax = Math.max(weightSumErrorMax, Math.abs(sum - 1));
}

if (candidate.mesh.indices.length !== indices.length) {
  indexMismatchCount = 1;
} else {
  for (let i = 0; i < indices.length; i++) {
    if (candidate.mesh.indices[i] !== indices[i]) {
      indexMismatchCount++;
      break;
    }
  }
}

for (let i = 0; i < animations.length; i++) {
  const sourceAnimation = animations[i];
  const candidateAnimation = candidate.animations[i];

  if (!candidateAnimation ||
      candidateAnimation.samplers.length !== sourceAnimation.samplers.length ||
      candidateAnimation.channels.length !== sourceAnimation.channels.length) {
    animationMismatchCount++;
    continue;
  }

  for (let s = 0; s < sourceAnimation.samplers.length; s++) {
    const sourceSampler = sourceAnimation.samplers[s];
    const candidateSampler = candidateAnimation.samplers[s];
    if ((sourceSampler.interpolation || 'LINEAR') !== candidateSampler.interpolation) {
      animationMismatchCount++;
      continue;
    }

    const sourceInput = readAccessor(sourceSampler.input);
    const sourceOutput = readAccessor(sourceSampler.output);
    for (let k = 0; k < sourceInput.length; k++) {
      if (sourceInput[k][0] !== candidateSampler.input[k][0]) animationMismatchCount++;
    }
    for (let k = 0; k < sourceOutput.length; k++) {
      for (let j = 0; j < sourceOutput[k].length; j++) {
        if (sourceOutput[k][j] !== candidateSampler.output[k][j]) animationMismatchCount++;
      }
    }
  }
}

const report = {
  schema: 'haraganzito.v2.native_weighted_roundtrip.v1',
  source: {
    bytes: bytes.length,
    vertices: positions.length,
    indices: indices.length,
    joints: skin.joints.length,
    animations: animations.length
  },
  candidate: {
    route: candidate.route,
    vertices: candidate.mesh.positions.length,
    bones: candidate.skeleton.joints.length,
    animations: candidate.animations.length,
    maxInfluencesPerVertex: Math.max(0, ...weights.map(v => v.length))
  },
  preservation: {
    maxAbsoluteAttributeError,
    indexMismatchCount,
    animationMismatchCount,
    weightSumErrorMax
  },
  classification: {
    sourceDataPreservation:
      maxAbsoluteError === 0 &&
      indexMismatchCount === 0 &&
      animationMismatchCount === 0
        ? 'exact_data_preservation'
        : 'not_exact',
    skinning:
      weights.every(v => v.length === 4) &&
      weightSumErrorMax < 1e-6
        ? '4_influences_per_vertex_preserved'
        : 'weight_structure_requires_review',
    vanillaBedrockRuntime: 'not_determined'
  }
};

console.log(JSON.stringify(report, null, 2));
