import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';

const VERSION = '0.1.0';
const r4 = (n: number) => Math.round(n * 10000) / 10000;

let loader_promise: Promise<GLTFLoader> | null = null;

function getLoader(): Promise<GLTFLoader> {
	if (!loader_promise) loader_promise = Promise.resolve(new GLTFLoader());
	return loader_promise;
}

function toArrayBuffer(data: any): ArrayBuffer {
	if (data instanceof ArrayBuffer) return data;
	if (ArrayBuffer.isView(data)) {
		return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	}
	throw new Error('The selected GLB did not provide binary data.');
}

function getUniformWorldScale(object: THREE.Object3D): number {
	const s = new THREE.Vector3();
	object.getWorldScale(s);
	return (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3 || 1;
}

function quatToEulerArray(q: THREE.Quaternion): ArrayVector3 {
	const order = Format?.euler_order || 'ZYX';
	const e = new THREE.Euler().setFromQuaternion(q, order as any);
	const d = 180 / Math.PI;
	return [r4(e.x * d), r4(e.y * d), r4(e.z * d)];
}

function makeBbTexture(three_texture: THREE.Texture, cache: Map<string, Texture>): Texture | null {
	const key = three_texture.uuid;
	if (cache.has(key)) return cache.get(key)!;
	const image: any = three_texture.image;
	if (!image) return null;
	try {
		const canvas = document.createElement('canvas');
		canvas.width = image.width || 1;
		canvas.height = image.height || 1;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
		const bb = new Texture().fromDataURL(canvas.toDataURL('image/png'));
		bb.name = three_texture.name || 'gltf_texture';
		bb.add(false);
		cache.set(key, bb);
		return bb;
	} catch (error) {
		console.error('[Rigged glTF] texture conversion failed', error);
		return null;
	}
}

function parseTrackName(name: string): {name: string, property: string} | null {
	const match = name.match(/^(?:.*\.)?([^./]+)\.(position|quaternion|scale)$/);
	if (!match) return null;
	return {name: match[1], property: match[2] === 'quaternion' ? 'rotation' : match[2]};
}

function addAnimatorKeyframe(animator: any, time: number, channel: string, value: ArrayVector3 | [number, number, number], interpolation = 'linear') {
	if (!animator || typeof animator.addKeyframe !== 'function') return;
	const data_point = {
		x: String(r4(value[0])),
		y: String(r4(value[1])),
		z: String(r4(value[2]))
	};
	animator.addKeyframe({
		channel,
		time,
		interpolation,
		data_points: [data_point]
	});
}

function nearestArmatureNode(root_bone: THREE.Bone): THREE.Object3D {
	let p = root_bone.parent;
	while (p && p.type === 'Bone') p = p.parent;
	return p || (root_bone.parent || root_bone);
}

function createArmatureForSkeleton(skeleton: THREE.Skeleton, scale: number) {
	const bones = skeleton.bones;
	const sourceRoot = bones.find(b => !bones.includes(b.parent as any)) || bones[0];
	const armatureSource = nearestArmatureNode(sourceRoot);
	const uniformWorldScale = getUniformWorldScale(armatureSource);

	const armature = new Armature({name: 'gltf_armature'});
	armature.addTo('root');
	armature.isOpen = true;
	armature.createUniqueName();
	armature.init();

	const boneMap = new Map<THREE.Bone, ArmatureBone>();
	const namedMap = new Map<string, ArmatureBone>();
	const worldQuaternion = armatureSource.getWorldQuaternion(new THREE.Quaternion());
	const worldMatrix = armatureSource.matrixWorld.clone();
	const restLocalPosition = new Map<THREE.Bone, THREE.Vector3>();

	function addBone(source: THREE.Bone, parent: Armature | ArmatureBone) {
		const localPosition = source.position.clone();
		const localQuaternion = source.quaternion.clone();
		const isRoot = source.parent?.type !== 'Bone';
		let position: THREE.Vector3;
		let rotation: THREE.Quaternion;
		if (isRoot) {
			position = new THREE.Vector3().setFromMatrixPosition(source.matrixWorld).multiplyScalar(scale);
			rotation = source.getWorldQuaternion(new THREE.Quaternion());
		} else {
			position = localPosition.multiplyScalar(uniformWorldScale * scale);
			rotation = localQuaternion;
		}

		const bb = new ArmatureBone({
			name: source.name || `bone_${boneMap.size}`,
			origin: [r4(position.x), r4(position.y), r4(position.z)],
			rotation: quatToEulerArray(rotation),
			length: 4,
			width: 2,
			connected: false,
		});
		bb.addTo(parent).init();
		bb.userData = bb.userData || {};
		bb.userData.gltfBoneName = source.name;
		bb.userData.gltfRestLocalPosition = [localPosition.x, localPosition.y, localPosition.z];
		bb.userData.gltfRestLocalQuaternion = [localQuaternion.x, localQuaternion.y, localQuaternion.z, localQuaternion.w];
		boneMap.set(source, bb);
		if (source.name) namedMap.set(source.name, bb);
		if ((source as any).uuid) namedMap.set((source as any).uuid, bb);

		for (const child of source.children) {
			if (child.type === 'Bone' && bones.includes(child as THREE.Bone)) addBone(child as THREE.Bone, bb);
		}
	}

	addBone(sourceRoot, armature);

	for (const source of bones) {
		const bb = boneMap.get(source);
		if (!bb) continue;
		const children = source.children.filter(c => c.type === 'Bone' && bones.includes(c as THREE.Bone)) as THREE.Bone[];
		if (children.length) {
			const child = boneMap.get(children[0]);
			const len = child ? new THREE.Vector3().fromArray(child.origin).distanceTo(new THREE.Vector3().fromArray(bb.origin)) : 4;
			bb.length = Math.max(1, len);
		} else {
			bb.length = 4;
		}
	}

	return {armature, boneMap, namedMap, armatureSource, uniformWorldScale, worldQuaternion, worldMatrix, restLocalPosition};
}

function importSkinnedMesh(
	source: THREE.SkinnedMesh,
	armatureData: ReturnType<typeof createArmatureForSkeleton>,
	scale: number,
	textureCache: Map<string, Texture>
) {
	const {armature, boneMap, armatureSource, uniformWorldScale} = armatureData;
	const geometry = source.geometry;
	const position = geometry.attributes.position;
	if (!position) return null;

	const bbMesh = new Mesh({name: source.name || 'gltf_mesh', origin: [0, 0, 0], rotation: [0, 0, 0], vertices: {}});
	bbMesh.addTo(armature);
	bbMesh.init();
	(bbMesh as any).armature = armature.uuid;

	const worldMatrix = source.matrixWorld.clone();
	const worldPosition = new THREE.Vector3();
	const worldScale = source.getWorldScale(new THREE.Vector3());
	const transformed = new THREE.Vector3();
	const verticesByOriginalIndex: string[] = [];

	for (let i = 0; i < position.count; i++) {
		transformed.fromBufferAttribute(position, i).applyMatrix4(worldMatrix).multiplyScalar(scale);
		verticesByOriginalIndex[i] = `v${i}`;
		(bbMesh.vertices as any)[verticesByOriginalIndex[i]] = [r4(transformed.x), r4(transformed.y), r4(transformed.z)];
	}

	const index = geometry.index;
	const uvAttr = geometry.attributes.uv;
	const groups = geometry.groups || [{start: 0, count: index ? index.count : position.count, materialIndex: 0}];
	const materials = Array.isArray(source.material) ? source.material : [source.material];
	const bbTextures = materials.map((m: any) => makeBbTexture(m?.map, textureCache));
	const faces: MeshFace[] = [];

	function materialForTriangle(triStart: number) {
		const group = groups.find(g => triStart >= g.start && triStart < g.start + g.count);
		return bbTextures[(group?.materialIndex || 0)] || null;
	}

	function uvFor(indexValue: number, texture: Texture | null): ArrayVector2 {
		if (!uvAttr) return [0, 0];
		const u = uvAttr.getX(indexValue);
		const v = uvAttr.getY(indexValue);
		const width = texture?.width || 16;
		const height = texture?.height || 16;
		return [r4(u * width), r4(v * height)];
	}

	const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
	for (let t = 0; t < triangleCount; t++) {
		const base = t * 3;
		const a = index ? index.getX(base) : base;
		const b = index ? index.getX(base + 1) : base + 1;
		const c = index ? index.getX(base + 2) : base + 2;
		const texture = materialForTriangle(base);
		faces.push(new MeshFace(bbMesh, {
			vertices: [verticesByOriginalIndex[a], verticesByOriginalIndex[b], verticesByOriginalIndex[c]],
			uv: {
				[verticesByOriginalIndex[a]]: uvFor(a, texture),
				[verticesByOriginalIndex[b]]: uvFor(b, texture),
				[verticesByOriginalIndex[c]]: uvFor(c, texture),
			},
			texture,
		}));
	}
	bbMesh.addFaces(...faces);

	const joints = geometry.attributes.JOINTS_0 || geometry.attributes.joints_0;
	const weights = geometry.attributes.WEIGHTS_0 || geometry.attributes.weights_0;
	if (joints && weights) {
		for (let i = 0; i < position.count; i++) {
			const key = verticesByOriginalIndex[i];
			for (let j = 0; j < 4; j++) {
				const jointIndex = Math.round(joints.getComponent(i, j));
				const weight = Number(weights.getComponent(i, j));
				const sourceBone = source.skeleton.bones[jointIndex];
				const bbBone = sourceBone ? boneMap.get(sourceBone) : undefined;
				if (bbBone && weight > 0) bbBone.setVertexWeight(bbMesh, key, weight);
			}
		}
	}

	return {bbMesh, uniformWorldScale, worldScale};
}

function importAnimations(gltf: any, armatureData: ReturnType<typeof createArmatureForSkeleton>, scale: number) {
	if (!gltf.animations?.length) return 0;
	const {namedMap, uniformWorldScale, armatureSource} = armatureData;
	const armatureQuaternion = armatureSource.getWorldQuaternion(new THREE.Quaternion());
	let imported = 0;

	for (const clip of gltf.animations) {
		const animation = new Animation({name: clip.name || `animation_${imported}`, length: clip.duration || 0}).add();
		for (const track of clip.tracks) {
			const parsed = parseTrackName(track.name);
			if (!parsed) continue;
			const bone = namedMap.get(parsed.name);
			if (!bone) continue;
			const animator = animation.getBoneAnimator(bone);
			if (!animator) continue;
			const sourceBone = (bone.userData?.gltfBoneName && (Array.from(namedMap.entries()).find(([n]) => n === bone.userData.gltfBoneName))) ? null : null;
			const restPos = new THREE.Vector3().fromArray((bone.userData?.gltfRestLocalPosition || [0, 0, 0]) as number[]);
			const restQuat = new THREE.Quaternion().fromArray((bone.userData?.gltfRestLocalQuaternion || [0, 0, 0, 1]) as number[]);
			const isRoot = bone.parent instanceof Armature;
			const interpolation = (track as any).createInterpolant?.name === 'DiscreteInterpolant' ? 'step' : 'linear';
			for (let i = 0; i < track.times.length; i++) {
				if (parsed.property === 'position') {
					const value = new THREE.Vector3(track.values[i*3], track.values[i*3+1], track.values[i*3+2]);
					value.sub(restPos);
					if (isRoot) value.applyQuaternion(armatureQuaternion);
					value.multiplyScalar((isRoot ? scale : uniformWorldScale * scale));
					addAnimatorKeyframe(animator, track.times[i], 'position', [value.x, value.y, value.z], interpolation);
				} else if (parsed.property === 'rotation') {
					const q = new THREE.Quaternion(track.values[i*4], track.values[i*4+1], track.values[i*4+2], track.values[i*4+3]);
					const delta = restQuat.clone().invert().multiply(q).normalize();
					const e = quatToEulerArray(delta);
					addAnimatorKeyframe(animator, track.times[i], 'rotation', e, interpolation);
				} else if (parsed.property === 'scale') {
					const sx = track.values[i*3] / (restPos.x || 1);
					const sy = track.values[i*3+1] / (restPos.y || 1);
					const sz = track.values[i*3+2] / (restPos.z || 1);
					addAnimatorKeyframe(animator, track.times[i], 'scale', [isFinite(sx) ? sx : 1, isFinite(sy) ? sy : 1, isFinite(sz) ? sz : 1], interpolation);
				}
			}
		}
		if (animation.animators && Object.keys(animation.animators).length) imported++;
	}
	return imported;
}

async function importRiggedGltf(file: Filesystem.FileResult, scale: number) {
	const loader = await getLoader();
	const gltf = await new Promise<any>((resolve, reject) => loader.parse(toArrayBuffer(file.content), PathModule.dirname(file.path) + PathModule.sep, resolve, reject));
	if (!gltf.scene) throw new Error('The glTF file has no scene.');
	gltf.scene.updateMatrixWorld(true);

	const skinnedMeshes: THREE.SkinnedMesh[] = [];
	gltf.scene.traverse((node: any) => {
		if (node.isSkinnedMesh && node.skeleton) skinnedMeshes.push(node);
	});
	if (!skinnedMeshes.length) throw new Error('This GLB contains no SkinnedMesh/Skeleton.');

	Undo.initEdit({outliner: true, selection: true, textures: [], animations: Project?.animations || []});
	const skeletons = new Map<THREE.Skeleton, ReturnType<typeof createArmatureForSkeleton>>();
	const textures = new Map<string, Texture>();
	let meshCount = 0;
	let animationCount = 0;

	for (const source of skinnedMeshes) {
		let armatureData = skeletons.get(source.skeleton);
		if (!armatureData) {
			armatureData = createArmatureForSkeleton(source.skeleton, scale);
			skeletons.set(source.skeleton, armatureData);
			animationCount += importAnimations(gltf, armatureData, scale);
		}
		if (importSkinnedMesh(source, armatureData, scale, textures)) meshCount++;
	}

	Undo.finishEdit('Import Rigged glTF');
	Canvas.updateAll();
	Blockbench.showQuickMessage(`Rigged glTF v${VERSION}: ${meshCount} mesh, ${skeletons.size} armature, ${animationCount} animation sets`);
	return {meshCount, skeletonCount: skeletons.size, animationCount};
}

new Action('import_rigged_gltf', {
	name: `Import Rigged glTF v${VERSION}`,
	icon: 'icon-gltf',
	category: 'file',
	condition: () => Modes.edit && !!Format?.meshes && !!Format?.armature_rig,
	click() {
		new Dialog('import_rigged_gltf_dialog', {
			title: `Rigged glTF Importer v${VERSION}`,
			form: {
				file: {type: 'file', label: 'GLTF/GLB File', return_as: 'file', extensions: ['gltf', 'glb'], readtype: 'buffer'},
				scale: {type: 'number', label: 'Scale', value: Settings.get('model_export_scale') || 16},
				info: {type: 'info', text: 'Built into this Blockbench fork. Uses THREE.GLTFLoader + native ArmatureBone skin weights.'}
			},
			onConfirm(form) {
				if (!form.file) return false;
				importRiggedGltf(form.file, Number(form.scale) || 16).catch(error => {
					console.error('[Rigged glTF]', error);
					Blockbench.showMessageBox({title: `Rigged glTF v${VERSION}`, message: String(error?.stack || error?.message || error), icon: 'error'});
				});
			}
		}).show();
	}
});

let importMenu = MenuBar?.menus?.file?.structure?.find(x => x['id'] === 'import') as any;
if (importMenu) {
	const children = importMenu.children as any[];
	if (!children.includes('import_rigged_gltf')) children.push('import_rigged_gltf');
}

(window as any).importRiggedGltf = importRiggedGltf;
