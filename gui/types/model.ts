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
    | 'allclear'
    | 'attention'
    | 'back'
    | 'bsod'
    | 'cable'
    | 'cookie'
    | 'corner'
    | 'duck'
    | 'empty'
    | 'eyebreak'
    | 'flex'
    | 'friday'
    | 'jira'
    | 'jitter'
    | 'justdream'
    | 'merge'
    | 'miss'
    | 'monday'
    | 'noted'
    | 'notesClockout'
    | 'notesEvening'
    | 'notesMorning'
    | 'notesNudge'
    | 'notesStress'
    | 'oh'
    | 'payday'
    | 'quickDone'
    | 'quickStart'
    | 'reboot'
    | 'score'
    | 'sneeze'
    | 'so'
    | 'tip'
    | 'works',
    string
  > &
    Record<'breathe' | 'busted' | 'standup', string[]>
>;

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
export type RobotSize = 'small' | 'normal' | 'large' | 'huge';

/** A robot built from parts (office3d/kit3d): a part name per slot and its colours. */
export type Kit = Partial<
  Record<'head' | 'face' | 'top' | 'body' | 'arms' | 'base' | 'finish' | 'clothes' | 'neck' | 'extra' | 'specs', string>
> &
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

export type StepMedia =
  | { kind: 'image'; mimeType: string; data?: string; notKept?: boolean }
  | { kind: 'document'; mimeType: string; size: number };

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

/** The tokens a turn used, as Claude Code counts them (main reports.rs Tokens). */
export type Tokens = {
  input: number; // (read afresh, not from its prompt cache)
  output: number;
  cacheRead: number;
  cacheWrite: number;
  calls?: number; // how many times it called the model (each reads the whole conversation again)
  context?: number; // how big the conversation was at its last call (answers since 2.0.2)
};

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
      tokens?: Tokens; // what it used (answers since this was kept)
      costUsd?: number;
      at: number;
    }
  | { role: 'note'; text: string; at: number }
  | { role: 'qa'; items: QAItem[]; at?: number }
  | PlanEntry;

/** A plan Claude made in plan mode, and what you said to it: go ahead (in `mode`), or keep planning (`feedback`). */
export type PlanEntry = {
  role: 'plan';
  plan: string;
  approved: boolean;
  mode?: PermissionMode | null;
  feedback?: string;
  at?: number;
};

/** A side question's thread (app/src/sidechat.rs): asked beside the conversation, about one of
 *  its answers (the one whose history entry has this `at`). */
export type SideMessage = {
  role: 'user' | 'assistant';
  text: string;
  at: number;
  isError?: boolean;
  interrupted?: boolean;
};
export type SideThread = {
  id: string;
  at: number;
  quote?: string;
  sessionId?: string | null;
  history: SideMessage[];
  createdAt: number;
};

export type Task = {
  id: string;
  subject: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
};

export type ContextUse = {
  percentage: number;
  totalTokens: number;
  maxTokens: number;
  autoCompactAt?: number;
  autoCompact?: boolean;
};

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
  contextEngine?: boolean; // its folder's code indexed for its Claude (app/src/context), switched on from the chat
};

/** How the context engine's index of a robot's folder is (app/src/context Status): off; setting
 * up its database the first time (note: what it's doing); reading its files (done of total);
 * ready, its chunks getting their vectors for search by meaning (embedded of chunks; note: the
 * model's download); or it couldn't (error). capped: more files than it reads. calls: who calls
 * what, once the code graph is built (0 till then); graph: it's built for the code as it is. */
export type ContextEngineStatus = {
  phase: 'off' | 'installing' | 'indexing' | 'ready' | 'failed';
  files: number;
  chunks: number;
  embedded: number;
  symbols: number;
  calls: number;
  graph: boolean;
  done: number;
  total: number;
  capped: boolean;
  note: string | null;
  error: string | null;
};

/** Everything about the context engine, for the chat's details panel (app/src/context/details.rs
 * Details): the robot's own folder (null while the engine is off for it), the store (null while
 * its database isn't up), every folder the store holds, the models, and where it all is. */
export type ContextEngineDetails = {
  folder: ContextFolderDetails | null;
  store: ContextStoreDetails | null;
  repos: ContextRepo[];
  models: ContextModel[];
  dir: string;
};

