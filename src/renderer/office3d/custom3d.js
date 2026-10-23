import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { toon, canvasTexture } from './materials.js';
import { buildAccessory } from './robot3d.js';
import { noLights, fitAccessory } from './critter.js';

// Your own character, from a .glb file (e.g. made from a picture with an
// image-to-3D tool). It gets the same parts as the robot (robot3d.js), so every
// pose and reaction drives it:
//   - with a skeleton, its bones are found by name (Mixamo, Meshy, Unreal, VRM...)
//     and posed: it sits in the chair, leans, turns its head, moves its arms;
//   - without one, it stands on the seat like a plush toy and moves as a whole.
// Faces come from the model's own blink / mouth-open / smile shapes, if it has any.

const SEAT_Y = 0.1; // where the hip joints sit (root units; the seat top is 0)
const HEAD_TOP = 1.2; // a seated character is scaled so its head tops out here, like the robot
const FLOOR = -0.67; // the floor, in root units
const PLUSH = { top: 1.2, z: 0.04 }; // a character without a skeleton stands on the seat, like a plush toy

/** Load a .glb by its stored file name (bytes come from the main process). */
export async function loadModel(file) {
  const bytes = await window.cbot.invoke('model:data', file);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', resolve, reject));
}

// ---------------------------------------------------------------- bone names

const NOISE = new Set(['mixamorig', 'mixamo', 'bip', 'def', 'org', 'mch', 'b', 'bn', 'bone', 'jnt', 'joint', 'j', 'c', 'left', 'right', 'l', 'r', 'cc', 'base', 'rig', 'armature', 'character', 'skeleton']);
const SKIP = new Set(['end', 'top', 'nub', 'tip', 'twist', 'ik', 'pole', 'target', 'roll', 'ctrl']);
const ROLES = {
  head: ['head'],
  neck: ['neck'],
  spine: ['spine', 'chest', 'upperchest', 'torso', 'abdomen', 'waist'],
  hips: ['hips', 'hip', 'pelvis'],
  upperArm: ['arm', 'upperarm', 'uparm'],
  foreArm: ['forearm', 'lowerarm', 'elbow'],
  thigh: ['upleg', 'upperleg', 'thigh'],
  shin: ['leg', 'lowerleg', 'calf', 'shin', 'knee'],
  foot: ['foot', 'ankle'],
};

// "mixamorig:LeftForeArm", "upperarm_l", "J_Bip_L_UpperLeg", "Spine1" -> a role, or null
export function roleOf(name) {
  const tokens = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.replace(/\d+$/, ''))
    .filter((t) => t && !NOISE.has(t));
  if (tokens.some((t) => SKIP.has(t))) return null;
  const key = tokens.join('');
  for (const [role, keys] of Object.entries(ROLES)) if (keys.includes(key)) return role;
  return null;
}

// ---------------------------------------------------------------- the character

