import { ease, mix } from '@/office3d/core/math';
import { isMesh } from '@/office3d/core/mesh';
import { ROBOT_SCALE } from '@/office3d/core/constants';
import * as THREE from 'three';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';
import { buildOffice, LAYOUT } from './scene';
import { themeOf } from './themes';
import { POSES } from './robot3d';
import { buildKit } from './kit3d';
import { buildHammer } from './hammer';
import { createMinis } from './minibots';
import { buildBattery } from './battery';
import { badgeTexture } from './materials';
import { buildBoard } from './board';
import { buildProps } from './props';
import { createAntics, wearTick } from './antics/index';
import { createAmbient } from './ambient';
import { CAMERA, soloView } from './camera';
import { createDeskFrame } from './desk-frame';
import { createParticles } from './particles';
import { bonkFrame } from './bonk';
import { createPicking, type PropHit } from './picking';
import { createPlay } from './play';
import { createBed } from './bed';
import { createWalker, frameSolo, AWAY_TURN } from './walker3d';
import type { Board, BoardHit, Rig } from './types';
import type { AnticPose, Vec3Tuple, WearCtx } from './antics/types';
import { CSS_VARS, type Flash, type Mood, type OfficeData, officeData, REACTIONS } from './protocol';

// The 3D workstation: a pure "view" of the robot's state, which the page puts on stateEl,
// moodEl and a few CSS variables (protocol.ts says what).

export type Office3DOptions = {
  stateEl: HTMLElement; // its dataset, classes and --paint: what to show (protocol.ts)
  moodEl: HTMLElement; // its classes: awake / asleep / thinking / talking / dragging / typing
  width: number;
  height: number;
  solo?: boolean; // the character alone, out for a walk (walker3d.js)
  onLost?: () => void; // the GPU took the canvas away and didn't give it back: nothing shows
};
export type { PropHit };
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

// (any material may have a picture, a map)
type Mapped = THREE.Material & { map?: THREE.Texture | null };

const NIGHT_GLOW = new THREE.Color('#7fb2ff');
const MOVING_MOUTHS = new Set(['talk', 'wide', 'chomp']); // mouths that move by themselves (face.js, kitface.js)

