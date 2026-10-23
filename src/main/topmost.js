// Windows can silently drop a window's "always on top" flag (taking a snip with
// the Snipping Tool does it) and Electron never notices: the robot falls behind
// the other windows and seems to vanish. So on Windows we read the real flag
// every couple of seconds and put it back when it's gone. Elsewhere this does
// nothing. It only ever restores a lost flag, so it never fights the Snipping
// Tool's own overlay or other always-on-top apps.

const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x8;
const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x1;
const SWP_NOMOVE = 0x2;
const SWP_NOACTIVATE = 0x10;
const SWP_NOOWNERZORDER = 0x200;

let user32;
function win32() {
  if (user32 !== undefined) return user32;
  user32 = null;
  if (process.platform !== 'win32') return user32;
  try {
    const koffi = require('koffi');
    const lib = koffi.load('user32.dll');
    user32 = {
      getExStyle: lib.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t hWnd, int nIndex)'),
      setPos: lib.func('bool __stdcall SetWindowPos(uintptr_t hWnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)'),
    };
  } catch (err) {
    console.warn('C-Bot: cannot check "always on top" on this system:', err.message);
  }
  return user32;
}

const hwndOf = (win) => {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
};

/** Keep the windows from getWindows() on top. Returns a function that stops it. */
function keepOnTop(getWindows, everyMs = 2000) {
  const api = win32();
  if (!api) return () => {};
  const timer = setInterval(() => {
    for (const win of getWindows()) {
      if (!win || win.isDestroyed() || !win.isVisible()) continue;
      try {
        const hwnd = hwndOf(win);
        if (Number(api.getExStyle(hwnd, GWL_EXSTYLE)) & WS_EX_TOPMOST) continue;
        api.setPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
        win.setAlwaysOnTop(true, 'floating'); // keep Electron's idea of it in step
      } catch {
        // a window closing mid-check; try again next time
      }
    }
  }, everyMs);
  return () => clearInterval(timer);
}

module.exports = { keepOnTop };
