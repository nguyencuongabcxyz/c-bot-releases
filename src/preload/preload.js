const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set([
  'robot:init', 'robot:ask', 'robot:cancel', 'robot:expand', 'robot:poke', 'robot:reset', 'robot:open-folder', 'robot:menu',
  'robot:sessions', 'robot:session', 'robot:resume', 'robot:commands', 'robot:inspect-paths', 'robot:save-paste', 'robot:paste-clipboard', 'robot:files', 'robot:answer', 'robot:terminal',
  'robot:tab-new', 'robot:tab-close', 'robot:tab-rename', 'robot:tab-activate', 'robot:tab-reopen',
  'robot:unqueue', 'robot:send-now', 'robot:brain', 'robot:set-brain', 'robot:compact',
  'robot:app-view', 'robot:app-page', 'robot:app-call', 'robot:open-link', 'robot:app-window', 'appview:init', 'robot:open-file',
  'model:data', 'mgr:pick-model', 'robot:wander', 'robot:wander-prep', 'walker:init',
  'mgr:state', 'mgr:pick-folder', 'mgr:create', 'mgr:update', 'mgr:delete', 'mgr:visible', 'mgr:reset', 'mgr:settings', 'mgr:pick-claude',
]);
const SEND = new Set(['robot:drag', 'robot:resize', 'robot:click-through', 'robot:walker', 'walker:drag', 'walker:click', 'walker:ready', 'walker:through']);
const LISTEN = new Set([
  'robot:layout', 'robot:cursor', 'robot:event', 'robot:character', 'robot:settings', 'robot:action',
  'mgr:changed', 'mgr:focus', 'walker:state', 'walker:character', 'walker:cursor',
]);

contextBridge.exposeInMainWorld('cbot', {
  // the real path of a file dropped or pasted into the page ('' if it has none, e.g. an image from a browser)
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) throw new Error(`Blocked channel ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, payload) {
    if (!SEND.has(channel)) throw new Error(`Blocked channel ${channel}`);
    ipcRenderer.send(channel, payload);
  },
  on(channel, cb) {
    if (!LISTEN.has(channel)) throw new Error(`Blocked channel ${channel}`);
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
