// What floats about the desk while it works or sleeps: steam off the mug, z's, the housemaid's
// sparkles, sweat, a question mark, steam out of its ears with its memory full; the bin's papers,
// the headband at high effort; and the helper bots circling over the desk.
import * as THREE from 'three';
import { LAYOUT } from './scene';
import type { createMinis } from './minibots';
import type { OfficeData } from './protocol';
import type { Emit } from './antics/types';
import type { OfficeSet, Rig } from './types';

/** What it takes from the office, once. */
export type AmbientParts = {
  emit: Emit;
  worldPoint: (obj: THREE.Object3D, x: number, y: number, z: number) => THREE.Vector3;
  minis: ReturnType<typeof createMinis>;
  camYaw: number;
};
/** What it takes from each frame. */
export type AmbientFrame = {
  t: number;
  dt: number;
  d: OfficeData;
  awake: boolean;
  working: boolean;
  scr: string;
  pose: string;
  thinking: boolean;
  hidden: boolean;
  lights: number;
  screen: string | null;
  set: OfficeSet;
  robot: Rig;
  since: (reaction: string) => number;
};

export function createAmbient({ emit, worldPoint, minis, camYaw }: AmbientParts) {
  let nextZ = 0;
  let nextSparkle = 0; // (the housemaid dusting the desk: data-tidy)
  let nextSteam = 0;
  let nextSweat = 0;
  let nextBrainSteam = 0;
  let nextQuestion = 0;

  return function update({
    t,
    dt,
    d,
    awake,
    working,
    scr,
    pose,
    thinking,
    hidden,
    lights,
    screen,
    set,
    robot,
    since,
  }: AmbientFrame) {
    if (t > nextSteam && lights > 0.5) {
      nextSteam = t + (thinking ? 0.35 : 0.9);
      emit('steam', worldPoint(set.mug, (Math.random() - 0.5) * 0.04, 0.16, 0), {
        life: 1.6,
        vel: new THREE.Vector3(0, 0.18, 0),
        size: 0.07,
        grow: 2.2,
      });
    }
    if (pose === 'sleep' && !hidden && t > nextZ) {
      nextZ = t + 1.1;
      emit('z', worldPoint(robot.head, 0.25, 0.65, 0), {
        life: 2.2,
        vel: new THREE.Vector3(0.12, 0.22, 0),
        size: 0.1,
        grow: 2,
      });
    }
    // the evening housemaid dusting (robot.js: data-tidy): sparkles all over the desk, and under
    // it where she sweeps; her emptied bin keeps no paper till the morning (data-bin-empty)
    if (d.tidy === '1' && !hidden && t > nextSparkle) {
      nextSparkle = t + 0.12;
      const under = Math.random() < 0.3;
      const p = under
        ? new THREE.Vector3(-0.9 + Math.random() * 1.2, 0.04 + Math.random() * 0.1, -0.75 + Math.random() * 0.5)
        : new THREE.Vector3(
            -1.15 + Math.random() * 1.5,
            LAYOUT.deskTop + 0.04 + Math.random() * 0.45,
            -1.18 + Math.random() * 0.55,
          );
      emit('star', worldPoint(under ? set.office : set.desk?.top || set.office, p.x, p.y, p.z), {
        life: 0.8,
        vel: new THREE.Vector3(0, 0.12, 0),
        size: 0.05 + Math.random() * 0.05,
        grow: 0.3,
        spin: 4,
      });
    }
    // (the bin: antics/awake.js puts it there)
    for (const paper of (set.office.userData.bin as THREE.Object3D | undefined)?.children || [])
      if (paper.userData.binPaper as boolean | undefined) paper.visible = d.binEmpty !== '1';
    // high effort: headband on; full memory: steam out of the ears
    robot.headband.visible = d.effort === 'xhigh' || d.effort === 'max';
    if (d.brain === 'full' && awake && !hidden && t > nextBrainSteam) {
      nextBrainSteam = t + 0.5;
      for (const side of [-1, 1])
        emit('steam', worldPoint(robot.head, side * 0.45, 0.35, 0), {
          life: 1.2,
          vel: new THREE.Vector3(side * 0.25, 0.3, 0),
          size: 0.08,
          grow: 2.5,
        });
    }
    const hurried = d.hurry === '1';
    if ((screen === 'run' || (hurried && working)) && !hidden && t > nextSweat) {
      nextSweat = t + (hurried ? 0.6 : 1.4);
      emit('sweat', worldPoint(robot.head, 0.36, 0.5, 0.1), {
        life: 0.9,
        vel: new THREE.Vector3(0.05, -0.35, 0),
        size: 0.08,
      });
    }
    if (pose === 'thinking' && scr !== 'helpers' && !hidden && t > nextQuestion) {
      nextQuestion = t + 1.6;
      emit('question', worldPoint(robot.head, -0.15, 0.85, 0), {
        life: 1.4,
        vel: new THREE.Vector3(0, 0.15, 0),
        size: 0.17,
        spin: 1.5,
      });
    }
    // helper agents at work: little bots circling over the desk
    const helperHome = worldPoint(robot.head, 0, robot.headTop ?? 0.6, 0);
    minis.update(t, dt, {
      want: hidden ? 0 : Math.min(6, Number(d.helpers) || 0),
      head: helperHome,
      center: helperHome
        .clone()
        .lerp(LAYOUT.monitor, 0.2)
        .setY(helperHome.y + 0.12),
      faceYaw: camYaw,
      hop: since('helper-step') < dt * 1.5,
      emit,
    });
  };
}
