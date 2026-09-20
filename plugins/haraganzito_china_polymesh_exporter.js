/**
 * Haraganzito China-Edition polymesh exporter (experimental research route)
 *
 * Based on the structure documented in Blockbench issue #2706:
 *   polymesh: mesh[].vertices[].weight
 *   skeleton: initpos/initquaternion/initscale/offmtx
 *   animation: tracks/channelMask/keyframes
 *
 * This does NOT claim compatibility with international/vanilla Bedrock.
 */
(function() {
  'use strict';

  const VERSION = '0.1.0';
  const CAL = {
    matrix: [[-16,0,0],[0,16,0],[0,0,16]],
    offset: [0.1242,10.1243,-0.1353]
  };

  function clone(v){ return JSON.parse(JSON.stringify(v)); }
  function round(v){ return Number.isFinite(v) ? Number(v.toFixed(9)) : 0; }
  function clean(v){ return Array.isArray(v) ? v.map(clean) : round(v); }

  function getBaseColorImage(intermediate) {
    const p = intermediate.meshes?.[0]?.primitives?.[0];
    const mat = p?.material == null ? null : intermediate.materials?.[p.material];
    const ti = mat?.pbrMetallicRoughness?.baseColorTexture?.index;
    const tex = ti == null ? null : intermediate.textures?.[ti];
    return tex?.source == null ? null : intermediate.images?.[tex.source] || null;
  }

  function matrixFromNode(node) {
    const l=node?.local||{};
    return new THREE.Matrix4().compose(
      new THREE.Vector3().fromArray(l.translation||[0,0,0]),
      new THREE.Quaternion().fromArray(l.rotation||[0,0,0,1]).normalize(),
      new THREE.Vector3().fromArray(l.scale||[1,1,1])
    );
  }

  function worldResolver(nodes) {
    const cache=new Map();
    function world(i){
      if(cache.has(i)) return cache.get(i).clone();
      const n=nodes[i];
      const local=matrixFromNode(n);
      const out=n.parent==null ? local : world(n.parent).multiply(local);
      cache.set(i,out.clone());
      return out;
    }
    return world;
  }

  function decompose(m){
    const p=new THREE.Vector3(), q=new THREE.Quaternion(), s=new THREE.Vector3();
    m.decompose(p,q,s);
    return {p:p.toArray(),q:q.toArray(),s:s.toArray()};
  }

  function convertWorldMatrixToBedrock(m){
    const S=new THREE.Matrix4().set(
      -16,0,0,0,
      0,16,0,0,
      0,0,16,0,
      0,0,0,1
    );
    const T=new THREE.Matrix4().makeTranslation(...CAL.offset);
    const B=T.multiply(S);
    return B.multiply(m).multiply(B.clone().invert());
  }

  function animationWorldMatrices(intermediate, animation, t){
    const local=intermediate.nodes.map(n => {
      const l=n.local||{};
      return {
        translation:[...(l.translation||[0,0,0])],
        rotation:[...(l.rotation||[0,0,0,1])],
        scale:[...(l.scale||[1,1,1])]
      };
    });

    function sample(s,t){
      const times=s.input||[], values=s.output||[];
      if(!times.length) return [];
      if(t<=times[0]) return values[0];
      if(t>=times[times.length-1]) return values[values.length-1];
      let lo=0,hi=times.length-1;
      while(hi-lo>1){
        const mid=(lo+hi)>>1;
        if(times[mid]<=t) lo=mid; else hi=mid;
      }
      const a=(t-times[lo])/(times[hi]-times[lo]);
      return values[lo].map((v,i)=>v+(values[hi][i]-v)*a);
    }

    for(const ch of animation.channels||[]){
      const s=animation.samplers[ch.sampler];
      if(!s) continue;
      const v=sample(s,t);
      if(ch.path==='translation') local[ch.targetNode].translation=v;
      else if(ch.path==='rotation') local[ch.targetNode].rotation=v;
      else if(ch.path==='scale') local[ch.targetNode].scale=v;
    }

    const cache=new Map();
    function world(i){
      if(cache.has(i)) return cache.get(i).clone();
      const l=local[i];
      let m=new THREE.Matrix4().compose(
        new THREE.Vector3().fromArray(l.translation),
        new THREE.Quaternion().fromArray(l.rotation).normalize(),
        new THREE.Vector3().fromArray(l.scale)
      );
      const p=intermediate.nodes[i].parent;
      if(p!=null) m=world(p).multiply(m);
      cache.set(i,m.clone());
      return m;
    }
    return intermediate.nodes.map((_,i)=>world(i));
  }

  function sourceToChina(intermediate){
    const primitive=intermediate.meshes?.[0]?.primitives?.[0];
    const skin=intermediate.skins?.[0];
    if(!primitive || !skin) throw new Error('HARAGANZITO_CHINA_REQUIRES_SKINNED_PRIMITIVE');

    const positions=primitive.attributes.POSITION||[];
    const normals=primitive.attributes.NORMAL||[];
    const uvs=primitive.attributes.TEXCOORD_0||[];
    const joints=primitive.attributes.JOINTS_0||[];
    const weights=primitive.attributes.WEIGHTS_0||[];
    const indices=primitive.indices||[];
    const jointNames=skin.joints.map((n,i)=>intermediate.nodes[n]?.name||('bone_'+i));

    const boneIndexByNode=new Map(skin.joints.map((n,i)=>[n,i]));

    const vertices=positions.map((p,i)=>{
      const pb=[
        -16*p[0]+CAL.offset[0],
        16*p[1]+CAL.offset[1],
        16*p[2]+CAL.offset[2]
      ];
      const uv=[uvs[i]?.[0]??0,1-(uvs[i]?.[1]??0)];
      const ws=[];
      for(let k=0;k<(joints[i]||[]).length;k++){
        const w=Number(weights[i]?.[k]||0);
        if(w>0) ws.push([jointNames[joints[i][k]],round(w)]);
      }
      return {
        pos:clean(pb),
        normal:clean(normals[i]||[0,1,0]),
        uvcoord:clean(uv),
        weight:ws.length===1 ? ws[0] : ws,
        weights:ws
      };
    });

    const tris=[];
    for(let i=0;i+2<indices.length;i+=3) tris.push([indices[i],indices[i+1],indices[i+2]]);

    const world=worldResolver(intermediate.nodes);
    const bindWorld=skin.joints.map(n=>world(n));
    const bindBed=bindWorld.map(convertWorldMatrixToBedrock);
    const skeleton=[];

    for(let i=0;i<skin.joints.length;i++){
      const nodeIndex=skin.joints[i];
      const parentNode=intermediate.nodes[nodeIndex]?.parent;
      const parentJoint=boneIndexByNode.get(parentNode);
      const localBed=parentJoint==null
        ? bindBed[i]
        : bindBed[parentJoint].clone().invert().multiply(bindBed[i]);
      const trs=decompose(localBed);
      skeleton.push({
        name:jointNames[i],
        parent:parentJoint==null?null:jointNames[parentJoint],
        initpos:clean(trs.p),
        initquaternion:clean(trs.q),
        initscale:clean(trs.s),
        offmtx:clean((skin.inverseBindMatrices?.[i])||[]),
        source_node_index:nodeIndex,
        source_joint_index:i
      });
    }

    const animations=[];
    for(const animation of intermediate.animations||[]){
      const duration=Math.max(0,...animation.samplers.flatMap(s=>s.input||[]));
      const times=[...new Set(animation.samplers.flatMap(s=>s.input||[]))].sort((a,b)=>a-b);
      const tracks=[];
      for(let bi=0;bi<skin.joints.length;bi++){
        const keyframes=[];
        for(const t of times){
          const wb=animationWorldMatrices(intermediate,animation,t);
          const currentWorld=convertWorldMatrixToBedrock(wb[skin.joints[bi]]);
          const parentJoint=boneIndexByNode.get(intermediate.nodes[skin.joints[bi]]?.parent);
          const local=parentJoint==null
            ? currentWorld
            : convertWorldMatrixToBedrock(wb[skin.joints[parentJoint]]).invert().multiply(currentWorld);
          const trs=decompose(local);
          keyframes.push({
            time:round(t),
            pos:clean(trs.p),
            quaternion:clean(trs.q),
            scale:clean(trs.s)
          });
        }
        tracks.push({
          bone:jointNames[bi],
          channelMask:7,
          keyFramesSize:keyframes.length,
          keyframes
        });
      }
      animations.push({
        name:animation.name,
        ID:animation.index,
        length:round(duration),
        tracksize:tracks.length,
        tracks
      });
    }

    return {
      polymesh:{
        mesh:[{
          material:'textures/entity/haraganzito.png',
          indices:tris,
          vertices
        }]
      },
      skeleton:{skeleton},
      animations,
      diagnostics:{
        route:'china_polymesh_skeleton_animation',
        sourceVertices:positions.length,
        sourceTriangles:Math.floor(indices.length/3),
        bones:skin.joints.length,
        animations:animations.length,
        maxInfluences:4,
        multiInfluenceVertices:weights.filter(row=>row.filter(v=>Number(v)>0).length>1).length,
        calibration:clone(CAL),
        runtimeCompatibility:'UNPROVEN'
      }
    };
  }

  async function exportChina() {
    if(typeof JSZip==='undefined') throw new Error('HARAGANZITO_JSZIP_UNAVAILABLE');
    const intermediate=Project?.haraganzito_source_intermediate;
    if(!intermediate) throw new Error('HARAGANZITO_SOURCE_INTERMEDIATE_NOT_AVAILABLE');

    const result=sourceToChina(intermediate);
    const image=getBaseColorImage(intermediate);
    const match=/^data:([^;]+);base64,(.+)$/s.exec(image?.dataUrl||'');
    const zip=new JSZip();

    zip.file('README_EXPERIMENTAL.txt',
      'Experimental Minecraft China Edition polymesh/skeleton/animation package.\n' +
      'Structure follows Blockbench issue #2706. Vanilla international Bedrock compatibility is UNPROVEN.\n'
    );
    zip.file('REPORT.json',JSON.stringify(result.diagnostics,null,2));
    zip.file('polymesh.json',JSON.stringify(result.polymesh));
    zip.file('skeleton.json',JSON.stringify(result.skeleton));

    for(const anim of result.animations){
      zip.file('animations/'+anim.name+'.json',JSON.stringify({animation:anim}));
    }

    if(match) {
      const ext=match[1]==='image/jpeg'?'jpg':'png';
      zip.file('textures/entity/haraganzito.'+ext,match[2],{base64:true});
    }

    const blob=await zip.generateAsync({type:'blob'});
    Blockbench.export({
      resource_id:'haraganzito_china_polymesh_experimental',
      type:'Haraganzito China Polymesh Experimental',
      extensions:['zip'],
      name:'Haraganzito_ChinaPolymesh_Experimental',
      savetype:'zip',
      content:blob,
      startpath:Project.export_path
    });
  }

  BBPlugin.register('haraganzito_china_polymesh_exporter',{
    title:'Haraganzito China Polymesh Experimental',
    author:'userblund',
    description:'Exports the GLB skin to the polymesh+skeleton+animation structure documented for Minecraft China Edition.',
    icon:'account_tree',
    version:VERSION,
    variant:'both',
    min_version:'4.10.4',
    onload(){
      globalThis.HaraganzitoChinaPolymesh={VERSION,sourceToChina,exportChina};
      new Action('export_haraganzito_china_polymesh',{
        name:'Haraganzito: Export China Polymesh Experimental',
        icon:'archive',
        category:'file',
        condition:()=>!!Project?.haraganzito_source_intermediate,
        click:()=>exportChina().catch(err=>{
          console.error('[Haraganzito China]',err);
          Blockbench.showStatusMessage('China polymesh export failed: '+err.message,5000);
        })
      });
    },
    onunload(){
      delete globalThis.HaraganzitoChinaPolymesh;
      if(window.Action?.remove) window.Action.remove('export_haraganzito_china_polymesh');
    }
  });
})();
