// What the robot window keeps track of, beside what main tells it (@/types/model.ts): its tabs,
// the answer being streamed, helper agents, the questions and plans waiting for you.
import type { McpAppHostHandle } from '@/features/mcp/app-host';
import type {
  AppCall,
  AppViewCall,
  Brief,
  ChatEvent,
  ClaudeCommand,
  ContextUse,
  Diff,
  FileInfo,
  Layout,
  PermissionMode,
  Personality,
  RobotView,
  SocialEvent,
  StepCall,
  Task,
  Tokens,
  ToolImage,
} from '@/types/model';
/** A question as it was asked: its words and the files that went with it (asked again when bonked). */
export type Ask = { question: string; paths: string[]; briefs?: Brief[] };

/** A piece of the answer being streamed (see partFor): words (its slice of the answer's text),
 *  a row of step chips, or what the steps made. */
export type TextPart = { kind: 'text'; el: HTMLElement; from: number; to?: number };
export type Part = TextPart | { kind: 'steps' | 'made'; el: HTMLElement; from?: number };

/** The answer being streamed into its bubble. */
export type Reply = {
  el: HTMLElement;
  parts: Part[];
  text: string;
  offset?: number; // (after a question card: its words from here on, in a fresh bubble)
  asked?: boolean;
  turnId?: string;
  ask?: Ask;
  toolStatus?: string;
};

/** An answer's bubble, as kept with the history (addBot). */
export type BotOpts = {
  error?: boolean;
  denials?: string[];
  tools?: (StepCall | string)[];
  asides?: string[];
  edits?: Diff[];
  apps?: AppCall[];
  images?: ToolImage[];
  tokens?: Tokens | null;
  costUsd?: number;
  tab?: ChatTab;
};

/** An MCP tool's view in the chat, with the call it shows (handed to the big window). */
export type AppHost = McpAppHostHandle & { call: AppViewCall };

/** A line in the composer's pop-up list: a command (/…), or a file or another tab to mention (@…). */
export type PaletteCommand = { kind: 'local' | 'claude'; name: string; description: string; args?: string };
export type PaletteFile = { kind: 'file'; rel: string; dir: boolean };
export type PaletteTab = { kind: 'tab'; id: string; title: string }; // (another conversation: @#, for a brief from it)
export type PaletteItem = PaletteCommand | PaletteFile | PaletteTab;

/** A brief for the next message, from another tab it mentions with @# (text: null while it's written). */
export type ComposerBrief = { tabId: string; title: string; text: string | null; wait: Promise<void> };

/** A message typed while it was still answering, waiting its turn. */
export type Queued = { turnId: string; el: HTMLElement; ask: Ask };

/** Claude's question card, waiting for your answer. */
export type PendingQuestion = {
  sent: boolean;
  card: HTMLElement;
  requestId?: string;
  closed?: string;
  typed(text: string): void;
  pickByNumber(n: number): void;
};

/** A step it took, as its chip shows it (live, or kept with the answer). */
export type ToolCall = Omit<StepCall, 'at'> & { at?: number; running: boolean };

/** A helper agent at work, as its card shows it. */
export type Helper = {
  id: string;
  description: string;
  status: string; // 'running', 'completed', 'failed', 'killed', 'stopped'…
  steps: { tool: string; detail: string; at: number }[];
  text: string;
  started: number;
  kind?: string;
  prompt?: string;
  background?: boolean;
  parent?: string | null;
  activity?: string;
  tokens?: number;
  toolsUsed?: number;
  summary?: string;
  report?: string;
  ended?: number;
};

/** A tab: one Claude Code conversation, its log, and how it's doing. */
export type ChatTab = {
  id: string;
  log: HTMLElement;
  busy: boolean;
  current: Reply | null;
  question: PendingQuestion | null;
  statusText: string;
  status: 'idle' | 'done' | 'error'; // (done, error: not seen yet)
  activity: string; // what the robot does at its desk for it
  draft: string;
  queue: Queued[];
  data: RobotView['tabs'][number];
  key: string;
  title: string;
  custom: boolean;
  tasks: Task[];
  context?: ContextUse | null;
  model?: string;
  effort?: string;
  mode?: PermissionMode; // its permission mode (plan mode while it plans)
  canBypass?: boolean; // (the robot may be switched to full access: the Workshop's choice)
  verbs?: number;
  renderQueued?: boolean;
  scrolledUp?: boolean; // (you scrolled up to read: what comes in doesn't pull the log down)
  scrollAt?: number; // (where you were, while the log is out of sight: hidden, it loses its place)
  calls?: Map<string, ToolCall>;
  agents?: Map<string, Helper>;
  justBack?: string | null;
  justDone?: string | null;
  todoCollapsed?: boolean;
  helpersCollapsed?: boolean;
  compacting?: boolean;
  compactResult?: Extract<ChatEvent, { type: 'compact' }> | null;
  warnedFull?: boolean;
  terminal?: boolean;
  remoteState?: string; // Remote Control's link to claude.ai: connecting, ready, connected…
  remoteAsked?: boolean; // (turned on from here: say how to reach it once it's on)
  bonk?: { turnId: string; ask: Ask } | null;
  hurried?: boolean;
  vocabWord?: string;
  noteId?: string;
  linkReq?: string;
  exchange?: string;
  task?: string;
  routine?: string; // (a routine's own tab: its runs go here)
  routineRun?: string; // the run it's on now
  // the status line while it works: since when, and how much it has written
  turnStart?: number;
  outTokens?: number; // (as Claude Code counts them, when it says)
  outChars?: number; // (else estimated from what streamed in)
  sent?: string[]; // what you asked in it, for ↑ / ↓ in the composer
  rewinding?: boolean; // (its last question is being taken back, to edit or ask again)
};

/** What the robot's up to: its window's state. */
export type RobotState = {
  character: RobotView | null;
  personalities: Record<string, Personality>;
  user: string;
  awake: boolean;
  collapsed: boolean;
  news: string;
  readonly busy: boolean;
  placement: Layout['placement'];
  robotX: number;
  robotY: number;
  pokes: number[];
  face: { eyes: string; mouth: string; until: number } | null;
  activity: string;
  pose: { name: string; until: number } | null;
  lookOverride: { dx: number; dy: number; until: number } | null;
  lastCursor: { dx: number; dy: number };
  lastActivity: number;
  attachments: FileInfo[];
  briefs: ComposerBrief[];
  // (and as it goes)
  scale?: number;
  mirroring?: boolean;
  away?: boolean;
  leaving?: boolean;
  meeting?: boolean;
  visiting?: { host: string; mode: Extract<SocialEvent, { phase: 'visit' }>['mode'] | 'lunch' } | null;
  hosting?: boolean;
  awayNews?: string;
  playing?: string | null;
  playingByUser?: boolean;
  waking?: boolean;
  lastBonk?: number;
  slacking?: number;
  claudeCommands?: ClaudeCommand[];
  peek?: boolean;
};
