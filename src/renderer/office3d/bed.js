import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toon, canvasTexture, roundRect } from './materials.js';
import { LAYOUT } from './scene.js';

// Two ways to sleep, picked by the page each time the robot nods off
// (stateEl data-sleep-style):
//   chair  stays in the chair, wearing an eye mask
//   floor  rolls the chair aside and curls up on its side on the floor, its head on a
//          pillow and its hands tucked by its face, under a blanket
// For the floor the robot is lifted off the chair into the office for as long as it
// sleeps there, then put back. update() runs after the frame has posed the robot,
// so the floor placement wins over the chair's sitting position.

// (exported for antics that move it about in bed and put it back: the blanket burrito)
export const FLOOR = {
  hips: new THREE.Vector3(-0.18, 0.19, -0.2), // where it lies (office space): where the chair was, head to the left
  yaw: 0.3, // its body along the desk's front, its face turned a little towards the camera
  roll: Math.PI / 2, // on its side, knees forward: curled up
  chairAside: 0.6, // how far the chair rolls away to make room
};

// Where the eyes are on each head (head space) and how big a mask they need.
// Round heads get a curved mask (radius = how far the face is from the head's middle).
const MASKS = {
  robot: { y: 0.34, z: 0.285, w: 0.6, h: 0.15 },
  cat: { y: 0.31, z: 0.36, w: 0.42, h: 0.12, round: true },
  loopy: { y: 0.37, z: 0.37, w: 0.46, h: 0.13, round: true },
  nerd: { y: 0.33, z: 0.39, w: 0.44, h: 0.12, round: true },
  girl: { y: 0.33, z: 0.39, w: 0.46, h: 0.13, round: true },
};

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

function maskTexture() {
  return canvasTexture(256, 72, (ctx, w, h) => {
    ctx.fillStyle = '#7d6bd6';
    roundRect(ctx, 0, 0, w, h, 30);
    ctx.fill();
    ctx.fillStyle = '#9c8cf0';
    roundRect(ctx, 6, 6, w - 12, h - 26, 24);
    ctx.fill();
    // two closed, lashed eyes
    ctx.strokeStyle = '#fff6d8';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    for (const cx of [w * 0.3, w * 0.7]) {
      ctx.beginPath();
      ctx.arc(cx, h * 0.36, 26, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
      for (const a of [0.3, 0.5, 0.7]) {
        const ang = a * Math.PI;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * 26, h * 0.36 + Math.sin(ang) * 26);
        ctx.lineTo(cx + Math.cos(ang) * 36, h * 0.36 + Math.sin(ang) * 36);
        ctx.stroke();
      }
    }
  }).tex;
}

function buildMask(robot, body) {
  const m = MASKS[body] || (() => {
    const h = robot.headTop ?? 0.6;
    return { y: h * 0.5, z: h * 0.5, w: h * 0.7, h: h * 0.2, round: true };
  })();
  const tex = maskTexture();
  const group = new THREE.Group(); // its own group: the nightcap hides the accessories, not this
  group.name = 'sleep-mask';
  let mesh;
  if (m.round) {
    const r = m.z + 0.014;
    const arc = Math.min(Math.PI * 0.9, m.w / r);
    const mat = toon('#ffffff', { map: tex, side: THREE.DoubleSide });
    mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, m.h, 28, 1, true, -arc / 2, arc), mat);
    mesh.position.y = m.y;
  } else {
    const side = toon('#7d6bd6');
    const front = new THREE.MeshToonMaterial({ map: tex });
    mesh = new THREE.Mesh(new RoundedBoxGeometry(m.w, m.h, 0.04, 2, 0.015), [side, side, side, side, front, side]);
    mesh.position.set(0, m.y, m.z + 0.012);
  }
  group.add(mesh);
  group.visible = false;
  robot.head.add(group);
  return group;
}

function plaid() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#5aa9e6';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(i * 32 + 8, 0, 10, h);
      ctx.fillRect(0, i * 32 + 8, w, 10);
    }
    ctx.fillStyle = 'rgba(255, 211, 77, 0.55)';
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(i * 32 + 22, 0, 3, h);
      ctx.fillRect(0, i * 32 + 22, w, 3);
    }
  }).tex;
}

// A blanket draped over a curled-up body: a sheet pushed up into a soft mound.
function buildBlanket(len, wide, height) {
  const geo = new THREE.PlaneGeometry(len, wide, 24, 16);
  geo.rotateX(-Math.PI / 2); // flat on the floor, x along the body, z across it
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / (len / 2);
    const z = pos.getZ(i) / (wide / 2);
    const d = Math.min(1, Math.hypot(x * 0.92, z));
    // a rounded hump, highest over the hips, with the hem resting on the floor
    const hump = height * (1 - d * d) ** 0.6 * (1 - 0.18 * Math.max(0, -x));
    pos.setY(i, 0.012 + Math.max(0, hump) + (d > 0.9 ? 0 : 0.01 * Math.sin(x * 9 + z * 5)));
  }
  geo.computeVertexNormals();
  const tex = plaid();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1.6);
  const blanket = new THREE.Mesh(geo, toon('#ffffff', { map: tex, side: THREE.DoubleSide }));
  blanket.castShadow = true;
  blanket.receiveShadow = true;
  return blanket;
}

