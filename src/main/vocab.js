const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app } = require('electron');
const { findClaude, cleanEnv } = require('./claude');

// Your English words: captured with a hotkey (capture.js), looked up by Claude
// (the small, quick model) with Vietnamese meanings and examples, and kept in
// <userData>/vocab.json, apart from the robots. Saved the same power-cut-safe
// way as the robots (store.js), with a daily backup next to theirs.
// Each word also carries when you next see it again (review: step, due, seen, right):
// a sleeping robot dreams of it, and the gap grows each time (GAP).

const BACKUPS_KEPT = 14;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Seeing it again, and again, further apart each time: the first dream 30 minutes after you
// save a word, then 2 h, 6 h, a day, 2 days, 4 days, a week, 2 weeks, and a month from then on.
// review.step is how many times you've seen it; review.due when it's next.
const GAP = [30 * MIN, 2 * HOUR, 6 * HOUR, DAY, 2 * DAY, 4 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
const LEARNT_STEP = 6; // seen six times, over most of a week: learnt
const gapAfter = (step) => GAP[Math.min(Math.max(0, step), GAP.length - 1)];
// words saved before (a quiz box): the step they start from
const BOX_TO_STEP = [0, 2, 3, 4, 6, 7, 8];
// a calendar day where you are (the streak goes by your days, not UTC's)
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const LOOKUP_TIMEOUT = 60_000;
const today = () => new Date().toISOString().slice(0, 10);
const norm = (w) => String(w || '').toLowerCase().replace(/[^\p{L}\p{N}' -]/gu, '').replace(/\s+/g, ' ').trim();

const readJson = (file) => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || !Array.isArray(data.words)) throw new Error('not a C-Bot vocabulary file');
  return data;
};

class Vocab {
  constructor() {
    const dir = app.getPath('userData');
    this.file = path.join(dir, 'vocab.json');
    this.backupDir = path.join(dir, 'backups');
    this.data = { words: [] };
    for (const f of [this.file, this.file + '.tmp']) {
      try {
        this.data = readJson(f);
        break;
      } catch {}
    }
    // a lookup that never finished (C-Bot quit): try it again when it's next shown
    for (const w of this.data.words) if (w.status === 'looking') w.status = 'failed';
    // saved with a quiz box: the matching step
    for (const w of this.data.words) {
      if (w.review && w.review.step === undefined) w.review.step = BOX_TO_STEP[w.review.box || 0] ?? 0;
    }
    this._timer = null;
    this._backupDay = null;
  }

  list() {
    return [...this.data.words].sort((a, b) => b.addedAt - a.addedAt);
  }
  get count() {
    return this.data.words.length;
  }
  get(id) {
    return this.data.words.find((w) => w.id === id);
  }
  find(text) {
    const n = norm(text);
    return n ? this.data.words.find((w) => norm(w.word) === n || norm(w.text) === n) : undefined;
  }

  add({ text, context = '', source = '' }) {
    const now = Date.now();
    const word = {
      id: crypto.randomUUID(),
      word: text,
      text, // as captured
      ipa: '',
      senses: [],
      examples: [],
      tip: '',
      context,
      source,
      status: 'looking',
      addedAt: now,
      review: { step: 0, due: now + GAP[0], seen: 0, right: 0 },
    };
    this.data.words.push(word);
    this.markDay();
    this.save();
    return word;
  }

  update(id, patch) {
    const w = this.get(id);
    if (!w) return null;
    Object.assign(w, patch);
    this.save();
    return w;
  }

  // ------------------------------------------------ seeing them again

  get ready() {
    return this.data.words.filter((w) => w.status === 'ready' && w.senses?.length);
  }

  /**
   * The word to dream of now: the most overdue one (a tie: the newer word), never `not`
   * (the last one shown). Null when none is due yet.
   */
  nextDream(now = Date.now(), { not = '' } = {}) {
    const due = this.ready.filter((w) => (w.review?.due ?? 0) <= now && w.id !== not);
    due.sort((a, b) => (a.review?.due ?? 0) - (b.review?.due ?? 0) || b.addedAt - a.addedAt);
    return due[0] || null;
  }
  // (a quiz you asked for: the most overdue word, whatever was last)
  nextDue(now = Date.now()) {
    return this.nextDream(now);
  }

  // a new review state from `step`: when it's next, from now
  _stepTo(w, step, extra = {}) {
    const now = Date.now();
    const r = { step: 0, seen: 0, right: 0, ...w.review, ...extra, step: Math.max(0, step), last: now };
    r.due = now + gapAfter(r.step);
    this.markDay();
    return this.update(w.id, { review: r });
  }

  /** It was just shown in a dream: one more time seen, and the next one further off. */
  dreamt(id) {
    const w = this.get(id);
    return w ? this._stepTo(w, (w.review?.step || 0) + 1, { dreamtAt: Date.now() }) : null;
  }

  /** "I know this one": it skips two steps ahead (so it comes back much later). */
  knowIt(id) {
    const w = this.get(id);
    return w ? this._stepTo(w, (w.review?.step || 0) + 2, { right: (w.review?.right || 0) + 1 }) : null;
  }

  /** A quiz you asked for: knew it, a step ahead; forgot, back to the start (30 minutes). */
  answer(id, knew) {
    const w = this.get(id);
    if (!w) return null;
    const r = w.review || {};
    return this._stepTo(w, knew ? (r.step || 0) + 1 : 0, { seen: (r.seen || 0) + 1, right: (r.right || 0) + (knew ? 1 : 0) });
  }

  /** Not now (a quiz put off or left): it comes back after `wait`, its step unchanged. */
  later(id, wait) {
    const w = this.get(id);
    return w ? this.update(id, { review: { ...w.review, due: Date.now() + wait } }) : null;
  }

  /** You met it again (caught it once more): it clearly still matters, back to "2 hours". */
  seenAgain(id) {
    const w = this.get(id);
    if (!w) return null;
    const due = Math.min(w.review?.due ?? Infinity, Date.now() + gapAfter(1));
    return this.update(id, { review: { ...w.review, step: Math.min(w.review?.step ?? 1, 1), due }, lastSeenAt: Date.now() });
  }

  /** The words to keep in sight (sticky notes, the monitor, sleep talk): the ones seen least first, newest first. */
  inSight(n = 6) {
    return [...this.ready].sort((a, b) => (a.review?.step ?? 0) - (b.review?.step ?? 0) || b.addedAt - a.addedAt).slice(0, n);
  }

  // the days you caught or reviewed a word (for the streak), the last few months
  markDay(day = localDay()) {
    const days = (this.data.days ||= []);
    if (days[days.length - 1] !== day) days.push(day);
    if (days.length > 400) days.splice(0, days.length - 400);
  }

  /** How it's going: words, learnt (seen LEARNT_STEP times), due now, the streak of days in a row. */
  stats(now = Date.now()) {
    const ready = this.ready;
    const days = new Set(this.data.days || []);
    let streak = 0;
    const d = new Date(now);
    if (!days.has(localDay(d))) d.setDate(d.getDate() - 1); // today not done yet: the streak still counts to yesterday
    while (days.has(localDay(d))) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return {
      total: this.count,
      learnt: ready.filter((w) => (w.review?.step || 0) >= LEARNT_STEP).length,
      learning: ready.filter((w) => (w.review?.step || 0) < LEARNT_STEP).length,
      due: ready.filter((w) => (w.review?.due || 0) <= now).length,
      reviewed: ready.reduce((n, w) => n + (w.review?.seen || 0), 0),
      streak,
      today: days.has(localDay(new Date(now))),
    };
  }

  remove(id) {
    const before = this.data.words.length;
    this.data.words = this.data.words.filter((w) => w.id !== id);
    if (this.data.words.length !== before) this.save();
    return before !== this.data.words.length;
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
      console.error('[vocab] save failed:', err);
    }
  }

  // one copy a day, the last two weeks kept
  _backup() {
    const day = today();
    if (this._backupDay === day || !this.data.words.length) return;
    this._backupDay = day;
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const target = path.join(this.backupDir, `vocab-${day}.json`);
      if (!fs.existsSync(target)) writeSafely(target, JSON.stringify(this.data, null, 2));
      const old = fs.readdirSync(this.backupDir).filter((f) => /^vocab-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(BACKUPS_KEPT);
      for (const f of old) fs.rmSync(path.join(this.backupDir, f), { force: true });
    } catch (err) {
      console.warn('[vocab] backup failed:', err.message);
    }
  }
}

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

