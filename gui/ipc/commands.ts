// Every command the pages call in main (app/src), typed: one function each, named after
// its Rust function (robotAsk is robot_ask); the arguments go over by name (tabId arrives as
// tab_id). The ones under "told" don't wait for an answer.
import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import type { AppPage, AppView, AppViewCall, Box, Character, ClaudeCommand, ContextUse, FileChip, FileInfo, FileView, LinkTask, ModelChoice, Note, NotesReminder, OkOr, PermissionMode, Point, QAItem, SessionRow, Settings, Transcript } from '@/types/model';
import type * as P from '@/types/pages';
import type { RobotInit, AskResult, IslandEdge, IslandNews, IslandReport, IslandRobot, PaletteView, SocialReport, StageState } from '@/types/ipc';

/** A command whose answer nobody waits for (a failure is only logged). */
function tell(cmd: string, args?: InvokeArgs): void {
  invoke(cmd, args).catch((err) => console.warn(cmd, err));
}

// ---- a robot window
export const robotInit = () => invoke<RobotInit>('robot_init');
// (tag: a line kept above the message: sent to everyone on the stage)
export const robotAsk = (tabId: string, prompt: string, attachments: string[], turnId?: string, kind?: 'chat' | 'bonk', tag?: string) => invoke<AskResult>('robot_ask', { tabId, prompt, attachments, turnId, kind, tag });
export const robotCompact = (tabId: string, turnId: string) => invoke<AskResult>('robot_compact', { tabId, turnId });
export const robotRemote = (tabId: string, on: boolean) => invoke<OkOr<{}>>('robot_remote', { tabId, on });
export const robotCancel = (tabId: string) => invoke<string[]>('robot_cancel', { tabId });
export const robotUnqueue = (tabId: string, turnId: string) => invoke<boolean>('robot_unqueue', { tabId, turnId });
export const robotSendNow = (tabId: string, turnId: string) => invoke<boolean>('robot_send_now', { tabId, turnId });
export const robotAnswer = (tabId: string, requestId: string, answers: Record<string, string>, items: QAItem[]) => invoke<boolean>('robot_answer', { tabId, requestId, answers, items });
// (edit the last question: back to before it; its words come back to edit)
export const robotRewind = (tabId: string) => invoke<OkOr<{ text: string; files?: FileChip[] }>>('robot_rewind', { tabId });
// (the tab's permission mode too, and whether the robot may be switched to doing anything at all)
export const robotBrain = (tabId: string) =>
  invoke<{ models: ModelChoice[]; model: string; effort: string; permissionMode: PermissionMode; canBypass: boolean; context: ContextUse | null } | null>('robot_brain', { tabId });
export const robotSetBrain = (tabId: string, patch: { model?: string; effort?: string; permissionMode?: PermissionMode }) => invoke<{ ok: boolean; error?: string }>('robot_set_brain', { tabId, patch });
// Claude's plan: go ahead in a permission mode, or (mode null) keep planning with your notes
export const robotPlan = (tabId: string, requestId: string, plan: string, mode: PermissionMode | null, feedback: string) =>
  invoke<{ ok: boolean; error?: string }>('robot_plan', { tabId, requestId, plan, mode, feedback });
