const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { automaticNote } = require('./sessions');

const HISTORY_LIMIT = 60;
const MAX_TABS = 8;
const CLOSED_TABS_KEPT = 10; // per robot, for "reopen closed tab"
const BACKUPS_KEPT = 14; // one a day

function newTab(fields = {}) {
  return { id: crypto.randomUUID(), title: '', sessionId: null, history: [], createdAt: Date.now(), ...fields };
}

// A tab's name: what the user called it, or its first question.
function titleFor(tab) {
  if (tab.title) return tab.title;
  const first = (tab.history || []).find((h) => h.role === 'user')?.text || '';
  const t = first.replace(/\s+/g, ' ').trim();
  return t ? (t.length > 28 ? t.slice(0, 27) + '…' : t) : 'New chat';
}

// Robots used to have a single conversation; it becomes their first tab.
function migrate(c) {
  if (!Array.isArray(c.tabs) || !c.tabs.length) {
    c.tabs = [newTab({ sessionId: c.sessionId || null, history: c.history || [] })];
  }
  if (!c.tabs.some((t) => t.id === c.activeTab)) c.activeTab = c.tabs[0].id;
  // Claude Code's own notices (background tasks, other sessions) were once saved as
  // if the user had typed them: show them as notes instead
  for (const t of c.tabs) {
    t.history = (t.history || []).flatMap((h) => {
      if (h.role !== 'user' || !h.text) return [h];
      const note = automaticNote({}, h.text);
      if (note === null) return [h];
      return note ? [{ role: 'note', text: note, at: h.at }] : [];
    });
  }
  delete c.sessionId;
  delete c.history;
  return c;
}

const readJson = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) throw new Error('empty file');
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || !Array.isArray(data.characters)) throw new Error('not a C-Bot file');
  return data;
};
const today = () => new Date().toISOString().slice(0, 10);

// Tiny JSON-file store. Everything lives in <userData>/c-bot.json.
// Saving is power-cut safe: write a temp file, force it to disk, then swap it in.
// A file that can't be read is never overwritten with an empty store: it's set
// aside and the robots come back from the temp file or the newest daily backup.
class Store {
  constructor() {
    const dir = app.getPath('userData');
    this.file = path.join(dir, 'c-bot.json');
    this.backupDir = path.join(dir, 'backups');
    this.data = { characters: [], settings: { muted: false, claudePath: '' } };
    this.recovered = null; // { from, broken } when the robots had to be recovered
    const raw = this._load();
    if (raw) this.data = { ...this.data, ...raw, settings: { ...this.data.settings, ...(raw.settings || {}) } };
    this.data.characters.forEach(migrate);
    // robot sounds: 'essential' | 'all' | 'off' (it was a mute checkbox: muted is off, else essential)
    if (!['essential', 'all', 'off'].includes(this.data.settings.sounds)) this.data.settings.sounds = this.data.settings.muted ? 'off' : 'essential';
    this._timer = null;
    this._backupDay = null;
    if (raw) this._backup();
  }

  _load() {
    if (!fs.existsSync(this.file)) {
      // first run, or a save was cut off between writing the temp file and swapping it in
      try {
        return readJson(this.file + '.tmp');
      } catch {
        return null;
      }
    }
    try {
      return readJson(this.file);
    } catch (err) {
      const broken = `${this.file.replace(/\.json$/, '')}.broken-${Date.now()}.json`;
      try {
        fs.renameSync(this.file, broken);
      } catch {}
      for (const candidate of [this.file + '.tmp', ...this._backups()]) {
        try {
          const data = readJson(candidate);
          this.recovered = { from: candidate, broken, error: err.message };
          console.warn(`[store] ${this.file} was unreadable (${err.message}); recovered from ${candidate}`);
          return data;
        } catch {}
      }
      this.recovered = { from: null, broken, error: err.message };
      return null;
    }
  }

  // newest first
  _backups() {
    try {
      return fs
        .readdirSync(this.backupDir)
        .filter((f) => /^c-bot-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort()
        .reverse()
        .map((f) => path.join(this.backupDir, f));
    } catch {
      return [];
    }
  }

  // one copy of the robots a day, the last two weeks kept
  _backup() {
    const day = today();
    if (this._backupDay === day) return;
    this._backupDay = day;
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const target = path.join(this.backupDir, `c-bot-${day}.json`);
      if (!fs.existsSync(target) && this.data.characters.length) this._writeSafely(target, JSON.stringify(this.data, null, 2));
      for (const old of this._backups().slice(BACKUPS_KEPT)) fs.rmSync(old, { force: true });
    } catch (err) {
      console.warn('[store] backup failed:', err.message);
    }
  }

