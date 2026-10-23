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
    ctx.moveTo(9, 10); ctx.lineTo(9, 19); ctx.lineTo(23, 19); ctx.lineTo(23, 10);
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
    roundRect(ctx, 150, 5, 120, 14, 4); ctx.fill();
    ctx.fillStyle = '#9199a1';
    ctx.font = '400 9px "Segoe UI", sans-serif';
    ctx.fillText('Search…', 156, 15);
    ctx.fillStyle = '#ffd34d';
    ctx.beginPath(); ctx.arc(296, 12, 7, 0, 7); ctx.fill();
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
    ctx.moveTo(16, 162); ctx.lineTo(22, 168); ctx.lineTo(32, 155);
    ctx.stroke();
    ctx.fillStyle = '#232629';
    ctx.font = '400 9px "Segoe UI", sans-serif';
    ctx.fillText('Press Esc, then type:', 46, 118);
    ctx.fillStyle = '#f1f2f3';
    roundRect(ctx, 46, 124, 200, 44, 4); ctx.fill();
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
    ctx.moveTo(ix - 3, iy - 7); ctx.lineTo(ix + 3, iy - 7);
    ctx.moveTo(ix, iy - 7); ctx.lineTo(ix, iy + 7);
    ctx.moveTo(ix - 3, iy + 7); ctx.lineTo(ix + 3, iy + 7);
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
      // later on the markers start to stutter and breed
      if (kind[0] === 'm' && hash(line, 2) < chaos) text = text.replace(/^(.)\1+/, (m) => m + m.slice(0, 3 + Math.floor(hash(line, tick) * 6)));
      ctx.fillStyle = kind[0] === 'm' ? '#ffffff' : '#d6d9e8';
      ctx.fillText(text, 32 + jx, y + 10);
    }
    // stray markers spraying across the screen as it falls apart
    const strays = Math.floor(chaos * chaos * 14);
    const roll = Math.floor(t * 4);
    for (let i = 0; i < strays; i++) {
      ctx.fillStyle = hash(i, roll) < 0.5 ? '#ff6b81' : '#7bed9f';
      ctx.fillText(MERGE_STRAY[Math.floor(hash(i, roll + 3) * MERGE_STRAY.length)], hash(i, roll + 1) * 260, 10 + hash(i, roll + 2) * 170);
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
    if (hit > 0 && hit < 0.35) ctx.translate(Math.sin(hit * 95) * 6 * (1 - hit / 0.35), Math.cos(hit * 80) * 4 * (1 - hit / 0.35));
    // a file tree, an editor, a terminal
    ctx.fillStyle = '#262838';
    ctx.fillRect(0, 0, 54, SCREEN_H);
    ctx.fillStyle = '#4a5275';
    for (let i = 0; i < 6; i++) ctx.fillRect(8 + (i % 3 ? 8 : 0), 12 + i * 13, 30 - (i % 2) * 8, 6);
    const code = [['#ff8fb1', 0.3], ['#7ff3ff', 0.55], ['#ffd34d', 0.4], ['#a29bfe', 0.62], ['#7bed9f', 0.35]];
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
      roundRect(ctx, 226, 44, 74, 16, 8); ctx.fill();
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
      roundRect(ctx, 10, y, 300, 19, 5); ctx.fill();
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

  // out for a walk: a sticky note stuck over the desktop saying where it went (big: it has
  // to read on a monitor about 90 px wide)
  brb(ctx, t, paint) {
    const sky = ctx.createLinearGradient(0, 0, 0, SCREEN_H);
    sky.addColorStop(0, '#4f6fd0');
    sky.addColorStop(1, '#9db4ff');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    ctx.fillStyle = paint;
    roundRect(ctx, 6, 8, 16, 16, 4); ctx.fill(); // a desktop icon peeking out
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
};

// ---- helpers for the office gags

// one copy of the hung window (all of them, in the trail, look the same)
function frozenWindow(ctx, x, y) {
  const W = 236;
  const H = 150;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(x + 3, y + 3, W, H);
  ctx.fillStyle = '#1e1f29';
  ctx.fillRect(x, y, W, H);
  const code = [['#ff8fb1', 0.35], ['#7ff3ff', 0.6], ['#ffd34d', 0.45], ['#a29bfe', 0.7], ['#7bed9f', 0.4], ['#7ff3ff', 0.55], ['#ff8fb1', 0.3]];
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

function arrow(ctx, x, y) {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x, y + 17); ctx.lineTo(x + 4.5, y + 13);
  ctx.lineTo(x + 8, y + 20); ctx.lineTo(x + 10.5, y + 19); ctx.lineTo(x + 7, y + 12); ctx.lineTo(x + 12, y + 12);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}
const WHEEL = ['#ff5e62', '#ff9f43', '#ffd34d', '#7bed9f', '#5ac8fa', '#a29bfe'];

// ▲ count ▼, Stack Overflow style
function votes(ctx, x, y, n) {
  ctx.fillStyle = '#bbc0c4';
  ctx.beginPath(); ctx.moveTo(x - 7, y + 8); ctx.lineTo(x + 7, y + 8); ctx.lineTo(x, y); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x - 7, y + 26); ctx.lineTo(x + 7, y + 26); ctx.lineTo(x, y + 34); ctx.fill();
  ctx.fillStyle = '#6a737c';
  ctx.font = '700 9px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(n, x, y + 21);
  ctx.textAlign = 'left';
}

