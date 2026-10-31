// What goes between a page and main beyond the model: what some commands return
// (gui/ipc/commands.ts has the commands themselves) and every event main sends a window,
// with its payload (ipc.on is typed from Events, so a wrong name is a compile error).
import type {
  ContextEngineStatus,
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
  RoutineEvent,
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

/** What a robot hears about the stage (robots/stage/mod.rs): picked for it (its number), a message
 * sent to everyone on it, a tile being dragged over it to swap places. */
export type StageEvent =
  | { kind: 'pick'; n: number | null }
  | { kind: 'ask'; prompt: string; paths: string[]; to: string[]; all: boolean }
  | { kind: 'target'; on: boolean };

/** The stage's bar (gui/views/stage): picking (a pill) or on stage (the bar along the bottom). */
export type StageState = {
  mode: 'pick' | 'stage';
  picked: string[];
  cast: string[];
  off: string[];
  spot: string | null;
  room: number;
  robots: IslandRobot[];
};

/** The action palette's menu (main palette.js view). */
export type PaletteItem = { heading: string } | { id: string; icon: string; label: string; hint?: string };
export type PaletteView = { text: string; source: string; items: PaletteItem[]; projected: boolean };

/** How a robot is, every few seconds, or what just happened to it (main social.js report). */
export type SocialReport =
  | { awake: boolean; busy: boolean; chat: boolean; idleMs: number; free: boolean; away: boolean; wanders: boolean }
  | { kind: 'done' | 'slept' | 'decline' | 'plane-read' };

/** How a robot is, for the robot island (robots/island.rs): awake, busy and at what since when
 * (ms), a question waiting for you. */
export type IslandReport = { awake: boolean; busy: boolean; text: string; since: number | null; asking: boolean };
/** News from a robot that's away on the island: a job done, a snag, a question (from its
 * page); a word it dreamt of, a word it's quizzing you on, your daily notes (from main). */
export type IslandNews = { kind: 'done' | 'error' | 'ask' | 'word' | 'quiz' | 'notes'; text: string };
export type IslandEdge = 'top' | 'bottom' | 'left' | 'right';
/** A robot as the island shows it: closed (put away, its window shut), away (sent to the
 * island, or closed), out for a walk; the rest as it last said (null: it hasn't). */
export type IslandRobot = {
  id: string;
  name: string;
  color: string;
  closed: boolean;
  away: boolean;
  walking: boolean;
  awake: boolean | null;
  busy: boolean | null;
  text: string | null;
  since: number | null;
  asking: boolean | null;
};

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
  'robot:stage': StageEvent;
  'robot:hush': boolean;
  'robot:screen': { file: FileInfo; source: string };
  'robot:tasks': LinkTask[];
  // (its context engine: how the index of its folder is, as it changes)
  'robot:context': ContextEngineStatus;
  // (the Context engine window: a folder's status as it changes, and the folder to show)
  'context:status': { root: string; status: ContextEngineStatus };
  'context:focus': string;
  'robot:vocab': VocabEvent;
  'robot:notes': NotesEvent;
  // (Quick actions at work on text you selected; action: refine, translate, explain, summarise)
  'robot:quick': { phase: 'start' | 'done' | 'fail' | 'replaced' | 'copied'; action?: string };
  'robot:palette': { phase: 'launch' };
  'robot:social': SocialEvent;
  'robot:link': LinkEvent;
  'robot:routine': RoutineEvent;
  // (its shell, workbench/shell.rs: what it printed, or that it ended)
  'robot:shell': { sid: number; kind: 'data'; data: string } | { sid: number; kind: 'exit'; code: number };
  // (its Claude, in the shells of its conversation tab: a terminal_* tool call; wait: seconds, for terminal_run)
  'robot:shell-ask': {
    req: number;
    tool: string;
    tab: string;
    args: { command?: string; shell?: number; shell_type?: string; new_shell?: boolean; lines?: number };
    wait: number;
  };
  // ---- the other windows
  'mgr:changed': undefined;
  'mgr:focus': string;
  'walker:state': P.WalkerState;
  'walker:character': P.WalkerLook;
  'walker:cursor': P.WalkerCursor;
  'walker:dream': P.WalkerDream;
  'walker:say': P.WalkerSay;
  'card:word': P.CardWord;
  'words:changed': undefined;
  'notebook:notes': P.NotebookNotes;
  'notebook:open': P.NotebookOpen;
  'routines:list': P.RoutinesList;
  'routines:open': P.RoutinesFocus;
  'palette:open': PaletteView;
  'drone:cmd': DroneCmd;
  'quick:open': P.QuickOpen;
  'quick:text': P.QuickText;
  'plane:pose': PlanePose;
  'groupchat:state': P.GroupChatView;
  'groupchat:delta': P.GroupChatDelta;
  'meeting:state': P.MeetingState;
  'meeting:say': P.MeetingSay;
  'island:robots': IslandRobot[];
  'stage:state': StageState;
  'island:hover': boolean;
  'island:target': 'off' | 'near' | 'over';
  'island:edge': { edge: IslandEdge; dragging: boolean };
  'island:news': IslandNews & { id: string };
}
