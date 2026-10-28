// Playing, every frame: the battery over its head as it charges at the plug, sparkles from a
// high-five, music notes while it dances, the drag's swing, a page eaten (crumbs), an idea (a bulb).
import * as THREE from 'three';
import { CSS_VARS } from './protocol';
import { ease, mix } from './core/math';
import type { buildBattery } from './battery';
import type { Emit } from './antics/types';
import type { Rig } from './types';

/** What it takes from the office, once. */
export type PlayParts = {
  world: THREE.Group;
  charger: ReturnType<typeof buildBattery>;
  emit: Emit;
  worldPoint: (obj: THREE.Object3D, x: number, y: number, z: number) => THREE.Vector3;
  camYaw: number;
  /** reaction name -> when it started (and crumbs: when they fly) */
  react: Partial<Record<string, number>>;
  cssNum: (name: string) => number;
};
/** What it takes from each frame. */
export type PlayFrame = {
  t: number;
  dt: number;
  robot: Rig;
  since: (reaction: string) => number;
  dancing: boolean;
  dragging: boolean;
  sChomp: number;
};

export function createPlay({ world, charger, emit, worldPoint, camYaw, react, cssNum }: PlayParts) {
  // (burstFor, fiveFor: the charge and the high-five they were for, as in react)
  const play: {
    nextBolt: number;
    nextNote: number;
    burstFor: number | null | undefined;
    fiveFor: number | null | undefined;
  } = { nextBolt: 0, nextNote: 0, burstFor: null, fiveFor: null };

  return function update({ t, dt, robot, since, dancing, dragging, sChomp }: PlayFrame) {
    // charge: a battery over its head fills red -> green while bolts crackle, then a burst
    const sCharge = since('charge');
    if (sCharge < 2.6) {
      const above = worldPoint(robot.head, 0, (robot.headTop ?? 0.6) + 0.3, 0);
      charger.battery.visible = true;
      charger.battery.position.copy(above);
      charger.battery.position.y += Math.sin(t * 6) * 0.015;
      charger.battery.rotation.y = camYaw;
      const grow = Math.min(1, sCharge / 0.2) * (sCharge > 2.35 ? Math.max(0, 1 - (sCharge - 2.35) / 0.25) : 1);
      charger.battery.scale.setScalar(Math.max(0.001, grow) * 1.25);
      charger.setLevel(sCharge / 1.9);
      if (t > play.nextBolt && sCharge < 1.9) {
        play.nextBolt = t + 0.18;
        const a = Math.random() * Math.PI * 2;
        emit('bolt', worldPoint(robot.head, Math.cos(a) * 0.35, 0.3 + Math.random() * 0.3, Math.sin(a) * 0.2), {
          life: 0.4,
          vel: new THREE.Vector3(0, 0.2, 0),
          size: 0.1,
          spin: 3,
        });
      }
      if (sCharge >= 1.95 && play.burstFor !== react.charge) {
        play.burstFor = react.charge; // full!
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          emit('bolt', above, {
            life: 0.7,
            vel: new THREE.Vector3(Math.cos(a) * 0.8, Math.sin(a) * 0.6 + 0.3, 0),
            size: 0.12,
            gravity: 0.6,
            spin: 4,
          });
        }
      }
    } else charger.battery.visible = false;
    // high-five: sparkles where the hands meet
    const sFive = since('highfive');
    if (sFive >= 0.45 && sFive < 1 && play.fiveFor !== react.highfive) {
      play.fiveFor = react.highfive;
      const hand = worldPoint(robot.arms.armR.elbow, 0, -0.25, 0);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        emit('star', hand, {
          life: 0.7,
          vel: new THREE.Vector3(Math.cos(a) * 0.7, Math.sin(a) * 0.7, 0),
          size: 0.1,
          gravity: 0.5,
          spin: 5,
        });
      }
    }
    // dance: music notes
    if (dancing && t > play.nextNote) {
      play.nextNote = t + 0.3;
      emit('note', worldPoint(robot.head, (Math.random() - 0.5) * 0.8, 0.5, 0.1), {
        life: 1.2,
        vel: new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.4, 0),
        size: 0.14,
        spin: 2,
      });
    }
    const swing = (cssNum(CSS_VARS.swing) * Math.PI) / 180;
    world.rotation.z = mix(world.rotation.z, swing * 0.5, ease(dt, dragging ? 20 : 6));
    // a page flies into the robot's mouth, then crumbs fly out
    if (sChomp < dt * 1.5) {
      const mouth = worldPoint(robot.head, 0, 0.2, 0.3);
      const from = worldPoint(robot.head, 0.25, 0.55, 1.4);
      emit('doc', from, { life: 0.4, vel: mouth.clone().sub(from).divideScalar(0.4), size: 0.26, grow: 0.35, spin: 3 });
      react.crumbs = t + 0.4;
    }
    if (react.crumbs && t >= react.crumbs) {
      react.crumbs = 0;
      const mouth = worldPoint(robot.head, 0, 0.2, 0.32);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        emit('crumb', mouth, {
          life: 0.8,
          vel: new THREE.Vector3(Math.cos(a) * 0.5, 0.45 + Math.random() * 0.3, Math.sin(a) * 0.5),
          size: 0.05,
          gravity: 2.2,
          spin: 4,
        });
      }
    }
    if (since('idea') < dt * 1.5) {
      emit('bulb', worldPoint(robot.head, 0.32, 0.85, 0), {
        life: 1.2,
        vel: new THREE.Vector3(0, 0.12, 0),
        size: 0.22,
      });
    }
  };
}
