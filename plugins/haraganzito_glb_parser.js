(function(global) {
  'use strict';

  const COMPONENTS = {
    5120: {name:'BYTE', bytes:1, read:(dv,o)=>dv.getInt8(o), integer:true},
    5121: {name:'UNSIGNED_BYTE', bytes:1, read:(dv,o)=>dv.getUint8(o), integer:true},
    5122: {name:'SHORT', bytes:2, read:(dv,o)=>dv.getInt16(o,true), integer:true},
    5123: {name:'UNSIGNED_SHORT', bytes:2, read:(dv,o)=>dv.getUint16(o,true), integer:true},
    5125: {name:'UNSIGNED_INT', bytes:4, read:(dv,o)=>dv.getUint32(o,true), integer:true},
    5126: {name:'FLOAT', bytes:4, read:(dv,o)=>dv.getFloat32(o,true), integer:false}
  };
  const TYPE_SIZE = {SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT2:4, MAT3:9, MAT4:16};

  function componentInfo(type) {
    const c = COMPONENTS[type];
    if (!c) throw new Error('Unsupported glTF componentType: ' + type);
    return c;
  }
  function accessorComponents(accessor) {
    const n = TYPE_SIZE[accessor.type];
    if (!n) throw new Error('Unsupported glTF accessor type: ' + accessor.type);
    return n;
  }
  function align4(n) { return (n + 3) & ~3; }

  function readGLB(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    if (dv.byteLength < 20) throw new Error('HARAGANZITO_GLB_TOO_SMALL');
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('HARAGANZITO_GLB_BAD_MAGIC');
    const version = dv.getUint32(4, true);
    const length = dv.getUint32(8, true);
    if (version !== 2) throw new Error('HARAGANZITO_GLB_UNSUPPORTED_VERSION:' + version);
    if (length > dv.byteLength) throw new Error('HARAGANZITO_GLB_TRUNCATED');
    let offset = 12;
    let json = null;
    const chunks = [];
    while (offset + 8 <= length) {
      const chunkLength = dv.getUint32(offset, true);
      const chunkType = dv.getUint32(offset + 4, true);
      const start = offset + 8;
      const end = start + chunkLength;
      if (end > length) throw new Error('HARAGANZITO_GLB_BAD_CHUNK');
      const bytes = new Uint8Array(arrayBuffer, start, chunkLength);
      if (chunkType === 0x4E4F534A) {
        const text = new TextDecoder('utf-8').decode(bytes).replace(/\u0000+$/g, '').trim();
        json = JSON.parse(text);
      } else if (chunkType === 0x004E4942) {
        chunks.push(bytes.slice().buffer);
      }
      offset = align4(end);
    }
    if (!json) throw new Error('HARAGANZITO_GLB_NO_JSON');
    return {json, binaryChunks: chunks};
  }

  function readAccessor(json, binaryChunks, accessorIndex) {
    const accessor = json.accessors?.[accessorIndex];
    if (!accessor) throw new Error('Missing accessor ' + accessorIndex);
    const components = accessorComponents(accessor);
    const comp = componentInfo(accessor.componentType);
    const count = accessor.count;
    const result = new Array(count);

    if (accessor.sparse) throw new Error('Sparse accessors are not yet supported');

    if (accessor.bufferView === undefined) {
      for (let i = 0; i < count; i++) result[i] = new Array(components).fill(0);
      return result;
    }

    const view = json.bufferViews?.[accessor.bufferView];
    if (!view) throw new Error('Missing bufferView ' + accessor.bufferView);
    const sourceBuffer = binaryChunks[view.buffer ?? 0];
    if (!sourceBuffer) throw new Error('Missing binary buffer ' + (view.buffer ?? 0));
    const stride = view.byteStride || comp.bytes * components;
    const base = (view.byteOffset || 0) + (accessor.byteOffset || 0);
    const dv = new DataView(sourceBuffer);
    const normalized = accessor.normalized === true;

    function normalizeInt(v) {
      switch (accessor.componentType) {
        case 5120: return Math.max(v / 127, -1);
        case 5121: return v / 255;
        case 5122: return Math.max(v / 32767, -1);
        case 5123: return v / 65535;
        case 5125: return v / 4294967295;
        default: return v;
      }
    }

    for (let i = 0; i < count; i++) {
      const values = new Array(components);
      const elementBase = base + i * stride;
      for (let j = 0; j < components; j++) {
        const raw = comp.read(dv, elementBase + j * comp.bytes);
        values[j] = normalized && comp.integer ? normalizeInt(raw) : raw;
      }
      result[i] = values;
    }
    return result;
  }

  function readAccessorFlat(json, binaryChunks, accessorIndex) {
    return readAccessor(json, binaryChunks, accessorIndex).flat();
  }

  function base64FromBytes(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    return btoa(out);
  }

  function readImageMeta(json, binaryChunks, imageIndex, includeData = false) {
    const image = json.images?.[imageIndex];
    if (!image) throw new Error('Missing image ' + imageIndex);
    if (image.bufferView === undefined) {
      return {mimeType:image.mimeType || null, byteLength:null, embedded:false, uri:image.uri || null};
    }
    const view = json.bufferViews?.[image.bufferView];
    if (!view) throw new Error('Missing image bufferView ' + image.bufferView);
    const src = binaryChunks[view.buffer ?? 0];
    if (!src) throw new Error('Missing binary image buffer');
    const meta = {mimeType:image.mimeType || null, byteLength:view.byteLength, embedded:true, uri:null};
    if (includeData) {
      meta.dataUrl = 'data:' + (image.mimeType || 'application/octet-stream') + ';base64,' + base64FromBytes(src.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength));
    }
    return meta;
  }

  function nodeLocal(node) {
    return {
      translation: node.translation ? [...node.translation] : [0,0,0],
      rotation: node.rotation ? [...node.rotation] : [0,0,0,1],
      scale: node.scale ? [...node.scale] : [1,1,1],
      matrix: node.matrix ? [...node.matrix] : null
    };
  }

  function buildNodeTree(json) {
    const nodes = (json.nodes || []).map((node, index) => ({
      index,
      name: node.name || ('node_' + index),
      children: [...(node.children || [])],
      parent: null,
      mesh: node.mesh ?? null,
      skin: node.skin ?? null,
      local: nodeLocal(node)
    }));
    for (const node of nodes) {
      for (const child of node.children) if (nodes[child]) nodes[child].parent = node.index;
    }
    return nodes;
  }

  function parseGLB(arrayBuffer, options = {}) {
    const {json, binaryChunks} = readGLB(arrayBuffer);
    const nodes = buildNodeTree(json);

    const buffers = (json.buffers || []).map((buffer, i) => ({
      index:i, byteLength:buffer.byteLength, uri:buffer.uri || null, embedded:!buffer.uri
    }));

    const images = (json.images || []).map((image, i) => ({
      index:i,
      name:image.name || ('image_' + i),
      ...readImageMeta(json, binaryChunks, i, options.includeImageData === true)
    }));

    const textures = (json.textures || []).map((texture, i) => ({
      index:i, name:texture.name || ('texture_' + i), source:texture.source ?? null, sampler:texture.sampler ?? null
    }));

    const materials = (json.materials || []).map((material, i) => ({
      index:i,
      name:material.name || ('material_' + i),
      pbrMetallicRoughness:material.pbrMetallicRoughness || null,
      normalTexture:material.normalTexture || null,
      occlusionTexture:material.occlusionTexture || null,
      emissiveTexture:material.emissiveTexture || null,
      emissiveFactor:material.emissiveFactor || [0,0,0],
      alphaMode:material.alphaMode || 'OPAQUE',
      alphaCutoff:material.alphaCutoff ?? 0.5,
      doubleSided:!!material.doubleSided,
      extensions:material.extensions || {}
    }));

    const meshes = (json.meshes || []).map((mesh, meshIndex) => ({
      index:meshIndex,
      name:mesh.name || ('mesh_' + meshIndex),
      primitives:(mesh.primitives || []).map((primitive, primitiveIndex) => {
        const attributes = {};
        for (const [semantic, accessorIndex] of Object.entries(primitive.attributes || {})) {
          attributes[semantic] = readAccessor(json, binaryChunks, accessorIndex);
        }
        let indices = null;
        if (primitive.indices !== undefined) indices = readAccessorFlat(json, binaryChunks, primitive.indices);
        const targets = (primitive.targets || []).map(target => {
          const out = {};
          for (const [semantic, accessorIndex] of Object.entries(target)) out[semantic] = readAccessor(json,binaryChunks,accessorIndex);
          return out;
        });
        return {
          index:primitiveIndex,
          mode:primitive.mode ?? 4,
          material:primitive.material ?? null,
          attributes,
          indices,
          targets,
          extras:primitive.extras || null,
          extensions:primitive.extensions || null
        };
      })
    }));

    const skins = (json.skins || []).map((skin, skinIndex) => ({
      index:skinIndex,
      name:skin.name || ('skin_' + skinIndex),
      joints:[...(skin.joints || [])],
      skeleton:skin.skeleton ?? null,
      inverseBindMatrices:skin.inverseBindMatrices === undefined ? null : readAccessor(json,binaryChunks,skin.inverseBindMatrices),
      jointNames:(skin.joints || []).map(index => nodes[index]?.name || ('node_' + index))
    }));

    const animations = (json.animations || []).map((animation, animationIndex) => ({
      index:animationIndex,
      name:animation.name || ('animation_' + animationIndex),
      samplers:(animation.samplers || []).map((sampler, samplerIndex) => ({
        index:samplerIndex,
        input:readAccessorFlat(json,binaryChunks,sampler.input),
        output:readAccessor(json,binaryChunks,sampler.output),
        interpolation:sampler.interpolation || 'LINEAR'
      })),
      channels:(animation.channels || []).map((channel, channelIndex) => ({
        index:channelIndex,
        sampler:channel.sampler,
        targetNode:channel.target?.node ?? null,
        targetNodeName:channel.target?.node === undefined ? null : nodes[channel.target.node]?.name || null,
        path:channel.target?.path || null
      }))
    }));

    return {
      schema:'haraganzito.gltf.intermediate.v1',
      source:{
        format:'glTF 2.0 / GLB',
        version:json.asset?.version || null,
        generator:json.asset?.generator || null,
        originalByteLength:arrayBuffer.byteLength
      },
      sources:{
        asset:json.asset || null,
        scenes:json.scenes || [],
        defaultScene:json.scene ?? null,
        extensionsUsed:json.extensionsUsed || [],
        extensionsRequired:json.extensionsRequired || [],
        extras:json.extras || null
      },
      buffers,nodes,meshes,skins,animations,materials,textures,images
    };
  }

  function summarize(intermediate) {
    const meshVertices = intermediate.meshes.reduce((sum,m) => sum + m.primitives.reduce((s,p) => s + (p.attributes.POSITION?.length || 0),0),0);
    const meshIndices = intermediate.meshes.reduce((sum,m) => sum + m.primitives.reduce((s,p) => s + (p.indices?.length || 0),0),0);
    return {
      schema:intermediate.schema,
      fileBytes:intermediate.source.originalByteLength,
      meshes:intermediate.meshes.length,
      primitives:intermediate.meshes.reduce((s,m)=>s+m.primitives.length,0),
      vertices:meshVertices,
      indices:meshIndices,
      nodes:intermediate.nodes.length,
      skins:intermediate.skins.length,
      joints:intermediate.skins.reduce((s,skin)=>s+skin.joints.length,0),
      animations:intermediate.animations.length,
      animationNames:intermediate.animations.map(a=>a.name),
      materials:intermediate.materials.length,
      textures:intermediate.textures.length,
      images:intermediate.images.length
    };
  }

  const api = {readGLB, readAccessor, parseGLB, summarize};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) {
    global.HaraganzitoGLBParser = api;
    if (global.BBPlugin && typeof global.BBPlugin.register === 'function') {
      global.BBPlugin.register('haraganzito_glb_parser', {
        title:'Haraganzito GLB Parser',
        author:'userblund',
        description:'Loss-preserving GLB 2.0 parser for the Haraganzito bridge intermediate representation.',
        icon:'icon-import',
        version:'0.1.0',
        variant:'both',
        onload(){ global.HaraganzitoGLBParser = api; },
        onunload(){ delete global.HaraganzitoGLBParser; }
      });
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