// ---------------------------------------------------------------- lookup

const SCHEMA = {
  type: 'object',
  properties: {
    word: { type: 'string', description: 'the dictionary form (lemma) of the word or phrase' },
    ipa: { type: 'string', description: 'US IPA, e.g. /məˈtɪkjələs/' },
    senses: {
      type: 'array',
      description: 'meanings, the one that fits the context first; at most 3',
      items: {
        type: 'object',
        properties: {
          pos: { type: 'string', description: 'noun, verb, adj, adv, phrase, idiom…' },
          vi: { type: 'string', description: 'the Vietnamese meaning' },
          en: { type: 'string', description: 'a short English definition' },
        },
        required: ['pos', 'vi', 'en'],
      },
    },
    phrases: {
      type: 'array',
      description: 'the 4-5 most common phrases / collocations the word is used in (the meaning used first), each with a natural everyday example sentence',
      items: {
        type: 'object',
        properties: {
          phrase: { type: 'string', description: 'e.g. "meticulous attention to detail", "be meticulous about something"' },
          vi: { type: 'string', description: 'its Vietnamese meaning' },
          example: { type: 'string', description: 'an English sentence using exactly this phrase' },
          exampleVi: { type: 'string', description: 'the Vietnamese translation of that sentence' },
        },
        required: ['phrase', 'vi', 'example', 'exampleVi'],
      },
    },
    verbForms: {
      type: 'object',
      description: 'if the word is (or can be) a verb, including a phrasal verb: all its forms; otherwise every field empty and irregular false',
      properties: {
        base: { type: 'string', description: 'go, tackle, give up' },
        third: { type: 'string', description: 'he/she/it form: goes, tackles, gives up' },
        past: { type: 'string', description: 'past simple: went, tackled, gave up (both if two are common: dreamed / dreamt)' },
        participle: { type: 'string', description: 'past participle: gone, tackled, given up' },
        ing: { type: 'string', description: 'present participle: going, tackling, giving up' },
        irregular: { type: 'boolean', description: 'true if the past or past participle is not just -ed' },
      },
      required: ['base', 'third', 'past', 'participle', 'ing', 'irregular'],
    },
    tip: { type: 'string', description: 'one short usage tip in Vietnamese (a common mistake, a confusable word), or empty' },
    synonyms: {
      type: 'array',
      description: 'up to 5 words with the same meaning (the sense used), closest first',
      items: {
        type: 'object',
        properties: {
          word: { type: 'string' },
          vi: { type: 'string', description: 'its Vietnamese meaning' },
          note: { type: 'string', description: 'in Vietnamese, short: how it differs (stronger, more formal, only for people…) and when to prefer it' },
        },
        required: ['word', 'vi', 'note'],
      },
    },
    antonyms: {
      type: 'array',
      description: 'up to 4 words with the opposite meaning (the sense used); empty if there are none',
      items: {
        type: 'object',
        properties: { word: { type: 'string' }, vi: { type: 'string' }, note: { type: 'string', description: 'in Vietnamese, short: when it is used' } },
        required: ['word', 'vi', 'note'],
      },
    },
    family: {
      type: 'array',
      description: 'the other words built on the same stem (noun, verb, adjective, adverb, un-/in-/dis- forms of it), not the word itself; empty if none',
      items: {
        type: 'object',
        properties: {
          word: { type: 'string' },
          pos: { type: 'string', description: 'noun, verb, adj, adv…' },
          vi: { type: 'string' },
          example: { type: 'string', description: 'a short English example using it' },
        },
        required: ['word', 'pos', 'vi', 'example'],
      },
    },
  },
  required: ['word', 'ipa', 'senses', 'phrases', 'verbForms', 'tip', 'synonyms', 'antonyms', 'family'],
};

