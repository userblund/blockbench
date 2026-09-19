/**
 * Haraganzito World-Rigid V2
 *
 * Geometry-isolation route built from the real Haraganzito v1.0.0 static
 * poly_mesh calibration. It preserves all 50,000 source triangles, assigns
 * each triangle to its dominant GLB bone, and bakes each source bone's world
 * transform into independent Bedrock bone tracks.
 *
 * This is NOT lossless skinning. It is a controlled rigid approximation
 * whose bind geometry is calibrated to the supplied working v1.0.0 addon.
 */
(function() {
  'use strict';

  const VERSION = '0.1.0';
  const CAL_A = [-16, 0, 0, 0, 16, 0, 0, 0, 16];
  const CAL_O = [0.1242, 10.1243, -0.1353];
  const FPS = 60;

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function transformPoint(p) {
    return [
      CAL_A[0]*p[0] + CAL_A[1]*p[1] + CAL_A[2]*p[2] + CAL_O[0],
      CAL_A[3]*p[0] + CAL_A[4]*p[1] + CAL_A[5]*p[2] + CAL_O[1],
      CAL_A[6]*p[0] + CAL_A[7]*p[1] + CAL_A[8]*p[2] + CAL_O[2]
    ];
  }
  function transformNormal(n) {
    const p = [-n[0], n[1], n[2]];
    const l = Math.hypot(...p) || 1;
    return p.map(x => x/l);
  }
  function qToEuler(q) {
    const e = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion().fromArray(q).normalize(),
      'XYZ'
    );
    return [Math.radToDeg(e.x), Math.radToDeg(e.y), Math.radToDeg(e.z)];
  }
  function qToM(q) {
    return new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion().fromArray(q).normalize()
    );
  }
  function compose(t, q, s) {
    return new THREE.Matrix4().compose(
      new THREE.Vector3().fromArray(t),
      new THREE.Quaternion().fromArray(q).normalize(),
      new THREE.Vector3().fromArray(s)
    );
  }
  function nodeLocal(node) {
    const l = node?.local || {};
    return compose(
      l.translation || [0,0,0],
      l.rotation || [0,0,0,1],
      l.scale || [1,1,1]
    );
  }
  function worldResolver(nodes) {
    const parents = new Map();
    nodes.forEach(n => (n.children || []).forEach(c => parents.set(c, n.index)));
    const cache = new Map();
    function world(i) {
      if (cache.has(i)) return cache.get(i).clone();
      const m = nodeLocal(nodes[i]);
      const out = parents.has(i)
        ? world(parents.get(i)).multiply(m)
        : m;
      cache.set(i, out.clone());
      return out;
    }
    return world;
  }
  function interp(times, values, t) {
    if (t <= times[0]) return values[0];
    if (t >= times[times.length-1]) return values[values.length-1];
    let lo = 0, hi = times.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid; else hi = mid;
    }
    const a = (t - times[lo]) / (times[hi] - times[lo]);
    const A = values[lo], B = values[hi];
    return A.map((v,i) => v + (B[i]-v)*a);
  }
  function evalAnimationWorld(intermediate, animationIndex, t) {
    const nodes = intermediate.nodes;
    const local = nodes.map(n => {
      const l = n.local || {};
      return {
        translation: [...(l.translation || [0,0,0])],
        rotation: [...(l.rotation || [0,0,0,1])],
        scale: [...(l.scale || [1,1,1])]
      };
    });
    const anim = intermediate.animations[animationIndex];
    for (const ch of anim.channels || []) {
      const s = anim.samplers[ch.sampler];
      const node = local[ch.targetNode];
      if (!s || !node) continue;
      const value = interp(s.input, s.output, t);
      if (ch.path === 'translation') node.translation = value;
      else if (ch.path === 'rotation') node.rotation = value;
      else if (ch.path === 'scale') node.scale = value;
    }
    const mats = nodes.map((n,i) =>
      compose(local[i].translation, local[i].rotation, local[i].scale)
    );
    const parents = new Map();
    nodes.forEach(n => (n.children || []).forEach(c => parents.set(c, n.index)));
    const cache = new Map();
    function world(i) {
      if (cache.has(i)) return cache.get(i).clone();
      const out = parents.has(i)
        ? world(parents.get(i)).multiply(mats[i])
        : mats[i];
      cache.set(i, out.clone());
      return out;
    }
    return nodes.map((_,i) => world(i));
  }
  function decomposeTRS(matrix) {
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
    matrix.decompose(pos, quat, scale);
    return {position: pos.toArray(), quaternion: quat.toArray(), scale: scale.toArray()};
  }
  function matrixToBedrockDelta(D, pivotBedrock) {
    const E = new THREE.Matrix4().set(
      -1,0,0,0,
      0,1,0,0,
      0,0,1,0,
      0,0,0,1
    );
    const linear = new THREE.Matrix4().copy(D);
    const e4 = E.clone().multiply(linear).multiply(E);
    const tglb = new THREE.Vector3(D.elements[12], D.elements[13], D.elements[14]);
    const tbed = tglb.multiplyScalar(16);
    tbed.x *= -1;
    const decomp = decomposeTRS(e4);
    const p = new THREE.Vector3(...pivotBedrock).applyMatrix4(e4);
    p.add(tbed).sub(new THREE.Vector3(...pivotBedrock));
    return {
      position: p.toArray(),
      rotation: qToEuler(decomp.quaternion),
      scale: decomp.scale
    };
  }
  function finite(x) { return Number.isFinite(x) ? Number(x.toFixed(9)) : 0; }
  function clean(v) {
    if (Array.isArray(v)) return v.map(clean);
    return finite(v);
  }
  function sanitizeId(name) {
    return String(name || 'animation')
      .replace(/[^A-Za-z0-9_.-]+/g, '_')
      .replace(/^\W+/, '')
      .toLowerCase() || 'animation';
  }
  function manifest(name, description, h, m, type) {
    return {
      format_version: 2,
      header: {name, description, uuid: h, version: [1,0,0], min_engine_version: [1,16,0]},
      modules: [{type, uuid: m, version: [1,0,0]}]
    };
  }
  function uid() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    if (typeof guid === 'function') return guid();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random()*16|0, v = c==='x'?r:(r&3)|8;
      return v.toString(16);
    });
  }

  function build(source) {
    const primitive = source.meshes?.[0]?.primitives?.[0];
    const skin = source.skins?.[0];
    if (!primitive || !skin) throw new Error('HARAGANZITO_WORLD_RIGID_REQUIRES_SKINNED_GLB');

    const positions = primitive.attributes.POSITION || [];
    const normals = primitive.attributes.NORMAL || [];
    const uvs = primitive.attributes.TEXCOORD_0 || [];
    const joints = primitive.attributes.JOINTS_0 || [];
    const weights = primitive.attributes.WEIGHTS_0 || [];
    const indices = primitive.indices || [];
    const world = worldResolver(source.nodes);

    const bindWorld = skin.joints.map(n => world(n));
    const pivots = bindWorld.map(m => {
      const e = m.elements;
      return transformPoint([e[12], e[13], e[14]]);
    });

    function posKey(p) {
      return p.map(v => Number(v).toFixed(6)).join(',');
    }

    const meshes = skin.joints.map(() => ({
      positions: [], normals: [], uvs: [], polys: [],
      pmap: new Map(), nmap: new Map(), umap: new Map()
    }));

    const triBones = [];
    for (let i=0; i<indices.length; i+=3) {
      const score = new Array(skin.joints.length).fill(0);
      for (let c=0; c<3; c++) {
        const vi = indices[i+c];
        for (let s=0; s<(joints[vi] || []).length; s++) {
          score[joints[vi][s]] += Number(weights[vi]?.[s] || 0);
        }
      }
      let best = 0;
      for (let j=1; j<score.length; j++) if (score[j] > score[best]) best = j;
      triBones.push(best);
    }

    function addCorner(bi, vi) {
      const m = meshes[bi];
      const p = transformPoint(positions[vi]);
      const key = posKey(p);
      let pi = m.pmap.get(key);
      if (pi === undefined) {
        pi = m.positions.length;
        m.pmap.set(key, pi);
        m.positions.push([
          p[0]-pivots[bi][0], p[1]-pivots[bi][1], p[2]-pivots[bi][2]
        ]);
      }
      const n = transformNormal(normals[vi] || [0,1,0]);
      const nk = n.map(v => Number(v).toFixed(6)).join(',');
      let ni = m.nmap.get(nk);
      if (ni === undefined) {
        ni = m.normals.length; m.nmap.set(nk, ni); m.normals.push(n);
      }
      const uv = [uvs[vi]?.[0] ?? 0, 1-(uvs[vi]?.[1] ?? 0)];
      const uk = uv.map(v => Number(v).toFixed(6)).join(',');
      let ui = m.umap.get(uk);
      if (ui === undefined) {
        ui = m.uvs.length; m.umap.set(uk, ui); m.uvs.push(uv);
      }
      return [pi, ni, ui];
    }

    for (let t=0; t<triBones.length; t++) {
      const bi = triBones[t];
      const base = t*3;
      const a = indices[base], b = indices[base+1], c = indices[base+2];
      const face = [addCorner(bi,a), addCorner(bi,b), addCorner(bi,c)];
      face.push(face[0]);
      meshes[bi].polys.push(face);
    }

    const bones = meshes.map((m,bi) => {
      const node = source.nodes[skin.joints[bi]];
      const bone = {
        name: node?.name || ('bone_'+bi),
        pivot: clean(pivots[bi])
      };
      if (m.polys.length) {
        bone.poly_mesh = {
          normalized_uvs: true,
          positions: clean(m.positions),
          normals: clean(m.normals),
          uvs: clean(m.uvs),
          polys: m.polys
        };
      }
      return bone;
    });

    const animationEntries = {};
    for (let ai=0; ai<(source.animations || []).length; ai++) {
      const anim = source.animations[ai];
      const duration = Math.max(0, ...anim.samplers.flatMap(s => s.input || []));
      const samples = Math.ceil(duration * FPS)+1;
      const times = Array.from({length:samples}, (_,i) => duration*i/(samples-1 || 1));
      const worldSamples = times.map(t => evalAnimationWorld(source, ai, t));
      const boneTracks = {};
      for (let bi=0; bi<skin.joints.length; bi++) {
        const ni = skin.joints[bi];
        const W0i = bindWorld[bi].clone().invert();
        const pos = {}, rot = {}, scale = {};
        for (let k=0; k<times.length; k++) {
          const D = worldSamples[k][ni].clone().multiply(W0i);
          const v = matrixToBedrockDelta(D, pivots[bi]);
          const key = times[k].toFixed(6);
          pos[key] = clean(v.position);
          rot[key] = clean(v.rotation);
          scale[key] = clean(v.scale);
        }
        boneTracks[bones[bi].name] = {position:pos, rotation:rot, scale};
      }
      const id = 'animation.haraganzito_'+sanitizeId(anim.name);
      animationEntries[id] = {
        animation_length: duration,
        loop: true,
        bones: boneTracks
      };
    }

    return {
      geometry: {
        format_version: '1.12.0',
        'minecraft:geometry': [{
          description: {
            identifier: 'geometry.haraganzito_world_rigid_v2',
            texture_width: 4096,
            texture_height: 4096,
            visible_bounds_width: 1,
            visible_bounds_height: 1,
            visible_bounds_offset: [0,0,0]
          },
          bones
        }]
      },
      animations: {format_version:'1.8.0', animations:animationEntries},
      diagnostics: {
        route: 'bedrock_world_rigid_v2',
        exactBindGeometry: true,
        exactAnimation: false,
        fps: FPS,
        sourceVertices: positions.length,
        sourceTriangles: Math.floor(indices.length/3),
        generatedTriangles: triBones.length,
        bones: bones.length,
        bonesWithGeometry: meshes.filter(m => m.polys.length).length,
        continuousWeightsDiscarded: true,
        calibration: {matrix3x3: [[-16,0,0],[0,16,0],[0,0,16]], offset: CAL_O}
      }
    };
  }

  async function exportCandidate() {
    if (typeof JSZip === 'undefined') throw new Error('HARAGANZITO_JSZIP_UNAVAILABLE');
    const source = Project?.haraganzito_source_intermediate;
    if (!source) throw new Error('HARAGANZITO_SOURCE_INTERMEDIATE_NOT_AVAILABLE');
    const candidate = build(source);
    const base = Project.haraganzito_source_intermediate;
    const primitive = base.meshes[0].primitives[0];
    const mi = primitive.material;
    const material = mi == null ? null : base.materials?.[mi];
    const ti = material?.pbrMetallicRoughness?.baseColorTexture?.index;
    const tex = ti == null ? null : base.textures?.[ti];
    const image = tex?.source == null ? null : base.images?.[tex.source];
    const match = /^data:([^;]+);base64,(.+)$/s.exec(image?.dataUrl || '');
    const rpHeader=uid(), rpModule=uid(), bpHeader=uid(), bpModule=uid();

    const animationNames={};
    const ids=Object.keys(candidate.animations.animations);
    for (const id of ids) animationNames[id.replace('animation.haraganzito_','')]=id;

    const clientEntity={
      format_version:'1.10.0',
      'minecraft:client_entity':{
        description:{
          identifier:'robot:haraganzito',
          materials:{default:'entity_alphatest'},
          textures:{default:'textures/entity/haraganzito'},
          geometry:{default:'geometry.haraganzito_world_rigid_v2'},
          animations:animationNames,
          scripts:{animate:['idle']},
          render_controllers:['controller.render.default']
        }
      }
    };

    const behavior={
      format_version:'1.16.100',
      'minecraft:entity':{
        description:{identifier:'robot:haraganzito',is_spawnable:true,is_summonable:true,is_experimental:false},
        components:{
          'minecraft:physics':{has_gravity:true,has_collision:true},
          'minecraft:pushable':{is_pushable:false},
          'minecraft:push_through':{value:1}
        }
      }
    };

    const rpManifest=manifest('Haraganzito World-Rigid V2 Resource','Haraganzito calibrated rigid-animation candidate.',rpHeader,rpModule,'resources');
    const bpManifest=manifest('Haraganzito World-Rigid V2 Behavior','Haraganzito calibrated rigid-animation candidate.',bpHeader,bpModule,'data');
    bpManifest.dependencies=[{uuid:rpHeader,version:[1,0,0]}];

    const rpZip=new JSZip();
    rpZip.file('manifest.json',JSON.stringify(rpManifest,null,2));
    rpZip.file('models/entity/haraganzito.geo.json',JSON.stringify(candidate.geometry,null,2));
    rpZip.file('animations/haraganzito.animation.json',JSON.stringify(candidate.animations,null,2));
    rpZip.file('entity/haraganzito.entity.json',JSON.stringify(clientEntity,null,2));
    rpZip.file('WORLD_RIGID_V2_REPORT.json',JSON.stringify(candidate.diagnostics,null,2));
    if (match) {
      const ext=match[1]==='image/jpeg'?'jpg':'png';
      rpZip.file('textures/entity/haraganzito.'+ext,match[2],{base64:true});
    }

    const bpZip=new JSZip();
    bpZip.file('manifest.json',JSON.stringify(bpManifest,null,2));
    bpZip.file('entities/haraganzito.behavior.json',JSON.stringify(behavior,null,2));

    const [rpBlob,bpBlob]=await Promise.all([
      rpZip.generateAsync({type:'blob'}),
      bpZip.generateAsync({type:'blob'})
    ]);
    const addon=new JSZip();
    addon.file('Haraganzito_WorldRigidV2_RP.mcpack',rpBlob);
    addon.file('Haraganzito_WorldRigidV2_BP.mcpack',bpBlob);
    addon.file('WORLD_RIGID_V2_REPORT.json',JSON.stringify(candidate.diagnostics,null,2));
    const blob=await addon.generateAsync({type:'blob'});

    Blockbench.export({
      resource_id:'haraganzito_world_rigid_v2',
      type:'Haraganzito World-Rigid V2 Candidate',
      extensions:['mcaddon'],
      name:'Haraganzito_WorldRigid_v2',
      savetype:'zip',
      content:blob,
      startpath:Project.export_path
    });
    return candidate;
  }

  BARS.defineActions(function() {
    new Action('export_haraganzito_world_rigid_v2', {
      name:'Haraganzito: Export World-Rigid V2 Candidate',
      icon:'archive',
      category:'file',
      condition:()=>!!Project?.haraganzito_source_intermediate,
      click(){
        exportCandidate().then(()=>{
          Blockbench.showStatusMessage('Haraganzito World-Rigid V2 exported',3000);
        }).catch(err=>{
          console.error('[Haraganzito] World-Rigid V2 export failed',err);
          Blockbench.showStatusMessage('Haraganzito World-Rigid V2 failed: '+err.message,5000);
        });
      }
    });
  });

  BBPlugin.register('haraganzito_world_rigid_v2',{
    title:'Haraganzito World-Rigid V2',
    author:'userblund',
    description:'Calibrated rigid poly_mesh animation route based on the working Haraganzito v1.0.0 geometry.',
    icon:'archive',
    version:VERSION,
    variant:'both',
    min_version:'4.10.4',
    onload(){
      globalThis.HaraganzitoWorldRigidV2={version:VERSION,build,exportCandidate};
      console.log('[Haraganzito] World-Rigid V2 loaded');
    },
    onunload(){delete globalThis.HaraganzitoWorldRigidV2;}
  });
})();
