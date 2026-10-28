// The 3D office's pieces, as the modules that build them return them: a robot's rig
// (kit3d.ts, robot3d.ts), the office set round it (scene.ts) and the floor bed (bed.ts).
// The builders are typed with these, so what's here is what they make.
import type * as THREE from 'three';
import type { Kit } from '@/types/model';
import type { CanvasTex } from './materials';
import type { DrawFace } from './face';
import type { Theme } from './themes';
import type { Emit } from './antics/types';
import type { OfficeData } from './protocol';

export type { CanvasTex } from './materials';
export type { DrawFace, FaceState } from './face';
export type { Theme, Brand, ScreenScene } from './themes';

// ---------------------------------------------------------------- the robot

/** A whole kit, as parseKit (kit3d.ts) makes it: every slot filled in (a part name, or a colour). */
export type KitParts = Required<Kit>;

/** Where things go on a body (kit3d.ts BODIES), torso space: the neck, its chest's depth, half its width, its middle. */
export type BodyFit = { top: number; front: number; half: number; mid: number };
/** How a head is shaped (kit3d.ts HEADS), head space: its crown, width, the face's depth and height, the ear bolts. */
export type HeadFit = { top: number; width: number; faceZ: number; faceY: number; earY: number; earX: number };

/** One arm: the shoulder pivots on the torso, the elbow 0.25 below it; the hand is 0.24 below the elbow. */
export type RigArm = { shoulder: THREE.Group; elbow: THREE.Group; side: number }; // side: -1 left, 1 right
export type RigArms = Record<'armL' | 'armR', RigArm>;

/** A built robot (kit3d buildKit): its scene graph and the parts that get posed. */
export type Rig = {
  root: THREE.Group; // origin: the middle of the seat top
  torso: THREE.Group; // pivots at the hips (it leans in)
  head: THREE.Group; // origin: the neck
  antenna: THREE.Group; // what's on top (antenna, ears, hair…)
  antennaBall: THREE.MeshBasicMaterial; // the glowing bit of it (lit in its light colour)
  chest: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>; // the chest light
  arms: RigArms;
  accessory: THREE.Group; // the hat slot (robot3d buildAccessory)
  headband: THREE.Group; // worn at high effort (hidden otherwise)
  headTop: number; // how high the top of its head is above the head's origin
  light: string; // its antenna and chest light colour
  face: CanvasTex & { material: THREE.MeshBasicMaterial }; // the face screen (FACE_W x FACE_H)
  drawFace: DrawFace;
  setColor(c: THREE.ColorRepresentation): void;
  setAccessory(name: string): void;
  setTheme(theme: Theme): void;
};

// ---------------------------------------------------------------- the office

/** A sticky note on the monitor's frame (scene.ts stickies.set). */
export type StickyItem = { id: string; text?: string; sub?: string; color?: string };
/** The sticky notes on the monitor's frame: see buildStickies in scene.ts. */
export type Stickies = {
  objects: THREE.Mesh[];
  set(kind: string, items?: StickyItem[]): void;
  lookup(mesh: THREE.Object3D): { kind: string; id: string } | null;
  hover(kind?: string, id?: string): void;
  update(dt: number): boolean;
  peel(kind: string, id: string): THREE.Group | null;
};

/** A note pinned on the corkboard (board.ts setNotes). */
export type BoardNote = { id?: string; text?: string; important?: boolean; age?: number; working?: boolean };
export type BoardHit = { kind: 'note'; id: string | undefined } | { kind: 'board' };
/** The notes corkboard (board.ts buildBoard). */
export type Board = {
  group: THREE.Group;
  setNotes(items?: BoardNote[], total?: number): void;
  setHover(on: boolean): void;
  setLift(k: number): void;
  hit(raycaster: THREE.Raycaster): BoardHit | null;
  stickyAt(id: string | undefined, out?: THREE.Vector3): THREE.Vector3 | null;
  update(t: number, dt: number): void;
  dispose(): void;
  _parts: {
    body: THREE.Group;
    tilt: THREE.Group;
    face: THREE.Group;
    badge: THREE.Group;
    more: THREE.Group;
    allClear: THREE.Group;
  };
};

/** The office round the robot (scene buildOffice): desk, chair, monitor, mug, lamp… */
export type OfficeSet = {
  office: THREE.Group;
  swivel: THREE.Group; // the robot sits on this; its rotation is the chair's swivel
  seatHeight: number;
  desk: { top: THREE.Group; buttons: THREE.Object3D; drawPanel: (cm?: number, pressed?: string) => void };
  chair: { lift(by: number): void };
  screen: CanvasTex & {
    material: THREE.MeshBasicMaterial;
    light: THREE.PointLight;
    led: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  };
  lamp: { group: THREE.Group; light: THREE.PointLight; bulb: THREE.MeshBasicMaterial };
  wordBox: { group: THREE.Group; setCount: (n: number) => void };
  stickies: Stickies;
  mug: THREE.Group;
  keyboard: THREE.Group;
  board?: Board; // the corkboard, once index puts it on the desk (for the antics)
};

// ---------------------------------------------------------------- the floor bed

/** The pillow and blanket (bed.ts), kept on set.office.userData.bed. */
export type BedProps = { group: THREE.Group; pillow: THREE.Mesh; blanket: THREE.Mesh };
/** What the bed reads each frame (bed.ts update). */
export type BedFrame = {
  t: number;
  dt: number;
  pose: string;
  d: Pick<OfficeData, 'sleepStyle'>; // the page's state (protocol.ts)
  robot: Rig;
  body: string;
  set: OfficeSet;
  camYaw?: number; // (passed, not used)
  away?: boolean;
};
/** The floor bed (bed.ts createBed): where the robot sleeps, in the chair or curled up on the floor. */
export type Bed = {
  readonly onFloor: boolean;
  aside: number;
  props(set: OfficeSet): BedProps | null;
  bubbleAt(set: OfficeSet, out: THREE.Vector3): THREE.Vector3 | null;
  update(frame: BedFrame): void;
};
export type BedOpts = { emit: Emit };
