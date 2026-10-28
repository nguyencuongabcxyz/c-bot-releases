// The bonk: a squeaky toy hammer swings in from the side and bonks the robot on the head (stars,
// a squeak), and the head squashes and wobbles back.
import * as THREE from 'three';
import type { Emit } from './antics/types';
import { HAMMER, type buildHammer } from './hammer';
import type { Rig } from './types';

// the squeaky-hammer bonk, in seconds: pops in, winds up, strikes, rebounds, shrinks away
// (the hit time is mirrored by BONK_HIT_MS in robot.js, which lands the sound and reaction)
const BONK = { appear: 0.18, windup: 0.34, hit: 0.42, leave: 0.72, end: 1.02, scale: 0.8 };
const easeOutBack = (p: number) => 1 + 2.4 * (p - 1) ** 3 + 1.4 * (p - 1) ** 2;

/** What it uses of the office. */
export type BonkParts = {
  toy: ReturnType<typeof buildHammer> & { hitFor?: number }; // (hitFor: the bonk it last landed)
  camera: THREE.Camera;
  emit: Emit;
  worldPoint: (obj: THREE.Object3D, x: number, y: number, z: number) => THREE.Vector3;
  /** reaction name -> when it started */
  react: Partial<Record<string, number>>;
};

/** The hammer, sBonk seconds into a bonk; how far the head is squashed (0: not at all). */
export function bonkFrame({ toy, camera, emit, worldPoint, react }: BonkParts, robot: Rig, sBonk: number) {
  let squash = 0;
  if (sBonk < BONK.end) {
    const top = worldPoint(robot.head, 0, robot.headTop, 0);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    right.y = 0;
    right.normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const out = new THREE.Vector3().crossVectors(right, up);
    // held off to the robot's side, so that at angle 0 the bottom face lands on its head
    toy.hammer.visible = true;
    toy.hammer.position
      .copy(top)
      .addScaledVector(right, HAMMER.reach * BONK.scale)
      .addScaledVector(up, HAMMER.faceDrop * BONK.scale);
    let angle: number;
    let grow = 1;
    // angles stay low and to the side: there's little room above the robot's head
    if (sBonk < BONK.appear) {
      angle = -0.55;
      grow = easeOutBack(sBonk / BONK.appear);
    } else if (sBonk < BONK.windup) {
      const p = (sBonk - BONK.appear) / (BONK.windup - BONK.appear);
      angle = -0.55 - 0.25 * p * p * (3 - 2 * p);
    } else if (sBonk < BONK.hit) {
      const p = (sBonk - BONK.windup) / (BONK.hit - BONK.windup);
      angle = -0.8 * (1 - p * p); // accelerates into the strike
    } else if (sBonk < BONK.leave) {
      const p = (sBonk - BONK.hit) / (BONK.leave - BONK.hit);
      angle = -0.6 * Math.sin(p * Math.PI * 0.5); // boing! straight back up
    } else {
      const p = (sBonk - BONK.leave) / (BONK.end - BONK.leave);
      angle = -0.6 - p * 0.5; // and off it goes, shrinking
      grow = 1 - p * p;
      toy.hammer.position.addScaledVector(right, p * 0.35);
    }
    toy.hammer.quaternion
      .setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, out))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle));
    toy.hammer.scale.setScalar(BONK.scale * Math.max(0.001, grow));
    // the pink head squishes on impact; the robot's head squashes and wobbles back
    const since_hit = sBonk - BONK.hit;
    const squish = since_hit > 0 && since_hit < 0.3 ? Math.sin((since_hit / 0.3) * Math.PI) * 0.3 : 0;
    toy.head.scale.set(1 + squish * 0.4, 1 - squish, 1 + squish * 0.4);
    squash = since_hit > 0 && since_hit < 0.8 ? Math.exp(-since_hit * 5) * Math.cos(since_hit * 22) * 0.32 : 0;
    if (since_hit >= 0 && toy.hitFor !== react.bonk) {
      toy.hitFor = react.bonk; // once per bonk, however the frames fall
      for (let i = 0; i < 6; i++) {
        const a = Math.PI * (0.1 + (i / 5) * 0.8);
        emit('star', top, {
          life: 0.9,
          vel: new THREE.Vector3(Math.cos(a) * 0.75, Math.sin(a) * 0.55, 0),
          size: 0.13,
          gravity: 0.8,
          spin: 5,
        });
      }
      emit('squeak', top.clone().addScaledVector(up, 0.25).addScaledVector(right, -0.35), {
        life: 0.9,
        vel: new THREE.Vector3(0, 0.25, 0),
        size: 0.34,
        grow: 1.25,
      });
    }
  } else toy.hammer.visible = false;
  return squash;
}
