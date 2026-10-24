import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toon, glow, noOutline, canvasTexture, roundRect } from './materials.js';
import { SCREEN_W, SCREEN_H } from './screens.js';
import { THEMES } from './themes.js';

// Layout of the robot's workstation (metres-ish; the ground is y = 0).
export const LAYOUT = {
  deskTop: 0.82,
  chair: new THREE.Vector3(0.02, 0, -0.3),
  monitor: new THREE.Vector3(-0.62, 0.82, -1.12),
  monitorYaw: 0.32,
  keyboard: new THREE.Vector3(-0.32, 0.86, -0.8),
};

const box = (w, h, d, r = 0.03) => new RoundedBoxGeometry(w, h, d, 3, r);
const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
};

export function buildOffice(theme = THEMES.classic) {
  const office = new THREE.Group();
  const { deskTop } = LAYOUT;
  const T = theme;

  // ---- invisible ground that only shows the shadows, so the desk sits on the desktop
  const ground = mesh(new THREE.PlaneGeometry(4, 4), noOutline(new THREE.ShadowMaterial({ color: '#1d2235', opacity: 0.22 })), -0.4, 0, -0.6);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  office.add(ground);

  // ---- desk: an electric standing desk. Its top, and everything on it, rides on
  // `top` (set.desk.top.position.y is how far it's raised); each leg is a fixed
  // outer column with an inner one sliding out of it. A little panel under the
  // front edge has a height display and ▲ / ▼ buttons (set.desk.drawPanel).
  const desk = new THREE.Group();
  const top = new THREE.Group();
  const deskX = -0.42;
  const deskZ = -1.0;
  const wood = toon(T.desk.top);
  const woodDark = toon(T.desk.frame);
  const steel = toon(T.desk.column || '#c3c8d4');
  top.add(mesh(box(1.55, 0.06, 0.78, 0.02), wood, deskX, deskTop - 0.03, deskZ));
  top.add(mesh(new THREE.BoxGeometry(1.4, 0.05, 0.07), woodDark, deskX, deskTop - 0.085, deskZ)); // the frame under the top
  for (const x of [deskX - 0.72, deskX + 0.72]) {
    desk.add(mesh(new THREE.BoxGeometry(0.09, 0.42, 0.075), woodDark, x, 0.25, deskZ)); // outer column
    desk.add(mesh(box(0.1, 0.04, 0.68, 0.015), woodDark, x, 0.02, deskZ)); // foot
    top.add(mesh(new THREE.BoxGeometry(0.066, 0.62, 0.052), steel, x, deskTop - 0.11 - 0.31, deskZ)); // inner column: rides up
  }
  // a rolling drawer unit stays on the floor
  desk.add(mesh(box(0.42, 0.6, 0.66, 0.02), woodDark, deskX + 0.46, 0.34, deskZ));
  for (const y of [0.5, 0.24]) desk.add(mesh(box(0.14, 0.03, 0.03, 0.01), toon(T.desk.handle), deskX + 0.46, y, deskZ + 0.34));
  // the control panel, under the top at the right-hand end (where the camera can see it)
  const panelFace = canvasTexture(256, 64);
  function drawPanel(cm = 72, pressed = '') {
    const { ctx } = panelFace;
    ctx.fillStyle = '#23283a';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#0d1a12';
    roundRect(ctx, 10, 10, 104, 44, 6);
    ctx.fill();
    ctx.fillStyle = '#5dff9a';
    ctx.font = '700 34px Consolas, "Cascadia Code", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(cm), 62, 34);
    for (const [i, dir] of [[0, 'up'], [1, 'down']]) {
      const x = 132 + i * 60;
      const lit = pressed === dir;
      ctx.fillStyle = lit ? '#ffd34d' : '#3d4459';
      roundRect(ctx, x, 9, 50, 46, 10);
      ctx.fill();
      ctx.fillStyle = lit ? '#1d2235' : '#d9def0';
      ctx.beginPath();
      if (dir === 'up') {
        ctx.moveTo(x + 25, 20);
        ctx.lineTo(x + 37, 42);
        ctx.lineTo(x + 13, 42);
      } else {
        ctx.moveTo(x + 13, 22);
        ctx.lineTo(x + 37, 22);
        ctx.lineTo(x + 25, 44);
      }
      ctx.fill();
    }
    panelFace.tex.needsUpdate = true;
  }
  drawPanel();
  const panel = new THREE.Group();
  panel.position.set(deskX + 0.79, deskTop - 0.078, deskZ + 0.24);
  panel.rotation.y = Math.PI / 2; // facing out of the desk's end
  panel.add(mesh(box(0.2, 0.05, 0.07, 0.012), toon('#23283a'), 0, 0, 0));
  const face = mesh(new THREE.PlaneGeometry(0.19, 0.0475), new THREE.MeshBasicMaterial({ map: panelFace.tex }), 0, 0, 0.0352);
  noOutline(face.material);
  panel.add(face);
  const buttons = new THREE.Object3D(); // where a finger presses (between ▲ and ▼)
  buttons.position.set(0.05, -0.005, 0.045);
  panel.add(buttons);
  top.add(panel);
  desk.add(top);
  office.add(desk);

  // ---- monitor
  const monitor = new THREE.Group();
  monitor.position.copy(LAYOUT.monitor);
  monitor.rotation.y = LAYOUT.monitorYaw;
  const metal = toon(T.monitor.stand);
  monitor.add(mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.03, 24), metal, 0, 0.015, 0));
  monitor.add(mesh(box(0.07, 0.36, 0.05, 0.02), metal, 0, 0.18, -0.03));
  monitor.add(mesh(box(0.98, 0.62, 0.06, 0.03), toon(T.monitor.bezel), 0, 0.68, 0));
  const screen = canvasTexture(SCREEN_W, SCREEN_H);
  const screenMat = glow('#ffffff', { map: screen.tex });
  monitor.add(mesh(new THREE.PlaneGeometry(0.9, 0.54), screenMat, 0, 0.68, 0.032));
  const led = mesh(new THREE.SphereGeometry(0.012, 8, 8), glow('#7bed9f'), 0.44, 0.39, 0.034);
  monitor.add(led);
  const screenLight = new THREE.PointLight('#ffffff', 0, 2.2, 1.6);
  screenLight.position.set(0, 0.68, 0.45);
  monitor.add(screenLight);
  top.add(monitor);

  // ---- sticky notes on the monitor's frame, shared by the features that put things
  // in sight: each kind has its own edge (English words on the left, notes on the right),
  // up to three notes stacked down it
  const stickies = buildStickies(monitor, office);

  // ---- keyboard + mouse
  const keyboard = new THREE.Group();
  keyboard.position.copy(LAYOUT.keyboard);
  keyboard.rotation.y = LAYOUT.monitorYaw;
  keyboard.add(mesh(box(0.56, 0.03, 0.19, 0.012), toon(T.keyboard.body), 0, 0, 0));
  const keyMat = toon(T.keyboard.keys);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 9; c++) {
      keyboard.add(mesh(new THREE.BoxGeometry(0.045, 0.012, 0.042), keyMat, -0.22 + c * 0.055, 0.02, -0.055 + r * 0.055));
    }
  }
  top.add(keyboard);
  const mouse = mesh(new THREE.CapsuleGeometry(0.03, 0.04, 4, 8), toon(T.keyboard.body), 0.05, 0.85, -0.74);
  mouse.rotation.x = Math.PI / 2;
  mouse.scale.set(1, 1, 0.6);
  top.add(mouse);

  // ---- coffee mug
  const mug = new THREE.Group();
  mug.position.set(0.28, deskTop, -1.08);
  mug.add(mesh(new THREE.CylinderGeometry(0.06, 0.055, 0.13, 20), toon(T.mug.body), 0, 0.065, 0));
  mug.add(mesh(new THREE.CylinderGeometry(0.061, 0.061, 0.03, 20), toon(T.mug.band), 0, 0.075, 0));
  const handle = mesh(new THREE.TorusGeometry(0.035, 0.012, 6, 12, Math.PI), toon(T.mug.body), 0.06, 0.065, 0);
  handle.rotation.z = -Math.PI / 2;
  mug.add(handle);
  mug.add(mesh(new THREE.CircleGeometry(0.052, 20), toon('#6b3e1f'), 0, 0.125, 0).rotateX(-Math.PI / 2));
  top.add(mug);

  // ---- desk lamp
  const lamp = new THREE.Group();
  lamp.position.set(-1.0, deskTop, -1.2);
  lamp.add(mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.03, 20), toon(T.lamp.base), 0, 0.015, 0));
  const arm1 = mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.42, 8), toon('#1d2235'), 0.05, 0.21, 0);
  arm1.rotation.z = -0.25;
  lamp.add(arm1);
  const shade = new THREE.Group();
  shade.position.set(0.12, 0.42, 0.04);
  shade.rotation.set(0.5, 0, -0.9);
  shade.add(mesh(new THREE.ConeGeometry(0.11, 0.16, 20, 1, true), toon(T.lamp.shade, { side: THREE.DoubleSide })));
  const bulbMat = glow('#fff3b0');
  shade.add(mesh(new THREE.SphereGeometry(0.04, 12, 12), bulbMat, 0, -0.06, 0));
  lamp.add(shade);
  const lampLight = new THREE.PointLight('#ffcf7a', 1.2, 2.2, 1.5);
  lampLight.position.set(0.2, 0.3, 0.15);
  lamp.add(lampLight);
  top.add(lamp);

  // ---- the word box: an index-card box between the monitor and the mug, filling
  // up with cards as you collect English words (hidden until the first one)
  const wordBox = new THREE.Group();
  wordBox.position.set(0.0, deskTop, -1.24);
  wordBox.rotation.y = -0.25;
  const boxMat = toon('#7fb7e6');
  const boxDark = toon('#4f86b8');
  wordBox.add(mesh(new THREE.BoxGeometry(0.17, 0.012, 0.11), boxDark, 0, 0.006, 0));
  for (const [w, d, x, z] of [[0.17, 0.012, 0, 0.049], [0.17, 0.012, 0, -0.049], [0.012, 0.11, 0.079, 0], [0.012, 0.11, -0.079, 0]]) {
    wordBox.add(mesh(new THREE.BoxGeometry(w, 0.07, d), boxMat, x, 0.035, z));
  }
  const tag = canvasTexture(96, 40, (ctx) => {
    ctx.fillStyle = '#fffdf5';
    roundRect(ctx, 4, 4, 88, 32, 8);
    ctx.fill();
    ctx.fillStyle = '#1d2235';
    ctx.font = '800 22px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ABC', 48, 21);
  });
  const tagMesh = mesh(new THREE.PlaneGeometry(0.07, 0.03), noOutline(new THREE.MeshToonMaterial({ map: tag.tex, transparent: true })), 0, 0.04, 0.0562);
  wordBox.add(tagMesh);
  const cardMat = toon('#fffdf5');
  const cardTip = toon('#ff8fab');
  const cards = [];
  for (let i = 0; i < 10; i++) {
    const card = new THREE.Group();
    card.position.set(0, 0.05 + (i % 3) * 0.006, -0.04 + i * 0.009);
    card.rotation.x = -0.18 + (i % 2) * 0.08;
    card.add(mesh(new THREE.BoxGeometry(0.15, 0.09, 0.003), cardMat));
    card.add(mesh(new THREE.BoxGeometry(0.15, 0.012, 0.0035), cardTip, 0, 0.039, 0));
    card.visible = false;
    wordBox.add(card);
    cards.push(card);
  }
  wordBox.visible = false;
  top.add(wordBox);
  // how many words there are: one card showing for each, up to ten
  const setWordCount = (n) => {
    wordBox.visible = n > 0;
    cards.forEach((card, i) => (card.visible = i < n));
  };

  // ---- swivel chair: the base stays put, the top (seat + back + robot) spins
  const chair = new THREE.Group();
  chair.position.copy(LAYOUT.chair);
  const chairDark = toon(T.chair.frame);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leg = mesh(new THREE.BoxGeometry(0.05, 0.04, 0.3), chairDark, Math.sin(a) * 0.15, 0.07, Math.cos(a) * 0.15);
    leg.rotation.y = a;
    chair.add(leg);
    chair.add(mesh(new THREE.SphereGeometry(0.04, 10, 8), toon(T.chair.wheel), Math.sin(a) * 0.3, 0.04, Math.cos(a) * 0.3));
  }
  // the gas column: stretches when the seat is pumped up (set.chair.lift)
  const column = mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.4, 12), metal, 0, 0.28, 0);
  chair.add(column);
  const swivel = new THREE.Group();
  swivel.position.y = 0.46;
  const seatMat = toon(T.chair.seat);
  swivel.add(mesh(box(0.62, 0.1, 0.58, 0.04), seatMat, 0, 0.04, 0));
  swivel.add(mesh(new THREE.BoxGeometry(0.06, 0.4, 0.04), chairDark, 0, 0.26, -0.27));
  swivel.add(mesh(box(0.58, 0.58, 0.09, 0.05), seatMat, 0, 0.6, -0.3));
  chair.add(swivel);
  office.add(chair);

  // ---- brand touches: a nameplate on the desk, a logo on the mug and the back of the chair
  if (T.brand) {
    const plate = canvasTexture(256, 96, (ctx, w, h) => {
      ctx.fillStyle = T.brand.plate || '#ffffff';
      ctx.fillRect(0, 0, w, h);
      T.brand.logo(ctx, 14, 14, 68, false);
      ctx.fillStyle = T.brand.ink || '#1d2235';
      ctx.textBaseline = 'middle';
      // as big as fits beside the logo
      let size = 34;
      do ctx.font = `800 ${size--}px ${T.brand.font || '"Segoe UI", sans-serif'}`;
      while (size > 12 && ctx.measureText(T.brand.short || T.brand.name).width > w - 104);
      ctx.fillText(T.brand.short || T.brand.name, 94, 40);
      ctx.font = `600 17px ${T.brand.font || '"Segoe UI", sans-serif'}`;
      ctx.globalAlpha = 0.7;
      ctx.fillText(T.brand.tagline || '', 95, 70);
      ctx.globalAlpha = 1;
    });
    const nameplate = new THREE.Group();
    nameplate.position.set(0.12, deskTop, -0.78);
    nameplate.rotation.y = -0.35;
    const front = new THREE.MeshToonMaterial({ map: plate.tex });
    const side = toon(T.brand.plate || '#ffffff');
    // a little tent card leaning back
    const card = mesh(new THREE.BoxGeometry(0.34, 0.13, 0.012), [side, side, side, side, front, side], 0, 0.065, 0);
    card.rotation.x = -0.32;
    nameplate.add(card);
    nameplate.add(mesh(new THREE.BoxGeometry(0.34, 0.012, 0.06), toon(T.brand.accent || T.mug.band), 0, 0.006, -0.02));
    top.add(nameplate);

    const decal = canvasTexture(128, 128, (ctx) => T.brand.logo(ctx, 14, 14, 100, false));
    const logoMat = new THREE.MeshToonMaterial({ map: decal.tex, transparent: true });
    noOutline(logoMat);
    const mugLogo = mesh(new THREE.PlaneGeometry(0.075, 0.075), logoMat, 0, 0.055, 0.0605);
    mug.add(mugLogo);
    const chairLogo = mesh(new THREE.PlaneGeometry(0.22, 0.22), logoMat, 0, 0.62, -0.346);
    chairLogo.rotation.y = Math.PI;
    swivel.add(chairLogo);
  }

  office.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  ground.castShadow = false;

  return {
    office,
    swivel, // the robot sits on this; its rotation is the chair's swivel
    seatHeight: 0.55,
    // the standing desk: raise `top` (everything on the desk rides on it); the panel's
    // `buttons` is where a finger presses; drawPanel(cm, 'up' | 'down' | '') redraws its face
    desk: { top, buttons, drawPanel },
    // the chair's seat height: lift(by) raises the seat (and robot) and stretches the column
    chair: {
      lift(by) {
        swivel.position.y = 0.46 + by;
        column.scale.y = (0.4 + by) / 0.4;
        column.position.y = 0.08 + (0.4 + by) / 2;
      },
    },
    screen: { ...screen, material: screenMat, light: screenLight, led },
    lamp: { group: lamp, light: lampLight, bulb: bulbMat },
    // the English word box: setCount(n) shows it with a card for each word (up to ten)
    wordBox: { group: wordBox, setCount: setWordCount },
    stickies, // sticky notes on the monitor: see buildStickies
    mug,
    keyboard,
  };
}