function buildProps() {
  const group = new THREE.Group();
  group.name = 'floor-bed';
  const pillow = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.1, 0.24, 3, 0.045), toon('#f4f6ff'));
  pillow.castShadow = pillow.receiveShadow = true;
  const blanket = buildBlanket(1.0, 0.92, 0.5);
  group.add(pillow, blanket);
  group.visible = false;
  return { group, pillow, blanket };
}

export function createBed({ emit }) {
  let onFloor = false;
  let since = 0; // when it last got into or out of bed
  let aside = 0; // how far the chair has rolled away (0..1)
  let mask = null;
  let maskOf = null;
  const U = new THREE.Vector3(); // along the body, towards the head
  const V = new THREE.Vector3(); // across it, towards the knees
  const P = new THREE.Vector3();

  function poof(set, at) {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      P.copy(at).add(new THREE.Vector3(Math.cos(a) * 0.12, 0.05 + Math.random() * 0.15, Math.sin(a) * 0.12));
      emit('steam', set.office.parent.worldToLocal(set.office.localToWorld(P.clone())), { life: 0.7, vel: new THREE.Vector3(Math.cos(a) * 0.35, 0.25, Math.sin(a) * 0.35), size: 0.16, grow: 2.2 });
    }
  }

  return {
    /** Lying on the floor right now (in bed, not just asked to be). */
    get onFloor() {
      return onFloor;
    },
    /** This desk's pillow and blanket ({ group, pillow, blanket }), or null before the first frame.
     *  update() places them afresh every frame, so an antic may move them after it (in place). */
    props(set) {
      return set.office.userData.bed || null;
    },

    /** Where its 3D speech bubble should float when it's lying down (office space), or null. */
    bubbleAt(set, out) {
      if (!onFloor) return null;
      return out.copy(FLOOR.hips).addScaledVector(U, 0.62).add(P.set(0.28, 0.55, 0));
    },

    update({ t, dt, pose, d, robot, body, set }) {
      if (robot !== maskOf) {
        maskOf = robot;
        mask = buildMask(robot, body);
        onFloor = false; // a new body sits down in the chair first
      }
      const ud = set.office.userData;
      ud.bed ||= buildProps();
      if (ud.bed.group.parent !== set.office) set.office.add(ud.bed.group);
      const bed = ud.bed;

      const asleep = pose === 'sleep';
      const style = d.sleepStyle === 'floor' ? 'floor' : 'chair';
      const wantFloor = asleep && style === 'floor';
      mask.visible = asleep && style === 'chair';

      // the body lies on its side along the desk, facing the camera a little
      const yaw = FLOOR.yaw;
      U.set(-Math.cos(yaw), 0, Math.sin(yaw)); // the head end (its local -x once rolled onto its side)
      V.set(Math.sin(yaw), 0, Math.cos(yaw)); // where it faces

      if (wantFloor !== onFloor) {
        onFloor = wantFloor;
        since = t;
        // a little cloud as it hops down (or back up)
        poof(set, onFloor ? P.copy(LAYOUT.chair).setY(0.5) : FLOOR.hips.clone());
        if (!onFloor) {
          set.swivel.add(robot.root);
          robot.root.position.x = 0;
          robot.root.rotation.set(0, 0, 0);
          robot.root.rotation.order = 'XYZ';
        }
      }

      aside += ((onFloor ? 1 : 0) - aside) * Math.min(1, dt * 3);
      const chair = set.swivel.parent;
      chair.position.x = LAYOUT.chair.x + FLOOR.chairAside * smooth(aside);

      bed.group.visible = onFloor;
      if (!onFloor) return;
      if (robot.root.parent !== set.office) set.office.add(robot.root);
      robot.root.rotation.order = 'YXZ';
      robot.root.position.copy(FLOOR.hips);
      robot.root.rotation.set(0, yaw, FLOOR.roll);
      // hands tucked up under its chin
      for (const arm of [robot.arms.armL, robot.arms.armR]) {
        arm.shoulder.rotation.set(-1.35, 0, 0.12 * arm.side);
        arm.elbow.rotation.x = -1.75;
      }

      // pillow under its head, blanket from the shoulders down (it drops in, then breathes)
      const k = smooth((t - since) / 0.45);
      bed.pillow.position.copy(FLOOR.hips).addScaledVector(U, 0.6).addScaledVector(V, 0.02).setY(0.05);
      bed.pillow.rotation.set(0, yaw, 0);
      bed.blanket.position.copy(FLOOR.hips).addScaledVector(U, -0.08).addScaledVector(V, 0.15);
      bed.blanket.position.y = 0.45 * (1 - k);
      bed.blanket.rotation.set(0, yaw, 0);
      const breathe = 1 + 0.035 * Math.sin(t * 1.6);
      bed.blanket.scale.set(1, (0.4 + 0.6 * k) * breathe, 1);
    },
  };
}
