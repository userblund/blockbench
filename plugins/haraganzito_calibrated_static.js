/**
 * Haraganzito calibrated static-bone candidate.
 *
 * Purpose:
 *   Use the working Haraganzito v1.0.0 static poly_mesh as a geometric
 *   calibration reference, then split the same 50,000 triangles across the
 *   GLB skeleton without introducing animation yet.
 *
 * This is deliberately a geometry-isolation route.
 * Runtime acceptance is NOT claimed until tested in Minecraft Bedrock.
 */
(function() {
  'use strict';

  const VERSION = '0.1.0';

  // Fitted from the supplied working Haraganzito v1.0.0 addon:
  //   P_bedrock = A * P_glb + offset
  const CALIBRATION_A = [
    -15.9999998,  0.0000000274162342, -0.0000000329482620,
     -0.0000000537565671, 15.9999999999, -0.000000210805214,
    -0.0000000320222758, -0.00000000612344264, 15.9999997
  ];
  const CALIBRATION_OFFSET = [
    0.124199995,
    10.12429999,
    -0.135300009
  ];

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function transformPoint(v) {
    return [
      CALIBRATION_A[0] * v[0] + CALIBRATION_A[1] * v[1] + CALIBRATION_A[2] * v[2] + CALIBRATION_OFFSET[0],
      CALIBRATION_A[3] * v[0] + CALIBRATION_A[4] * v[1] + CALIBRATION_A[5] * v[2] + CALIBRATION_OFFSET[1],
      CALIBRATION_A[6] * v[0] + CALIBRATION_A[7] * v[1] + CALIBRATION_A[8] * v[2] + CALIBRATION_OFFSET[2]
    ];
  }

  function transformNormal(v) {
    const n = [
      CALIBRATION_A[0] * v[0] + CALIBRATION_A[1] * v[1] + CALIBRATION_A[2] * v[2],
      CALIBRATION_A[3] * v[0] + CALIBRATION_A[4] * v[1] + CALIBRATION_A[5] * v[2],
      CALIBRATION_A[6] * v[0] + CALIBRATION_A[7] * v[1] + CALIBRATION_A[8] * v[2]
    ];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / len, n[1] / len, n[2] / len];
  }

  function matrixFromColumnMajor(a) {
    const m = new THREE.Matrix4();
    m.fromArray(a);
    return m;
  }

  function uuidv4() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    if (typeof guid === 'function') return guid();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : ((r & 3) | 8);
      return v.toString(16);
    });
  }

  function jsonText(value) {
    return JSON.stringify(value, null, 2);
  }

  function baseColorData(source) {
    const primitive = source.meshes?.[0]?.primitives?.[0];
    const materialIndex = primitive?.material;
    const material = materialIndex == null ? null : source.materials?.[materialIndex];
    const textureIndex = material?.pbrMetallicRoughness?.baseColorTexture?.index;
    const texture = textureIndex == null ? null : source.textures?.[textureIndex];
    const image = texture?.source == null ? null : source.images?.[texture.source];
    const dataUrl = image?.dataUrl || '';
    const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
    return match ? {mime: match[1], base64: match[2]} : null;
  }

  function dominantTriangleBones(source) {
    const primitive = source.meshes?.[0]?.primitives?.[0];
    const indices = primitive?.indices || [];
    const joints = primitive?.attributes?.JOINTS_0 || [];
    const weights = primitive?.attributes?.WEIGHTS_0 || [];
    const jointCount = source.skins?.[0]?.joints?.length || 0;
    const result = new Array(Math.floor(indices.length / 3));

    for (let t = 0; t < result.length; t++) {
      const scores = new Array(jointCount).fill(0);
      for (let c = 0; c < 3; c++) {
        const vi = indices[t * 3 + c];
        const rowJ = joints[vi] || [];
        const rowW = weights[vi] || [];
        for (let s = 0; s < rowJ.length; s++) {
          scores[rowJ[s]] += Number(rowW[s] || 0);
        }
      }
      let best = 0;
      for (let i = 1; i < scores.length; i++) {
        if (scores[i] > scores[best]) best = i;
      }
      result[t] = best;
    }
    return result;
  }

  function buildCandidate(source) {
    const primitive = source.meshes?.[0]?.primitives?.[0];
    const skin = source.skins?.[0];
    if (!primitive || !skin) throw new Error('HARAGANZITO_CALIBRATED_ROUTE_NEEDS_SKINNED_PRIMITIVE');

    const positions = primitive.attributes?.POSITION || [];
    const normals = primitive.attributes?.NORMAL || [];
    const uvs = primitive.attributes?.TEXCOORD_0 || [];
    const indices = primitive.indices || [];

    const nodeParent = new Map();
    (source.nodes || []).forEach(node => {
      (node.children || []).forEach(child => nodeParent.set(child, node.index));
    });

    const jointPivots = [];
    for (let i = 0; i < skin.joints.length; i++) {
      const ibm = skin.inverseBindMatrices?.[i];
      if (!ibm) throw new Error('HARAGANZITO_MISSING_INVERSE_BIND_MATRIX:' + i);
      const bindJointWorld = matrixFromColumnMajor(ibm).invert();
      jointPivots.push(transformPoint([
        bindJointWorld.elements[12],
        bindJointWorld.elements[13],
        bindJointWorld.elements[14]
      ]));
    }

    const jointIndexByNode = new Map(
      skin.joints.map((nodeIndex, index) => [nodeIndex, index])
    );

    const meshes = skin.joints.map(() => ({
      positions: [],
      normals: [],
      uvs: [],
      polys: [],
      vertexMap: new Map()
    }));

    const triangleBone = dominantTriangleBones(source);

    function addVertex(boneIndex, vertexIndex) {
      const mesh = meshes[boneIndex];
      if (mesh.vertexMap.has(vertexIndex)) return mesh.vertexMap.get(vertexIndex);

      const world = transformPoint(positions[vertexIndex]);
      const local = [
        world[0] - jointPivots[boneIndex][0],
        world[1] - jointPivots[boneIndex][1],
        world[2] - jointPivots[boneIndex][2]
      ];

      const outIndex = mesh.positions.length;
      mesh.vertexMap.set(vertexIndex, outIndex);
      mesh.positions.push(local);
      mesh.normals.push(transformNormal(normals[vertexIndex] || [0, 1, 0]));
      mesh.uvs.push([...(uvs[vertexIndex] || [0, 0])]);
      return outIndex;
    }

    for (let t = 0; t < triangleBone.length; t++) {
      const boneIndex = triangleBone[t];
      const a = indices[t * 3];
      const b = indices[t * 3 + 1];
      const c = indices[t * 3 + 2];
      const ia = addVertex(boneIndex, a);
      const ib = addVertex(boneIndex, b);
      const ic = addVertex(boneIndex, c);
      const poly = [
        [ia, ia, ia],
        [ib, ib, ib],
        [ic, ic, ic]
      ];
      poly.push(poly[0]);
      meshes[boneIndex].polys.push(poly);
    }

    const bones = [];
    for (let i = 0; i < skin.joints.length; i++) {
      const nodeIndex = skin.joints[i];
      const parentNode = nodeParent.get(nodeIndex);
      const parentBone = parentNode == null ? null : jointIndexByNode.get(parentNode);
      const node = source.nodes[nodeIndex];

      const bone = {
        name: node?.name || ('bone_' + i),
        pivot: jointPivots[i],
        rotation: [0, 0, 0]
      };

      if (parentBone != null) {
        bone.parent = source.nodes[skin.joints[parentBone]]?.name || ('bone_' + parentBone);
      }

      const mesh = meshes[i];
      if (mesh.polys.length) {
        bone.poly_mesh = {
          normalized_uvs: true,
          positions: mesh.positions,
          normals: mesh.normals,
          uvs: mesh.uvs,
          polys: mesh.polys
        };
      }

      bones.push(bone);
    }

    const generatedTriangles = meshes.reduce((sum, mesh) => sum + mesh.polys.length, 0);
    const generatedPositions = meshes.reduce((sum, mesh) => sum + mesh.positions.length, 0);

    return {
      route: 'bedrock_rigid_poly_mesh_bones_calibrated_static',
      exactSourceGeometryCalibration: true,
      animation: false,
      geometry: {
        format_version: '1.21.0',
        'minecraft:geometry': [{
          description: {
            identifier: 'geometry.haraganzito_calibrated_static',
            texture_width: 4096,
            texture_height: 4096
          },
          bones
        }]
      },
      diagnostics: {
        sourceVertices: positions.length,
        sourceTriangles: Math.floor(indices.length / 3),
        generatedTriangles,
        generatedPositions,
        bones: bones.length,
        bonesWithPolyMesh: meshes.filter(mesh => mesh.polys.length > 0).length,
        triangleAssignment: 'dominant_sum_of_source_vertex_weights',
        calibration: {
          matrix3x3: [
            CALIBRATION_A.slice(0, 3),
            CALIBRATION_A.slice(3, 6),
            CALIBRATION_A.slice(6, 9)
          ],
          offset: clone(CALIBRATION_OFFSET),
          purpose: 'reproduce the supplied working Haraganzito v1.0.0 static poly_mesh coordinate space'
        },
        skinningLossAtBindPose: 'continuous_weights_replaced_by_rigid_triangle_assignment',
        runtimeCompatibility: 'not_yet_determined'
      }
    };
  }

  function makeManifest(name, description, uuidHeader, uuidModule, moduleType) {
    return {
      format_version: 2,
      header: {
        name,
        description,
        uuid: uuidHeader,
        version: [1, 0, 0],
        min_engine_version: [1, 16, 0]
      },
      modules: [{
        type: moduleType,
        uuid: uuidModule,
        version: [1, 0, 0]
      }]
    };
  }

  async function exportCandidate() {
    if (typeof JSZip === 'undefined') throw new Error('HARAGANZITO_JSZIP_UNAVAILABLE');
    const source = Project?.haraganzito_source_intermediate;
    if (!source) throw new Error('HARAGANZITO_SOURCE_INTERMEDIATE_NOT_AVAILABLE');

    const candidate = buildCandidate(source);
    const texture = baseColorData(source);

    const rpHeader = uuidv4();
    const rpModule = uuidv4();
    const bpHeader = uuidv4();
    const bpModule = uuidv4();

    const rp = {
      manifest: makeManifest(
        'Haraganzito Calibrated Static Resource',
        'Haraganzito geometry-isolation candidate calibrated against v1.0.0.',
        rpHeader, rpModule, 'resources'
      ),
      entity: {
        format_version: '1.10.0',
        'minecraft:client_entity': {
          description: {
            identifier: 'robot:haraganzito',
            materials: {default: 'entity_alphatest'},
            textures: {default: 'textures/entity/haraganzito'},
            geometry: {default: 'geometry.haraganzito_calibrated_static'},
            render_controllers: ['controller.render.default']
          }
        }
      }
    };

    const bp = {
      manifest: makeManifest(
        'Haraganzito Calibrated Static Behavior',
        'Haraganzito geometry-isolation candidate.',
        bpHeader, bpModule, 'data'
      ),
      entity: {
        format_version: '1.16.100',
        'minecraft:entity': {
          description: {
            identifier: 'robot:haraganzito',
            is_spawnable: true,
            is_summonable: true,
            is_experimental: false
          },
          components: {
            'minecraft:physics': {
              has_gravity: true,
              has_collision: true
            },
            'minecraft:pushable': {is_pushable: false},
            'minecraft:push_through': {value: 1}
          }
        }
      }
    };

    const rpZip = new JSZip();
    rpZip.file('manifest.json', jsonText(rp.manifest));
    rpZip.file('models/entity/haraganzito.geo.json', jsonText(candidate.geometry));
    rpZip.file('entity/haraganzito.entity.json', jsonText(rp.entity));
    rpZip.file('bridge/haraganzito_calibration_report.json', jsonText(candidate.diagnostics));
    if (texture) {
      const ext = texture.mime === 'image/jpeg' ? 'jpg' : 'png';
      rpZip.file('textures/entity/haraganzito.' + ext, texture.base64, {base64: true});
    }

    const bpZip = new JSZip();
    bpZip.file('manifest.json', jsonText(bp.manifest));
    bpZip.file('entities/haraganzito.behavior.json', jsonText(bp.entity));

    const [rpBlob, bpBlob] = await Promise.all([
      rpZip.generateAsync({type: 'blob'}),
      bpZip.generateAsync({type: 'blob'})
    ]);

    const addon = new JSZip();
    addon.file('Haraganzito_Calibrated_Static_RP.mcpack', rpBlob);
    addon.file('Haraganzito_Calibrated_Static_BP.mcpack', bpBlob);
    addon.file('CALIBRATION_REPORT.json', jsonText({
      schema: 'haraganzito.calibrated_static_candidate.v1',
      route: candidate.route,
      runtimeCompatibility: 'not_yet_determined',
      candidateDiagnostics: candidate.diagnostics
    }));

    const blob = await addon.generateAsync({type: 'blob'});
    Blockbench.export({
      type: 'Haraganzito Calibrated Static Candidate',
      extensions: ['mcaddon'],
      name: 'Haraganzito_Calibrated_Static',
      savetype: 'zip',
      content: blob,
      startpath: Project.export_path
    });
  }

  BARS.defineActions(function() {
    new Action('export_haraganzito_calibrated_static', {
      name: 'Haraganzito: Export Calibrated Static-Bone Candidate',
      icon: 'archive',
      category: 'file',
      condition: () => !!Project?.haraganzito_source_intermediate,
      click() {
        exportCandidate().catch(error => {
          console.error('[Haraganzito] calibrated static export failed', error);
          Blockbench.showStatusMessage(
            'Haraganzito calibrated static export failed: ' + error.message,
            5000
          );
        });
      }
    });
  });

  BBPlugin.register('haraganzito_calibrated_static', {
    title: 'Haraganzito Calibrated Static',
    author: 'userblund',
    description: 'Geometry-isolation route calibrated against the working Haraganzito v1.0.0 poly_mesh.',
    icon: 'archive',
    version: VERSION,
    variant: 'both',
    min_version: '4.10.4',
    onload() {
      globalThis.HaraganzitoCalibratedStatic = {
        version: VERSION,
        buildCandidate,
        exportCandidate
      };
      console.log('[Haraganzito] calibrated static route loaded', VERSION);
    },
    onunload() {
      delete globalThis.HaraganzitoCalibratedStatic;
    }
  });
})();