export const robotExpand = (expanded: boolean, opts?: { focus?: boolean; tucked?: boolean }) => invoke<void>('robot_expand', { expanded, opts });
export const robotPeek = (peek: boolean) => invoke<void>('robot_peek', { peek });
export const robotPoke = () => invoke<number>('robot_poke');
export const robotReset = (tabId?: string) => invoke<void>('robot_reset', { tabId });
export const robotMenu = (state: { awake: boolean; away?: boolean }) => invoke<void>('robot_menu', { state });
export const robotTerminal = (tabId: string) => invoke<OkOr<{ already?: boolean }>>('robot_terminal', { tabId });
// (temporary: a chat that keeps nothing, gone when it's closed)
export const robotTabNew = (temporary?: boolean) => invoke<OkOr<{ tabId: string }>>('robot_tab_new', { temporary });
export const robotTabClose = (tabId: string) => invoke<OkOr<{ activeTab?: string }>>('robot_tab_close', { tabId });
export const robotTabReopen = (tabId?: string) => invoke<OkOr<{ tabId: string; title: string }>>('robot_tab_reopen', { tabId });
export const robotTabRename = (tabId: string, title: string) => invoke<void>('robot_tab_rename', { tabId, title });
export const robotTabActivate = (tabId: string) => invoke<void>('robot_tab_activate', { tabId });
export const robotSessions = () => invoke<SessionRow[]>('robot_sessions');
export const robotSession = (sessionId: string) => invoke<Transcript | null>('robot_session', { sessionId });
// (already: it was open in one of the tabs, now the active one)
export const robotResume = (tabId: string, sessionId: string) => invoke<OkOr<{ tabId: string; already: true } | { tabId: string; already?: undefined; title: string; total: number }>>('robot_resume', { tabId, sessionId });
export const robotCommands = () => invoke<ClaudeCommand[]>('robot_commands');
export const robotFiles = (query: string) => invoke<{ rel: string; dir: boolean }[]>('robot_files', { query });
export const robotInspectPaths = (paths: string[]) => invoke<FileInfo[]>('robot_inspect_paths', { paths });
// (the picture goes over as it is, the request's body; its extension in a header)
export const robotSavePaste = (bytes: ArrayBuffer | Uint8Array, ext: string) => invoke<FileInfo | null>('robot_save_paste', bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { headers: { ext } });
export const robotPasteClipboard = () => invoke<FileInfo[]>('robot_paste_clipboard');
export const robotOpenFile = (file: string, opts?: { reveal?: boolean }) => invoke<OkOr<{ revealed?: boolean }>>('robot_open_file', { file, opts });
// (a file or folder opened in the chat itself)
export const robotReadFile = (path: string) => invoke<OkOr<FileView>>('robot_read_file', { path });
// (speaking into the chat box, voice.rs: the system's engine, if there is one; systemUi: it
// shows the listening itself)
export const voiceEngine = () => invoke<{ name: string | null; systemUi: boolean }>('voice_engine');
export const voiceStart = () => invoke<void>('voice_start');
// (the composer's ＋: files, or only pictures, picked in the open dialog)
export const robotPickFiles = (pictures?: boolean) => invoke<FileInfo[]>('robot_pick_files', { pictures });
// (how tall you made the chat; null: the height of the screen)
export const robotChatHeight = (height: number | null) => invoke<void>('robot_chat_height', { height });
// (what an MCP tool's view asked to open: main opens it only if it's a web link)
export const robotOpenLink = (url: string | undefined) => invoke<void>('robot_open_link', { url });
export const robotOpenFolder = () => invoke<void>('robot_open_folder');
// (the shells in its chat, shell.rs: one per tab of the drawer, each belonging to a chat tab;
// sid names one, and its robot:shell events)
// (kind: 'bash' for Git Bash, else PowerShell; robotShellKinds: the ones there are here)
export const robotShellOpen = (cols: number, rows: number, tabId: string, kind: string) => invoke<OkOr<{ sid: number; shell: string }>>('robot_shell_open', { cols, rows, tabId, kind });
export const robotShellKinds = () => invoke<{ kind: string; label: string }[]>('robot_shell_kinds');
export const robotShellWrite = (sid: number, data: string) => invoke<void>('robot_shell_write', { sid, data });
export const robotShellResize = (sid: number, cols: number, rows: number) => tell('robot_shell_resize', { sid, cols, rows });
// (no sid: all of them)
export const robotShellClose = (sid?: number) => invoke<void>('robot_shell_close', { sid });
// (how a terminal_* call from its Claude went: robot:shell-ask)
export const robotShellReply = (req: number, answer: { text: string; isError?: boolean }) => tell('robot_shell_reply', { req, answer });
export const robotWanderPrep = (opts: { asleep: boolean }) => invoke<boolean>('robot_wander_prep', { opts });
export const robotWander = (opts: { asleep: boolean; feet?: Point }) => invoke<boolean>('robot_wander', { opts });
export const robotTasks = () => invoke<LinkTask[]>('robot_tasks');
export const robotScreenAsk = () => invoke<boolean>('robot_screen_ask');
export const robotVocabSave = (text: string) => invoke<void>('robot_vocab_save', { text });
export const robotVocabOpen = (id: string) => invoke<boolean>('robot_vocab_open', { id });
export const robotVocabQuiz = (how: 'later' | 'ignored') => invoke<boolean>('robot_vocab_quiz', { how });
export const robotVocabQuizMe = () => invoke<boolean>('robot_vocab_quiz_me');
export const robotVocabWords = () => invoke<void>('robot_vocab_words');
export const robotVocabDream = () => invoke<boolean>('robot_vocab_dream');
export const robotVocabBox = () => invoke<boolean>('robot_vocab_box');
// (focus: 'add' for the add box, or a note's id)
export const notesOpen = (opts?: { focus?: string | null }) => invoke<void>('notes_open', { opts });
export const notesAdd = (text: string) => invoke<Note | null>('notes_add', { text });
// (the note as it is now, null if it's gone; remind-shown: true)
export const notesAct = (action: 'working' | 'done' | 'remind-shown', p?: { id?: string; working?: boolean }) => invoke<Note | true | null>('notes_act', { action, p });
export const notesRemindOpen = (p: { kind: 'morning' | 'evening'; info: Partial<NotesReminder> & { line: string } }) => invoke<void>('notes_remind_open', { p });
export const quickOpenBlank = (p?: { text?: string }) => invoke<void>('quick_open_blank', { p });
// ---- MCP tool views (in the chat, and big in a window of their own)
export const robotAppView = (toolName: string) => invoke<AppView | null>('robot_app_view', { toolName });
export const robotAppPage = (server: string, uri: string) => invoke<OkOr<AppPage>>('robot_app_page', { server, uri });
export const robotAppCall = (server: string, method: string, params: unknown) => invoke<OkOr<{ result: unknown }> & { code?: number }>('robot_app_call', { server, method, params });
export const robotAppWindow = (view: AppViewCall & { title: string }) => invoke<boolean>('robot_app_window', { view });
export const appviewInit = () => invoke<P.AppWindowView | null>('appview_init');
// ---- a robot out for a walk
export const walkerInit = () => invoke<P.WalkerInit>('walker_init');
// ---- the action palette
export const paletteInit = () => invoke<PaletteView | null>('palette_init');
export const palettePick = (id: string) => invoke<boolean>('palette_pick', { id });
export const paletteClose = () => invoke<boolean>('palette_close');
// ---- drag a box round part of the screen
export const snipInit = () => invoke<{ image: string; hint: string } | null>('snip_init');
export const snipDone = (area: Box) => invoke<boolean>('snip_done', { area });
export const snipCancel = () => invoke<boolean>('snip_cancel');
// ---- the word card, My words
export const cardInit = () => invoke<P.CardInit | null>('card_init');
export const cardAct = (action: string, payload?: unknown) => invoke<unknown>('card_act', { action, payload });
export const wordsList = () => invoke<P.WordsList>('words_list');
export const wordsOpen = (id: string) => invoke<boolean>('words_open', { id });
export const wordsDelete = (id: string) => invoke<boolean>('words_delete', { id });
export const wordsQuiz = () => invoke<boolean>('words_quiz');
export const wordsExport = () => invoke<string | null>('words_export');
export const wordsSettings = (patch: { reminders?: boolean; hours?: [number, number] }) => invoke<boolean>('words_settings', { patch });
// ---- the notebook, Quick actions
export const notebookInit = () => invoke<P.NotebookInit | null>('notebook_init');
export const notebookAct = (action: string, p?: unknown) => invoke<unknown>('notebook_act', { action, p });
export const quickInit = () => invoke<P.QuickInit | null>('quick_init');
export const quickRun = (req: P.QuickRunRequest) => invoke<unknown>('quick_run', { req });
export const quickAct = (action: string, p?: unknown) => invoke<unknown>('quick_act', { action, p });
// ---- the Robot Workshop
export const mgrState = () => invoke<P.WorkshopState>('mgr_state');
export const mgrPickFolder = (current?: string) => invoke<string | null>('mgr_pick_folder', { current });
export const mgrCreate = (fields: Partial<Character>) => invoke<Character>('mgr_create', { fields });
export const mgrUpdate = (id: string, patch: Partial<Character>) => invoke<Character | null>('mgr_update', { id, patch });
export const mgrDelete = (id: string) => invoke<void>('mgr_delete', { id });
export const mgrVisible = (id: string, visible: boolean) => invoke<void>('mgr_visible', { id, visible });
export const mgrReset = (id: string) => invoke<void>('mgr_reset', { id });
export const mgrSettings = (patch: Partial<Settings>) => invoke<Settings>('mgr_settings', { patch });
export const mgrPickClaude = () => invoke<OkOr<{ path?: string; version?: string }>>('mgr_pick_claude');
export const mgrFindClaude = () => invoke<{ claudePath: string | null; claudeSource: string }>('mgr_find_claude');
// ---- the group chat and its meeting room
export const groupchatInit = () => invoke<P.GroupChatView | null>('groupchat_init');
export const groupchatAct = (action: string, p?: unknown) => invoke<unknown>('groupchat_act', { action, p });
export const meetingInit = () => invoke<P.MeetingInit | null>('meeting_init');

