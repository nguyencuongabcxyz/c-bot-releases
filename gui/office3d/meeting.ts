import * as THREE from 'three';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';
import { POSES } from './robot3d';
import { buildKit } from './kit3d';
import { toon, glow, noOutline, canvasTexture, roundRect } from './materials';
import { themeOf } from './themes';
import type { Rig } from './types';
import type { Vec3Tuple } from './antics/types';
import type { Kit } from '@/types/model';

// The group chat's meeting room (main groupChat.js / meeting.js; page renderer/meeting): a
// small room seen from the front, everyone in the chat sitting round one table, the topic on
// the whiteboard. Robots roll in through the door on their office chairs, one after another,
// as they leave their desks. Whoever's talking talks (mouth and hands) and the others turn to
// it; whoever's writing a message thinks; the host writes the summary.
// Built to cost little: its own small bundle (meeting3d.bundle.js, no desk), one renderer for
// everyone, no shadow maps (a soft blob under each chair), and it draws 30 times a second only
// while something moves (someone rolling in, turning or talking), else 8, and not at all while
// the window is hidden. The window only exists while the meeting's on.
//   mount(host, { width, height, onFrame }) -> {
//     seat(people)      [{ id, name, color, kit, acc, theme }]: they roll in, in this order
//     topic(text)       on the whiteboard
//     act(id, mode)     'idle' | 'typing' | 'talking' | 'summary' | 'agree'
//     focus(id|null)    the others turn to this one
//     headAt(id)        where its head is on the page (CSS px), for its speech bubble
//     dispose() }
//   onFrame()  after each frame drawn (the page moves the bubbles then)

/** Someone at the table (seat): kit is its parts (JSON, or as an object: kit3d.js). */
export type MeetingSeat = { id: string; name?: string; color?: string; kit?: string | Kit; acc?: string; theme: string };
/** What they can be doing (act): anything else is 'idle'. */
export type MeetingMode = 'idle' | 'typing' | 'talking' | 'summary' | 'agree';
export type MeetingOptions = { width: number; height: number; onFrame?: () => void };
/** What mount() gives back. */
export type MeetingView = {
  seat(list: MeetingSeat[]): number; // how many are new (rolling in)
  topic(text: string): void;
  act(id: string, mode: string): void; // a MeetingMode
  focus(id: string | null | undefined): void;
  headAt(id: string): { x: number; y: number } | null;
  resize(w: number, h: number): void;
  dispose(): void;
};

/** How someone sits for a mode: its pose (robot3d POSES) and face. */
type Mood = { pose: string; eyes: string; mouth: string };
/** Someone in the room, and how they're posed now. */
type Person = {
  robot: Rig;
  chair: THREE.Group;
  swivel: THREE.Group;
  mode: string;
  cur: { yaw: number; lean: number; head: Vec3Tuple; armL: Vec3Tuple; armR: Vec3Tuple };
  face: string; // the face as drawn ('' for one that moves by itself)
  blinkAt: number;
  blinkUntil?: number;
  arriveAt: number; // when it rolls in (s)
  home: THREE.Vector3; // its place at the table
  homeYaw: number;
  moving?: boolean; // still turning
};

const ROBOT_SCALE = 0.82;
const SEAT_Y = 0.46;
const TABLE = { x: 0, z: 0.25, rx: 1.05, rz: 0.6, h: 0.6 };
const RING = { rx: 1.7, rz: 1.18 }; // where the chairs stand round the table
const DOOR = new THREE.Vector3(-3.5, 0, -1.1); // they roll in from here, through the door in the left wall
const ARRIVE = { first: 0.9, gap: 0.55, glide: 1.6 }; // seconds: the first one, between them, the roll in
const MOODS: Record<string, Mood> = {
  idle: { pose: 'idle', eyes: 'open', mouth: 'smile' },
  typing: { pose: 'thinking', eyes: 'open', mouth: 'flat' },
  talking: { pose: 'talking', eyes: 'open', mouth: 'talk' },
  summary: { pose: 'typing', eyes: 'open', mouth: 'flat' },
  agree: { pose: 'idle', eyes: 'happy', mouth: 'smile' },
};
const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
};

// ------------------------------------------------------------ the room

