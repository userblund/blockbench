/**
 * Haraganzito native GLB importer for the Blockbench fork.
 *
 * This importer is intentionally different from the Bedrock poly_mesh route:
 * it constructs a native Blockbench Armature + Mesh and transfers all four
 * GLB vertex influences into ArmatureBone.vertex_weights.
 *
 * It also keeps an exact source animation payload on the project so the
 * animation adapter can be improved without destroying the original tracks.
 */
(function() {
  'use strict';

  const VERSION = '0.1.0';

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function quaternionToEuler(q) {
    const quat = new THREE.Quaternion().fromArray(q || [0, 0, 0, 1]).normalize();
    const e = new THREE.Euler().setFromQuaternion(quat, Format.euler_order);
    return [Math.radToDeg(e.x), Math.radToDeg(e.y), Math.radToDeg(e.z)];
  }

  function relativeQuaternionEuler(base, value) {
    const baseQ = new THREE.Quaternion().fromArray(base || [0, 0, 0, 1]).normalize();
    const valueQ = new THREE.Quaternion().fromArray(value || [0, 0, 0, 1]).normalize();
    const delta = baseQ.clone().invert().multiply(valueQ).normalize();
    return quaternionToEuler(delta.toArray());
  }

  function getBaseColorImage(intermediate, primitive) {
    const materialIndex = primitive?.material;
    const material = materialIndex == null ? null : intermediate.materials?.[materialIndex];
    const textureIndex = material?.pbrMetallicRoughness?.baseColorTexture?.index;
    const texture = textureIndex == null ? null : intermediate.textures?.[textureIndex];
    return texture?.source == null ? null : intermediate.images?.[texture.source] || null;
  }

  function makeTexture(intermediate, primitive) {
    const image = getBaseColorImage(intermediate, primitive);
    if (!image?.dataUrl) return null;

    const texture = new Texture({
      name: image.name || 'haraganzito_basecolor.png',
      saved: false
    });
    texture.fromDataURL(image.dataUrl).add(false);

    return texture;
  }

  function createProjectForImport(fileName) {
    if (typeof setupProject === 'function' && Formats?.free) {
      setupProject(Formats.free);
    }
    Project.name = (fileName || 'haraganzito').replace(/\.[^.]+$/, '');
    Project.geometry_name = 'haraganzito';
    Project.texture_width = 4096;
    Project.texture_height = 4096;
    return Project;
  }

  function makeMesh(intermediate, armature, primitive, texture) {
    const positions = primitive.attributes.POSITION || [];
    const uvs = primitive.attributes.TEXCOORD_0 || [];
    const indices = primitive.indices || [];

    const mesh = new Mesh({
      name: intermediate.meshes?.[0]?.name || 'HaraganzitoMesh',
      vertices: {}
    });
    mesh.addTo(armature);

    const vertexKeys = new Array(positions.length);
    for (let i = 0; i < positions.length; i++) {
      vertexKeys[i] = mesh.addVertices(positions[i])[0];
    }

    const faces = [];
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = indices[i];
      const b = indices[i + 1];
      const c = indices[i + 2];

      const uv = {};
      for (const index of [a, b, c]) {
        const tex = uvs[index] || [0, 0];
        uv[vertexKeys[index]] = [
          tex[0] * Project.texture_width,
          (1 - tex[1]) * Project.texture_height
        ];
      }

      const face = new MeshFace(mesh, {
        vertices: [vertexKeys[a], vertexKeys[b], vertexKeys[c]],
        uv,
        texture: texture || false
      });
      faces.push(face);
    }

    mesh.addFaces(...faces);
    mesh.init();

    /*
     * Mesh has no native per-vertex-normal field. Preserve the GLB normals
     * separately so the later poly_mesh compiler can reproduce them instead
     * of recalculating them from faces.
     */
    mesh.haraganzito_source_normals = clone(primitive.attributes.NORMAL || []);
    mesh.haraganzito_source_uvs = clone(uvs);
    mesh.haraganzito_source_indices = clone(indices);
    mesh.haraganzito_source_positions = clone(positions);

    return {mesh, vertexKeys};
  }

  function buildArmature(intermediate, skin) {
    const skeletonNode = skin.skeleton != null ? intermediate.nodes?.[skin.skeleton] : null;

    const armature = new Armature({
      name: skeletonNode?.name || 'HaraganzitoArmature'
    });
    armature.addTo(Outliner.ROOT);
    armature.init();

    if (skeletonNode) {
      const armatureMesh = armature.scene_object;
      const local = skeletonNode.local || {};
      armatureMesh.position.fromArray(local.translation || [0, 0, 0]);
      armatureMesh.quaternion.fromArray(local.rotation || [0, 0, 0, 1]).normalize();
      armatureMesh.scale.fromArray(local.scale || [1, 1, 1]);
      armatureMesh.updateMatrixWorld(true);
    }

    const boneMap = new Map();

    function createBoneRecursive(nodeIndex, parentElement) {
      const node = intermediate.nodes[nodeIndex];
      if (!node) return null;

      const boneIndex = skin.joints.indexOf(nodeIndex);
      if (boneIndex < 0) return null;

      const local = node.local || {};
      const euler = quaternionToEuler(local.rotation || [0, 0, 0, 1]);

      const bone = new ArmatureBone({
        name: node.name || ('bone_' + boneIndex),
        origin: [...(local.translation || [0, 0, 0])],
        rotation: euler,
        length: 1,
        width: 1
      });
      bone.addTo(parentElement);
      bone.init();

      bone.haraganzito_source_node_index = nodeIndex;
      bone.haraganzito_source_bone_index = boneIndex;
      bone.haraganzito_source_rotation_quaternion = clone(local.rotation || [0, 0, 0, 1]);
      bone.haraganzito_source_scale = clone(local.scale || [1, 1, 1]);
      boneMap.set(nodeIndex, bone);

      for (const childIndex of node.children || []) {
        if (skin.joints.includes(childIndex)) {
          createBoneRecursive(childIndex, bone);
        }
      }
      return bone;
    }

    const jointRoots = skin.joints.filter(nodeIndex => {
      const parent = intermediate.nodes?.[nodeIndex]?.parent;
      return parent == null || !skin.joints.includes(parent);
    });
    for (const rootIndex of jointRoots) createBoneRecursive(rootIndex, armature);

    /*
     * ArmatureBone.init() calculates its own inverse bind matrix. Replace it
     * with the actual GLB inverse bind matrix after hierarchy creation.
     */
    for (let i = 0; i < skin.joints.length; i++) {
      const nodeIndex = skin.joints[i];
      const bone = boneMap.get(nodeIndex);
      const ibm = skin.inverseBindMatrices?.[i];
      if (bone && ibm && bone.scene_object?.inverse_bind_matrix) {
        bone.scene_object.inverse_bind_matrix.fromArray(ibm);
      }
    }

    armature.haraganzito_bone_map = boneMap;
    return armature;
  }

  function transferWeights(intermediate, skin, armature, mesh, vertexKeys) {
    const primitive = intermediate.meshes[0].primitives[0];
    const joints = primitive.attributes.JOINTS_0 || [];
    const weights = primitive.attributes.WEIGHTS_0 || [];
    const bones = intermediate.nodes;
    const boneMap = armature.haraganzito_bone_map;

    const allInfluences = new Array(vertexKeys.length);

    for (let vertexIndex = 0; vertexIndex < vertexKeys.length; vertexIndex++) {
      const influences = [];
      const jointRow = joints[vertexIndex] || [];
      const weightRow = weights[vertexIndex] || [];

      for (let slot = 0; slot < jointRow.length; slot++) {
        const weight = Number(weightRow[slot] ?? 0);
        if (weight === 0) continue;

        const skinBoneIndex = jointRow[slot];
        const nodeIndex = skin.joints[skinBoneIndex];
        const bone = boneMap.get(nodeIndex);
        if (!bone) {
          throw new Error('HARAGANZITO_MISSING_IMPORTED_BONE:' + skinBoneIndex);
        }

        bone.setVertexWeight(mesh, vertexKeys[vertexIndex], weight);
        influences.push({
          slot,
          boneIndex: skinBoneIndex,
          boneName: bones[nodeIndex]?.name || null,
          weight
        });
      }

      allInfluences[vertexIndex] = influences;
    }

    mesh.haraganzito_source_influences = allInfluences;
    return allInfluences;
  }

  function buildRawAnimationStore(intermediate) {
    return {
      schema: 'haraganzito.source_animation_store.v1',
      exactSource: true,
      animations: clone(intermediate.animations || [])
    };
  }

  function buildPreviewAnimations(intermediate, armature) {
    const store = buildRawAnimationStore(intermediate);
    Project.haraganzito_source_animations = store;

    const bonesByName = {};
    armature.getAllBones().forEach(bone => {
      bonesByName[bone.name] = bone;
    });

    const sourceBones = {};
    const skin = intermediate.skins?.[0];
    if (skin) {
      skin.joints.forEach((nodeIndex, boneIndex) => {
        const node = intermediate.nodes[nodeIndex];
        if (node) {
          sourceBones[node.name] = {
            translation: clone(node.local.translation || [0, 0, 0]),
            rotation: clone(node.local.rotation || [0, 0, 0, 1]),
            scale: clone(node.local.scale || [1, 1, 1])
          };
        }
      });
    }

    for (const sourceAnimation of intermediate.animations || []) {
      const boneChannels = {};

      for (const channel of sourceAnimation.channels || []) {
        const sampler = sourceAnimation.samplers[channel.sampler];
        const node = intermediate.nodes[channel.targetNode];
        if (!sampler || !node || !bonesByName[node.name]) continue;

        if (!boneChannels[node.name]) boneChannels[node.name] = {};
        const base = sourceBones[node.name] || {
          translation: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1]
        };

        const keyframes = sampler.input.map((time, keyIndex) => {
          const value = sampler.output[keyIndex] || [];
          let result;

          if (channel.path === 'translation') {
            result = {
              x: (value[0] ?? 0) - (base.translation[0] ?? 0),
              y: (value[1] ?? 0) - (base.translation[1] ?? 0),
              z: (value[2] ?? 0) - (base.translation[2] ?? 0)
            };
          } else if (channel.path === 'rotation') {
            const delta = relativeQuaternionEuler(base.rotation, value);
            result = {x: delta[0], y: delta[1], z: delta[2]};
          } else if (channel.path === 'scale') {
            result = {
              x: value[0] ?? 1,
              y: value[1] ?? 1,
              z: value[2] ?? 1
            };
          } else {
            return null;
          }

          return {
            time,
            channel: channel.path === 'translation' ? 'position' : channel.path,
            interpolation: 'linear',
            data_points: [result]
          };
        }).filter(Boolean);

        const bbChannel = channel.path === 'translation' ? 'position' : channel.path;
        boneChannels[node.name][bbChannel] = keyframes;
      }

      const animators = {};
      for (const boneName of Object.keys(boneChannels)) {
        const bone = bonesByName[boneName];
        if (!bone) continue;

        const keyframes = [];
        for (const channel of Object.keys(boneChannels[boneName])) {
          keyframes.push(...boneChannels[boneName][channel]);
        }

        animators[bone.uuid] = {
          name: boneName,
          type: 'bone',
          keyframes
        };
      }

      const animation = new Animation({
        name: sourceAnimation.name,
        length: Math.max(0, ...sourceAnimation.samplers.flatMap(s => s.input || [])),
        loop: 'once',
        override: true,
        animators
      }).add();

      animation.haraganzito_source_animation_index = sourceAnimation.index;
      animation.haraganzito_source_interpolation = sourceAnimation.samplers.map(s => s.interpolation);
    }
  }

  function validateImportedProject(intermediate, armature, mesh, vertexKeys) {
    const primitive = intermediate.meshes[0]?.primitives[0];
    const sourceJoints = primitive?.attributes?.JOINTS_0 || [];
    const sourceWeights = primitive?.attributes?.WEIGHTS_0 || [];

    let maxInfluences = 0;
    let maxWeightError = 0;

    for (let i = 0; i < vertexKeys.length; i++) {
      const count = (mesh.haraganzito_source_influences?.[i] || []).length;
      maxInfluences = Math.max(maxInfluences, count);

      const sum = (sourceWeights[i] || []).reduce((a, b) => a + Number(b || 0), 0);
      maxWeightError = Math.max(maxWeightError, Math.abs(sum - 1));
    }

    return {
      schema: 'haraganzito.native_import.validation.v1',
      exactGeometryInput: vertexKeys.length === (primitive?.attributes?.POSITION || []).length,
      vertices: vertexKeys.length,
      indices: (primitive?.indices || []).length,
      bones: armature.getAllBones().length,
      animations: (intermediate.animations || []).length,
      maxInfluencesPerVertex: maxInfluences,
      sourceWeightSumErrorMax: maxWeightError,
      result: (
        vertexKeys.length === (primitive?.attributes?.POSITION || []).length &&
        armature.getAllBones().length === (intermediate.skins?.[0]?.joints?.length || 0) &&
        maxWeightError < 1e-5
      ) ? 'exact_source_data_attached_to_native_representation' : 'validation_failed',
      bedrockRuntime: 'not_determined'
    };
  }

  function importGLB(file) {
    if (!globalThis.HaraganzitoGLBParser?.parseGLB) {
      throw new Error('HARAGANZITO_GLB_PARSER_NOT_LOADED');
    }

    const intermediate = HaraganzitoGLBParser.parseGLB(file.content, {includeImageData: true});
    const skin = intermediate.skins?.[0];
    const primitive = intermediate.meshes?.[0]?.primitives?.[0];

    if (!skin || !primitive) {
      throw new Error('HARAGANZITO_REQUIRES_FIRST_SKINNED_PRIMITIVE');
    }

    createProjectForImport(file.name);

    const armature = buildArmature(intermediate, skin);
    const texture = makeTexture(intermediate, primitive);
    const meshResult = makeMesh(intermediate, armature, primitive, texture);
    const influences = transferWeights(intermediate, skin, armature, meshResult.mesh, meshResult.vertexKeys);

    meshResult.mesh.haraganzito_validation = {
      influences,
      source_skins: clone(intermediate.skins)
    };

    buildPreviewAnimations(intermediate, armature);

    const validation = validateImportedProject(intermediate, armature, meshResult.mesh, meshResult.vertexKeys);
    Project.haraganzito_native_validation = validation;
    Project.haraganzito_source_glb_summary = HaraganzitoGLBParser.summarize(intermediate);

    Canvas.updateAllBones();
    Canvas.updatePositions();
    updateSelection();

    Blockbench.showQuickMessage('Haraganzito: native weighted import complete', 3000);

    return {
      intermediate,
      armature,
      mesh: meshResult.mesh,
      validation
    };
  }

  BARS.defineActions(function() {
    new Action('import_haraganzito_glb_native', {
      name: 'Haraganzito: Import GLB (Native Weighted Armature)',
      icon: 'icon-import',
      category: 'file',
      click() {
        Blockbench.read([], {
          extensions: ['glb'],
          type: 'file',
          readtype: 'binary',
          resource_id: 'haraganzito_glb_native_import',
          title: 'Import Haraganzito GLB'
        }, files => {
          try {
            importGLB(files[0]);
          } catch (error) {
            console.error('[Haraganzito] native import failed', error);
            Blockbench.showStatusMessage('Haraganzito import failed: ' + error.message, 5000);
          }
        });
      }
    });
  });

  if (typeof BBPlugin !== 'undefined' && BBPlugin.register) {
    BBPlugin.register('haraganzito_native_importer', {
      title: 'Haraganzito Native GLB Importer',
      author: 'userblund',
      description: 'Builds a native weighted Blockbench Armature from the Haraganzito GLB intermediate representation.',
      icon: 'accessibility',
      version: VERSION,
      variant: 'both',
      min_version: '4.10.4',
      onload() {
        console.log('[Haraganzito] native importer loaded', VERSION);
      },
      onunload() {
        delete Project.haraganzito_source_animations;
        delete Project.haraganzito_native_validation;
        delete Project.haraganzito_source_glb_summary;
      }
    });
  }

  globalThis.HaraganzitoNativeImporter = {
    version: VERSION,
    importGLB,
    validateImportedProject
  };
})();