// the merge conflict, a block at a time (m* are marker lines)
const MERGE_BLOCK = ['code', 'mHead', 'ours', 'ours', 'mMid', 'theirs', 'theirs', 'theirs', 'mEnd', 'code', 'code'];
const MERGE_BG = { code: '#1e1f29', mHead: '#2d6b4a', ours: 'rgba(47,191,113,0.25)', mMid: '#3a3c4e', theirs: 'rgba(255,94,98,0.25)', mEnd: '#8a2f3a' };
const MERGE_TEXT = {
  mHead: '<<<<<<< HEAD',
  mMid: '=======',
  mEnd: '>>>>>>> feature/fix-everything',
  code: ['function deploy(env) {', '  const ok = check();', '}', '// TODO: fix', 'export default app;'],
  ours: ['  return fixEverything();', '  if (env === "prod") panic();', '  retries = 3;'],
  theirs: ['  return fixEverything(true);', '  if (env == "prod") pray();', '  retries = Infinity;', '  // trust me'],
};
const MERGE_STRAY = ['<<<<<<<', '=======', '>>>>>>>', 'HEAD', '<<<<<<< HEAD', '>>>>>>> fix'];

// "works on my machine": its stamp, drawn once (with ink gaps) and reused
const WORKS_AT = 1.8;
const STAMP_W = 250;
const STAMP_H = 96;
const WORKS_LINES = [['$ npm test', '#d6d9e8'], [' PASS  src/app.test.js', '#7bed9f'], ['Tests: 42 passed, 42 total', '#d6d9e8']];
let stamp = null;
function worksStamp() {
  if (stamp) return stamp;
  stamp = document.createElement('canvas');
  stamp.width = STAMP_W;
  stamp.height = STAMP_H;
  const s = stamp.getContext('2d');
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
const PAYDAY_IN = 4250;
const PAYDAY_LINES = [['Salary 💼', PAYDAY_IN, 0.3], ['Rent', -1800, 4.0], ['Coffee ☕', -612.4, 4.45], ['Subscriptions', -1834.43, 4.9]];
function paydayBalance(t) {
  // counts up fast (easing out) over 0.3–2.5
  const u = Math.min(1, Math.max(0, (t - 0.3) / 2.2));
  let b = PAYDAY_IN * (1 - (1 - u) ** 3);
  for (const [, amount, at] of PAYDAY_LINES) if (amount < 0) b += amount * Math.min(1, Math.max(0, (t - at) / 0.3));
  return Math.max(0, b);
}
function money(n) {
  const [whole, cents] = n.toFixed(2).split('.');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}

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
  frozen: '#dfe8f5', stackoverflow: '#ffe2c4', merge: '#ff7b8a', works: '#7bed9f', payday: '#5fd39a', brb: '#ffe680',
  ...FEED_LIGHT,
};
