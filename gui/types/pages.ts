// What the windows other than the robot's get from main and give back: their *:init
// views, their actions' answers and their events (main wordCard.js, notebook.js,
// quickWindow.js, walker.js, groupChat.js, meeting.js, mcpApps.js and main.js's
// Workshop and My words handlers).
import type { Character, Note, NotesBoard, NotesReminder, PermissionMode, Point, RobotView, Settings, VocabWord } from './model';

// ---- the word card, My words

/** The word on the card: known (one you had already), a quiz, or a dream bubble (main.js). */
export type CardShownWord = VocabWord & { known?: boolean; quiz?: boolean; dream?: boolean };
export type CardInit = { word: CardShownWord; paint: string };
/** fresh: a new word on the card (not the same one looked up or edited). */
export type CardWord = { word: CardShownWord; paint: string; fresh?: boolean };

/** A row of My words (main.js wordRow); box: times seen. */
export type WordRow = {
  id: string;
  word: string;
  ipa: string;
  vi: string;
  pos: string;
  status: VocabWord['status'];
  addedAt: number;
  box: number;
  seen: number;
  right: number;
  due: number;
};
/** How it's going (vocab.js stats). */
export type WordsStats = { total: number; learnt: number; learning: number; due: number; reviewed: number; streak: number; today: boolean };
export type WordsList = { words: WordRow[]; stats: WordsStats; hotkey: string; reminders: boolean; hours: [number, number] };

// ---- the notebook

/**
 * The morning / end-of-day reminder's banner. info: how many notes (main.js remindNotes),
 * and the robot's line when it came through the robot (robot.js notes:remind-open).
 */
export type NotebookReminder = {
  kind: 'morning' | 'evening';
  info?: Partial<NotesReminder> & { line?: string };
  line?: string; // (read by the notebook, but main never sends it here: the line comes in info)
};
export type NotebookNotes = { notes: Note[]; board: NotesBoard };
/** focus: 'add' (the add box), a note's id, or null; text, source: what to put in the add box. */
export type NotebookOpen = { focus: string | null; reminder: NotebookReminder | null; text?: string; source?: string };
export type NotebookInit = NotebookNotes & NotebookOpen;

// ---- Quick actions

export type QuickAction = 'refine' | 'translate' | 'explain' | 'summarise';
export type QuickLang = 'en' | 'vi';
export type QuickPrefs = { action: QuickAction; style: string; lang: QuickLang };
/**
 * What the window shows (quickWindow.js view): the text, the last action you used (prefs: main
 * fills in the defaults, and the page does again), refine's styles.
 */
export type QuickInit = {
  text: string;
  source: string;
  canReplace: boolean;
  paint: string;
  prefs: Partial<QuickPrefs>;
  styles: { id: string; label: string; how: string }[];
  model: string;
  max: number;
};
export type QuickRunRequest = { action: QuickAction; text: string; style: string; custom: string; to: QuickLang; lang: QuickLang };
/** One of refine's changes (main quick.js splitRefine). */
export type QuickChange = { from: string; to: string; why: string };
/** quick:run's answer: the text (and refine's changes), or cancelled, or an error. */
export type QuickResult = { id: number; text?: string; changes?: QuickChange[]; ms?: number; model?: string; cancelled?: boolean; error?: string };
export type QuickOpen = QuickInit;
/** The answer so far, as it streams in. */
export type QuickText = { id: number; text: string };

// ---- the Robot Workshop

/** The notes reminders' settings (main notes.js NOTE_DEFAULTS). */
export type NoteSettings = { notesReminders: boolean; notesEvening: string; notesMorning: boolean; notesWorkdays: number[]; notesCarry: boolean };
/** The settings as the store keeps them, with the notes' and the words' (rewards) too. */
export type WorkshopSettings = Settings & Partial<NoteSettings> & { vocabRewards?: { gradcap?: boolean } };
/** A global hotkey (main.js hotkeyList): its keys, its default, whether it works (ok: no other app has it). */
export type WorkshopHotkey = {
  setting: 'paletteHotkey' | 'screenHotkey' | 'quickHotkey' | 'vocabHotkey' | 'noteHotkey';
  label: string;
  what: string;
  key: string;
  def: string;
  ok: boolean;
};
/** main.js mgr:state */
export type WorkshopState = {
  characters: RobotView[];
  personalities: Record<string, { label: string; emoji: string }>;
  permissionModes: Record<PermissionMode, string>;
  settings: WorkshopSettings;
  claudePath: string | null;
  claudeSource: string;
  notes: { hotkey: string; hotkeyOk: boolean; defaults: NoteSettings };
  hotkeys: WorkshopHotkey[];
};

