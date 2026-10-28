// The robot window's fixed tables: what each of Claude Code's tools looks like as a step, how
// the robot sits for each monitor scene, and the sizes and timings the parts agree on.

/** The robot's own part of its window, in CSS px (the 3D office is drawn this big). */
export const ROBOT_W = 300;
export const ROBOT_H = 290;

/** Left alone this long, awake and idle, it dozes off. */
export const AUTO_SLEEP_MS = 3 * 60 * 1000;

/** What it says it's doing while it thinks. */

export const THINKING_VERBS = [
  'Thinking',
  'Pondering',
  'Crunching bits',
  'Consulting my circuits',
  'Rummaging around',
  'Warming up the neurons',
  'Beep-booping',
  'Reticulating splines',
  'Oiling the gears',
];

// tool name -> [chip emoji, verb, what the robot does at its desk]
export const TOOLS: Record<string, [string, string, string]> = {
  Read: ['📖', 'Reading', 'read'],
  Glob: ['🗂️', 'Looking for', 'search'],
  Grep: ['🔍', 'Searching for', 'search'],
  Bash: ['⚙️', 'Running', 'run'],
  PowerShell: ['⚙️', 'Running', 'run'],
  Edit: ['✏️', 'Editing', 'edit'],
  MultiEdit: ['✏️', 'Editing', 'edit'],
  Write: ['📝', 'Writing', 'edit'],
  NotebookEdit: ['📓', 'Editing', 'edit'],
  WebSearch: ['🌐', 'Searching the web for', 'web'],
  WebFetch: ['🌐', 'Visiting', 'web'],
  Task: ['🤖', 'Sending a helper bot:', 'agent'],
  Agent: ['🤖', 'Sending a helper bot:', 'agent'],
  TodoWrite: ['✅', 'Planning', 'plan'],
  AskUserQuestion: ['✋', 'Asking you', 'ask'],
  ToolSearch: ['🧰', 'Looking up tools:', 'think'],
  TaskCreate: ['📋', 'Adding a task:', 'plan'],
  TaskUpdate: ['✅', 'Updating task', 'plan'],
  TaskList: ['📋', 'Checking the plan', 'plan'],
  TaskGet: ['📋', 'Checking a task', 'plan'],
  Skill: ['🎓', 'Using the skill', 'read'],
  // asking another robot (main robotLink.js)
  mcp__cbot__ask_robot: ['🤖', 'Asking', 'agent'],
  mcp__cbot__list_robots: ['🤖', 'Looking for the other robots', 'agent'],
  mcp__cbot__hand_off_task: ['📋', 'Handing off', 'agent'],
  // its other tabs, at work in the same folder
  mcp__cbot__list_tabs: ['🗂️', 'Checking my other tabs', 'agent'],
  mcp__cbot__wait_for_tab: ['⏳', 'Waiting for', 'agent'],
  // your words and notebook
  mcp__cbot__list_words: ['📚', 'Checking your words', 'read'],
  mcp__cbot__save_words: ['📚', 'Saving the words', 'edit'],
  mcp__cbot__list_notes: ['🗒️', 'Reading your notes', 'read'],
  mcp__cbot__add_note: ['🗒️', 'Noting down', 'edit'],
  // the shells in its conversation's drawer
  mcp__cbot__terminal_read: ['💻', 'Reading the terminal', 'read'],
  mcp__cbot__terminal_type: ['💻', 'Typing in the terminal:', 'run'],
  mcp__cbot__terminal_run: ['💻', 'Running in the terminal:', 'run'],
};

// a tool chip's line icon, by the kind of step (@/icons/icons.ts)
export const TOOL_ICONS: Record<string, string> = {
  read: 'file',
  search: 'search',
  run: 'terminal',
  edit: 'edit',
  web: 'globe',
  agent: 'bot',
  plan: 'plan',
  ask: 'help',
  think: 'wrench',
};

// monitor scene -> how the robot sits while it's on screen
export const POSES: Record<string, string> = {
  off: 'sleep',
  boot: 'idle',
  idle: 'idle',
  think: 'thinking',
  talk: 'talking',
  read: 'reading',
  search: 'reading',
  web: 'reading',
  agent: 'reading',
  edit: 'typing',
  run: 'typing',
  plan: 'typing',
  done: 'cheer',
  error: 'idle',
  locked: 'idle',
  ask: 'raise',
  compact: 'typing',
  helpers: 'thinking', // supervising its helper agents: chin in hand, watching them circle
  dance: 'cheer',
};

// where the monitor is, relative to the robot's face, for eye tracking
export const MONITOR = { dx: 200, dy: 50 };

export const fileIcon = (f: { isDir: boolean; isImage: boolean }) =>
  f.isDir ? 'folder' : f.isImage ? 'image' : 'file'; // (a icons/icons.ts name)

// "anthropic-skills:pptx" -> "pptx (anthropic-skills)", as the bridge describes it live
export const skillLabel = (s: string) => {
  const i = s.lastIndexOf(':');
  return i > 0 ? `${s.slice(i + 1)} (${s.slice(0, i)})` : s;
};
