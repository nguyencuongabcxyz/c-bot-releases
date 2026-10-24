const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, powerMonitor } = require('electron');

// Your notes: one notebook shared by all your robots, kept in <userData>/notes.json
// (saved the power-cut-safe way, with a daily backup, like vocab.json). Each note is
// { id, text, important, createdAt, doneAt, source, working }: unfinished ones carry over
// from day to day until you tick them off; done ones are kept DONE_KEPT_DAYS, then cleared.
//
// And the daily reminders (createNoteReminders): at the end of your workday about today's
// notes, and the first time you're at the PC on a workday about what you noted since your
// last one. Each once a day, only while you're actually there, and they can be put off.

const BACKUPS_KEPT = 14;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const DONE_KEPT_DAYS = 30;
const MAX_LEN = 2000;
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const readJson = (file) => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || !Array.isArray(data.notes)) throw new Error('not a C-Bot notes file');
  return data;
};

function writeSafely(file, text) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

class Notes {
  constructor(dir = app.getPath('userData')) {
    this.file = path.join(dir, 'notes.json');
    this.backupDir = path.join(dir, 'backups');
    this.data = { notes: [], reminded: {} };
    for (const f of [this.file, this.file + '.tmp']) {
      try {
        this.data = { reminded: {}, ...readJson(f) };
        break;
      } catch {}
    }
    // Claude can't still be on a note after a restart
    for (const n of this.data.notes) delete n.working;
    this._timer = null;
    this._backupDay = null;
    this._listeners = new Set();
    this.purge();
  }

  /** Every note, newest first. */
  list() {
    return [...this.data.notes].sort((a, b) => b.createdAt - a.createdAt);
  }
  get(id) {
    return this.data.notes.find((n) => n.id === id) || null;
  }
  /** The ones still to do: important first, then oldest first (they've waited longest). */
  open() {
    return this.data.notes.filter((n) => !n.doneAt).sort((a, b) => (b.important ? 1 : 0) - (a.important ? 1 : 0) || a.createdAt - b.createdAt);
  }

  /** A new note. A leading "!" marks it important. Returns it, or null if it's empty. */
  add({ text, important = false, source = '' } = {}) {
    let t = String(text || '').replace(/\r\n/g, '\n').trim();
    if (t.startsWith('!')) {
      important = true;
      t = t.replace(/^!+\s*/, '');
    }
    if (!t) return null;
    const note = { id: crypto.randomUUID(), text: t.slice(0, MAX_LEN), important: !!important, createdAt: Date.now(), doneAt: null, source: String(source || '').slice(0, 120) };
    this.data.notes.push(note);
    this._changed({ added: note });
    return note;
  }

  update(id, patch = {}) {
    const n = this.get(id);
    if (!n) return null;
    if (typeof patch.text === 'string') {
      const t = patch.text.replace(/\r\n/g, '\n').trim();
      if (t) n.text = t.slice(0, MAX_LEN);
    }
    if (typeof patch.important === 'boolean') n.important = patch.important;
    if (typeof patch.working === 'boolean') {
      if (patch.working) n.working = true;
      else delete n.working;
    }
    this._changed({ updated: n });
    return n;
  }

  /** Ticked off (or back to do). */
  setDone(id, done = true) {
    const n = this.get(id);
    if (!n || !!n.doneAt === !!done) return n;
    n.doneAt = done ? Date.now() : null;
    delete n.working;
    this._changed(done ? { done: n } : { undone: n });
    return n;
  }

  /** Gone (the notebook offers Undo: restore() puts it back as it was). */
  remove(id) {
    const i = this.data.notes.findIndex((n) => n.id === id);
    if (i < 0) return null;
    const [n] = this.data.notes.splice(i, 1);
    this._changed({ removed: n });
    return n;
  }
  restore(note) {
    if (!note?.id || this.get(note.id)) return null;
    this.data.notes.push(note);
    this._changed({ restored: note });
    return note;
  }

