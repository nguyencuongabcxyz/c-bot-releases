// Jira juggling: three tickets in the air (your notes, if you have any), until one hits it in the face.
import { canvasTexture, toon } from '@/office3d/materials';
import * as THREE from 'three';
import { type HeadBox, scaleOf, headBox, popIn, E1, dispose } from './team-common';
import type { Antic } from './types';
import { armOf, at, aim, pose, blend, handAt, onceAt } from './common';
import { seg, bump, mix } from '@/office3d/core/math';

// scratch, so the frame loop doesn't allocate (one antic plays at a time)
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const PL = [0, 0, 0];
const QL = [0, 0, 0];
const QR = [0, 0, 0];
const HEAD = [0, 0, 0];
const Q1 = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();

// ------------------------------------------------------------ jira juggling

// Three tickets pop into its hands (0.1–0.4) and it juggles them over its head,
// a hand going up with each throw (0.5–4.0). The last throw goes wrong: URGENT!
// slaps flat onto its face at 4.0 (the other two drop in its lap), stays there
// till 5.0, then it peels it off (5.0–5.4) and the lot pop away.
const NOTES = [
  ['URGENT!', '#ffb347'],
  ['TODO', '#ff9ec7'],
  ['BUG-404', '#ffe066'],
];
// with notes of your own (robot.js passes up to three titles as "a|b|c" in data-antic-text),
// it juggles those instead: the first word or two of each
const shortTitle = (t: string) => {
  const words = t.replace(/\s+/g, ' ').trim().split(' ');
  const two = words.slice(0, 2).join(' ');
  return (two.length <= 14 ? two : words[0]).slice(0, 14);
};
const NOTE = 0.23;
const T0 = 0.5; // the first throw
const BEAT = 3.5 / 11; // a throw every beat, two beats in the air: the face one lands at 4.0
const LAST = [9, 7, 8]; // each ticket's last throw (beats); 9 is the one that hits the face
const HIT = 4.0;
const throwSide = (k: number) => (k % 2 ? 1 : -1); // even beats from the left hand, odd from the right

function buildNote(text: string, color: string) {
  const tex = canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.08)'; // the sticky strip
    ctx.fillRect(0, 0, w, 44);
    ctx.fillStyle = '#1d2235';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 92;
    do ctx.font = `900 ${size--}px "Segoe UI", sans-serif`;
    while (size > 30 && ctx.measureText(text).width > w - 28);
    ctx.fillText(text, w / 2, h / 2 + 10);
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(29,34,53,0.45)';
    ctx.beginPath();
    ctx.moveTo(40, 200);
    ctx.lineTo(w - 70, 200);
    ctx.stroke();
  });
  const paper = toon(color);
  const note = new THREE.Mesh(new THREE.BoxGeometry(NOTE, NOTE, 0.004), [
    paper,
    paper,
    paper,
    paper,
    new THREE.MeshToonMaterial({ map: tex.tex }),
    paper,
  ]);
  note.castShadow = true;
  return note;
}

// where a ticket is at time s: 'hand' (and which), 'air' (thrown at beat k, f of the way), or the face
type AirState = { mode: 'air'; k: number; f: number };
type NoteState = { mode: 'hand'; side: number } | AirState | { mode: 'face'; side: number };
function noteState(i: number, s: number): NoteState {
  const u = (s - T0) / BEAT;
  if (u < i) return { mode: 'hand', side: throwSide(i) };
  let k = i;
  while (k + 3 <= LAST[i] && k + 3 <= u) k += 3;
  const f = (u - k) / 2;
  if (f < 1) return { mode: 'air', k, f };
  return { mode: k === 9 ? 'face' : 'hand', side: -throwSide(k) };
}

// (hb and dropFrom are made along with the notes, on the first frame)
type JiraRun = { notes?: ReturnType<typeof buildNote>[]; hb: HeadBox; dropFrom: THREE.Vector3[] };

