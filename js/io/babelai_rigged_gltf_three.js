import { THREE } from '../lib/libs';
import { Dialog } from '../interface/dialog';
import { Animation } from '../animations/animation';
import { BoneAnimator } from '../animations/timeline_animators';
import { Armature } from '../outliner/types/armature';
import { ArmatureBone } from '../outliner/types/armature_bone';

function fail(message) {
	throw new Error(`[BabelAI GLB] ${message}`);
}

function isIdentityTRS(object, eps = 1e-6) {
	return object.position.length() <= eps
		&& Math.abs(object.rotation.x) <= eps
		&& Math.abs(object.rotation.y) <= eps
		&& Math.abs(object.rotation.z) <= eps
		&& Math.abs(object.scale.x - 1) <= eps
		&& Math.abs(object.scale.y - 1) <= eps
		&& Math.abs(object.scale.z - 1) <= eps;
}

function textureDataURL(texture) {
	const image = texture?.image;
	if (!image) return null;
	if (typeof image.src === 'string' && image.src) return image.src;
	if (image.width && image.height) {
		const canvas = document.createElement('canvas');
		canvas.width = image.width;
		canvas.height = image.height;
		const ctx = canvas.getContext('2d');
		ctx.drawImage(image, 0, 0);
		return canvas.toDataURL('image/png');
	}
	return null;
}

function validateLoadedGLTF(gltf, skinnedMesh) {
	const json = gltf?.parser?.json;
	if (!json) fail('GLTFLoader no expuso el JSON original.');
	if ((json.meshes || []).length !== 1) fail(`Se requiere exactamente 1 mesh; hay ${(json.meshes || []).length}.`);
	if ((json.skins || []).length !== 1) fail(`Se requiere exactamente 1 skin; hay ${(json.skins || []).length}.`);
	const meshDef = json.meshes[0];
	if ((meshDef.primitives || []).length !== 1) fail('La ruta estricta requiere exactamente 1 primitive.');
	if ((meshDef.primitives[0].mode ?? 4) !== 4) fail('La primitive debe usar TRIANGLES.');
	const required = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'];
	for (const key of required) if (meshDef.primitives[0].attributes?.[key] === undefined) fail(`Falta ${key}.`);
	for (const animation of json.animations || []) {
		for (const sampler of animation.samplers || []) {
			if ((sampler.interpolation || 'LINEAR') !== 'LINEAR') fail(`La animación ${animation.name || 'sin nombre'} usa ${sampler.interpolation || 'LINEAR'}; esta ruta exige LINEAR.`);
		}
	}
	const skeleton = skinnedMesh.skeleton;
	if (!skeleton || !skeleton.bones.length) fail('La malla cargada no tiene Skeleton.');
	const skinIndex = skinnedMesh.geometry.getAttribute('skinIndex');
	const skinWeight = skinnedMesh.geometry.getAttribute('skinWeight');
	if (!skinIndex || !skinWeight) fail('Three.js no entregó skinIndex/skinWeight.');
	if (skinIndex.count !== skinWeight.count) fail('skinIndex y skinWeight tienen distinta cantidad de vértices.');
	for (let i = 0; i < skinWeight.count; i++) {
		let sum = 0;
		for (let c = 0; c < 4; c++) {
			const joint = skinIndex.getComponent(i, c);
			const weight = skinWeight.getComponent(i, c);
			if (!Number.isFinite(weight) || weight < -1e-8) fail(`Peso inválido en vértice ${i}.`);
			if (!Number.isInteger(joint) || joint < 0 || joint >= skeleton.bones.length) fail(`Joint inválido en vértice ${i}.`);
			sum += weight;
		}
		if (Math.abs(sum - 1) > 1e-4) fail(`Los pesos del vértice ${i} no suman 1 (${sum}).`);
	}
	if (!skinnedMesh.geometry.getAttribute('position') || !skinnedMesh.geometry.getAttribute('uv')) fail('POSITION o UV ausente tras GLTFLoader.');
	if (!skeleton.boneInverses || skeleton.boneInverses.length !== skeleton.bones.length) fail('boneInverses incompletos.');
	return json;
}

function installExactRuntimeHook() {
	const current = BoneAnimator.prototype.displayFrame;
	if (current.__babelai_exact_glb) return;
	function wrapped(multiplier = 1) {
		if (this.animation?.babelai_three_runtime) {
			this.animation.babelai_three_runtime.apply(Timeline.time, multiplier);
			return this;
		}
		return current.call(this, multiplier);
	}
	wrapped.__babelai_exact_glb = true;
	BoneAnimator.prototype.displayFrame = wrapped;
}

