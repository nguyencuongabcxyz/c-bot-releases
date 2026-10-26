const { powerMonitor } = require('electron');

// Seeing your words again: now and then during your working hours a sleeping robot
// dreams of one that's due (vocab.js keeps when each comes back), and a dream bubble
// shows it with its meaning and an example. Only while you're at the PC: not while it's
// locked or you're away, and not while Windows says you're busy (presenting, a fullscreen
// game or video, Focus). A word that's due waits for the next robot that dozes off.
//   createReminders({ vocab, settings, dream, quiz })
//       dream(word) shows it from a sleeping robot (false if none is asleep)
//       quiz(word, opts) a quiz you asked for (false if no robot is free)
//   .quizNow()   a quiz straight away (the tray, a robot's menu, the My words window)
//   .done()      the quiz was answered, put off or ignored

const MIN = 60_000;
const TICK = MIN / 2;
const DREAM_GAP = 20 * MIN; // at most one dream this often
const DREAMS_A_DAY = 12;
const AWAY_AFTER = 120; // s without touching mouse or keyboard

// QUERY_USER_NOTIFICATION_STATE: 5 = QUNS_ACCEPTS_NOTIFICATIONS (anything else: busy, presenting, away…)
let shell32;
function acceptsNotifications() {
  const state = notificationState();
  return state === 5 || state === 0;
}

// a full-screen app (2), a full-screen game (3) or presentation mode (4) has the screen
function presenting() {
  return [2, 3, 4].includes(notificationState());
}

// Windows' SHQueryUserNotificationState (QUNS_*), or 0 when it can't tell
function notificationState() {
  if (process.platform !== 'win32') return 0;
  try {
    if (shell32 === undefined) {
      const koffi = require('koffi');
      const lib = koffi.load('shell32.dll');
      shell32 = { state: lib.func('long __stdcall SHQueryUserNotificationState(_Out_ int *pquns)') };
    }
    if (!shell32) return 0;
    const out = [0];
    return shell32.state(out) !== 0 ? 0 : out[0];
  } catch {
    shell32 = null;
    return 0;
  }
}

const today = () => new Date().toDateString();

function createReminders({ vocab, settings, dream, quiz }) {
  let locked = false;
  let open = false; // a quiz you asked for is showing
  let lastDreamAt = Date.now() - DREAM_GAP + 3 * MIN; // the first one a few minutes after C-Bot starts
  let lastWord = '';
  let day = today();
  let dreamsToday = 0;
  powerMonitor.on('lock-screen', () => (locked = true));
  powerMonitor.on('unlock-screen', () => (locked = false));

  const enabled = () => settings().vocabReminders !== false;
  function inHours(d = new Date()) {
    const [from, to] = settings().vocabHours || [9, 18];
    const h = d.getHours() + d.getMinutes() / 60;
    return h >= from && h < to;
  }
  const present = () => !locked && powerMonitor.getSystemIdleTime() < AWAY_AFTER && acceptsNotifications();

  function tick() {
    if (day !== today()) {
      day = today();
      dreamsToday = 0;
    }
    if (!enabled() || open || dreamsToday >= DREAMS_A_DAY || Date.now() - lastDreamAt < DREAM_GAP || !inHours() || !present()) return;
    const word = vocab.nextDream(Date.now(), { not: lastWord });
    if (!word || !dream(word)) return; // nothing due, or no robot asleep: look again soon
    lastDreamAt = Date.now();
    lastWord = word.id;
    dreamsToday++;
  }
  setInterval(tick, TICK).unref?.();

  return {
    // straight away: a due word, or else one you've seen least
    quizNow() {
      const word = vocab.nextDue() || vocab.inSight(3).sort(() => Math.random() - 0.5)[0];
      if (!word) return false;
      const ok = quiz(word, { asked: true });
      if (ok) open = true;
      return ok;
    },
    done() {
      open = false;
    },
    get open() {
      return open;
    },
  };
}

module.exports = { createReminders, acceptsNotifications, presenting };