const SYSTEM =
  'You are an English–Vietnamese learner\'s dictionary. The user is a Vietnamese speaker learning English and wants to use words the way native speakers do. ' +
  'For the word or phrase given, reply with its dictionary form, US IPA, its meanings (Vietnamese meaning and a short English definition; ' +
  'when a context sentence is given, the meaning used there comes first), all its verb forms if it can be a verb, and one short usage tip in Vietnamese. ' +
  'Focus on how the word is really used: give the most common phrases and collocations it appears in, each with a natural, everyday example sentence using that phrase and its Vietnamese translation. ' +
  'Synonyms and antonyms must fit the meaning used (the first meaning), each with a short Vietnamese note on how it differs in nuance, strength or register. ' +
  'The word family lists only the other forms built on the same English stem (diligent: diligence, diligently; happy: happiness, happily, unhappy), each with a short example; ' +
  'no words from a different stem, even if related in meaning (those belong in synonyms or antonyms). ' +
  'Only real, common English words. If the text is not English, still explain it as best you can.';

const str = (v, max = 400) => String(v || '').slice(0, max);
// a verb's five forms, or null when it isn't a verb
function verbForms(v) {
  const f = { base: str(v?.base, 60), third: str(v?.third, 60), past: str(v?.past, 60), participle: str(v?.participle, 60), ing: str(v?.ing, 60) };
  return f.base && f.past ? { ...f, irregular: !!v.irregular } : null;
}
const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);

