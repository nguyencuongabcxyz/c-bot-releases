// What the pages and main pass each other: the robots as the store keeps them
// (main store.js), what a robot window is told about itself, and its chat's events.

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

// ---------------------------------------------------------------- settings

export type ThemePick = { theme: 'vintage' | 'future'; mode: 'auto' | 'light' | 'dark' };
export type SoundLevel = 'essential' | 'all' | 'off';

export type Settings = {
  claudePath: string;
  muted?: boolean;
  island?: boolean; // the robot island at the screen's edge (on unless false)
  sounds: SoundLevel;
  theme?: string;
  themeMode?: string;
  startAtLogin?: boolean;
  toolset?: { version: string; tools: string[] } | null;
  quickModel?: 'haiku' | 'sonnet';
  maid?: boolean;
  socialising?: 'often' | 'sometimes' | 'never';
  paletteDrone?: boolean;
  vocabReminders?: boolean;
  vocabHours?: [number, number];
  vocabTutor?: string;
  notesRobot?: string;
  notesBoard?: 'all' | 'one';
  paletteHotkey?: string;
  screenHotkey?: string;
  quickHotkey?: string;
  vocabHotkey?: string;
  noteHotkey?: string;
  notebookSize?: { width: number; height: number };
  groupChatSize?: { width: number; height: number };
};

// ---------------------------------------------------------------- robots

export type Personality = {
  label: string;
  emoji: string;
  greetings: string[];
  sleepy: string[];
  pokes: string[];
  annoyed: string[];
  bonked: string[];
  done: string[];
  oops: string[];
  hungry: string[];
  yum: string[];
  bored: string[];
  sleeptalk: string[];
  quips: Quips;
};

/** What it says during its antics (shared/personalities.json): a line, or a few in a row. */
export type Quips = Partial<
  Record<
    | 'allclear' | 'attention' | 'back' | 'bsod' | 'cable' | 'cookie' | 'corner' | 'duck' | 'empty' | 'eyebreak'
    | 'flex' | 'friday' | 'jira' | 'jitter' | 'justdream' | 'merge' | 'miss' | 'monday' | 'noted' | 'notesClockout'
    | 'notesEvening' | 'notesMorning' | 'notesNudge' | 'notesStress' | 'oh' | 'payday' | 'quickDone' | 'quickStart'
    | 'reboot' | 'score' | 'sneeze' | 'so' | 'tip' | 'works',
    string
  > &
    Record<'breathe' | 'busted' | 'standup', string[]>
>;

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
export type RobotSize = 'small' | 'normal' | 'large' | 'huge';

/** A robot built from parts (office3d/kit3d): a part name per slot and its colours. */
export type Kit = Partial<Record<'head' | 'face' | 'top' | 'body' | 'arms' | 'base' | 'finish' | 'clothes' | 'neck' | 'extra' | 'specs', string>> &
  Partial<Record<'second' | 'accent' | 'eye' | 'cloth' | 'hair', string>>;

export type FileChip = { name: string; isDir: boolean; isImage: boolean };

/** What another tab wrote for a message that mentioned it with @# (features/chat/brief.rs). */
export type Brief = { title: string; text: string };

/** A file change Claude made, as unified-diff hunks (main claude.js editDiff). */
export type Diff = {
  id?: string;
  file: string;
  created: boolean;
  added: number;
  removed: number;
  hunks: { oldStart: number; newStart: number; lines: string[] }[];
  truncated: boolean;
};

export type StepMedia = { kind: 'image'; mimeType: string; data?: string; notKept?: boolean } | { kind: 'document'; mimeType: string; size: number };

/** One step Claude took, as kept with its answer. */
export type StepCall = {
  id: string;
  name: string;
  detail: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
  media?: StepMedia[];
  at: number; // where in the answer's text it came
  trimmed?: boolean;
};

export type ToolImage = { id: string; mimeType: string; data: string };
export type QAItem = { question: string; header?: string; answer: string };

// ---------------------------------------------------------------- MCP tool views

/** An MCP tool's own page (main mcpApps.js appFor): the server that serves it, for which tool. */
export type AppView = { server: string; tool: string; uri: string };

