const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set([
  'robot:init', 'robot:ask', 'robot:cancel', 'robot:expand', 'robot:poke', 'robot:reset', 'robot:open-folder', 'robot:menu',
  'robot:sessions', 'robot:session', 'robot:resume', 'robot:commands', 'robot:inspect-paths', 'robot:save-paste', 'robot:paste-clipboard', 'robot:files', 'robot:answer', 'robot:terminal',
  'robot:tab-new', 'robot:tab-close', 'robot:tab-rename', 'robot:tab-activate', 'robot:tab-reopen',
  'robot:unqueue', 'robot:send-now', 'robot:brain', 'robot:set-brain', 'robot:compact',
  'robot:app-view', 'robot:app-page', 'robot:app-call', 'robot:open-link', 'robot:app-window', 'appview:init', 'robot:open-file',
  'robot:wander', 'robot:wander-prep', 'walker:init',
  'robot:vocab-save', 'robot:tasks', 'robot:vocab-open', 'robot:vocab-quiz', 'robot:vocab-quiz-me', 'robot:vocab-words', 'robot:vocab-dream', 'robot:vocab-box', 'robot:screen-ask', 'palette:init', 'palette:pick', 'palette:close', 'card:init', 'card:act',
  'snip:init', 'snip:done', 'snip:cancel',
  'notes:open', 'notes:add', 'notes:act', 'notes:remind-open', 'notebook:init', 'notebook:act',
  'quick:init', 'quick:run', 'quick:act', 'quick:open-blank',
  'words:list', 'words:open', 'words:delete', 'words:quiz', 'words:export', 'words:settings',
  'mgr:state', 'mgr:pick-folder', 'mgr:create', 'mgr:update', 'mgr:delete', 'mgr:visible', 'mgr:reset', 'mgr:settings', 'mgr:pick-claude', 'mgr:find-claude',
]);
const SEND = new Set(['robot:drag', 'robot:laid-out', 'robot:resize', 'robot:click-through', 'robot:walker', 'walker:drag', 'walker:click', 'walker:ready', 'walker:through', 'card:size', 'quick:size', 'social:report', 'robots:answer', 'palette:size', 'drone:arrived', 'drone:gone']);
const LISTEN = new Set([
  'robot:layout', 'robot:cursor', 'robot:event', 'robot:character', 'robot:settings', 'robot:action',
  'mgr:changed', 'mgr:focus', 'walker:state', 'walker:character', 'walker:cursor', 'walker:dream', 'robot:vocab', 'card:word', 'words:changed',
  'robot:notes', 'notebook:notes', 'notebook:open', 'theme:changed', 'robot:screen', 'palette:open', 'drone:cmd', 'robot:palette',
  'quick:open', 'quick:text', 'robot:quick',
  'robot:social', 'walker:say', 'plane:pose', 'robot:link', 'robot:tasks', 'robot:hush',
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
  // the look the user picked, { theme, mode }: read at once (ui/theme.js sets it before the page draws)
  theme() {
    return ipcRenderer.sendSync('theme:get');
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
