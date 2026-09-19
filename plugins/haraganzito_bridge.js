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
    version: '0.3.0'
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
      schema: 'haraganzito.skinning.intermediate.v1',
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
        weights: {}
      };
      for (const vkey of Object.keys(mesh.vertices || {})) {
        const influences = [];
        for (let i = 0; i < bones.length; i++) {
          const weight = bones[i].getVertexWeight(mesh, vkey);
          if (weight > 0) influences.push({bone: i, weight});
        }
        influences.sort((a, b) => b.weight - a.weight);
        const top4 = influences.slice(0, 4);
        const sum = top4.reduce((s, x) => s + x.weight, 0);
        if (sum > 0) {
          top4.forEach(x => x.weight /= sum);
        }
        meshRecord.weights[vkey] = top4;
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
        const influences = mesh.weights[key];
        result.vertices++;
        if (influences.length) result.verticesWithWeights++;
        result.maxInfluences = Math.max(result.maxInfluences, influences.length);
        const sum = influences.reduce((s, x) => s + x.weight, 0);
        result.weightSumErrorMax = Math.max(result.weightSumErrorMax, Math.abs(sum - (influences.length ? 1 : 0)));
        if (influences.length > 4) {
          result.exact = false;
          result.errors.push({mesh: mesh.name, vertex: key, reason: 'more_than_4_influences'});
        }
      }
    }
    return result;
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
      console.log('[HaraganzitoBridge] v0.1.0 loaded');
    },
    onunload() {
      delete window.HaraganzitoBridge;
    }
  });
})();