/** The robot's own folder: its index, what's in it, its watch, its git branch. readAt: when it was
 * last brought up to date (ms since 1970). */
export type ContextFolderDetails = {
  root: string;
  status: ContextEngineStatus;
  watched: boolean;
  readAt: number | null;
  languages: { name: string; files: number }[];
  docs: number;
  keywordBytes: number;
  vectorsInMemory: number;
  graphBuilt: boolean;
  git: ContextGit | null;
};

/** A folder's branch and last commit; changed: files changed and not committed. */
export type ContextGit = {
  branch: string;
  head: string;
  subject: string;
  author: string;
  when: string;
  changed: number;
};

/** The engine's PostgreSQL; startedHere: by this C-Bot (which stops it on its way out). */
export type ContextStoreDetails = {
  version: string;
  port: number;
  dataDir: string;
  startedHere: boolean;
  bytes: number;
  vectors: { model: string; count: number }[];
};

/** A folder the store holds: robots, the ones with the engine on reading it; current: this
 * robot's; open: in memory now; kinds: its files by language or kind of document (most first);
 * bytes: its files', as last read. */
export type ContextRepo = {
  root: string;
  files: number;
  chunks: number;
  embedded: number;
  generation: number;
  robots: string[];
  current: boolean;
  open: boolean;
  kinds: { name: string; files: number; bytes: number }[];
  bytes: number;
};

/** A model the engine runs, or what runs them. */
export type ContextModel = {
  role: 'sentence' | 'reranker' | 'runtime';
  name: string;
  downloaded: boolean;
  loaded: boolean;
  bytes: number;
};

/** A group of the tools C-Bot gives a robot's Claude Code (app/src/mcp/tools/mod.rs GroupInfo):
 * on, this robot's conversations get them (the context engine's only while it's on). */
export type ToolGroupInfo = {
  group: 'robots' | 'words' | 'notes' | 'routines' | 'terminal' | 'screen' | 'tabs' | 'code';
  on: boolean;
  tools: ToolInfo[];
};

/** A tool: its name as Claude Code calls it (mcp__cbot__…), what it does, and whether using it
 * asks first (the robot's permission mode decides). */
export type ToolInfo = { name: string; description: string; asks: boolean };

/** What the Context engine window opens on (app/src/context/window.rs): the folder asked for
 * (a robot's), as the store names it. */
export type ContextInit = { focus: string | null };

/** A folder of the store, as the window shows it (window.rs RepoView): loaded, a robot reads it
 * now (in memory, watched, with its code graph); else what the store knows of it. */
export type ContextRepoView = { folder: ContextFolderDetails; loaded: boolean };

/** A folder's files (app/src/context/browse.rs IndexedFiles), by path. */
export type ContextFiles = { root: string; files: ContextFile[] };

/** A file of the index: path, in the folder (with `/`); kind, its language or kind of document;
 * code: search counts it as code; embedded: its chunks with their vector; defs: its definitions. */
export type ContextFile = {
  path: string;
  kind: string;
  code: boolean;
  bytes: number;
  chunks: number;
  embedded: number;
  defs: number;
};

/** One file of the index opened up (browse.rs FileIndex): full, its path on disk. */
export type ContextFileIndex = {
  path: string;
  full: string;
  defs: ContextDef[];
  chunks: ContextChunk[];
};

/** A definition, as the code tools read it (parse.rs Def): container, what holds it; depth,
 * inside how many other definitions; sig, how it starts, on one line. */
export type ContextDef = {
  name: string;
  kind:
    | 'module'
    | 'class'
    | 'struct'
    | 'interface'
    | 'trait'
    | 'enum'
    | 'type'
    | 'impl'
    | 'function'
    | 'method'
    | 'constructor'
    | 'property'
    | 'const'
    | 'macro';
  container: string | null;
  line: number;
  end: number;
  depth: number;
  sig: string;
};

/** A chunk, as search finds it: its lines (from–to), the definition it's about, and whether it
 * has its vector (search by meaning). */
export type ContextChunk = {
  idx: number;
  code: boolean;
  from: number;
  to: number;
  symbol: string;
  text: string;
  embedded: boolean;
};

