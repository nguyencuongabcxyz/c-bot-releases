import { roundRect } from './materials.js';
import { FEEDS, FEED_LIGHT } from './feeds.js';

// The monitor shows what Claude Code is doing. Each scene is drawn onto a
// 320x200 canvas every frame it's visible; `t` is seconds since the scene began.
export const SCREEN_W = 320;
export const SCREEN_H = 200;

const INK = '#1d2235';
const pageWidths = [0.7, 0.85, 0.5, 0.78, 0.4, 0.82, 0.62];

function bg(ctx, color) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
}

function lines(ctx, { x, y, gap, height, color, offset = 0, count = 12, widths = pageWidths, maxW = 240 }) {
  ctx.fillStyle = color;
  for (let i = -1; i < count; i++) {
    const yy = y + i * gap - (offset % (gap * widths.length));
    const idx = ((i % widths.length) + widths.length) % widths.length;
    ctx.fillRect(x, yy, maxW * widths[idx], height);
  }
}

const SCENES = {
  off(ctx) {
    bg(ctx, '#0b0d16');
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(30, 90); ctx.lineTo(110, 30);
    ctx.moveTo(60, 120); ctx.lineTo(160, 45);
    ctx.stroke();
  },

  // a dance party: a flashing disco floor and a bouncing note
  dance(ctx, t) {
    const colors = ['#ff6b81', '#ffd34d', '#7bed9f', '#5ac8fa', '#a29bfe', '#ff9f43'];
    const step = Math.floor(t * 4);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 8; x++) {
        ctx.fillStyle = colors[(x * 3 + y * 5 + step) % colors.length];
        ctx.globalAlpha = (x + y + step) % 3 === 0 ? 1 : 0.55;
        ctx.fillRect(x * 40, y * 40, 39, 39);
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(29,34,53,0.35)';
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    const bounce = Math.abs(Math.sin(t * Math.PI * 2)) * 18;
    ctx.font = '900 84px "Segoe UI Symbol", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 8;
    ctx.strokeStyle = INK;
    ctx.strokeText('♪', 160, 120 - bounce);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('♪', 160, 120 - bounce);
    ctx.font = '900 30px "Segoe UI", sans-serif';
    ctx.strokeText('DANCE!', 160, 182);
    ctx.fillStyle = colors[step % colors.length];
    ctx.fillText('DANCE!', 160, 182);
  },

  boot(ctx, t, paint) {
    bg(ctx, '#f4f5fb');
    ctx.fillStyle = INK;
    ctx.font = '900 40px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('C-BOT', 160, 105);
    ctx.fillStyle = '#dfe2ee';
    roundRect(ctx, 90, 130, 140, 10, 5); ctx.fill();
    ctx.fillStyle = paint;
    roundRect(ctx, 90, 130, 140 * Math.min(1, t / 0.9), 10, 5); ctx.fill();
  },

  idle(ctx, t, paint) {
    bg(ctx, INK);
    ctx.fillStyle = '#7bed9f';
    ctx.font = '700 30px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('>', 20, 48);
    if (Math.floor(t * 2) % 2 === 0) ctx.fillRect(46, 24, 16, 28);
    const s = 1 + Math.sin(t * 4) * 0.1;
    ctx.save();
    ctx.translate(160, 120);
    ctx.scale(s * 2.2, s * 2.2);
    ctx.fillStyle = paint;
    ctx.beginPath();
    ctx.moveTo(0, 14);
    ctx.bezierCurveTo(-22, -2, -12, -20, 0, -8);
    ctx.bezierCurveTo(12, -20, 22, -2, 0, 14);
    ctx.fill();
    ctx.restore();
  },

  think(ctx, t) {
    bg(ctx, INK);
    ctx.strokeStyle = '#7ff3ff';
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(160, 100, 42, t * 6, t * 6 + Math.PI * 1.3);
    ctx.stroke();
    ctx.fillStyle = '#ffd34d';
    ctx.font = '900 46px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('?', 160, 117);
  },

  read(ctx, t, paint) {
    bg(ctx, '#f4f5fb');
    lines(ctx, { x: 24, y: 20, gap: 22, height: 9, color: '#b9bfd3', offset: t * 40 });
    ctx.fillStyle = paint;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(14, 70 + Math.sin(t * 2) * 50, 292, 20);
    ctx.globalAlpha = 1;
  },

  search(ctx, t) {
    bg(ctx, '#f4f5fb');
    lines(ctx, { x: 24, y: 20, gap: 22, height: 9, color: '#b9bfd3' });
    const x = 160 + Math.cos(t * 2.4) * 80;
    const y = 100 + Math.sin(t * 3.1) * 45;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.arc(x, y, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + 22, y + 22);
    ctx.lineTo(x + 46, y + 46);
    ctx.stroke();
  },

  edit(ctx, t) {
    bg(ctx, INK);
    ctx.fillStyle = '#252b45';
    ctx.fillRect(0, 0, 28, SCREEN_H);
    const code = [
      [40, '#ff8fb1', 0.45], [60, '#7ff3ff', 0.7], [60, '#ffd34d', 0.35], [80, '#7bed9f', 0.6],
      [60, '#a29bfe', 0.45], [40, '#ff8fb1', 0.25], [60, '#7ff3ff', 0.55],
    ];
    const cycle = t % 4;
    code.forEach(([x, color, w], i) => {
      const grow = Math.max(0, Math.min(1, (cycle - i * 0.35) / 0.4));
      const y = 22 + i * 24;
      ctx.fillStyle = '#4a5275';
      ctx.fillRect(8, y, 12, 9);
      ctx.fillStyle = color;
      roundRect(ctx, x, y, 240 * w * grow, 10, 5);
      ctx.fill();
      if (grow > 0 && grow < 1) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(x + 240 * w * grow + 3, y - 3, 4, 16);
      }
    });
    // diff gutter: + and - markers
    ctx.fillStyle = '#7bed9f';
    ctx.fillRect(30, 94, 6, 14);
    ctx.fillStyle = '#ff6b81';
    ctx.fillRect(30, 46, 6, 14);
  },

  run(ctx, t) {
    bg(ctx, '#0b0d16');
    const step = Math.floor(t * 5) * 7;
    ctx.font = '700 16px Consolas, monospace';
    for (let i = -1; i < 10; i++) {
      const y = 22 + i * 21 - (step % 21);
      const row = i + Math.floor(step / 21);
      if (row % 3 === 0) {
        ctx.fillStyle = '#7bed9f';
        ctx.fillText('$', 14, y + 12);
        ctx.fillRect(34, y, 120 + (row * 37) % 90, 9);
      } else {
        ctx.fillStyle = 'rgba(123,237,159,0.55)';
        ctx.fillRect(14, y, 110 + (row * 53) % 170, 9);
      }
    }
  },

  web(ctx, t) {
    bg(ctx, '#3a7bd5');
    ctx.fillStyle = '#7ff3ff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(160, 100, 60, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 4;
    for (const k of [0, 0.5]) {
      const rx = Math.abs(Math.cos((t * 1.6 + k) * Math.PI)) * 60;
      ctx.beginPath();
      ctx.ellipse(160, 100, Math.max(rx, 1), 60, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const y of [70, 100, 130]) {
      const half = Math.sqrt(Math.max(0, 60 * 60 - (y - 100) ** 2));
      ctx.beginPath();
      ctx.moveTo(160 - half, y);
      ctx.lineTo(160 + half, y);
      ctx.stroke();
    }
  },

  agent(ctx, t, paint) {
    bg(ctx, '#2a3049');
    const bot = (x, color, phase) => {
      const y = 95 - Math.abs(Math.sin(t * 5 + phase)) * 24;
      ctx.fillStyle = color;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 5;
      roundRect(ctx, x - 36, y, 72, 56, 16);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = INK;
      ctx.beginPath(); ctx.arc(x - 14, y + 26, 7, 0, 7); ctx.arc(x + 14, y + 26, 7, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 18); ctx.stroke();
      ctx.fillStyle = '#ff5e62';
      ctx.beginPath(); ctx.arc(x, y - 22, 7, 0, 7); ctx.fill();
    };
    bot(105, paint, 0);
    bot(215, '#ffd34d', 1.4);
  },

  plan(ctx, t) {
    bg(ctx, '#f4f5fb');
    const cycle = t % 3;
    for (let i = 0; i < 3; i++) {
      const y = 36 + i * 52;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 5;
      roundRect(ctx, 30, y, 30, 30, 6);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#b9bfd3';
      ctx.fillRect(80, y + 10, [170, 130, 190][i], 10);
      if (cycle > 0.6 + i * 0.6) {
        ctx.strokeStyle = '#2fbf71';
        ctx.lineWidth = 7;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(36, y + 15); ctx.lineTo(44, y + 23); ctx.lineTo(56, y + 6);
        ctx.stroke();
      }
    }
  },

  talk(ctx, t) {
    bg(ctx, INK);
    ctx.fillStyle = '#fff';
    roundRect(ctx, 70, 50, 180, 90, 28);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(120, 135); ctx.lineTo(100, 165); ctx.lineTo(150, 135);
    ctx.fill();
    ctx.fillStyle = INK;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(125 + i * 35, 95 - Math.max(0, Math.sin(t * 7 - i * 0.7)) * 10, 11, 0, 7);
      ctx.fill();
    }
  },

  ask(ctx, t, paint) {
    bg(ctx, '#ffd34d');
    const bob = Math.sin(t * 5) * 6;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 7;
    roundRect(ctx, 105, 30 + bob, 110, 90, 26);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = paint;
    ctx.font = '900 70px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('?', 160, 102 + bob);
    ctx.fillStyle = INK;
    ctx.font = '900 24px "Segoe UI", sans-serif';
    ctx.fillText('YOUR TURN!', 160, 172);
  },

  compact(ctx, t, paint) {
    bg(ctx, INK);
    // a stack of pages squished down into a neat little cube, over and over
    const cycle = (t % 2.2) / 2.2;
    const squish = Math.min(1, cycle / 0.6);
    const pages = 6;
    for (let i = 0; i < pages; i++) {
      const h = 60 * (1 - squish) + 9;
      const w = 150 - squish * 70;
      const y = 150 - (i + 1) * (h / pages + 2) + Math.sin(t * 9 + i) * 2 * (1 - squish);
      ctx.fillStyle = i % 2 ? '#f4f5fb' : '#dfe2ee';
      ctx.fillRect(160 - w / 2 + Math.sin(i * 1.7) * 8 * (1 - squish), y, w, h / pages + 1);
    }
    ctx.fillStyle = paint;
    ctx.fillRect(40, 30 + squish * 40, 240, 14); // the press
    ctx.fillRect(152, 0, 16, 30 + squish * 40);
    ctx.fillStyle = '#fff';
    ctx.font = '900 20px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('SQUISH!', 160, 190);
  },

  done(ctx, t) {
    bg(ctx, '#2fbf71');
    const s = Math.min(1, t / 0.35);
    const pop = s < 1 ? s * 1.15 : 1;
    ctx.save();
    ctx.translate(160, 100);
    ctx.scale(pop, pop);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 22;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(-50, 0); ctx.lineTo(-14, 36); ctx.lineTo(56, -40);
    ctx.stroke();
    ctx.restore();
  },

  error(ctx) {
    bg(ctx, '#2463d1');
    ctx.fillStyle = '#fff';
    ctx.font = '700 64px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(':(', 24, 82);
    ctx.globalAlpha = 0.75;
    ctx.fillRect(26, 110, 200, 10);
    ctx.fillRect(26, 132, 140, 10);
    ctx.globalAlpha = 0.5;
    ctx.fillRect(26, 154, 170, 10);
    ctx.globalAlpha = 1;
  },

  locked(ctx, t) {
    bg(ctx, INK);
    const shake = t < 0.5 ? Math.sin(t * 60) * 6 : 0;
    ctx.save();
    ctx.translate(160 + shake, 100);
    ctx.strokeStyle = '#ffd34d';
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(0, -10, 24, Math.PI, 0);
    ctx.lineTo(24, 4);
    ctx.moveTo(-24, -10);
    ctx.lineTo(-24, 4);
    ctx.stroke();
    ctx.fillStyle = '#ffd34d';
    roundRect(ctx, -40, 0, 80, 60, 10);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.arc(0, 26, 8, 0, 7); ctx.fill();
    ctx.restore();
  },

  // ---- idle antics borrow the screen for these

  // the bouncing-logo screensaver: it skims past the corners but never quite hits one
  dvd(ctx, t, accent, theme) {
    bouncer(ctx, t, accent, theme, DVD);
  },

  // ...except this time it does, at exactly t = 6 s (robot.js cheers right then)
  'dvd-lucky'(ctx, t, accent, theme) {
    const party = t >= LUCKY_AT && t < LUCKY_AT + 1.5 ? t - LUCKY_AT : -1;
    bouncer(ctx, t, accent, theme, LUCKY, party >= 0 ? DVD_COLORS[Math.floor(t * 10) % DVD_COLORS.length] : null);
    if (party < 0) return;
    // a flash, sparks flying out of the corner, and the news
    if (party < 0.35) {
      ctx.fillStyle = `rgba(255,255,255,${0.6 * (1 - party / 0.35)})`;
      ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    }
    const fade = 1 - Math.max(0, (party - 1.2) / 0.3);
    ctx.globalAlpha = fade;
    ctx.strokeStyle = '#ffd34d';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    const [cx, cy] = LUCKY_CORNER;
    const sx = cx ? -1 : 1;
    const sy = cy ? -1 : 1;
    const r = 20 + party * 120;
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const a = ((i + 0.5) / 7) * (Math.PI / 2);
      ctx.moveTo(cx + sx * Math.cos(a) * r * 0.6, cy + sy * Math.sin(a) * r * 0.6);
      ctx.lineTo(cx + sx * Math.cos(a) * r, cy + sy * Math.sin(a) * r);
    }
    ctx.stroke();
    const pop = party < 0.25 ? 0.6 + (party / 0.25) * 0.5 : 1.1 - Math.min(0.1, (party - 0.25) * 0.4);
    ctx.save();
    ctx.translate(160, 100);
    ctx.scale(pop, pop);
    ctx.rotate(Math.sin(party * 9) * 0.06);
    ctx.font = '900 40px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 8;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.strokeText('CORNER!', 0, 0);
    ctx.fillStyle = '#ffd34d';
    ctx.fillText('CORNER!', 0, 0);
    ctx.restore();
    ctx.globalAlpha = 1;
  },

  // asleep and dreaming of something (drawScreen passes the emoji from "dream:🐟")
  dream(ctx, t, accent, theme, emoji) {
    const g = ctx.createLinearGradient(0, 0, 0, SCREEN_H);
    g.addColorStop(0, '#110d2e');
    g.addColorStop(1, '#2d1f63');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    ctx.fillStyle = '#ffffff';
    for (const [x, y, r, speed, phase] of STARS) {
      ctx.globalAlpha = 0.15 + 0.75 * (0.5 + 0.5 * Math.sin(t * speed + phase)) ** 2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 7);
      ctx.fill();
    }
    // the dream itself drifts about slowly in a soft glow
    const x = 160 + Math.sin(t * 0.45) * 36;
    const y = 100 + Math.sin(t * 1.2) * 9;
    ctx.fillStyle = accent;
    for (const [r, a] of DREAM_GLOW) {
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(t * 0.8) * 0.12);
    ctx.font = '96px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji || '💭', 0, 6);
    ctx.restore();
  },

  // dreaming of work: garbled code typing in line by line, a few lines corrupted
  gibberish(ctx, t, accent) {
    bg(ctx, '#0b0d16');
    ctx.font = '700 13px Consolas, "Courier New", monospace';
    ctx.textAlign = 'left';
    const rows = 12;
    const per = 0.3; // a new line every `per` seconds, the screen scrolls up
    const n = Math.floor(t / per);
    const flick = Math.floor(t * 12);
    let cursorX = 12;
    for (let k = 0; k < rows; k++) {
      const line = n - (rows - 1) + k; // the bottom row is the one being typed
      if (line < 0) continue;
      const indent = Math.floor(hash(line, 1) * 4) * 2;
      let len = 6 + Math.floor(hash(line, 2) * (32 - indent));
      if (line === n) len = Math.floor(len * Math.min(1, (t % per) / (per * 0.8)));
      const corrupt = hash(line, 3) < 0.22;
      const set = corrupt ? JUNK : GLYPHS;
      let text = '';
      for (let i = 0; i < len; i++) {
        // a few characters keep changing their mind; corrupted lines can't settle at all
        const live = hash(line * 64 + i, 4) < (corrupt ? 0.6 : 0.08);
        text += set[Math.floor(hash(line * 64 + i, live ? flick : 5) * set.length)];
      }
      const x = 12 + indent * 7.2;
      const y = 20 + k * 15.5;
      if (corrupt) {
        // torn and colour-split
        const jx = (hash(line, flick) - 0.5) * 8;
        ctx.fillStyle = 'rgba(127,243,255,0.7)';
        ctx.fillText(text, x + jx - 2, y);
        ctx.fillStyle = '#ff6b81';
        ctx.fillText(text, x + jx + 1, y);
      } else {
        ctx.fillStyle = line === n ? '#c8ffd9' : '#7bed9f';
        ctx.globalAlpha = 0.4 + (0.6 * (k + 1)) / rows;
        ctx.fillText(text, x, y);
        ctx.globalAlpha = 1;
      }
      if (line === n) cursorX = x + ctx.measureText(text).width + 2;
    }
    if (Math.floor(t * 3) % 2 === 0) {
      ctx.fillStyle = accent;
      ctx.fillRect(cursorX, 20 + (rows - 1) * 15.5 - 11, 8, 13);
    }
  },
};

