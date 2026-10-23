const { app, Notification } = require('electron');

// Auto-updates for the installed app (the one built by `npm run dist` / `npm run release`).
// It checks GitHub Releases at start and every few hours, downloads a newer version in
// the background, and installs it the next time C-Bot quits — or straight away from the
// tray's "Restart to update". Running from source (`npm start`) it does nothing.

const CHECK_EVERY = 4 * 60 * 60 * 1000;

let autoUpdater = null;
const state = { ready: null, checking: false, last: '' }; // ready: the version waiting to install

function startUpdates({ onChange = () => {} } = {}) {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.warn('[update] electron-updater missing:', err.message);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => {
    state.checking = true;
    onChange(state);
  });
  autoUpdater.on('update-not-available', () => {
    state.checking = false;
    state.last = 'up to date';
    onChange(state);
  });
  autoUpdater.on('update-available', (info) => {
    state.last = `downloading ${info.version}…`;
    onChange(state);
  });
  autoUpdater.on('update-downloaded', (info) => {
    state.checking = false;
    state.ready = info.version;
    onChange(state);
    new Notification({ title: 'C-Bot update ready', body: `Version ${info.version} installs when C-Bot restarts. Right-click the tray icon → Restart to update.` }).show();
  });
  autoUpdater.on('error', (err) => {
    state.checking = false;
    state.last = "couldn't check";
    console.warn('[update]', err?.message || err);
    onChange(state);
  });
  check();
  setInterval(check, CHECK_EVERY).unref?.();
}

function check() {
  if (!autoUpdater) return false;
  autoUpdater.checkForUpdates().catch(() => {});
  return true;
}

// quit (saving everything) and run the downloaded installer silently, then start again
function restartToUpdate() {
  if (autoUpdater && state.ready) autoUpdater.quitAndInstall(true, true);
}

module.exports = { startUpdates, checkForUpdates: check, restartToUpdate, updateState: state };
