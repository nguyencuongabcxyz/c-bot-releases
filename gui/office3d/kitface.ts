import { roundRect } from './materials';
import { FACE_W, FACE_H, drawFace } from './face';
import type { DrawFace, FaceState } from './face';

// The faces a robot you build (kit3d.js) can have on its face screen. Each draws the same
// expressions as the classic face (face.js): eyes open / closed / happy / dizzy / flat,
// blinking, looking at the mouse; mouth smile / talk / o / wide / chomp / flat; blush.
//   kitFace(style, eyeColor) -> drawFace(ctx, f)   (eyeColor '' follows its brain, like the classic)
// Styles: dots (the classic), cute (big shiny eyes), visor (a glowing band), cyclops (one big
// eye), pixel (chunky pixels, like an old handheld).

const EYES: Record<string, string> = { default: '#7ff3ff', opus: '#c4a8ff', fable: '#ffd34d', sonnet: '#7ff3ff', haiku: '#7bed9f' };

function screen(ctx: CanvasRenderingContext2D, f: FaceState, r = 44) {
  ctx.clearRect(0, 0, FACE_W, FACE_H);
  ctx.fillStyle = f.asleep ? '#121524' : '#1d2235';
  roundRect(ctx, 4, 4, FACE_W - 8, FACE_H - 8, r);
  ctx.fill();
}

