// Rig: our own pose representation on Float32Array local transforms, own FK, and the single
// place where three.js bones are written. AnimationMixer is not used for the surfer (it only
// writes bones when values change, which breaks procedural layers).
//
// Model space = the character root (Bip01, identity) = the space the rig object is placed in.
// The lab parents the rig under the board root, so model space is the board frame B.

import * as THREE from 'three';

/** Canonical joint names → bone names in the source skeleton (Rocketbox / 3ds Max Biped). */
export const ROCKETBOX_MAP = {
  pelvis: 'Bip01_Pelvis',
  spine0: 'Bip01_Spine',
  spine1: 'Bip01_Spine1',
  spine2: 'Bip01_Spine2',
  neck: 'Bip01_Neck',
  head: 'Bip01_Head',
  thighL: 'Bip01_L_Thigh',
  calfL: 'Bip01_L_Calf',
  footL: 'Bip01_L_Foot',
  toeL: 'Bip01_L_Toe0',
  thighR: 'Bip01_R_Thigh',
  calfR: 'Bip01_R_Calf',
  footR: 'Bip01_R_Foot',
  toeR: 'Bip01_R_Toe0',
  clavL: 'Bip01_L_Clavicle',
  upperarmL: 'Bip01_L_UpperArm',
  forearmL: 'Bip01_L_Forearm',
  handL: 'Bip01_L_Hand',
  clavR: 'Bip01_R_Clavicle',
  upperarmR: 'Bip01_R_UpperArm',
  forearmR: 'Bip01_R_Forearm',
  handR: 'Bip01_R_Hand',
} as const;

export type Joint = keyof typeof ROCKETBOX_MAP;
export const JOINTS = Object.keys(ROCKETBOX_MAP) as Joint[];

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** A pose: local rotations (x,y,z,w per bone) and local positions (x,y,z per bone). */
export class Pose {
  readonly q: Float32Array;
  readonly p: Float32Array;
  constructor(n: number) {
    this.q = new Float32Array(n * 4);
    this.p = new Float32Array(n * 3);
  }
  copy(o: Pose): this {
    this.q.set(o.q);
    this.p.set(o.p);
    return this;
  }
  getQ(i: number, out: THREE.Quaternion): THREE.Quaternion {
    return out.set(this.q[4 * i], this.q[4 * i + 1], this.q[4 * i + 2], this.q[4 * i + 3]);
  }
  setQ(i: number, q: THREE.Quaternion): void {
    this.q[4 * i] = q.x;
    this.q[4 * i + 1] = q.y;
    this.q[4 * i + 2] = q.z;
    this.q[4 * i + 3] = q.w;
  }
  getP(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.p[3 * i], this.p[3 * i + 1], this.p[3 * i + 2]);
  }
  setP(i: number, v: THREE.Vector3): void {
    this.p[3 * i] = v.x;
    this.p[3 * i + 1] = v.y;
    this.p[3 * i + 2] = v.z;
  }
}

export class Rig {
  readonly root: THREE.Object3D;
  readonly mesh: THREE.SkinnedMesh;
  readonly bones: THREE.Bone[];
  readonly parent: Int16Array;
  readonly n: number;
  readonly idx: Record<Joint, number>;
  readonly rest: Pose;
  /** Model-space rest rotations/positions. */
  readonly restModelQ: Float32Array;
  readonly restModelP: Float32Array;
  /** Model-space working buffers filled by fk(). */
  readonly mq: Float32Array;
  readonly mp: Float32Array;