function whiteboardText(ctx: CanvasRenderingContext2D, w: number, h: number, text: string) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fbfcff';
  roundRect(ctx, 0, 0, w, h, 18);
  ctx.fill();
  ctx.fillStyle = '#5a6380';
  ctx.font = '700 30px "Segoe UI", sans-serif';
  ctx.fillText('TODAY', 34, 54);
  ctx.fillStyle = '#1d2235';
  ctx.font = '600 40px "Segoe UI", sans-serif';
  // the topic, wrapped onto three lines at most
  const words = String(text || '').split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > w - 68 && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > 3) {
    lines.length = 3;
    lines[2] = lines[2].replace(/\s*\S*$/, '') + '…';
  }
  lines.forEach((l, i) => ctx.fillText(l, 34, 112 + i * 50));
  // a few marker squiggles
  ctx.strokeStyle = '#e5484d';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(w - 150, h - 44);
  ctx.bezierCurveTo(w - 120, h - 70, w - 90, h - 20, w - 50, h - 48);
  ctx.stroke();
}

function buildRoom() {
  const room = new THREE.Group();
  const wall = toon('#e9e4f7');
  const trim = toon('#cfc6ea');
  // the floor: a carpet on a wooden floor
  room.add(mesh(new THREE.BoxGeometry(6.2, 0.1, 3.9), toon('#d9b48a'), 0, -0.05, 0));
  const rug = mesh(new THREE.CylinderGeometry(1, 1, 0.02, 48), toon('#8fa5e8'), TABLE.x, 0.01, TABLE.z);
  rug.scale.set(2.35, 1, 1.75);
  room.add(rug);
  // back wall with a skirting board, and the left wall with the door gap
  room.add(mesh(new THREE.BoxGeometry(6.2, 2.5, 0.1), wall, 0, 1.25, -1.95));
  room.add(mesh(new THREE.BoxGeometry(6.2, 0.12, 0.12), trim, 0, 0.06, -1.88));
  // (the left wall stops short of the front, so you see in; the door's near the back)
  room.add(mesh(new THREE.BoxGeometry(0.1, 2.5, 0.45), wall, -3.1, 1.25, -1.725));
  room.add(mesh(new THREE.BoxGeometry(0.1, 0.5, 0.8), wall, -3.1, 2.25, -1.1));
  room.add(mesh(new THREE.BoxGeometry(0.1, 2.5, 1.1), wall, -3.1, 1.25, -0.15));
  for (const z of [-1.5, -0.7]) room.add(mesh(new THREE.BoxGeometry(0.14, 2.0, 0.08), trim, -3.08, 1.0, z)); // (the door frame)
  // the whiteboard with the topic
  const board = canvasTexture(1024, 300);
  const boardFace = new THREE.MeshBasicMaterial({ map: board.tex, transparent: true });
  noOutline(boardFace);
  const frame = mesh(new THREE.BoxGeometry(2.7, 0.83, 0.05), toon('#b9bfd3'), 0.35, 1.8, -1.88);
  room.add(frame);
  room.add(mesh(new THREE.PlaneGeometry(2.6, 0.76), boardFace, 0.35, 1.8, -1.85));
  // a window on the back wall, a plant in the corner, a clock
  room.add(mesh(new THREE.BoxGeometry(0.95, 0.8, 0.05), toon('#9fb0c8'), -2.1, 1.7, -1.88));
  room.add(mesh(new THREE.PlaneGeometry(0.85, 0.7), glow('#bfe6ff'), -2.1, 1.7, -1.85));
  room.add(mesh(new THREE.CylinderGeometry(0.17, 0.13, 0.32, 16), toon('#c96f4a'), 2.65, 0.16, -1.55));
  for (const [x, y, z, s] of [[2.65, 0.55, -1.55, 0.26], [2.55, 0.75, -1.5, 0.18], [2.75, 0.72, -1.62, 0.17]]) room.add(mesh(new THREE.SphereGeometry(s, 14, 10), toon('#4caf6e'), x, y, z));
  const clock = mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.04, 24), toon('#ffffff'), 2.2, 2.0, -1.88);
  clock.rotation.x = Math.PI / 2;
  room.add(clock);
  // the table: an oval top on a pedestal
  const top = mesh(new THREE.CylinderGeometry(1, 1, 0.07, 48), toon('#f0c48c'), TABLE.x, TABLE.h, TABLE.z);
  top.scale.set(TABLE.rx, 1, TABLE.rz);
  room.add(top);
  room.add(mesh(new THREE.CylinderGeometry(0.12, 0.16, TABLE.h, 16), toon('#c98f58'), TABLE.x, TABLE.h / 2, TABLE.z));
  const foot = mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.04, 24), toon('#c98f58'), TABLE.x, 0.02, TABLE.z);
  room.add(foot);
  // on the table: a laptop, a coffee pot, notepads
  room.add(mesh(new THREE.BoxGeometry(0.34, 0.02, 0.24), toon('#3a4060'), 0.15, TABLE.h + 0.045, TABLE.z + 0.22));
  room.add(mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.2, 14), toon('#e5484d'), -0.35, TABLE.h + 0.135, TABLE.z + 0.05));
  for (const [x, z] of [[-0.1, -0.15], [0.45, -0.1]]) room.add(mesh(new THREE.BoxGeometry(0.16, 0.012, 0.21), toon('#fff2a8'), x, TABLE.h + 0.04, TABLE.z + z));
  return { room, board };
}

