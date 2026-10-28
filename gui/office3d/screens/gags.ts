// The office gags' screens (antics desk.ts, team.ts, calendar.ts): a hung app, the accepted answer,
// a merge conflict, works-on-my-machine, payday. Each drawn with t = seconds into the antic.
import { INK, SCREEN_W, SCREEN_H } from '@/office3d/core/constants';
import { roundRect } from '../materials';
import { hash, bg } from './draw';
import type { ScreenScene } from '../themes';

// ---- helpers for the office gags

// one copy of the hung window (all of them, in the trail, look the same)
export function frozenWindow(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const W = 236;
  const H = 150;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(x + 3, y + 3, W, H);
  ctx.fillStyle = '#1e1f29';
  ctx.fillRect(x, y, W, H);
  const code: [string, number][] = [
    ['#ff8fb1', 0.35],
    ['#7ff3ff', 0.6],
    ['#ffd34d', 0.45],
    ['#a29bfe', 0.7],
    ['#7bed9f', 0.4],
    ['#7ff3ff', 0.55],
    ['#ff8fb1', 0.3],
  ];
  code.forEach(([color, w], i) => {
    ctx.fillStyle = color;
    ctx.fillRect(x + 12 + (i % 3) * 10, y + 30 + i * 16, 190 * w, 7);
  });
  // "ghosted": washed out white
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  ctx.fillRect(x, y + 18, W, H - 18);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, W, 18);
  ctx.fillStyle = '#1d2235';
  ctx.font = '600 10px "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Code.exe (Not Responding)', x + 7, y + 13);
  ctx.fillStyle = '#8a90a6';
  ctx.fillText('—  ☐', x + W - 50, y + 13);
  ctx.fillStyle = '#e81123';
  ctx.fillRect(x + W - 18, y, 18, 18);
  ctx.fillStyle = '#fff';
  ctx.fillText('✕', x + W - 13, y + 13);
  ctx.strokeStyle = '#7a8094';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, W - 1, H - 1);
}

export function arrow(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + 17);
  ctx.lineTo(x + 4.5, y + 13);
  ctx.lineTo(x + 8, y + 20);
  ctx.lineTo(x + 10.5, y + 19);
  ctx.lineTo(x + 7, y + 12);
  ctx.lineTo(x + 12, y + 12);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}
export const WHEEL = ['#ff5e62', '#ff9f43', '#ffd34d', '#7bed9f', '#5ac8fa', '#a29bfe'];

// ▲ count ▼, Stack Overflow style
export function votes(ctx: CanvasRenderingContext2D, x: number, y: number, n: string) {
  ctx.fillStyle = '#bbc0c4';
  ctx.beginPath();
  ctx.moveTo(x - 7, y + 8);
  ctx.lineTo(x + 7, y + 8);
  ctx.lineTo(x, y);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 7, y + 26);
  ctx.lineTo(x + 7, y + 26);
  ctx.lineTo(x, y + 34);
  ctx.fill();
  ctx.fillStyle = '#6a737c';
  ctx.font = '700 9px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(n, x, y + 21);
  ctx.textAlign = 'left';
}

// the merge conflict, a block at a time (m* are marker lines)
export type MergeKind = 'code' | 'mHead' | 'ours' | 'mMid' | 'theirs' | 'mEnd';
export const MERGE_BLOCK: MergeKind[] = [
  'code',
  'mHead',
  'ours',
  'ours',
  'mMid',
  'theirs',
  'theirs',
  'theirs',
  'mEnd',
  'code',
  'code',
];
export const MERGE_BG: Record<MergeKind, string> = {
  code: '#1e1f29',
  mHead: '#2d6b4a',
  ours: 'rgba(47,191,113,0.25)',
  mMid: '#3a3c4e',
  theirs: 'rgba(255,94,98,0.25)',
  mEnd: '#8a2f3a',
};
// (a marker's line, or the lines to pick from)
export const MERGE_TEXT: Record<MergeKind, string | string[]> = {
  mHead: '<<<<<<< HEAD',
  mMid: '=======',
  mEnd: '>>>>>>> feature/fix-everything',
  code: ['function deploy(env) {', '  const ok = check();', '}', '// TODO: fix', 'export default app;'],
  ours: ['  return fixEverything();', '  if (env === "prod") panic();', '  retries = 3;'],
  theirs: ['  return fixEverything(true);', '  if (env == "prod") pray();', '  retries = Infinity;', '  // trust me'],
};
export const MERGE_STRAY = ['<<<<<<<', '=======', '>>>>>>>', 'HEAD', '<<<<<<< HEAD', '>>>>>>> fix'];

