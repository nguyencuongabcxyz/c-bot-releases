const { clipboard, globalShortcut } = require('electron');

// Global hotkeys that grab something from whatever app you're in, for the
// features that collect things (vocabulary words; quick notes can register their
// own kind too):
//   capture.register('vocab', 'Ctrl+Alt+W', handler)   handler runs on the hotkey
//   await capture.readSelection()  -> { text, source, hwnd }  the text selected in the
//                                     app in front, that window's title and handle
//   await capture.pasteInto(hwnd, text)  puts text over the selection in that window
//                                     (Ctrl+V), clipboard put back afterwards
// readSelection copies the selection the way you would (Ctrl+C, once you've let
// go of the hotkey's keys) and then puts your clipboard back as it was.
// (Win+Shift+S belongs to the Snipping Tool; don't use it.)

const VK = { SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, LWIN: 0x5b, RWIN: 0x5c, C: 0x43, V: 0x56 };
const KEYEVENTF_KEYUP = 0x2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let user32;
function win32() {
  if (user32 !== undefined) return user32;
  user32 = null;
  if (process.platform !== 'win32') return user32;
  try {
    const koffi = require('koffi');
    const lib = koffi.load('user32.dll');
    user32 = {
      keyState: lib.func('int16_t __stdcall GetAsyncKeyState(int vKey)'),
      key: lib.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)'),
      foreground: lib.func('uintptr_t __stdcall GetForegroundWindow()'),
      title: lib.func('int __stdcall GetWindowTextW(uintptr_t hWnd, _Out_ uint8_t *lpString, int nMaxCount)'),
      setForeground: lib.func('int __stdcall SetForegroundWindow(uintptr_t hWnd)'),
      isWindow: lib.func('int __stdcall IsWindow(uintptr_t hWnd)'),
      clipSeq: lib.func('uint32_t __stdcall GetClipboardSequenceNumber()'),
    };
  } catch (err) {
    console.warn('C-Bot: capture hotkeys cannot read selections on this system:', err.message);
  }
  return user32;
}

// the title of the window in front ("Report.docx - Word"), '' if unknown
function foregroundTitle() {
  const api = win32();
  if (!api) return '';
  try {
    const buf = Buffer.alloc(1024);
    const n = api.title(api.foreground(), buf, 512);
    return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
  } catch {
    return '';
  }
}

// wait (a second at most) for the hotkey's keys to come up, so our Ctrl+C isn't Ctrl+Alt+C
async function keysReleased(extra = []) {
  const api = win32();
  const keys = [VK.SHIFT, VK.CONTROL, VK.MENU, VK.LWIN, VK.RWIN, ...extra];
  for (let i = 0; i < 70; i++) {
    if (!keys.some((k) => api.keyState(k) & 0x8000)) return;
    await sleep(15);
  }
}

// what's on the clipboard now, to put back afterwards
function saveClipboard() {
  const formats = clipboard.availableFormats();
  const saved = {};
  if (formats.some((f) => f.startsWith('text/plain'))) saved.text = clipboard.readText();
  if (formats.includes('text/html')) saved.html = clipboard.readHTML();
  if (formats.includes('text/rtf')) saved.rtf = clipboard.readRTF();
  const image = clipboard.readImage();
  if (!image.isEmpty()) saved.image = image;
  return saved;
}
function restoreClipboard(saved) {
  if (Object.keys(saved).length) clipboard.write(saved);
  else clipboard.clear();
}

let busy = false;
const QUIET_TICKS = 10; // 150 ms
/**
 * The text selected in the app in front (trimmed; '' when nothing is selected), its window
 * title and handle. keepLines keeps its line breaks (else it's all on one line, for a word).
 */
async function readSelection({ hotkeyKey, keepLines = false } = {}) {
  const source = foregroundTitle();
  const api = win32();
  let hwnd = 0;
  try {
    hwnd = Number(api?.foreground() || 0);
  } catch {}
  if (!api || busy) return { text: '', source, hwnd };
  busy = true;
  const saved = saveClipboard();
  try {
    await keysReleased(hotkeyKey ? [hotkeyKey] : []);
    clipboard.clear();
    const before = api.clipSeq();
    api.key(VK.CONTROL, 0, 0, 0);
    api.key(VK.C, 0, 0, 0);
    api.key(VK.C, 0, KEYEVENTF_KEYUP, 0);
    api.key(VK.CONTROL, 0, KEYEVENTF_KEYUP, 0);
    let text = '';
    for (let i = 0; i < 40 && !text; i++) {
      await sleep(15);
      // the app hasn't touched the clipboard at all after a moment: nothing's selected,
      // so don't wait out the rest (apps copy a selection within a few tens of ms)
      if (i >= QUIET_TICKS && api.clipSeq() === before) break;
      text = clipboard.readText();
    }
    text = keepLines ? text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim() : text.replace(/\s+/g, ' ').trim();
    return { text, source, hwnd };
  } finally {
    restoreClipboard(saved);
    busy = false;
  }
}

/**
 * Put `text` in the window `hwnd` in place of what's selected there: back to that window,
 * Ctrl+V, and the clipboard as it was. Resolves false when that window's gone.
 */
async function pasteInto(hwnd, text) {
  const api = win32();
  if (!api || busy || !hwnd || !api.isWindow(hwnd)) return false;
  busy = true;
  const saved = saveClipboard();
  try {
    clipboard.writeText(String(text));
    api.setForeground(hwnd);
    await sleep(160); // (its caret and selection come back)
    await keysReleased();
    api.key(VK.CONTROL, 0, 0, 0);
    api.key(VK.V, 0, 0, 0);
    api.key(VK.V, 0, KEYEVENTF_KEYUP, 0);
    api.key(VK.CONTROL, 0, KEYEVENTF_KEYUP, 0);
    await sleep(350); // (the app reads the clipboard before it's put back)
    return true;
  } finally {
    restoreClipboard(saved);
    busy = false;
  }
}

const handlers = new Map(); // kind -> { accelerator, handler }

/** Bind `accelerator` (Electron syntax, e.g. 'Ctrl+Alt+W') to handler(kind). False if another app has it. */
function register(kind, accelerator, handler) {
  unregister(kind);
  if (!accelerator) return false;
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, () => handler(kind));
  } catch (err) {
    console.warn(`[capture] bad hotkey ${accelerator}:`, err.message);
  }
  if (ok) handlers.set(kind, { accelerator, handler });
  else console.warn(`[capture] ${accelerator} is taken by another app`);
  return ok;
}

function unregister(kind) {
  const h = handlers.get(kind);
  if (!h) return;
  globalShortcut.unregister(h.accelerator);
  handlers.delete(kind);
}

const hotkeyOf = (kind) => handlers.get(kind)?.accelerator || '';

// the virtual-key code of an accelerator's last key ('W' in Ctrl+Alt+W), so readSelection waits for it too
function keyCode(accelerator = '') {
  const last = accelerator.split('+').pop() || '';
  if (/^space$/i.test(last)) return 0x20;
  return /^[A-Z0-9]$/i.test(last) ? last.toUpperCase().charCodeAt(0) : undefined;
}

module.exports = { register, unregister, hotkeyOf, keyCode, readSelection, pasteInto, foregroundTitle };
