// The monitor while it works: what Claude Code is doing (reading, searching, editing, running…),
// and the screens for when it's off, done, stuck or dancing.
import { bg, lines } from './draw';
import { SCREEN_W, SCREEN_H, INK } from '@/office3d/core/constants';
import { roundRect } from '../materials';
import type { ScreenScene } from '../themes';

export const WORK_SCENES: Record<string, ScreenScene> = {
  off(ctx) {
    bg(ctx, '#0b0d16');
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(30, 90);
    ctx.lineTo(110, 30);
    ctx.moveTo(60, 120);
    ctx.lineTo(160, 45);
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
    roundRect(ctx, 90, 130, 140, 10, 5);
    ctx.fill();
    ctx.fillStyle = paint;
    roundRect(ctx, 90, 130, 140 * Math.min(1, t / 0.9), 10, 5);
    ctx.fill();
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
    const code: [number, string, number][] = [
      [40, '#ff8fb1', 0.45],
      [60, '#7ff3ff', 0.7],
      [60, '#ffd34d', 0.35],
      [80, '#7bed9f', 0.6],
      [60, '#a29bfe', 0.45],
      [40, '#ff8fb1', 0.25],
      [60, '#7ff3ff', 0.55],
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
        ctx.fillRect(34, y, 120 + ((row * 37) % 90), 9);
      } else {
        ctx.fillStyle = 'rgba(123,237,159,0.55)';
        ctx.fillRect(14, y, 110 + ((row * 53) % 170), 9);
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
    const bot = (x: number, color: string, phase: number) => {
      const y = 95 - Math.abs(Math.sin(t * 5 + phase)) * 24;
      ctx.fillStyle = color;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 5;
      roundRect(ctx, x - 36, y, 72, 56, 16);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(x - 14, y + 26, 7, 0, 7);
      ctx.arc(x + 14, y + 26, 7, 0, 7);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - 18);
      ctx.stroke();
      ctx.fillStyle = '#ff5e62';
      ctx.beginPath();
      ctx.arc(x, y - 22, 7, 0, 7);
      ctx.fill();
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
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#b9bfd3';
      ctx.fillRect(80, y + 10, [170, 130, 190][i], 10);
      if (cycle > 0.6 + i * 0.6) {
        ctx.strokeStyle = '#2fbf71';
        ctx.lineWidth = 7;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(36, y + 15);
        ctx.lineTo(44, y + 23);
        ctx.lineTo(56, y + 6);
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
    ctx.moveTo(120, 135);
    ctx.lineTo(100, 165);
    ctx.lineTo(150, 135);
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
    ctx.moveTo(-50, 0);
    ctx.lineTo(-14, 36);
    ctx.lineTo(56, -40);
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
    ctx.beginPath();
    ctx.arc(0, 26, 8, 0, 7);
    ctx.fill();
    ctx.restore();
  },
};
