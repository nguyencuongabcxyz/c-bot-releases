import { ease } from '@/office3d/core/math';
import { shadowMesh } from '@/office3d/core/mesh';
import * as THREE from 'three';
import { toon, glow, noOutline, canvasTexture } from './materials';
import { buildHammer, HAMMER } from './hammer';
import type { Theme } from './themes';

// The things round the desk you click to play with the robot (they replace the old hover
// menu): the squeaky hammer lying on the floor (bonk) and a power strip under the desk with
// the robot's charger plugged in (charge). buildProps(theme) ->
//   props.hammer, props.floor         add both to the office (on the floor)
//   props.hit(raycaster)               { kind: 'hammer' | 'plug', distance } | null
//   props.setHover(kind)               'hammer' | 'plug' | '' : that one glows and grows a little
//   props.update(t, dt, { bonking, charging })
//                                      per frame: the resting hammer hides while the bonk
//                                      hammer is out; the plug jiggles and its light goes
//                                      green while it charges
//   props.dispose()

export const PROPS = {
  // on the floor by the desk's left end, the BONK sticker to the camera (the left end stays
  // clear in every pose: asleep on the floor the chair rolls off to the right)
  hammer: { position: new THREE.Vector3(-1.42, 0, -0.32), yaw: 0.64, scale: 0.5 },
  // under the desk's left end, a cable up its leg
  plug: { position: new THREE.Vector3(-0.98, 0, -0.88), yaw: 1.25 },
};
const GLOW = new THREE.Color('#ffc93c');

// (a material that may light up: toon ones have an emissive colour, glow() ones don't)
type Lit = THREE.Material & { emissive?: THREE.Color };
type Owned = { dispose(): void };

// every material under a group, cloned so a glow on this one doesn't light up its twins
function ownMaterials(group: THREE.Object3D, owned: Owned[]) {
  const mats: { mat: Lit; base: THREE.Color }[] = [];
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return; // (one material each, here)
    o.material = o.material.clone() as Lit;
    owned.push(o.material);
    if (o.material.emissive) mats.push({ mat: o.material, base: o.material.emissive.clone() });
  });
  return mats;
}