  _writeSafely(file, text) {
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd); // on disk before it replaces the old file, so a power cut can't leave it empty
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this._writeSafely(this.file, JSON.stringify(this.data, null, 2));
    this._backup(); // a new day while the app kept running
  }

  get pending() {
    return !!this._timer;
  }

  get settings() {
    return this.data.settings;
  }

  updateSettings(patch) {
    Object.assign(this.data.settings, patch);
    this.save();
    return this.data.settings;
  }

  list() {
    return this.data.characters;
  }

  get(id) {
    return this.data.characters.find((c) => c.id === id);
  }

  create(fields) {
    const first = newTab();
    const character = {
      id: crypto.randomUUID(),
      name: 'Robo',
      folder: '',
      personality: 'cheerful',
      color: '#5ac8fa',
      permissionMode: 'default',
      model: '',
      tabs: [first],
      activeTab: first.id,
      visible: true,
      position: null,
      stats: { questions: 0, pokes: 0, costUsd: 0 },
      createdAt: Date.now(),
      ...fields,
    };
    this.data.characters.push(character);
    this.save();
    return character;
  }

  update(id, patch) {
    const c = this.get(id);
    if (!c) return null;
    Object.assign(c, patch);
    this.save();
    return c;
  }

  remove(id) {
    this.data.characters = this.data.characters.filter((c) => c.id !== id);
    this.save();
  }

  // ---------------------------------------------------------------- tabs

  tab(id, tabId) {
    return this.get(id)?.tabs.find((t) => t.id === tabId) || null;
  }

  addTab(id, fields) {
    const c = this.get(id);
    if (!c || c.tabs.length >= MAX_TABS) return null;
    const tab = newTab(fields);
    c.tabs.push(tab);
    c.activeTab = tab.id;
    this.save();
    return tab;
  }

  removeTab(id, tabId) {
    const c = this.get(id);
    if (!c) return;
    const i = c.tabs.findIndex((t) => t.id === tabId);
    if (i < 0) return;
    const [closed] = c.tabs.splice(i, 1);
    // a tab with a conversation in it can be reopened (Ctrl+Shift+T)
    if (closed.history?.length || closed.sessionId) {
      c.closedTabs = [...(c.closedTabs || []).filter((t) => t.id !== closed.id), { ...closed, closedAt: Date.now() }].slice(-CLOSED_TABS_KEPT);
    }
    if (!c.tabs.length) c.tabs.push(newTab());
    if (c.activeTab === tabId) c.activeTab = c.tabs[Math.min(i, c.tabs.length - 1)].id;
    this.save();
  }

  /** Bring back the most recently closed tab (or the one with this id). */
  reopenTab(id, tabId) {
    const c = this.get(id);
    const closed = c?.closedTabs || [];
    const i = tabId ? closed.findIndex((t) => t.id === tabId) : closed.length - 1;
    if (!c || i < 0) return null;
    // an empty "New chat" tab makes room for it
    const blank = c.tabs.find((t) => !t.history.length && !t.sessionId && !t.title);
    if (c.tabs.length >= MAX_TABS && !blank) return null;
    const [{ closedAt, ...tab }] = closed.splice(i, 1);
    if (blank && c.tabs.length >= MAX_TABS) c.tabs = c.tabs.filter((t) => t !== blank);
    else if (blank && c.tabs.length === 1) c.tabs = []; // the lone empty tab left behind by closing the last one
    c.tabs.push(tab);
    c.activeTab = tab.id;
    c.closedTabs = closed;
    this.save();
    return tab;
  }

  updateTab(id, tabId, patch) {
    const tab = this.tab(id, tabId);
    if (!tab) return null;
    Object.assign(tab, patch);
    this.save();
    return tab;
  }

  pushHistory(id, tabId, entry) {
    const tab = this.tab(id, tabId);
    if (!tab) return;
    tab.history.push({ ...entry, at: Date.now() });
    if (tab.history.length > HISTORY_LIMIT) tab.history.splice(0, tab.history.length - HISTORY_LIMIT);
    this.save();
  }

  // every session this robot has started, to label them in "past conversations"
  rememberSession(id, sessionId) {
    const c = this.get(id);
    if (!c || !sessionId) return;
    const ids = c.sessionIds || [];
    if (!ids.includes(sessionId)) c.sessionIds = [...ids, sessionId].slice(-200);
    this.save();
  }
}

module.exports = { Store, titleFor, MAX_TABS };