  clearDone() {
    const before = this.data.notes.length;
    this.data.notes = this.data.notes.filter((n) => !n.doneAt);
    if (this.data.notes.length !== before) this._changed({ cleared: true });
  }

  /** Done notes older than a month go (quietly, on start). */
  purge(now = Date.now()) {
    const before = this.data.notes.length;
    this.data.notes = this.data.notes.filter((n) => !n.doneAt || now - n.doneAt < DONE_KEPT_DAYS * DAY);
    if (this.data.notes.length !== before) this.save();
  }

  /** Days a note has been open (calendar days, where you are). */
  static age(n, now = new Date()) {
    return Math.max(0, Math.round((startOfDay(now) - startOfDay(new Date(n.createdAt))) / DAY));
  }

  /** What the desk's corkboard shows: up to `max` open notes and how many in all. */
  board(max = 5, now = new Date()) {
    const open = this.open();
    // important first, then the newest (what you just jotted down is what you want to see)
    const shown = [...open].sort((a, b) => (b.important ? 1 : 0) - (a.important ? 1 : 0) || b.createdAt - a.createdAt).slice(0, max);
    return { items: shown.map((n) => ({ id: n.id, text: n.text, important: !!n.important, age: Notes.age(n, now), working: !!n.working })), total: open.length };
  }

  /** Taken on or after `since` (ms). */
  takenSince(since) {
    return this.data.notes.filter((n) => n.createdAt >= since);
  }

  /** The reminders' bookkeeping (which day each last went off), saved with the notes. */
  reminded(kind) {
    return this.data.reminded?.[kind] || '';
  }
  markReminded(kind, day) {
    this.data.reminded = { ...this.data.reminded, [kind]: day };
    this.save();
  }

  /** Called with { added | updated | done | undone | removed | restored | cleared } after each change. */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  _changed(what) {
    this.save();
    for (const fn of this._listeners) {
      try {
        fn(what);
      } catch (err) {
        console.error('[notes] listener failed:', err);
      }
    }
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeSafely(this.file, JSON.stringify(this.data, null, 2));
      this._backup();
    } catch (err) {
      console.error('[notes] save failed:', err);
    }
  }

  // one copy a day, the last two weeks kept (next to the robots' and the vocabulary's)
  _backup() {
    const day = localDay();
    if (this._backupDay === day || !this.data.notes.length) return;
    this._backupDay = day;
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const target = path.join(this.backupDir, `notes-${day}.json`);
      if (!fs.existsSync(target)) writeSafely(target, JSON.stringify(this.data, null, 2));
      const old = fs.readdirSync(this.backupDir).filter((f) => /^notes-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(BACKUPS_KEPT);
      for (const f of old) fs.rmSync(path.join(this.backupDir, f), { force: true });
    } catch (err) {
      console.warn('[notes] backup failed:', err.message);
    }
  }
}

// ---------------------------------------------------------------- the daily reminders

// (notesCarry: the morning one lists every note still open, not just the ones from last workday)
const DEFAULTS = { notesReminders: true, notesEvening: '17:30', notesMorning: true, notesWorkdays: [1, 2, 3, 4, 5], notesCarry: true };
const AWAY_AFTER = 120; // s without touching mouse or keyboard: you're not there
const MORNING_FROM = 6; // a "start of day" reminder only from 6 am…
const EVENING_UNTIL = 22; // …and the end-of-day one no later than 10 pm (missed it: the morning covers it)

/** "17:30" -> minutes after midnight (bad input: the default). */
function minutesOf(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
  if (!m || +m[1] > 23 || +m[2] > 59) return 17 * 60 + 30;
  return +m[1] * 60 + +m[2];
}

/**
 * Checks once a minute (and whenever you come back to the PC) whether a reminder is due.
 *   notes      the Notes
 *   settings   () => the app settings (notesReminders, notesEvening "HH:MM", notesMorning, notesWorkdays [0-6])
 *   remind     (kind, info) => bool   shows it: 'morning' | 'evening', info { notes, today, open, since };
 *              false if it couldn't be shown right now (it's tried again on the next check)
 *   now, present   for tests: the clock, and "is the user at the PC?"
 */
