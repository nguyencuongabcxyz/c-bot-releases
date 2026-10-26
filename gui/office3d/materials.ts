import * as THREE from 'three';
import type { Theme } from './themes';

// Cel-shaded look: a 3-step gradient map gives flat cartoon bands of light.
let gradient: THREE.DataTexture | null = null;
function toonGradient() {
  if (gradient) return gradient;
  gradient = new THREE.DataTexture(new Uint8Array([110, 185, 255]), 3, 1, THREE.RedFormat);
  gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  return gradient;
}

export function toon(color: THREE.ColorRepresentation, extra: THREE.MeshToonMaterialParameters = {}) {
  return new THREE.MeshToonMaterial({ color, gradientMap: toonGradient(), ...extra });
}

// Unlit, glowing surfaces (screens, LEDs). These skip the ink outline.
export function glow(color: THREE.ColorRepresentation, extra: THREE.MeshBasicMaterialParameters = {}) {
  const m = new THREE.MeshBasicMaterial({ color, toneMapped: false, ...extra });
  m.userData.outlineParameters = { visible: false };
  return m;
}

export function noOutline<M extends THREE.Material>(material: M) {
  material.userData.outlineParameters = { visible: false };
  return material;
}

/** A canvas, its 2D context and a texture of it (canvasTexture). */
export type CanvasTex = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture };
export type CanvasDraw = (ctx: CanvasRenderingContext2D, width: number, height: number) => void;

export function canvasTexture(width: number, height: number, draw?: CanvasDraw): CanvasTex {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!; // (a new canvas always has one)
  draw?.(ctx, width, height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { canvas, ctx, tex };
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ------------------------------------------------------------ painted props

export function badgeTexture(name: string | null | undefined, color: string, theme?: Theme) {
  const brand = theme?.brand;
  const header = theme?.robot?.badge || color;
  return canvasTexture(96, 128, (ctx, w, h) => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = header;
    ctx.fillRect(0, 0, w, 28);
    if (brand) {
      // the company's logo where the photo would be
      brand.logo(ctx, 18, 40, 60, false);
    } else {
      ctx.fillStyle = '#dfe2ee';
      ctx.fillRect(28, 38, 40, 44);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(48, 56, 12, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = brand?.ink || '#1d2235';
    ctx.font = '700 15px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText((name || 'ROBO').slice(0, 9), 48, 104);
    ctx.font = '600 10px "Segoe UI", sans-serif';
    ctx.fillText(brand ? brand.short.toUpperCase().slice(0, 15) : 'ENGINEER', 48, 120);
  });
}

// Soft sprite textures for particles.
export function spriteTexture(kind: string) {
  return canvasTexture(64, 64, (ctx) => {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (kind === 'steam') {
      const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
    } else if (kind === 'z') {
      ctx.font = '900 44px "Segoe UI", sans-serif';
      ctx.lineWidth = 8;
      ctx.strokeStyle = '#fff';
      ctx.strokeText('Z', 32, 34);
      ctx.fillStyle = '#1d2235';
      ctx.fillText('Z', 32, 34);
    } else if (kind === 'heart') {
      ctx.fillStyle = '#ff5e8a';
      ctx.strokeStyle = '#1d2235';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(32, 54);
      ctx.bezierCurveTo(4, 34, 10, 8, 32, 20);
      ctx.bezierCurveTo(54, 8, 60, 34, 32, 54);
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'sweat') {
      ctx.fillStyle = '#7fd3ff';
      ctx.strokeStyle = '#1d2235';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(32, 6);
      ctx.bezierCurveTo(50, 32, 50, 58, 32, 58);
      ctx.bezierCurveTo(14, 58, 14, 32, 32, 6);
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'bulb') {
      ctx.fillStyle = '#ffe57a';
      ctx.strokeStyle = '#1d2235';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(32, 26, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#8a90a6';
      ctx.fillRect(24, 44, 16, 12);
      ctx.strokeRect(24, 44, 16, 12);
    } else if (kind === 'doc') {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#1d2235';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(14, 6); ctx.lineTo(40, 6); ctx.lineTo(52, 18); ctx.lineTo(52, 58); ctx.lineTo(14, 58); ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#b9bfd3';
      for (let i = 0; i < 4; i++) ctx.fillRect(20, 24 + i * 8, i % 2 ? 20 : 26, 4);
    } else if (kind === 'crumb') {
      ctx.fillStyle = '#e8ebf5';
      ctx.strokeStyle = '#1d2235';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(14, 20); ctx.lineTo(46, 12); ctx.lineTo(52, 44); ctx.lineTo(20, 52); ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'question') {
      ctx.font = '900 46px "Segoe UI", sans-serif';
      ctx.lineWidth = 8;
      ctx.strokeStyle = '#1d2235';
      ctx.strokeText('?', 32, 34);
      ctx.fillStyle = '#ffd34d';
      ctx.fillText('?', 32, 34);
    } else if (kind === 'note') {
      // a music note (humming)
      ctx.fillStyle = '#1d2235';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 5;
      ctx.lineJoin = 'round';
      ctx.font = '900 46px "Segoe UI Symbol", "Segoe UI", sans-serif';
      ctx.strokeText('♪', 32, 34);
      ctx.fillText('♪', 32, 34);
    } else if (kind === 'ball') {
      // a crumpled paper ball
      ctx.fillStyle = '#f4f5fa';
      ctx.strokeStyle = '#1d2235';
      ctx.lineWidth = 4;
      ctx.beginPath();
      for (let i = 0; i < 11; i++) {
        const a = (i / 11) * Math.PI * 2;
        const r = i % 2 ? 22 : 26;
        ctx.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#9aa1b8';
      ctx.beginPath();
      ctx.moveTo(18, 26); ctx.lineTo(30, 34); ctx.lineTo(44, 22);
      ctx.moveTo(26, 46); ctx.lineTo(36, 38); ctx.lineTo(46, 44);
      ctx.stroke();
    } else if (kind === 'bolt') {
      // a lightning bolt, for charging up
      ctx.fillStyle = '#ffd34d';
      ctx.strokeStyle = '#1d2235';
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(38, 4); ctx.lineTo(14, 36); ctx.lineTo(30, 36);
      ctx.lineTo(24, 60); ctx.lineTo(50, 24); ctx.lineTo(34, 24);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'haha') {
      // a giggle, for tickling
      ctx.font = '900 26px "Segoe UI", sans-serif';
      ctx.lineWidth = 6;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#1d2235';
      ctx.strokeText('ha!', 32, 34);
      ctx.fillStyle = '#ff9f43';
      ctx.fillText('ha!', 32, 34);
    } else if (kind === 'squeak') {
      ctx.font = '900 15px "Segoe UI", sans-serif';
      ctx.lineWidth = 5;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#1d2235';
      ctx.strokeText('SQUEAK!', 32, 34);
      ctx.fillStyle = '#ff4f9a';
      ctx.fillText('SQUEAK!', 32, 34);
    } else if (kind === 'star') {
      ctx.fillStyle = '#ffd34d';
      ctx.strokeStyle = '#1d2235';
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 11 : 26;
        ctx.lineTo(32 + Math.cos(a) * r, 34 + Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }).tex;
}
