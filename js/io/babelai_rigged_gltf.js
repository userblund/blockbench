import { THREE } from '../lib/libs';
import { Dialog } from '../interface/dialog';
import { Animation } from '../animations/animation';
import { BoneAnimator } from '../animations/timeline_animators';
import { Armature } from '../outliner/types/armature';
import { ArmatureBone } from '../outliner/types/armature_bone';

const GLTF_COMPONENTS = {
	5120: {size: 1, read: 'getInt8', normalizedMin: -1, normalizedMax: 1},
	5121: {size: 1, read: 'getUint8', normalizedMin: 0, normalizedMax: 1},
	5122: {size: 2, read: 'getInt16', normalizedMin: -1, normalizedMax: 1},
	5123: {size: 2, read: 'getUint16', normalizedMin: 0, normalizedMax: 1},
	5125: {size: 4, read: 'getUint32'},
	5126: {size: 4, read: 'getFloat32'},
};
const GLTF_TYPES = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16};

function readString(bytes) {
	return new TextDecoder('utf-8').decode(bytes);
}

function readGLB(buffer) {
	const bytes = new Uint8Array(buffer);
	if (bytes.length < 20) throw new Error('GLB demasiado pequeño');
	const dv = new DataView(buffer);
	if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('No es un GLB');
	if (dv.getUint32(4, true) !== 2) throw new Error('Solo GLB v2');
	if (dv.getUint32(8, true) !== bytes.length) throw new Error('GLB truncado');
	let offset = 12;
	let json = null;
	let bin = new Uint8Array(0);
	while (offset < bytes.length) {
		const length = dv.getUint32(offset, true);
		const type = dv.getUint32(offset + 4, true);
		offset += 8;
		const chunk = bytes.slice(offset, offset + length);
		offset += length;
		if (type === 0x4e4f534a) json = JSON.parse(readString(chunk));
		else if (type === 0x004e4942) bin = chunk;
	}
	if (!json) throw new Error('GLB sin chunk JSON');
	return {json, bin};
}

function readAccessor(gltf, bin, index) {
	const acc = gltf.accessors[index];
	if (!acc || acc.sparse) throw new Error(`Accessor ${index} no soportado o sparse`);
	const view = gltf.bufferViews[acc.bufferView];
	const comp = GLTF_COMPONENTS[acc.componentType];
	const count = GLTF_TYPES[acc.type];
	if (!view || !comp || !count) throw new Error(`Accessor ${index}: tipo no soportado`);
	const stride = view.byteStride || comp.size * count;
	const start = (view.byteOffset || 0) + (acc.byteOffset || 0);
	const out = new Array(acc.count);
	const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
	for (let i = 0; i < acc.count; i++) {
		const row = new Array(count);
		let p = start + i * stride;
		for (let j = 0; j < count; j++) {
			let value = dv[comp.read](p, true);
			p += comp.size;
			if (acc.normalized) {
				if (acc.componentType === 5120) value = Math.max(value / 127, -1);
				else if (acc.componentType === 5121) value /= 255;
				else if (acc.componentType === 5122) value = Math.max(value / 32767, -1);
				else if (acc.componentType === 5123) value /= 65535;
			}
			row[j] = value;
		}
		out[i] = row;
	}
	return out;
}

function readMatrixAccessor(gltf, bin, index) {
	const rows = readAccessor(gltf, bin, index);
	return rows.map(row => new THREE.Matrix4().fromArray(row));
}

function nodeLocalMatrix(node) {
	if (node.matrix) return new THREE.Matrix4().fromArray(node.matrix);
	const t = node.translation || [0, 0, 0];
	const r = node.rotation || [0, 0, 0, 1];
	const s = node.scale || [1, 1, 1];
	return new THREE.Matrix4().compose(
		new THREE.Vector3().fromArray(t),
		new THREE.Quaternion().fromArray(r),
		new THREE.Vector3().fromArray(s),
	);
}