// a rolling office chair, its seat (the swivel) where the robot sits
function buildChair() {
  const chair = new THREE.Group();
  const dark = toon('#3a4060');
  const seatMat = toon('#4b5272');
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leg = mesh(new THREE.BoxGeometry(0.05, 0.04, 0.3), dark, Math.sin(a) * 0.15, 0.07, Math.cos(a) * 0.15);
    leg.rotation.y = a;
    chair.add(leg);
    chair.add(mesh(new THREE.SphereGeometry(0.04, 8, 6), toon('#1d2235'), Math.sin(a) * 0.3, 0.04, Math.cos(a) * 0.3));
  }
  chair.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.36, 10), dark, 0, 0.27, 0));
  const swivel = new THREE.Group();
  swivel.position.y = SEAT_Y;
  swivel.add(mesh(new THREE.BoxGeometry(0.62, 0.1, 0.58), seatMat, 0, 0.04, 0));
  swivel.add(mesh(new THREE.BoxGeometry(0.06, 0.4, 0.04), dark, 0, 0.26, -0.27));
  swivel.add(mesh(new THREE.BoxGeometry(0.58, 0.58, 0.09), seatMat, 0, 0.6, -0.3));
  chair.add(swivel);
  // a soft shadow under it (instead of a shadow map)
  const blob = mesh(new THREE.CircleGeometry(0.42, 24), noOutline(new THREE.MeshBasicMaterial({ color: '#1d2235', transparent: true, opacity: 0.18, depthWrite: false })), 0, 0.012, 0);
  blob.rotation.x = -Math.PI / 2;
  chair.add(blob);
  return { chair, swivel };
}

// where the n chairs go: an arc round the back of the table, facing it (and so you)
function seats(n: number) {
  const spread = n <= 1 ? 0 : Math.min(1.45, 0.42 * (n - 1));
  return Array.from({ length: n }, (_, i) => {
    const a = n <= 1 ? 0 : -spread + (2 * spread * i) / (n - 1);
    const pos = new THREE.Vector3(TABLE.x + RING.rx * Math.sin(a), 0, TABLE.z - RING.rz * Math.cos(a));
    return { pos, yaw: Math.atan2(TABLE.x - pos.x, TABLE.z + 0.5 - pos.z) };
  });
}

// ------------------------------------------------------------ the view