// Ask Claude Code's quick model one question and get its structured answer.
// Streamed in and out, so the answer is read the moment it's ready: waiting for
// the process to exit instead costs a few seconds of shutdown every time.
// content: the user message (a string, or content blocks such as an image).
function askHaiku(exe, { schema, system, content }) {
  const args = [
    '-p', '--model', 'haiku', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(schema), '--system-prompt', system,
    '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: os.tmpdir(), env: cleanEnv(), windowsHide: true, shell: /\.cmd$/i.test(exe) });
    let buf = '';
    let err = '';
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end(); // it's answered: let it go (it shuts down by itself)
      fn(v);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error('Claude Code took too long'));
      child.kill();
    }, LOOKUP_TIMEOUT);
    child.stdin.on('error', () => {}); // (it may already be gone)
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.type !== 'result') continue;
        if (m.is_error || !m.structured_output) finish(reject, new Error(String(m.result || 'nothing came back').slice(0, 200)));
        else finish(resolve, m.structured_output);
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => finish(reject, new Error(`Claude Code stopped (${code}): ${err.slice(0, 200) || 'no answer'}`)));
  });
}

// The lookup comes in two parts, asked at the same time: the meaning (small, so
// it's back in a couple of seconds and the card can show it) and the extras
// (phrases, verb forms, synonyms, word family: most of the writing, so slower).
const part = (keys) => ({ type: 'object', properties: Object.fromEntries(keys.map((k) => [k, SCHEMA.properties[k]])), required: keys });
const CORE_SCHEMA = part(['word', 'ipa', 'senses']);
const EXTRAS_SCHEMA = part(['phrases', 'verbForms', 'tip', 'synonyms', 'antonyms', 'family']);
const CORE_SYSTEM =
  'You are an English–Vietnamese learner\'s dictionary for a Vietnamese speaker learning English. ' +
  'For the word or phrase given, reply with its dictionary form, US IPA and its meanings (Vietnamese meaning and a short English definition); ' +
  'when a context sentence is given, the meaning used there comes first. Only real, common English words. If the text is not English, still explain it as best you can.';

/**
 * Look a word up with Claude Code's quick model. Resolves to
 * { word, ipa, senses: [{ pos, vi, en }], phrases: [{ phrase, vi, example, exampleVi }], tip,
 *   verbForms: { base, third, past, participle, ing, irregular } or null,
 *   synonyms / antonyms: [{ word, vi, note }], family: [{ word, pos, vi, example }] }; rejects on failure.
 * onCore(meaning) is called as soon as the meaning is in ({ word, ipa, senses }), before the rest.
 * If only the extras fail, it still resolves, with the meaning and empty extras (and extrasError).
 */