// turn: quarter turns (0-3) for models that don't face front (+z)
export function buildCustom(gltf, { turn = 0 } = {}) {
  const scene = gltf.scene;
  scene.position.set(0, 0, 0);
  scene.quaternion.identity();
  scene.scale.setScalar(1);
  scene.updateMatrixWorld(true);

  // cartoon look: the model's colours and textures on the same toon shading as the rest
  scene.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    const swap = (m) =>
      toon(m.color ?? '#ffffff', {
        map: m.map ?? null,
        vertexColors: !!m.vertexColors,
        // solid, with cut-out edges: robot windows are see-through, so blended
        // (semi-transparent) surfaces would let the desktop show through the character
        transparent: false,
        alphaTest: m.transparent || m.alphaTest ? Math.max(m.alphaTest ?? 0, 0.5) : 0,
        side: m.side ?? THREE.FrontSide,
        emissive: m.emissive ?? new THREE.Color(0),
        emissiveMap: m.emissiveMap ?? null,
      });
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    o.castShadow = true;
    o.frustumCulled = false; // posed bones move skinned meshes outside their rest bounds
  });

  // find the bones we can drive
  const bones = [];
  scene.traverse((o) => o.isBone && bones.push(o));
  // VRM 0.x avatars face -z by convention: turn them round to start with
  const quarter = (turn + (gltf.parser?.json?.extensions?.VRM ? 2 : 0)) % 4;
  const F = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (quarter * Math.PI) / 2); // model -> chair
  const pos = (o) => o.getWorldPosition(new THREE.Vector3());
  const pick = (role) => bones.filter((b) => roleOf(b.name) === role);
  // left and right as seen in the chair: by x once turned
  const sideX = (b) => pos(b).applyQuaternion(F).x;
  const bySide = (list) => ({ neg: list.find((b) => sideX(b) < 0), pos: list.find((b) => sideX(b) > 0) });
  const rig = {
    head: pick('head')[0],
    spine: pick('spine')[0] || pick('hips')[0],
    hips: pick('hips')[0],
    arm: bySide(pick('upperArm')),
    fore: bySide(pick('foreArm')),
    thigh: bySide(pick('thigh')),
    shin: bySide(pick('shin')),
    foot: bySide(pick('foot')),
  };
  const rigged = !!(rig.head && rig.spine && rig.arm.neg && rig.arm.pos && rig.fore.neg && rig.fore.pos);
  const legs = !!(rig.thigh.neg && rig.thigh.pos);
  // leg stand-ins, like the robot's hip groups (walker3d.js stands it up and walks it):
  // hip.rotation.x PI/2 swings the thigh down, knee.rotation.x `straight` puts the shin in
  // line with it. Left alone (identity) it sits, as before.
  const legStand = rigged && legs && rig.shin.neg && rig.shin.pos
    ? ['neg', 'pos'].map((k) => ({ k, side: k === 'neg' ? -1 : 1, hip: new THREE.Group(), knee: new THREE.Group(), straight: -Math.PI / 2 }))
    : null;

  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());

  // ---- fit it into the chair: scale and place the model (model space -> root space)
  let s;
  let anchor; // a model-space point, and where it goes in root space
  let target;
  if (rigged) {
    const hipPoint = legs ? pos(rig.thigh.neg).add(pos(rig.thigh.pos)).multiplyScalar(0.5) : pos(rig.hips || rig.spine);
    s = (HEAD_TOP - SEAT_Y) / Math.max(0.01, box.max.y - hipPoint.y);
    anchor = hipPoint;
    target = new THREE.Vector3(0, SEAT_Y, 0.02);
  } else {
    s = PLUSH.top / Math.max(0.01, size.y);
    anchor = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
    target = new THREE.Vector3(0, 0, PLUSH.z);
  }
  const toRoot = (p) => p.clone().multiplyScalar(s).applyQuaternion(F).add(offset);
  const offset = target.clone().sub(anchor.clone().multiplyScalar(s).applyQuaternion(F));
  // where its soles are with the legs straight down (root space): the hips less the legs' length
  let standSole = 0;
  if (legStand) {
    standSole = Math.min(...legStand.map(({ k }) => {
      const thigh = pos(rig.thigh[k]).distanceTo(pos(rig.shin[k]));
      const foot = rig.foot[k];
      const lower = foot ? pos(foot).distanceTo(pos(rig.shin[k])) + pos(foot).y - box.min.y : thigh * 1.1;
      return toRoot(pos(rig.thigh[k])).y - (thigh + lower) * s;
    }));
  }

  const root = new THREE.Group(); // origin: centre of the seat top
  const container = new THREE.Group();
  container.position.copy(offset);
  container.quaternion.copy(F);
  container.scale.setScalar(s);

  // ---- the robot's parts, as stand-ins the poses move
  const torso = new THREE.Group();
  const head = new THREE.Group();
  const antenna = new THREE.Group();
  const accessory = new THREE.Group();
  const headband = new THREE.Group();
  const arms = {};
  let headBox;
  if (rigged) {
    const spineAt = toRoot(pos(rig.spine));
    const headAt = toRoot(pos(rig.head));
    torso.position.copy(spineAt);
    head.position.copy(headAt).sub(spineAt);
    for (const [key, side, b] of [['armL', -1, 'neg'], ['armR', 1, 'pos']]) {
      const shoulder = new THREE.Group();
      shoulder.position.copy(toRoot(pos(rig.arm[b]))).sub(spineAt);
      const elbow = new THREE.Group();
      elbow.position.y = -pos(rig.fore[b]).distanceTo(pos(rig.arm[b])) * s;
      shoulder.add(elbow);
      torso.add(shoulder);
      arms[key] = { shoulder, elbow, side, bone: rig.arm[b], foreBone: rig.fore[b] };
    }
    headBox = boxOfBone(scene, rig.head, toRoot) || new THREE.Box3(headAt.clone().add(new THREE.Vector3(-0.3, 0, -0.3)), headAt.clone().add(new THREE.Vector3(0.3, 0.6, 0.3)));
  } else {
    // no skeleton: everything pivots on the seat, and "the head" is the top of it
    torso.position.copy(target);
    head.position.set(0, PLUSH.top - 0.55, 0);
    for (const [key, side] of [['armL', -1], ['armR', 1]]) {
      const shoulder = new THREE.Group();
      const elbow = new THREE.Group();
      shoulder.add(elbow);
      torso.add(shoulder);
      arms[key] = { shoulder, elbow, side };
    }
    const half = Math.min(size.x, size.z) * s * 0.4;
    headBox = new THREE.Box3(new THREE.Vector3(-half, PLUSH.top - 0.6, PLUSH.z - half), new THREE.Vector3(half, PLUSH.top, PLUSH.z + half));
  }
  root.add(container, torso);
  torso.add(head);
  head.add(antenna, accessory, headband);

  // ---- hats and the effort headband, sized to the head
  root.updateMatrixWorld(true);
  const headAtRoot = head.getWorldPosition(new THREE.Vector3()); // root has no parent yet: this is root space
  const hb = headBox.clone().translate(headAtRoot.clone().negate()); // the head's box around the head origin
  const hw = Math.max(0.2, hb.max.x - hb.min.x);
  const hd = Math.max(0.2, hb.max.z - hb.min.z);
  const hh = Math.max(0.2, hb.max.y - hb.min.y);
  const widen = hw / 0.74;
  const top = hb.max.y;
  const mid = (hb.min.y + hb.max.y) / 2;
  const hat = [top - 0.59, 0, widen];
  const FIT = {
    hardhat: hat, tophat: hat, crown: hat, pirate: hat, flower: hat,
    headphones: [mid - 0.3, 0, widen],
    glasses: [mid + hh * 0.08 - 0.32, hb.max.z - 0.29 * widen, widen],
    bowtie: [hb.min.y + 0.02, hb.max.z * 0.8 - 0.21, 1],
  };
  const band = new THREE.Mesh(new THREE.TorusGeometry(hw / 2 + 0.02, 0.035, 8, 36), toon('#e5484d'));
  band.position.y = top - hh * 0.22;
  band.rotation.x = Math.PI / 2;
  band.scale.set(1, hd / hw, 1);
  headband.add(band);
  headband.visible = false;

  // ---- faces: the model's own blink / mouth / smile shapes
  const shapes = { blink: [], mouth: [], smile: [] };
  scene.traverse((o) => {
    if (!o.morphTargetDictionary) return;
    for (const [name, i] of Object.entries(o.morphTargetDictionary)) {
      const n = name.toLowerCase();
      if (/blink|eyeclose|eyesclose|eye_close|eyes_close/.test(n)) shapes.blink.push([o, i]);
      else if (/jawopen|mouthopen|mouth_open|viseme_?aa|v_aa$|phoneme_a$|mth_a$|^aa$|^a$|^open/.test(n)) shapes.mouth.push([o, i]);
      else if (/smile|happy|joy|^fun/.test(n)) shapes.smile.push([o, i]);
    }
  });
  const setShape = (list, v) => list.forEach(([o, i]) => (o.morphTargetInfluences[i] = v));
  function drawFace(_ctx, f) {
    const shut = f.eyes === 'closed' || f.eyes === 'happy' ? 1 : f.blink;
    setShape(shapes.blink, shut);
    const open = { talk: Math.abs(Math.sin(f.t * 18)) * 0.8, wide: 0.9, o: 0.45, chomp: Math.abs(Math.sin(f.t * 14)) }[f.mouth] || 0;
    setShape(shapes.mouth, open);
    setShape(shapes.smile, f.eyes === 'happy' || f.mouth === 'smile' ? 0.6 : 0);
  }

  // ---- every frame: turn the stand-ins' poses into bone rotations; a model
  // without a skeleton tips and squashes about its feet instead
  let sync;
  if (rigged) {
    sync = retarget({ bones, rig, arms, torso, head, legs, legStand, F, kneeRoom: (knee) => knee.y * s + offset.y - FLOOR, s, floorToAnkle: (k) => (rig.foot[k] ? pos(rig.foot[k]).y - box.min.y : 0) * s });
  } else {
    const pivot = new THREE.Group();
    pivot.position.copy(target);
    container.position.copy(offset).sub(target);
    pivot.add(container);
    root.add(pivot);
    sync = () => {
      pivot.rotation.set(head.rotation.x * 0.5 + torso.rotation.x * 0.3, head.rotation.y * 0.6, head.rotation.z * 0.5);
      pivot.scale.copy(head.scale);
    };
  }
  container.add(scene); // only now: everything above measures the model in its own space

  return {
    root, torso, head, antenna, arms, accessory, headband,
    ...noLights(),
    legs: legStand, // (null: no legs to stand on, so it hops about like a plush)
    standSole,
    headTop: top, // where the hammer lands
    face: { ...canvasTexture(4, 4), material: null },
    drawFace,
    sync,
    status: {
      rigged,
      legs,
      face: Object.entries(shapes).filter(([, l]) => l.length).map(([k]) => k),
      bones: bones.length,
    },
    setColor() {}, // a model keeps its own colours
    setAccessory(name) {
      fitAccessory(accessory, name, FIT, buildAccessory);
    },
  };
}

