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

  const VERSION = '0.1.0';

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
        buildChinaReferenceCandidate,
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