// ---- a robot out for a walk

/** What a walker looks like (main.js walkerLook; maid.js's housemaid is staff, with a name tag). */
export type WalkerLook = Pick<Character, 'name' | 'color' | 'body' | 'kit' | 'accessory' | 'theme' | 'size'> & { staff?: boolean; tag?: string };
export type WalkerGait = 'stand' | 'walk' | 'sleepwalk' | 'wave' | 'look' | 'sit' | 'dangle' | 'land' | 'talk' | 'tiptoe' | 'clap' | 'dust';
export type WalkerHeading = 'left' | 'right' | 'away' | 'toward';
export type WalkerState = { gait: WalkerGait; heading: WalkerHeading; asleep: boolean; speed: number };
/** ({} when that robot isn't out) */
export type WalkerInit = Partial<{ character: WalkerLook | null; gait: WalkerGait; heading: WalkerHeading; asleep: boolean }>;
/** The cursor, from the walker box's corner. */
export type WalkerCursor = Point;
export type WalkerDream = { word: string };
export type WalkerSay = { text: string; ms: number };

// ---- the group chat and its meeting room

/** A robot in the group chat (groupChat.js robotInfo); out and agree once the chat's on. */
export type GroupChatRobot = {
  id: string;
  name: string;
  color: string;
  emoji: string;
  personality: string;
  folder: string;
  onDesk: boolean;
  asleep: boolean;
  out?: boolean; // (it left the chat)
  agree?: boolean;
};
/** A line of the chat: a robot's message (live while its words come in), yours, the summary or a notice. */
export type GroupChatMessage = {
  id: number;
  at: number;
  text: string;
  who: 'robot' | 'user' | 'summary' | 'system';
  name?: string;
  robot?: string; // (the robot's id)
  round?: number;
  live?: boolean;
  asked?: boolean; // (answering you)
  agree?: boolean;
  looked?: string[]; // (what it looked at first)
  note?: string; // ('cut short', 'took too long: skipped')
  error?: string;
  nudge?: string; // (what the robots read of a notice)
};
export type GroupChatPhase = 'running' | 'summarising' | 'done' | 'stopped';
/** Before it starts: who can join, and the lengths and cost caps to pick from. */
export type GroupChatSetup = { phase: 'setup'; hostId: string | null; robots: GroupChatRobot[]; rounds: number[]; messages: number[]; caps: number[] };
/** The chat going on (or just over). typing: free chat, who's writing and what they last looked at. */
export type GroupChatLive = {
  phase: GroupChatPhase;
  mode: 'free' | 'turns';
  topic: string;
  hostId: string;
  robots: GroupChatRobot[];
  round: number;
  rounds: number;
  said: number;
  messages: number;
  cost: number;
  cap: number;
  speaker: string | null;
  typing: { id: string; looked: string }[];
  wrapping: boolean;
  ended: string;
  log: GroupChatMessage[];
};
/** groupChat.js view */
export type GroupChatView = GroupChatSetup | GroupChatLive;
/** A speaker's words as they come (the message's id). */
export type GroupChatDelta = { id: number; delta: string };
/** Someone round the table (kit: its JSON). */
export type MeetingPerson = { id: string; name: string; color: string; kit: string; acc: string; theme: string };
/** groupChat.js meetingState: who's typing, talking, agreeing. */
export type MeetingState = { ids: string[]; mode: 'free' | 'turns'; phase: GroupChatPhase; speaker: string | null; typing: string[]; agree: string[] };
export type MeetingInit = { people: MeetingPerson[]; topic: string; state: MeetingState };
/** A line of what someone just posted. */
export type MeetingSay = { id: string; text: string; agree: boolean };

// ---- an MCP tool's view, big in a window of its own

/** main.js openAppWindow: the tool call it's for, and its input and result. */
export type AppWindowView = { id: string; server: string; tool: string; uri: string; title: string; input: unknown; result: unknown };
