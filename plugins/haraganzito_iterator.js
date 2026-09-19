/**
 * Haraganzito route iterator.
 *
 * Purpose:
 *   Treat GLB -> MCADDON as a search over representations instead of a
 *   single hard-coded conversion. The GLB remains ground truth.
 *
 * This file does not claim that any candidate is runtime-compatible until
 * the candidate is exported and measured in the target Bedrock runtime.
 */
(function() {
  'use strict';

  const VERSION = '0.2.0';

  const ROUTES = [
    {
      id: 'bedrock_poly_mesh_static',
      family: 'bedrock_normal',
      description: 'Poly mesh only; no animation/skinning preservation.',
      preserves: ['positions', 'normals', 'texcoords0', 'indices', 'materials'],
      loses: ['joints0', 'weights0', 'inverseBindMatrices', 'animation']
    },
    {
      id: 'bedrock_rigid_poly_mesh_bones',
      family: 'bedrock_normal',
      description: 'Poly mesh attached to animated bones as rigid bone-local geometry.',
      preserves: ['positions', 'normals', 'texcoords0', 'indices', 'materials', 'skeletonHierarchy', 'animationTracks'],
      loses: ['arbitraryVertexWeights', 'inverseBindMatrices']
    },
    {
      id: 'native_blockbench_weighted_armature',
      family: 'blockbench_native_skinning',
      description: 'Native Blockbench armature + mesh vertex weights + animation tracks, preserving the GLB skinning data before Bedrock serialization.',
      preserves: ['positions', 'normals', 'texcoords0', 'indices', 'materials', 'joints0', 'weights0', 'inverseBindMatrices', 'skeletonHierarchy', 'animationTracks'],
      loses: []
    },
    {
      id: 'china_polymesh_skeleton_animation',
      family: 'bedrock_china_reference',
      description: 'Polymesh + per-vertex bone weights + skeleton + animation tracks.',
      preserves: ['positions', 'normals', 'texcoords0', 'indices', 'materials', 'joints0', 'weights0', 'skeletonHierarchy', 'animationTracks'],
      loses: ['runtimeCompatibilityWithVanillaBedrock']
    },
    {
      id: 'hybrid_split_weighted_poly_mesh',
      family: 'bedrock_normal_hybrid',
      description: 'Split geometry into bone-addressable regions, preserving animation by bone transforms.',
      preserves: ['positions', 'normals', 'texcoords0', 'indices', 'materials', 'skeletonHierarchy', 'animationTracks'],
      loses: ['continuousCrossBoneSkinning']
    },
    {
      id: 'baked_pose_geometry_sequence',
      family: 'bedrock_normal_baked',
      description: 'Bake deformed geometry at sampled times, then search for a runtime animation mechanism.',
      preserves: ['sampledPoseGeometry', 'materials', 'texcoords0'],
      loses: ['exactContinuousSkinning', 'nativeAnimationContinuity']
    }
  ];

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function routeById(id) {
    return ROUTES.find(route => route.id === id) || null;
  }

  function sourceCapabilities(source) {
    const req = source?.requirements || {};
    return {
      geometry: !!(req.positions && req.indices),
      normals: !!req.normals,
      uv: !!req.texcoords0,
      skinning: !!(req.joints0 && req.weights0),
      bindPose: !!req.inverseBindMatrices,
      translation: !!req.animationTranslation,
      rotation: !!req.animationRotation,
      scale: !!req.animationScale,
      animation: !!(req.animationTranslation || req.animationRotation || req.animationScale)
    };
  }

  function assessRoute(source, routeId) {
    const route = routeById(routeId);
    if (!route) throw new Error('HARAGANZITO_UNKNOWN_ROUTE:' + routeId);

    const caps = sourceCapabilities(source);
    const missing = [];
    for (const required of route.preserves) {
      const supported =
        required === 'positions' ? caps.geometry :
        required === 'normals' ? caps.normals :
        required === 'texcoords0' ? caps.uv :
        required === 'indices' ? caps.geometry :
        required === 'joints0' ? caps.skinning :
        required === 'weights0' ? caps.skinning :
        required === 'inverseBindMatrices' ? caps.bindPose :
        required === 'skeletonHierarchy' ? caps.skinning :
        required === 'animationTracks' ? caps.animation :
        required === 'materials' ? true :
        required === 'sampledPoseGeometry' ? caps.geometry && caps.animation :
        false;
      if (!supported) missing.push(required);
    }

    const risks = [];
    for (const loss of route.loses) {
      if (loss === 'animation' && caps.animation) risks.push(loss);
      if (loss === 'joints0' && caps.skinning) risks.push(loss);
      if (loss === 'weights0' && caps.skinning) risks.push(loss);
      if (loss === 'inverseBindMatrices' && caps.bindPose) risks.push(loss);
      if (loss === 'arbitraryVertexWeights' && caps.skinning) risks.push(loss);
      if (loss === 'continuousCrossBoneSkinning' && caps.skinning) risks.push(loss);
      if (loss === 'runtimeCompatibilityWithVanillaBedrock') risks.push(loss);
      if (loss === 'exactContinuousSkinning' && caps.skinning && caps.animation) risks.push(loss);
      if (loss === 'nativeAnimationContinuity' && caps.animation) risks.push(loss);
    }

    return {
      route: route.id,
      family: route.family,
      missing,
      risks,
      structurallyCompatible: missing.length === 0,
      sourceCapabilities: caps
    };
  }

  function enumerateRoutes(source, history) {
    const used = new Set((history || []).map(item => item.route));
    return ROUTES
      .filter(route => !used.has(route.id))
      .map(route => ({
        id: route.id,
        assessment: assessRoute(source, route.id)
      }));
  }

  function nextRoute(source, history) {
    const candidates = enumerateRoutes(source, history);
    if (!candidates.length) {
      return {
        status: 'search_exhausted',
        reason: 'all_registered_routes_tested'
      };
    }

    // Search ordering is by preservation coverage, then by fewer declared
    // losses. This is a search heuristic, not a proof of optimality.
    candidates.sort((a, b) => {
      const ap = routeById(a.id).preserves.length;
      const bp = routeById(b.id).preserves.length;
      if (bp !== ap) return bp - ap;
      return a.assessment.risks.length - b.assessment.risks.length;
    });

    return {
      status: 'candidate',
      route: candidates[0].id,
      assessment: candidates[0].assessment,
      alternatives: candidates.slice(1)
    };
  }

  function compareErrors(previous, current) {
    const keys = ['geometry', 'skinning', 'animation', 'materials', 'uv'];
    const delta = {};
    let improved = false;
    let changed = false;

    for (const key of keys) {
      const before = Number.isFinite(previous?.errors?.[key]) ? previous.errors[key] : null;
      const after = Number.isFinite(current?.errors?.[key]) ? current.errors[key] : null;
      const improvement = before !== null && after !== null ? before - after : null;
      delta[key] = {before, after, improvement};
      if (before !== after) changed = true;
      if (improvement !== null && improvement > 0) improved = true;
    }

    return {delta, improved, changed};
  }

  function classifyIteration(iteration, allRoutesTested) {
    const errors = iteration?.errors || {};
    const keys = ['geometry', 'skinning', 'animation', 'materials', 'uv'];
    const complete = keys.every(key => Number.isFinite(errors[key]));
    const exact = complete && keys.every(key => errors[key] === 0);

    if (exact) return 'exact';
    if (allRoutesTested && complete) return 'maximum_reached';
    return 'undetermined';
  }

  function recordIteration(history, candidate) {
    const previous = history && history.length ? history[history.length - 1] : null;
    const comparison = compareErrors(previous, candidate);

    const record = {
      schema: 'haraganzito.iteration.record.v2',
      iteration: (history?.length || 0) + 1,
      route: candidate.route,
      errors: clone(candidate.errors || {}),
      diagnostics: clone(candidate.diagnostics || {}),
      parentIteration: previous ? previous.iteration : null,
      comparison,
      changedRepresentation: candidate.route !== previous?.route,
      timestamp: new Date().toISOString()
    };

    record.classification = classifyIteration(record, false);
    return record;
  }

  /*
   * Reference implementation of the China-style representation documented
   * in Blockbench issue #2706:
   *   polymesh vertices carry bone weights,
   *   skeleton stores hierarchy/initial transforms,
   *   animations store tracks per bone.
   *
   * It is intentionally a neutral intermediate representation. It is NOT
   * emitted as a vanilla Bedrock .geo.json file.
   */
  function glbIntermediateToRouteInput(glb) {
    if (!glb || !Array.isArray(glb.meshes) || !Array.isArray(glb.nodes)) {
      throw new Error('HARAGANZITO_INVALID_GLB_INTERMEDIATE');
    }

    const primitive = glb.meshes[0]?.primitives[0];
    if (!primitive) throw new Error('HARAGANZITO_NO_FIRST_PRIMITIVE');

    const positions = primitive.attributes.POSITION || [];
    const normals = primitive.attributes.NORMAL || [];
    const uvs = primitive.attributes.TEXCOORD_0 || [];
    const joints = primitive.attributes.JOINTS_0 || [];
    const weights = primitive.attributes.WEIGHTS_0 || [];
    const indices = primitive.indices || [];

    const skin = glb.skins[0] || null;
    const bones = (skin?.joints || []).map((nodeIndex, boneIndex) => {
      const node = glb.nodes[nodeIndex];
      const inverseBindMatrix = skin.inverseBindMatrices?.[boneIndex] || null;
      return {
        index: boneIndex,
        nodeIndex,
        name: node?.name || ('bone_' + boneIndex),
        parent: node?.parent != null ? glb.nodes[node.parent]?.name || null : null,
        position: node?.local?.translation || [0,0,0],
        quaternion: node?.local?.rotation || [0,0,0,1],
        scale: node?.local?.scale || [1,1,1],
        inverseBindMatrix
      };
    });

    const boneIndexToName = bones.map(b => b.name);
    const vertices = positions.map((position, index) => ({
      id: index,
      position: [...position],
      normal: [...(normals[index] || [0,1,0])],
      uv: [...(uvs[index] || [0,0])],
      joints: [...(joints[index] || [])],
      weights: [...(weights[index] || [])].map((weight, j) => ({
        bone: joints[index]?.[j] ?? 0,
        boneName: boneIndexToName[joints[index]?.[j] ?? 0] || null,
        weight
      }))
    }));

    const polygons = [];
    for (let i = 0; i + 2 < indices.length; i += 3) {
      polygons.push([
        [indices[i], indices[i+1], indices[i+2]]
      ]);
    }

    const tracks = [];
    for (const animation of glb.animations || []) {
      for (const channel of animation.channels || []) {
        const sampler = animation.samplers[channel.sampler];
        const targetBone = bones.find(b => b.nodeIndex === channel.targetNode);
        if (!sampler || !targetBone) continue;
        const keyframes = sampler.input.map((time, k) => ({
          time,
          position: channel.path === 'translation' ? (sampler.output[k] || [0,0,0]) : [0,0,0],
          quaternion: channel.path === 'rotation' ? (sampler.output[k] || [0,0,0,1]) : [0,0,0,1],
          scale: channel.path === 'scale' ? (sampler.output[k] || [1,1,1]) : [1,1,1]
        }));
        tracks.push({
          animation: animation.name,
          bone: targetBone.name,
          path: channel.path,
          interpolation: sampler.interpolation,
          channelMask: channel.path === 'translation' ? 1 : channel.path === 'rotation' ? 2 : channel.path === 'scale' ? 4 : 0,
          keyframes
        });
      }
    }

    const animationMap = new Map();
    for (const track of tracks) {
      if (!animationMap.has(track.animation)) animationMap.set(track.animation, []);
      animationMap.get(track.animation).push(track);
    }

    return {
      vertices,
      bones,
      polygons,
      materialPath: glb.textures?.[0]?.name || null,
      animations: (glb.animations || []).map(animation => ({
        name: animation.name,
        id: animation.index,
        length: Math.max(0, ...animation.samplers.flatMap(s => s.input || [])),
        tracks: animationMap.get(animation.name) || []
      }))
    };
  }


  /*
   * The documented vanilla poly_mesh schema has geometry fields but no
   * per-vertex JOINTS/WEIGHTS representation. This report turns that
   * representational fact into a deterministic route diagnostic.
   */
  function assessVanillaSkinningRepresentability(intermediate) {
    const primitive = intermediate.meshes?.[0]?.primitives?.[0];
    const weights = primitive?.attributes?.WEIGHTS_0 || [];
    let multiInfluenceVertices = 0;
    let maxInfluences = 0;

    for (const row of weights) {
      const influences = row.filter(weight => Number(weight) !== 0).length;
      maxInfluences = Math.max(maxInfluences, influences);
      if (influences > 1) multiInfluenceVertices++;
    }

    return {
      schema: 'haraganzito.vanilla_poly_mesh.representability.v1',
      documentedPolyMeshFields: ['normalized_uvs', 'positions', 'normals', 'uvs', 'polys'],
      supportsPerVertexSkinWeights: false,
      vertices: weights.length,
      multiInfluenceVertices,
      maxInfluences,
      exactContinuousSkinning: multiInfluenceVertices === 0,
      classification: multiInfluenceVertices === 0
        ? 'not_blocked_by_weight_representation'
        : 'representation_loss_required_for_vanilla_poly_mesh',
      reason: multiInfluenceVertices === 0
        ? 'Every source vertex is rigidly influenced.'
        : 'The documented vanilla poly_mesh schema cannot encode multiple continuous vertex influences.'
    };
  }

  function dominantBone(value, vertexIndex) {
    const weights = value?.weights || [];
    let best = 0;
    let bestWeight = -Infinity;
    for (let i = 0; i < weights.length; i++) {
      if ((weights[i]?.weight ?? 0) > bestWeight) {
        bestWeight = weights[i].weight ?? 0;
        best = weights[i].bone ?? 0;
      }
    }
    return best;
  }

  /*
   * Candidate generator A1:
   * Convert the GLB mesh to Bedrock poly_mesh, split polygons by their
   * dominant bone, and attach each resulting mesh to that bone.
   *
   * This is deliberately a rigid-skin candidate. It is not claimed exact.
   * The iterator can compare it and move to a different representation.
   */

  function quaternionToEulerDegrees(q) {
    const x=q[0]||0, y=q[1]||0, z=q[2]||0, w=q[3]===undefined?1:q[3];
    const sinr=2*(w*x+y*z), cosr=1-2*(x*x+y*y);
    const roll=Math.atan2(sinr,cosr);
    const sinp=2*(w*y-z*x);
    const pitch=Math.abs(sinp)>=1 ? Math.sign(sinp)*Math.PI/2 : Math.asin(sinp);
    const siny=2*(w*z+x*y), cosy=1-2*(y*y+z*z);
    const yaw=Math.atan2(siny,cosy);
    return [roll*180/Math.PI,pitch*180/Math.PI,yaw*180/Math.PI];
  }

  function buildBedrockAnimationFiles(intermediate) {
    const source=glbIntermediateToRouteInput(intermediate);
    const files=[];
    for (const animation of intermediate.animations || []) {
      const bones={};
      for (const channel of animation.channels || []) {
        const sampler=animation.samplers[channel.sampler];
        const bone=source.bones.find(b=>b.nodeIndex===channel.targetNode);
        if (!sampler || !bone) continue;
        if (!bones[bone.name]) bones[bone.name]={};
        const keyframes={};
        sampler.input.forEach((time,k)=>{
          let value=sampler.output[k] || [];
          if (channel.path==='translation') {
            value=[-(value[0]||0), value[1]||0, value[2]||0];
            keyframes[String(time)]=value;
          } else if (channel.path==='scale') {
            keyframes[String(time)]=[value[0]??1,value[1]??1,value[2]??1];
          } else if (channel.path==='rotation') {
            const e=quaternionToEulerDegrees(value);
            keyframes[String(time)]=[-e[0],-e[1],e[2]];
          }
        });
        if (channel.path==='translation') bones[bone.name].position=keyframes;
        if (channel.path==='rotation') bones[bone.name].rotation=keyframes;
        if (channel.path==='scale') bones[bone.name].scale=keyframes;
      }
      files.push({
        format_version:'1.8.0',
        animations:{
          [animation.name]:{
            animation_length:Math.max(0,...animation.samplers.flatMap(s=>s.input||[])),
            loop:true,
            bones
          }
        }
      });
    }
    return files;
  }

  function buildRigidPolyMeshCandidate(intermediate, options = {}) {
    const source = glbIntermediateToRouteInput(intermediate);
    const primitive = intermediate.meshes?.[0]?.primitives?.[0];
    const skin = intermediate.skins?.[0];
    if (!primitive || !skin) throw new Error('HARAGANZITO_RIGID_ROUTE_REQUIRES_SKINNED_PRIMITIVE');

    const flipX = options.flipX !== false;

    function identity4() {
      return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    }
    function mul4(a, b) {
      const o = new Array(16).fill(0);
      for (let c=0;c<4;c++) for (let r=0;r<4;r++) for (let k=0;k<4;k++) {
        o[c*4+r] += a[k*4+r] * b[c*4+k];
      }
      return o;
    }
    function transform4(m, v) {
      return [
        m[0]*v[0] + m[4]*v[1] + m[8]*v[2] + m[12],
        m[1]*v[0] + m[5]*v[1] + m[9]*v[2] + m[13],
        m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]
      ];
    }
    function inverse4(m) {
      const a = [
        [m[0],m[4],m[8],m[12]],
        [m[1],m[5],m[9],m[13]],
        [m[2],m[6],m[10],m[14]],
        [m[3],m[7],m[11],m[15]]
      ];
      const b = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
      for (let c=0;c<4;c++) {
        let p=c;
        for (let r=c+1;r<4;r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p=r;
        if (Math.abs(a[p][c]) < 1e-14) throw new Error('HARAGANZITO_SINGULAR_MATRIX');
        [a[c],a[p]]=[a[p],a[c]];
        [b[c],b[p]]=[b[p],b[c]];
        const d=a[c][c];
        for (let j=0;j<4;j++) { a[c][j]/=d; b[c][j]/=d; }
        for (let r=0;r<4;r++) if (r!==c) {
          const f=a[r][c];
          for (let j=0;j<4;j++) { a[r][j]-=f*a[c][j]; b[r][j]-=f*b[c][j]; }
        }
      }
      const out=[];
      for (let c=0;c<4;c++) for (let r=0;r<4;r++) out[c*4+r]=b[r][c];
      return out;
    }
    function norm4(q) {
      const n=Math.hypot(q[0],q[1],q[2],q[3]) || 1;
      return q.map(v=>v/n);
    }
    function quatMul(a,b) {
      return norm4([
        a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
        a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
        a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
        a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2]
      ]);
    }
    function quatToMatrix(q) {
      const [x,y,z,w]=norm4(q);
      return [
        1-2*(y*y+z*z), 2*(x*y+z*w), 2*(x*z-y*w), 0,
        2*(x*y-z*w), 1-2*(x*x+z*z), 2*(y*z+x*w), 0,
        2*(x*z+y*w), 2*(y*z-x*w), 1-2*(x*x+y*y), 0,
        0,0,0,1
      ];
    }
    function composeTRS(t,q,s) {
      const m=quatToMatrix(q);
      m[0]*=s[0]; m[1]*=s[0]; m[2]*=s[0];
      m[4]*=s[1]; m[5]*=s[1]; m[6]*=s[1];
      m[8]*=s[2]; m[9]*=s[2]; m[10]*=s[2];
      m[12]=t[0]; m[13]=t[1]; m[14]=t[2];
      return m;
    }
    function decomposeTRS(m) {
      const sx=Math.hypot(m[0],m[1],m[2]);
      const sy=Math.hypot(m[4],m[5],m[6]);
      const sz=Math.hypot(m[8],m[9],m[10]);
      const r=m.slice();
      if (sx) { r[0]/=sx; r[1]/=sx; r[2]/=sx; }
      if (sy) { r[4]/=sy; r[5]/=sy; r[6]/=sy; }
      if (sz) { r[8]/=sz; r[9]/=sz; r[10]/=sz; }
      const tr=r[0]+r[5]+r[10];
      let x,y,z,w;
      if (tr>0) {
        const s=Math.sqrt(tr+1)*2;
        w=.25*s; x=(r[6]-r[9])/s; y=(r[8]-r[2])/s; z=(r[1]-r[4])/s;
      } else if (r[0]>r[5] && r[0]>r[10]) {
        const s=Math.sqrt(1+r[0]-r[5]-r[10])*2;
        w=(r[6]-r[9])/s; x=.25*s; y=(r[4]+r[1])/s; z=(r[8]+r[2])/s;
      } else if (r[5]>r[10]) {
        const s=Math.sqrt(1+r[5]-r[0]-r[10])*2;
        w=(r[8]-r[2])/s; x=(r[4]+r[1])/s; y=.25*s; z=(r[9]+r[6])/s;
      } else {
        const s=Math.sqrt(1+r[10]-r[0]-r[5])*2;
        w=(r[1]-r[4])/s; x=(r[8]+r[2])/s; y=(r[9]+r[6])/s; z=.25*s;
      }
      return {
        translation:[m[12],m[13],m[14]],
        scale:[sx,sy,sz],
        quaternion:norm4([x,y,z,w])
      };
    }
    function sourceWorld(nodeIndex) {
      const cache=new Map();
      function world(i) {
        if (cache.has(i)) return cache.get(i);
        const node=intermediate.nodes[i];
        if (!node) throw new Error('HARAGANZITO_NODE_NOT_FOUND:'+i);
        const local=node.local||{};
        const localM=composeTRS(
          local.translation||[0,0,0],
          local.rotation||[0,0,0,1],
          local.scale||[1,1,1]
        );
        const out=node.parent==null ? localM : mul4(world(node.parent),localM);
        cache.set(i,out);
        return out;
      }
      return world(nodeIndex);
    }
    function lowestCommonAncestor(a,b) {
      const seen=new Set();
      let x=a;
      while (x!=null) { seen.add(x); x=intermediate.nodes[x]?.parent ?? null; }
      x=b;
      while (x!=null) {
        if (seen.has(x)) return x;
        x=intermediate.nodes[x]?.parent ?? null;
      }
      return null;
    }
    function inverseTransposeNormal(m,n) {
      const a00=m[0],a01=m[4],a02=m[8];
      const a10=m[1],a11=m[5],a12=m[9];
      const a20=m[2],a21=m[6],a22=m[10];
      const det=a00*(a11*a22-a12*a21)-a01*(a10*a22-a12*a20)+a02*(a10*a21-a11*a20);
      if (Math.abs(det)<1e-14) return [...n];
      const it=[
        (a11*a22-a12*a21)/det,(a02*a21-a01*a22)/det,(a01*a12-a02*a11)/det,
        (a12*a20-a10*a22)/det,(a00*a22-a02*a20)/det,(a02*a10-a00*a12)/det,
        (a10*a21-a11*a20)/det,(a01*a20-a00*a21)/det,(a00*a11-a01*a10)/det
      ];
      const out=[
        it[0]*n[0]+it[3]*n[1]+it[6]*n[2],
        it[1]*n[0]+it[4]*n[1]+it[7]*n[2],
        it[2]*n[0]+it[5]*n[1]+it[8]*n[2]
      ];
      const len=Math.hypot(...out)||1;
      return out.map(v=>v/len);
    }

    const meshNodeIndex=intermediate.nodes.findIndex(node=>node.mesh===0);
    const skeletonRoot=skin.skeleton!=null ? skin.skeleton : skin.joints[0];
    const containerIndex=lowestCommonAncestor(meshNodeIndex,skeletonRoot);
    if (meshNodeIndex<0 || containerIndex==null) throw new Error('HARAGANZITO_COMMON_SKIN_CONTAINER_NOT_FOUND');

    const container=decomposeTRS(sourceWorld(containerIndex));
    const scale=container.scale;
    const uniformScaleError=Math.max(Math.abs(scale[0]-scale[1]),Math.abs(scale[1]-scale[2]),Math.abs(scale[0]-scale[2]));
    if (uniformScaleError>1e-5 && options.allowNonUniformContainerScale!==true) {
      throw new Error('HARAGANZITO_NON_UNIFORM_CONTAINER_SCALE:'+uniformScaleError);
    }
    const scalar=(scale[0]+scale[1]+scale[2])/3;
    const jointIndexByNode=new Map(skin.joints.map((nodeIndex,index)=>[nodeIndex,index]));

    const bones=(source.bones||[]).map(bone=>{
      const node=intermediate.nodes[bone.nodeIndex];
      const parentNode=node?.parent;
      const parentBoneIndex=jointIndexByNode.has(parentNode) ? jointIndexByNode.get(parentNode) : null;
      const localT=node?.local?.translation || [0,0,0];
      const localQ=norm4(node?.local?.rotation || [0,0,0,1]);
      const localS=node?.local?.scale || [1,1,1];
      const root=parentBoneIndex==null;
      const scaledT=[scalar*localT[0],scalar*localT[1],scalar*localT[2]];
      let pivot=scaledT;
      let rotationQ=localQ;
      if (root) {
        const rotated=transform4(quatToMatrix(container.quaternion),scaledT);
        pivot=[
          container.translation[0]+rotated[0],
          container.translation[1]+rotated[1],
          container.translation[2]+rotated[2]
        ];
        rotationQ=quatMul(container.quaternion,localQ);
      }
      return {
        index:bone.index,
        nodeIndex:bone.nodeIndex,
        name:bone.name,
        parentBoneIndex,
        parent:parentBoneIndex==null ? null : source.bones[parentBoneIndex]?.name || null,
        pivot,
        rotationQuaternion:rotationQ,
        rotation:quaternionToEulerDegrees(rotationQ),
        sourceScale:localS,
        sourceInverseBindMatrix:clone(bone.inverseBindMatrix)
      };
    });

    const positions=primitive.attributes.POSITION||[];
    const normals=primitive.attributes.NORMAL||[];
    const uvs=primitive.attributes.TEXCOORD_0||[];
    const joints=primitive.attributes.JOINTS_0||[];
    const weights=primitive.attributes.WEIGHTS_0||[];
    const indices=primitive.indices||[];

    const boneMeshes=bones.map(b=>({
      positions:[],
      normals:[],
      uvs:[],
      polys:[],
      sourceVertices:[],
      vertexMap:new Map()
    }));

    function addVertex(boneIndex,vertexIndex) {
      const mesh=boneMeshes[boneIndex];
      const key=String(vertexIndex);
      if (mesh.vertexMap.has(key)) return mesh.vertexMap.get(key);
      const ibm=bones[boneIndex].sourceInverseBindMatrix;
      const local=transform4(ibm,positions[vertexIndex]);
      const p=[local[0]*scalar,local[1]*scalar,local[2]*scalar];
      const n=inverseTransposeNormal(ibm,normals[vertexIndex]||[0,1,0]);
      const uv=[...(uvs[vertexIndex]||[0,0])];
      const outPos=flipX ? [-p[0],p[1],p[2]] : p;
      const outIndex=mesh.positions.length;
      mesh.positions.push(outPos);
      mesh.normals.push(n);
      mesh.uvs.push(uv);
      mesh.sourceVertices.push(vertexIndex);
      mesh.vertexMap.set(key,outIndex);
      return outIndex;
    }

    const triangleMappings=[];
    for (let i=0;i+2<indices.length;i+=3) {
      const vertices=[indices[i],indices[i+1],indices[i+2]];
      const score=new Array(bones.length).fill(0);
      for (const vertexIndex of vertices) {
        const row=joints[vertexIndex]||[];
        const weightsRow=weights[vertexIndex]||[];
        for (let k=0;k<row.length;k++) score[row[k]] += Number(weightsRow[k]||0);
      }
      let target=0;
      for (let b=1;b<score.length;b++) if (score[b]>score[target]+1e-15) target=b;
      const mesh=boneMeshes[target];
      const poly=vertices.map(vertexIndex=>{
        const p=addVertex(target,vertexIndex);
        const u=mesh.uvs[p] ? p : p;
        return [p,p,u];
      });
      mesh.polys.push(poly);
      triangleMappings.push({triangle:i/3,bone:target,vertices});
    }

    const geometryBones=bones.map((bone,index)=>{
      const mesh=boneMeshes[index];
      const out={name:bone.name};
      if (bone.parent) out.parent=bone.parent;
      out.pivot=bone.pivot.slice();
      if (bone.rotation.some(v=>Math.abs(v)>1e-12)) out.rotation=[-bone.rotation[0],-bone.rotation[1],bone.rotation[2]];
      if (mesh.polys.length) {
        out.poly_mesh={
          normalized_uvs:true,
          positions:mesh.positions,
          normals:mesh.normals,
          uvs:mesh.uvs,
          polys:mesh.polys
        };
      }
      return out;
    });

    const animationFiles=(intermediate.animations||[]).map(animation=>{
      const boneOut={};
      for (const channel of animation.channels||[]) {
        const sampler=animation.samplers[channel.sampler];
        const node=intermediate.nodes[channel.targetNode];
        const bone=source.bones.find(item=>item.nodeIndex===channel.targetNode);
        if (!sampler || !node || !bone) continue;
        const boneIndex=bone.index;
        const candidateBone=bones[boneIndex];
        if (!boneOut[candidateBone.name]) boneOut[candidateBone.name]={};
        const bindT=node.local?.translation || [0,0,0];
        const bindQ=norm4(node.local?.rotation || [0,0,0,1]);
        const bindS=node.local?.scale || [1,1,1];
        const keyframes={};
        for (let k=0;k<sampler.input.length;k++) {
          const time=String(sampler.input[k]);
          const value=sampler.output[k]||[];
          if (channel.path==='translation') {
            let delta=[
              ((value[0]??0)-(bindT[0]??0))*scalar,
              ((value[1]??0)-(bindT[1]??0))*scalar,
              ((value[2]??0)-(bindT[2]??0))*scalar
            ];
            if (candidateBone.parentBoneIndex==null) {
              delta=transform4(quatToMatrix(container.quaternion),delta);
            }
            if (flipX) delta[0]*=-1;
            if (!boneOut[candidateBone.name].position) boneOut[candidateBone.name].position={};
            boneOut[candidateBone.name].position[time]=delta;
          } else if (channel.path==='rotation') {
            const baseInv=[-bindQ[0],-bindQ[1],-bindQ[2],bindQ[3]];
            const deltaQ=quatMul(baseInv,norm4(value));
            const e=quaternionToEulerDegrees(deltaQ);
            if (flipX) e[0]*=-1;
            e[1]*=-1;
            if (!boneOut[candidateBone.name].rotation) boneOut[candidateBone.name].rotation={};
            boneOut[candidateBone.name].rotation[time]=e;
          } else if (channel.path==='scale') {
            if (!boneOut[candidateBone.name].scale) boneOut[candidateBone.name].scale={};
            boneOut[candidateBone.name].scale[time]=[
              (value[0]??1)/(bindS[0]||1),
              (value[1]??1)/(bindS[1]||1),
              (value[2]??1)/(bindS[2]||1)
            ];
          }
        }
      }
      return {
        name:animation.name,
        length:Math.max(0,...animation.samplers.flatMap(s=>s.input||[])),
        loop:true,
        bones:boneOut
      };
    });

    return {
      schema:'haraganzito.candidate.rigid_polymesh.v2',
      route:'bedrock_rigid_poly_mesh_bones',
      exact:false,
      lossModel:{
        skinning:'triangle_rigid_assignment',
        assignment:'max_sum_of_source_vertex_weights',
        discardedContinuousWeights:true
      },
      geometry:{
        format_version:'1.21.0',
        'minecraft:geometry':[{
          description:{
            identifier:'geometry.haraganzito_candidate',
            texture_width:4096,
            texture_height:4096
          },
          bones:geometryBones
        }]
      },
      animations:animationFiles,
      diagnostics:{
        sourceVertices:positions.length,
        sourceTriangles:Math.floor(indices.length/3),
        generatedTriangles:triangleMappings.length,
        bones:bones.length,
        bonesWithPolyMesh:geometryBones.filter(b=>b.poly_mesh).length,
        meshNodeIndex,
        skeletonRoot,
        containerIndex,
        containerName:intermediate.nodes[containerIndex]?.name||null,
        containerTranslation:container.translation,
        containerScale:container.scale,
        containerRotationQuaternion:container.quaternion,
        containerUniformScaleError:uniformScaleError,
        triangleMappings,
        sourceScaleNonUnitMaxDeviation:Math.max(0,...bones.map(b=>Math.max(...b.sourceScale.map(s=>Math.abs(s-1)))))
      }
    };
  }

  /*
   * Candidate V2:
   * Preserve the GLB skin continuously inside Blockbench's native armature
   * representation. Blockbench ArmatureBone stores per-vertex weights and
   * exposes an inverse bind matrix in the preview controller.
   *
   * This is intentionally an intermediate/native candidate. It is NOT yet
   * a claim that vanilla Bedrock serialization preserves those weights.
   */
  function buildNativeBlockbenchWeightedArmatureCandidate(intermediate) {
    const source = glbIntermediateToRouteInput(intermediate);
    const primitive = intermediate.meshes[0]?.primitives[0];
    if (!primitive) throw new Error('HARAGANZITO_NO_PRIMITIVE_FOR_NATIVE_ARMATURE');

    const sourceWeights = primitive.attributes?.WEIGHTS_0 || [];
    const sourceJoints = primitive.attributes?.JOINTS_0 || [];

    const vertices = source.vertices.map((vertex, index) => ({
      index,
      position: [...vertex.position],
      normal: [...vertex.normal],
      uv: [...vertex.uv],
      influences: (sourceJoints[index] || []).map((boneIndex, slot) => ({
        boneIndex,
        boneName: source.bones[boneIndex]?.name || null,
        weight: Number(sourceWeights[index]?.[slot] ?? 0)
      })).filter(influence => influence.weight !== 0)
    }));

    const bones = source.bones.map(bone => ({
      index: bone.index,
      nodeIndex: bone.nodeIndex,
      name: bone.name,
      parent: bone.parent,
      origin: [...bone.position],
      rotationQuaternion: [...bone.quaternion],
      scale: [...bone.scale],
      inverseBindMatrix: clone(bone.inverseBindMatrix)
    }));

    const animations = source.animations.map(animation => ({
      name: animation.name,
      id: animation.id,
      length: animation.length,
      tracks: animation.tracks.map(track => ({
        bone: track.bone,
        path: track.path,
        interpolation: track.interpolation,
        channelMask: track.channelMask,
        keyframes: clone(track.keyframes)
      }))
    }));

    const influenceCount = vertices.map(v => v.influences.length);
    const weightSumErrorMax = vertices.reduce((max, vertex) => {
      const sum = vertex.influences.reduce((s, influence) => s + influence.weight, 0);
      return Math.max(max, Math.abs(sum - 1));
    }, 0);

    return {
      schema: 'haraganzito.candidate.native_blockbench_weighted_armature.v1',
      route: 'native_blockbench_weighted_armature',
      exactSourcePreservation: true,
      runtimeCompatibility: 'not_yet_determined',
      representation: {
        type: 'Blockbench Armature + Mesh',
        weightedVertices: true,
        inverseBindMatrices: true,
        animationTracks: true
      },
      mesh: {
        vertices,
        indices: clone(primitive.indices || []),
        mode: primitive.mode ?? 4,
        material: primitive.material ?? null
      },
      skeleton: {
        bones
      },
      animations,
      diagnostics: {
        vertexCount: vertices.length,
        indexCount: (primitive.indices || []).length,
        boneCount: bones.length,
        animationCount: animations.length,
        maxInfluencesPerVertex: Math.max(0, ...influenceCount),
        minInfluencesPerVertex: influenceCount.length ? Math.min(...influenceCount) : 0,
        weightSumErrorMax
      }
    };
  }

  function buildChinaReferenceCandidate(intermediate) {
    if (!intermediate || !Array.isArray(intermediate.vertices)) {
      throw new Error('HARAGANZITO_NO_INTERMEDIATE_VERTICES');
    }

    const vertexIndex = new Map();
    const vertices = intermediate.vertices.map((vertex, index) => {
      vertexIndex.set(vertex.id ?? index, index);
      const weights = (vertex.weights || []).map(influence => ({
        bone: influence.boneName ?? influence.bone ?? null,
        weight: Number(influence.weight) || 0
      }));
      return {
        pos: Array.from(vertex.position || [0, 0, 0]),
        normal: Array.from(vertex.normal || [0, 1, 0]),
        uvcoord: Array.from(vertex.uv || [0, 0]),
        weight: weights
      };
    });

    const mesh = [{
      material: intermediate.materialPath || null,
      vertices,
      indices: clone(intermediate.polygons || [])
    }];

    const skeleton = (intermediate.bones || []).map(bone => ({
      name: bone.name,
      parent: bone.parent ?? null,
      initpos: Array.from(bone.position || [0, 0, 0]),
      initquaternion: Array.from(bone.quaternion || [0, 0, 0, 1]),
      initscale: Array.from(bone.scale || [1, 1, 1]),
      offmtx: clone(bone.inverseBindMatrix || null),
      boundingbox: clone(bone.boundingBox || null)
    }));

    const animations = (intermediate.animations || []).map(animation => ({
      animation: {
        name: animation.name,
        ID: animation.id ?? null,
        length: Number(animation.length) || 0,
        tracksize: (animation.tracks || []).length,
        tracks: (animation.tracks || []).map(track => ({
          bone: track.bone,
          channelMask: track.channelMask ?? 0,
          keyFramesSize: (track.keyframes || []).length,
          keyframes: (track.keyframes || []).map(keyframe => ({
            time: Number(keyframe.time) || 0,
            pos: Array.from(keyframe.position || [0, 0, 0]),
            quaternion: Array.from(keyframe.quaternion || [0, 0, 0, 1]),
            scale: Array.from(keyframe.scale || [1, 1, 1])
          }))
        }))
      }
    }));

    return {
      schema: 'haraganzito.route.china_polymesh_skeleton_animation.v1',
      route: 'china_polymesh_skeleton_animation',
      mesh,
      skeleton,
      animations
    };
  }

  function search(source, evaluator, options = {}) {
    const maxIterations = Math.max(1, options.maxIterations || ROUTES.length);
    const history = [];
    const tried = new Set();

    for (let i = 0; i < maxIterations; i++) {
      const choice = nextRoute(source, history);
      if (choice.status === 'search_exhausted') break;

      const candidate = evaluator(choice.route, choice.assessment, history);
      if (!candidate || !candidate.errors) {
        history.push({
          schema: 'haraganzito.iteration.record.v2',
          iteration: history.length + 1,
          route: choice.route,
          errors: {},
          diagnostics: {status: 'candidate_generation_failed'},
          changedRepresentation: true
        });
      } else {
        const record = recordIteration(history, candidate);
        history.push(record);
        if (record.classification === 'exact') break;
      }
      tried.add(choice.route);
    }

    const allRoutesTested = tried.size >= ROUTES.length;
    if (history.length) {
      history[history.length - 1].classification =
        classifyIteration(history[history.length - 1], allRoutesTested);
    }

    return {
      schema: 'haraganzito.route-search.v1',
      version: VERSION,
      routesRegistered: ROUTES.length,
      routesTested: tried.size,
      status: history.length && history[history.length - 1].classification === 'exact'
        ? 'exact_found'
        : (allRoutesTested ? 'search_exhausted' : 'search_incomplete'),
      history
    };
  }

  BBPlugin.register('haraganzito_iterator', {
    title: 'Haraganzito Route Iterator',
    author: 'userblund',
    description: 'Search multiple GLB -> Bedrock representations against measurable losses.',
    icon: 'fa-random',
    version: VERSION,
    variant: 'both',
    onload() {
      const bridge = window.HaraganzitoBridge || {};
      window.HaraganzitoIterator = {
        version: VERSION,
        routes: clone(ROUTES),
        sourceCapabilities,
        assessRoute,
        enumerateRoutes,
        nextRoute,
        compareErrors,
        classifyIteration,
        recordIteration,
        assessVanillaSkinningRepresentability,
        buildNativeBlockbenchWeightedArmatureCandidate,
        buildChinaReferenceCandidate,
        glbIntermediateToRouteInput,
        buildRigidPolyMeshCandidate,
        buildBedrockAnimationFiles,
        search
      };
      console.log('[HaraganzitoIterator] v' + VERSION + ' loaded');
      if (!bridge.version) {
        console.warn('[HaraganzitoIterator] HaraganzitoBridge is not loaded; route search APIs remain available, but bridge metrics are not.');
      }
    },
    onunload() {
      delete window.HaraganzitoIterator;
    }
  });
})();
