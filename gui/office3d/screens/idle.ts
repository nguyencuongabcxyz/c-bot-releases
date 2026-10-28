// The screens idle antics borrow: the bouncing-logo screensaver, dreams, the note left when it
// goes for a walk, one of your English words on a flash card, a word looked up.
import { SCREEN_W, SCREEN_H, INK } from '@/office3d/core/constants';
import type { Theme, ScreenScene } from '../themes';
import { bg, hash } from './draw';
import { roundRect } from '../materials';

// ---- the bouncing logo

// the logo's box, and how far its top-left corner can travel
export const DVD_W = 84;
export const DVD_H = 46;
export const DVD_RX = SCREEN_W - DVD_W;
export const DVD_RY = SCREEN_H - DVD_H;
export const DVD_COLORS = ['#ff5e62', '#ffd34d', '#7bed9f', '#7ff3ff', '#a29bfe', '#ff8fb1', '#ff9f43'];
// start and speed (px, px/s). DVD was searched so that over its 9 s every wall hit misses
// the corner by at least 9 px (with teases of 9-22 px at 3.4 s and 6.3-6.5 s).
export const DVD = { x0: 214, y0: 94, vx: 76, vy: 58 };
// LUCKY starts exactly where it must to reach x = 2 * DVD_RX and y = 3 * DVD_RY at
// LUCKY_AT: the bottom-left corner. Before that its closest call is 19 px (at 2.85 s).
export const LUCKY_AT = 6;
export const LUCKY = { vx: 75, vy: 55, x0: 2 * DVD_RX - LUCKY_AT * 75, y0: 3 * DVD_RY - LUCKY_AT * 55 };
export const LUCKY_CORNER = [0, SCREEN_H];

// a triangle wave: distance travelled u, folded back and forth between 0 and range
export function fold(u: number, range: number) {
  const m = ((u % (range * 2)) + range * 2) % (range * 2);
  return m < range ? m : range * 2 - m;
}

