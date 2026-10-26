import { roundRect } from './materials';
import type { ScreenScene } from './themes';

// Social feeds for the monitor, while the robot scrolls them instead of working
// (the 'feed' antic in antics/awake.js). Cartoon look-alikes, not the real apps.
// Each is drawn on the 320x200 screen with `t` = seconds into the antic.
// Timings are a contract with robot.js (sounds and faces):
//   scroll flicks at FLICKS; the funny one is on screen at FUNNY (it laughs);
//   it likes it at LIKE. On the video site the flick at 4.0 is a click: it
//   opens a video, and at 7.0 it goes back to the list.
export const FLICKS = [1.0, 2.0, 3.0, 4.0, 7.0, 8.0];
export const FUNNY = 4.8;
export const LIKE = 6.2;

const W = 320;
const H = 200;
const INK = '#1d2235';
const EMOJI = '"Segoe UI Emoji", "Segoe UI Symbol", sans-serif';
const SYMBOL = '"Segoe UI Symbol", "Segoe UI", sans-serif';

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const easeOut = (x: number) => 1 - (1 - clamp(x, 0, 1)) ** 3;
// how far it has scrolled: each flick glides one `step` (eased, like a wheel spin)
function scrolled(t: number, step: number, flicks = FLICKS) {
  let y = 0;
  for (const f of flicks) y += step * easeOut((t - f) / 0.45);
  return y;
}
// a pop: 0 before `at`, overshoots to ~1.15, settles at 1, then fades from `at + hold`
function pop(t: number, at: number, hold = 1.0) {
  const k = t - at;
  if (k < 0 || k > hold + 0.3) return { s: 0, a: 0 };
  const s = k < 0.18 ? (k / 0.18) * 1.15 : 1.15 - Math.min(0.15, (k - 0.18) * 0.6);
  return { s, a: 1 - clamp((k - hold) / 0.3, 0, 1) };
}
// (symbol = a plain glyph that takes the fill colour, like ♥ or ♪, rather than a colour emoji)
function emoji(ctx: CanvasRenderingContext2D, ch: string, x: number, y: number, size: number, symbol = false) {
  ctx.font = `${size}px ${symbol ? SYMBOL : EMOJI}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch, x, y);
  ctx.textBaseline = 'alphabetic';
}
function bars(ctx: CanvasRenderingContext2D, x: number, y: number, widths: number[], h: number, gap: number, color: string) {
  ctx.fillStyle = color;
  widths.forEach((w, i) => ctx.fillRect(x, y + i * gap, w, h));
}
// a hand-drawn arrow pointer
function pointer(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(0, 14); ctx.lineTo(4, 10.5); ctx.lineTo(7, 16);
  ctx.lineTo(9, 15); ctx.lineTo(6.5, 9.5); ctx.lineTo(11, 9.5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// ------------------------------------------------------------ the blue social network

// a column of posts; the 5th (index 4) is the funny one, centred after the 4th flick
const FB_POST = 150;
const FB_PHOTOS = [
  ['#ffd180', '🌅'], ['#b9f6ca', '🥗'], ['#80d8ff', '🏖️'], ['#ea80fc', '🎂'],
  ['#ffe082', '😹'], ['#ffab91', '🐶'], ['#a7ffeb', '🌵'], ['#c5cae9', '🚀'],
];
function facebook(ctx: CanvasRenderingContext2D, t: number) {
  ctx.fillStyle = '#f0f2f5';
  ctx.fillRect(0, 0, W, H);
  const off = scrolled(t, FB_POST);
  const x = 60;
  const w = 200;
  const first = Math.floor(off / FB_POST);
  for (let i = first; i < first + 3; i++) {
    const y = 34 + i * FB_POST - off;
    const [tint, pic] = FB_PHOTOS[i % FB_PHOTOS.length];
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, x, y, w, FB_POST - 10, 8);
    ctx.fill();
    // who posted it
    ctx.fillStyle = ['#ff8a80', '#82b1ff', '#ffd180', '#b388ff'][i % 4];
    ctx.beginPath();
    ctx.arc(x + 14, y + 13, 7, 0, Math.PI * 2);
    ctx.fill();
    bars(ctx, x + 26, y + 8, [52 + (i % 3) * 14, 30], 4, 7, '#bcc0c4');
    // the photo
    ctx.fillStyle = tint;
    ctx.fillRect(x, y + 28, w, 80);
    ctx.fillStyle = INK;
    emoji(ctx, pic, x + w / 2, y + 68, 44);
    if (i === 4) {
      // a caption meme on the funny one
      ctx.font = '900 13px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = INK;
      ctx.strokeText('WHEN THE BUILD PASSES', x + w / 2, y + 44);
      ctx.fillStyle = '#ffffff';
      ctx.fillText('WHEN THE BUILD PASSES', x + w / 2, y + 44);
    }
    // like / comment / share
    const liked = i === 4 && t >= 6.2;
    ctx.font = '700 9px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = liked ? '#1877f2' : '#65676b';
    ctx.fillText('👍 Like', x + 34, y + 126);
    ctx.fillStyle = '#65676b';
    ctx.fillText('💬 Comment', x + 100, y + 126);
    ctx.fillText('↗ Share', x + 166, y + 126);
  }
  // the top bar
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, 26);
  ctx.fillStyle = '#1877f2';
  ctx.font = '900 17px "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('facebook', 10, 19);
  ctx.fillStyle = '#f0f2f5';
  roundRect(ctx, 100, 6, 120, 14, 7);
  ctx.fill();
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = '#e4e6eb';
    ctx.beginPath();
    ctx.arc(256 + i * 22, 13, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#d6d9dd';
  ctx.fillRect(0, 26, W, 1);
  // the like: a big thumbs-up pops out of the post
  const p = pop(t, 6.2);
  if (p.a > 0) {
    ctx.globalAlpha = p.a;
    ctx.save();
    ctx.translate(160, 66);
    ctx.scale(p.s, p.s);
    ctx.fillStyle = '#1877f2';
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    emoji(ctx, '👍', 0, 2, 34);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

// ------------------------------------------------------------ the short-video app

// full-height vertical videos, one per swipe; the 5th (index 4) is the funny one
const TT_VIDEOS = [
  ['#ff6b81', '#ffd34d', '💃'], ['#5ac8fa', '#a29bfe', '🐶'], ['#ff9f43', '#ff6b6b', '🍜'], ['#2ed573', '#1e90ff', '🎸'],
  ['#ffd34d', '#ff9ff3', '😹'], ['#a29bfe', '#ff6bd6', '🕺'], ['#70a1ff', '#7bed9f', '🐧'],
];
function tiktok(ctx: CanvasRenderingContext2D, t: number) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);
  const vw = 116;
  const vx = (W - vw) / 2;
  const off = scrolled(t, H);
  const first = Math.floor(off / H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(vx, 0, vw, H);
  ctx.clip();
  for (let i = first; i < first + 2; i++) {
    const y = i * H - off;
    const [a, b, star] = TT_VIDEOS[i % TT_VIDEOS.length];
    const g = ctx.createLinearGradient(0, y, 0, y + H);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    ctx.fillStyle = g;
    ctx.fillRect(vx, y, vw, H);
    // the star of the video, dancing about (the cat falls over laughing)
    const funny = i === 4;
    const beat = t * (funny ? 7 : 5) + i;
    const bx = vx + vw / 2 + Math.sin(beat) * (funny ? 6 : 12);
    const by = y + 92 - Math.abs(Math.sin(beat)) * 14;
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(funny ? Math.sin(t * 9) * 0.35 : Math.sin(beat) * 0.15);
    emoji(ctx, star, 0, 0, 52);
    ctx.restore();
    // caption and sound
    bars(ctx, vx + 8, y + 160, [60, 82], 4, 8, 'rgba(255,255,255,0.85)');
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `9px ${SYMBOL}`;
    ctx.textAlign = 'left';
    ctx.fillText('♫ original sound', vx + 8, y + 186);
    // the side buttons: avatar, heart, comments, share
    const liked = funny && t >= 6.2;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(vx + vw - 14, y + 70, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = liked ? '#fe2c55' : '#ffffff';
    emoji(ctx, '♥', vx + vw - 14, y + 96, 18, true);
    ctx.fillStyle = '#ffffff';
    emoji(ctx, '💬', vx + vw - 14, y + 120, 13);
    emoji(ctx, '↪', vx + vw - 14, y + 142, 14, true);
  }
  ctx.restore();
  // the tabs on top
  ctx.font = '700 10px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText('Following', vx + 34, 16);
  ctx.fillStyle = '#ffffff';
  ctx.fillText('For You', vx + 82, 16);
  ctx.fillRect(vx + 72, 20, 20, 2);
  // the app's note logo off to the side, in its cyan and pink
  ctx.font = `900 40px ${SYMBOL}`;
  ctx.fillStyle = '#25f4ee';
  ctx.fillText('♪', 52, 112);
  ctx.fillStyle = '#fe2c55';
  ctx.fillText('♪', 56, 116);
  ctx.fillStyle = '#ffffff';
  ctx.fillText('♪', 54, 114);
  // double-tap: a big heart pops in the middle
  const p = pop(t, 6.2, 0.8);
  if (p.a > 0) {
    ctx.globalAlpha = p.a;
    ctx.save();
    ctx.translate(160, 66);
    ctx.scale(p.s, p.s);
    ctx.rotate(-0.2);
    ctx.fillStyle = '#fe2c55';
    emoji(ctx, '♥', 0, 0, 70, true);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

// ------------------------------------------------------------ the video site

const YT_ROW = 96;
const YT_THUMBS = [
  ['#ff8a80', '🎮'], ['#80d8ff', '🍳'], ['#ea80fc', '🚗'], ['#ffd180', '🎸'], ['#b9f6ca', '🐱'],
  ['#ffab91', '🏀'], ['#a7ffeb', '🧪'], ['#c5cae9', '🎤'], ['#ffe082', '🐶'], ['#f8bbd0', '🍰'],
];
const YT_PICK = 4; // the thumbnail it clicks at 4.0 (row 2, left), a cat video
function ytBar(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, 26);
  ctx.fillStyle = '#ff0000';
  roundRect(ctx, 10, 6, 22, 15, 4);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(18, 9.5); ctx.lineTo(25, 13.5); ctx.lineTo(18, 17.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#0f0f0f';
  ctx.font = '800 13px "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('YouTube', 36, 18);
  ctx.strokeStyle = '#d3d3d3';
  ctx.lineWidth = 1;
  roundRect(ctx, 108, 6, 130, 15, 7.5);
  ctx.stroke();
}
function ytHome(ctx: CanvasRenderingContext2D, off: number) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  const first = Math.max(0, Math.floor(off / YT_ROW));
  for (let r = first; r < first + 3; r++) {
    for (let col = 0; col < 2; col++) {
      const i = r * 2 + col;
      const x = 34 + col * 132;
      const y = 34 + r * YT_ROW - off;
      const [tint, pic] = YT_THUMBS[i % YT_THUMBS.length];
      ctx.fillStyle = tint;
      roundRect(ctx, x, y, 120, 64, 6);
      ctx.fill();
      ctx.fillStyle = INK;
      emoji(ctx, pic, x + 60, y + 32, 30);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(x + 96, y + 52, 20, 9);
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 7px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${3 + (i % 7)}:${10 + ((i * 17) % 50)}`, x + 106, y + 59);
      bars(ctx, x, y + 70, [110 - (i % 3) * 16, 64], 4, 8, '#c4c4c4');
    }
  }
  ytBar(ctx);
}
function youtube(ctx: CanvasRenderingContext2D, t: number) {
  // the list scrolls with the flicks before and after the video (4.0 is a click, not a scroll)
  const before = scrolled(t, YT_ROW, [1.0, 2.0, 3.0]) * (2 / 3); // ends with the cat video's row in view
  const after = scrolled(t, YT_ROW, [7.0, 8.0]);
  const off = before + after;
  const watching = t >= 4.0 && t < 7.0;
  if (!watching) {
    ytHome(ctx, off);
    // the pointer drifts to the cat video just before it clicks
    if (t > 3.2 && t < 4.05) {
      const k = easeOut((t - 3.2) / 0.6);
      const r = Math.floor(YT_PICK / 2);
      const tx = 34 + 60;
      const ty = 34 + r * YT_ROW - off + 32;
      pointer(ctx, 230 + (tx - 230) * k, 170 + (ty - 170) * k);
    }
    return;
  }
  // the video page: a player that's really playing, a title, a like button
  const v = t - 4.0;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#0f0f0f';
  ctx.fillRect(20, 30, 200, 112);
  // the cat, knocking a cup off the table (and the robot loses it at 4.8)
  ctx.fillStyle = '#b9a07a';
  ctx.fillRect(20, 112, 200, 30);
  const knock = clamp((v - 0.6) / 0.5, 0, 1);
  ctx.save();
  ctx.translate(150 + knock * 40, 102 + knock * knock * 34);
  ctx.rotate(knock * 2.4);
  emoji(ctx, '☕', 0, 0, 20);
  ctx.restore();
  ctx.save();
  ctx.translate(100, 92);
  ctx.rotate(v > 0.6 && v < 1.4 ? Math.sin(v * 20) * 0.08 : 0);
  emoji(ctx, v > 0.8 ? '😹' : '🐱', 0, 0, 44);
  ctx.restore();
  // progress bar
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(20, 139, 200, 3);
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(20, 139, 200 * Math.min(1, 0.05 + v / 3.2), 3);
  // title, channel, like button
  bars(ctx, 20, 150, [170, 110], 5, 9, '#3a3a3a');
  ctx.fillStyle = '#e6e6e6';
  ctx.beginPath();
  ctx.arc(28, 180, 7, 0, Math.PI * 2);
  ctx.fill();
  const liked = t >= 6.2;
  ctx.fillStyle = liked ? '#0f0f0f' : '#f2f2f2';
  roundRect(ctx, 150, 172, 52, 16, 8);
  ctx.fill();
  ctx.fillStyle = liked ? '#ffffff' : '#0f0f0f';
  ctx.font = `700 9px ${EMOJI}`;
  ctx.textAlign = 'center';
  ctx.fillText(liked ? '👍 1.3M' : '👍 1.2M', 176, 183);
  // up-next on the right
  for (let i = 0; i < 3; i++) {
    const [tint, pic] = YT_THUMBS[(i + 6) % YT_THUMBS.length];
    ctx.fillStyle = tint;
    roundRect(ctx, 232, 30 + i * 50, 70, 40, 4);
    ctx.fill();
    ctx.fillStyle = INK;
    emoji(ctx, pic, 267, 50 + i * 50, 18);
  }
  ytBar(ctx);
  const p = pop(t, 6.2, 0.7);
  if (p.a > 0) {
    ctx.globalAlpha = p.a;
    ctx.save();
    ctx.translate(176, 160);
    ctx.scale(p.s * 1.4, p.s * 1.4);
    emoji(ctx, '👍', 0, 0, 22);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

export const FEEDS: Record<string, ScreenScene> = { facebook, tiktok, youtube };
// the colour each one casts on the robot and the desk
export const FEED_LIGHT: Record<string, string> = { facebook: '#dfe8ff', tiktok: '#ff4f9a', youtube: '#ffffff' };