// (Some parts are only at the desk (set, antics, bed, the toys) and the walker only out walking
// (solo): they're null otherwise, and each side checks for its own before using them.)
function mount(
  host: HTMLElement,
  { stateEl, moodEl, width, height, solo = false, onLost }: Office3DOptions,
): Office3DView {
  const data = officeData(stateEl);
  const mood = (m: Mood) => moodEl.classList.contains(m);
  const flashing = (f: Flash) => stateEl.classList.contains(f);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false; // (the frame loop says when: frame())
  host.appendChild(renderer.domElement);
  // A GPU reset (a driver update, waking from sleep) takes the canvas away; three asks for it
  // back. If it doesn't come back, the robot is invisible in its see-through window: say so.
  const LOST_WAIT = 5000;
  let lostTimer = 0;
  renderer.domElement.addEventListener('webglcontextlost', () => {
    clearTimeout(lostTimer);
    if (onLost) lostTimer = window.setTimeout(onLost, LOST_WAIT);
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => clearTimeout(lostTimer));
  const effect = new OutlineEffect(renderer, {
    defaultThickness: 0.004,
    defaultColor: [0.11, 0.13, 0.2],
    defaultAlpha: 1,
  });

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
  const desk = createDeskFrame(); // (the monitor, stickies, corkboard… each frame: desk-frame.ts)
  function addBoard() {
    if (!set) return;
    board = buildBoard(theme);
    (set.desk?.top || set.office).add(board.group);
    set.board = board;
    desk.repinBoard(); // (pin them up again)
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
    const old = set;
    if (!old) return; // (never: at the desk there's always a set)
    world.remove(old.office);
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
    const seatIn = solo ? walker?.stage : set?.swivel;
    if (!seatIn) throw new Error('No walker stage or desk chair to seat the robot in');
    seatIn.add(robot.root);
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

  // ---- particles
  const particles = createParticles(world);
  const emit = particles.emit;
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
  const YAW: Partial<Record<string, number>> = {
    idle: camYaw,
    talking: camYaw,
    cheer: camYaw,
    wave: camYaw,
    eager: camYaw,
    raise: camYaw,
    sleep: camYaw - 0.3,
    slack: camYaw - 0.15,
    typing: monitorYaw,
    reading: monitorYaw,
    thinking: thinkYaw,
  };
  // out for a walk: the empty chair, pushed back from the desk and turned a little towards you
  const awayYaw = monitorYaw + (camYaw - monitorYaw) * AWAY_TURN;

  const antics = solo ? null : createAntics({ world, emit, worldPoint, camYaw, monitorYaw });
  // asleep: in the chair with an eye mask, or curled up on the floor under a blanket
  const bed = solo ? null : createBed({ emit });
  const bedBubble = new THREE.Vector3();
  const bubbleAt = () =>
    bed && set && bed.bubbleAt(set, bedBubble) ? world.worldToLocal(set.office.localToWorld(bedBubble)) : null; // (the antics', at the desk)

  // ---- animated state
  const cur: { yaw: number; lean: number; head: Vec3Tuple; armL: Vec3Tuple; armR: Vec3Tuple } = {
    yaw: camYaw,
    lean: 0,
    head: [0, 0, 0],
    armL: [...POSES.idle.armL],
    armR: [...POSES.idle.armR],
  };
  const react: Partial<Record<string, number>> = {}; // reaction name -> start time
  const seen = new Set<string>();
  let screen: string | null = null;
  let screenStart = 0;
  let paint = '';
  let acc: string | null | undefined = null;
  let name: string | null | undefined = null;
  seat('kit:{}', (o) => buildKit({}, { ...o, standing: solo }));
  let lights = 1;
  let night = 0; // 0..1, up past 10 pm (data-late-night)
  let last = performance.now();
  let lastFrame = 0;
  let shadowAt = -Infinity; // when the shadow map was last redrawn
  let raf = 0;
  const clock0 = performance.now();

  const cssNum = (name: string) => parseFloat(document.documentElement.style.getPropertyValue(name)) || 0;

  const bonkParts = toy ? { toy, camera, emit, worldPoint, react } : null;
  const playFrame = charger ? createPlay({ world, charger, emit, worldPoint, camYaw, react, cssNum }) : null;
  const ambientFrame = minis ? createAmbient({ emit, worldPoint, minis, camYaw }) : null;

  // what frame() remembers between frames: how many it drew, whether it was out and since when;
  // and whether soloFrame() has set its lights yet
  let framesDrawn = 0;
  let wasGone: boolean | undefined;
  let goneAt = 0;
  let soloLit = false;
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const awake = mood('awake');
    const dragging = mood('dragging');
    const scr = data.screen || 'off';
    const working = scr !== 'off';
    // full frame rate only while something is really moving; idle and asleep tick slower
    const lively = solo
      ? walker?.lively || dragging || particles.count > 0
      : dragging ||
        (working && scr !== 'idle') ||
        mood('thinking') ||
        Number(data.helpers) > 0 ||
        antics?.active ||
        !!data.propHover ||
        !!data.stickyHover ||
        desk.stickiesMoving ||
        data.tidy === '1' ||
        REACTIONS.some((r) => flashing(r));
    // (its robot's in the group chat's meeting room: the empty desk needs only the odd frame)
    const fps = data.meeting === '1' && !dragging ? 2 : lively ? 30 : awake ? 12 : 6;
    // (hidden at the screen's edge, data-peek: only its head peeks out, drawn by the page)
    if (((document.hidden || data.peek === '1') && !solo) || now - lastFrame < 1000 / fps - 2) return; // (a walker draws while still hidden, to take over seamlessly)
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
    const d = data;
    const pose = d.pose || 'idle';
    const target = POSES[pose] || POSES.idle;
    const thinking = mood('thinking');
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
    const n = ++framesDrawn;
    if (n < 30 || n % 15 === 1) {
      const p = getComputedStyle(stateEl).getPropertyValue(CSS_VARS.paint).trim() || '#5ac8fa';
      if (p !== paint || d.name !== name) {
        paint = p;
        name = d.name;
        robot.setColor(paint);
        const b = badgeTexture(name, paint, theme);
        robot.torso.traverse((o) => {
          if (
            isMesh<THREE.Mesh<THREE.BufferGeometry, Mapped | Mapped[]>>(o) &&
            Array.isArray(o.material) &&
            o.material[4]?.map
          ) {
            o.material[4].map = b.tex;
            o.material[4].needsUpdate = true;
          }
        });
      }
    }
    for (const r of REACTIONS) {
      const on = flashing(r);
      if (on && !seen.has(r)) react[r] = t;
      if (on) seen.add(r);
      else seen.delete(r);
    }
    if (solo) return soloFrame(t, dt, d, awake);
    // (never: at the desk they're all there)
    if (!set || !antics || !bed || !toy || !charger || !minis || !bonkParts || !playFrame || !ambientFrame) return;
    // out for a walk: nobody's in the chair
    const gone = d.away === '1';
    if (gone !== wasGone) {
      wasGone = gone;
      goneAt = t;
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
    const toward =
      facing === null ? null : cur.yaw + Math.atan2(Math.sin(facing - cur.yaw), Math.cos(facing - cur.yaw));
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
    const A: AnticPose = {
      lean: cur.lean,
      head: [...cur.head],
      armL,
      armR,
      yaw: 0,
      tip: 0,
      rootY: 0,
      rootZ: 0,
      mug: new THREE.Vector3(),
      mugTilt: 0,
      lamp: 1,
      screen: null,
      screenDim: 0,
      shake: 0,
      reachL: 1,
      reachR: 1,
      antenna: 0,
      boardLift: 0,
    };
    antics.update({ t, dt, d, pose, robot, set, curYaw: cur.yaw, A, bubbleAt, bed, away: gone });
    set.swivel.rotation.order = 'YXZ';
    set.swivel.rotation.y = cur.yaw + spinExtra + A.yaw + danceSway;
    set.swivel.rotation.x = -A.tip;
    set.mug.position.copy(antics.mugHome).add(A.mug);
    set.mug.rotation.z = A.mugTilt;
    for (const [arm, a] of [
      [robot.arms.armL, armL],
      [robot.arms.armR, armR],
    ] as const) {
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
    const facingYou =
      pose === 'idle' ||
      pose === 'slack' ||
      pose === 'talking' ||
      pose === 'wave' ||
      pose === 'cheer' ||
      pose === 'eager' ||
      pose === 'raise';
    const lookX = cssNum(CSS_VARS.lookX);
    const lookY = cssNum(CSS_VARS.lookY);
    // chewing: the head bobs while the mouth works
    const sChomp = since('chomp');
    const chew = sChomp < 1.3 ? Math.sin(sChomp * 22) * 0.1 * (1 - sChomp / 1.3) : 0;
    robot.head.rotation.set(
      A.head[0] + (facingYou ? lookY * 0.05 : 0) + chew,
      A.head[1] + (facingYou ? lookX * 0.06 : 0),
      A.head[2] + (data.eyes === 'dizzy' ? Math.sin(t * 7) * 0.15 : 0),
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
        emit('heart', worldPoint(robot.head, (i - 1) * 0.25, 0.7, 0.1), {
          life: 1.1,
          vel: new THREE.Vector3((i - 1) * 0.15, 0.55, 0),
          size: 0.13,
        });
      }
    }
    const sShake = since('shake');
    world.position.x =
      (sShake < 0.5 ? Math.sin(sShake * 70) * 0.05 * (1 - sShake / 0.5) : 0) + Math.sin(t * 60) * 0.02 * A.shake;
    // bonk: the squeaky toy hammer (bonk.ts)
    const squash = bonkFrame(bonkParts, robot, since('bonk'));
    robot.head.scale.set(1 + squash * 0.45, 1 - squash, 1 + squash * 0.45);
    if (dancing) robot.head.rotation.z += Math.sin(sDance * Math.PI * 4) * 0.15; // head bob

    // ---- play (the plug by the desk; a dance or a high-five by itself)
    playFrame({ t, dt, robot, since, dancing, dragging, sChomp });

    drawFaceNow(d, t, !awake && !working, lookX, lookY);

    // ---- the monitor, the word box, the stickies, the corkboard, the hammer and the plug
    desk.update({
      now,
      t,
      dt,
      d,
      A,
      gone,
      goneAt,
      screen,
      screenStart,
      anticStart: antics.startedAt,
      paint,
      theme,
      themeKey,
      lights,
      night,
      set,
      board,
      props,
      toy,
      since,
    });

    // ---- antenna + chest light
    const lightCol = thinking
      ? new THREE.Color().setHSL((t * 0.8) % 1, 0.85, 0.62)
      : new THREE.Color(awake || working ? robot.light || theme.robot?.light || '#ff5e62' : '#8a90a6'); // (robot.light: the lights colour of a robot you built)
    robot.antennaBall.color.copy(lightCol);
    robot.chest.material.color.copy(thinking ? new THREE.Color('#4de1ff') : lightCol);

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
    ambientFrame({ t, dt, d, awake, working, scr, pose, thinking, hidden, lights, screen, set, robot, since });
    particles.tick(dt);

    effect.render(scene, camera);
  }

  // the face is redrawn (and sent to the GPU) only when it changes; dizzy eyes and a talking,
  // chomping or wide-open mouth move by themselves, so those draw every frame
  let faceDrawn: { ctx: CanvasRenderingContext2D | null; key: string } = { ctx: null, key: '' };
  function drawFaceNow(d: OfficeData, t: number, asleep: boolean, lookX: number, lookY: number) {
    const f = {
      eyes: d.eyes || 'open',
      mouth: d.mouth || 'smile',
      lookX,
      lookY,
      blink: flashing('blink') ? 1 : 0,
      blush: flashing('blush') || mood('typing'),
      asleep,
      model: d.model,
      t,
    };
    const moving = f.eyes === 'dizzy' || MOVING_MOUTHS.has(f.mouth);
    // (the eyes drawn a quarter pixel apart look the same)
    const key = moving
      ? ''
      : `${f.eyes}|${f.mouth}|${Math.round(lookX * 12)}|${Math.round(lookY * 12)}|${f.blink}|${f.blush}|${asleep}|${f.model}`;
    if (key && key === faceDrawn.key && faceDrawn.ctx === robot.face.ctx) return;
    faceDrawn = { ctx: robot.face.ctx, key };
    robot.drawFace(robot.face.ctx, f);
    robot.face.tex.needsUpdate = true;
  }

  // Out for a walk on the user's desktop: just the character, standing on an invisible
  // ground (walker3d.js poses it). Always fully lit out there; only its face reads asleep.
  const wear: Omit<WearCtx, 'robot'> & { robot: Rig | null } = {
    robot: null,
    t: 0,
    dt: 0,
    nightcap: false,
    lateNight: false,
    asleep: false,
  };
  const look: [number, number] = [0, 0];
  function soloFrame(t: number, dt: number, d: OfficeData, awake: boolean) {
    look[0] = cssNum(CSS_VARS.lookX);
    look[1] = cssNum(CSS_VARS.lookY);
    walker?.update({ t, dt, d, robot, swingDeg: cssNum(CSS_VARS.swing), look });
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
    if (!soloLit) {
      lights = awake ? 1 : 0;
      soloLit = true;
    }
    lights = mix(lights, 1, ease(dt, 0.9));
    hemi.intensity = mix(0.5, 1.2, lights);
    hemi.color.set('#9fb0ff').lerp(new THREE.Color('#ffffff'), lights);
    sun.intensity = mix(0.3, 1.3, lights);
    particles.tick(dt);
    effect.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  const picking = createPicking({
    renderer,
    camera,
    solo,
    set: () => set,
    robot: () => robot,
    board: () => board,
    props: () => props,
  });
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
    ...picking,
    dispose() {
      cancelAnimationFrame(raf);
      clearTimeout(lostTimer);
      walker?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

export const Office3D = { mount };
