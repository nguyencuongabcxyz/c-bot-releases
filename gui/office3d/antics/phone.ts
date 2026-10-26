import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toon, canvasTexture, noOutline, roundRect } from '@/office3d/materials';
import type { Antic, TickCtx, Vec3Tuple } from './types';

// Doom scrolling. A phone pops into its hand and it flicks through a feed that
// really scrolls, the screen lighting up its face.
//   phone       awake and idle: looks down at the phone, scrolls, laughs at something
//   sleepphone  asleep in the chair: slides its eye mask up, scrolls with the phone
//               held over its face ("…just one more"), then mask down, back to sleep
// Timings are a contract: robot.js plays sounds and faces at the marked moments
// (phone: pop 0.4, flicks, 😂 at 3.4; sleepphone: eyes open 0.5, pop 0.6, eyes shut 7.3).

const HAND = 0.24; // how far down the forearm the hand is
const SIZE = 1.8; // bigger than life, so it reads in the small window
const FEED_W = 64;
const FEED_H = 128;

type Side = 'L' | 'R';
type Span = [number, number];

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const seg = (s: number, a: number, b: number) => smooth((s - a) / (b - a));

// scratch
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const AIM = new THREE.Vector3();
const QR: Vec3Tuple = [0, 0, 0];
const HEAD: Vec3Tuple = [0, 0, 0];

const at = (c: TickCtx, obj: THREE.Object3D, x: number, y: number, z: number, out: THREE.Vector3) => c.set.office.worldToLocal(obj.localToWorld(out.set(x, y, z)));

// Arm angles [pitch, out, elbow] that put the hand on a point (office space): the
// same two-bone reach as awake.js; returns the stretch needed if it's too far.
function aim(c: TickCtx, side: Side, p: THREE.Vector3, out: Vec3Tuple, most = 1.9) {
  const arm = c.robot.arms[side === 'L' ? 'armL' : 'armR'];
  const v = c.robot.torso.worldToLocal(c.set.office.localToWorld(AIM.copy(p))).sub(arm.shoulder.position);
  const u = Math.abs(arm.elbow.position.y) || 0.2;
  const L = Math.max(1e-4, v.length());
  out[0] = Math.atan2(-v.z, -v.y);
  out[1] = Math.asin(clamp(v.x / L, -1, 1)) * arm.side;
  if (L >= u + HAND) {
    out[2] = 0;
    return clamp(L / (u + HAND), 1, most);
  }
  out[2] = -(Math.PI - Math.acos(clamp((u * u + HAND * HAND - L * L) / (2 * u * HAND), -1, 1)));
  out[0] += Math.acos(clamp((u * u + L * L - HAND * HAND) / (2 * u * L), -1, 1));
  return 1;
}

// the feed: an endless column of posts (a photo, a name, a few lines), drawn at an offset
const POST_H = 46;
const PHOTOS = ['#ff8a80', '#ffd180', '#80d8ff', '#b9f6ca', '#ea80fc', '#ffab91', '#a7ffeb'];
function drawFeed(ctx: CanvasRenderingContext2D, offset: number) {
  ctx.fillStyle = '#f4f6fb';
  ctx.fillRect(0, 0, FEED_W, FEED_H);
  const first = Math.floor(offset / POST_H);
  for (let i = first; i < first + 4; i++) {
    const y = i * POST_H - offset + 8;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, 4, y, FEED_W - 8, POST_H - 6, 5);
    ctx.fill();
    ctx.fillStyle = PHOTOS[((i % PHOTOS.length) + PHOTOS.length) % PHOTOS.length];
    ctx.fillRect(7, y + 9, FEED_W - 14, 20);
    ctx.fillStyle = '#c4c9d6';
    ctx.beginPath();
    ctx.arc(10, y + 5, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(15, y + 3.5, 18 + (i % 3) * 5, 3);
    ctx.fillRect(7, y + 32, FEED_W - 22 - (i % 2) * 10, 2.5);
  }
  // the app's top bar
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, FEED_W, 7);
  ctx.fillStyle = '#ff4f7b';
  ctx.fillRect(4, 2, 14, 3);
}

function buildPhone() {
  const phone = new THREE.Group();
  const body = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.145, 0.012, 2, 0.01), toon('#1d2235'));
  phone.add(body);
  const feed = canvasTexture(FEED_W, FEED_H);
  drawFeed(feed.ctx, 0);
  feed.tex.needsUpdate = true;
  const screenMat = new THREE.MeshBasicMaterial({ map: feed.tex });
  noOutline(screenMat);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.066, 0.132), screenMat);
  screen.position.z = 0.0065;
  phone.add(screen);
  // the screen's glow on its face
  const light = new THREE.PointLight('#9fd3ff', 0, 0.8, 1.5);
  light.position.z = 0.16; // out in front of the screen: on its face, not its fingers
  phone.add(light);
  return { phone, feed, light, offset: 0, drawn: -1 };
}
type Phone = ReturnType<typeof buildPhone>;

// (three's types only put isMesh on a Mesh) the phone's meshes have one material
// each, toon or basic, so `map` may be there
type PhoneMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial | THREE.MeshBasicMaterial>;
const isMesh = (o: THREE.Object3D): o is PhoneMesh => 'isMesh' in o && !!o.isMesh;

function dispose(obj: THREE.Object3D) {
  obj.removeFromParent();
  obj.traverse((o) => {
    if (!isMesh(o)) return;
    o.geometry.dispose();
    o.material.map?.dispose();
    o.material.dispose();
  });
}

