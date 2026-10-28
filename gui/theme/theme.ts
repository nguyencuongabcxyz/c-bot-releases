// Puts the chosen theme on <html> before the page draws: data-theme="vintage" | "future" and
// data-mode="light" | "dark" (theme.css keys off both). The choice lives in main (Settings >
// Theme); "follow Windows" is resolved here, and both follow changes live.
import type { ThemePick } from '@/types/model';

import * as ipc from '@/ipc';

const root = document.documentElement;
// which window this is ("card", "words", "notebook", "robot", "manager"…), for the themes' touches
root.dataset.page = new URLSearchParams(location.search).get('view') || '';
const dark = matchMedia('(prefers-color-scheme: dark)');
let pick: ThemePick = { theme: 'future', mode: 'auto' };
try {
  pick = { ...pick, ...ipc.theme() };
} catch {}
function apply() {
  root.dataset.theme = pick.theme === 'vintage' ? 'vintage' : 'future';
  root.dataset.mode = pick.mode === 'light' || pick.mode === 'dark' ? pick.mode : dark.matches ? 'dark' : 'light';
}
apply();
dark.addEventListener('change', apply);
try {
  ipc.on('theme:changed', (v) => {
    pick = { ...pick, ...v };
    apply();
  });
} catch {}
