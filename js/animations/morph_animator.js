import { GeneralAnimator } from "./timeline_animators";

export class MorphAnimator extends GeneralAnimator {
	constructor(uuid, animation, name) {
		super(uuid, animation);
		this.uuid = uuid;
		this._name = name;
		this.channels = {};
		this.muted = {};
	}
	get name() {
		let element = this.getElement();
		return element?.name || this._name || 'Morphs';
	}
	set name(name) {
		this._name = name;
	}
	getElement() {
		this.element = OutlinerNode.uuids[this.uuid];
		return this.element;
	}
	ensureChannel(index) {
		index = Math.max(0, Math.floor(Number(index) || 0));
		const channel = 'morph_' + index;
		if (!this.channels[channel]) {
			this.channels[channel] = {
				name: 'Morph ' + index,
				condition: () => true,
				transform: false,
				mutable: true,
				max_data_points: 1,
			};
			this[channel] = [];
			this.muted[channel] = false;
		}
		return channel;
	}
	addKeyframe(data, uuid) {
		if (data?.channel && typeof data.channel === 'string' && data.channel.startsWith('morph_')) {
			this.ensureChannel(parseInt(data.channel.slice(6), 10));
		}
		return super.addKeyframe(data, uuid);
	}
	createKeyframe(value, time, channel, undo, select) {
		if (typeof channel === 'string' && channel.startsWith('morph_')) {
			this.ensureChannel(parseInt(channel.slice(6), 10));
			if (typeof value === 'number') {
				value = {data_points: [{x: value, y: 0, z: 0}]};
			}
		}
		return super.createKeyframe(value, time, channel, undo, select);
	}
	getScalarValue(keyframe) {
		const point = keyframe?.data_points?.[0];
		const value = point?.x;
		const numeric = Number(value);
		return Number.isFinite(numeric) ? numeric : 0;
	}
	interpolate(channel) {
		const frames = this[channel];
		if (!frames || !frames.length) return 0;
		const time = this.animation?.time ?? Timeline.time;
		if (frames.length === 1) return this.getScalarValue(frames[0]);
		if (time <= frames[0].time) return this.getScalarValue(frames[0]);
		const last = frames[frames.length - 1];
		if (time >= last.time) return this.getScalarValue(last);
		let before = frames[0];
		let after = last;
		for (let i = 1; i < frames.length; i++) {
			if (frames[i].time >= time) {
				after = frames[i];
				before = frames[i - 1];
				break;
			}
		}
		if (after.time === before.time) return this.getScalarValue(after);
		if (after.interpolation === 'step') return this.getScalarValue(before);
		const amount = Math.clamp((time - before.time) / (after.time - before.time), 0, 1);
		const a = this.getScalarValue(before);
		const b = this.getScalarValue(after);
		return a + (b - a) * amount;
	}
	displayFrame(multiplier = 1) {
		const element = this.getElement();
		if (!element) return;
		const mesh = element.mesh;
		if (!mesh) return;
		if (element._gltf_morph_geometry && mesh.geometry !== element._gltf_morph_geometry) {
			mesh.geometry = element._gltf_morph_geometry;
			if (element._gltf_morph_material) mesh.material = element._gltf_morph_material;
		}
		if (!mesh.morphTargetInfluences) return;
		for (let i = 0; i < mesh.morphTargetInfluences.length; i++) {
			mesh.morphTargetInfluences[i] = 0;
		}
		for (let channel in this.channels) {
			if (!channel.startsWith('morph_')) continue;
			const index = parseInt(channel.slice(6), 10);
			if (!Number.isInteger(index) || index < 0 || index >= mesh.morphTargetInfluences.length) continue;
			if (this.muted[channel]) continue;
			mesh.morphTargetInfluences[index] = this.interpolate(channel) * multiplier;
		}
		mesh.geometry.computeBoundingSphere?.();
	}
}
MorphAnimator.prototype.type = 'morph';