function makeRuntime(clip, threeScene, threeToBB) {
	const mixer = new THREE.AnimationMixer(threeScene);
	const action = mixer.clipAction(clip);
	action.enabled = true;
	action.clampWhenFinished = true;
	action.setEffectiveWeight(1);
	action.play();
	let lastTime = NaN;
	return {
		apply(time, multiplier = 1) {
			if (time !== lastTime) {
			lastTime = time;
			mixer.setTime(Math.max(0, time));
			threeToBB.forEach(pair => {
				const bb = pair.bb.mesh;
				const src = pair.three;
				bb.position.copy(src.position);
				bb.quaternion.copy(src.quaternion);
				bb.scale.copy(src.scale);
			});
			Project.model_3d.updateMatrixWorld(true);
		}
		if (multiplier !== 1) {
			const w = Math.clamp(multiplier, 0, 1);
			threeToBB.forEach(pair => {
				const bb = pair.bb.mesh;
				const bind = pair.bind;
				bb.position.copy(bind.position.clone().lerp(bb.position, w));
				bb.quaternion.copy(bind.quaternion.clone().slerp(bb.quaternion, w));
				bb.scale.copy(bind.scale.clone().lerp(bb.scale, w));
			});
			Project.model_3d.updateMatrixWorld(true);
		}
	}
};
}

function importWithThreeGLTF(file) {
	if (typeof THREE.GLTFLoader !== 'function') {
		fail('THREE.GLTFLoader no está cargado. La ruta exacta usa el GLTF Importer oficial que ya tienes instalado.');
	}
	return new Promise((resolve, reject) => {
		const manager = new THREE.LoadingManager();
		const loader = new THREE.GLTFLoader(manager);
		loader.parse(file.content, '', resolve, reject);
	});
}