function lookup(text, { context = '', claudePath = '', onCore = null } = {}) {
  const exe = findClaude(claudePath);
  if (!exe) return Promise.reject(new Error("Claude Code isn't installed"));
  const prompt = `Word or phrase: "${text}"${context && context !== text ? `\nFound in: "${context.slice(0, 400)}"` : ''}`;
  const core = askHaiku(exe, { schema: CORE_SCHEMA, system: CORE_SYSTEM, content: prompt }).then((r) => {
    if (!r?.senses?.length) throw new Error('no meaning came back');
    const meaning = {
      word: str(r.word || text, 80),
      ipa: str(r.ipa, 80),
      senses: list(r.senses, 3).map((s) => ({ pos: str(s.pos, 30), vi: str(s.vi), en: str(s.en) })),
    };
    onCore?.(meaning);
    return meaning;
  });
  const extras = askHaiku(exe, { schema: EXTRAS_SCHEMA, system: SYSTEM, content: prompt }).then(
    (r) => ({ r }),
    (e) => ({ r: {}, error: e.message })
  );
  core.catch(() => {}); // (awaited below; this just keeps an early failure from going unhandled)
  return Promise.all([core, extras]).then(([meaning, { r, error }]) => {
    const like = (x) => ({ word: str(x.word, 80), vi: str(x.vi), note: str(x.note) });
    const itself = (w) => norm(w) === norm(meaning.word); // the family sometimes lists the word itself
    return {
      ...meaning,
      phrases: list(r.phrases, 6)
        .map((p) => ({ phrase: str(p.phrase, 80), vi: str(p.vi, 200), example: str(p.example), exampleVi: str(p.exampleVi) }))
        .filter((p) => p.phrase),
      verbForms: verbForms(r.verbForms),
      examples: [], // (older words had separate examples; the phrases' examples take their place)
      usage: undefined, // (and a "how formal / where you meet it" box, dropped)
      tip: str(r.tip),
      // (none at all if the extras failed: the card then offers to look it up again, as for older words)
      synonyms: error ? undefined : list(r.synonyms, 6).map(like).filter((x) => x.word),
      antonyms: list(r.antonyms, 5).map(like).filter((x) => x.word),
      family: list(r.family, 8).map((f) => ({ word: str(f.word, 80), pos: str(f.pos, 30), vi: str(f.vi), example: str(f.example) })).filter((f) => f.word && !itself(f.word)),
      ...(error ? { extrasError: error } : {}),
    };
  });
}

// ---------------------------------------------------------------- reading a picture

const READ_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'the English word or short phrase they boxed, as written (empty if there is none)' },
    sentence: { type: 'string', description: 'the sentence it is in, if one is visible; else empty' },
  },
  required: ['text', 'sentence'],
};
const READ_SYSTEM =
  'You read text in pictures. The user boxed a bit of their screen round an English word or short phrase they want to learn. ' +
  'Reply with that word or phrase (the main one, the one most in the middle if there are several) and the sentence it is in when one is visible.';

/** The word in a cut-out of the screen (a PNG): resolves to { text, sentence }; rejects on failure. */
function readPicture(png, { claudePath = '' } = {}) {
  const exe = findClaude(claudePath);
  if (!exe) return Promise.reject(new Error("Claude Code isn't installed"));
  // the picture goes in as an image in the first message
  const content = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
    { type: 'text', text: 'Which word or phrase did I box?' },
  ];
  return askHaiku(exe, { schema: READ_SCHEMA, system: READ_SYSTEM, content }).then((r) => ({ text: str(r.text, 80).trim(), sentence: str(r.sentence, 400).trim() }));
}

module.exports = { Vocab, lookup, readPicture, norm, GAP, LEARNT_STEP, MIN, HOUR, DAY };
