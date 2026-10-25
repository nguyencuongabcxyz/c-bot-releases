const { contextBridge, ipcRenderer } = require('electron');

// The meeting room window's own small bridge (main meeting.js): the same shape as preload.js's
// `cbot`, with only the channels this window uses.
const INVOKE = new Set(['meeting:init']);
const LISTEN = new Set(['meeting:state', 'meeting:say']);

contextBridge.exposeInMainWorld('cbot', {
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
