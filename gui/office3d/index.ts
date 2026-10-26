import * as THREE from 'three';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';
import { buildOffice, LAYOUT } from './scene';
import { themeOf } from './themes';
import { POSES } from './robot3d';
import { buildKit } from './kit3d';
import { buildHammer, HAMMER } from './hammer';
import { createMinis } from './minibots';
import { buildBattery } from './battery';
import { drawScreen, SCREEN_LIGHT } from './screens';
import { spriteTexture, badgeTexture } from './materials';
import { buildBoard } from './board';
import { buildProps } from './props';
import { buildPaperPlane } from './plane3d';
import { createAntics, wearTick } from './antics/index';
import { createBed } from './bed';
import { createWalker, frameSolo, AWAY_TURN } from './walker3d';
import type { SoloView } from './walker3d';
import type { Board, BoardHit, BoardNote, OfficeSet, Rig, StickyItem } from './types';
import type { AnticPose, ParticleKind, ParticleOpts, Vec3Tuple, WearCtx } from './antics/types';

// The 3D workstation is a pure "view" of the robot's state. It reads what the page
// already tracks on every frame:
//   stateEl.dataset  screen, pose, eyes, mouth, acc, name, kit (the robot's parts: JSON, see kit3d.js),
//                    vocabCount (English words collected: the word box on the desk),
//                    vocabStickies (JSON [{ id, text, sub }]: words on sticky notes on the monitor),
//                    stickyHover (the id of the word note under the mouse: it zooms up),
//                    helpers (how many helper agents are at work: little bots circle the desk),
//                    theme (the desk, screen and badge style: classic | sioux),
//                    antic, anticSeq, anticText, nightcap (idle antics: see antics/index.js)
//   stateEl classes  one-shot reactions: hop, squish, shake, spin, blink, blush, idea, bonk, helper-step
//   moodEl classes   awake / asleep / thinking / talking / dragging / typing
//   CSS variables    --paint, --look-x, --look-y, --swing
// so the robot window and the Workshop preview can drive it without knowing about 3D.
//
// Out for a walk (the "wanders off" feature):
//   data-away '1'    it's out: the chair is empty, the monitor says BRB, no antics
//                    (antics/walk.js has it step out of, and back into, the chair)
//   mount(..., { solo: true })  the character alone, out on the user's desktop (walker3d.js);
//                    it reads body, glb, glbTurn, acc, name, theme, eyes, mouth, nightcap,
//                    lateNight, --paint as the desk does, plus
//     data-gait      stand | walk | sleepwalk | wave | look | sit | dangle | land
//     data-heading   left | right | toward | away
//     data-speed     walking pace (1 = about two steps a second)

export type Office3DOptions = {
  stateEl: HTMLElement; // its dataset, classes and --paint: what to show (see above)
  moodEl: HTMLElement; // its classes: awake / asleep / thinking / talking / dragging / typing
  width: number;
  height: number;
  solo?: boolean; // the character alone, out for a walk (walker3d.js)
};
/** Something you can click round the desk (propAt), nearest first. */
export type PropHit = BoardHit | { kind: 'hammer' } | { kind: 'plug' };
/** What mount() gives back. Points are CSS px. */
export type Office3DView = {
  setScale(k: number): void;
  resize(w: number, h: number): void;
  stickyAt(clientX: number, clientY: number): { kind: string; id: string } | null;
  propAt(clientX: number, clientY: number): PropHit | null;
  boardAt(clientX: number, clientY: number): BoardHit | null;
  hitsMonitor(clientX: number, clientY: number): boolean;
  floorAt(clientX: number, clientY: number): { x: number; z: number } | null;
  feetPosition(): { x: number; y: number };
  headPosition(): { x: number; y: number };
  dispose(): void;
};

/** A particle in flight (emit). */
type Particle = { s: THREE.Sprite; life: number; age: number; vel: THREE.Vector3; size: number; grow: number; spin: number; gravity: number };
// (three's types leave the isMesh flag off Object3D; any material may have a picture, a map)
type Mapped = THREE.Material & { map?: THREE.Texture | null };
const isMesh = (o: THREE.Object3D): o is THREE.Mesh<THREE.BufferGeometry, Mapped | Mapped[]> => 'isMesh' in o;

const ROBOT_SCALE = 0.82;
// (charge: the plug by the desk; highfive, dance: by itself now and then)
const REACTIONS = ['hop', 'squish', 'shake', 'spin', 'idea', 'chomp', 'bonk', 'helper-step', 'charge', 'highfive', 'dance'];
// the squeaky-hammer bonk, in seconds: pops in, winds up, strikes, rebounds, shrinks away
// (the hit time is mirrored by BONK_HIT_MS in robot.js, which lands the sound and reaction)
const BONK = { appear: 0.18, windup: 0.34, hit: 0.42, leave: 0.72, end: 1.02, scale: 0.8 };
const NIGHT_GLOW = new THREE.Color('#7fb2ff');
const STILL_SCREENS = new Set(['off', 'error']); // monitor scenes that don't move (screens.js)
const MOVING_MOUTHS = new Set(['talk', 'wide', 'chomp']); // mouths that move by themselves (face.js, kitface.js)
const easeOutBack = (p: number) => 1 + 2.4 * (p - 1) ** 3 + 1.4 * (p - 1) ** 2;
const isUnder = (o: THREE.Object3D | null, root: THREE.Object3D) => {
  for (; o; o = o.parent) if (o === root) return true;
  return false;
};
const CAMERA = { target: new THREE.Vector3(-0.38, 0.7, -0.7), dir: new THREE.Vector3(0.62, 0.5, 0.8), distance: 5.95, fov: 27 };
// Out walking (solo) it's drawn just as big as at its desk, seen from the same height: the
// desk window is DESK_H CSS px tall (robot.js ROBOT_H), and this is how many of them a world
// unit takes up where it stands up from its chair (antics/walk.js).
const DESK_H = 290;
function soloView(height: number): SoloView {
  const eye = CAMERA.target.clone().addScaledVector(CAMERA.dir.clone().normalize(), CAMERA.distance);
  const spot = new THREE.Vector3(LAYOUT.chair.x, 0, LAYOUT.chair.z);
  spot.addScaledVector(new THREE.Vector3(eye.x - spot.x, 0, eye.z - spot.z).normalize(), 0.32).setY(0.55);
  // (+3%: by the time the walker takes over it has stepped a little nearer the camera; measured)
  const pxPerUnit = (1.03 * DESK_H) / (2 * eye.distanceTo(spot) * Math.tan(THREE.MathUtils.degToRad(CAMERA.fov / 2)));
  const pitch = Math.asin(CAMERA.dir.y / CAMERA.dir.length());
  return { height, pxPerUnit, fov: CAMERA.fov, pitch };
}