/** A tool call that came with a view, as kept with its answer (main.js takeApps): the view is
 *  looked up again by the tool's name. */
export type AppCall = { id: string; name: string; input: unknown; result?: unknown };

/** A tool call and its view, as the chat hosts it (and hands it to the big window). */
export type AppViewCall = AppView & { id: string; input: unknown; result?: unknown };

/** Where to load a view's page from (main mcpApps.js pageFor); permissions as the app declares
 *  them (clipboardWrite…). */
export type AppPage = { url: string; prefersBorder: boolean; permissions: Record<string, unknown> };

export type HistoryEntry =
  | { role: 'user'; text: string; files?: FileChip[]; at: number; tag?: string; briefs?: Brief[] }
  | {
      role: 'assistant';
      text: string;
      asides?: string[];
      isError?: boolean;
      interrupted?: boolean;
      denials?: string[];
      edits?: Diff[];
      apps?: AppCall[];
      images?: ToolImage[];
      tools?: (StepCall | string)[]; // (just its name, "Skill(…)" for a skill: older answers and resumed conversations)
      uuid?: string; // its last message in Claude Code's transcript (an edited question after it goes back to here)
      at: number;
    }
  | { role: 'note'; text: string; at: number }
  | { role: 'qa'; items: QAItem[]; at?: number }
  | PlanEntry;

/** A plan Claude made in plan mode, and what you said to it: go ahead (in `mode`), or keep planning (`feedback`). */
export type PlanEntry = { role: 'plan'; plan: string; approved: boolean; mode?: PermissionMode | null; feedback?: string; at?: number };

/** A side question's thread (app/src/sidechat.rs): asked beside the conversation, about one of
 *  its answers (the one whose history entry has this `at`). */
export type SideMessage = { role: 'user' | 'assistant'; text: string; at: number; isError?: boolean; interrupted?: boolean };
export type SideThread = { id: string; at: number; quote?: string; sessionId?: string | null; history: SideMessage[]; createdAt: number };

export type Task = { id: string; subject: string; activeForm?: string; status: 'pending' | 'in_progress' | 'completed' | string };

export type ContextUse = { percentage: number; totalTokens: number; maxTokens: number; autoCompactAt?: number; autoCompact?: boolean };

export type Tab = {
  id: string;
  title: string;
  sessionId: string | null;
  history: HistoryEntry[];
  createdAt: number;
  model?: string;
  effort?: string;
  tasks?: Task[];
  context?: ContextUse | null;
  temporary?: boolean; // a chat that keeps nothing: gone, transcripts and all, when it's closed
  remote?: boolean; // Remote Control: carried on from claude.ai/code or the Claude app too
  remoteUrl?: string | null; // (its page on claude.ai)
  sides?: SideThread[]; // side questions about its answers
};

export type ClaudeCommand = { name: string; description: string };

/** A robot as the store keeps it (main store.js). */
export type Character = {
  id: string;
  name: string;
  folder: string;
  personality: string;
  color: string;
  permissionMode: PermissionMode;
  model: string;
  tabs: Tab[];
  activeTab: string;
  visible: boolean;
  peek?: boolean; // sent away to the robot island (its window veiled, still at work)
  position: Point | null;
  stats: { questions: number; pokes: number; costUsd: number };
  createdAt: number;
  body?: string;
  kit?: Kit;
  accessory?: string;
  theme?: 'classic' | 'sioux';
  size?: RobotSize;
  clickOpens?: 'chat' | 'terminal';
  wanders?: boolean;
  chatWidth?: number;
  chatHeight?: number | null; // (none: the height of the screen)
  claudeCommands?: ClaudeCommand[];
  sessionIds?: string[];
  closedTabs?: (Tab & { closedAt: number })[];
};

/** What a robot window is told about its robot (main.js robotView). */
export type RobotView = Omit<Character, 'tabs' | 'closedTabs'> & {
  tabs: (Tab & { custom: boolean; busy: boolean })[];
  closedTabs: { id: string; title: string; closedAt: number }[];
  busy: boolean;
  terminalOpen: boolean;
  terminalTab: string | null;
};

// ---------------------------------------------------------------- the robot window