function createNoteReminders({ notes, settings, remind, now = () => new Date(), present: isPresent } = {}) {
  let locked = false;
  let pending = null; // put off: { kind, at }
  const cfg = () => ({ ...DEFAULTS, ...Object.fromEntries(Object.entries(settings() || {}).filter(([k, v]) => k in DEFAULTS && v !== undefined)) });
  const present = isPresent || (() => !locked && powerMonitor.getSystemIdleTime() < AWAY_AFTER);

  // your last workday before `d` (yesterday, or Friday on a Monday), as the time it started
  function lastWorkdayStart(d, days) {
    for (let i = 1; i <= 7; i++) {
      const p = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
      if (days.includes(p.getDay())) return p.getTime();
    }
    return startOfDay(d) - DAY;
  }

  /** What a reminder of this kind would list, at time d. */
  function gather(kind, d = now()) {
    const c = cfg();
    const open = notes.open();
    const since = kind === 'morning' ? lastWorkdayStart(d, c.notesWorkdays) : startOfDay(d);
    const taken = notes.takenSince(since).filter((n) => (kind === 'morning' ? n.createdAt < startOfDay(d) : true));
    const ids = new Set([...(kind === 'morning' && !c.notesCarry ? [] : open), ...taken].map((n) => n.id));
    const list = notes.list().filter((n) => ids.has(n.id));
    return { kind, notes: list, open: open.length, today: notes.takenSince(startOfDay(d)).length, taken: taken.length, since };
  }

  function fire(kind, d) {
    const info = gather(kind, d);
    if (!info.notes.length) return true; // nothing to say: counts as done for today
    return remind(kind, info) !== false;
  }

  function check() {
    const d = now();
    const c = cfg();
    if (!c.notesReminders) return null;
    if (!present()) return null;
    // put off with "remind me later"
    if (pending) {
      if (d.getTime() < pending.at) return null;
      const { kind } = pending;
      pending = null;
      return fire(kind, d) ? kind : null;
    }
    if (!c.notesWorkdays.includes(d.getDay())) return null;
    const day = localDay(d);
    const mins = d.getHours() * 60 + d.getMinutes();
    const evening = minutesOf(c.notesEvening);
    // end of the day first: if it's already past it, the morning one has had its chance
    if (mins >= evening && d.getHours() < EVENING_UNTIL && notes.reminded('evening') !== day) {
      if (!fire('evening', d)) return null;
      notes.markReminded('evening', day);
      notes.markReminded('morning', day);
      return 'evening';
    }
    if (c.notesMorning && d.getHours() >= MORNING_FROM && mins < evening && notes.reminded('morning') !== day) {
      if (!fire('morning', d)) return null;
      notes.markReminded('morning', day);
      return 'morning';
    }
    return null;
  }

  const timer = setInterval(check, MIN);
  timer.unref?.();
  // back at the PC: maybe the start of your day
  const soon = () => setTimeout(check, 4000);
  powerMonitor.on('lock-screen', () => (locked = true));
  powerMonitor.on('unlock-screen', () => {
    locked = false;
    soon();
  });
  powerMonitor.on('resume', soon);
  setTimeout(check, 15_000); // and a little after C-Bot starts

  return {
    check,
    gather,
    /** "Remind me in N minutes". */
    snooze(kind, minutes = 15) {
      pending = { kind, at: now().getTime() + minutes * MIN };
    },
    /** "Done for today": nothing more today (the snooze too). */
    doneForToday() {
      pending = null;
      const day = localDay(now());
      notes.markReminded('evening', day);
      notes.markReminded('morning', day);
    },
    /** Show one now, whatever the time (the tray, tests). */
    now(kind = 'evening') {
      return fire(kind, now());
    },
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { Notes, createNoteReminders, localDay, minutesOf, NOTE_DEFAULTS: DEFAULTS };