function buildDefaultWorldMatrices(gltf) {
	const nodes = gltf.nodes || [];
	const worlds = nodes.map(() => new THREE.Matrix4());
	const visiting = new Set();
	const parents = {};
	for (let i = 0; i < nodes.length; i++) {
		for (const child of (nodes[i].children || [])) {
			if (parents[child] !== undefined) throw new Error(`Node ${child} tiene multiples padres`);
			parents[child] = i;
		}
	}
	function solve(index) {
		if (visiting.has(index)) throw new Error('Jerarquia GLTF ciclica');
		if (worlds[index].userData?.done) return worlds[index];
		visiting.add(index);
		const parent = parents[index];
		const local = nodeLocalMatrix(nodes[index]);
		const world = parent === undefined ? local : solve(parent).clone().multiply(local);
		worlds[index].copy(world);
		worlds[index].userData = {done: true};
		visiting.delete(index);
		return worlds[index];
	}
	for (let i = 0; i < nodes.length; i++) solve(i);
	return {worlds, parents};
}

function matrixToLocalTRS(matrix) {
	const position = new THREE.Vector3();
	const quaternion = new THREE.Quaternion();
	const scale = new THREE.Vector3();
	matrix.decompose(position, quaternion, scale);
	return {position, quaternion, scale};
}

