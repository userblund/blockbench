import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';

const VERSION = '0.2.1';
const r4 = (n: number) => Math.round(n * 10000) / 10000;
let loader_promise: Promise<GLTFLoader> | null = null;
const attr4 = (a:any, i:number, c:number) => c===0?a.getX(i):c===1?a.getY(i):c===2?a.getZ(i):a.getW(i);
const animatorCount = (a:any) => a?.animators instanceof Map ? a.animators.size : Object.keys(a?.animators || {}).length;

function getLoader(): Promise<GLTFLoader> { if (!loader_promise) loader_promise = Promise.resolve(new GLTFLoader()); return loader_promise; }
function toArrayBuffer(data:any):ArrayBuffer { if(data instanceof ArrayBuffer)return data; if(ArrayBuffer.isView(data))return data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength) as ArrayBuffer; throw new Error('GLB binary data is unavailable.'); }
function quatToEulerArray(q:THREE.Quaternion):ArrayVector3 { const e=new THREE.Euler().setFromQuaternion(q,(Format?.euler_order||'ZYX') as any),d=180/Math.PI; return [r4(e.x*d),r4(e.y*d),r4(e.z*d)]; }
function makeBbTexture(t:THREE.Texture,cache:Map<string,Texture>):Texture|null { if(cache.has(t.uuid))return cache.get(t.uuid)!; const image:any=t.image;if(!image)return null;try{const canvas=document.createElement('canvas');canvas.width=image.width||1;canvas.height=image.height||1;const ctx=canvas.getContext('2d');if(!ctx)return null;ctx.drawImage(image,0,0,canvas.width,canvas.height);const bb=new Texture().fromDataURL(canvas.toDataURL('image/png'));bb.name=t.name||'gltf_texture';bb.add(false);cache.set(t.uuid,bb);return bb;}catch(e){console.error('[Rigged glTF] texture conversion failed',e);return null;} }
function parseTrackName(name:string):{name:string,property:string}|null { const m=name.match(/^(?:.*\.)?([^./]+)\.(position|quaternion|scale)$/);return m?{name:m[1],property:m[2]==='quaternion'?'rotation':m[2]}:null; }
function addKey(animator:any,time:number,channel:string,v:ArrayVector3,interpolation='linear'){if(!animator?.addKeyframe)return;animator.addKeyframe({channel,time,interpolation,data_points:[{x:String(r4(v[0])),y:String(r4(v[1])),z:String(r4(v[2]))}]});}
function nearestArmatureNode(root:THREE.Bone):THREE.Object3D{let p=root.parent;while(p&&p.type==='Bone')p=p.parent;return p||root;}

function createArmatureForSkeleton(skeleton:THREE.Skeleton,scale:number){
	const bones=skeleton.bones,root=bones.find(b=>!bones.includes(b.parent as any))||bones[0],sourceArmature=nearestArmatureNode(root),armatureInverse=sourceArmature.matrixWorld.clone().invert();
	const armature=new Armature({name:'gltf_armature'});armature.addTo('root');armature.isOpen=true;armature.createUniqueName();armature.init();
	const boneMap=new Map<THREE.Bone,ArmatureBone>(),namedMap=new Map<string,ArmatureBone>();
	function addBone(source:THREE.Bone,parent:Armature|ArmatureBone){
		const localPos=source.position.clone(),localQuat=source.quaternion.clone(),isRoot=source.parent?.type!=='Bone';let pos:THREE.Vector3,rot:THREE.Quaternion;
		if(isRoot){pos=new THREE.Vector3().setFromMatrixPosition(source.matrixWorld).applyMatrix4(armatureInverse).multiplyScalar(scale);rot=source.getWorldQuaternion(new THREE.Quaternion()).premultiply(sourceArmature.getWorldQuaternion(new THREE.Quaternion()).invert());}
		else{pos=localPos.clone().multiplyScalar(scale);rot=localQuat.clone();}
		const bb=new ArmatureBone({name:source.name||`bone_${boneMap.size}`,origin:[r4(pos.x),r4(pos.y),r4(pos.z)],rotation:quatToEulerArray(rot),length:4,width:2,connected:false});
		bb.addTo(parent).init();bb.userData=bb.userData||{};bb.userData.gltfBoneName=source.name;bb.userData.gltfRestLocalPosition=[localPos.x,localPos.y,localPos.z];bb.userData.gltfRestLocalQuaternion=[localQuat.x,localQuat.y,localQuat.z,localQuat.w];bb.userData.gltfRestLocalScale=[source.scale.x,source.scale.y,source.scale.z];
		boneMap.set(source,bb);if(source.name)namedMap.set(source.name,bb);namedMap.set(source.uuid,bb);
		for(const child of source.children)if(child.type==='Bone'&&bones.includes(child as THREE.Bone))addBone(child as THREE.Bone,bb);
	}
	addBone(root,armature);
	for(const source of bones){const bb=boneMap.get(source);if(!bb)continue;const child=source.children.find(c=>c.type==='Bone'&&bones.includes(c as THREE.Bone)) as THREE.Bone|undefined;if(child){const cb=boneMap.get(child);if(cb)bb.length=Math.max(1,new THREE.Vector3().fromArray(cb.origin).distanceTo(new THREE.Vector3().fromArray(bb.origin)));}}
	return {armature,boneMap,namedMap,sourceArmature,armatureInverse};
}

