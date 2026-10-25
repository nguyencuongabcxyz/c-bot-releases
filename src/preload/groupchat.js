const { contextBridge, ipcRenderer } = require('electron');

// The group chat window's own small bridge (main groupChat.js): the same shape as preload.js's
// `cbot`, with only the channels this window uses.
const INVOKE = new Set(['groupchat:init', 'groupchat:act']);
const LISTEN = new Set(['groupchat:state', 'groupchat:delta', 'theme:changed']);

contextBridge.exposeInMainWorld('cbot', {
  // the look the user picked, { theme, mode } (ui/theme.js)
  theme() {
    return ipcRenderer.sendSync('theme:get');
  },
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) throw new Error(`Blocked channel ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, cb) {
    if (!LISTEN.has(channel)) throw new Error(`Blocked channel ${channel}`);
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
