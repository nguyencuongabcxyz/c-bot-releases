// What goes between a page and main beyond the model: what some commands return
// (gui/ipc/commands.ts has the commands themselves) and every event main sends a window,
// with its payload (ipc.on is typed from Events, so a wrong name is a compile error).
import type {
  FileInfo,
  Layout,
  LinkEvent,
  LinkTask,
  NotesBoard,
  NotesEvent,
  OkOr,
  Personality,
  Point,
  RobotEvent,
  RobotView,
  Settings,
  SightWord,
  SocialEvent,
  ThemePick,
  VocabEvent,
} from './model';
import type * as P from './pages';

/** What a robot window gets on (re)load (main.js robot:init). */
export type RobotInit = {
  character: RobotView | null;
  personalities: Record<string, Personality>;
  settings: Settings;
  user: string;
  vocabCount: number;
  vocabSight: SightWord[];
  vocabHotkey: string;
  notesBoard: NotesBoard;
  noteHotkey: string;
  hush: boolean;
};

export type AskResult = OkOr<{ turnId: string; queued: boolean }>;

/** The action palette's menu (main palette.js view). */
export type PaletteItem = { heading: string } | { id: string; icon: string; label: string; hint?: string };
export type PaletteView = { text: string; source: string; items: PaletteItem[]; projected: boolean };

/** How a robot is, every few seconds, or what just happened to it (main social.js report). */
export type SocialReport =
  | { awake: boolean; busy: boolean; chat: boolean; idleMs: number; free: boolean; away: boolean; wanders: boolean }
  | { kind: 'done' | 'slept' | 'decline' | 'plane-read' };

/** The drone flying the action palette over (main drone.js); points are in its window. */
export type DroneCmd =
  | { kind: 'launch'; from: Point; to: Point; paint?: string }
  | { kind: 'retarget'; to: Point }
  | { kind: 'hover'; at: Point; width: number }
  | { kind: 'recall'; to: Point | null };

/** The paper plane's heading (main plane.js), or its last moments. */
export type PlanePose = { angle?: number; flip?: boolean; u?: number; landed?: boolean; fade?: boolean };

export interface Events {
  'theme:changed': ThemePick;
  // ---- a robot window
  'robot:layout': Layout;
  'robot:cursor': Point;
  'robot:event': RobotEvent;
  'robot:character': RobotView;
  'robot:settings': Settings;
  'robot:action': string;
  'robot:hush': boolean;
  'robot:screen': { file: FileInfo; source: string };
  'robot:tasks': LinkTask[];
  'robot:vocab': VocabEvent;
  'robot:notes': NotesEvent;
  // (Quick actions at work on text you selected; action: refine, translate, explain, summarise)
  'robot:quick': { phase: 'start' | 'done' | 'fail' | 'replaced' | 'copied'; action?: string };
  'robot:palette': { phase: 'launch' };
  'robot:social': SocialEvent;
  'robot:link': LinkEvent;
  // ---- the other windows
  'mgr:changed': void;
  'mgr:focus': string;
  'walker:state': P.WalkerState;
  'walker:character': P.WalkerLook;
  'walker:cursor': P.WalkerCursor;
  'walker:dream': P.WalkerDream;
  'walker:say': P.WalkerSay;
  'card:word': P.CardWord;
  'words:changed': void;
  'notebook:notes': P.NotebookNotes;
  'notebook:open': P.NotebookOpen;
  'palette:open': PaletteView;
  'drone:cmd': DroneCmd;
  'quick:open': P.QuickOpen;
  'quick:text': P.QuickText;
  'plane:pose': PlanePose;
  'groupchat:state': P.GroupChatView;
  'groupchat:delta': P.GroupChatDelta;
  'meeting:state': P.MeetingState;
  'meeting:say': P.MeetingSay;
}