function importSkinnedMesh(source:THREE.SkinnedMesh,data:ReturnType<typeof createArmatureForSkeleton>,scale:number,textureCache:Map<string,Texture>){
	const {armature,boneMap,armatureInverse}=data,geometry=source.geometry,posAttr=geometry.attributes.position;if(!posAttr)return null;
	const bbMesh=new Mesh({name:source.name||'gltf_mesh',origin:[0,0,0],rotation:[0,0,0],vertices:{}});bbMesh.addTo(armature);bbMesh.init();
	const localToArmature=armatureInverse.clone().multiply(source.matrixWorld),transformed=new THREE.Vector3(),keys:string[]=[];
	for(let i=0;i<posAttr.count;i++){transformed.fromBufferAttribute(posAttr,i).applyMatrix4(localToArmature).multiplyScalar(scale);keys[i]=`v${i}`;(bbMesh.vertices as any)[keys[i]]=[r4(transformed.x),r4(transformed.y),r4(transformed.z)];}
	const index=geometry.index,uvAttr=geometry.attributes.uv,groups=geometry.groups.length?geometry.groups:[{start:0,count:index?index.count:posAttr.count,materialIndex:0}],materials=Array.isArray(source.material)?source.material:[source.material],textures=materials.map((m:any)=>m?.map?makeBbTexture(m.map,textureCache):null);
	const textureFor=(offset:number)=>{const g=groups.find(x=>offset>=x.start&&offset<x.start+x.count);return textures[g?.materialIndex||0]||null;};
	const uvFor=(i:number,t:Texture|null):ArrayVector2=>uvAttr?[r4(uvAttr.getX(i)*(t?.width||16)),r4(uvAttr.getY(i)*(t?.height||16))]:[0,0];
	const faces:MeshFace[]=[];const triangles=index?Math.floor(index.count/3):Math.floor(posAttr.count/3);
	for(let t=0;t<triangles;t++){const o=t*3,a=index?index.getX(o):o,b=index?index.getX(o+1):o+1,c=index?index.getX(o+2):o+2,tex=textureFor(o);faces.push(new MeshFace(bbMesh,{vertices:[keys[a],keys[b],keys[c]],uv:{[keys[a]]:uvFor(a,tex),[keys[b]]:uvFor(b,tex),[keys[c]]:uvFor(c,tex)},texture:tex}));}
	bbMesh.addFaces(...faces);
	const joints:any=geometry.attributes.JOINTS_0||geometry.attributes.joints_0,weights:any=geometry.attributes.WEIGHTS_0||geometry.attributes.weights_0;
	if(joints&&weights)for(let i=0;i<posAttr.count;i++)for(let j=0;j<4;j++){const ji=Math.round(attr4(joints,i,j)),w=Number(attr4(weights,i,j)),sourceBone=source.skeleton.bones[ji],bbBone=sourceBone?boneMap.get(sourceBone):undefined;if(bbBone&&w>0)bbBone.setVertexWeight(bbMesh,keys[i],w);}
	return bbMesh;
}

