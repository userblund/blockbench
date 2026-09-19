/**
 * Haraganzito GLB -> Bedrock bridge foundation.
 *
 * This plugin deliberately preserves the source GLB as the ground truth.
 * It does NOT claim that Bedrock can losslessly encode arbitrary skinning.
 * The analyzer records the representation requirements and creates a
 * machine-readable intermediate manifest for later bridge/iteration work.
 */
(function() {
  'use strict';

  const plugin = {
    title: 'Haraganzito GLB Bridge',
    author: 'userblund',
    description: 'Ground-truth and iterative bridge foundation for rigged GLB -> Bedrock.',
    icon: 'icon-import',
    version: '0.5.0'
  };

  function analyzeGLTFDocument(gltf) {
    const meshes = gltf.meshes || [];
    const skins = gltf.skins || [];
    const animations = gltf.animations || [];
    const nodes = gltf.nodes || [];

    const report = {
      schema: 'haraganzito.bridge.intermediate.v1',
      source: {
        format: 'glTF 2.0 / GLB',
        meshes: meshes.length,
        skins: skins.length,
        nodes: nodes.length,
        animations: animations.length
      },
      requirements: {
        positions: false,
        normals: false,
        texcoords0: false,
        indices: false,
        joints0: false,
        weights0: false,
        inverseBindMatrices: false,
        animationTranslation: false,
        animationRotation: false,
        animationScale: false
      },
      preservation: {
        originalDocumentRequired: true,
        arbitraryVertexWeightsRequired: true,
        skeletonHierarchyRequired: true,
        bindPoseRequired: true,
        animationTracksRequired: true
      }
    };

    for (const mesh of meshes) {
      for (const primitive of (mesh.primitives || [])) {
        const a = primitive.attributes || {};
        report.requirements.positions ||= a.POSITION !== undefined;
        report.requirements.normals ||= a.NORMAL !== undefined;
        report.requirements.texcoords0 ||= a.TEXCOORD_0 !== undefined;
        report.requirements.joints0 ||= a.JOINTS_0 !== undefined;
        report.requirements.weights0 ||= a.WEIGHTS_0 !== undefined;
        report.requirements.indices ||= primitive.indices !== undefined;
      }
    }

    for (const skin of skins) {
      report.requirements.inverseBindMatrices ||= skin.inverseBindMatrices !== undefined;
    }

    for (const animation of animations) {
      for (const channel of (animation.channels || [])) {
        const path = channel.target && channel.target.path;
        report.requirements.animationTranslation ||= path === 'translation';
        report.requirements.animationRotation ||= path === 'rotation';
        report.requirements.animationScale ||= path === 'scale';
      }
    }

    return report;
  }

  function captureArmatureSkinning(armature) {
    if (!armature || typeof armature.getAllBones !== 'function') {
      throw new Error('HARAGANZITO_NO_ARMATURE');
    }
    const bones = armature.getAllBones();
    const meshes = armature.children.filter(child => child instanceof Mesh);
    const result = {
      schema: 'haraganzito.skinning.intermediate.v2',
      armature: {name: armature.name, uuid: armature.uuid},
      bones: bones.map((bone, index) => ({
        index,
        uuid: bone.uuid,
        name: bone.name,
        parent: bone.parent && bone.parent.name ? bone.parent.name : null,
        origin: Array.from(bone.origin || []),
        rotation: Array.from(bone.rotation || []),
        vertex_weights: {}
      })),
      meshes: []
    };

    for (const mesh of meshes) {
      const meshRecord = {
        uuid: mesh.uuid,
        name: mesh.name,
        vertices: Object.keys(mesh.vertices || {}).length,
        weights: {},
      sourceWeightingPreserved: true
      };
      for (const vkey of Object.keys(mesh.vertices || {})) {
        const influences = [];
        for (let i = 0; i < bones.length; i++) {
          const weight = bones[i].getVertexWeight(mesh, vkey);
          if (weight > 0) influences.push({bone: i, weight});
        }
        influences.sort((a, b) => b.weight - a.weight);
        const originalSum = influences.reduce((s, x) => s + x.weight, 0);
        const allInfluences = influences.map(x => ({bone: x.bone, weight: x.weight}));

        // Keep the complete source weighting. A top-4 projection is only a
        // candidate representation and must never overwrite the ground truth.
        const top4 = influences.slice(0, 4).map(x => ({bone: x.bone, weight: x.weight}));
        const top4Sum = top4.reduce((s, x) => s + x.weight, 0);
        if (top4Sum > 0) {
          top4.forEach(x => x.weight /= top4Sum);
        }

        meshRecord.weights[vkey] = {
          all: allInfluences,
          top4Normalized: top4,
          originalSum,
          discardedInfluenceWeight: Math.max(0, originalSum - top4Sum),
          influenceCount: influences.length
        };
      }
      result.meshes.push(meshRecord);
    }

    return result;
  }

  function validateSkinningManifest(manifest) {
    const result = {
      schema: 'haraganzito.skinning.validation.v1',
      exact: true,
      errors: [],
      warnings: [],
      vertices: 0,
      verticesWithWeights: 0,
      maxInfluences: 0,
      weightSumErrorMax: 0
    };
    for (const mesh of (manifest.meshes || [])) {
      for (const key of Object.keys(mesh.weights || {})) {
        const record = mesh.weights[key];
        const influences = Array.isArray(record) ? record : (record?.all || []);
        result.vertices++;
        if (influences.length) result.verticesWithWeights++;
        result.maxInfluences = Math.max(result.maxInfluences, influences.length);
        const sum = influences.reduce((s, x) => s + x.weight, 0);
        result.weightSumErrorMax = Math.max(result.weightSumErrorMax, Math.abs(sum - (influences.length ? 1 : 0)));
        if (influences.length > 4) {
          result.warnings.push({mesh: mesh.name, vertex: key, reason: 'more_than_4_influences'});
        }
        if (!Array.isArray(record) && record && record.discardedInfluenceWeight > 0) {
          result.exact = false;
          result.errors.push({
            mesh: mesh.name,
            vertex: key,
            reason: 'candidate_projection_discards_weight',
            discardedInfluenceWeight: record.discardedInfluenceWeight
          });
        }
      }
    }
    return result;
  }

  function compareIterations(previous, current) {
    const p = previous || {};
    const c = current || {};
    const fields = ['geometry', 'skinning', 'animation', 'materials', 'uv'];
    const delta = {};
    let improved = false;
    for (const field of fields) {
      const before = Number.isFinite(p[field]) ? p[field] : null;
      const after = Number.isFinite(c[field]) ? c[field] : null;
      delta[field] = {before, after, improvement: before !== null && after !== null ? before - after : null};
      if (delta[field].improvement !== null && delta[field].improvement > 0) improved = true;
    }
    return {
      schema: 'haraganzito.iteration.v1',
      improved,
      exact: fields.every(field => c[field] === 0),
      delta
    };
  }

  BBPlugin.register('haraganzito_bridge', {
    title: plugin.title,
    author: plugin.author,
    description: plugin.description,
    icon: plugin.icon,
    version: plugin.version,
    variant: 'both',
    onload() {
      window.HaraganzitoBridge = {
        version: plugin.version,
        status: 'experimental_bridge',
        analyzeGLTFDocument,
        captureArmatureSkinning,
        validateSkinningManifest,
        compareIterations,
        metricDefinition: {
          geometry: 'sum_i ||v_source(i)-v_candidate(i)||^2',
          animation: 'sum_t sum_i ||v_source(i,t)-v_candidate(i,t)||^2',
          classification: {
            exact: 'error == 0 under the declared metric',
            maximum_reached: 'positive minimum demonstrated for current representation',
            undetermined: 'insufficient search or proof'
          }
        }
      };
      console.log('[HaraganzitoBridge] v' + plugin.version + ' loaded');
    },
    onunload() {
      delete window.HaraganzitoBridge;
    }
  });
})();
