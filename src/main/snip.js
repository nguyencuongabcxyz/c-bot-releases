const { BrowserWindow, desktopCapturer, ipcMain, screen } = require('electron');
const path = require('path');

// Drag a box round a word you can't select (in a picture, a video, a PDF scan):
// the screen under the mouse is captured, shown dimmed over itself, and the box
// you drag is cut out of that capture and handed to onShot(nativeImage).
// Esc, a click without a drag or a right-click cancels.
//   const snipper = createSnipper({ preload, guardNavigation, onShot, onCancel })
//   await snipper.start({ hint, hide })  hint: the line shown at the top; hide: windows
//                                        faded out while the screen is captured

function createSnipper({ preload, guardNavigation, onShot, onCancel = () => {} }) {
  let win = null;
  let shot = null; // { image, display }
  let hint = '';

  function close() {
    if (win && !win.isDestroyed()) win.close();
    win = null;
  }

  async function start({ hint: line = '', hide = [] } = {}) {
    if (win) return;
    hint = line;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { width, height } = display.size;
    const scale = display.scaleFactor || 1;
    // the screen as it is now, before the overlay covers it (and without the windows in the way)
    const faded = hide.filter((w) => !w.isDestroyed() && w.isVisible());
    for (const w of faded) w.setOpacity(0);
    if (faded.length) await new Promise((r) => setTimeout(r, 120)); // (till the screen's redrawn without them)
    let sources;
    try {
      sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) } });
    } finally {
      for (const w of faded) if (!w.isDestroyed()) w.setOpacity(1);
    }
    const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!source) return onCancel();
    shot = { image: source.thumbnail, display };
    win = new BrowserWindow({
      ...display.bounds,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      show: false,
      backgroundColor: '#000000',
      title: 'Drag a box round a word',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile(path.join(__dirname, '..', 'renderer', 'snip', 'index.html'));
    guardNavigation(win);
    win.once('ready-to-show', () => {
      win.setBounds(display.bounds);
      win.show();
      win.focus();
    });
    win.on('blur', () => {
      // switched away (Alt+Tab): no box after all
      if (win && !win.isDestroyed()) {
        close();
        onCancel();
      }
    });
    win.on('closed', () => (win = null));
  }

  const fromSnip = (event) => win && !win.isDestroyed() && event.sender === win.webContents;
  ipcMain.handle('snip:init', (event) => (fromSnip(event) && shot ? { image: shot.image.toDataURL(), hint } : null));
  // the box, in the page's CSS px (= DIP on that screen)
  ipcMain.handle('snip:done', (event, box) => {
    if (!fromSnip(event) || !shot) return false;
    const scale = shot.display.scaleFactor || 1;
    const size = shot.image.getSize();
    const x = Math.max(0, Math.round(box.x * scale));
    const y = Math.max(0, Math.round(box.y * scale));
    const crop = {
      x,
      y,
      width: Math.min(size.width - x, Math.round(box.width * scale)),
      height: Math.min(size.height - y, Math.round(box.height * scale)),
    };
    const image = shot.image;
    shot = null;
    win.removeAllListeners('blur');
    close();
    if (crop.width < 6 || crop.height < 6) return onCancel(), false;
    onShot(image.crop(crop));
    return true;
  });
  ipcMain.handle('snip:cancel', (event) => {
    if (!fromSnip(event)) return false;
    shot = null;
    win.removeAllListeners('blur');
    close();
    onCancel();
    return true;
  });

  return { start, windows: () => (win && !win.isDestroyed() ? [win] : []) };
}

module.exports = { createSnipper };