// T: when things happen (seconds). asleep: held over its face, lying back in the chair.
type Times = { up: Span; pop: number; scroll: Span; every: number; down: Span; away: number; mask?: Span; maskBack?: Span; say?: [number, number, string, 'speech' | 'thought'] };
// (from / to are set at the first flick, before they're read)
type ScrollRun = { p?: Phone; mask?: THREE.Object3D | null; flick?: number; from: number; to: number };
function scroller({ dur, T, asleep }: { dur: number; T: Times; asleep: boolean }): Antic<ScrollRun> {
  return {
    dur,
    fadeIn: 0.35,
    fadeOut: 0.5,
    update(c, A) {
      const { s, run } = c;
      if (!run.p) {
        run.p = buildPhone();
        c.set.office.add(run.p.phone);
        run.mask = asleep ? c.robot.head.getObjectByName('sleep-mask') : null;
      }
      const p = run.p;
      const top = c.robot.headTop ?? 0.6;
      // where it holds the phone: over its face when lying back asleep, lower and
      // closer when it's looking down at it awake (head space, so it follows the head)
      // asleep: held up on the arm's own side, above and in front of its face (the arm doesn't cross it)
      const side = Math.sign(c.robot.arms.armR.shoulder.position.x) || 1;
      if (asleep) at(c, c.robot.head, side * top * 0.36, top * 0.66, top * 0.5 + 0.34, V2);
      else at(c, c.robot.head, 0, top * 0.1, top * 0.5 + 0.3, V2);
      const hold = seg(s, T.up[0], T.up[1]) * (1 - seg(s, T.down[0], T.down[1]));
      // a thumb flick now and then: the hand jerks up a touch and the feed jumps a post
      const scrolling = s > T.scroll[0] && s < T.scroll[1];
      const flickAt = Math.floor((s - T.scroll[0]) / T.every);
      const since = (s - T.scroll[0]) - flickAt * T.every;
      if (scrolling && flickAt !== run.flick) {
        run.flick = flickAt;
        run.from = p.offset;
        run.to = p.offset + POST_H * (0.8 + Math.random() * 1.6);
      }
      if (scrolling) p.offset = mix(run.from, run.to, 1 - Math.exp(-since * 9));
      V2.y += scrolling ? 0.012 * Math.exp(-since * 14) : 0;
      const r = aim(c, 'R', V2, QR, 2.2);
      for (let i = 0; i < 3; i++) A.armR[i] = mix(A.armR[i], QR[i], hold * c.w);
      A.reachR = mix(A.reachR, r, hold * c.w);
      if (!asleep) A.lean = mix(A.lean, 0.12, hold * c.w); // hunched over it

      // the phone sits just beyond its fingers; its screen faces somewhere between its
      // face and you, so you catch the glowing feed too. It pops in and pops away.
      at(c, c.robot.arms.armR.elbow, 0, -HAND - 0.07, 0, p.phone.position);
      at(c, c.robot.head, 0, top * 0.5, top * 0.5, V1);
      const toYou = asleep ? 0.85 : 0.45; // held over its face, it needs tipping further your way
      V1.x += Math.sin(c.camYaw) * toYou;
      V1.z += Math.cos(c.camYaw) * toYou;
      V1.y += 0.1;
      p.phone.lookAt(c.set.office.localToWorld(V1.clone()));
      const size = s < T.pop ? 0 : s < T.pop + 0.2 ? smooth((s - T.pop) / 0.2) * 1.12 : s < T.pop + 0.35 ? 1.12 - 0.12 * smooth((s - T.pop - 0.2) / 0.15) : s < T.away ? 1 : Math.max(0, 1 - (s - T.away) / 0.25);
      p.phone.scale.setScalar(Math.max(0.001, size * SIZE * (c.robot.root.scale.x / 0.82)));
      p.phone.visible = size > 0.01;
      p.light.intensity = 0.4 * size;
      const shown = Math.round(p.offset);
      if (shown !== p.drawn) {
        p.drawn = shown;
        drawFeed(p.feed.ctx, shown);
        p.feed.tex.needsUpdate = true;
      }

      // eyes on the screen: the head tips towards it (asleep it's already lying back)
      HEAD[0] = A.head[0] + (asleep ? 0.1 : 0.32) * hold;
      HEAD[1] = A.head[1];
      HEAD[2] = A.head[2] * (1 - 0.6 * hold);
      for (let i = 0; i < 3; i++) A.head[i] = mix(A.head[i], HEAD[i], c.w);

      // asleep: the eye mask slides up onto its forehead, and back down at the end
      // (there's only a mask asleep, and the asleep timings have mask / maskBack)
      if (run.mask) run.mask.position.y = 0.17 * top * seg(s, T.mask![0], T.mask![1]) * (1 - seg(s, T.maskBack![0], T.maskBack![1]));
      if (T.say && s > T.say[0] && s < T.say[1]) c.say(T.say[2], T.say[3]);
    },
    end(c) {
      const { run } = c;
      if (run?.mask) run.mask.position.y = 0;
      if (run?.p) dispose(run.p.phone);
    },
  };
}

export const PHONE: Record<string, Antic> = {
  phone: scroller({
    dur: 7,
    asleep: false,
    T: { up: [0.1, 0.6], pop: 0.4, scroll: [0.9, 6.0], every: 0.8, down: [6.2, 6.8], away: 6.3, say: [3.4, 4.8, '😂', 'speech'] },
  }),
  sleepphone: scroller({
    dur: 8,
    asleep: true,
    T: { mask: [0.2, 0.7], up: [0.4, 1.0], pop: 0.6, scroll: [1.1, 6.6], every: 0.9, down: [6.7, 7.2], away: 6.8, maskBack: [7.1, 7.6], say: [3.6, 5.2, '…just one more', 'thought'] },
  }),
};