function importAnimations(gltf:any,data:ReturnType<typeof createArmatureForSkeleton>,scale:number){let count=0;for(const clip of gltf.animations||[]){const animation=new Animation({name:clip.name||`animation_${count}`,length:clip.duration||0}).add();for(const track of clip.tracks){const parsed=parseTrackName(track.name);if(!parsed)continue;const bone=data.namedMap.get(parsed.name);if(!bone)continue;const animator=animation.getBoneAnimator(bone);if(!animator)continue;const restPos=new THREE.Vector3().fromArray(bone.userData?.gltfRestLocalPosition||[0,0,0]),restQuat=new THREE.Quaternion().fromArray(bone.userData?.gltfRestLocalQuaternion||[0,0,0,1]),restScale=new THREE.Vector3().fromArray(bone.userData?.gltfRestLocalScale||[1,1,1]),interpolation=(track as any).createInterpolant?.name==='DiscreteInterpolant'?'step':'linear';for(let i=0;i<track.times.length;i++){if(parsed.property==='position'){const v=new THREE.Vector3(track.values[i*3],track.values[i*3+1],track.values[i*3+2]).sub(restPos).multiplyScalar(scale);addKey(animator,track.times[i],'position',[v.x,v.y,v.z],interpolation);}else if(parsed.property==='rotation'){const q=new THREE.Quaternion(track.values[i*4],track.values[i*4+1],track.values[i*4+2],track.values[i*4+3]),d=restQuat.clone().invert().multiply(q).normalize();addKey(animator,track.times[i],'rotation',quatToEulerArray(d),interpolation);}else if(parsed.property==='scale'){const v=[track.values[i*3]/(restScale.x||1),track.values[i*3+1]/(restScale.y||1),track.values[i*3+2]/(restScale.z||1)];addKey(animator,track.times[i],'scale',[isFinite(v[0])?v[0]:1,isFinite(v[1])?v[1]:1,isFinite(v[2])?v[2]:1],interpolation);}}}if(animatorCount(animation))count++;else animation.remove();}return count;}

async function importRiggedGltf(file:Filesystem.FileResult,scale:number){const loader=await getLoader(),gltf=await new Promise<any>((resolve,reject)=>loader.parse(toArrayBuffer(file.content),PathModule.dirname(file.path)+PathModule.sep,resolve,reject));if(!gltf.scene)throw new Error('The glTF file has no scene.');gltf.scene.updateMatrixWorld(true);const meshes:THREE.SkinnedMesh[]=[];gltf.scene.traverse((n:any)=>{if(n.isSkinnedMesh&&n.skeleton)meshes.push(n);});if(!meshes.length)throw new Error('No SkinnedMesh/Skeleton found.');Undo.initEdit({outliner:true,selection:true,textures:[],animations:Project?.animations||[]});const skeletons=new Map<THREE.Skeleton,ReturnType<typeof createArmatureForSkeleton>>(),textureCache=new Map<string,Texture>();let meshCount=0,animationCount=0;for(const source of meshes){let data=skeletons.get(source.skeleton);if(!data){data=createArmatureForSkeleton(source.skeleton,scale);skeletons.set(source.skeleton,data);animationCount+=importAnimations(gltf,data,scale);}if(importSkinnedMesh(source,data,scale,textureCache))meshCount++;}Undo.finishEdit('Import Rigged glTF');Canvas.updateAll();Blockbench.showQuickMessage(`Rigged glTF v${VERSION}: ${meshCount} mesh, ${skeletons.size} armature, ${animationCount} animations`);return{meshCount,skeletonCount:skeletons.size,animationCount};}

new Action('import_rigged_gltf',{name:`Import Rigged glTF v${VERSION}`,icon:'icon-gltf',category:'file',condition:()=>Modes.edit&&!!Format?.meshes&&!!Format?.armature_rig,click(){new Dialog('import_rigged_gltf_dialog',{title:`Rigged glTF Importer v${VERSION}`,form:{file:{type:'file',label:'GLTF/GLB File',return_as:'file',extensions:['gltf','glb'],readtype:'buffer'},scale:{type:'number',label:'Scale',value:Settings.get('model_export_scale')||16},info:{type:'info',text:'Native rigged glTF importer: skeleton, skin weights, textures and animations.'}},onConfirm(form){if(!form.file)return false;importRiggedGltf(form.file,Number(form.scale)||16).catch(error=>{console.error('[Rigged glTF]',error);Blockbench.showMessageBox({title:`Rigged glTF v${VERSION}`,message:String(error?.stack||error?.message||error),icon:'error'});});}}).show();}});
const importMenu=MenuBar?.menus?.file?.structure?.find(x=>x['id']==='import') as any;if(importMenu&&!importMenu.children.includes('import_rigged_gltf'))(importMenu.children as any[]).push('import_rigged_gltf');
(window as any).importRiggedGltf=importRiggedGltf;