/** Where things go in the robot's window (main.js layoutFor), in CSS px. */
export type Layout = {
  expanded: boolean;
  seq: number;
  masked: boolean;
  bounds: Box;
  robotX: number;
  robotY: number;
  placement: 'none' | 'left' | 'right' | 'tuck-above' | 'tuck-below' | 'hidden' | 'stage';
  side?: 'left' | 'right'; // (tucked away: the side the chat opens on)
  panel?: { x: number; w: number };
  maxChatW?: number;
  stage?: StageTileInfo; // (on the stage: its tile)
  inset?: number; // (on the stage: how far the chat sits in from the window's edges)
  sideW?: number; // (the side panel open beside the chat: the part of the panel's room that's its)
};

/** A robot's tile on the stage (robots/stage/mod.rs): the gaps on its edges you can drag (each named,
 * as stage_split knows them), or that it's in the spotlight or a strip beside it. */
export type StageTileInfo = {
  edges?: Partial<Record<'left' | 'right' | 'top' | 'bottom', string | null>>;
  spot?: boolean;
  strip?: boolean;
};

/** A file or folder fed to the robot (main.js inspectPath). */
export type FileInfo = { path: string; name: string; isDir: boolean; size: number; isImage: boolean; thumb?: string };

export type OkOr<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** A file or folder opened in the chat's file viewer (workbench/files.rs read_for_view): its text (the
 * first 2 MB), a picture (an SVG's source too), a PDF/song/video to show through cbot-file,
 * a folder's list, or only what it is. modified: ms. */
export type FileView = { name: string; path: string; ext: string; size: number; modified?: number | null } & (
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image'; text?: string; truncated?: boolean }
  | { kind: 'pdf' | 'audio' | 'video' | 'binary' }
  | { kind: 'dir'; entries: { name: string; isDir: boolean; size: number }[]; truncated: boolean }
);

export type ModelChoice = { value: string; displayName: string; description: string; efforts: string[] };

/** A past conversation in the robot's folder (main sessions.js listSessions). */
export type SessionRow = {
  id: string;
  title: string;
  preview: string;
  messages: number | null;
  updatedAt: number;
  size: number;
  byRobot: boolean;
  active: boolean;
  current: boolean;
  tabId: string | null;
};

/** A message of a past conversation, as read from Claude Code's transcript (main sessions.js). */
export type TranscriptMessage =
  | { role: 'user'; text: string; at?: string }
  | { role: 'note'; text: string; at?: string }
  | { role: 'assistant'; text: string; tools: string[]; asides: string[]; at?: string }
  | { role: 'qa'; items: QAItem[] }
  | PlanEntry;

export type Transcript = {
  id: string;
  title: string;
  total: number;
  messages: TranscriptMessage[];
};

/** A task one robot handed another, as a desk shows it (main robotLink.js tasksFor). */
export type LinkTask = {
  id: string;
  mine: boolean; // handed to this robot (or by it)
  other: string; // the other robot's name
  title: string;
  status: 'sent' | 'working' | 'done' | 'failed' | 'cancelled';
  at: number;
  doneAt: number;
  report: string;
};

// ---------------------------------------------------------------- your words (main vocab.js)

/** One meaning of a word (main vocab.js lookup). */
export type VocabSense = { pos: string; vi: string; en: string };
/** A phrase it's used in, with an example sentence and its translation. */
export type VocabPhrase = { phrase: string; vi: string; example: string; exampleVi: string };
/** A verb's five forms (null when it isn't a verb). */
export type VerbForms = { base: string; third: string; past: string; participle: string; ing: string; irregular: boolean };
/** A synonym or an antonym, and how it differs. */
export type VocabLike = { word: string; vi: string; note: string };
/** Another word built on the same stem. */
export type VocabKin = { word: string; pos: string; vi: string; example: string };
/** When you see it again (vocab.js): times seen (step), when it's next (due), quizzes seen and got right. */
export type VocabReview = { step: number; due: number; seen: number; right: number; last?: number; dreamtAt?: number; box?: number };

/** One of your English words, as vocab.json keeps it. The meaning comes in as Claude looks it
 *  up (status 'looking' until then); the extras (phrases, synonyms…) a little after. */
export type VocabWord = {
  id: string;
  word: string; // its dictionary form, once looked up
  text: string; // as captured
  ipa: string;
  senses: VocabSense[];
  examples: { en: string; vi: string }[]; // (older words; the phrases' examples took their place)
  tip: string;
  context: string;
  source: string;
  status: 'looking' | 'ready' | 'failed';
  error?: string;
  addedAt: number;
  review?: VocabReview;
  phrases?: VocabPhrase[];
  verbForms?: VerbForms | null;
  usage?: { collocations?: { phrase: string; vi: string }[] }; // (older words)
  // (none: saved before C-Bot learned them, or that part of the lookup failed)
  synonyms?: VocabLike[];
  antonyms?: VocabLike[];
  family?: VocabKin[];
  extrasError?: string;
  lastSeenAt?: number;
  editedAt?: number;
};

/** A word a robot keeps in sight: on its monitor's stickies, in its sleep talk (main.js sightWords). */
export type SightWord = { id: string; word: string; vi: string; phrase: string; box: number };

/** What happens with your words, as the robot acts it out (robot:vocab; main.js tellVocab). */
export type VocabEvent =
  | { phase: 'catch' | 'found' | 'known' | 'knowit' | 'undone' | 'ask' | 'dream'; word: VocabWord }
  | { phase: 'failed'; word: VocabWord | null; error: string }
  | { phase: 'quiz'; word: VocabWord; asked: boolean }
  | { phase: 'answered'; how: 'knew' | 'forgot' | 'later' | 'ignored'; word: VocabWord; wait: number }
  // (these come without a word)
  | ((
      | { phase: 'count'; count: number }
      | { phase: 'sight'; words: SightWord[] }
      | { phase: 'empty'; hotkey: string }
      | { phase: 'too-long' | 'reading' | 'unreadable' }
      | { phase: 'milestone'; learnt: number; streak: number; unlocked: string }
    ) & { word?: undefined });

// ---------------------------------------------------------------- your notes (main notes.js)

export type Note = {
  id: string;
  text: string;
  important: boolean;
  createdAt: number;
  doneAt: number | null;
  source: string;
  working?: boolean; // Claude's on it, in a chat
};

/** What a desk's corkboard shows: the first few open notes, and how many there are (hidden:
 *  another robot has the board). */
export type NotesBoard = {
  items: { id: string; text: string; important: boolean; age: number; working: boolean }[];
  total: number;
  hidden?: boolean;
};

/** A daily reminder's counts: notes taken today, still open, taken since the last workday. */
export type NotesReminder = { today: number; open: number; taken: number };

/** What happens with your notes, as the robot acts it out (robot:notes; main.js tellNotes). */
export type NotesEvent =
  | { phase: 'board'; board: NotesBoard }
  | { phase: 'added'; note: Note; quiet?: boolean }
  | { phase: 'done'; note: Note; left: number }
  | { phase: 'opened' | 'clockout' }
  | { phase: 'writing'; on: boolean }
  | { phase: 'remind'; kind: 'morning' | 'evening'; info: NotesReminder }
  | { phase: 'ask'; prompt: string; note?: Note; draft?: boolean; summary?: boolean };

// ---------------------------------------------------------------- the other robots

/** The side of the screen another robot is on. */
export type Side = 'L' | 'R';

/** Robots noticing each other (robot:social; main social.js, maid.js and groupChat.js). */
export type SocialEvent =
  | { phase: 'wave' | 'wave-back' | 'listen' | 'throw'; side: Side }
  | { phase: 'stir' | 'dance' | 'oops' | 'tidy-end' }
  | { phase: 'clap'; side: Side; text: string }
  | { phase: 'yawn'; side: Side; sleepSoon: boolean }
  | { phase: 'visit'; host: string; mode: 'chat' | 'watch' | 'tiptoe' | 'order' | 'goout' | 'tea' }
  | { phase: 'visit-over'; why: string }
  | { phase: 'go-out'; with: string }
  | { phase: 'treat'; kind: 'food' | 'tea'; text: string }
  | { phase: 'hosting'; on: boolean }
  | { phase: 'tidy'; side: Side; mood: 'away' | 'asleep' | 'busy' | 'chat' | 'free'; thanks: string }
  | { phase: 'say'; text: string }
  | { phase: 'listen-end'; wave?: boolean }
  | { phase: 'catch'; side: Side; from: string; text: string }
  | { phase: 'plane-land'; from: string; text: string }
  | { phase: 'visit-note'; from: string; found: string };

/** Another robot's Claude asks this one something, or hands it a task (robot:link; main robotLink.js). */
export type LinkEvent = {
  phase: 'incoming';
  reqId: string;
  exchange: string; // the back-and-forth it's part of (follow-ups go to the same tab)
  first: boolean;
  from: string; // the asking robot's name
  text: string;
  task: { id: string; title: string } | null;
};

// ---------------------------------------------------------------- the chat's events

/** Helper agents (sub-agents) at work, as main claude.js reports them. */
export type AgentEvent =
  | { op: 'start'; id: string; parent?: string | null; description: string; kind: string; prompt: string; background: boolean }
  | { op: 'progress'; id: string; activity: string; tokens?: number; tools?: number; ms?: number }
  | { op: 'step'; id: string; tool: string; detail: string }
  | { op: 'text'; id: string; text: string }
  | { op: 'status'; id: string; status: string }
  | { op: 'done'; id: string; status: string; summary: string; report?: string; tokens?: number; tools?: number; ms?: number };

/** How Claude Code's task list just changed (main claude.js 'task'). */
export type TaskChange =
  | { op: 'create'; id: string; subject: string; activeForm?: string; status: 'pending' }
  | { op: 'update'; id: string; status?: string; subject?: string; activeForm?: string }
  | { op: 'replace'; tasks: Task[]; id?: undefined; status?: undefined };

export type Question = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] };

