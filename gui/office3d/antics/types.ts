// What an antic gets and gives (antics/index.ts runs them): see the notes there.
import type * as THREE from 'three';
import type { Bed, OfficeSet, Rig } from '@/office3d/types';

export type Vec3Tuple = [number, number, number];

/** The particle sprites there are (materials spriteTexture; index.ts makes one of each). */
export type ParticleKind =
  | 'steam'
  | 'z'
  | 'heart'
  | 'sweat'
  | 'bulb'
  | 'question'
  | 'doc'
  | 'crumb'
  | 'star'
  | 'squeak'
  | 'note'
  | 'ball'
  | 'bolt'
  | 'haha';
/** A puff, a star, a Z… floating off from a point (index.ts emit). */
export type ParticleOpts = {
  life?: number;
  vel?: THREE.Vector3;
  size?: number;
  grow?: number;
  spin?: number;
  gravity?: number;
};
export type Emit = (kind: ParticleKind, pos: THREE.Vector3, opts?: ParticleOpts) => void;

/** The pose being drawn this frame; an antic changes it in place. */
export type AnticPose = {
  lean: number;
  head: Vec3Tuple;
  armL: Vec3Tuple;
  armR: Vec3Tuple;
  yaw: number; // extra chair swivel (radians)
  tip: number; // chair tipped back (radians, + leans back)
  rootY: number; // the robot slides in its seat
  rootZ: number; // (+z is towards its knees)
  mug: THREE.Vector3; // offset of the mug from where it sits (office space)
  mugTilt: number;
  lamp: number; // desk-lamp brightness factor (1 = as normal, 0 = off)
  screen: string | null; // a monitor scene to show instead (drawn with time = s)
  screenDim: number;
  shake: number; // desk shake strength (0..1)
  reachL: number; // cartoon arm stretch (1 = normal length)
  reachR: number;
  antenna: number; // extra sideways swing of the antenna
  boardLift: number; // the corkboard held up (0..1, a reminder: notes.js)
};

/** What the nightcap and the late-night hood need (index.ts wearTick, out for a walk too). */
export type WearCtx = {
  robot: Rig;
  t: number;
  dt: number;
  nightcap: boolean;
  lateNight: boolean; // awake past 10 pm: hood up
  asleep: boolean;
};

/** What every frame gives the ticks (and, with AnticPlay, an antic). */
export type TickCtx = WearCtx & {
  body: string;
  set: OfficeSet;
  emit: Emit;
  worldPoint: (obj: THREE.Object3D, x: number, y: number, z: number) => THREE.Vector3;
  mix: (a: number, b: number, k: number) => number;
  toward: <T extends number[]>(arr: T, target: readonly number[], k: number) => T;
  THREE: typeof THREE;
  antic: string; // what's playing ('' for nothing)
  camYaw: number;
  monitorYaw: number;
  curYaw: number;
  mugHome: THREE.Vector3;
  lampHome: THREE.Vector3;
  sleepStyle: string; // asleep in the chair (eye mask) or on the floor (blanket): 'chair' | 'floor'
  bed: Bed | null; // the floor bed
  hand: (side?: 'L' | 'R') => THREE.Vector3;
  say: (text: string, kind?: 'speech' | 'thought') => void;
};

/** An antic's own scratch state (meshes it added, "already emitted" flags…). It starts out
 *  empty ({}), so a handler with a typed view of its own (Antic<{ legs?: Leg[] }>, a type
 *  alias) makes every field optional. */
export type AnticScratch = Record<string, unknown>;

/** What's added while an antic plays. R: its scratch, as the handler sees it. */
export type AnticPlay<R extends object = AnticScratch> = {
  s: number; // seconds in
  p: number; // s / dur
  w: number; // 0..1 weight that eases in and out
  dur: number;
  text: string;
  run: R;
};

/** What an antic may use (update, place, bubbleAt). */
export type AnticCtx<R extends object = AnticScratch> = TickCtx & AnticPlay<R>;

/** What end(c) gets, cut short or done: the last frame's context with its own scratch and
 *  robot; the play fields (s, p, w, dur, text) aren't there if it ended before playing a frame. */
export type AnticEndCtx<R extends object = AnticScratch> = TickCtx & Partial<AnticPlay<R>> & { run: R };

/** One antic: { dur, fadeIn?, fadeOut?, update(c, A), end?(c), place?(c), bubbleAt?(c) }.
 *  R types its scratch (c.run); an Antic<R> still goes in a Record<string, Antic>. */
export type Antic<R extends object = AnticScratch> = {
  dur: number;
  fadeIn?: number;
  fadeOut?: number;
  update(c: AnticCtx<R>, A: AnticPose): void;
  end?(c: AnticEndCtx<R>): void;
  place?(c: AnticCtx<R>): void;
  bubbleAt?(c: AnticCtx<R>): THREE.Vector3 | null | undefined;
};

/** Something that lives outside one antic (the standing desk, the bin): every frame, before
 *  the antic. (The nightcap's and the hood's ticks are also worn out for a walk, by wearTick,
 *  with only a WearCtx: type those (c: WearCtx) => void, which fits here too.) */
export type AnticTick = (c: TickCtx, A: AnticPose) => void;
