import * as THREE from 'three';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';
import { buildOffice, LAYOUT } from './scene.js';
import { themeOf } from './themes.js';
import { buildRobot, POSES } from './robot3d.js';
import { buildLoopy } from './loopy3d.js';
import { buildCat } from './cat3d.js';
import { buildNerd } from './nerd3d.js';
import { buildGirl } from './girl3d.js';
import { loadModel, buildCustom } from './custom3d.js';
import { buildHammer, HAMMER } from './hammer.js';
import { createMinis } from './minibots.js';
import { buildBattery } from './battery.js';
import { drawScreen, SCREEN_LIGHT } from './screens.js';
import { spriteTexture, badgeTexture } from './materials.js';
import { createAntics } from './antics/index.js';
import { createBed } from './bed.js';

// The 3D workstation is a pure "view" of the robot's state. It reads what the page
// already tracks on every frame:
//   stateEl.dataset  screen, pose, eyes, mouth, acc, name, body (loopy | cat | nerd | girl | robot | custom), glb, glbTurn,
//                    helpers (how many helper agents are at work: little bots circle the desk),
//                    theme (the desk, screen and badge style: classic | sioux),
//                    antic, anticSeq, anticText, nightcap (idle antics: see antics/index.js)
//   stateEl classes  one-shot reactions: hop, squish, shake, spin, blink, blush, idea, bonk, helper-step
//   moodEl classes   awake / asleep / thinking / talking / dragging / typing
//   CSS variables    --paint, --look-x, --look-y, --swing
// so the robot window and the Workshop preview can drive it without knowing about 3D.

const ROBOT_SCALE = 0.82;
// who sits at the desk; both share one rig (see robot3d.js)
const BODIES = { loopy: buildLoopy, cat: buildCat, nerd: buildNerd, girl: buildGirl, robot: buildRobot };
// (charge, tickle, highfive, dance: from the robot's hover menu)
const REACTIONS = ['hop', 'squish', 'shake', 'spin', 'idea', 'chomp', 'bonk', 'helper-step', 'charge', 'tickle', 'highfive', 'dance'];
// the squeaky-hammer bonk, in seconds: pops in, winds up, strikes, rebounds, shrinks away
// (the hit time is mirrored by BONK_HIT_MS in robot.js, which lands the sound and reaction)
const BONK = { appear: 0.18, windup: 0.34, hit: 0.42, leave: 0.72, end: 1.02, scale: 0.8 };
const NIGHT_GLOW = new THREE.Color('#7fb2ff');
const easeOutBack = (p) => 1 + 2.4 * (p - 1) ** 3 + 1.4 * (p - 1) ** 2;
const CAMERA = { target: new THREE.Vector3(-0.38, 0.7, -0.7), dir: new THREE.Vector3(0.62, 0.5, 0.8), distance: 5.95, fov: 27 };