/** What the Context engine window deletes besides one folder's index (app/src/context/wipe.rs):
 * every index (the downloads stay), or everything, downloads too. */
export type ContextWipe = 'indexes' | 'everything';

/** What was deleted. */
export type ContextWiped = {
  freed: number; // (bytes, on disk)
  later: boolean; // (some of it was in use: it goes the next time C-Bot starts)
  robots: string[]; // (the robots the engine was switched off for, by name)
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
export type VerbForms = {
  base: string;
  third: string;
  past: string;
  participle: string;
  ing: string;
  irregular: boolean;
};
/** A synonym or an antonym, and how it differs. */
export type VocabLike = { word: string; vi: string; note: string };
/** Another word built on the same stem. */
export type VocabKin = { word: string; pos: string; vi: string; example: string };
/** When you see it again (vocab.js): times seen (step), when it's next (due), quizzes seen and got right. */
export type VocabReview = {
  step: number;
  due: number;
  seen: number;
  right: number;
  last?: number;
  dreamtAt?: number;
  box?: number;
};

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

// ---------------------------------------------------------------- routines

/** When a routine runs (features/routines/schedule.rs When). days: 1 = Monday … 7 = Sunday (none: every day); at: "2026-10-30T14:00". */
export type RoutineWhen =
  | { kind: 'daily'; days: number[]; times: string[] }
  | { kind: 'every'; hours: number; from: string; to: string; days: number[] }
  | { kind: 'once'; at: string };
/** How a run's result is shown: the Routines window beside the robot, the robot's line, a Windows notification. */
export type RoutineShow = 'card' | 'pop' | 'toast';
/** How its last run went: slot, the time it ran for ("" by hand); text, the result or why there's none. */
export type RoutineLast = { slot: string; at: number; outcome: 'done' | 'failed'; text: string };
/** A prompt a robot runs on a schedule (routines.json; features/routines/mod.rs Routine). robot: its id. */
export type Routine = {
  id: string;
  name: string;
  emoji: string;
  robot: string;
  prompt: string;
  when: RoutineWhen;
  show: RoutineShow;
  on: boolean;
  catchUp: boolean;
  limitMin: number;
  createdAt: number;
  slot: string;
  last: RoutineLast | null;
};

/**
 * A routine's run, on the robot that does it (robot:routine; features/routines/runs.rs): run it
 * in its tab (last: the result before, for a new tab), stop it (too long), its result is in,
 * or open its tab.
 */
export type RoutineEvent =
  | { phase: 'run'; runId: string; routineId: string; title: string; text: string; last: string }
  | { phase: 'stop'; runId: string }
  | { phase: 'result'; routineId: string; title: string; line: string; ok: boolean; show: RoutineShow }
  | { phase: 'open'; routineId: string };

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
  | {
      op: 'start';
      id: string;
      parent?: string | null;
      description: string;
      kind: string;
      prompt: string;
      background: boolean;
    }
  | { op: 'progress'; id: string; activity: string; tokens?: number; tools?: number; ms?: number }
  | { op: 'step'; id: string; tool: string; detail: string }
  | { op: 'text'; id: string; text: string }
  | { op: 'status'; id: string; status: string }
  | {
      op: 'done';
      id: string;
      status: string;
      summary: string;
      report?: string;
      tokens?: number;
      tools?: number;
      ms?: number;
    };

/** How Claude Code's task list just changed (main claude.js 'task'). */
export type TaskChange =
  | { op: 'create'; id: string; subject: string; activeForm?: string; status: 'pending' }
  | { op: 'update'; id: string; status?: string; subject?: string; activeForm?: string }
  | { op: 'replace'; tasks: Task[]; id?: undefined; status?: undefined };

export type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

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
      tokens?: Tokens | null;
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
  | {
      type: 'side';
      op: 'start' | 'text' | 'step' | 'done' | 'fail';
      threadId: string;
      turnId?: string;
      delta?: string;
      name?: string;
      detail?: string;
      text?: string;
      isError?: boolean;
      interrupted?: boolean;
      message?: string;
      cancelled?: boolean;
    };

export type RobotEvent = ChatEvent & { tabId: string };