// (Some parts are only at the desk (set, antics, bed, the toys) and the walker only out walking
// (solo): they're null otherwise, and the uses marked `!` below are on their own side of that.)
function mount(host: HTMLElement, { stateEl, moodEl, width, height, solo = false }: Office3DOptions): Office3DView {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false; // (the frame loop says when: frame())
  host.appendChild(renderer.domElement);
  const effect = new OutlineEffect(renderer, { defaultThickness: 0.004, defaultColor: [0.11, 0.13, 0.2], defaultAlpha: 1 });

  const scene = new THREE.Scene();
  const world = new THREE.Group();
  scene.add(world);

  const camera = new THREE.PerspectiveCamera(CAMERA.fov, width / height, 0.1, 50);
  if (solo) frameSolo(camera, soloView(height));
  else {
    camera.position.copy(CAMERA.target).addScaledVector(CAMERA.dir.clone().normalize(), CAMERA.distance);
    camera.lookAt(CAMERA.target);
  }

  // ---- lights
  const hemi = new THREE.HemisphereLight('#ffffff', '#b9a7ff', 1.2);
  const sun = new THREE.DirectionalLight('#fff4e0', 1.6);
  sun.position.set(2.5, 4.5, 2.2);
  sun.castShadow = !solo; // out walking, a soft blob under its feet does instead (walker3d.js)
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -2.4;
  sun.shadow.camera.right = sun.shadow.camera.top = 2.4;
  sun.shadow.bias = -0.0008;
  sun.shadow.radius = 4;
  scene.add(hemi, sun);

  // ---- set + actor
  let theme = themeOf('classic');
  let themeKey = 'classic';
  // (solo: no desk, just the character on an invisible ground)
  let set = solo ? null : buildOffice(theme);
  if (set) world.add(set.office);
  // ---- the corkboard with your notes, on the desk's left end (board.js; robot.js: data-board),
  // standing on the desk top so it rises with the standing desk; set.board for the antics
  let board: Board | null = null;
  let boardKey: string | null = null; // the notes it shows, as drawn (data-board, JSON)
  function addBoard() {
    if (!set) return;
    board = buildBoard(theme);
    (set.desk?.top || set.office).add(board.group);
    set.board = board;
    boardKey = null; // (pin them up again)
    // the squeaky hammer and the charger's power strip by the desk: click them to play (props.js)
    props = buildProps(theme);
    set.office.add(props.hammer, props.floor);
  }
  let props: ReturnType<typeof buildProps> | null = null;
  addBoard();
  // a new theme: rebuild the workstation around the robot
  function dress(key: string) {
    themeKey = key;
    theme = themeOf(key);
    paint = ''; // repaint the badge
    if (solo) return robot?.setTheme?.(theme);
    world.remove(set!.office);
    const old = set!;
    set = buildOffice(theme);
    world.add(set.office);
    board?.dispose();
    props?.dispose();
    addBoard();
    if (robot) {
      old.swivel.remove(robot.root);
      set.swivel.add(robot.root);
      set.swivel.rotation.y = old.swivel.rotation.y;
      robot.setTheme?.(theme);
    }
  }
  let robot!: Rig; // (seated just below, before anything else reads it)
  let body!: string;
  // the robot, built from its parts (kit3d.js); key: what it's built from, so a change rebuilds it
  function seat(kind: string, build: (o: { color: string; name: string }) => Rig) {
    if (robot) robot.root.removeFromParent(); // off the chair, or off the floor if it was asleep there
    body = kind;
    robot = build({ color: paint || '#5ac8fa', name: name || '' });
    robot.root.position.set(0, 0.09, 0.04);
    robot.root.scale.setScalar(ROBOT_SCALE);
    (solo ? walker!.stage : set!.swivel).add(robot.root);
    robot.setTheme?.(theme);
    // re-apply what the old body was wearing
    acc = null;
    paint = '';
  }
  // the desk's toys (not out walking)
  // (hitFor: the bonk it last landed, see below)
  const toy: (ReturnType<typeof buildHammer> & { hitFor?: number }) | null = solo ? null : buildHammer();
  if (toy) world.add(toy.hammer);
  const minis = solo ? null : createMinis(world);
  const charger = solo ? null : buildBattery();
  if (charger) world.add(charger.battery);
  // (burstFor, fiveFor: the charge and the high-five they were for, as in react)
  const play: { nextBolt: number; nextNote: number; burstFor: number | null | undefined; fiveFor: number | null | undefined } = { nextBolt: 0, nextNote: 0, burstFor: null, fiveFor: null };

  // ---- particles
  const particles: Particle[] = [];
  const textures = Object.fromEntries(['steam', 'z', 'heart', 'sweat', 'bulb', 'question', 'doc', 'crumb', 'star', 'squeak', 'note', 'ball', 'bolt', 'haha'].map((k) => [k, spriteTexture(k)]));
  function emit(kind: ParticleKind, pos: THREE.Vector3, { life = 1.2, vel = new THREE.Vector3(0, 0.4, 0), size = 0.14, grow = 1, spin = 0, gravity = 0 }: ParticleOpts = {}) {
    const mat = new THREE.SpriteMaterial({ map: textures[kind], transparent: true, depthWrite: false });
    mat.userData.outlineParameters = { visible: false };
    const s = new THREE.Sprite(mat);
    s.position.copy(pos);
    s.scale.setScalar(size);
    world.add(s);
    particles.push({ s, life, age: 0, vel, size, grow, spin, gravity });
  }
  const worldPoint = (obj: THREE.Object3D, x: number, y: number, z: number) => {
    const v = new THREE.Vector3(x, y, z);
    obj.localToWorld(v);
    return world.worldToLocal(v);
  };
  const walker = solo ? createWalker({ world, emit, worldPoint, scale: ROBOT_SCALE }) : null;

  // ---- chair directions
  const chairPos = LAYOUT.chair;
  const yawTo = (p: { x: number; z: number }) => Math.atan2(p.x - chairPos.x, p.z - chairPos.z);
  const camYaw = yawTo(camera.position);
  const monitorYaw = yawTo(LAYOUT.monitor) + 0.12;
  const thinkYaw = (camYaw + monitorYaw) / 2;
  const YAW: Partial<Record<string, number>> = { idle: camYaw, talking: camYaw, cheer: camYaw, wave: camYaw, eager: camYaw, raise: camYaw, sleep: camYaw - 0.3, slack: camYaw - 0.15, typing: monitorYaw, reading: monitorYaw, thinking: thinkYaw };
  // out for a walk: the empty chair, pushed back from the desk and turned a little towards you
  const awayYaw = monitorYaw + (camYaw - monitorYaw) * AWAY_TURN;

  const antics = solo ? null : createAntics({ world, emit, worldPoint, camYaw, monitorYaw });
  // asleep: in the chair with an eye mask, or curled up on the floor under a blanket
  const bed = solo ? null : createBed({ emit });
  const bedBubble = new THREE.Vector3();
  const bubbleAt = () => (bed!.bubbleAt(set!, bedBubble) ? world.worldToLocal(set!.office.localToWorld(bedBubble)) : null); // (the antics', at the desk)

  // ---- animated state
  const cur: { yaw: number; lean: number; head: Vec3Tuple; armL: Vec3Tuple; armR: Vec3Tuple } = { yaw: camYaw, lean: 0, head: [0, 0, 0], armL: [...POSES.idle.armL], armR: [...POSES.idle.armR] };
  const react: Partial<Record<string, number>> = {}; // reaction name -> start time
  const seen = new Set<string>();
  let screen: string | null = null;
  let screenStart = 0;
  const screenDrawn: { set: OfficeSet | null; key: string; at: number } = { set: null, key: '', at: 0 }; // what the monitor's canvas shows, and when it was drawn
  let paint = '';
  let acc: string | null | undefined = null;
  let name: string | null | undefined = null;
  seat('kit:{}', (o) => buildKit({}, { ...o, standing: solo }));
  let lights = 1;
  let night = 0; // 0..1, up past 10 pm (data-late-night)
  let shownWords = -1; // the word box shows this many (and wordsSet is the desk it's on)
  let wordsSet: OfficeSet | null = null;
  let shownStickies = '';
  let deskPlane: ReturnType<typeof buildPaperPlane> | null = null; // a paper plane that landed on the desk (data-desk-plane)
  let shownVisit = ''; // the visitor's sticky (data-visit-notes), and the desk it's on
  let visitSet: OfficeSet | null = null;
  let stickiesMoving = false; // a sticky note zooming up or back (scene.js stickies.update)
  let nextZ = 0;
  let nextSparkle = 0; // (the housemaid dusting the desk: data-tidy)
  let nextSteam = 0;
  let nextSweat = 0;
  let nextBrainSteam = 0;
  let nextQuestion = 0;
  let last = performance.now();
  let lastFrame = 0;
  let shadowAt = -Infinity; // when the shadow map was last redrawn
  let raf = 0;
  const clock0 = performance.now();

  const ease = (dt: number, rate: number) => 1 - Math.exp(-dt * rate);
  const mix = (a: number, b: number, k: number) => a + (b - a) * k;
  const cssNum = (name: string) => parseFloat(document.documentElement.style.getPropertyValue(name)) || 0;

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const awake = moodEl.classList.contains('awake');
    const dragging = moodEl.classList.contains('dragging');
    const scr = stateEl.dataset.screen || 'off';
    const working = scr !== 'off';
    // full frame rate only while something is really moving; idle and asleep tick slower
    const lively = solo
      ? walker!.lively || dragging || particles.length > 0
      : dragging || (working && scr !== 'idle') || moodEl.classList.contains('thinking') || Number(stateEl.dataset.helpers) > 0 || antics!.active || !!stateEl.dataset.propHover || !!stateEl.dataset.stickyHover || stickiesMoving || stateEl.dataset.tidy === '1' || REACTIONS.some((r) => stateEl.classList.contains(r));
    // (its robot's in the group chat's meeting room: the empty desk needs only the odd frame)
    const fps = stateEl.dataset.meeting === '1' && !dragging ? 2 : lively ? 30 : awake ? 12 : 6;
    if ((document.hidden && !solo) || now - lastFrame < 1000 / fps - 2) return; // (a walker draws while still hidden, to take over seamlessly)
    lastFrame = now;
    // the shadows follow every frame while something moves; sitting or sleeping, twice a second
    // is plenty (they're the costliest part of a frame)
    if (lively || now - shadowAt > 500) {
      renderer.shadowMap.needsUpdate = true;
      shadowAt = now;
    }
    // rAF timestamps can trail performance.now() on the first frame; never step backwards
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = Math.max(last, now);
    const t = (now - clock0) / 1000;

    // ---- read the page state
    const d = stateEl.dataset;
    const pose = d.pose || 'idle';
    const target = POSES[pose] || POSES.idle;
    const thinking = moodEl.classList.contains('thinking');
    if (d.screen !== screen) {
      screen = d.screen || 'off';
      screenStart = t;
    }
    if ((d.theme || 'classic') !== themeKey) dress(d.theme || 'classic');
    // (its parts are in data-kit; any change rebuilds it)
    const want = `kit:${d.kit || '{}'}`;
    if (want !== body) {
      seat(want, (o) => buildKit(d.kit, { ...o, standing: solo }));
    }
    if (d.acc !== acc) {
      acc = d.acc;
      robot.setAccessory(acc || 'none');
    }
    // (every frame at first, so a walker taking over from the desk is never the default colour)
    const n = (frame.n = (frame.n || 0) + 1);
    if (n < 30 || n % 15 === 1) {
      const p = getComputedStyle(stateEl).getPropertyValue('--paint').trim() || '#5ac8fa';
      if (p !== paint || d.name !== name) {
        paint = p;
        name = d.name;
        robot.setColor(paint);
        const b = badgeTexture(name, paint, theme);
        robot.torso.traverse((o) => {
          if (isMesh(o) && Array.isArray(o.material) && o.material[4]?.map) {
            o.material[4].map = b.tex;
            o.material[4].needsUpdate = true;
          }
        });
      }
    }
    for (const r of REACTIONS) {
      const on = stateEl.classList.contains(r);
      if (on && !seen.has(r)) react[r] = t;
      if (on) seen.add(r);
      else seen.delete(r);
    }
    if (solo) return soloFrame(t, dt, d, awake);
    if (!set || !antics || !bed || !toy || !charger || !minis) return; // (never: at the desk they're all there)
    // out for a walk: nobody's in the chair
    const gone = d.away === '1';
    if (gone !== frame.gone) {
      frame.gone = gone;
      frame.goneAt = t;
    }
    // (nothing reacts to pokes while it's out)
    const since = (r: string) => (gone || react[r] === undefined ? Infinity : t - react[r]);

    // ---- chair swivel target (+ a full spin for the "spin" reaction)
    const k = ease(dt, 5);
    // (the Workshop's preview: data-facing 'camera' keeps it facing you; a number turns it that
    // far round from there, in radians, as you drag it, quickly)
    const turned = d.facing === 'camera' ? 0 : parseFloat(d.facing ?? '');
    const facing = Number.isFinite(turned) ? camYaw + turned : null;
    // (the short way round to where it's turned)
    const toward = facing === null ? null : cur.yaw + Math.atan2(Math.sin(facing - cur.yaw), Math.cos(facing - cur.yaw));
    cur.yaw = gone ? awayYaw : mix(cur.yaw, toward ?? YAW[pose] ?? camYaw, d.facingDrag ? ease(dt, 18) : k);
    // (turned round, the chair's back would hide the robot's: it goes while you look)
    if (facing !== null && !solo) {
      const away = Math.abs(Math.atan2(Math.sin(cur.yaw - camYaw), Math.cos(cur.yaw - camYaw)));
      for (const o of set.swivel.children) if (o !== robot.root) o.visible = away < 1.25;
    }
    const sSpin = since('spin');
    const spinExtra = sSpin < 0.9 ? Math.PI * 2 * (1 - (1 - sSpin / 0.9) ** 3) : 0;

    // ---- body pose
    const kp = ease(dt, 7);
    cur.lean = mix(cur.lean, target.lean, kp);
    for (let i = 0; i < 3; i++) {
      cur.head[i] = mix(cur.head[i], target.head[i], kp);
      cur.armL[i] = mix(cur.armL[i], target.armL[i], kp);
      cur.armR[i] = mix(cur.armR[i], target.armR[i], kp);
    }
    const armL: Vec3Tuple = [...cur.armL];
    const armR: Vec3Tuple = [...cur.armR];
    if (pose === 'typing') {
      const f = d.hurry === '1' ? 36 : 22; // bonked into a hurry: frantic typing
      armL[0] += Math.sin(t * f) * 0.07;
      armR[0] += Math.sin(t * f + Math.PI) * 0.07;
      armL[2] += Math.sin(t * f + 1) * 0.12;
      armR[2] += Math.sin(t * f + 1 + Math.PI) * 0.12;
    } else if (pose === 'talking') {
      armL[2] += Math.sin(t * 3.2) * 0.35;
      armR[2] += Math.sin(t * 2.6 + 1.5) * 0.35;
      armR[1] += Math.sin(t * 2.6) * 0.1;
    } else if (pose === 'cheer') {
      armL[1] += Math.sin(t * 14) * 0.18;
      armR[1] += Math.sin(t * 14) * 0.18;
    } else if (pose === 'wave') {
      armR[1] += Math.sin(t * 11) * 0.3;
      armR[2] += Math.sin(t * 11) * 0.3;
    } else if (pose === 'raise') {
      // "ooh, ooh, pick me!" wiggle
      armR[1] += Math.sin(t * 9) * 0.12;
      armR[0] += Math.sin(t * 4.5) * 0.06;
    } else if (pose === 'thinking') {
      armR[2] += Math.sin(t * 4) * 0.08;
    }
    // dancing: the chair sways
    const sDance = since('dance');
    const dancing = sDance < 4.2;
    const danceSway = dancing ? Math.sin(sDance * Math.PI * 2) * 0.45 : 0;
    // idle antics (sipping coffee, snot bubbles…) play on top of the pose
    const A: AnticPose = { lean: cur.lean, head: [...cur.head], armL, armR, yaw: 0, tip: 0, rootY: 0, rootZ: 0, mug: new THREE.Vector3(), mugTilt: 0, lamp: 1, screen: null, screenDim: 0, shake: 0, reachL: 1, reachR: 1, antenna: 0, boardLift: 0 };
    antics.update({ t, dt, d, pose, robot, set, curYaw: cur.yaw, A, bubbleAt, bed, away: gone });
    set.swivel.rotation.order = 'YXZ';
    set.swivel.rotation.y = cur.yaw + spinExtra + A.yaw + danceSway;
    set.swivel.rotation.x = -A.tip;
    set.mug.position.copy(antics.mugHome).add(A.mug);
    set.mug.rotation.z = A.mugTilt;
    for (const [arm, a] of [[robot.arms.armL, armL], [robot.arms.armR, armR]] as const) {
      arm.shoulder.rotation.set(a[0], 0, a[1] * arm.side);
      arm.elbow.rotation.x = a[2];
    }
    // cartoon stretch: the raised arm grows so the hand gets above the head
    const stretch = robot.arms.armR.shoulder.scale;
    // (and both stretch a little to get the hands behind the head when it slacks off)
    const slackReach = pose === 'slack' ? 1.4 : 1;
    stretch.y = mix(stretch.y, pose === 'raise' ? 1.55 : A.reachR * slackReach, kp);
    robot.arms.armL.shoulder.scale.y = mix(robot.arms.armL.shoulder.scale.y, A.reachL * slackReach, kp);

    // head: follow the cursor when facing you, otherwise the pose decides
    const facingYou = pose === 'idle' || pose === 'slack' || pose === 'talking' || pose === 'wave' || pose === 'cheer' || pose === 'eager' || pose === 'raise';
    const lookX = cssNum('--look-x');
    const lookY = cssNum('--look-y');
    // chewing: the head bobs while the mouth works
    const sChomp = since('chomp');
    const chew = sChomp < 1.3 ? Math.sin(sChomp * 22) * 0.1 * (1 - sChomp / 1.3) : 0;
    robot.head.rotation.set(
      A.head[0] + (facingYou ? lookY * 0.05 : 0) + chew,
      A.head[1] + (facingYou ? lookX * 0.06 : 0),
      A.head[2] + (stateEl.dataset.eyes === 'dizzy' ? Math.sin(t * 7) * 0.15 : 0),
    );
    const breathe = pose === 'sleep' ? Math.sin(t * 1.6) * 0.03 : Math.sin(t * 2.2) * 0.01;
    robot.torso.rotation.x = A.lean + breathe;
    robot.antenna.rotation.z = (thinking ? Math.sin(t * 12) * 0.35 : Math.sin(t * 2) * 0.05) + A.antenna;

    // one-shot reactions
    const sHop = since('hop');
    const hop = sHop < 0.55 ? Math.sin((sHop / 0.55) * Math.PI) * 0.22 : 0;
    const cheerBounce = pose === 'cheer' ? Math.abs(Math.sin(t * 8)) * 0.06 : 0;
    robot.root.position.y = 0.09 + hop + cheerBounce + A.rootY;
    robot.root.position.z = 0.04 + A.rootZ;
    // dancing bobs up and down and rocks
    if (dancing) robot.root.position.y += Math.abs(Math.sin(sDance * Math.PI * 4)) * 0.07;
    robot.root.rotation.z = dancing ? Math.sin(sDance * Math.PI * 2) * 0.1 : 0;
    const sSquish = since('squish');
    const sq = sSquish < 0.5 ? Math.sin((sSquish / 0.5) * Math.PI * 3) * 0.14 * (1 - sSquish / 0.5) : 0;
    robot.root.scale.set(ROBOT_SCALE * (1 + sq), ROBOT_SCALE * (1 - sq), ROBOT_SCALE * (1 + sq));
    // asleep on the floor: off the chair and curled up under a blanket (wins over the seat position)
    bed.update({ t, dt, pose, d, robot, body, set, camYaw, away: gone });
    const hidden = gone; // out for a walk: nothing of it here (no z's, sweat, helper bots…)
    robot.root.visible = !hidden; // (with whatever it's wearing: mask, nightcap, hood)
    antics.place(); // an antic may take it out of the chair (push-ups on the floor)
    if (sSquish < dt * 1.5) {
      for (let i = 0; i < 3; i++) {
        emit('heart', worldPoint(robot.head, (i - 1) * 0.25, 0.7, 0.1), { life: 1.1, vel: new THREE.Vector3((i - 1) * 0.15, 0.55, 0), size: 0.13 });
      }
    }
    const sShake = since('shake');
    world.position.x = (sShake < 0.5 ? Math.sin(sShake * 70) * 0.05 * (1 - sShake / 0.5) : 0) + Math.sin(t * 60) * 0.02 * A.shake;
    // bonk: a squeaky toy hammer swings in from the side and bonks the robot on the head
    const sBonk = since('bonk');
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
      toy.hammer.position.copy(top).addScaledVector(right, HAMMER.reach * BONK.scale).addScaledVector(up, HAMMER.faceDrop * BONK.scale);
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
          emit('star', top, { life: 0.9, vel: new THREE.Vector3(Math.cos(a) * 0.75, Math.sin(a) * 0.55, 0), size: 0.13, gravity: 0.8, spin: 5 });
        }
        emit('squeak', top.clone().addScaledVector(up, 0.25).addScaledVector(right, -0.35), { life: 0.9, vel: new THREE.Vector3(0, 0.25, 0), size: 0.34, grow: 1.25 });
      }
    } else toy.hammer.visible = false;
    robot.head.scale.set(1 + squash * 0.45, 1 - squash, 1 + squash * 0.45);
    if (dancing) robot.head.rotation.z += Math.sin(sDance * Math.PI * 4) * 0.15; // head bob

    // ---- play (the plug by the desk; a dance or a high-five by itself)
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
        emit('bolt', worldPoint(robot.head, Math.cos(a) * 0.35, 0.3 + Math.random() * 0.3, Math.sin(a) * 0.2), { life: 0.4, vel: new THREE.Vector3(0, 0.2, 0), size: 0.1, spin: 3 });
      }
      if (sCharge >= 1.95 && play.burstFor !== react.charge) {
        play.burstFor = react.charge; // full!
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          emit('bolt', above, { life: 0.7, vel: new THREE.Vector3(Math.cos(a) * 0.8, Math.sin(a) * 0.6 + 0.3, 0), size: 0.12, gravity: 0.6, spin: 4 });
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
        emit('star', hand, { life: 0.7, vel: new THREE.Vector3(Math.cos(a) * 0.7, Math.sin(a) * 0.7, 0), size: 0.1, gravity: 0.5, spin: 5 });
      }
    }
    // dance: music notes
    if (dancing && t > play.nextNote) {
      play.nextNote = t + 0.3;
      emit('note', worldPoint(robot.head, (Math.random() - 0.5) * 0.8, 0.5, 0.1), { life: 1.2, vel: new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.4, 0), size: 0.14, spin: 2 });
    }
    const swing = (cssNum('--swing') * Math.PI) / 180;
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
        emit('crumb', mouth, { life: 0.8, vel: new THREE.Vector3(Math.cos(a) * 0.5, 0.45 + Math.random() * 0.3, Math.sin(a) * 0.5), size: 0.05, gravity: 2.2, spin: 4 });
      }
    }
    if (since('idea') < dt * 1.5) {
      emit('bulb', worldPoint(robot.head, 0.32, 0.85, 0), { life: 1.2, vel: new THREE.Vector3(0, 0.12, 0), size: 0.22 });
    }

    drawFaceNow(d, t, !awake && !working, lookX, lookY);

    // ---- monitor
    // (an antic may borrow it: a screensaver, a dream on the dark screen; out for a walk: a BRB note)
    const shown = gone ? 'brb' : A.screen || screen;
    // redrawn (and sent to the GPU) only when it changes: a still scene once, a moving one
    // at up to 20 fps
    const dim = A.screen && A.screenDim > 0 ? A.screenDim : 0;
    const screenKey = `${shown}|${paint}|${themeKey}|${dim.toFixed(2)}`;
    if (set !== screenDrawn.set || screenKey !== screenDrawn.key || (!STILL_SCREENS.has(shown) && now - screenDrawn.at >= 48)) {
      drawScreen(set.screen.ctx, shown, gone ? t - (frame.goneAt as number) : A.screen ? t - antics.startedAt : t - screenStart, paint || '#5ac8fa', theme); // (goneAt: set as it went)
      if (dim) {
        set.screen.ctx.fillStyle = `rgba(0,0,0,${dim})`;
        set.screen.ctx.fillRect(0, 0, set.screen.canvas.width, set.screen.canvas.height);
      }
      set.screen.tex.needsUpdate = true;
      screenDrawn.set = set;
      screenDrawn.key = screenKey;
      screenDrawn.at = now;
    }
    const glowColor = SCREEN_LIGHT[shown.split(':')[0]] || (A.screen ? '#9fb0ff' : null);
    // (the BRB note glows softly in a dark room, so the desk still reads asleep)
    const glow = glowColor ? 1.4 * (1 - A.screenDim) * (gone ? mix(0.35, 1, lights) : 1) : 0;
    set.screen.light.intensity = mix(set.screen.light.intensity, glow + 1.6 * night, ease(dt, 6));
    if (glowColor) set.screen.light.color.set(glowColor);
    set.screen.led.material.color.set(screen === 'off' ? (Math.sin(t * 2.5) > 0 ? '#ffb347' : '#5a4630') : '#7bed9f');

    // ---- antenna + chest light
    const lightCol = thinking ? new THREE.Color().setHSL((t * 0.8) % 1, 0.85, 0.62) : new THREE.Color(awake || working ? robot.light || theme.robot?.light || '#ff5e62' : '#8a90a6'); // (robot.light: the lights colour of a robot you built)
    robot.antennaBall.color.copy(lightCol);
    robot.chest.material.color.copy(thinking ? new THREE.Color('#4de1ff') : lightCol);

    // ---- the English word box on the desk (robot.js: data-vocab-count), and the words
    // you're learning on sticky notes on the monitor (data-vocab-stickies: JSON [{ id, text, sub }])
    const words = Number(d.vocabCount) || 0;
    const stickyJson = d.vocabStickies || '';
    if (words !== shownWords || set !== wordsSet || stickyJson !== shownStickies) {
      shownWords = words;
      wordsSet = set;
      shownStickies = stickyJson;
      set.wordBox?.setCount(words);
      let notes: StickyItem[] = [];
      try {
        notes = stickyJson ? (JSON.parse(stickyJson) as StickyItem[]) : []; // (robot.js writes it)
      } catch {}
      set.stickies?.set('vocab', notes);
    }
    // a visitor found it asleep: a "came by" sticky on the monitor's other edge (robot.js:
    // data-visit-notes, JSON [{ id, text, sub, color }])
    if ((d.visitNotes || '') !== shownVisit || set !== visitSet) {
      shownVisit = d.visitNotes || '';
      visitSet = set;
      let notes: StickyItem[] = [];
      try {
        notes = shownVisit ? (JSON.parse(shownVisit) as StickyItem[]) : []; // (robot.js writes it)
      } catch {}
      set.stickies?.set('note', notes);
    }
    // a paper plane another robot threw, landed (on top of its monitor, in sight whether it
    // sits or sleeps in the chair or on the floor) while it was busy or asleep
    // (robot.js: data-desk-plane '1'; it picks it up and reads it when it's free)
    const top = set.desk?.top || set.office;
    if (d.deskPlane === '1' && deskPlane?.parent !== top) {
      deskPlane ||= buildPaperPlane();
      deskPlane.position.set(-0.36, 1.83, -1.19);
      deskPlane.rotation.set(0.04, 0.55, 0.12);
      deskPlane.scale.setScalar(1.6);
      top.add(deskPlane);
    } else if (d.deskPlane !== '1' && deskPlane?.parent) deskPlane.removeFromParent();
    // the word note under the mouse pops up bigger (robot.js: data-sticky-hover)
    set.stickies?.hover(d.stickyHover ? 'vocab' : '', d.stickyHover || '');
    stickiesMoving = !!set.stickies?.update(dt);

    // ---- the corkboard: your open notes (data-board: JSON { items, total, hidden }), lit up
    // while the mouse is on it (data-board-hover), held up for a reminder (A.boardLift)
    if (board) {
      const json = d.board || '';
      if (json !== boardKey) {
        boardKey = json;
        let b: { items?: BoardNote[]; total?: number; hidden?: boolean } = { items: [], total: 0 };
        try {
          if (json) b = JSON.parse(json) as typeof b; // (robot.js writes it)
        } catch {}
        board.group.visible = !b.hidden;
        board.setNotes(b.items || [], b.total || 0);
      }
      board.setHover(d.propHover === 'board');
      board.setLift(A.boardLift || 0);
      board.update(t, dt);
    }
    // ---- the hammer and the plug: lit up under the mouse (data-prop-hover), the hammer
    // picked up while it bonks, the plug buzzing while it charges
    if (props) {
      props.setHover(d.propHover);
      props.update(t, dt, { bonking: toy?.hammer.visible, charging: since('charge') < 2.2 });
    }

    // ---- lighting: bright while awake, dimmed and bluish while asleep
    lights = mix(lights, awake || working ? 1 : 0, ease(dt, 3));
    // up past 10 pm: the room goes dim and the monitor's glow lights its face
    night = mix(night, d.lateNight === '1' && awake ? 1 : 0, ease(dt, 2));
    hemi.intensity = mix(0.5, 1.2, lights) * (1 - 0.45 * night);
    hemi.color.set('#9fb0ff').lerp(new THREE.Color('#ffffff'), lights * (1 - 0.6 * night));
    sun.intensity = mix(0.3, 1.3, lights) * (1 - 0.6 * night);
    if (night > 0.01) set.screen.light.color.lerp(NIGHT_GLOW, night);
    set.lamp.light.intensity = mix(0, 1.2, lights) * A.lamp;
    // a dance party turns the desk lamp into a disco light
    if (dancing) {
      set.lamp.light.color.setHSL((t * 0.9) % 1, 0.9, 0.6);
      set.lamp.light.intensity *= 1.6;
    } else set.lamp.light.color.set('#ffcf7a');
    set.lamp.bulb.color.set(lights > 0.5 && A.lamp > 0.5 ? '#fff3b0' : '#8a90a6');

    // ---- ambient particles
    if (t > nextSteam && lights > 0.5) {
      nextSteam = t + (thinking ? 0.35 : 0.9);
      emit('steam', worldPoint(set.mug, (Math.random() - 0.5) * 0.04, 0.16, 0), { life: 1.6, vel: new THREE.Vector3(0, 0.18, 0), size: 0.07, grow: 2.2 });
    }
    if (pose === 'sleep' && !hidden && t > nextZ) {
      nextZ = t + 1.1;
      emit('z', worldPoint(robot.head, 0.25, 0.65, 0), { life: 2.2, vel: new THREE.Vector3(0.12, 0.22, 0), size: 0.1, grow: 2 });
    }
    // the evening housemaid dusting (robot.js: data-tidy): sparkles all over the desk, and under
    // it where she sweeps; her emptied bin keeps no paper till the morning (data-bin-empty)
    if (d.tidy === '1' && !hidden && t > nextSparkle) {
      nextSparkle = t + 0.12;
      const under = Math.random() < 0.3;
      const p = under
        ? new THREE.Vector3(-0.9 + Math.random() * 1.2, 0.04 + Math.random() * 0.1, -0.75 + Math.random() * 0.5)
        : new THREE.Vector3(-1.15 + Math.random() * 1.5, LAYOUT.deskTop + 0.04 + Math.random() * 0.45, -1.18 + Math.random() * 0.55);
      emit('star', worldPoint(under ? set.office : set.desk?.top || set.office, p.x, p.y, p.z), { life: 0.8, vel: new THREE.Vector3(0, 0.12, 0), size: 0.05 + Math.random() * 0.05, grow: 0.3, spin: 4 });
    }
    // (the bin: antics/awake.js puts it there)
    for (const paper of (set.office.userData.bin as THREE.Object3D | undefined)?.children || []) if (paper.userData.binPaper as boolean | undefined) paper.visible = d.binEmpty !== '1';
    // high effort: headband on; full memory: steam out of the ears
    robot.headband.visible = d.effort === 'xhigh' || d.effort === 'max';
    if (d.brain === 'full' && awake && !hidden && t > nextBrainSteam) {
      nextBrainSteam = t + 0.5;
      for (const side of [-1, 1]) emit('steam', worldPoint(robot.head, side * 0.45, 0.35, 0), { life: 1.2, vel: new THREE.Vector3(side * 0.25, 0.3, 0), size: 0.08, grow: 2.5 });
    }
    const hurried = d.hurry === '1';
    if ((screen === 'run' || (hurried && working)) && !hidden && t > nextSweat) {
      nextSweat = t + (hurried ? 0.6 : 1.4);
      emit('sweat', worldPoint(robot.head, 0.36, 0.5, 0.1), { life: 0.9, vel: new THREE.Vector3(0.05, -0.35, 0), size: 0.08 });
    }
    if (pose === 'thinking' && scr !== 'helpers' && !hidden && t > nextQuestion) {
      nextQuestion = t + 1.6;
      emit('question', worldPoint(robot.head, -0.15, 0.85, 0), { life: 1.4, vel: new THREE.Vector3(0, 0.15, 0), size: 0.17, spin: 1.5 });
    }
    // helper agents at work: little bots circling over the desk
    const helperHome = worldPoint(robot.head, 0, robot.headTop ?? 0.6, 0);
    minis.update(t, dt, {
      want: hidden ? 0 : Math.min(6, Number(d.helpers) || 0),
      head: helperHome,
      center: helperHome.clone().lerp(LAYOUT.monitor, 0.2).setY(helperHome.y + 0.12),
      faceYaw: camYaw,
      hop: since('helper-step') < dt * 1.5,
      emit,
    });
    tickParticles(dt);

    effect.render(scene, camera);
  }

  function tickParticles(dt: number) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      const life = p.age / p.life;
      if (life >= 1) {
        world.remove(p.s);
        p.s.material.dispose();
        particles.splice(i, 1);
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.s.position.addScaledVector(p.vel, dt);
      p.s.scale.setScalar(p.size * (1 + (p.grow - 1) * life) * Math.min(1, p.age * 8));
      p.s.material.opacity = life < 0.7 ? 1 : 1 - (life - 0.7) / 0.3;
      p.s.material.rotation = Math.sin(p.age * 4) * 0.2 * p.spin;
    }
  }

  // the face is redrawn (and sent to the GPU) only when it changes; dizzy eyes and a talking,
  // chomping or wide-open mouth move by themselves, so those draw every frame
  let faceDrawn: { ctx: CanvasRenderingContext2D | null; key: string } = { ctx: null, key: '' };
  function drawFaceNow(d: DOMStringMap, t: number, asleep: boolean, lookX: number, lookY: number) {
    const f = {
      eyes: d.eyes || 'open',
      mouth: d.mouth || 'smile',
      lookX,
      lookY,
      blink: stateEl.classList.contains('blink') ? 1 : 0,
      blush: stateEl.classList.contains('blush') || moodEl.classList.contains('typing'),
      asleep,
      model: d.model,
      t,
    };
    const moving = f.eyes === 'dizzy' || MOVING_MOUTHS.has(f.mouth);
    // (the eyes drawn a quarter pixel apart look the same)
    const key = moving ? '' : `${f.eyes}|${f.mouth}|${Math.round(lookX * 12)}|${Math.round(lookY * 12)}|${f.blink}|${f.blush}|${asleep}|${f.model}`;
    if (key && key === faceDrawn.key && faceDrawn.ctx === robot.face.ctx) return;
    faceDrawn = { ctx: robot.face.ctx, key };
    robot.drawFace(robot.face.ctx, f);
    robot.face.tex.needsUpdate = true;
  }

  // Out for a walk on the user's desktop: just the character, standing on an invisible
  // ground (walker3d.js poses it). Always fully lit out there; only its face reads asleep.
  const wear: Omit<WearCtx, 'robot'> & { robot: Rig | null } = { robot: null, t: 0, dt: 0, nightcap: false, lateNight: false, asleep: false };
  const look: [number, number] = [0, 0];
  function soloFrame(t: number, dt: number, d: DOMStringMap, awake: boolean) {
    look[0] = cssNum('--look-x');
    look[1] = cssNum('--look-y');
    walker!.update({ t, dt, d, robot, swingDeg: cssNum('--swing'), look });
    // the nightcap when it sleepwalks, the hood when it's up late (as at the desk)
    wear.robot = robot;
    wear.t = t;
    wear.dt = dt;
    wear.nightcap = d.nightcap === '1';
    wear.lateNight = d.lateNight === '1';
    wear.asleep = !awake;
    wearTick(wear as WearCtx); // (its robot: just set)
    robot.headband.visible = d.effort === 'xhigh' || d.effort === 'max';
    drawFaceNow(d, t, !awake, look[0], look[1]);
    robot.antennaBall.color.set(awake ? robot.light || theme.robot?.light || '#ff5e62' : '#8a90a6');
    robot.chest.material.color.copy(robot.antennaBall.color);
    robot.antenna.rotation.z = Math.sin(t * 2) * 0.05;
    // it steps out of its desk lit as it was there (dimmed, asleep), then brightens up as it
    // walks out into your screen
    if (soloFrame.lit === undefined) lights = soloFrame.lit = awake ? 1 : 0;
    lights = mix(lights, 1, ease(dt, 0.9));
    hemi.intensity = mix(0.5, 1.2, lights);
    hemi.color.set('#9fb0ff').lerp(new THREE.Color('#ffffff'), lights);
    sun.intensity = mix(0.3, 1.3, lights);
    tickParticles(dt);
    effect.render(scene, camera);
  }
  // (frame's and soloFrame's own memos, kept on them: unset to begin with)
  frame.n = undefined as number | undefined;
  frame.gone = undefined as boolean | undefined;
  frame.goneAt = undefined as number | undefined;
  soloFrame.lit = undefined as number | undefined;
  raf = requestAnimationFrame(frame);

  return {
    // draw at k times the resolution, for a robot box scaled up by k
    setScale(k) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * Math.max(1, k));
      renderer.setSize(width, height);
    },
    resize(w, h) {
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (solo) frameSolo(camera, soloView(h));
    },
    // Is this point (client px) on the monitor's screen? (double-clicking it crashes the computer)
    // the sticky note under a page point (CSS px): { kind, id } or null (scene.js stickies)
    stickyAt(clientX, clientY) {
      if (solo || !set?.stickies?.objects.length) return null;
      const r = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, 1 - ((clientY - r.top) / r.height) * 2);
      const ray = new THREE.Raycaster();
      camera.updateMatrixWorld();
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects([set.office, robot.root], true).find((h) => robot.root.visible || !isUnder(h.object, robot.root));
      return hit ? set.stickies.lookup(hit.object) : null;
    },
    // What you can click round the desk under a page point (CSS px), nearest first:
    // { kind: 'note', id } | { kind: 'board' } (the corkboard) | { kind: 'hammer' } | { kind: 'plug' }
    // | null (also when the robot's in front of it)
    propAt(clientX, clientY) {
      if (solo || !set) return null;
      const r = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, 1 - ((clientY - r.top) / r.height) * 2);
      const ray = new THREE.Raycaster();
      camera.updateMatrixWorld();
      ray.setFromCamera(ndc, camera);
      let best: (PropHit & { distance: number }) | null = props?.hit(ray) || null;
      const onBoard = board?.group.visible && ray.intersectObject(board.group, true)[0];
      // (a ray through a hidden part of the board isn't on it: board.hit says what is)
      const boardHit = onBoard ? board!.hit(ray) : null;
      if (onBoard && boardHit && (!best || onBoard.distance < best.distance)) best = { ...boardHit, distance: onBoard.distance };
      if (!best) return null;
      const inFront = robot.root.visible && ray.intersectObject(robot.root, true)[0];
      if (inFront && inFront.distance < best.distance) return null;
      const { distance, ...hit } = best;
      void distance;
      return hit;
    },
    // (the corkboard only)
    boardAt(clientX, clientY) {
      const hit = this.propAt(clientX, clientY);
      return hit && (hit.kind === 'note' || hit.kind === 'board') ? hit : null;
    },
    hitsMonitor(clientX, clientY) {
      if (solo) return false;
      const r = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, 1 - ((clientY - r.top) / r.height) * 2);
      const ray = new THREE.Raycaster();
      camera.updateMatrixWorld(); // (its stored matrices can be stale between frames)
      ray.setFromCamera(ndc, camera);
      // (not the robot while it's hidden, out for a walk)
      const hit = ray.intersectObjects([set!.office, robot.root], true).find((h) => robot.root.visible || !isUnder(h.object, robot.root));
      return (hit?.object as { material?: unknown } | undefined)?.material === set!.screen.material; // (whatever it hit: a mesh, a sprite…)
    },
    // The point on the floor (office space, {x, z}) under a page point (CSS px): where a walker
    // put down on the desk is standing (robot.js / antics/walk.js stepin)
    floorAt(clientX, clientY) {
      if (!set) return null;
      const r = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, 1 - ((clientY - r.top) / r.height) * 2);
      camera.updateMatrixWorld();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), -set.office.getWorldPosition(new THREE.Vector3()).y);
      const hit = ray.ray.intersectPlane(floor, new THREE.Vector3());
      if (!hit) return null;
      set.office.worldToLocal(hit);
      return { x: hit.x, z: hit.z };
    },
    // Where its feet are, in the page (CSS px): stepping out, the walker window takes over
    // with its feet on this very spot (robot.js / main walker.js)
    feetPosition() {
      const v = new THREE.Vector3();
      robot.root.getWorldPosition(v);
      v.y = set ? set.office.getWorldPosition(new THREE.Vector3()).y : 0; // down on the floor
      camera.updateMatrixWorld();
      v.project(camera);
      const r = renderer.domElement.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
    // Where the robot's head is on screen (CSS px within the canvas).
    headPosition() {
      const v = new THREE.Vector3(0, 0.3, 0);
      robot.head.localToWorld(v);
      camera.updateMatrixWorld();
      v.project(camera);
      const r = renderer.domElement.getBoundingClientRect();
      return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height };
    },
    dispose() {
      cancelAnimationFrame(raf);
      walker?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

export const Office3D = { mount };
