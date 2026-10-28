// Cloth for the kit's clothes: printed patterns (flowers, dots, stripes), and putting a piece on
// (it casts a shadow).
import * as THREE from 'three';
import { canvasTexture, type CanvasDraw } from './materials';

export const put = <T extends THREE.Object3D>(parent: THREE.Object3D, m: T) => {
  m.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });
  parent.add(m);
  return m;
};

// ---------------------------------------------------------------- patterns

const pattern = (() => {
  const cache = new Map<string, THREE.CanvasTexture>();
  return (key: string, draw: CanvasDraw) => {
    let t = cache.get(key);
    if (!t) {
      t = canvasTexture(128, 128, draw).tex;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      cache.set(key, t);
    }
    return t;
  };
})();
export const flowers = (bg: string) =>
  pattern(`flowers${bg}`, (ctx) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 128, 128);
    const petal = (x: number, y: number, c: string) => {
      ctx.fillStyle = c;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.ellipse(x + Math.cos(a) * 7, y + Math.sin(a) * 7, 6, 4, a, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#ffd34d';
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    };
    petal(28, 30, '#ffffff');
    petal(90, 22, '#ff8fb1');
    petal(64, 76, '#ffffff');
    petal(18, 104, '#ff8fb1');
    petal(108, 100, '#ffffff');
    ctx.fillStyle = 'rgba(40, 140, 80, 0.8)';
    for (const [x, y] of [
      [48, 50],
      [110, 60],
      [40, 82],
      [86, 118],
    ]) {
      ctx.beginPath();
      ctx.ellipse(x, y, 10, 4, 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
  });
export const dots = (bg: string, dot: string) =>
  pattern(`dots${bg}${dot}`, (ctx) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = dot;
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        ctx.beginPath();
        ctx.arc(16 + x * 32 + (y % 2) * 16, 16 + y * 32, 6, 0, Math.PI * 2);
        ctx.fill();
      }
  });
export const stripes = (a: string, b: string, n = 8) =>
  pattern(`stripes${a}${b}${n}`, (ctx) => {
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i % 2 ? b : a;
      ctx.fillRect(0, (i * 128) / n, 128, 128 / n);
    }
  });