// "works on my machine": its stamp, drawn once (with ink gaps) and reused
export const WORKS_AT = 1.8;
export const STAMP_W = 250;
export const STAMP_H = 96;
export const WORKS_LINES: [string, string][] = [
  ['$ npm test', '#d6d9e8'],
  [' PASS  src/app.test.js', '#7bed9f'],
  ['Tests: 42 passed, 42 total', '#d6d9e8'],
];
export let stamp: HTMLCanvasElement | null = null;
export function worksStamp() {
  if (stamp) return stamp;
  stamp = document.createElement('canvas');
  stamp.width = STAMP_W;
  stamp.height = STAMP_H;
  const s = stamp.getContext('2d') as CanvasRenderingContext2D; // (a canvas's first 2d context)
  s.strokeStyle = s.fillStyle = '#19b35a';
  s.lineWidth = 6;
  roundRect(s, 4, 4, STAMP_W - 8, STAMP_H - 8, 12);
  s.stroke();
  s.lineWidth = 2;
  roundRect(s, 12, 12, STAMP_W - 24, STAMP_H - 24, 7);
  s.stroke();
  s.textAlign = 'center';
  s.textBaseline = 'middle';
  s.font = '900 27px "Segoe UI", sans-serif';
  s.fillText('WORKS ON', STAMP_W / 2 + 16, 34);
  s.fillText('MY MACHINE', STAMP_W / 2, 64);
  s.font = '25px "Segoe UI Emoji", sans-serif';
  s.fillText('✅', 46, 34);
  // speckles of missing ink
  s.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 160; i++) {
    s.beginPath();
    s.arc(hash(i, 31) * STAMP_W, hash(i, 32) * STAMP_H, 0.6 + hash(i, 33) * 1.6, 0, 7);
    s.fill();
  }
  return stamp;
}

// payday: [label, amount, when it lands]; the bills take 0.3 s to come off the balance
export const PAYDAY_IN = 4250;
export const PAYDAY_LINES: [string, number, number][] = [
  ['Salary 💼', PAYDAY_IN, 0.3],
  ['Rent', -1800, 4.0],
  ['Coffee ☕', -612.4, 4.45],
  ['Subscriptions', -1834.43, 4.9],
];
export function paydayBalance(t: number) {
  // counts up fast (easing out) over 0.3–2.5
  const u = Math.min(1, Math.max(0, (t - 0.3) / 2.2));
  let b = PAYDAY_IN * (1 - (1 - u) ** 3);
  for (const [, amount, at] of PAYDAY_LINES) if (amount < 0) b += amount * Math.min(1, Math.max(0, (t - at) / 0.3));
  return Math.max(0, b);
}
export function money(n: number) {
  const [whole, cents] = n.toFixed(2).split('.');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}