// the classic face's mouths, at (mx, my), k times the size
function mouth(ctx: CanvasRenderingContext2D, f: FaceState, eye: string, mx: number, my: number, k = 1) {
  ctx.fillStyle = eye;
  ctx.strokeStyle = eye;
  ctx.lineWidth = 9 * k;
  ctx.lineCap = 'round';
  switch (f.mouth) {
    case 'talk': {
      const open = (4 + Math.abs(Math.sin(f.t * 18)) * 11) * k;
      ctx.beginPath();
      ctx.ellipse(mx, my, 16 * k, open, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'o':
      ctx.beginPath();
      ctx.ellipse(mx, my, 10 * k, 13 * k, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'wide':
    case 'chomp': {
      const open = (f.mouth === 'wide' ? 15 + Math.sin(f.t * 9) * 3 : Math.abs(Math.sin(f.t * 14)) * 20) * k;
      ctx.beginPath();
      if (open > 3) ctx.ellipse(mx, my, 24 * k, open, 0, 0, Math.PI * 2);
      else ctx.rect(mx - 24 * k, my - 3, 48 * k, 6);
      ctx.fill();
      break;
    }
    case 'flat':
      ctx.beginPath();
      ctx.moveTo(mx - 18 * k, my);
      ctx.lineTo(mx + 18 * k, my);
      ctx.stroke();
      break;
    default:
      ctx.beginPath();
      ctx.moveTo(mx - 22 * k, my - 4 * k);
      ctx.quadraticCurveTo(mx, my + 16 * k, mx + 22 * k, my - 4 * k);
      ctx.stroke();
  }
}

// an eye at (x, y) about r big, in one of the expressions (round eyes)
function roundEye(ctx: CanvasRenderingContext2D, f: FaceState, x: number, y: number, rx: number, ry: number, glints: [number, number, number][]) {
  switch (f.eyes) {
    case 'closed':
      ctx.beginPath();
      ctx.moveTo(x - rx, y);
      ctx.quadraticCurveTo(x, y + ry * 0.65, x + rx, y);
      ctx.stroke();
      return;
    case 'happy':
      ctx.beginPath();
      ctx.moveTo(x - rx, y + ry * 0.3);
      ctx.quadraticCurveTo(x, y - ry * 0.9, x + rx, y + ry * 0.3);
      ctx.stroke();
      return;
    case 'dizzy':
      ctx.beginPath();
      for (let a = 0; a < Math.PI * 5; a += 0.2) {
        const r = 2 + a * (rx / 14);
        const px = x + Math.cos(a + f.t * 8) * r;
        const py = y + Math.sin(a + f.t * 8) * r;
        a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();
      return;
    case 'flat':
      ctx.beginPath();
      ctx.moveTo(x - rx, y);
      ctx.lineTo(x + rx, y);
      ctx.stroke();
      return;
  }
  const sy = Math.max(0.08, 1 - f.blink);
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry * sy, 0, 0, Math.PI * 2);
  ctx.fill();
  if (sy > 0.5) {
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff';
    for (const [gx, gy, gr] of glints) {
      ctx.beginPath();
      ctx.arc(x + gx * rx, y + gy * ry, gr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function blush(ctx: CanvasRenderingContext2D, f: FaceState, always?: boolean) {
  if (!f.blush && !always) return;
  ctx.fillStyle = f.blush ? 'rgba(255,122,162,0.6)' : 'rgba(255,122,162,0.32)';
  for (const x of [44, 212]) {
    ctx.beginPath();
    ctx.ellipse(x, 124, 18, 11, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function glowPen(ctx: CanvasRenderingContext2D, f: FaceState, eye: string, width: number) {
  ctx.shadowColor = eye;
  ctx.shadowBlur = f.asleep ? 4 : 14;
  ctx.strokeStyle = eye;
  ctx.fillStyle = eye;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = width;
}

const STYLES: Record<string, (ctx: CanvasRenderingContext2D, f: FaceState, eye: string) => void> = {
  cute(ctx, f, eye) {
    screen(ctx, f, 52);
    const lx = f.lookX * 3;
    const ly = f.lookY * 3;
    ctx.save();
    glowPen(ctx, f, eye, 10);
    for (const x of [84, 172]) roundEye(ctx, f, x + lx, 76 + ly, 27, 33, [[0.32, -0.36, 9], [-0.3, 0.34, 4.5]]);
    mouth(ctx, f, eye, 128 + lx * 0.6, 132 + ly * 0.6, 0.7);
    ctx.restore();
    blush(ctx, f, true);
  },
  visor(ctx, f, eye) {
    screen(ctx, f, 30);
    const lx = f.lookX * 4;
    const ly = f.lookY * 2;
    // the band
    ctx.save();
    ctx.globalAlpha = f.asleep ? 0.12 : 0.22;
    ctx.fillStyle = eye;
    roundRect(ctx, 16, 46, FACE_W - 32, 60, 30);
    ctx.fill();
    ctx.restore();
    ctx.save();
    glowPen(ctx, f, eye, 9);
    const y = 76 + ly;
    for (const x of [92 + lx, 164 + lx]) {
      if (f.eyes === 'open' || !['closed', 'happy', 'dizzy', 'flat'].includes(f.eyes)) {
        const h = Math.max(3, 22 * (1 - f.blink));
        roundRect(ctx, x - 22, y - h / 2, 44, h, Math.min(8, h / 2));
        ctx.fill();
      } else roundEye(ctx, f, x, y, 20, 18, []);
    }
    mouth(ctx, f, eye, 128 + lx * 0.5, 134, 0.75);
    ctx.restore();
    blush(ctx, f);
  },
  cyclops(ctx, f, eye) {
    screen(ctx, f);
    const lx = f.lookX * 5;
    const ly = f.lookY * 4;
    ctx.save();
    glowPen(ctx, f, eye, 12);
    roundEye(ctx, f, 128 + lx, 72 + ly, 40, 40, [[0.34, -0.36, 11], [-0.32, 0.3, 5]]);
    // a pupil, looking where it looks
    if ((f.eyes === 'open' || !['closed', 'happy', 'dizzy', 'flat'].includes(f.eyes)) && f.blink < 0.5) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#1d2235';
      ctx.beginPath();
      ctx.arc(128 + lx * 2.2, 74 + ly * 2, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(134 + lx * 2.2, 67 + ly * 2, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    mouth(ctx, f, eye, 128 + lx * 0.6, 136 + ly * 0.5, 0.85);
    ctx.restore();
    blush(ctx, f);
  },
  pixel(ctx, f, eye) {
    screen(ctx, f, 20);
    const C = 16; // one pixel
    const ox = Math.round(f.lookX) * C * 0.5;
    const oy = Math.round(f.lookY) * C * 0.5;
    ctx.save();
    ctx.shadowColor = eye;
    ctx.shadowBlur = f.asleep ? 2 : 8;
    ctx.fillStyle = eye;
    const px = (cells: number[][], x0: number, y0: number) => {
      for (const [cx, cy] of cells) ctx.fillRect(x0 + cx * C + ox + 1, y0 + cy * C + oy + 1, C - 2, C - 2);
    };
    const shut = f.blink > 0.5;
    const EYE_CELLS: Record<string, number[][]> = {
      open: shut ? [[0, 2], [1, 2], [2, 2]] : [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]],
      closed: [[0, 2], [1, 2], [2, 2]],
      happy: [[0, 2], [1, 1], [2, 2]],
      dizzy: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
      flat: [[0, 1], [1, 1], [2, 1]],
    };
    const cells = EYE_CELLS[f.eyes] || EYE_CELLS.open;
    const w = f.eyes === 'open' && !shut ? 2 : 3;
    px(cells, 72 - (w * C) / 2, 36);
    px(cells, 184 - (w * C) / 2, 36);
    const talking = f.mouth === 'talk' || f.mouth === 'chomp' ? Math.sin(f.t * 16) > 0 : false;
    const MOUTH_CELLS: Record<string, number[][]> = {
      smile: [[0, 0], [1, 1], [2, 1], [3, 1], [4, 0]],
      o: [[1, 0], [2, 0], [1, 1], [2, 1]],
      flat: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
      wide: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [0, 1], [4, 1], [1, 2], [2, 2], [3, 2]],
      talk: talking ? [[1, 0], [2, 0], [3, 0], [1, 1], [2, 1], [3, 1]] : [[1, 0], [2, 0], [3, 0]],
      chomp: talking ? [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [0, 1], [4, 1]] : [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
    };
    const m = MOUTH_CELLS[f.mouth] || MOUTH_CELLS.smile;
    const mw = Math.max(...m.map(([x]) => x)) + 1;
    px(m, 128 - (mw * C) / 2, 110);
    ctx.restore();
    if (f.blush) {
      ctx.fillStyle = 'rgba(255,122,162,0.6)';
      for (const x of [28, 212]) ctx.fillRect(x, 112, C, C / 2);
    }
  },
};

export const KIT_FACES = ['dots', 'cute', 'visor', 'cyclops', 'pixel'];

export function kitFace(style: string, eyeColor = ''): DrawFace {
  const draw = STYLES[style];
  return (ctx, f) => {
    const eye = eyeColor || EYES[f.model ?? ''] || EYES.default;
    if (!draw) return drawFace(ctx, { ...f, eyeColor: eye }); // dots: the classic face
    draw(ctx, f, eye);
  };
}