async function importRiggedGLBExact(file) {
	const gltf = await importWithThreeGLTF(file);
	const scene = gltf.scene;
	if (!scene) fail('GLTFLoader no devolvió scene.');
	scene.updateMatrixWorld(true);
	const skinnedMeshes = [];
	scene.traverse(node => { if (node.isSkinnedMesh) skinnedMeshes.push(node); });
	if (skinnedMeshes.length !== 1) fail(`Se requiere exactamente 1 SkinnedMesh; hay ${skinnedMeshes.length}.`);
	const skinnedMesh = skinnedMeshes[0];
	const json = validateLoadedGLTF(gltf, skinnedMesh);
	const skeleton = skinnedMesh.skeleton;
	const rootBones = skeleton.bones.filter(b => !skeleton.bones.includes(b.parent));
	if (rootBones.length !== 1) fail(`Se requiere un único root de armature; hay ${rootBones.length}.`);
	const rootBone = rootBones[0];
	const armatureParent = rootBone.parent;
	if (!armatureParent) fail('El root del skeleton no tiene parent de escena.');
	const rootParentMatrix = armatureParent.matrixWorld.clone();
	const rootsShareParent = rootBones.every(b => b.parent === armatureParent);
	if (!rootsShareParent) fail('Los roots del skeleton no comparten parent.');
	if (!isIdentityTRS(skinnedMesh)) fail('La ruta estricta actual requiere SkinnedMesh con transform local identidad; no se pierde información por aplicarlo silenciosamente.');
	if (!skinnedMesh.geometry.index) fail('La malla GLTF cargada no tiene índice; la ruta estricta actual exige índice.');

	const material = Array.isArray(skinnedMesh.material) ? skinnedMesh.material[0] : skinnedMesh.material;
	const map = material?.map;
	const dataURL = textureDataURL(map);
	if (!dataURL) fail('No se pudo recuperar la textura base desde Three.js sin una recodificación externa.');
	const texture = new Texture({name: map?.name || 'texture'}).fromDataURL(dataURL).add();
	texture.keep_size = true;
	if (map?.image?.width) texture.width = map.image.width;
	if (map?.image?.height) texture.height = map.image.height;
	Project.texture_width = texture.width || 16;
	Project.texture_height = texture.height || 16;

	setupProject(Formats.free);
	Project.name = 'BabelAI — Rigged GLB Exact';

	const armature = new Armature({name: armatureParent.name || 'GLTF_Armature'});
	armature.addTo('root').init();
	armature.mesh.matrixAutoUpdate = false;
	armature.mesh.matrix.copy(rootParentMatrix);
	armature.mesh.updateMatrixWorld(true);

	const boneByThree = new Map();
	const pairs = [];
	const threeToBB = [];

	function addBoneTree(threeBone, parentBB) {
		const index = skeleton.bones.indexOf(threeBone);
		if (index < 0) fail(`Bone ${threeBone.name} no pertenece al skeleton.`);
		const euler = new THREE.Euler().setFromQuaternion(threeBone.quaternion, Format.euler_order);
		const bind = {
			position: threeBone.position.clone(),
			quaternion: threeBone.quaternion.clone(),
			scale: threeBone.scale.clone(),
		};
		const bbBone = new ArmatureBone({
			name: threeBone.name || `bone_${index}`,
			origin: bind.position.toArray(),
			rotation: [THREE.MathUtils.radToDeg(euler.x), THREE.MathUtils.radToDeg(euler.y), THREE.MathUtils.radToDeg(euler.z)],
			connected: false,
		});
		bbBone.addTo(parentBB).init();
		bbBone.length = Math.max(1, threeBone.children.find(c => skeleton.bones.includes(c))?.position.length() || 1);
		bbBone.mesh.scale.copy(bind.scale);
		bbBone.mesh.inverse_bind_matrix.copy(skeleton.boneInverses[index]);
		bbBone.babelai_three_uuid = threeBone.uuid;
		bbBone.babelai_joint_index = index;
		bbBone.babelai_bind_local = bind;
		boneByThree.set(threeBone, bbBone);
		pairs.push({three: threeBone, bb: bbBone, bind});
		for (const child of threeBone.children) {
			if (skeleton.bones.includes(child)) addBoneTree(child, bbBone);
		}
	}
	addBoneTree(rootBone, armature);
	if (boneByThree.size !== skeleton.bones.length) fail(`No se reconstruyeron todos los huesos (${boneByThree.size}/${skeleton.bones.length}).`);

	const mesh = new Mesh({name: skinnedMesh.name || 'GLTF_Mesh', vertices: {}});
	mesh.addTo(armature);
	mesh.init();
	const position = skinnedMesh.geometry.getAttribute('position');
	const uv = skinnedMesh.geometry.getAttribute('uv');
	const normal = skinnedMesh.geometry.getAttribute('normal');
	const indexAttr = skinnedMesh.geometry.index;
	const skinIndex = skinnedMesh.geometry.getAttribute('skinIndex');
	const skinWeight = skinnedMesh.geometry.getAttribute('skinWeight');
	const vertexKeys = [];
	for (let i = 0; i < position.count; i++) {
		vertexKeys.push(mesh.addVertices([position.getX(i), position.getY(i), position.getZ(i)]));
	}
	for (let i = 0; i < indexAttr.count; i += 3) {
		const ids = [indexAttr.getX(i), indexAttr.getX(i + 1), indexAttr.getX(i + 2)];
		const faceUV = {};
		for (const v of ids) faceUV[vertexKeys[v]] = [uv.getX(v) * texture.width, uv.getY(v) * texture.height];
		mesh.addFaces(new MeshFace(mesh, {vertices: ids.map(v => vertexKeys[v]), uv: faceUV, texture}));
	}
	mesh.userData ||= {};
	mesh.userData.babelai = {
		source: 'THREE.GLTFLoader',
		vertex_count: position.count,
		triangle_count: indexAttr.count / 3,
		original_normals: normal ? Array.from(normal.array) : null,
		joint_count: skeleton.bones.length,
		inverse_bind_matrices: skeleton.boneInverses.map(m => m.toArray()),
	};
	for (let v = 0; v < position.count; v++) {
		for (let c = 0; c < 4; c++) {
			const weight = skinWeight.getComponent(v, c);
			if (weight <= 0) continue;
			const joint = skinIndex.getComponent(v, c);
			const bbBone = boneByThree.get(skeleton.bones[joint]);
			if (!bbBone) fail(`No se encontró el bone ${joint} para el vértice ${v}.`);
			bbBone.setVertexWeight(mesh, vertexKeys[v], weight);
		}
	}

	installExactRuntimeHook();
	for (const clip of gltf.animations || []) {
		const animation = new Animation({
			name: clip.name || `animation_${Animation.all.length}`,
			saved_name: clip.name || `animation_${Animation.all.length}`,
			length: clip.duration,
			loop: /idle|walk|run|sprint/i.test(clip.name || '') ? 'loop' : 'once',
			override: true,
		});
		animation.add();
		for (const pair of pairs) animation.getBoneAnimator(pair.bb);
		animation.babelai_three_runtime = makeRuntime(clip, scene, pairs);
	}

	mesh.select();
	armature.select();
	Project.model_3d.updateMatrixWorld(true);
	Canvas.updateAll();
	return {json, scene, skinnedMesh, skeleton, armature, mesh};
}

let importDialog;
BARS.defineActions(() => {
	new Action('babelai_import_rigged_glb_three', {
		name: 'Import GLB Rigged (BabelAI Exact / Three.js)',
		icon: 'accessibility',
		category: 'file',
		condition: {modes: ['edit']},
		click() {
			if (!importDialog) {
				importDialog = new Dialog('babelai_import_rigged_glb_three', {
					title: 'BabelAI — Import GLB Rigged Exact',
					form: {
						file: {type: 'file', label: 'GLB', return_as: 'file', extensions: ['glb'], resource_id: 'babelai_exact_glb', filetype: 'glTF Binary Model', readtype: 'buffer'},
						info: {type: 'info', text: 'Usa el GLTFLoader de Three.js para conservar Skeleton, boneInverses, skinIndex, skinWeight y clips de animación. No usa pesos dominantes ni poly_mesh.'}
					},
					onConfirm(result) {
						if (!result.file) return false;
						importRiggedGLBExact(result.file).catch(error => {
							console.error('[BabelAI exact GLB]', error);
							Blockbench.showMessageBox({title: 'BabelAI GLB rechazado', message: error?.message || String(error), icon: 'error', width: 700});
						});
					}
				});
			}
			importDialog.show();
		}
	});
});