// ---- the robot island (island.rs)
export const islandInit = () => invoke<{ robots: IslandRobot[]; edge: IslandEdge }>('island_init');

// ---- the stage (stage.rs): its bar
export const stageInit = () => invoke<StageState>('stage_init');
export const stageSend = (prompt: string, paths: string[]) => invoke<OkOr<{ count: number }>>('stage_send', { prompt, paths });
export const stagePickFiles = () => invoke<FileInfo[]>('stage_pick_files');

// ---- told, not asked: nothing comes back
export const robotDrag = (step: { phase: 'start' | 'move' | 'end'; dx?: number; dy?: number }) => tell('robot_drag', { step });
export const robotResize = (step: { phase: 'start' | 'move' | 'end' | 'reset'; dx?: number }) => tell('robot_resize', { step });
export const robotClickThrough = (through: boolean) => tell('robot_click_through', { through });
export const robotAlive = (hidden: boolean) => tell('robot_alive', { hidden });
export const robotRevive = () => tell('robot_revive');
export const robotWalker = (what: 'wave' | 'asleep' | 'awake' | 'dock' | 'docked' | 'cancel') => tell('robot_walker', { what });
export const robotsAnswer = (answer: { reqId: string; text?: string; error?: string }) => tell('robots_answer', { answer });
export const socialReport = (report: SocialReport) => tell('social_report', { report });
export const robotIsland = (report: IslandReport, news?: IslandNews) => tell('robot_island', { report, news });
export const walkerDrag = (step: { phase: 'start' | 'move' | 'end'; dx?: number; dy?: number }) => tell('walker_drag', { step });
export const walkerClick = () => tell('walker_click');
export const walkerReady = () => tell('walker_ready');
export const walkerThrough = (through: boolean) => tell('walker_through', { through });
export const cardSize = (height: number) => tell('card_size', { height });
export const islandSize = (width: number, height: number) => tell('island_size', { width, height });
export const islandBox = (x: number, y: number, width: number, height: number) => tell('island_box', { x, y, width, height });
export const islandDrag = (phase: 'start' | 'end') => tell('island_drag', { phase });
export const stagePick = () => tell('stage_pick');
export const stageAddMenu = () => tell('stage_add_menu');
export const stageTile = (action: 'spot' | 'leave') => tell('stage_tile', { action });
export const stageSplit = (step: { phase: 'start' | 'move' | 'end' | 'even'; split: string; d?: number }) => tell('stage_split', { step });
export const stageSwap = (phase: 'start' | 'move' | 'end') => tell('stage_swap', { phase });
export const stageAct = (action: 'start' | 'clear' | 'unpick' | 'exit' | 'add' | 'even' | 'chip', id?: string) => tell('stage_act', { action, id });
export const islandAct = (action: 'out' | 'away' | 'chat' | 'notes' | 'workshop' | 'all-out' | 'all-away', id?: string) => tell('island_act', { action, id });
export const quickSize = (height: number) => tell('quick_size', { height });
export const paletteSize = (height: number) => tell('palette_size', { height });
export const droneArrived = () => tell('drone_arrived');
export const droneGone = () => tell('drone_gone');
