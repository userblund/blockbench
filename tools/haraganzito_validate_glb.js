#!/usr/bin/env node
const fs = require('node:fs');
const process = require('node:process');
const path = require('node:path');

const parser = require(path.resolve(__dirname, '../plugins/haraganzito_glb_parser.js'));

function fail(message, detail) {
  console.error('HARAGANZITO GLB VALIDATION FAILED');
  console.error(message);
  if (detail) console.error(detail);
  process.exit(1);
}

const file = process.argv[2];
if (!file) fail('Usage: node tools/haraganzito_validate_glb.js <model.glb>');

let bytes;
try {
  bytes = fs.readFileSync(file);
} catch (error) {
  fail('Cannot read GLB: ' + file, error.message);
}

try {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const intermediate = parser.parseGLB(buffer);
  const summary = parser.summarize(intermediate);
  const primitive = intermediate.meshes[0]?.primitives[0];
  const attrs = primitive?.attributes || {};
  const weights = attrs.WEIGHTS_0 || [];
  const joints = attrs.JOINTS_0 || [];

  const result = {
    summary,
    attributes: Object.keys(attrs),
    hasSkinIndices: joints.length === summary.vertices,
    hasSkinWeights: weights.length === summary.vertices,
    maxInfluencesPerVertex: Math.max(0, ...weights.map(v => v.length)),
    minWeightSum: weights.length ? Math.min(...weights.map(v => v.reduce((a,b) => a+b, 0))) : null,
    maxWeightSum: weights.length ? Math.max(...weights.map(v => v.reduce((a,b) => a+b, 0))) : null,
    animationChannels: intermediate.animations.map(a => ({
      name: a.name,
      channels: a.channels.length,
      samplers: a.samplers.length,
      interpolationModes: [...new Set(a.samplers.map(s => s.interpolation))]
    }))
  };

  const failures = [];
  if (summary.meshes !== 1) failures.push('expected 1 mesh');
  if (summary.primitives !== 1) failures.push('expected 1 primitive');
  if (summary.vertices !== 33486) failures.push('expected 33486 vertices');
  if (summary.indices !== 150000) failures.push('expected 150000 indices');
  if (summary.skins !== 1) failures.push('expected 1 skin');
  if (summary.joints !== 22) failures.push('expected 22 joints');
  if (summary.animations !== 6) failures.push('expected 6 animations');
  if (!result.hasSkinIndices || !result.hasSkinWeights) failures.push('missing complete JOINTS_0/WEIGHTS_0');
  if (result.maxInfluencesPerVertex !== 4) failures.push('expected 4 influences per vertex');
  if (result.minWeightSum === null || Math.abs(result.minWeightSum - 1) > 1e-5) failures.push('weight sums are not normalized');
  if (result.maxWeightSum === null || Math.abs(result.maxWeightSum - 1) > 1e-5) failures.push('weight sums are not normalized');
  if (result.animationChannels.some(a => a.interpolationModes.some(mode => mode !== 'LINEAR'))) {
    failures.push('target GLB contains non-LINEAR interpolation');
  }

  console.log(JSON.stringify(result, null, 2));

  if (failures.length) {
    fail('Ground-truth invariants failed', failures.join('\n'));
  }

  console.log('HARAGANZITO GLB VALIDATION: OK');
} catch (error) {
  fail(error.message, error.stack);
}
