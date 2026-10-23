import { roundRect } from './materials.js';

// The robot's face screen, drawn in 2D and mapped onto the front of its head.
export const FACE_W = 256;
export const FACE_H = 176;

// eye colour follows the robot's brain (model)
const EYES = { default: '#7ff3ff', opus: '#c4a8ff', fable: '#ffd34d', sonnet: '#7ff3ff', haiku: '#7bed9f' };

/**
 * f: { eyes, mouth, lookX, lookY, blink (0..1 closed), blush, asleep, t }
 */
export function drawFace(ctx, f) {
  const EYE = EYES[f.model] || EYES.default;
  ctx.clearRect(0, 0, FACE_W, FACE_H);
  ctx.fillStyle = f.asleep ? '#121524' : '#1d2235';
  roundRect(ctx, 4, 4, FACE_W - 8, FACE_H - 8, 44);
  ctx.fill();

  const lx = f.lookX * 3;
  const ly = f.lookY * 3;
  const ex = [88 + lx, 168 + lx];
  const ey = 78 + ly;

  ctx.save();
  ctx.shadowColor = EYE;
  ctx.shadowBlur = f.asleep ? 4 : 14;
  ctx.strokeStyle = EYE;
  ctx.fillStyle = EYE;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 10;

  switch (f.eyes) {
    case 'closed':
      for (const x of ex) {
        ctx.beginPath();
        ctx.moveTo(x - 20, ey);
        ctx.quadraticCurveTo(x, ey + 16, x + 20, ey);
        ctx.stroke();
      }
      break;
    case 'happy':
      for (const x of ex) {
        ctx.beginPath();
        ctx.moveTo(x - 20, ey + 8);
        ctx.quadraticCurveTo(x, ey - 22, x + 20, ey + 8);
        ctx.stroke();
      }
      break;
    case 'dizzy':
      ctx.lineWidth = 7;
      for (const x of ex) {
        ctx.beginPath();
        for (let a = 0; a < Math.PI * 5; a += 0.2) {
          const r = 2 + a * 1.4;
          const px = x + Math.cos(a + f.t * 8) * r;
          const py = ey + Math.sin(a + f.t * 8) * r;
          a === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      break;
    case 'flat':
      for (const x of ex) {
        ctx.beginPath();
        ctx.moveTo(x - 20, ey);
        ctx.lineTo(x + 20, ey);
        ctx.stroke();
      }
      ctx.strokeStyle = '#ff8f8f';
      ctx.shadowColor = '#ff8f8f';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(ex[0] - 24, ey - 30); ctx.lineTo(ex[0] + 18, ey - 20);
      ctx.moveTo(ex[1] + 24, ey - 30); ctx.lineTo(ex[1] - 18, ey - 20);
      ctx.stroke();
      break;
    default: {
      const sy = Math.max(0.08, 1 - f.blink);
      for (const x of ex) {
        ctx.beginPath();
        ctx.ellipse(x, ey, 19, 25 * sy, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (sy > 0.5) {
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#fff';
        for (const x of ex) {
          ctx.beginPath();
          ctx.arc(x + 7, ey - 9, 6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // mouth
  ctx.fillStyle = EYE;
  ctx.strokeStyle = EYE;
  ctx.shadowColor = EYE;
  ctx.lineWidth = 9;
  const mx = 128 + lx * 0.6;
  const my = 128 + ly * 0.6;
  switch (f.mouth) {
    case 'talk': {
      const open = 4 + Math.abs(Math.sin(f.t * 18)) * 11;
      ctx.beginPath();
      ctx.ellipse(mx, my, 16, open, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'o':
      ctx.beginPath();
      ctx.ellipse(mx, my, 10, 13, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'wide': {
      // mouth wide open for incoming food, with a wiggling tongue
      const open = 15 + Math.sin(f.t * 9) * 3;
      ctx.beginPath();
      ctx.ellipse(mx, my, 26, open, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ff7aa2';
      ctx.beginPath();
      ctx.ellipse(mx, my + open * 0.45, 13, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'chomp': {
      const open = Math.abs(Math.sin(f.t * 14)) * 20;
      ctx.beginPath();
      if (open > 3) ctx.ellipse(mx, my, 24, open, 0, 0, Math.PI * 2);
      else ctx.rect(mx - 24, my - 3, 48, 6);
      ctx.fill();
      break;
    }
    case 'flat':
      ctx.beginPath();
      ctx.moveTo(mx - 18, my);
      ctx.lineTo(mx + 18, my);
      ctx.stroke();
      break;
    default:
      ctx.beginPath();
      ctx.moveTo(mx - 22, my - 4);
      ctx.quadraticCurveTo(mx, my + 16, mx + 22, my - 4);
      ctx.stroke();
  }
  ctx.restore();

  if (f.blush) {
    ctx.fillStyle = 'rgba(255,122,162,0.6)';
    for (const x of [44, 212]) {
      ctx.beginPath();
      ctx.ellipse(x, 124, 18, 11, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