export const GAG_SCENES: Record<string, ScreenScene> = {
  // ---- office gags (desk.js, team.js, calendar.js) borrow the screen for these

  // a hung app: title "(Not Responding)", washed-out content, a spinner that never
  // stops, and the trail of copies it leaves behind when it's dragged about
  frozen(ctx, t) {
    bg(ctx, '#2f6aa8');
    const n = Math.min(7, Math.floor(t * 2.5));
    for (let i = 0; i <= n; i++) frozenWindow(ctx, 12 + i * 7, 10 + i * 5);
    // the cursor: wiggled about in frustration, the wheel spinning all the while
    const wig = Math.min(1, t / 2);
    const x = 150 + n * 7 + Math.sin(t * 9) * 10 * wig;
    const y = 95 + n * 5 + Math.sin(t * 13) * 6 * wig;
    arrow(ctx, x, y);
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = WHEEL[i];
      ctx.beginPath();
      ctx.moveTo(x + 18, y + 22);
      ctx.arc(x + 18, y + 22, 10, t * 7 + (i * Math.PI) / 3, t * 7 + ((i + 1) * Math.PI) / 3);
      ctx.fill();
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x + 18, y + 22, 10, 0, 7);
    ctx.stroke();
  },

  // the accepted answer to the one question everyone has: the code block gets
  // selected at 1.6–1.8, just before Ctrl+C
  stackoverflow(ctx, t) {
    bg(ctx, '#ffffff');
    // the top bar: logo (a tray with papers stacking up out of it), name, search
    ctx.fillStyle = '#f48024';
    ctx.fillRect(0, 0, SCREEN_W, 24);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(9, 10);
    ctx.lineTo(9, 19);
    ctx.lineTo(23, 19);
    ctx.lineTo(23, 10);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 4; i++) {
      ctx.save();
      ctx.translate(16, 16 - i * 3.2);
      ctx.rotate(-i * 0.22);
      ctx.fillRect(-5 + i * 0.6, -1, 9, 2);
      ctx.restore();
    }
    ctx.textAlign = 'left';
    ctx.font = '400 12px "Segoe UI", sans-serif';
    ctx.fillText('stack', 29, 16);
    ctx.font = '700 12px "Segoe UI", sans-serif';
    ctx.fillText('overflow', 59, 16);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    roundRect(ctx, 150, 5, 120, 14, 4);
    ctx.fill();
    ctx.fillStyle = '#9199a1';
    ctx.font = '400 9px "Segoe UI", sans-serif';
    ctx.fillText('Search…', 156, 15);
    ctx.fillStyle = '#ffd34d';
    ctx.beginPath();
    ctx.arc(296, 12, 7, 0, 7);
    ctx.fill();
    // the question
    ctx.fillStyle = '#0063bf';
    ctx.font = '700 17px "Segoe UI", sans-serif';
    ctx.fillText('How do I exit vim?', 12, 45);
    ctx.fillStyle = '#6a737c';
    ctx.font = '400 8px "Segoe UI", sans-serif';
    ctx.fillText('Asked 13 years ago · Viewed 2.9m times', 12, 57);
    ctx.fillStyle = '#e3e6e8';
    ctx.fillRect(12, 62, 296, 1);
    votes(ctx, 24, 70, '4.2k');
    ctx.fillStyle = '#232629';
    ctx.font = '400 9px "Segoe UI", sans-serif';
    ctx.fillText("I opened a file and now I can't leave.", 46, 79);
    ctx.fillText("It's been three days. Please help.", 46, 92);
    ctx.fillStyle = '#e3e6e8';
    ctx.fillRect(12, 102, 296, 1);
    // the accepted answer
    votes(ctx, 24, 110, '9.1k');
    ctx.strokeStyle = '#2f9e44';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(16, 162);
    ctx.lineTo(22, 168);
    ctx.lineTo(32, 155);
    ctx.stroke();
    ctx.fillStyle = '#232629';
    ctx.font = '400 9px "Segoe UI", sans-serif';
    ctx.fillText('Press Esc, then type:', 46, 118);
    ctx.fillStyle = '#f1f2f3';
    roundRect(ctx, 46, 124, 200, 44, 4);
    ctx.fill();
    // the selection sweeps over the two lines of code
    const sel = Math.min(1, Math.max(0, (t - 1.6) / 0.2));
    const CODE = [':wq   " save and quit', ':q!   " just quit'];
    ctx.font = '700 13px Consolas, "Courier New", monospace';
    CODE.forEach((line, i) => {
      const k = Math.min(1, Math.max(0, sel * 2 - i));
      const w = ctx.measureText(line).width;
      if (k > 0) {
        ctx.fillStyle = '#9fc4f5';
        ctx.fillRect(52, 129 + i * 18, w * k + 2, 16);
      }
      ctx.fillStyle = '#0c0d0e';
      ctx.fillText(line.slice(0, 5), 54, 142 + i * 18);
      ctx.fillStyle = '#7d8790';
      ctx.fillText(line.slice(5), 54 + ctx.measureText(line.slice(0, 5)).width, 142 + i * 18);
    });
    ctx.fillStyle = '#6a737c';
    ctx.font = '400 8px "Segoe UI", sans-serif';
    ctx.fillText('answered Jan 2012 · edited by 412 people', 46, 182);
    // the text cursor: over to the code, then dragging across it
    const go = Math.min(1, Math.max(0, (t - 1.0) / 0.6));
    const ix = sel > 0 ? 54 + 120 * sel : 230 - 176 * go * go * (3 - 2 * go);
    const iy = sel > 0 ? 135 + 18 * sel : 190 - 55 * go;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ix - 3, iy - 7);
    ctx.lineTo(ix + 3, iy - 7);
    ctx.moveTo(ix, iy - 7);
    ctx.lineTo(ix, iy + 7);
    ctx.moveTo(ix - 3, iy + 7);
    ctx.lineTo(ix + 3, iy + 7);
    ctx.stroke();
  },

  // a merge conflict, scrolling slowly by, and getting worse the longer you look
  merge(ctx, t) {
    const chaos = Math.min(1, t / 7);
    const shake = chaos > 0.6 ? (hash(Math.floor(t * 20), 7) - 0.5) * 4 * chaos : 0;
    bg(ctx, '#1e1f29');
    ctx.translate(shake, 0);
    ctx.fillStyle = '#262838';
    ctx.fillRect(0, 0, 26, SCREEN_H);
    ctx.font = '700 10px Consolas, "Courier New", monospace';
    ctx.textAlign = 'left';
    const LH = 14;
    const scroll = t * 11;
    const first = Math.floor(scroll / LH);
    const tick = Math.floor(t * 8);
    for (let k = -1; k < 14; k++) {
      const line = first + k;
      const y = 4 + k * LH - (scroll % LH);
      if (line < 0) continue;
      const kind = MERGE_BLOCK[line % MERGE_BLOCK.length];
      const jx = (hash(line, tick) - 0.5) * 8 * chaos * chaos;
      ctx.fillStyle = MERGE_BG[kind];
      ctx.fillRect(26, y, SCREEN_W, LH);
      ctx.fillStyle = '#5c6080';
      ctx.fillText(String(line + 1).padStart(3), 4, y + 10);
      let text = MERGE_TEXT[kind];
      if (kind === 'ours' || kind === 'theirs' || kind === 'code') text = text[Math.floor(hash(line, 1) * text.length)];
      // (a line by now: the markers' text is one, and one was just picked from the others' lists)
      // later on the markers start to stutter and breed
      if (kind[0] === 'm' && hash(line, 2) < chaos)
        text = (text as string).replace(/^(.)\1+/, (m) => m + m.slice(0, 3 + Math.floor(hash(line, tick) * 6)));
      ctx.fillStyle = kind[0] === 'm' ? '#ffffff' : '#d6d9e8';
      ctx.fillText(text as string, 32 + jx, y + 10);
    }
    // stray markers spraying across the screen as it falls apart
    const strays = Math.floor(chaos * chaos * 14);
    const roll = Math.floor(t * 4);
    for (let i = 0; i < strays; i++) {
      ctx.fillStyle = hash(i, roll) < 0.5 ? '#ff6b81' : '#7bed9f';
      ctx.fillText(
        MERGE_STRAY[Math.floor(hash(i, roll + 3) * MERGE_STRAY.length)],
        hash(i, roll + 1) * 260,
        10 + hash(i, roll + 2) * 170,
      );
    }
    // the status bar keeps count
    const n = Math.round(3 * 2 ** (t * 1.15));
    const blink = chaos > 0.5 && Math.floor(t * 5) % 2 === 0;
    ctx.fillStyle = blink ? '#ff5e62' : '#b8323f';
    ctx.fillRect(0, SCREEN_H - 18, SCREEN_W, 18);
    ctx.fillStyle = '#fff';
    ctx.font = '700 11px "Segoe UI", sans-serif';
    ctx.fillText(`⚠ ${n > 999 ? '999+' : n} merge conflicts`, 8, SCREEN_H - 5);
    ctx.textAlign = 'right';
    ctx.fillText('feature/fix-everything → main', SCREEN_W - 8, SCREEN_H - 5);
    if (chaos > 0.75) {
      ctx.fillStyle = `rgba(255,60,80,${0.18 * Math.abs(Math.sin(t * 9))})`;
      ctx.fillRect(-10, 0, SCREEN_W + 20, SCREEN_H);
    }
  },

  // tests pass (locally); at 1.8 the verdict gets stamped on, with a thump
  works(ctx, t) {
    const hit = t - WORKS_AT;
    bg(ctx, '#1e1f29');
    if (hit > 0 && hit < 0.35)
      ctx.translate(Math.sin(hit * 95) * 6 * (1 - hit / 0.35), Math.cos(hit * 80) * 4 * (1 - hit / 0.35));
    // a file tree, an editor, a terminal
    ctx.fillStyle = '#262838';
    ctx.fillRect(0, 0, 54, SCREEN_H);
    ctx.fillStyle = '#4a5275';
    for (let i = 0; i < 6; i++) ctx.fillRect(8 + (i % 3 ? 8 : 0), 12 + i * 13, 30 - (i % 2) * 8, 6);
    const code: [string, number][] = [
      ['#ff8fb1', 0.3],
      ['#7ff3ff', 0.55],
      ['#ffd34d', 0.4],
      ['#a29bfe', 0.62],
      ['#7bed9f', 0.35],
    ];
    code.forEach(([color, w], i) => {
      ctx.fillStyle = color;
      roundRect(ctx, 66 + (i % 2) * 14, 12 + i * 15, 240 * w, 7, 3.5);
      ctx.fill();
    });
    ctx.fillStyle = '#11131c';
    ctx.fillRect(54, 90, SCREEN_W, SCREEN_H);
    ctx.fillStyle = '#8a90a6';
    ctx.font = '700 8px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('TERMINAL', 62, 102);
    ctx.font = '700 11px Consolas, "Courier New", monospace';
    const shown = Math.floor(t / 0.3);
    WORKS_LINES.forEach(([text, color], i) => {
      if (i > shown) return;
      ctx.fillStyle = color;
      ctx.fillText(text, 62, 120 + i * 16);
    });
    if (shown >= WORKS_LINES.length) {
      ctx.fillStyle = '#2fbf71';
      ctx.font = '900 15px "Segoe UI", sans-serif';
      ctx.fillText('All tests passed ✓', 62, 184);
    }
    if (hit < 0) return;
    // slams down from big to its size in a tenth of a second
    const k = Math.min(1, hit / 0.1);
    const scale = 1 + 1.3 * (1 - k) ** 2;
    ctx.save();
    ctx.globalAlpha = Math.min(1, hit / 0.06) * 0.92;
    ctx.translate(165, 100);
    ctx.rotate(-0.22);
    ctx.scale(scale, scale);
    ctx.drawImage(worksStamp(), -STAMP_W / 2, -STAMP_H / 2);
    ctx.restore();
  },

  // payday: the salary counts in (0.3–2.5), then from 4.0 the bills take it all
  // back, down to pocket change by 5.5
  payday(ctx, t) {
    bg(ctx, '#eef2f6');
    ctx.fillStyle = '#0b5e55';
    ctx.fillRect(0, 0, SCREEN_W, 26);
    ctx.fillStyle = '#fff';
    ctx.font = '700 13px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('PiggyBank', 12, 18);
    ctx.font = '12px "Segoe UI Emoji", "Segoe UI", sans-serif';
    ctx.fillText('🔔', 292, 18);
    // the balance card fades from green to a sorry grey-red as it empties
    const balance = paydayBalance(t);
    const broke = Math.min(1, Math.max(0, (t - 4.0) / 1.5));
    ctx.fillStyle = broke < 0.5 ? '#2fbf71' : '#b0565f';
    ctx.globalAlpha = 1;
    roundRect(ctx, 10, 34, 300, 68, 12);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '600 9px "Segoe UI", sans-serif';
    ctx.fillText('Available balance', 22, 50);
    ctx.fillStyle = '#fff';
    ctx.font = '900 30px "Segoe UI", sans-serif';
    ctx.fillText(money(balance), 22, 86);
    if (t > 5.5 && Math.floor(t * 3) % 2 === 0) {
      ctx.fillStyle = '#fff';
      roundRect(ctx, 226, 44, 74, 16, 8);
      ctx.fill();
      ctx.fillStyle = '#b0565f';
      ctx.font = '700 9px "Segoe UI", sans-serif';
      ctx.fillText('LOW BALANCE', 233, 55);
    }
    // +$ floating up off the card while it counts
    if (t > 0.3 && t < 3.0) {
      ctx.font = '900 15px "Segoe UI", sans-serif';
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 6; i++) {
        const u = (t * 0.9 + hash(i, 21)) % 1;
        ctx.globalAlpha = Math.sin(u * Math.PI) * Math.min(1, (3.0 - t) / 0.4);
        ctx.fillText('+$', 190 + hash(i, 22) * 100, 100 - u * 60);
      }
      ctx.globalAlpha = 1;
    }
    // the statement: the salary in, then everything going out
    PAYDAY_LINES.forEach(([label, amount, at], i) => {
      if (t < at) return;
      const y = 110 + i * 22;
      const pop = Math.min(1, (t - at) / 0.15);
      ctx.globalAlpha = pop;
      ctx.fillStyle = '#fff';
      roundRect(ctx, 10, y, 300, 19, 5);
      ctx.fill();
      ctx.fillStyle = '#232629';
      ctx.font = '600 12px "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(label, 18, y + 14);
      ctx.fillStyle = amount > 0 ? '#1f9d55' : '#d63a4a';
      ctx.font = '800 12px "Segoe UI", sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`${amount > 0 ? '+' : '−'}${money(Math.abs(amount))}`, 302, y + 14);
      ctx.globalAlpha = 1;
    });
    ctx.textAlign = 'left';
  },
};
