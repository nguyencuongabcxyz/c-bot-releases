// Payday: the salary lands in its wallet (cha-ching), then the bills fly out of it one by one.
import type { Vec3Tuple, Antic } from './types';
import * as THREE from 'three';
import { canvasTexture, noOutline, toon } from '@/office3d/materials';
import { mesh, isMesh } from '@/office3d/core/mesh';
import { type Mat, propScale, popScale, grip, sigh, disposeTree } from './calendar-common';
import { at, blend, onceAt } from './common';
import { mix, seg, bump } from '@/office3d/core/math';

// scratch, so the frame loop doesn't allocate (one antic plays at a time)
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const PL: Vec3Tuple = [0, 0, 0];
const HEAD: Vec3Tuple = [0, 0, 0];
const QT = new THREE.Quaternion();

// ------------------------------------------------------------ payday

// Payday! Money rains down (0.3–2.8) and it cheers, arms up; then it pulls out
// its tiny wallet (3.0), opens it (3.4) and a moth flutters out (3.6). A long
// sad sigh (4.2–5.8). The monitor shows the bank app the whole time.
// robot.js: ka-ching 0.3, speech 4.2.
const BILLS = 16;
const WALLET_W = 0.085;
const WALLET_H = 0.065;
const WALLET_T = 0.012;
const CHEER: Vec3Tuple = [-2.55, 0.75, -0.3]; // arms up in a V (in front of the head, so you see them)
let billTex: THREE.CanvasTexture | null = null;
let mothTex: THREE.CanvasTexture | null = null;
function paydayTextures() {
  billTex ||= canvasTexture(128, 128, (ctx) => {
    ctx.font = '104px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('💵', 64, 70);
  }).tex;
  mothTex ||= canvasTexture(64, 64, (ctx) => {
    ctx.strokeStyle = '#1d2235';
    ctx.lineWidth = 2.5;
    for (const side of [-1, 1]) {
      for (const [y, rx, ry, col] of [
        [26, 18, 13, '#b9ad97'],
        [40, 12, 9, '#9e917b'],
      ] as const) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.ellipse(32 + side * (rx + 1), y, rx, ry, side * 0.35, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = '#6f6452';
      ctx.beginPath();
      ctx.arc(32 + side * 18, 25, 3.5, 0, 7);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(32 + side * 2, 16);
      ctx.quadraticCurveTo(32 + side * 6, 6, 32 + side * 12, 5);
      ctx.stroke();
    }
    ctx.fillStyle = '#5b5143';
    ctx.beginPath();
    ctx.ellipse(32, 32, 4, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }).tex;
}
function sprite(tex: THREE.Texture | null) {
  const mat = noOutline(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  const sp = new THREE.Sprite(mat);
  sp.visible = false;
  return sp;
}
function buildWallet() {
  const wallet = new THREE.Group();
  const inner = new THREE.Group(); // shifts so it stays centred as it opens
  wallet.add(inner);
  const leather = toon('#8b5a2b');
  const lining = toon('#d9b48a');
  const box = new THREE.BoxGeometry(WALLET_W, WALLET_H, WALLET_T);
  inner.add(mesh(box, [leather, leather, leather, leather, lining, leather], WALLET_W / 2, 0, 0));
  const cover = new THREE.Group(); // the front half, hinged at the spine (x = 0)
  cover.position.z = WALLET_T;
  cover.add(mesh(box, [leather, leather, leather, leather, leather, lining], WALLET_W / 2, 0, 0));
  // an empty card slot inside the cover
  cover.add(
    mesh(
      new THREE.BoxGeometry(WALLET_W * 0.75, 0.008, 0.002),
      toon('#a87a4c'),
      WALLET_W / 2,
      0.01,
      -WALLET_T / 2 - 0.001,
    ),
  );
  inner.add(cover);
  wallet.traverse((o) => {
    if (isMesh<THREE.Mesh<THREE.BufferGeometry, Mat | Mat[]>>(o)) o.castShadow = true;
  });
  return { wallet, inner, cover };
}

// (the rest is set with bills, on the first frame)
type PaydayRun = {
  bills?: THREE.Sprite[];
  moth: THREE.Sprite;
  wallet: ReturnType<typeof buildWallet>;
  mid: THREE.Vector3;
  top: number;
};

const payday: Antic<PaydayRun> = {
  dur: 6.0,
  update(c, A) {
    const { s, run } = c;
    const { torso, head } = c.robot;
    A.screen = 'payday';
    const k = propScale(c);
    if (!run.bills) {
      paydayTextures();
      run.bills = Array.from({ length: BILLS }, () => sprite(billTex));
      run.moth = sprite(mothTex);
      run.wallet = buildWallet();
      c.set.office.add(...run.bills, run.moth, run.wallet.wallet);
      // the rain falls in a box around the chair, from above the head to below the seat
      run.mid = at(c, c.robot.root, 0, 0, 0.15, new THREE.Vector3());
      run.top = at(c, head, 0, (c.robot.headTop ?? 0.6) + 0.9, 0, new THREE.Vector3()).y;
    }
    // money rain: each bill drops in turn, fluttering and spinning
    run.bills.forEach((b, i) => {
      const t0 = 0.3 + (i / BILLS) * 1.55 + Math.sin(i * 7.3) * 0.06; // all down by 2.8
      const u = (s - t0) / 0.95;
      b.visible = u > 0 && u < 1;
      if (!b.visible) return;
      b.position.set(
        run.mid.x + (((i * 0.618) % 1) - 0.5) * 1.0 + Math.sin(u * 8 + i) * 0.06,
        mix(run.top, run.mid.y - 0.25, u),
        run.mid.z + Math.cos(i * 4.1) * 0.3,
      );
      b.material.rotation = Math.sin(u * 7 + i) * 0.7;
      b.material.opacity = Math.min(1, (1 - u) / 0.2, u / 0.08);
      b.scale.setScalar(0.17 * k);
    });
    // cheering, arms up and bouncing
    const yay = seg(s, 0.3, 0.55) * (1 - seg(s, 2.6, 2.95));
    for (const [key, ph] of [
      ['armL', 0],
      ['armR', 1.3],
    ] as const) {
      for (let i = 0; i < 3; i++) PL[i] = CHEER[i];
      PL[1] += Math.sin(s * 14 + ph) * 0.18;
      blend(A, key, PL, yay * c.w);
    }
    A.rootY += 0.05 * Math.abs(Math.sin(s * 8)) * yay * c.w;

    // the wallet: in both hands in front of the chest; lowered to the lap for the sigh
    const { wallet, inner, cover } = run.wallet;
    const hy = head.position.y;
    const sad = seg(s, 4.2, 4.9) * (1 - seg(s, 5.6, 5.9));
    const wy = mix(hy - 0.27, hy - 0.42, sad);
    const wz = mix(0.38, 0.33, sad);
    const size = popScale(s, 3.0, 5.6) * k * 1.9;
    const open = seg(s, 3.4, 3.6);
    at(c, torso, 0, wy + 0.06 * k, wz, wallet.position);
    torso.getWorldQuaternion(wallet.quaternion);
    wallet.quaternion.multiply(QT.setFromAxisAngle(V1.set(1, 0, 0), -0.55)); // tipped up to look into
    wallet.scale.setScalar(Math.max(0.001, size));
    wallet.visible = size > 0;
    cover.rotation.y = -2.9 * open + Math.sin(s * 30) * 0.05 * bump(s, 3.0, 3.35); // a fiddle, then open
    inner.position.x = (-WALLET_W / 2) * (1 - open);
    const half = (mix(0.55, 0.95, open) * WALLET_W * size) / c.robot.root.scale.x; // (torso space)
    grip(
      c,
      A,
      at(c, torso, -half, wy, wz + 0.02, V1),
      at(c, torso, half, wy, wz + 0.02, V2),
      seg(s, 2.75, 3.05) * (1 - seg(s, 5.5, 5.9)) * c.w,
    );

    // ...and out flutters a moth, up and away to your right
    const fly = s - 3.6;
    const moth = run.moth;
    moth.visible = fly > 0 && fly < 1.8;
    if (moth.visible) {
      moth.position.copy(wallet.position);
      moth.position.x += fly * 0.4 + Math.sin(fly * 9) * 0.07;
      moth.position.y += 0.06 + fly * 0.65 + Math.sin(fly * 13) * 0.04;
      moth.position.z += 0.05 + fly * 0.15;
      const sz = 0.2 * k * Math.min(1, fly / 0.15);
      moth.scale.set(sz * (0.35 + 0.65 * Math.abs(Math.sin(fly * 26))), sz, 1);
      moth.material.opacity = Math.min(1, (1.8 - fly) / 0.4);
    }
    if (onceAt(c, 'dust', 3.45)) {
      for (let i = 0; i < 3; i++)
        c.emit('steam', wallet.position, {
          life: 0.7,
          vel: new THREE.Vector3((i - 1) * 0.15, 0.25, 0.05),
          size: 0.04,
          grow: 2.2,
        });
    }

    // head: up at the money; down into the wallet; after the moth; then hung low
    const peek = seg(s, 3.0, 3.25) * (1 - seg(s, 3.6, 3.8));
    const follow = seg(s, 3.6, 3.8) * (1 - seg(s, 4.2, 4.6));
    // (never so far down that the face goes out of view)
    HEAD[0] = -0.2 * yay + 0.2 * peek - 0.3 * follow + 0.12 * sad;
    HEAD[1] = -0.35 * follow * Math.min(1, fly + 0.3);
    HEAD[2] = 0.24 * sad;
    blend(A, 'head', HEAD, c.w);
    A.lean = mix(A.lean, mix(-0.04 * yay + 0.06 * peek, 0.1, sad), c.w);
    A.rootY -= 0.03 * sad * c.w;
    if (onceAt(c, 'sigh', 4.35)) sigh(c, -0.7);
  },
  end(c) {
    const { run } = c;
    if (!run?.bills) return;
    for (const sp of [...run.bills, run.moth]) {
      sp.removeFromParent();
      sp.material.dispose(); // (the shared textures are kept for next payday)
    }
    disposeTree(run.wallet.wallet);
  },
};

export const PAYDAY: Record<string, Antic> = { payday };