function mount(host, { stateEl, moodEl, width, height }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);
  const effect = new OutlineEffect(renderer, { defaultThickness: 0.004, defaultColor: [0.11, 0.13, 0.2], defaultAlpha: 1 });

  const scene = new THREE.Scene();
  const world = new THREE.Group();
  scene.add(world);

  const camera = new THREE.PerspectiveCamera(CAMERA.fov, width / height, 0.1, 50);
  camera.position.copy(CAMERA.target).addScaledVector(CAMERA.dir.clone().normalize(), CAMERA.distance);
  camera.lookAt(CAMERA.target);

  // ---- lights
  const hemi = new THREE.HemisphereLight('#ffffff', '#b9a7ff', 1.2);
  const sun = new THREE.DirectionalLight('#fff4e0', 1.6);
  sun.position.set(2.5, 4.5, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -2.4;
  sun.shadow.camera.right = sun.shadow.camera.top = 2.4;
  sun.shadow.bias = -0.0008;
  sun.shadow.radius = 4;
  scene.add(hemi, sun);

  // ---- set + actor
  let theme = themeOf('classic');
  let themeKey = 'classic';
  let set = buildOffice(theme);
  world.add(set.office);
  // a new theme: rebuild the workstation around the robot
  function dress(key) {
    themeKey = key;
    theme = themeOf(key);
    world.remove(set.office);
    const old = set;
    set = buildOffice(theme);
    world.add(set.office);
    if (robot) {
      old.swivel.remove(robot.root);
      set.swivel.add(robot.root);
      set.swivel.rotation.y = old.swivel.rotation.y;
      robot.setTheme?.(theme);
    }
    paint = ''; // repaint the badge
  }
  let robot = null;
  let body = null;
  function seat(kind, build = BODIES[kind]) {
    if (robot) robot.root.removeFromParent(); // off the chair, or off the floor if it was asleep there
    body = kind;
    robot = build({ color: paint || '#5ac8fa', name: name || '' });
    robot.root.position.set(0, 0.09, 0.04);
    robot.root.scale.setScalar(ROBOT_SCALE);
    set.swivel.add(robot.root);
    robot.setTheme?.(theme);
    // re-apply what the old body was wearing
    acc = null;
    paint = '';
  }
  const toy = buildHammer();
  world.add(toy.hammer);
  const minis = createMinis(world);
  const charger = buildBattery();
  world.add(charger.battery);
  const play = { nextBolt: 0, nextHa: 0, nextNote: 0, burstFor: null, fiveFor: null };

  // ---- particles
  const particles = [];
  const textures = Object.fromEntries(['steam', 'z', 'heart', 'sweat', 'bulb', 'question', 'doc', 'crumb', 'star', 'squeak', 'note', 'ball', 'bolt', 'haha'].map((k) => [k, spriteTexture(k)]));
  function emit(kind, pos, { life = 1.2, vel = new THREE.Vector3(0, 0.4, 0), size = 0.14, grow = 1, spin = 0, gravity = 0 } = {}) {
    const mat = new THREE.SpriteMaterial({ map: textures[kind], transparent: true, depthWrite: false });
    mat.userData.outlineParameters = { visible: false };
    const s = new THREE.Sprite(mat);
    s.position.copy(pos);
    s.scale.setScalar(size);
    world.add(s);
    particles.push({ s, life, age: 0, vel, size, grow, spin, gravity });
  }
  const worldPoint = (obj, x, y, z) => {
    const v = new THREE.Vector3(x, y, z);
    obj.localToWorld(v);
    return world.worldToLocal(v);
  };

  // ---- chair directions
  const chairPos = LAYOUT.chair;
  const yawTo = (p) => Math.atan2(p.x - chairPos.x, p.z - chairPos.z);
  const camYaw = yawTo(camera.position);
  const monitorYaw = yawTo(LAYOUT.monitor) + 0.12;
  const thinkYaw = (camYaw + monitorYaw) / 2;
  const YAW = { idle: camYaw, talking: camYaw, cheer: camYaw, wave: camYaw, eager: camYaw, raise: camYaw, sleep: camYaw - 0.3, slack: camYaw - 0.15, typing: monitorYaw, reading: monitorYaw, thinking: thinkYaw };

  const antics = createAntics({ world, emit, worldPoint, camYaw, monitorYaw });
  // asleep: in the chair with an eye mask, or curled up on the floor under a blanket
  const bed = createBed({ emit });
  const bedBubble = new THREE.Vector3();
  const bubbleAt = () => (bed.bubbleAt(set, bedBubble) ? world.worldToLocal(set.office.localToWorld(bedBubble)) : null);

  // ---- animated state
  const cur = { yaw: camYaw, lean: 0, head: [0, 0, 0], armL: [...POSES.idle.armL], armR: [...POSES.idle.armR] };
  const react = {}; // reaction name -> start time
  const seen = new Set();
  let screen = null;
  let screenStart = 0;
  let paint = '';
  let acc = null;
  let name = null;
  seat('loopy');
  // your own model (.glb): loads in the background, the old body stays until it's ready.
  // The page hears how it went through a 'character-status' event on stateEl.
  let loading = null;
  const failed = new Map();
  function loadCustom(key, file, turn) {
    const report = (detail) => stateEl.dispatchEvent(new CustomEvent('character-status', { detail }));
    if (failed.has(key)) return;
    loading = key;
    report({ loading: true });
    loadModel(file)
      .then((gltf) => {
        if (loading !== key) return;
        loading = null;
        seat(key, () => buildCustom(gltf, { turn }));
        report({ ok: true, ...robot.status });
      })
      .catch((err) => {
        console.error('Could not load the character model', err);
        failed.set(key, err);
        if (loading === key) loading = null;
        report({ ok: false, error: String(err?.message || err) });
      });
  }
  let lights = 1;
  let night = 0; // 0..1, up past 10 pm (data-late-night)
  let nextZ = 0;
  let nextSteam = 0;
  let nextSweat = 0;
  let nextBrainSteam = 0;
  let nextQuestion = 0;
  let last = performance.now();
  let lastFrame = 0;
  let raf = 0;
  const clock0 = performance.now();

  const ease = (dt, rate) => 1 - Math.exp(-dt * rate);
  const mix = (a, b, k) => a + (b - a) * k;
  const cssNum = (name) => parseFloat(document.documentElement.style.getPropertyValue(name)) || 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const awake = moodEl.classList.contains('awake');
    const dragging = moodEl.classList.contains('dragging');
    const scr = stateEl.dataset.screen || 'off';
    const working = scr !== 'off';
    // full frame rate only while something is really moving; idle and asleep tick slower
    const lively = dragging || (working && scr !== 'idle') || moodEl.classList.contains('thinking') || Number(stateEl.dataset.helpers) > 0 || antics.active || REACTIONS.some((r) => stateEl.classList.contains(r));
    const fps = lively ? 30 : awake ? 20 : 8;
    if (document.hidden || now - lastFrame < 1000 / fps - 2) return;
    lastFrame = now;
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
    const want = d.body === 'custom' && d.glb ? `custom:${d.glb}:${d.glbTurn || 0}` : BODIES[d.body] ? d.body : 'loopy';
    if (want !== body && want !== loading) {
      if (want.startsWith('custom:')) loadCustom(want, d.glb, Number(d.glbTurn) || 0);
      else seat(want);
    }
    if (d.acc !== acc) {
      acc = d.acc;
      robot.setAccessory(acc || 'none');
    }
    if ((frame.n = (frame.n || 0) + 1) % 15 === 1) {
      const p = getComputedStyle(stateEl).getPropertyValue('--paint').trim() || '#5ac8fa';
      if (p !== paint || d.name !== name) {
        paint = p;
        name = d.name;
        robot.setColor(paint);
        const b = badgeTexture(name, paint, theme);
        robot.torso.traverse((o) => {
          if (Array.isArray(o.material) && o.material[4]?.map) {
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
    const since = (r) => (react[r] === undefined ? Infinity : t - react[r]);

    // ---- chair swivel target (+ a full spin for the "spin" reaction)
    const k = ease(dt, 5);
    cur.yaw = mix(cur.yaw, YAW[pose] ?? camYaw, k);
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
    const armL = [...cur.armL];
    const armR = [...cur.armR];
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
    // tickled: the arms flail
    const sTickle = since('tickle');
    if (sTickle < 1.6) {
      const k = 1 - sTickle / 1.6;
      armL[1] += Math.sin(t * 28) * 0.5 * k;
      armR[1] += Math.sin(t * 28 + 1.6) * 0.5 * k;
      armL[2] -= Math.abs(Math.sin(t * 22)) * 0.6 * k;
      armR[2] -= Math.abs(Math.sin(t * 22 + 1)) * 0.6 * k;
    }
    // dancing: the chair sways
    const sDance = since('dance');
    const dancing = sDance < 4.2;
    const danceSway = dancing ? Math.sin(sDance * Math.PI * 2) * 0.45 : 0;
    // idle antics (sipping coffee, snot bubbles…) play on top of the pose
    const A = { lean: cur.lean, head: [...cur.head], armL, armR, yaw: 0, tip: 0, rootY: 0, rootZ: 0, mug: new THREE.Vector3(), mugTilt: 0, lamp: 1, screen: null, screenDim: 0, shake: 0, reachL: 1, reachR: 1, antenna: 0 };
    antics.update({ t, dt, d, pose, robot, set, curYaw: cur.yaw, A, bubbleAt, bed });
    set.swivel.rotation.order = 'YXZ';
    set.swivel.rotation.y = cur.yaw + spinExtra + A.yaw + danceSway;
    set.swivel.rotation.x = -A.tip;
    set.mug.position.copy(antics.mugHome).add(A.mug);
    set.mug.rotation.z = A.mugTilt;
    for (const [arm, a] of [[robot.arms.armL, armL], [robot.arms.armR, armR]]) {
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
    // dancing bobs up and down and rocks; a tickle wriggles
    if (dancing) robot.root.position.y += Math.abs(Math.sin(sDance * Math.PI * 4)) * 0.07;
    robot.root.rotation.z = (sTickle < 1.6 ? Math.sin(t * 40) * 0.07 * (1 - sTickle / 1.6) : 0) + (dancing ? Math.sin(sDance * Math.PI * 2) * 0.1 : 0);
    const sSquish = since('squish');
    const sq = sSquish < 0.5 ? Math.sin((sSquish / 0.5) * Math.PI * 3) * 0.14 * (1 - sSquish / 0.5) : 0;
    robot.root.scale.set(ROBOT_SCALE * (1 + sq), ROBOT_SCALE * (1 - sq), ROBOT_SCALE * (1 + sq));
    // asleep on the floor: off the chair and curled up under a blanket (wins over the seat position)
    bed.update({ t, dt, pose, d, robot, body, set, camYaw });
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
      let angle;
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

    // ---- play (the hover menu)
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
    // tickle: giggles pop out
    if (sTickle < 1.5 && t > play.nextHa) {
      play.nextHa = t + 0.28;
      emit('haha', worldPoint(robot.head, (Math.random() - 0.5) * 0.6, 0.55, 0.1), { life: 0.9, vel: new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.45, 0), size: 0.2, spin: 2 });
    }
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

    // ---- face
    robot.drawFace(robot.face.ctx, {
      eyes: d.eyes || 'open',
      mouth: d.mouth || 'smile',
      lookX,
      lookY,
      blink: stateEl.classList.contains('blink') ? 1 : 0,
      blush: stateEl.classList.contains('blush') || moodEl.classList.contains('typing'),
      asleep: !awake && !working,
      model: d.model,
      t,
    });
    robot.face.tex.needsUpdate = true;

    // ---- monitor
    // (an antic may borrow it: a screensaver, a dream on the dark screen)
    const shown = A.screen || screen;
    drawScreen(set.screen.ctx, shown, A.screen ? t - antics.startedAt : t - screenStart, paint || '#5ac8fa', theme);
    if (A.screen && A.screenDim > 0) {
      set.screen.ctx.fillStyle = `rgba(0,0,0,${A.screenDim})`;
      set.screen.ctx.fillRect(0, 0, set.screen.canvas.width, set.screen.canvas.height);
    }
    set.screen.tex.needsUpdate = true;
    const glowColor = SCREEN_LIGHT[shown.startsWith('dream:') ? 'dream' : shown] || (A.screen ? '#9fb0ff' : null);
    set.screen.light.intensity = mix(set.screen.light.intensity, (glowColor ? 1.4 * (1 - A.screenDim) : 0) + 1.6 * night, ease(dt, 6));
    if (glowColor) set.screen.light.color.set(glowColor);
    set.screen.led.material.color.set(screen === 'off' ? (Math.sin(t * 2.5) > 0 ? '#ffb347' : '#5a4630') : '#7bed9f');

    // ---- antenna + chest light
    const lightCol = thinking ? new THREE.Color().setHSL((t * 0.8) % 1, 0.85, 0.62) : new THREE.Color(awake || working ? theme.robot?.light || '#ff5e62' : '#8a90a6');
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
    if (t > nextSteam && lights > 0.5) {
      nextSteam = t + (thinking ? 0.35 : 0.9);
      emit('steam', worldPoint(set.mug, (Math.random() - 0.5) * 0.04, 0.16, 0), { life: 1.6, vel: new THREE.Vector3(0, 0.18, 0), size: 0.07, grow: 2.2 });
    }
    if (pose === 'sleep' && t > nextZ) {
      nextZ = t + 1.1;
      emit('z', worldPoint(robot.head, 0.25, 0.65, 0), { life: 2.2, vel: new THREE.Vector3(0.12, 0.22, 0), size: 0.1, grow: 2 });
    }
    // high effort: headband on; full memory: steam out of the ears
    robot.headband.visible = d.effort === 'xhigh' || d.effort === 'max';
    if (d.brain === 'full' && awake && t > nextBrainSteam) {
      nextBrainSteam = t + 0.5;
      for (const side of [-1, 1]) emit('steam', worldPoint(robot.head, side * 0.45, 0.35, 0), { life: 1.2, vel: new THREE.Vector3(side * 0.25, 0.3, 0), size: 0.08, grow: 2.5 });
    }
    const hurried = d.hurry === '1';
    if ((screen === 'run' || (hurried && working)) && t > nextSweat) {
      nextSweat = t + (hurried ? 0.6 : 1.4);
      emit('sweat', worldPoint(robot.head, 0.36, 0.5, 0.1), { life: 0.9, vel: new THREE.Vector3(0.05, -0.35, 0), size: 0.08 });
    }
    if (pose === 'thinking' && scr !== 'helpers' && t > nextQuestion) {
      nextQuestion = t + 1.6;
      emit('question', worldPoint(robot.head, -0.15, 0.85, 0), { life: 1.4, vel: new THREE.Vector3(0, 0.15, 0), size: 0.17, spin: 1.5 });
    }
    // helper agents at work: little bots circling over the desk
    const helperHome = worldPoint(robot.head, 0, robot.headTop ?? 0.6, 0);
    minis.update(t, dt, {
      want: Math.min(6, Number(d.helpers) || 0),
      head: helperHome,
      center: helperHome.clone().lerp(LAYOUT.monitor, 0.2).setY(helperHome.y + 0.12),
      faceYaw: camYaw,
      hop: since('helper-step') < dt * 1.5,
      emit,
    });
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

    robot.sync?.();
    effect.render(scene, camera);
  }
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
    },
    // Is this point (client px) on the monitor's screen? (double-clicking it crashes the computer)
    hitsMonitor(clientX, clientY) {
      const r = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, 1 - ((clientY - r.top) / r.height) * 2);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects([set.office, robot.root], true)[0];
      return hit?.object.material === set.screen.material;
    },
    // Where the robot's head is on screen (CSS px within the canvas).
    headPosition() {
      const v = new THREE.Vector3(0, 0.3, 0);
      robot.head.localToWorld(v);
      v.project(camera);
      const r = renderer.domElement.getBoundingClientRect();
      return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height };
    },
    dispose() {
      cancelAnimationFrame(raf);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

window.Office3D = { mount };