/** What happens in a tab's conversation (robot:event; main.js sessionFor). */
export type ChatEvent =
  | { type: 'turn-start'; turnId: string; kind?: string }
  | { type: 'text'; delta: string }
  | { type: 'aside'; text: string }
  | { type: 'thinking' }
  | { type: 'status'; text: string }
  | { type: 'question'; requestId: string; questions: Question[] }
  | { type: 'request-cancelled'; requestId: string }
  | { type: 'plan'; requestId: string; plan: string; file: string }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'thinking-text'; id: string; delta: string }
  | { type: 'usage'; outputTokens: number }
  | { type: 'tool'; id: string; name: string; detail: string; args: unknown }
  | { type: 'tool-output'; id: string; text: string; media: StepMedia[]; isError: boolean }
  | { type: 'tool-images'; id: string; images: ToolImage[] }
  | ({ type: 'edit' } & Diff)
  | ({ type: 'agent' } & AgentEvent)
  | { type: 'tasks'; tasks: Task[]; change: TaskChange }
  | { type: 'compact'; phase: 'start' | 'done'; pre?: number; post?: number }
  | { type: 'context'; context: ContextUse }
  | {
      type: 'done';
      turnId: string;
      text: string;
      asides: string[];
      isError: boolean;
      interrupted: boolean;
      costUsd: number;
      denials: string[];
      sessionId: string | null;
      kind?: string;
      uuid?: string | null;
      at?: number | null; // (when it went into the history: its side questions hang from it)
      outputTokens?: number;
      ms?: number;
    }
  | { type: 'fail'; turnId: string; message: string; cancelled?: boolean; sessionMissing?: boolean }
  | { type: 'dropped'; turnIds: string[] }
  | { type: 'terminal'; state: 'opened' | 'closed' }
  | { type: 'remote'; on: boolean; url?: string | null; error?: string }
  | { type: 'remote-state'; state: string }
  | { type: 'remote-prompt'; text: string; tag: string }
  | { type: 'mirror'; kind: 'prompt' | 'question' | 'text' | 'idle' }
  | { type: 'mirror'; kind: 'tool'; name: string; detail: string }
  | ({ type: 'app' } & AppViewCall)
  | { type: 'app-result'; id: string; result: unknown }
  | { type: 'side'; op: 'start' | 'text' | 'step' | 'done' | 'fail'; threadId: string; turnId?: string; delta?: string; name?: string; detail?: string; text?: string; isError?: boolean; interrupted?: boolean; message?: string; cancelled?: boolean };

export type RobotEvent = ChatEvent & { tabId: string };