// ---- the bouncing logo

// the logo's box, and how far its top-left corner can travel
const DVD_W = 84;
const DVD_H = 46;
const DVD_RX = SCREEN_W - DVD_W;
const DVD_RY = SCREEN_H - DVD_H;
const DVD_COLORS = ['#ff5e62', '#ffd34d', '#7bed9f', '#7ff3ff', '#a29bfe', '#ff8fb1', '#ff9f43'];
// start and speed (px, px/s). DVD was searched so that over its 9 s every wall hit misses
// the corner by at least 9 px (with teases of 9-22 px at 3.4 s and 6.3-6.5 s).
const DVD = { x0: 214, y0: 94, vx: 76, vy: 58 };
// LUCKY starts exactly where it must to reach x = 2 * DVD_RX and y = 3 * DVD_RY at
// LUCKY_AT: the bottom-left corner. Before that its closest call is 19 px (at 2.85 s).
const LUCKY_AT = 6;
const LUCKY = { vx: 75, vy: 55, x0: 2 * DVD_RX - LUCKY_AT * 75, y0: 3 * DVD_RY - LUCKY_AT * 55 };
const LUCKY_CORNER = [0, SCREEN_H];

// a triangle wave: distance travelled u, folded back and forth between 0 and range
function fold(u, range) {
  const m = ((u % (range * 2)) + range * 2) % (range * 2);
  return m < range ? m : range * 2 - m;
}