// ---------------------------------------------------------------- sticky notes

// Sticky notes on the monitor's frame, one edge per kind of thing (STICKY_SIDES),
// up to three down each edge, half on the frame and half hanging off it.
//   stickies.set(kind, items)  items [{ id, text, sub?, color? }]: what that edge shows
//   stickies.objects           the meshes, for a raycast (index.js stickyAt)
//   stickies.lookup(mesh)      -> { kind, id } for one of them (or null)
//   stickies.peel(kind, id)    takes that note off the frame and returns it (a Group in
//                              office space, where it was) for an antic to fling; it's the
//                              antic's to dispose of. The edge closes up at the next set().
//   stickies.hover(kind, id)   the note under the mouse ('' for none): it pops up bigger,
//                              straightens and comes in towards the screen's middle
//   stickies.update(dt)        every frame (the zoom springs); true while something's moving
const STICKY_SIDES = { vocab: -1, note: 1 };
const STICKY = { size: 0.19, slots: 3, colors: { vocab: '#bfe7ff', note: '#fff2a8' } };
const ZOOM = { scale: 2.6, inward: 0.2, out: 0.08, stiff: 260, damp: 17 }; // hovered: how big, how far in and out, its spring
function stickyTexture(text, sub, color) {
  return canvasTexture(160, 160, (ctx, w, h) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.07)'; // the sticky strip along the top
    ctx.fillRect(0, 0, w, 26);
    ctx.fillStyle = '#1d2235';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 34;
    ctx.font = `800 ${size}px "Segoe UI", sans-serif`;
    while (size > 14 && ctx.measureText(text).width > w - 16) {
      size -= 2;
      ctx.font = `800 ${size}px "Segoe UI", sans-serif`;
    }
    ctx.fillText(text, w / 2, sub ? 66 : 84);
    if (!sub) return;
    ctx.fillStyle = 'rgba(29,34,53,0.75)';
    ctx.font = '600 17px "Segoe UI", sans-serif';
    const words = sub.split(' ');
    const lines = [];
    let line = '';
    for (const part of words) {
      const next = line ? `${line} ${part}` : part;
      if (ctx.measureText(next).width > w - 18 && line) {
        lines.push(line);
        line = part;
      } else line = next;
    }
    if (line) lines.push(line);
    lines.slice(0, 3).forEach((l, i) => ctx.fillText(i === 2 && lines.length > 3 ? l + '…' : l, w / 2, 104 + i * 20));
  });
}
function buildStickies(monitor, office) {
  const rack = new THREE.Group();
  rack.position.set(0, 0.68, 0.034); // the frame's face (see the monitor above)
  monitor.add(rack);
  const shown = {}; // kind -> [{ id, group, mesh, base: { x, y, z, rz }, zoom, vel, side }]
  const objects = [];
  const owner = new Map(); // mesh -> { kind, id }
  let hovered = { kind: '', id: '' };
  function clear(kind) {
    for (const n of shown[kind] || []) {
      n.group.removeFromParent();
      n.mesh.material.map.dispose();
      n.mesh.material.dispose();
      n.mesh.geometry.dispose();
      owner.delete(n.mesh);
      objects.splice(objects.indexOf(n.mesh), 1);
    }
    shown[kind] = [];
  }
  return {
    objects,
    set(kind, items = []) {
      const side = STICKY_SIDES[kind];
      if (!side) return;
      const list = items.slice(0, STICKY.slots);
      const key = JSON.stringify(list.map((x) => [x.id, x.text, x.sub, x.color]));
      if (shown[kind]?.key === key) return;
      clear(kind);
      shown[kind].key = key;
      list.forEach((item, i) => {
        const group = new THREE.Group();
        // stacked down the edge, each a little askew, half over the frame
        group.position.set(side * (0.49 + STICKY.size * 0.1), 0.2 - i * (STICKY.size + 0.015), 0.002 + i * 0.001);
        group.rotation.z = side * (0.06 + 0.05 * ((i * 7) % 3)) * (i % 2 ? -1 : 1);
        const base = { x: group.position.x, y: group.position.y, z: group.position.z, rz: group.rotation.z };
        const tex = stickyTexture(String(item.text || ''), String(item.sub || ''), item.color || STICKY.colors[kind]);
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(STICKY.size, STICKY.size), glow('#ffffff', { map: tex.tex, side: THREE.DoubleSide })); // lit: readable in a dark room too
        mesh.castShadow = true;
        group.add(mesh);
        rack.add(group);
        shown[kind].push({ id: item.id, group, mesh, base, side, zoom: 0, vel: 0 });
        objects.push(mesh);
        owner.set(mesh, { kind, id: item.id });
      });
    },
    lookup(mesh) {
      return owner.get(mesh) || null;
    },
    hover(kind = '', id = '') {
      hovered = { kind, id };
    },
    update(dt) {
      let moving = false;
      const step = Math.min(dt, 1 / 30);
      for (const [kind, list] of Object.entries(shown)) {
        for (const n of list) {
          const want = hovered.kind === kind && hovered.id === n.id ? 1 : 0;
          // a springy pop: it overshoots a little and settles
          n.vel += ((want - n.zoom) * ZOOM.stiff - n.vel * ZOOM.damp) * step;
          n.zoom += n.vel * step;
          if (Math.abs(want - n.zoom) < 0.001 && Math.abs(n.vel) < 0.001) {
            n.zoom = want;
            n.vel = 0;
          } else moving = true;
          const z = n.zoom;
          n.group.scale.setScalar(1 + (ZOOM.scale - 1) * Math.max(0, z));
          n.group.position.set(n.base.x - n.side * ZOOM.inward * z, n.base.y - 0.05 * z, n.base.z + ZOOM.out * z);
          n.group.rotation.z = n.base.rz * (1 - Math.min(1, Math.max(0, z)));
          n.mesh.renderOrder = z > 0.01 ? 5 : 0; // over the rest of the desk while it's up
        }
      }
      return moving;
    },
    peel(kind, id) {
      const n = (shown[kind] || []).find((x) => x.id === id);
      if (!n) return null;
      office.attach(n.group); // keeps it where it is, now in office space
      owner.delete(n.mesh);
      objects.splice(objects.indexOf(n.mesh), 1);
      shown[kind] = shown[kind].filter((x) => x !== n);
      shown[kind].key = ''; // the next set() lays the edge out again
      return n.group;
    },
  };
}