export function buildProps(theme: Theme) {
  void theme;
  const owned: Owned[] = [];

  // ---- the hammer, resting: standing on its head with the handle sloping down to the floor
  const { hammer } = buildHammer();
  hammer.visible = true;
  const hammerSpot = new THREE.Group();
  hammerSpot.position.copy(PROPS.hammer.position);
  hammerSpot.rotation.y = PROPS.hammer.yaw;
  const hammerBody = new THREE.Group(); // scales up on hover, about the middle of the hammer
  hammerSpot.add(hammerBody);
  const s = PROPS.hammer.scale;
  const lean = Math.atan2(HAMMER.faceDrop + 0.012, HAMMER.reach); // head on the floor, handle end too
  hammer.scale.setScalar(s);
  hammer.rotation.z = -lean;
  hammer.position.set((HAMMER.reach / 2) * s * Math.cos(lean), 0.036 * s, 0); // (the middle at the spot)
  hammerBody.add(hammer);
  const hammerMats = ownMaterials(hammer, owned);

  // ---- the power strip, its light, and the charger plugged into it
  const floor = new THREE.Group();
  floor.position.copy(PROPS.plug.position);
  floor.rotation.y = PROPS.plug.yaw;
  const strip = new THREE.Group();
  floor.add(strip);
  const white = toon('#f4f5fb');
  const grey = toon('#c3c8d4');
  const dark = toon('#2b3150');
  owned.push(white, grey, dark);
  strip.add(shadowMesh(new THREE.BoxGeometry(0.32, 0.045, 0.1), white, 0, 0.0225, 0));
  for (const x of [-0.09, 0, 0.09]) {
    const socket = shadowMesh(new THREE.CylinderGeometry(0.026, 0.026, 0.004, 18), grey, x, 0.046, 0);
    strip.add(socket);
    for (const dx of [-0.008, 0.008])
      strip.add(shadowMesh(new THREE.CylinderGeometry(0.004, 0.004, 0.005, 8), dark, x + dx, 0.048, 0));
  }
  // the switch, with its light
  const lightMat = glow('#ff5a4f');
  owned.push(lightMat);
  strip.add(shadowMesh(new THREE.BoxGeometry(0.035, 0.016, 0.05), toon('#ff5a4f'), 0.14, 0.052, 0));
  const light = shadowMesh(new THREE.SphereGeometry(0.01, 10, 8), lightMat, 0.14, 0.064, 0.0);
  strip.add(light);
  // the plug: a chunky block with a lightning sticker, in the left socket
  const plug = new THREE.Group();
  plug.position.set(-0.09, 0.046, 0);
  strip.add(plug);
  const plugBody = new THREE.Group(); // (it jiggles while charging)
  plug.add(plugBody);
  const plugMat = toon('#ffd23f');
  owned.push(plugMat);
  plugBody.add(shadowMesh(new THREE.BoxGeometry(0.07, 0.06, 0.07), plugMat, 0, 0.03, 0));
  plugBody.add(shadowMesh(new THREE.CylinderGeometry(0.018, 0.022, 0.03, 12), dark, 0, 0.075, 0)); // where the cable goes in
  const bolt = canvasTexture(64, 64, (ctx) => {
    ctx.fillStyle = '#1d2235';
    ctx.beginPath();
    [
      [36, 4],
      [14, 36],
      [30, 36],
      [24, 60],
      [50, 26],
      [34, 26],
      [42, 4],
    ].forEach(([x, y], i) => {
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.fill();
  });
  owned.push(bolt.tex);
  const sticker = shadowMesh(
    new THREE.PlaneGeometry(0.05, 0.05),
    noOutline(new THREE.MeshBasicMaterial({ map: bolt.tex, transparent: true })),
    0,
    0.03,
    0.0355,
  );
  sticker.castShadow = false;
  plugBody.add(sticker);
  // the cable: out of the plug's top, along the floor, up the desk's back leg
  const cablePts = [
    [-0.09, 0.09, 0],
    [-0.09, 0.14, -0.02],
    [-0.14, 0.03, -0.12],
    [-0.2, 0.01, -0.3],
    [-0.26, 0.01, -0.42],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const cable = shadowMesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(cablePts), 24, 0.008, 6), dark);
  cable.castShadow = false;
  strip.add(cable);
  const plugMats = ownMaterials(strip, owned).filter((m) => m.mat !== lightMat);
  const lightOwn = light.material; // (cloned above)

  // ---- hover / play
  const hover = { hammer: 0, plug: 0 };
  let hoverKind = '';
  const glowAll = (mats: { mat: Lit; base: THREE.Color }[], k: number) => {
    for (const { mat, base } of mats) mat.emissive?.copy(base).lerp(GLOW, 0.35 * k); // (ownMaterials keeps only those with one)
  };
  const red = new THREE.Color('#ff5a4f');
  const green = new THREE.Color('#18d26e');

  return {
    hammer: hammerSpot,
    floor,
    hit(raycaster: THREE.Raycaster) {
      let best: { kind: 'hammer' | 'plug'; distance: number } | null = null;
      for (const [kind, group] of [
        ['hammer', hammerSpot],
        ['plug', floor],
      ] as const) {
        if (!group.visible || (kind === 'hammer' && !hammer.visible)) continue;
        group.updateWorldMatrix(true, true);
        const h = raycaster.intersectObject(group, true).find((x) => x.object.visible);
        if (h && (!best || h.distance < best.distance)) best = { kind, distance: h.distance };
      }
      return best;
    },
    setHover(kind?: string) {
      hoverKind = kind || '';
    },
    update(
      t: number,
      dt: number,
      { bonking = false, charging = 0 }: { bonking?: boolean; charging?: boolean | number } = {},
    ) {
      for (const k of ['hammer', 'plug'] as const) {
        hover[k] += ((hoverKind === k ? 1 : 0) - hover[k]) * ease(dt, 12);
      }
      // the hammer: picked up for the bonk (the swinging one is index.js's), back after
      hammer.visible = !bonking;
      hammerBody.scale.setScalar(1 + 0.12 * hover.hammer);
      hammerBody.position.y = 0.012 * hover.hammer;
      glowAll(hammerMats, hover.hammer);
      // the plug: wiggles while the power flows, its light goes green
      strip.scale.setScalar(1 + 0.1 * hover.plug);
      glowAll(plugMats, Math.max(hover.plug, charging ? 0.6 + 0.4 * Math.sin(t * 14) : 0));
      plugBody.position.y = charging ? Math.abs(Math.sin(t * 22)) * 0.01 : 0;
      plugBody.rotation.z = charging ? Math.sin(t * 31) * 0.06 : 0;
      lightOwn.color.copy(charging ? green : red);
    },
    dispose() {
      for (const g of [hammerSpot, floor]) {
        g.removeFromParent();
        g.traverse((o) => o instanceof THREE.Mesh && o.geometry?.dispose());
      }
      for (const x of owned) x.dispose?.();
    },
  };
}