/** Where the logo starts (px) and how fast it goes (px/s). */
export type Bounce = { x0: number; y0: number; vx: number; vy: number };
export function bouncer(
  ctx: CanvasRenderingContext2D,
  t: number,
  accent: string,
  theme: Theme | undefined,
  { x0, y0, vx, vy }: Bounce,
  override?: string | null,
) {
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

export const GLYPHS = 'abcdefghijklmnopqrstuvwxyz{}()[]<>=;:+-*/&|!?_.,#$%0123456789λΣΩ';
export const JUNK = '█▓▒░#@%&$¤§¥Ø∆≠¿';
// [x, y, radius, twinkle speed, phase]
export const STARS = Array.from({ length: 28 }, (_, i) => [
  hash(i, 11) * SCREEN_W,
  hash(i, 12) * SCREEN_H,
  0.6 + hash(i, 13) * 1.4,
  1 + hash(i, 14) * 2.5,
  hash(i, 15) * 6.3,
]);
// [radius, alpha]
export const DREAM_GLOW = [
  [78, 0.08],
  [56, 0.12],
];

export const IDLE_SCENES: Record<string, ScreenScene> = {
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
  dream(ctx, t, accent, _theme, emoji) {
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
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const dream = emoji || '💭';
    if (/\p{L}{2}/u.test(dream)) {
      // dreaming of a word (one of your English words): written in big glowing letters
      let size = 54;
      ctx.font = `800 ${size}px "Segoe UI", sans-serif`;
      while (size > 20 && ctx.measureText(dream).width > SCREEN_W - 70) {
        size -= 3;
        ctx.font = `800 ${size}px "Segoe UI", sans-serif`;
      }
      ctx.shadowColor = '#c4a8ff';
      ctx.shadowBlur = 14;
      ctx.fillStyle = '#fffdf5';
      ctx.fillText(dream, 0, 4);
    } else {
      ctx.font = '96px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
      ctx.fillText(dream, 0, 6);
    }
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

  // out for a walk: a sticky note stuck over the desktop saying where it went (big: it has
  // to read on a monitor about 90 px wide)
  brb(ctx, t, paint) {
    const sky = ctx.createLinearGradient(0, 0, 0, SCREEN_H);
    sky.addColorStop(0, '#4f6fd0');
    sky.addColorStop(1, '#9db4ff');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    ctx.fillStyle = paint;
    roundRect(ctx, 6, 8, 16, 16, 4);
    ctx.fill(); // a desktop icon peeking out
    // the note, a little crooked, fluttering now and then
    ctx.save();
    ctx.translate(SCREEN_W / 2 + 4, SCREEN_H / 2 + 2);
    ctx.rotate(-0.025 + 0.01 * Math.sin(t * 1.3) * Math.max(0, Math.sin(t * 0.4)));
    ctx.fillStyle = 'rgba(29,34,53,0.3)';
    ctx.fillRect(-140, -84, 288, 180);
    ctx.fillStyle = '#ffe066';
    ctx.fillRect(-146, -90, 288, 180);
    ctx.fillStyle = '#ffd23f';
    ctx.fillRect(-146, -90, 288, 14); // the sticky strip
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 78px "Segoe UI", sans-serif';
    ctx.fillText('BRB', -34, -34);
    // the walker bobs along
    ctx.font = '62px "Segoe UI Emoji", "Segoe UI Symbol", sans-serif';
    ctx.fillText('🚶', 84, -36 - Math.abs(Math.sin(t * 4)) * 4);
    ctx.font = '800 34px "Segoe UI", sans-serif';
    ctx.fillText('drag me back', -2, 30);
    ctx.fillText('to my desk', -2, 66);
    ctx.restore();
  },

  // one of your English words ("wordcard:tackle|giải quyết|tackle a problem"), on a
  // flash card, the meaning fading in under it
  wordcard(ctx, t, _accent, _theme, text = '') {
    const [word = '', vi = '', phrase = ''] = text.split('|');
    bg(ctx, '#2a3150');
    ctx.fillStyle = '#fffdf5';
    roundRect(ctx, 18, 14, SCREEN_W - 36, SCREEN_H - 28, 14);
    ctx.fill();
    ctx.fillStyle = '#ff8fab';
    ctx.fillRect(18, 14, SCREEN_W - 36, 22);
    ctx.fillStyle = '#fffdf5';
    ctx.font = '800 13px "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('📚 MY WORDS', 30, 26);
    ctx.textAlign = 'center';
    ctx.fillStyle = INK;
    let size = 40;
    ctx.font = `800 ${size}px "Segoe UI", sans-serif`;
    while (size > 18 && ctx.measureText(word).width > SCREEN_W - 70) {
      size -= 3;
      ctx.font = `800 ${size}px "Segoe UI", sans-serif`;
    }
    ctx.fillText(word, SCREEN_W / 2, 76);
    // the meaning and a phrase come in after a moment, as if it's remembering
    const a = Math.min(1, Math.max(0, (t - 1.2) / 0.6));
    ctx.globalAlpha = a;
    ctx.fillStyle = '#b3261e';
    ctx.font = '700 17px "Segoe UI", sans-serif';
    const lines = [];
    let line = '';
    for (const part of vi.split(' ')) {
      const next = line ? `${line} ${part}` : part;
      if (ctx.measureText(next).width > SCREEN_W - 64 && line) {
        lines.push(line);
        line = part;
      } else line = next;
    }
    if (line) lines.push(line);
    lines.slice(0, 2).forEach((l, i) => {
      ctx.fillText(l, SCREEN_W / 2, 114 + i * 21);
    });
    if (phrase) {
      ctx.fillStyle = 'rgba(29,34,53,0.6)';
      ctx.font = 'italic 14px "Segoe UI", sans-serif';
      ctx.fillText(phrase.length > 36 ? `${phrase.slice(0, 35)}…` : phrase, SCREEN_W / 2, 164);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  },

  // looking up an English word ("define:meticulous"): the word typed into a
  // dictionary's search box, then the results coming in
  define(ctx, t, _accent, _theme, word = '') {
    bg(ctx, '#f6f1e4');
    ctx.fillStyle = '#b3261e';
    ctx.fillRect(0, 0, SCREEN_W, 38);
    ctx.fillStyle = '#fffaf0';
    ctx.font = '800 20px "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('📖 Dictionary', 14, 20);
    // the search box, the word typing in
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, 14, 50, SCREEN_W - 28, 34, 10);
    ctx.fill();
    ctx.strokeStyle = '#b3261e';
    ctx.lineWidth = 2;
    ctx.stroke();
    let typed = word.slice(0, Math.max(0, Math.floor(t * 9)));
    ctx.fillStyle = INK;
    ctx.font = '700 19px "Segoe UI", sans-serif';
    while (typed.length > 1 && ctx.measureText(typed).width > SCREEN_W - 80) typed = typed.slice(1);
    ctx.fillText(typed, 26, 68);
    if (Math.floor(t * 2.5) % 2 === 0) ctx.fillRect(28 + ctx.measureText(typed).width, 57, 2, 22);
    ctx.font = '18px "Segoe UI Emoji", sans-serif';
    ctx.fillText('🔍', SCREEN_W - 44, 68);
    // results: a headword bar and lines filling in, over and over while it reads
    const since = t - word.length / 9 - 0.3;
    if (since > 0) {
      const k = (since % 3.2) / 3.2;
      ctx.fillStyle = '#b3261e';
      ctx.fillRect(18, 100, 120 * Math.min(1, k * 4), 12);
      ctx.fillStyle = 'rgba(29,34,53,0.35)';
      [0.9, 0.72, 0.84, 0.5].forEach((w, i) => {
        const shown = Math.min(1, Math.max(0, k * 5 - 0.6 - i * 0.5));
        ctx.fillRect(18, 124 + i * 17, (SCREEN_W - 60) * w * shown, 8);
      });
    }
    ctx.textBaseline = 'alphabetic';
  },
};