function mimeForImage(bytes, declared) {
	if (declared) return declared;
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (bytes.length >= 12 && readString(bytes.slice(0, 4)) === 'RIFF' && readString(bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
	throw new Error('Formato de textura embebida no reconocido');
}

function imageDimensions(bytes, mime) {
	if (mime === 'image/png' && bytes.length >= 24) {
		const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		return [dv.getUint32(16, false), dv.getUint32(20, false)];
	}
	if (mime === 'image/jpeg') {
		for (let i = 2; i + 9 < bytes.length;) {
			if (bytes[i] !== 0xff) { i++; continue; }
			const marker = bytes[i + 1];
			const len = (bytes[i + 2] << 8) | bytes[i + 3];
			if (marker >= 0xc0 && marker <= 0xc3 && i + 8 < bytes.length) return [(bytes[i + 7] << 8) | bytes[i + 8], (bytes[i + 5] << 8) | bytes[i + 6]];
			if (len < 2) break;
			i += 2 + len;
		}
	}
	return [16, 16];
}

function bytesToDataURL(bytes, mime) {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
	return `data:${mime};base64,${btoa(binary)}`;
}

function textureFromGLTF(gltf, bin, materialIndex) {
	const material = gltf.materials?.[materialIndex];
	if (!material?.pbrMetallicRoughness?.baseColorTexture) throw new Error('Material sin baseColorTexture');
	const texIndex = material.pbrMetallicRoughness.baseColorTexture.index;
	const texDef = gltf.textures?.[texIndex];
	const imageDef = gltf.images?.[texDef?.source];
	if (!imageDef?.bufferView) throw new Error('La textura base no esta embebida en el GLB');
	const view = gltf.bufferViews[imageDef.bufferView];
	const raw = bin.slice(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
	const mime = mimeForImage(raw, imageDef.mimeType);
	const dataUrl = bytesToDataURL(raw, mime);
	const texture = new Texture({name: imageDef.name || 'texture'}).fromDataURL(dataUrl).add();
	texture.keep_size = true;
	texture.internal = true;
	texture.source = dataUrl;
	const [width, height] = imageDimensions(raw, mime);
	texture.width = width;
	texture.height = height;
	return {texture, material, width, height};
}

function sampleLinearTrack(track, time, path) {
	const times = track.times;
	const values = track.values;
	if (!times.length) return path === 'rotation' ? [0, 0, 0, 1] : path === 'scale' ? [1, 1, 1] : [0, 0, 0];
	if (time <= times[0]) return values[0].slice();
	if (time >= times[times.length - 1]) return values[values.length - 1].slice();
	let i = 0;
	while (i + 1 < times.length && times[i + 1] < time) i++;
	const dt = times[i + 1] - times[i];
	const alpha = dt > 0 ? (time - times[i]) / dt : 0;
	const a = values[i];
	const b = values[i + 1];
	if (path === 'rotation') {
		const qa = new THREE.Quaternion().fromArray(a);
		const qb = new THREE.Quaternion().fromArray(b);
		return qa.slerp(qb, alpha).toArray();
	}
	return a.map((v, k) => v + (b[k] - v) * alpha);
}

function createAnimationRuntime(gltf, bin, animationDef, nodeToBone, defaultLocals) {
	const samplerCache = {};
	const channelsByNode = {};
	let length = 0;
	for (const channel of animationDef.channels || []) {
		const sampler = animationDef.samplers[channel.sampler];
		if (!sampler || sampler.interpolation && sampler.interpolation !== 'LINEAR') throw new Error(`Animacion ${animationDef.name || 'sin nombre'} usa interpolacion no lineal`);
		const times = readAccessor(gltf, bin, sampler.input).map(row => row[0]);
		const values = readAccessor(gltf, bin, sampler.output);
		const path = channel.target?.path;
		if (!['translation', 'rotation', 'scale'].includes(path)) throw new Error(`Animacion ${animationDef.name || 'sin nombre'} usa canal ${path}`);
		samplerCache[channel.sampler] = {times, values};
		const node = channel.target.node;
		(channelsByNode[node] ||= {})[path] = samplerCache[channel.sampler];
		if (times.length) length = Math.max(length, times[times.length - 1]);
	}
	return {
		length,
		channelsByNode,
		defaultLocals,
		applyBone(animator, time, multiplier = 1) {
			const nodeIndex = animator.babelaiNodeIndex;
			const localDefaults = defaultLocals[nodeIndex];
			const channels = channelsByNode[nodeIndex] || {};
			const translation = channels.translation ? sampleLinearTrack(channels.translation, time, 'translation') : localDefaults.position.toArray();
			const rotation = channels.rotation ? sampleLinearTrack(channels.rotation, time, 'rotation') : localDefaults.quaternion.toArray();
			const scale = channels.scale ? sampleLinearTrack(channels.scale, time, 'scale') : localDefaults.scale.toArray();
			const bone = nodeToBone[nodeIndex]?.mesh;
			if (!bone) return;
			bone.position.fromArray(translation);
			bone.quaternion.fromArray(rotation).normalize();
			bone.scale.fromArray(scale);
			if (multiplier !== 1) {
				const bind = nodeToBone[nodeIndex]?.babelaiBindLocal;
				if (bind) {
					const w = Math.clamp(multiplier, 0, 1);
					bone.position.copy(bind.position.clone().lerp(bone.position, w));
					bone.quaternion.copy(bind.quaternion.clone().slerp(bone.quaternion, w));
					bone.scale.copy(bind.scale.clone().lerp(bone.scale, w));
				}
			}
		}
	};
}

function installAnimationRuntimeHook() {
	const original = BoneAnimator.prototype.displayFrame;
	if (original.__babelai_wrapped) return;
	function wrapped(multiplier = 1) {
		if (this.animation?.babelai_gltf_runtime) {
			this.animation.babelai_gltf_runtime.applyBone(this, Timeline.time, multiplier);
			return this;
		}
		return original.call(this, multiplier);
	}
	wrapped.__babelai_wrapped = true;
	BoneAnimator.prototype.displayFrame = wrapped;
}

function importRiggedGLB(file) {
	const {json: gltf, bin} = readGLB(file.content);
	const {worlds, parents} = buildDefaultWorldMatrices(gltf);
	const meshes = gltf.meshes || [];
	const skins = gltf.skins || [];
	if (meshes.length !== 1 || skins.length !== 1) throw new Error(`Ruta estricta: se requiere 1 mesh y 1 skin (recibidos ${meshes.length}/${skins.length})`);
	const meshDef = meshes[0];
	const primitives = meshDef.primitives || [];
	if (primitives.length !== 1 || (primitives[0].mode ?? 4) !== 4) throw new Error('Ruta estricta: una sola primitiva TRIANGLES');
	const primitive = primitives[0];
	const attrs = primitive.attributes || {};
	for (const required of ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0']) if (attrs[required] === undefined) throw new Error(`Falta atributo GLTF ${required}`);
	const skin = skins[0];
	if (!skin.inverseBindMatrices) throw new Error('Skin sin inverseBindMatrices');
	const jointNodes = skin.joints || [];
	if (!jointNodes.length) throw new Error('Skin sin joints');
	const jointSet = new Set(jointNodes);
	const roots = jointNodes.filter(j => !jointSet.has(parents[j]));
	if (roots.length !== 1) throw new Error(`La ruta estricta requiere un solo root de skin (recibidos ${roots.length})`);
	const rootNode = roots[0];
	const rootParentNode = parents[rootNode];
	if (rootParentNode === undefined) throw new Error('El root de skin debe tener un parent de escena estable');
	for (const a of gltf.animations || []) for (const c of a.channels || []) if (!jointSet.has(c.target.node)) throw new Error(`La animacion ${a.name || 'sin nombre'} anima un nodo no perteneciente al skin`);
	const meshNodes = [];
	for (let ni = 0; ni < gltf.nodes.length; ni++) if (gltf.nodes[ni].mesh === 0) meshNodes.push(ni);
	if (meshNodes.length !== 1) throw new Error(`Se requiere un unico node para mesh 0 (recibidos ${meshNodes.length})`);
	const meshNode = meshNodes[0];
	const meshLocalTRS = matrixToLocalTRS(nodeLocalMatrix(gltf.nodes[meshNode]));
	const meshLocalIdentity = meshLocalTRS.position.length() < 1e-7 && Math.abs(meshLocalTRS.scale.x - 1) < 1e-7 && Math.abs(meshLocalTRS.scale.y - 1) < 1e-7 && Math.abs(meshLocalTRS.scale.z - 1) < 1e-7 && Math.abs(meshLocalTRS.quaternion.x) < 1e-7 && Math.abs(meshLocalTRS.quaternion.y) < 1e-7 && Math.abs(meshLocalTRS.quaternion.z) < 1e-7 && Math.abs(Math.abs(meshLocalTRS.quaternion.w) - 1) < 1e-7;
	if (!meshLocalIdentity) throw new Error('Ruta estricta actual: mesh node con transform local no identidad');
	const armatureParentMatrix = worlds[rootParentNode].clone();
	const inverseBinds = readMatrixAccessor(gltf, bin, skin.inverseBindMatrices);
	const bindWorld = inverseBinds.map(m => m.clone().invert());
	const defaultLocals = gltf.nodes.map(node => matrixToLocalTRS(nodeLocalMatrix(node)));
	const bindLocals = {};
	const jointIndex = Object.fromEntries(jointNodes.map((n, i) => [n, i]));
	for (let i = 0; i < jointNodes.length; i++) {
		const nodeIndex = jointNodes[i];
		const parentJoint = jointSet.has(parents[nodeIndex]) ? parents[nodeIndex] : null;
		bindLocals[nodeIndex] = parentJoint === null ? armatureParentMatrix.clone().invert().multiply(bindWorld[i]) : bindWorld[jointIndex[parentJoint]].clone().invert().multiply(bindWorld[i]);
	}
	setupProject(Formats.free);
	Project.name = gltf.asset?.generator ? `BabelAI - ${gltf.asset.generator}` : 'BabelAI Rigged GLB';
	const armature = new Armature({name: 'GLTF_Armature'});
	armature.addTo('root');
	armature.init();
	armature.mesh.matrixAutoUpdate = false;
	armature.mesh.matrix.copy(armatureParentMatrix);
	armature.mesh.updateMatrixWorld(true);
	const nodeToBone = {};
	const pending = new Set(jointNodes);
	function addChildren(parentNodeIndex, outlinerParent) {
		for (const nodeIndex of jointNodes) {
			if (parents[nodeIndex] !== parentNodeIndex || !pending.has(nodeIndex)) continue;
			pending.delete(nodeIndex);
			const trs = bindLocals[nodeIndex];
			const boneEuler = new THREE.Euler().setFromQuaternion(trs.quaternion, Format.euler_order);
			const bone = new ArmatureBone({name: gltf.nodes[nodeIndex].name || `bone_${nodeIndex}`, connected: false});
			bone.origin = trs.position.toArray();
			bone.rotation = [THREE.MathUtils.radToDeg(boneEuler.x), THREE.MathUtils.radToDeg(boneEuler.y), THREE.MathUtils.radToDeg(boneEuler.z)];
			bone.length = Math.max(0.5, trs.position.length());
			bone.addTo(outlinerParent).init();
			bone.babelaiNodeIndex = nodeIndex;
			bone.babelaiBindLocal = {position: trs.position.clone(), quaternion: trs.quaternion.clone(), scale: trs.scale.clone()};
			bone.mesh.scale.copy(trs.scale);
			nodeToBone[nodeIndex] = bone;
			addChildren(nodeIndex, bone);
		}
	}
	addChildren(rootNode, armature);
	if (pending.size) throw new Error('No se pudo reconstruir toda la jerarquia de huesos');
	const positions = readAccessor(gltf, bin, attrs.POSITION);
	const v = positions.map(row => new THREE.Vector3(row[0], row[1], row[2]));
	const uv = readAccessor(gltf, bin, attrs.TEXCOORD_0);
	const joints = readAccessor(gltf, bin, attrs.JOINTS_0);
	const weights = readAccessor(gltf, bin, attrs.WEIGHTS_0);
	const indices = primitive.indices === undefined ? Array.from({length: v.length}, (_, i) => i) : readAccessor(gltf, bin, primitive.indices).map(r => r[0]);
	const materialInfo = textureFromGLTF(gltf, bin, primitive.material ?? 0);
	Project.texture_width = materialInfo.width;
	Project.texture_height = materialInfo.height;
	const mesh = new Mesh({name: gltf.nodes[meshNode].name || 'GLTF_Mesh', vertices: {}});
	mesh.addTo(armature);
	for (const p of v) mesh.addVertices(p.toArray());
	mesh.armature = armature.uuid;
	const vertexKeys = Object.keys(mesh.vertices);
	for (let f = 0; f < indices.length; f += 3) {
		const vi = [indices[f], indices[f + 1], indices[f + 2]];
		const faceUV = {};
		for (let k = 0; k < 3; k++) {
			const src = uv[vi[k]];
			faceUV[vertexKeys[vi[k]]] = [src[0] * materialInfo.width, (1 - src[1]) * materialInfo.height];
		}
		mesh.addFaces(new MeshFace(mesh, {vertices: vi.map(x => vertexKeys[x]), uv: faceUV, texture: materialInfo.texture}));
	}
	mesh.init();
	for (let vindex = 0; vindex < weights.length; vindex++) {
		const jointRow = joints[vindex];
		const weightRow = weights[vindex];
		for (let k = 0; k < 4; k++) {
			const weight = weightRow[k];
			if (!(weight > 0)) continue;
			const targetJoint = jointNodes[jointRow[k]];
			const bone = nodeToBone[targetJoint];
			if (bone) bone.setVertexWeight(mesh, vertexKeys[vindex], weight);
		}
	}
	mesh.userData ||= {};
	mesh.userData.babelai = {source: 'gltf', vertex_count: v.length, triangles: indices.length / 3, original_normals: readAccessor(gltf, bin, attrs.NORMAL), joint_nodes: jointNodes.slice(), inverse_bind_matrices: inverseBinds.map(m => m.toArray())};
	installAnimationRuntimeHook();
	for (const animationDef of gltf.animations || []) {
		const runtime = createAnimationRuntime(gltf, bin, animationDef, nodeToBone, defaultLocals);
		const animation = new Animation({name: animationDef.name || `animation_${Animation.all.length}`, saved_name: animationDef.name || `animation_${Animation.all.length}`, length: runtime.length, loop: /idle|walk|run|sprint/i.test(animationDef.name || '') ? 'loop' : 'once'});
		animation.babelai_gltf_runtime = runtime;
		animation.add();
		for (const nodeIndex of jointNodes) {
			const animator = animation.getBoneAnimator(nodeToBone[nodeIndex]);
			if (animator) animator.babelaiNodeIndex = nodeIndex;
		}
	}
	armature.select();
	mesh.select();
	Canvas.updateAll();
	Canvas.updateView({elements: [mesh], element_aspects: {geometry: true}});
	return {armature, mesh};
}

let importDialog;
BARS.defineActions(() => {
	new Action('babelai_import_rigged_glb', {
		name: 'Import GLB Rigged (BabelAI Lossless)',
		icon: 'accessibility',
		category: 'file',
		condition: {modes: ['edit']},
		click() {
			if (!importDialog) {
				importDialog = new Dialog('babelai_import_rigged_glb', {
					title: 'BabelAI — Import GLB Rigged',
					form: {
						file: {type: 'file', label: 'GLB', return_as: 'file', extensions: ['glb'], resource_id: 'babelai_rigged_glb', filetype: 'glTF Binary Model', readtype: 'buffer'},
						info: {type: 'info', text: 'Ruta estricta: preserva vertices, UV, huesos, pesos, inverse bind matrices y animaciones lineales. Rechaza conversiones no demostrables.'}
					},
					onConfirm(result) {
						if (!result.file) return false;
						try { importRiggedGLB(result.file); }
						catch (error) {
							console.error('[BabelAI GLB]', error);
							Blockbench.showMessageBox({title: 'BabelAI GLB rechazado', message: `${error?.message || error}`, icon: 'error', width: 620});
						}
					}
				});
			}
			importDialog.show();
		}
	});
});
