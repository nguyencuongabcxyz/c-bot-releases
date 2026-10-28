// The monitor shows what Claude Code is doing. Each scene is drawn onto a SCREEN_W x SCREEN_H
// canvas every frame it's visible; `t` is seconds since the scene began. The scenes: work.ts
// (its work), idle.ts (idle antics, dreams), gags.ts (office gags), ../feeds.ts (social feeds).
import { GAG_SCENES } from './gags';
import { IDLE_SCENES } from './idle';
import { WORK_SCENES } from './work';
import { FEEDS, FEED_LIGHT } from '../feeds';
import type { ScreenScene, Theme } from '../themes';

const SCENES: Record<string, ScreenScene> = {
  ...WORK_SCENES,
  ...IDLE_SCENES,
  ...GAG_SCENES,
};

// the robot slacking off on social feeds (feeds.js)
Object.assign(SCENES, FEEDS);

export function drawScreen(ctx: CanvasRenderingContext2D, scene: string, t: number, paint: string, theme?: Theme) {
  ctx.save();
  ctx.textAlign = 'left';
  // "helpers": the robot supervising its helper agents shows the helper-bots scene too
  let name = scene === 'helpers' ? 'agent' : scene;
  // "dream:🐟" / "define:meticulous": the scene, given what to show
  let text = '';
  const colon = typeof name === 'string' ? name.indexOf(':') : -1;
  if (colon > 0) {
    text = name.slice(colon + 1);
    name = name.slice(0, colon);
  }
  const accent = theme?.screen?.accent || paint;
  (theme?.screen?.scenes?.[name] || SCENES[name] || SCENES.idle)(ctx, t, accent, theme, text);
  ctx.restore();
}

// Colour the monitor casts onto the robot and desk for each scene.
// (A scene given text, like "dream:<emoji>", is looked up by its name, "dream".)
export const SCREEN_LIGHT: Record<string, string | null> = {
  off: null,
  boot: '#ffffff',
  idle: '#7bed9f',
  think: '#7ff3ff',
  read: '#ffffff',
  search: '#ffffff',
  edit: '#a29bfe',
  run: '#7bed9f',
  web: '#5aa0ff',
  agent: '#ffd34d',
  helpers: '#ffd34d',
  plan: '#ffffff',
  talk: '#ffffff',
  done: '#2fbf71',
  ask: '#ffd34d',
  compact: '#ff9f43',
  error: '#2463d1',
  locked: '#ffd34d',
  dvd: '#4a5288',
  'dvd-lucky': '#4a5288',
  dream: '#7d6cff',
  gibberish: '#3f9e6a',
  dance: '#ff6bd6',
  frozen: '#dfe8f5',
  stackoverflow: '#ffe2c4',
  merge: '#ff7b8a',
  works: '#7bed9f',
  payday: '#5fd39a',
  brb: '#ffe680',
  define: '#fff3d6',
  wordcard: '#fff3d6',
  ...FEED_LIGHT,
};