const jira: Antic<JiraRun> = {
  dur: 5.5,
  fadeOut: 0.2,
  update(c, A) {
    const { s, run } = c;
    const sc = scaleOf(c);
    if (!run.notes) {
      run.hb = headBox(c);
      const titles = String(c.text || '')
        .split('|')
        .map((t) => t.trim())
        .filter(Boolean);
      run.notes = NOTES.map(([text, color], i) => buildNote(titles[i] ? shortTitle(titles[i]) : text, color));
      for (const n of run.notes) c.set.office.add(n);
      run.dropFrom = [];
    }
    const { hb } = run;
    const { torso, head, root } = c.robot;
    // in torso space: the hands' spots either side, the top of the loop over its head
    const R = hb.hw + 0.17;
    const yH = armOf(c, 'R').shoulder.position.y - 0.08;
    const zH = 0.34;
    const apex = head.position.y + hb.top + 0.3;
    const u = (s - T0) / BEAT;
    const juggling = seg(s, 0.1, 0.45) * (1 - seg(s, HIT, HIT + 0.15));

    // the hands: up with each throw, a little give with each catch
    for (const [side, key, out, sd] of [
      ['L', 'armL', QL, -1],
      ['R', 'armR', QR, 1],
    ] as const) {
      let lift = 0;
      for (let k = sd < 0 ? 0 : 1; k <= 9; k += 2) lift += bump(u, k - 0.55, k + 0.45);
      at(c, torso, sd * (R - 0.06 * lift), yH + 0.17 * lift, zH, V1);
      const r = aim(c, side, V1, out, 1.5);
      // after the splat: a startled flinch, then the arms drop (the right one peels it off)
      const flinch = bump(s, HIT, HIT + 0.45);
      out[0] -= 0.5 * flinch;
      out[1] += 0.4 * flinch;
      pose(PL, A[key], s, [[0.1, 0.45, out]]);
      if (s > HIT) for (let i = 0; i < 3; i++) PL[i] = mix(out[i], A[key][i], seg(s, HIT + 0.3, HIT + 0.8));
      blend(A, key, PL, c.w);
      A[side === 'L' ? 'reachL' : 'reachR'] = mix(1, r, juggling * c.w);
    }
    // peel: the right hand to the note's corner, then away with it
    const peel = seg(s, 5.0, 5.15) * (1 - seg(s, 5.3, 5.5));
    if (peel > 0) {
      at(c, head, hb.hw * 0.25, hb.cy + NOTE * 0.35, hb.front + 0.03 + 0.25 * seg(s, 5.15, 5.35), V1);
      const r = aim(c, 'R', V1, QR, 1.6);
      blend(A, 'armR', QR, peel * c.w);
      A.reachR = mix(A.reachR, r, peel * c.w);
    }
    // eyes up on the tickets; knocked back by the splat
    HEAD[0] = A.head[0] - 0.22 * juggling - 0.25 * bump(s, HIT, HIT + 0.35) + 0.04 * Math.sin(u * Math.PI) * juggling;
    HEAD[1] = A.head[1] + Math.sin(u * Math.PI) * 0.1 * juggling;
    HEAD[2] = A.head[2] + 0.12 * seg(s, HIT + 0.3, HIT + 0.6) * (1 - seg(s, 5.0, 5.3)); // "…really?"
    blend(A, 'head', HEAD, c.w);
    A.lean = mix(A.lean, A.lean - 0.08 * juggling - 0.1 * bump(s, HIT, HIT + 0.4), c.w);

    // the tickets
    const size = popIn(s, 0.1, 5.38);
    for (let i = 0; i < 3; i++) {
      const n = run.notes[i];
      n.visible = size > 0.01;
      n.scale.setScalar(Math.max(0.001, size * sc));
      const st = noteState(i, s);
      if (st.mode === 'face' || (st.mode === 'air' && st.k === 9)) {
        if (s < HIT) {
          // the bad throw: up and over, straight onto its face
          const { f } = st as AirState; // (still in the air till it hits)
          at(c, torso, R, yH, zH, V1);
          at(c, head, 0, hb.cy, hb.front + 0.012, V2);
          n.position.lerpVectors(V1, V2, f);
          n.position.y += 4 * 0.42 * f * (1 - f);
          E1.set(0, c.camYaw, f * Math.PI * 2);
          Q1.setFromEuler(E1);
          head.getWorldQuaternion(Q2);
          n.quaternion.slerpQuaternions(Q1, Q2, seg(f, 0.55, 0.95));
        } else if (s < 5.15) {
          at(c, head, 0, hb.cy, hb.front + 0.012, n.position); // stuck
          head.getWorldQuaternion(n.quaternion);
        } else {
          // peeled off: hangs from the fingers by its corner
          handAt(c, 'R', n.position);
          head.getWorldQuaternion(n.quaternion);
          n.rotateZ(-0.6 * seg(s, 5.15, 5.35));
          n.rotateX(-0.5 * seg(s, 5.15, 5.35));
          n.translateY(-NOTE * 0.4 * sc);
        }
        continue;
      }
      if (s >= HIT) {
        // dropped in its lap when the other one hit
        run.dropFrom[i] ||= n.position.clone();
        const fall = seg(s, HIT, HIT + 0.45);
        at(c, root, i === 1 ? -0.14 : 0.12, 0.24, 0.3, V1);
        n.position.lerpVectors(run.dropFrom[i], V1, fall);
        n.position.y += 0.08 * bump(fall, 0, 1);
        E1.set(
          -1.35 * fall + Math.sin(s * 14) * 0.3 * (1 - fall),
          c.camYaw + (i === 1 ? 0.4 : -0.3) * fall,
          0.25 * fall,
          'YXZ',
        );
        n.quaternion.setFromEuler(E1);
        continue;
      }
      if (st.mode === 'hand') {
        handAt(c, st.side < 0 ? 'L' : 'R', n.position);
        n.position.y += NOTE * 0.45 * sc;
        n.position.x += 0.03 * i;
        E1.set(0, c.camYaw, st.side * 0.2);
      } else {
        // over the top: from one hand round to the other
        const sd = throwSide(st.k);
        const a = Math.PI * st.f;
        at(c, torso, sd * R * Math.cos(a), yH + (apex - yH) * Math.sin(a), zH + 0.06 * Math.sin(a), n.position);
        E1.set(0, c.camYaw, -sd * a * 1.4);
      }
      n.quaternion.setFromEuler(E1);
    }
    if (onceAt(c, 'splat', HIT)) {
      at(c, head, 0, hb.cy, hb.front + 0.05, V1);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        c.emit('star', V1, {
          life: 0.5,
          vel: new THREE.Vector3(Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0.2),
          size: 0.08,
          spin: 6,
        });
      }
    }
    if (onceAt(c, 'pop', 5.4)) {
      for (const n of run.notes) {
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          c.emit('star', n.position, {
            life: 0.45,
            vel: new THREE.Vector3(Math.cos(a) * 0.4, 0.3 + Math.sin(a) * 0.3, 0),
            size: 0.06,
            spin: 5,
          });
        }
      }
    }
  },
  end(c) {
    for (const n of c.run?.notes || []) dispose(n);
  },
};

export const JIRA: Record<string, Antic> = { jira };
