// The Workshop's fixed choices: paints, hats, sizes, desk themes, what a click opens, the
// hints under them, robots' names, and the desk routine the preview shows off.
export const COLORS = ['#5ac8fa', '#ff9f43', '#7bed9f', '#ff6b81', '#a29bfe', '#feca57', '#c8d6e5', '#ffffff'];
export const ACCESSORIES = {
  none: 'None',
  hardhat: '👷 Hard hat',
  glasses: '🤓 Glasses',
  bowtie: '🎀 Bow tie',
  tophat: '🎩 Top hat',
  crown: '👑 Crown',
  headphones: '🎧 Headphones',
  flower: '🌸 Flower',
  pirate: '🏴‍☠️ Pirate hat',
  gradcap: '🎓 Graduation cap', // a reward: shown once you've learnt 10 English words
  santa: 'Santa hat',
  elf: 'Elf hat',
  antlers: 'Reindeer antlers',
  witch: 'Witch hat',
  horns: 'Devil horns',
  sunhat: 'Sun hat',
  strawhat: 'Straw hat',
  partyhat: 'Party hat',
  tiara: 'Tiara',
  hairbow: 'Hair bow',
  maidcap: 'Maid headband',
  beanie: 'Beanie',
};
export const SIZES = { small: '🐭 Small', normal: '🙂 Normal', large: '🦒 Large', huge: '🐘 Huge' };
export const SOUNDS_HINT = {
  essential:
    'An answer is ready, a question for you, an error, a reminder, and a sound when you play with it. Quiet while you present or share your screen.',
  all: 'Every sound: chatter while it answers, each step, its antics and snores, the robots together.',
  off: 'No sounds at all, and no word read aloud.',
};
// desk themes (office3d/themes.js); picking one also picks its paint job
export const THEMES: Record<string, { label: string; paint?: string }> = {
  classic: { label: '🎨 Classic' },
  sioux: { label: '⛺ Sioux Connect', paint: '#F47920' },
};

export const PERMISSION_HINTS = {
  default: 'Can read and search files. Anything that changes things gets politely refused.',
  acceptEdits: 'Can read and edit files in its folder. Shell commands are still refused.',
  bypassPermissions: '⚠️ Can run any command and change anything without asking. Only for folders you trust it with.',
  plan: 'Investigates and proposes plans, but makes no changes.',
};
export const CLICK_OPENS = { chat: '💬 Chat bubble', terminal: '⌨️ Terminal (full Claude Code)' };
export const CLICK_HINTS = {
  chat: 'The cartoon chat. You can still jump to the terminal with ⌨️ or /terminal.',
  terminal:
    'Real Claude Code in a terminal window, with every command and prompt. The robot acts out what happens there.',
};
export const WANDERS = { yes: '🚶 Now and then', no: '🪑 Stays at its desk' };
export const WANDER_HINTS = {
  yes: 'Left alone for a while it goes for a walk round the screen (asleep, it sleepwalks). Drag it back onto its desk to use it again.',
  no: 'It never leaves its desk.',
};
export const NAMES = [
  'Sparky',
  'Bolt',
  'Widget',
  'Pixel',
  'Gizmo',
  'Rusty',
  'Beep',
  'Nugget',
  'Sprocket',
  'Byte',
  'Cogsworth',
  'Zippy',
];

/** The desk routine the preview shows off: what the robot does while Claude Code works. */
export const DEMO = [
  { screen: 'idle', pose: 'idle', mouth: 'smile', eyes: 'open', label: 'Waiting for a question' },
  { screen: 'think', pose: 'thinking', mouth: 'o', eyes: 'open', label: '🤔 Thinking', cls: 'thinking' },
  { screen: 'read', pose: 'reading', mouth: 'o', eyes: 'open', label: '📖 Reading a file' },
  { screen: 'search', pose: 'reading', mouth: 'o', eyes: 'open', label: '🔍 Searching the code' },
  { screen: 'edit', pose: 'typing', mouth: 'o', eyes: 'open', label: '✏️ Editing a file' },
  { screen: 'run', pose: 'typing', mouth: 'o', eyes: 'open', label: '⚙️ Running a command' },
  { screen: 'web', pose: 'reading', mouth: 'o', eyes: 'open', label: '🌐 Browsing the web' },
  { screen: 'agent', pose: 'reading', mouth: 'o', eyes: 'open', label: '🤖 Sending a helper bot' },
  { screen: 'plan', pose: 'typing', mouth: 'o', eyes: 'open', label: '✅ Making a plan' },
  { screen: 'talk', pose: 'talking', mouth: 'talk', eyes: 'open', label: '💬 Answering you', cls: 'talking' },
  { screen: 'done', pose: 'cheer', mouth: 'smile', eyes: 'happy', label: '🎉 Done!' },
  { screen: 'error', pose: 'idle', mouth: 'flat', eyes: 'dizzy', label: '😵 Something broke' },
  { screen: 'locked', pose: 'idle', mouth: 'flat', eyes: 'flat', label: '🔒 Not allowed to do that' },
];
