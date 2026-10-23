import * as THREE from 'three';
import { toon, glow } from './materials.js';

// Little helper bots: one per helper agent at work. They fly out of the
// robot's head, circle the desk while their helper works, hop when it takes a
// step, and fly home into the robot's head when it's done.

const COLORS = ['#8e7cff', '#ffd34d', '#7bed9f', '#ff9f43', '#5ac8fa', '#ff6b81'];
const FLY_OUT = 0.7; // seconds
const FLY_HOME = 0.55;

const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
};

function buildMini(color) {
  const bot = new THREE.Group();
  const body = toon(color);
  const ink = toon('#1d2235');
  const head = mesh(new THREE.SphereGeometry(0.1, 18, 14), body);
  head.scale.set(1.15, 0.95, 1);
  bot.add(head);
  // a dark visor with two glowing eyes, facing +z
  const visor = mesh(new THREE.SphereGeometry(0.075, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), ink, 0, 0, 0.045);
  visor.rotation.x = Math.PI / 2;
  visor.scale.set(1.2, 0.55, 0.8);
  bot.add(visor);
  const eye = glow('#7ff3ff');
  for (const side of [-1, 1]) bot.add(mesh(new THREE.SphereGeometry(0.016, 8, 6), eye, side * 0.035, 0.005, 0.1));
  // antenna and a little propeller
  bot.add(mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.07, 6), ink, 0, 0.12, 0));
  const prop = new THREE.Group();
  prop.position.y = 0.16;
  prop.add(mesh(new THREE.BoxGeometry(0.16, 0.008, 0.025), ink));
  prop.add(mesh(new THREE.SphereGeometry(0.014, 8, 6), glow('#ff5e62')));
  bot.add(prop);
  // stubby arms
  for (const side of [-1, 1]) {
    const arm = mesh(new THREE.CapsuleGeometry(0.018, 0.04, 3, 6), body, side * 0.11, -0.03, 0);
    arm.rotation.z = side * 0.6;
    bot.add(arm);
  }
  return { bot, prop };
}

const easeOut = (p) => 1 - (1 - p) ** 3;

/**
 * minis.update(t, dt, { want, head, center, faceYaw, hop, emit }):
 *   want     how many helpers are at work now
 *   head     where they leave from and come home to (Vector3, world group space)
 *   center   the middle of their circle over the desk
 *   faceYaw  turn them to face the camera
 *   hop      true on the frame a helper took a step: one of them hops
 *   emit     (kind, pos, opts) particle emitter, for the homecoming sparkle
 */
export function createMinis(parent) {
  const minis = [];
  let made = 0;

  function slot(i, n, t) {
    const a = t * 0.8 + (i / Math.max(1, n)) * Math.PI * 2;
    return { a, r: n === 1 ? 0.4 : 0.48 };
  }

  return {
    update(t, dt, { want, head, center, faceYaw, hop, emit }) {
      const out = minis.filter((m) => m.state !== 'home');
      if (out.length < want) {
        const { bot, prop } = buildMini(COLORS[made++ % COLORS.length]);
        bot.scale.setScalar(0.001);
        parent.add(bot);
        minis.push({ bot, prop, state: 'out', t0: t, hopAt: -1, from: head.clone() });
      } else if (out.length > want) {
        // the one that's been out longest comes home first
        const m = out[0];
        m.state = 'home';
        m.t0 = t;
        m.from = m.bot.position.clone();
      }
      if (hop) {
        const busy = minis.filter((m) => m.state === 'orbit');
        if (busy.length) busy[Math.floor(Math.random() * busy.length)].hopAt = t;
      }
      const circling = minis.filter((m) => m.state !== 'home');
      for (let i = minis.length - 1; i >= 0; i--) {
        const m = minis[i];
        const k = circling.indexOf(m);
        const { a, r } = slot(Math.max(0, k), circling.length, t);
        // a ring around the robot's head, tilted so the front of it dips toward you
        const target = new THREE.Vector3(center.x + Math.cos(a) * r, center.y + Math.sin(a) * 0.1 + Math.sin(t * 2.2 + i) * 0.04, center.z + Math.sin(a) * r * 0.7);
        const sinceHop = t - m.hopAt;
        if (m.hopAt >= 0 && sinceHop < 0.45) target.y += Math.sin((sinceHop / 0.45) * Math.PI) * 0.12;
        if (m.state === 'out') {
          const p = Math.min(1, (t - m.t0) / FLY_OUT);
          const e = easeOut(p);
          m.bot.position.lerpVectors(m.from, target, e);
          m.bot.position.y += Math.sin(p * Math.PI) * 0.25; // a little arc on the way out
          m.bot.scale.setScalar(Math.max(0.001, e));
          if (p >= 1) m.state = 'orbit';
        } else if (m.state === 'orbit') {
          m.bot.position.lerp(target, 1 - Math.exp(-dt * 6));
          m.bot.scale.setScalar(1);
        } else {
          const p = Math.min(1, (t - m.t0) / FLY_HOME);
          const e = p * p;
          m.bot.position.lerpVectors(m.from, head, e);
          m.bot.position.y += Math.sin(p * Math.PI) * 0.2;
          m.bot.scale.setScalar(Math.max(0.001, 1 - e * 0.85));
          if (p >= 1) {
            for (let s = 0; s < 5; s++) {
              const ang = (s / 5) * Math.PI * 2;
              emit('star', head, { life: 0.8, vel: new THREE.Vector3(Math.cos(ang) * 0.5, 0.45 + Math.sin(ang) * 0.2, 0), size: 0.1, gravity: 0.8, spin: 4 });
            }
            parent.remove(m.bot);
            minis.splice(i, 1);
            continue;
          }
        }
        m.bot.rotation.set(Math.sin(t * 3 + i) * 0.12, faceYaw + Math.sin(t * 1.3 + i) * 0.3, Math.sin(t * 2.4 + i) * 0.1);
        m.prop.rotation.y = t * 22;
      }
    },
  };
}