function bouncer(ctx, t, accent, theme, { x0, y0, vx, vy }, override) {
  bg(ctx, '#05060b');
  const ux = x0 + vx * t;
  const uy = y0 + vy * t;
  const x = fold(ux, DVD_RX);
  const y = fold(uy, DVD_RY);
  // a new colour with every wall it touches (the first one is the accent)
  const hits = Math.floor(ux / DVD_RX) + Math.floor(uy / DVD_RY);
  const color = override || (hits === 0 ? accent : DVD_COLORS[(hits - 1) % DVD_COLORS.length]);
  const brand = theme?.brand;
  ctx.fillStyle = color;
  if (brand) {
    brand.logo(ctx, x + 23, y + 1, 38, true);
  } else {
    ctx.font = '900 25px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('C-BOT', x + DVD_W / 2, y + 25);
  }
  // the squashed disc under the name, with its hole
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x + DVD_W / 2, y + 36, 40, 9, 0, 0, 7);
  ctx.fill();
  ctx.fillStyle = '#05060b';
  ctx.beginPath();
  ctx.ellipse(x + DVD_W / 2, y + 36, 11, 3, 0, 0, 7);
  ctx.fill();
}

// ---- helpers for the dream screens

// a cheap repeatable "random" number in [0, 1) for a pair of integers
function hash(a, b) {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const GLYPHS = 'abcdefghijklmnopqrstuvwxyz{}()[]<>=;:+-*/&|!?_.,#$%0123456789λΣΩ';
const JUNK = '█▓▒░#@%&$¤§¥Ø∆≠¿';
// [x, y, radius, twinkle speed, phase]
const STARS = Array.from({ length: 28 }, (_, i) => [hash(i, 11) * SCREEN_W, hash(i, 12) * SCREEN_H, 0.6 + hash(i, 13) * 1.4, 1 + hash(i, 14) * 2.5, hash(i, 15) * 6.3]);
const DREAM_GLOW = [[78, 0.08], [56, 0.12]]; // [radius, alpha]

// the robot slacking off on social feeds (feeds.js)
Object.assign(SCENES, FEEDS);

export function drawScreen(ctx, scene, t, paint, theme) {
  ctx.save();
  ctx.textAlign = 'left';
  // "helpers": the robot supervising its helper agents shows the helper-bots scene too
  let name = scene === 'helpers' ? 'agent' : scene;
  // "dream:🐟": the dream scene, showing what it's dreaming of
  let text = '';
  if (typeof name === 'string' && name.startsWith('dream:')) {
    text = name.slice(6);
    name = 'dream';
  }
  const accent = theme?.screen?.accent || paint;
  (theme?.screen?.scenes?.[name] || SCENES[name] || SCENES.idle)(ctx, t, accent, theme, text);
  ctx.restore();
}

// Colour the monitor casts onto the robot and desk for each scene.
// (A dream is shown as "dream:<emoji>"; look that up as "dream".)
export const SCREEN_LIGHT = {
  off: null, boot: '#ffffff', idle: '#7bed9f', think: '#7ff3ff', read: '#ffffff', search: '#ffffff',
  edit: '#a29bfe', run: '#7bed9f', web: '#5aa0ff', agent: '#ffd34d', helpers: '#ffd34d', plan: '#ffffff', talk: '#ffffff',
  done: '#2fbf71', ask: '#ffd34d', compact: '#ff9f43', error: '#2463d1', locked: '#ffd34d',
  dvd: '#4a5288', 'dvd-lucky': '#4a5288', dream: '#7d6cff', gibberish: '#3f9e6a', dance: '#ff6bd6',
  ...FEED_LIGHT,
};
