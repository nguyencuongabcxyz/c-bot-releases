// What a page tells the 3D office, typed for both sides. The office is a pure "view" of the
// robot's state: every frame it reads what the page put on two elements, so the robot window,
// the Workshop preview and the walker drive it without knowing about 3D.
//   stateEl.dataset  OfficeData below (all strings; '1' for on)
//   stateEl classes  one-shot reactions: REACTIONS, plus blink and blush (FLASHES)
//   moodEl classes   Mood: awake / asleep / thinking / talking / dragging / typing
//   CSS variables    --paint on stateEl; --look-x, --look-y, --swing on the page's root (CSS_VARS)
// Out for a walk, mount(..., { solo: true }) draws the character alone (walker3d.ts): it reads
// the same, plus gait, heading and speed.
import type { Kit } from '@/types/model';
import type { WalkerGait, WalkerHeading } from '@/types/pages';
import type { BoardNote, StickyItem } from './types';

/** On or off, as a data attribute holds it. */
export type Flag = '1' | '';

/** The corkboard: your open notes (data-board, JSON). */
export type BoardData = { items?: BoardNote[]; total?: number; hidden?: boolean };

/** stateEl's data-* attributes. Missing means the default. */
export type OfficeData = {
  // ---- the robot
  /** its parts: JSON of a Kit (kit3d.ts); see writeJson */
  kit?: string;
  /** what the page keeps for itself: which body it has (always 'kit' now) */
  body?: string;
  /** the hat slot (robot3d.ts buildAccessory) */
  acc?: string;
  name?: string;
  /** the desk, screen and badge style: classic | sioux (themes.ts) */
  theme?: string;
  /** a robot3d.ts POSES key */
  pose?: string;
  /** face.ts / kitface.ts eyes and mouths */
  eyes?: string;
  mouth?: string;
  /** its model and effort (a headband at xhigh and max), and 'full' when its context is nearly full (steam) */
  model?: string;
  effort?: string;
  brain?: 'full' | '';
  /** bonked into a hurry: sweat and frantic typing */
  hurry?: Flag;
  /** how many helper agents are at work: little bots circle the desk */
  helpers?: string;

  // ---- the desk
  /** a monitor scene (screens.ts) */
  screen?: string;
  /** English words collected: the word box on the desk */
  vocabCount?: string;
  /** JSON StickyItem[]: words on sticky notes on the monitor; see writeJson */
  vocabStickies?: string;
  /** the id of the word note under the mouse: it zooms up */
  stickyHover?: string;
  /** JSON StickyItem[]: a visitor's "came by" notes; see writeJson */
  visitNotes?: string;
  /** JSON BoardData: the corkboard; see writeJson */
  board?: string;
  /** what's under the mouse round the desk: board | hammer | plug | '' */
  propHover?: string;
  /** a paper plane landed on the monitor */
  deskPlane?: Flag;
  /** the maid tidied up (sparkles), and the bin she emptied */
  tidy?: Flag;
  binEmpty?: Flag;
  /** awake past 10 pm (a hood), asleep late (a nightcap), and where it sleeps */
  lateNight?: Flag;
  nightcap?: Flag;
  sleepStyle?: 'chair' | 'floor';

  // ---- idle antics (antics/index.ts)
  /** its name ('' for none), a fresh value each time it starts, and optional words for it */
  antic?: string;
  anticSeq?: string;
  anticText?: string;

  // ---- where it is
  /** out: the chair is empty, the monitor says BRB, no antics */
  away?: Flag;
  /** in the group chat's meeting room: drawn twice a second */
  meeting?: Flag;
  /** the window is tucked away: not drawn */
  peek?: Flag;

  // ---- the Workshop preview
  /** how far it's turned round ('camera': facing you), and while it's being dragged round */
  facing?: string;
  facingDrag?: Flag;

  // ---- out for a walk (walker3d.ts)
  gait?: WalkerGait;
  heading?: WalkerHeading;
  /** walking pace (1 = about two steps a second) */
  speed?: string;
};

/** The JSON-valued attributes and what they hold. */
type JsonData = { kit: Kit; board: BoardData; vocabStickies: StickyItem[]; visitNotes: StickyItem[] };

/** stateEl's data-* attributes, typed (the element's own dataset: reading and writing it is live). */
export const officeData = (el: HTMLElement): OfficeData => el.dataset as OfficeData;

/** Put a JSON-valued attribute. */
export function writeJson<K extends keyof JsonData>(d: OfficeData, key: K, value: JsonData[K]) {
  d[key] = JSON.stringify(value);
}

/** Read a JSON-valued attribute's text: `fallback` when it's empty or can't be read. */
export function readJson<K extends keyof JsonData>(text: string | undefined, fallback: JsonData[K]): JsonData[K] {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as JsonData[K]; // (the page wrote it with writeJson)
  } catch {
    return fallback;
  }
}

/** One-shot reactions: a class on stateEl for a moment (charge: the plug by the desk;
 *  highfive, dance: by itself now and then). */
export const REACTIONS = [
  'hop',
  'squish',
  'shake',
  'spin',
  'idea',
  'chomp',
  'bonk',
  'helper-step',
  'charge',
  'highfive',
  'dance',
] as const;
export type Reaction = (typeof REACTIONS)[number];
/** What a page may flash on stateEl: a reaction, a blink or a blush. */
export type Flash = Reaction | 'blink' | 'blush';

/** moodEl's classes. */
export type Mood = 'awake' | 'asleep' | 'thinking' | 'talking' | 'dragging' | 'typing';

/** The CSS variables it reads: --paint on stateEl, the rest on the page's root. */
export const CSS_VARS = { paint: '--paint', lookX: '--look-x', lookY: '--look-y', swing: '--swing' } as const;
