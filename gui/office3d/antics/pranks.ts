// Antics that are your fault. Double-click the monitor and the computer
// blue-screens: the robot jumps, stares at the monitor, then turns to you,
// clutching its chest, and points. robot.js plays the crash at 0 and the
// "betrayed" line at 1.2. See ./index.js for the contract.
import { bump, mix, seg, wrap } from '@/office3d/core/math';
import type { Antic, Vec3Tuple } from './types';

const CLUTCH: Vec3Tuple = [-1.0, -0.5, -1.9]; // right hand on its chest
const POINT: Vec3Tuple = [-1.6, 0.2, -0.3]; // left arm straight out at you: "YOU did this"
const _head: Vec3Tuple = [0, 0, 0];

const bsod: Antic = {
  dur: 4.2,
  fadeIn: 0.1,
  update(c, A) {
    const { s, w } = c;
    A.screen = 'error';
    // jolt
    A.rootY += 0.06 * bump(s, 0, 0.3);
    A.shake = Math.max(A.shake, 1 - seg(s, 0, 0.35));
    // stares at the monitor… then slowly turns round to face you
    const atMonitor = seg(s, 0.1, 0.4) * (1 - seg(s, 1.0, 1.5));
    A.yaw += wrap(c.monitorYaw - c.curYaw) * 0.3 * atMonitor * w;
    _head[0] = mix(0.05, -0.12, seg(s, 1.2, 1.6)) - 0.04 * Math.sin(s * 3) * seg(s, 1.6, 2);
    _head[1] = 0.45 * atMonitor * Math.sign(wrap(c.monitorYaw - c.curYaw));
    _head[2] = 0.2 * seg(s, 1.2, 1.7); // the wounded head tilt
    c.toward(A.head, _head, w);
    A.lean = mix(A.lean, A.lean - 0.15, seg(s, 1.2, 1.6) * w);
    // a hand to its chest, the other pointing at you
    const hurt = seg(s, 1.15, 1.5) * (1 - seg(s, 3.6, 4.1));
    c.toward(A.armR, CLUTCH, hurt * w);
    c.toward(A.armL, POINT, seg(s, 1.6, 1.85) * (1 - seg(s, 3.0, 3.4)) * w);
    A.armL[0] += Math.sin(s * 18) * 0.04 * bump(s, 1.7, 3.0); // shaking with indignation
  },
};

export const PRANKS: Record<string, Antic> = { bsod };