// The box (in root space) around the vertices skinned mostly to the head bone or
// its children, i.e. the head itself.
function boxOfBone(scene, headBone, toRoot) {
  const inHead = new Set();
  headBone.traverse((o) => o.isBone && inHead.add(o));
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let n = 0;
  scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const idx = o.geometry.attributes.skinIndex;
    const wt = o.geometry.attributes.skinWeight;
    const heads = o.skeleton.bones.map((b) => inHead.has(b));
    const count = o.geometry.attributes.position.count;
    const step = Math.max(1, Math.floor(count / 20000));
    for (let i = 0; i < count; i += step) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (heads[idx.getComponent(i, k)]) w += wt.getComponent(i, k);
      if (w < 0.5) continue;
      o.getVertexPosition(i, v);
      v.applyMatrix4(o.matrixWorld);
      box.expandByPoint(toRoot(v));
      n++;
    }
  });
  return n > 30 ? box : null;
}

// Pose the skeleton from the stand-ins. Each driven bone gets the rotation its
// stand-in has (relative to the model's root), applied on top of a "virtual rest":
// the model's own rest pose with the arms hanging down and the thighs forward
// (sitting), which is how the robot's rest pose looks. Other bones keep their rest.
function retarget({ bones, rig, arms, torso, head, legs, legStand, F, kneeRoom, s, floorToAnkle }) {
  const restLocal = new Map(bones.map((b) => [b, b.quaternion.clone()]));
  const restWorld = new Map();
  const parentRest = new Map();
  for (const b of bones) {
    restWorld.set(b, b.getWorldQuaternion(new THREE.Quaternion()));
    parentRest.set(b, b.parent ? b.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion());
  }
  const pos = (o) => o.getWorldPosition(new THREE.Vector3());
  const turn = (from, to) => new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
  const DOWN = new THREE.Vector3(0, -1, 0);

  // virtual rest orientation (model space) and which stand-in drives each bone
  const drive = new Map(); // bone -> { rest, motion: () => quaternion in root space }
  const q = new THREE.Quaternion();
  drive.set(rig.spine, { rest: restWorld.get(rig.spine), motion: () => torso.quaternion });
  drive.set(rig.head, { rest: restWorld.get(rig.head), motion: () => q.multiplyQuaternions(torso.quaternion, head.quaternion) });
  for (const arm of Object.values(arms)) {
    const hang = turn(pos(arm.foreBone).sub(pos(arm.bone)), DOWN);
    const shoulderMotion = new THREE.Quaternion();
    drive.set(arm.bone, { rest: hang.clone().multiply(restWorld.get(arm.bone)), motion: () => shoulderMotion.multiplyQuaternions(torso.quaternion, arm.shoulder.quaternion) });
    const elbowMotion = new THREE.Quaternion();
    drive.set(arm.foreBone, { rest: hang.clone().multiply(restWorld.get(arm.foreBone)), motion: () => elbowMotion.multiplyQuaternions(torso.quaternion, arm.shoulder.quaternion).multiply(arm.elbow.quaternion) });
  }
  const Finv = F.clone().invert();
  if (legs) {
    const forward = new THREE.Vector3(0, -0.12, 1).applyQuaternion(Finv); // the chair's forward, in model space
    for (const k of ['neg', 'pos']) {
      const thigh = rig.thigh[k];
      const shin = rig.shin[k];
      const stand = legStand?.find((l) => l.k === k);
      const knee = shin ? pos(shin) : pos(thigh).add(DOWN);
      const sit = turn(knee.sub(pos(thigh)), forward);
      drive.set(thigh, { rest: sit.clone().multiply(restWorld.get(thigh)), motion: stand ? () => stand.hip.quaternion : () => IDENTITY });
      if (!shin) continue;
      // shins hang down from the knee; long legs swing their feet forward so they
      // rest on the floor instead of going through it
      const foot = rig.foot[k];
      const hipAt = pos(thigh);
      const kneeAt = pos(shin).sub(hipAt).applyQuaternion(sit).add(hipAt);
      const shinDir = foot ? pos(foot).sub(pos(shin)) : DOWN.clone();
      const len = foot ? shinDir.length() * s : 0;
      const room = kneeRoom(kneeAt) - floorToAnkle(k);
      const swing = len > room && room > 0 ? Math.acos(room / len) : len > 0 && room <= 0 ? Math.PI / 2 : 0;
      const hang = new THREE.Vector3(0, -Math.cos(swing), Math.sin(swing)).applyQuaternion(Finv);
      const shinTurn = turn(shinDir, hang);
      const shinMotion = new THREE.Quaternion();
      if (stand) stand.straight = -Math.PI / 2 + swing; // (its shin already hangs swung forward by `swing`)
      drive.set(shin, { rest: shinTurn.multiply(restWorld.get(shin)), motion: stand ? () => shinMotion.multiplyQuaternions(stand.hip.quaternion, stand.knee.quaternion) : () => IDENTITY });
      if (foot) drive.set(foot, { rest: restWorld.get(foot), motion: () => IDENTITY }); // feet stay flat
    }
  }

  const world = new Map();
  const m = new THREE.Quaternion();
  const t = new THREE.Quaternion();
  return function sync() {
    for (const b of bones) {
      const parentWorld = world.get(b.parent) || parentRest.get(b);
      const d = drive.get(b);
      if (d) {
        // target world (model space) = (F⁻¹ · motion · F) · virtual rest
        m.copy(Finv).multiply(d.motion()).multiply(F);
        t.multiplyQuaternions(m, d.rest);
        b.quaternion.copy(parentWorld).invert().multiply(t);
      } else {
        b.quaternion.copy(restLocal.get(b));
      }
      world.set(b, (world.get(b) || new THREE.Quaternion()).multiplyQuaternions(parentWorld, b.quaternion));
    }
    rig.head.scale.copy(head.scale); // squash and stretch
  };
}

const IDENTITY = new THREE.Quaternion();