  constructor(gltfScene: THREE.Object3D) {
    this.root = gltfScene;
    let mesh: THREE.SkinnedMesh | null = null;
    gltfScene.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && !mesh) mesh = o as THREE.SkinnedMesh;
    });
    if (!mesh) throw new Error('no SkinnedMesh in character');
    this.mesh = mesh;
    const m = mesh as THREE.SkinnedMesh;
    m.frustumCulled = false;
    // hierarchy order: parents before children
    const set = new Set(m.skeleton.bones);
    const ordered: THREE.Bone[] = [];
    const visit = (o: THREE.Object3D) => {
      if (set.has(o as THREE.Bone)) ordered.push(o as THREE.Bone);
      for (const c of o.children) visit(c);
    };
    visit(gltfScene);
    this.bones = ordered;
    this.n = ordered.length;
    this.parent = new Int16Array(this.n);
    const index = new Map(ordered.map((b, i) => [b, i]));
    ordered.forEach((b, i) => (this.parent[i] = index.get(b.parent as THREE.Bone) ?? -1));
    this.idx = {} as Record<Joint, number>;
    for (const j of JOINTS) {
      const i = ordered.findIndex((b) => b.name === ROCKETBOX_MAP[j]);
      if (i < 0) throw new Error(`bone ${ROCKETBOX_MAP[j]} missing`);
      this.idx[j] = i;
    }
    // the character root (parent of the pelvis) must be identity relative to the gltf scene
    const top = ordered[this.idx.pelvis].parent!;
    if (!top.matrix.equals(new THREE.Matrix4())) console.warn('character root is not identity', top.name);
    this.rest = new Pose(this.n);
    ordered.forEach((b, i) => {
      this.rest.setQ(i, b.quaternion);
      this.rest.setP(i, b.position);
    });
    this.restModelQ = new Float32Array(this.n * 4);
    this.restModelP = new Float32Array(this.n * 3);
    this.mq = new Float32Array(this.n * 4);
    this.mp = new Float32Array(this.n * 3);
    this.fk(this.rest);
    this.restModelQ.set(this.mq);
    this.restModelP.set(this.mp);
  }

  /** Forward kinematics of a full pose into mq/mp (model space). */
  fk(pose: Pose, from = 0): void {
    this.fkRange(pose, from, this.n);
  }

  /** FK of one subtree root and all its descendants (bones after i that descend from i). */
  fkSubtree(pose: Pose, i: number): void {
    // bones are in DFS order, so the subtree is a contiguous range starting at i
    let end = i + 1;
    while (end < this.n && this.isDescendant(end, i)) end++;
    this.fkRange(pose, i, end);
  }

  private isDescendant(j: number, i: number): boolean {
    let p = this.parent[j];
    while (p >= 0) {
      if (p === i) return true;
      p = this.parent[p];
    }
    return false;
  }

  private fkRange(pose: Pose, a: number, b: number): void {
    const { mq, mp, parent } = this;
    for (let i = a; i < b; i++) {
      const pi = parent[i];
      const lq = _q.set(pose.q[4 * i], pose.q[4 * i + 1], pose.q[4 * i + 2], pose.q[4 * i + 3]);
      const lp = _v.set(pose.p[3 * i], pose.p[3 * i + 1], pose.p[3 * i + 2]);
      if (pi < 0) {
        mq[4 * i] = lq.x;
        mq[4 * i + 1] = lq.y;
        mq[4 * i + 2] = lq.z;
        mq[4 * i + 3] = lq.w;
        mp[3 * i] = lp.x;
        mp[3 * i + 1] = lp.y;
        mp[3 * i + 2] = lp.z;
        continue;
      }
      const pq = _q2.set(mq[4 * pi], mq[4 * pi + 1], mq[4 * pi + 2], mq[4 * pi + 3]);
      lp.applyQuaternion(pq);
      mp[3 * i] = mp[3 * pi] + lp.x;
      mp[3 * i + 1] = mp[3 * pi + 1] + lp.y;
      mp[3 * i + 2] = mp[3 * pi + 2] + lp.z;
      pq.multiply(lq);
      mq[4 * i] = pq.x;
      mq[4 * i + 1] = pq.y;
      mq[4 * i + 2] = pq.z;
      mq[4 * i + 3] = pq.w;
    }
  }

  modelQ(i: number, out: THREE.Quaternion): THREE.Quaternion {
    return out.set(this.mq[4 * i], this.mq[4 * i + 1], this.mq[4 * i + 2], this.mq[4 * i + 3]);
  }
  modelP(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.mp[3 * i], this.mp[3 * i + 1], this.mp[3 * i + 2]);
  }
  restQ(i: number, out: THREE.Quaternion): THREE.Quaternion {
    return out.set(this.restModelQ[4 * i], this.restModelQ[4 * i + 1], this.restModelQ[4 * i + 2], this.restModelQ[4 * i + 3]);
  }
  restP(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.restModelP[3 * i], this.restModelP[3 * i + 1], this.restModelP[3 * i + 2]);
  }

  /** Set bone i's MODEL rotation (parent's model rotation must be current in mq). */
  setModelQ(pose: Pose, i: number, qModel: THREE.Quaternion): void {
    const pi = this.parent[i];
    if (pi < 0) {
      pose.setQ(i, qModel);
      return;
    }
    _q2.set(this.mq[4 * pi], this.mq[4 * pi + 1], this.mq[4 * pi + 2], this.mq[4 * pi + 3]).invert();
    _q2.multiply(qModel);
    pose.setQ(i, _q2);
  }

  /** The only place three.js bones are touched. */
  write(pose: Pose): void {
    const b = this.bones;
    for (let i = 0; i < this.n; i++) {
      b[i].quaternion.set(pose.q[4 * i], pose.q[4 * i + 1], pose.q[4 * i + 2], pose.q[4 * i + 3]);
      b[i].position.set(pose.p[3 * i], pose.p[3 * i + 1], pose.p[3 * i + 2]);
    }
  }
}
