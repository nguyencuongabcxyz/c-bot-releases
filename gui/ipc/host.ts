// What the window itself gets from main, besides commands and events: the theme it opened
// in, where local pictures are served from, the mouse while clicks go through it, and files
// dragged onto it. Imported once by main.ts, before any view.
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { ThemePick } from '@/types/model';

const THEME: ThemePick = (() => {
  try {
    return JSON.parse(new URLSearchParams(location.search).get('theme') ?? '');
  } catch {
    return { theme: 'future', mode: 'auto' };
  }
})();

/** The look picked in Settings > Theme as the window opened (main puts it in ?theme=). */
export const theme = (): ThemePick => THEME;

/** Local pictures and files in the chat (main's cbot-file protocol, as WebView2 serves it). */
export const fileUrl = 'http://cbot-file.localhost/';

// Files dragged onto a window: Tauri takes the drop itself (that's how it learns their
// paths, which a page's File doesn't carry), so the page never sees it. It's replayed below
// as the page's own drag events, with a stand-in File for each file, whose real path
// pathForFile knows.
const dropped = new Map<string, string>(); // `${name}|${lastModified}` of a stand-in -> its real path
let stamp = 0;
const keyOf = (f: File) => `${f.name}|${f.lastModified}`;
function standIns(paths: string[]): File[] {
  dropped.clear(); // (the last drop's are done with)
  return paths.map((p) => {
    const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
    const f = new File([], name, { lastModified: Date.now() * 1000 + (stamp++ % 1000) }); // (unique: its key)
    dropped.set(keyOf(f), p);
    return f;
  });
}

/** The real path of a dropped file ('' for one that isn't: a pasted picture). */
export const pathForFile = (file: File): string => dropped.get(keyOf(file)) ?? '';

// A window that lets clicks through gets no mouse moves of its own, so the page can't tell
// the mouse is back over something solid. Main watches the cursor and sends them: replay
// each on what's under it, as the page would have had it.
void getCurrentWebviewWindow().listen<{ x: number; y: number; sx: number; sy: number }>('cbot:forward', ({ payload: p }) => {
  const el = document.elementFromPoint(p.x, p.y) || document.documentElement;
  el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: p.x, clientY: p.y, screenX: p.sx, screenY: p.sy }));
});

// Tauri's drag-drop (positions in physical px within the window) as the page's dragenter /
// dragover / drop / dragleave, carrying the stand-in Files.
let drag: { files: File[]; at: { x: number; y: number } | null } | null = null;
function fire(type: string, position?: { x: number; y: number }) {
  if (!drag) return;
  const r = window.devicePixelRatio || 1;
  const at = position ? { x: position.x / r, y: position.y / r } : drag.at || { x: 0, y: 0 };
  drag.at = at;
  const dataTransfer = new DataTransfer();
  for (const f of drag.files) dataTransfer.items.add(f);
  const el = document.elementFromPoint(at.x, at.y) || document.documentElement;
  el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: at.x, clientY: at.y, dataTransfer }));
}
void getCurrentWebview().onDragDropEvent(({ payload: p }) => {
  switch (p.type) {
    case 'enter':
      // (text or anything else that isn't files: nothing for the page to take)
      drag = p.paths.length ? { files: standIns(p.paths), at: null } : null;
      fire('dragenter', p.position);
      break;
    case 'over':
      fire('dragover', p.position);
      break;
    case 'drop':
      if (p.paths.length) {
        drag = { files: standIns(p.paths), at: drag && drag.at };
        fire('drop', p.position);
      }
      drag = null;
      break;
    case 'leave':
      fire('dragleave');
      drag = null;
      break;
  }
});