function mount(host: HTMLElement, { width, height, onFrame = () => {} }: MeetingOptions): MeetingView {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(width, height);
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);
  const effect = new OutlineEffect(renderer, { defaultThickness: 0.004, defaultColor: [0.11, 0.13, 0.2], defaultAlpha: 1 });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, width / height, 0.1, 40);
  function frameCamera(w: number, h: number) {
    camera.aspect = w / h;
    // the whole room across, whatever the window's shape
    const across = 6.4;
    const dist = across / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / camera.aspect;
    const dir = new THREE.Vector3(0, 0.5, 1).normalize();
    const target = new THREE.Vector3(0, 0.85, -0.25);
    camera.position.copy(target).addScaledVector(dir, Math.max(5.5, dist));
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  }
  frameCamera(width, height);
  scene.add(new THREE.HemisphereLight('#ffffff', '#b9a7ff', 1.25));
  const sun = new THREE.DirectionalLight('#fff4e0', 1.5);
  sun.position.set(2.5, 4.5, 3);
  scene.add(sun);

  const { room, board } = buildRoom();
  scene.add(room);
  let topicText = '';

  const people = new Map<string, Person>(); // id -> { robot, chair, swivel, home, homeYaw, arriveAt, mode, cur, face }
  let order: string[] = [];
  let focusId: string | null = null;
  const clock0 = performance.now();
  const now = () => (performance.now() - clock0) / 1000;

  function seat(list: MeetingSeat[]) {
    const fresh = list.filter((p) => !people.has(p.id));
    for (const id of [...people.keys()]) if (!list.some((p) => p.id === id)) leave(id);
    order = list.map((p) => p.id);
    const spots = seats(order.length);
    let k = 0;
    for (const p of list) {
      const spot = spots[order.indexOf(p.id)];
      let me = people.get(p.id);
      if (!me) {
        const robot = buildKit(p.kit || {}, { color: p.color || '#5ac8fa', name: p.name || '' });
        robot.setAccessory(p.acc || 'none');
        robot.setTheme?.(themeOf(p.theme));
        robot.antennaBall.color.set(robot.light || '#ff5e62');
        robot.chest.material.color.copy(robot.antennaBall.color);
        const { chair, swivel } = buildChair();
        robot.root.position.set(0, 0.09, 0.04);
        robot.root.scale.setScalar(ROBOT_SCALE);
        swivel.add(robot.root);
        chair.visible = false;
        scene.add(chair);
        // (arriveAt, home and homeYaw: set just below)
        me = { robot, chair, swivel, mode: 'idle', cur: { yaw: 0, lean: 0, head: [0, 0, 0], armL: [...POSES.idle.armL], armR: [...POSES.idle.armR] }, face: '', blinkAt: 2 + Math.random() * 3 } as Person;
        me.arriveAt = now() + ARRIVE.first + ARRIVE.gap * k++;
        people.set(p.id, me);
      }
      me.home = spot.pos;
      me.homeYaw = spot.yaw;
    }
    return fresh.length;
  }
  function leave(id: string) {
    const me = people.get(id);
    if (!me) return;
    me.chair.removeFromParent();
    people.delete(id);
  }

  let lastFrame = 0;
  let last = performance.now();
  let raf = 0;
  function frame(nowMs: number) {
    raf = requestAnimationFrame(frame);
    if (document.hidden) return;
    const t = now();
    let lively = false;
    for (const me of people.values()) {
      if (t < me.arriveAt + ARRIVE.glide + 0.3) lively = true;
      if (me.mode === 'talking' || me.moving) lively = true;
    }
    const fps = lively ? 30 : 8;
    if (nowMs - lastFrame < 1000 / fps - 2) return;
    lastFrame = nowMs;
    const dt = Math.max(0, Math.min(0.1, (nowMs - last) / 1000));
    last = nowMs;
    const focus = focusId && people.get(focusId);
    for (const me of people.values()) tick(me, t, dt, focus);
    effect.render(scene, camera);
    onFrame();
  }

  function tick(me: Person, t: number, dt: number, focus: Person | '' | null | undefined) {
    const { robot, chair } = me;
    // rolling in from the door
    const p = (t - me.arriveAt) / ARRIVE.glide;
    chair.visible = p >= 0;
    if (p < 0) return;
    const s = smooth(p);
    const from = DOOR;
    // (bowing out towards the back wall, round the table)
    chair.position.set(mix(from.x, me.home.x, s), 0, mix(from.z, me.home.z, s) - Math.sin(Math.PI * Math.min(1, s)) * 0.45);
    // facing where it rolls, then round to the table; then to whoever's talking
    let want = me.homeYaw;
    if (focus && focus !== me && focus.home) want = mix(me.homeYaw, Math.atan2(focus.home.x - me.home.x, focus.home.z - me.home.z), 0.65);
    if (p < 1) want = mix(Math.atan2(me.home.x - from.x, me.home.z - from.z), me.homeYaw, smooth((p - 0.55) / 0.45));
    const turn = wrap(want - me.cur.yaw);
    me.cur.yaw += turn * ease(dt, p < 1 ? 12 : 5);
    me.moving = Math.abs(turn) > 0.02;
    chair.rotation.y = me.cur.yaw;
    // its pose and face for what it's doing
    const mood = MOODS[me.mode] || MOODS.idle;
    const target = POSES[mood.pose] || POSES.idle;
    const kp = ease(dt, 8);
    me.cur.lean = mix(me.cur.lean, target.lean, kp);
    for (let i = 0; i < 3; i++) {
      me.cur.head[i] = mix(me.cur.head[i], target.head[i], kp);
      me.cur.armL[i] = mix(me.cur.armL[i], target.armL[i], kp);
      me.cur.armR[i] = mix(me.cur.armR[i], target.armR[i], kp);
    }
    const armL = [...me.cur.armL];
    const armR = [...me.cur.armR];
    if (me.mode === 'talking') {
      // talking with its hands
      armR[0] += Math.sin(t * 5.2) * 0.22;
      armR[2] += Math.sin(t * 6.1 + 1) * 0.25;
      armL[0] += Math.sin(t * 4.3 + 2) * 0.12;
    } else if (me.mode === 'summary') armL[2] += Math.sin(t * 14) * 0.12; // (writing)
    for (const [arm, a] of [[robot.arms.armL, armL], [robot.arms.armR, armR]] as const) {
      arm.shoulder.rotation.set(a[0], 0, a[1] * arm.side);
      arm.elbow.rotation.x = a[2];
    }
    robot.head.rotation.set(me.cur.head[0], me.cur.head[1], me.cur.head[2]);
    robot.torso.rotation.x = me.cur.lean + Math.sin(t * 2.2 + me.arriveAt) * 0.01;
    robot.antenna.rotation.z = me.mode === 'typing' ? Math.sin(t * 12) * 0.3 : Math.sin(t * 2) * 0.05;
    robot.root.position.y = 0.09 + (me.mode === 'agree' ? Math.abs(Math.sin(t * 7)) * 0.03 : 0);
    // the face: drawn again only when it changes (a talking mouth moves by itself)
    if (t > me.blinkAt) {
      me.blinkUntil = t + 0.14;
      me.blinkAt = t + 2.5 + Math.random() * 4;
    }
    const blink = t < (me.blinkUntil || 0) ? 1 : 0;
    const f = { eyes: mood.eyes, mouth: mood.mouth, lookX: 0, lookY: 0, blink, blush: false, asleep: false, t };
    const key = mood.mouth === 'talk' ? '' : `${f.eyes}|${f.mouth}|${blink}`;
    if (!key || key !== me.face) {
      me.face = key;
      robot.drawFace(robot.face.ctx, f);
      robot.face.tex.needsUpdate = true;
    }
  }
  raf = requestAnimationFrame(frame);

  const V = new THREE.Vector3();
  return {
    seat,
    topic(text: string) {
      if (text === topicText) return;
      topicText = text;
      whiteboardText(board.ctx, board.canvas.width, board.canvas.height, text);
      board.tex.needsUpdate = true;
    },
    act(id: string, mode: string) {
      const me = people.get(id);
      if (me) me.mode = MOODS[mode] ? mode : 'idle';
    },
    focus(id: string | null | undefined) {
      focusId = id || null;
    },
    /** Where its head is on the page (CSS px), or null while it isn't in the room yet. */
    headAt(id: string) {
      const me = people.get(id);
      if (!me || !me.chair.visible) return null;
      V.set(0, (me.robot.headTop ?? 0.6) + 0.12, 0);
      me.robot.head.localToWorld(V);
      V.project(camera);
      return { x: ((V.x + 1) / 2) * width, y: ((1 - V.y) / 2) * height };
    },
    resize(w: number, h: number) {
      width = w;
      height = h;
      renderer.setSize(w, h);
      frameCamera(w, h);
    },
    dispose() {
      cancelAnimationFrame(raf);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

export const Meeting3D: { mount(host: HTMLElement, opts: MeetingOptions): MeetingView } = { mount };
