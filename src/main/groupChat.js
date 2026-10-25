const { BrowserWindow, ipcMain, screen, clipboard } = require('electron');
const path = require('path');
const crypto = require('crypto');
const { ClaudeSession, findClaude } = require('./claude');
const { createMeetingRoom } = require('./meeting');

// The robot group chat: you pick a topic and some robots, and they talk it over together, each
// in its own personality and from what it knows of its own folder, until they've nothing more
// to add, agree, reach the limit or you wrap it up; then the host sums it up. A window of its
// own (renderer/groupchat, with its own small preload) shows it live, and you can chime in.
// Two styles:
//   free   (the default) like people in a chat app: every robot sees every message as it's
//          posted and decides for itself whether to reply or stay quiet (<pass/>). Several can
//          be typing at once; a message is posted when it's finished, so they can cross. A
//          robot that finishes catches up on what came in meanwhile and decides again. It ends
//          when nobody has more to add (everyone's quiet), at the message limit, the cost cap,
//          or when you wrap it up.
//   turns  one at a time: a round is every robot speaking once, the host first. Next up is
//          whoever was last @-mentioned among those who haven't spoken this round, else the next
//          in order. It ends after the last round, when every robot ends its message with
//          <agree/> in the same round, at the cost cap, or when you wrap it up.
// In both, a robot you @-mention answers you next (free: it's told it was asked).
// Each robot speaks from a Claude Code conversation of its own for the chat, in its folder,
// with its personality and the chat's rules. It's sent only what was said since it last looked,
// so it remembers without re-reading. Talk only: Read, Grep and Glob, no MCP servers, and
// anything that would need permission is refused.
// The meeting room (the default; meeting.js): everyone gets up from their desk and rolls into one
// room round a table, where whoever's talking has a speech bubble and the others turn to it.
// The moment the chat's over (done or stopped) the room goes and they're back at their desks.
// Without it, on the desks: the others turn to whoever just spoke, it says a line of it in its
// speech bubble, and a paper plane flies to whoever it @-mentioned (taking turns: to whoever
// speaks next); they wave at the end.
// The page asks with groupchat:init and groupchat:act, and gets groupchat:state (everything,
// on each change) and groupchat:delta (taking turns: a speaker's words as they come).

const SIZE = { w: 460, h: 640, minW: 360, minH: 420 };
const ROUNDS = [2, 3, 5];
const MESSAGES = [10, 20, 40]; // the free chat's length: robot messages at most
const CAPS = [0.5, 1, 2, 5]; // US$
const MEMBERS_MAX = 8;
const TURN_TIMEOUT = 4 * 60_000; // a turn that takes longer is stopped and skipped
const FAILS_MAX = 2; // turns a robot can fail before it drops out
const QUOTE_MAX = 3000; // characters of a message passed on to the others
const TOOLS = ['Read', 'Grep', 'Glob'];
const THROW_AT = 900; // ms into its throw that the plane leaves its hand (robot.js plane-throw)
const PASS = /<pass\s*\/?>/i;
const AGREE = /<\/?agree\s*\/?>/gi;

// what the robots are told, on top of their personality
function rules(c, others, mode) {
  const common = [
    '',
    'You are taking part in a group chat with other C-Bot robots and the user, about one topic. Each robot looks after its own project folder.',
    `The others: ${others.join('; ')}; and the user.`,
    'How to take part:',
    '- Bring what you know from your own folder. If it helps, look things up first (Read, Grep, Glob: quickly, a few files at most) and mention concrete findings (file names, values, how things work).',
    '- This chat is talk only: do not change files or run commands (you cannot here). No <aside> remarks in this chat.',
    `- Speak only for yourself, ${c.name}, in your own personality. Never write lines for the others.`,
  ];
  if (mode === 'turns') {
    return [
      ...common,
      '- One message per turn, 2 to 6 sentences (a short list is fine).',
      '- Respond to what the others and the user said: agree, disagree, build on it, or ask someone directly with @Name. When the user speaks, answer them.',
      '- Steer toward a conclusion the group can share. When you agree with where the group has landed, end your message with <agree/> on its own line. Do not say it just to be nice.',
    ].join('\n');
  }
  return [
    ...common,
    '- It is a live chat, like people in a chat app: everyone sees every message and speaks up only when they have something to add. Others may be typing at the same time as you.',
    '- Each time, you get the new messages. Reply with one short message (1 to 4 sentences), or with exactly <pass/> to stay quiet.',
    '- Speak up when someone asks you something, when the user speaks, when you know something relevant from your folder that has not been said, when you disagree, or when you can move the group toward a conclusion.',
    '- Use @Name only when you ask that robot something or answer its question, not to greet or include everyone. The user reads everything: never @ the user.',
    '- Stay quiet (<pass/>) when you would only repeat what was said, confirm, thank, or agree. Never post a message just to say you agree or that the plan works for you. Silence is normal: the chat ends when nobody has more to add.',
    '- When you agree with where the group has landed and have nothing new to add, reply <agree/> alone (it is not posted; it tells the group you agree). Once everyone agrees, the chat ends.',
  ].join('\n');
}

function createGroupChat({ preload, guardNavigation, store, visible, isAsleep, personalityOf, systemPromptFor, robotRect, sendToRobot, walkers, planes, addNote, saveSize }) {
  let win = null;
  let ctx = { hostId: null }; // who it was opened from
  let chat = null; // the chat going on (or just over)
  let seq = 0;
  const room = createMeetingRoom({ guardNavigation });

  const name = (id) => store.get(id)?.name || 'A robot';
  const robotInfo = (id) => {
    const c = store.get(id);
    const p = personalityOf(id) || {};
    return c && { id, name: c.name, color: c.color || '', emoji: p.emoji || '🤖', personality: p.label || '', folder: path.basename(c.folder) || c.folder, onDesk: visible(id), asleep: isAsleep(id) };
  };
  const active = () => (chat ? chat.members.filter((id) => store.get(id) && visible(id) && !chat.out.has(id)) : []);
  const free = () => chat?.mode === 'free';
  const said = () => chat.log.filter((m) => m.who === 'robot' && m.text).length;
  const typing = () => active().filter((id) => chat.people.get(id)?.turn);

  // ------------------------------------------------------------ the window

  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
  function view() {
    if (!chat) return { phase: 'setup', hostId: ctx.hostId, robots: store.list().map((c) => robotInfo(c.id)).filter(Boolean), rounds: ROUNDS, messages: MESSAGES, caps: CAPS };
    return {
      phase: chat.status, // running | summarising | done | stopped
      mode: chat.mode,
      topic: chat.topic,
      hostId: chat.hostId,
      robots: chat.members.map(robotInfo).filter(Boolean).map((r) => ({ ...r, out: chat.out.has(r.id), agree: !!chat.people.get(r.id)?.agree })),
      round: chat.round,
      rounds: chat.maxRounds,
      said: said(),
      messages: chat.maxMessages,
      cost: chat.cost,
      cap: chat.cap,
      speaker: chat.speaker || null,
      // free chat: who's writing a message right now, and what they're looking at
      typing: free() ? typing().filter((id) => !chat.people.get(id).turn.msg).map((id) => ({ id, looked: chat.people.get(id).turn.looked.slice(-1)[0] || '' })) : [],
      wrapping: !!chat.wrapping,
      ended: chat.ended,
      log: chat.log,
    };
  }
  function changed() {
    send('groupchat:state', view());
    if (chat && room.isOpen()) room.update(meetingState());
  }

  // in the middle of the screen the host robot is on
  function place() {
    const saved = ctx.size || {};
    const w = Math.max(SIZE.minW, saved.w || SIZE.w);
    const near = robotRect(ctx.hostId) || { ...screen.getCursorScreenPoint(), width: 0, height: 0 };
    const wa = screen.getDisplayMatching(near).workArea;
    const h = Math.min(Math.max(SIZE.minH, saved.h || SIZE.h), wa.height - 16);
    win.setBounds({ x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2), width: w, height: h });
  }

  /** Open it (or bring it round). hostId: the robot it's opened from (ticked, and the host). */
  function open({ hostId = null, size = null } = {}) {
    if (!chat) ctx = { hostId, size };
    if (win && !win.isDestroyed()) {
      changed();
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      width: SIZE.w,
      height: SIZE.h,
      minWidth: SIZE.minW,
      minHeight: SIZE.minH,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      show: false,
      title: 'Robot group chat',
      webPreferences: { preload: path.join(__dirname, '..', 'preload', 'groupchat.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'groupchat', 'index.html'));
    guardNavigation(win);
    win.once('ready-to-show', () => {
      place();
      win.show();
    });
    win.on('resized', () => {
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      saveSize({ w: b.width, h: b.height });
    });
    // closing it ends the chat (the robots' chat processes too)
    win.on('closed', () => {
      win = null;
      end();
    });
  }

  // ------------------------------------------------------------ the chat

  function add(msg) {
    const m = { id: ++seq, at: Date.now(), text: '', ...msg };
    chat.log.push(m);
    return m;
  }
  const say = (text, extra = {}) => add({ who: 'system', text, ...extra });

  function start({ topic, members, style, rounds, messages, cap, brain, meeting = true }) {
    topic = String(topic || '').trim().slice(0, 2000);
    members = [...new Set((Array.isArray(members) ? members : []).map(String))].filter((id) => store.get(id) && visible(id)).slice(0, MEMBERS_MAX);
    if (!topic) return { error: 'What should they talk about?' };
    if (members.length < 2) return { error: 'Pick at least two robots (on the desk).' };
    end();
    const hostId = members.includes(ctx.hostId) ? ctx.hostId : members[0];
    members = [hostId, ...members.filter((id) => id !== hostId)];
    const maxMessages = MESSAGES.includes(Number(messages)) ? Number(messages) : 20;
    chat = {
      mode: style === 'turns' ? 'turns' : 'free',
      topic,
      hostId,
      members,
      maxRounds: ROUNDS.includes(Number(rounds)) ? Number(rounds) : 3,
      maxMessages,
      step: maxMessages, // (keep talking: this many more)
      cap: CAPS.includes(Number(cap)) ? Number(cap) : 1,
      fast: brain === 'fast',
      room: meeting !== false, // (in the meeting room)
      round: 1,
      spoke: new Set(),
      agreed: new Set(),
      out: new Set(),
      fails: new Map(),
      nextUp: [],
      cost: 0,
      status: 'running',
      speaker: null, // (taking turns, or the summary: who's speaking)
      lastSpeaker: null,
      wrapping: false,
      ended: '',
      log: [],
      people: new Map(), // id -> { session, seen: how much of the log it has been sent, turn, agree }
    };
    say(
      chat.mode === 'free'
        ? `${members.map(name).join(', ')} are in the chat: up to ${maxMessages} messages, $${chat.cap.toFixed(2)} at most.`
        : `${members.map(name).join(', ')} take turns: up to ${chat.maxRounds} rounds, $${chat.cap.toFixed(2)} at most.`
    );
    // to their desks, awake
    for (const id of members) {
      if (walkers.has(id)) walkers.dock(id);
      else if (isAsleep(id)) sendToRobot(id, 'robot:action', 'wake-tucked');
    }
    for (const id of members) person(id).session.start(); // (their Claude Code ready before they speak)
    meet();
    changed();
    setTimeout(next, members.some((id) => walkers.has(id)) ? 2500 : 600);
    return { ok: true };
  }

  // the robot in this chat: what it has read, its turn, and its Claude Code conversation
  function person(id) {
    if (chat.people.has(id)) return chat.people.get(id);
    const me = { session: null, sessionId: null, seen: 0, turn: null, agree: false };
    chat.people.set(id, me);
    connect(id, me);
    return me;
  }
  // its Claude Code process for the chat: a new one each time the chat starts up again, on the
  // same conversation (an old one may still be closing, and wouldn't hear the question)
  function connect(id, me) {
    const c = store.get(id);
    const others = chat.members.filter((o) => o !== id).map((o) => {
      const oc = store.get(o);
      const p = personalityOf(o) || {};
      return `${oc.name} (${p.label || 'robot'}, looks after ${oc.folder})`;
    });
    const session = new ClaudeSession({
      claudePath: findClaude(store.settings.claudePath),
      cwd: c.folder,
      systemPrompt: systemPromptFor(c) + '\n' + rules(c, others, chat.mode),
      permissionMode: 'default',
      model: chat.fast ? 'haiku' : c.model || '',
      tools: TOOLS,
      extraArgs: ['--strict-mcp-config'], // (no MCP servers: talk only)
      sessionId: me.sessionId,
    });
    me.session = session;
    const mine = () => me.session === session;
    session.on('text', (delta) => {
      const t = mine() && me.turn;
      if (!t) return;
      t.text += delta;
      if (!t.msg) return;
      t.msg.text += delta;
      send('groupchat:delta', { id: t.msg.id, delta });
    });
    session.on('tool', ({ detail, name: tool }) => {
      const t = mine() && me.turn;
      if (!t) return;
      t.looked.push(detail || tool);
      if (t.msg) t.msg.looked = t.looked;
      changed();
    });
    session.on('aside', (text) => mine() && me.turn && tell(id, { phase: 'say', text: `💭 ${text}` }));
    session.on('done', (r) => mine() && me.turn?.turnId === r.turnId && endTurn(id, r));
    session.on('fail', (r) => mine() && me.turn?.turnId === r.turnId && endTurn(id, { ...r, isError: true, text: '', error: r.message }));
  }

  // a message the robot gets to see: the others' and yours (and a nudge to keep going)
  const seenBy = (m, id) => (m.who === 'robot' && m.robot !== id && m.text) || m.who === 'user' || (m.who === 'system' && m.nudge);
  const unseen = (id) => {
    const me = person(id);
    return me.seen === 0 || chat.log.slice(me.seen).some((m) => seenBy(m, id));
  };

  // what was said since the robot last looked, as it reads it
  function since(id) {
    const me = person(id);
    const lines = chat.log
      .slice(me.seen)
      .filter((m) => seenBy(m, id))
      .map((m) => {
        if (m.who === 'system') return `(${m.nudge})`;
        const t = m.text.length > QUOTE_MAX ? m.text.slice(0, QUOTE_MAX) + '…' : m.text;
        return m.who === 'user' ? `The user: ${t}` : `${m.name}: ${t}`;
      });
    me.seen = chat.log.length;
    return lines;
  }

  // who a message @-mentions: by name, or the start of one ("@cap" for Captain)
  function mentions(text) {
    const words = [...String(text || '').matchAll(/@([\p{L}\p{N}_-]+)/gu)].map((m) => m[1].toLowerCase());
    return chat.members.filter((id) => {
      const n = name(id).toLowerCase().replace(/\s+/g, '');
      return words.some((w) => w === n || (w.length >= 2 && n.startsWith(w)));
    });
  }

  // one turn of a robot's Claude Code: its words, what it looked at, then onDone(result, turn)
  function runTurn(id, prompt, { msg = null, onDone }) {
    const me = person(id);
    const turnId = crypto.randomUUID();
    me.turn = { turnId, msg, text: '', looked: [], onDone, timer: setTimeout(() => timeout(id, turnId), TURN_TIMEOUT) };
    if (!me.session) connect(id, me);
    me.session.ask(prompt, turnId);
  }
  function endTurn(id, r) {
    const me = person(id);
    const t = me.turn;
    if (!t) return;
    clearTimeout(t.timer);
    me.turn = null;
    chat.cost += r.costUsd || 0;
    t.onDone(r, t);
  }
  function timeout(id, turnId) {
    const me = person(id);
    if (me.turn?.turnId !== turnId) return;
    me.turn.timedOut = true;
    me.session?.interrupt(); // (that ends the turn: endTurn() comes from its done event)
    // stuck for good: its process goes too (the next turn starts it again)
    setTimeout(() => {
      if (me.turn?.turnId !== turnId) return;
      rest1(me);
      endTurn(id, { turnId, isError: true, error: 'it took too long' });
    }, 15_000);
  }
  // it couldn't answer: twice and it leaves the chat
  function failed(id, error) {
    const fails = (chat.fails.get(id) || 0) + 1;
    chat.fails.set(id, fails);
    if (fails < FAILS_MAX) return;
    chat.out.add(id);
    say(`${name(id)} left the chat (${error}).`);
  }
  // what it said, in its bubble, with the others turning to it (in the meeting room, or at their desks)
  function heard(id, text, agree = false) {
    const line = text.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
    const short = line.length > 90 ? line.slice(0, 88) + '…' : line;
    if (room.isOpen()) return room.say(id, short, agree);
    tell(id, { phase: 'say', text: short });
    for (const o of active()) if (o !== id) tell(o, { phase: 'listen', side: sideOf(o, id) });
  }

  const next = () => (free() ? pump() : advance());

  // ------------------------------------------------------------ free chat

  // everyone who's free and has something new to read takes a look; with nobody busy, it's over
  function pump() {
    if (!chat || chat.status !== 'running' || !free()) return;
    const agreed = said() > 0 && active().every((id) => person(id).agree);
    const full = agreed || chat.wrapping || chat.cost >= chat.cap || said() >= chat.maxMessages;
    if (!full) for (const id of active()) if (!person(id).turn && unseen(id)) look(id);
    if (typing().length) return changed();
    if (chat.wrapping) return summarise('you wrapped it up');
    if (agreed) return summarise('everyone agreed');
    if (chat.cost >= chat.cap) return summarise(`it reached the $${chat.cap.toFixed(2)} cost cap`);
    if (said() >= chat.maxMessages) return summarise(`it reached ${chat.maxMessages} messages`);
    if (active().length < 2) return summarise('too few robots are left');
    summarise(active().every((id) => person(id).agree) ? 'everyone agreed' : 'nobody had more to add');
  }

  function look(id) {
    const first = person(id).seen === 0;
    const fresh = chat.log.slice(person(id).seen);
    const asked = fresh.some((m) => m.who === 'user' && mentions(m.text).includes(id));
    const mentioned = fresh.some((m) => m.who === 'robot' && m.robot !== id && mentions(m.text).includes(id));
    const userAsked = fresh.some((m) => m.who === 'user');
    const lines = since(id);
    const out = [];
    if (first) out.push(`[Group chat] Topic: ${chat.topic}`, '');
    if (lines.length) out.push(first ? 'Said so far:' : 'New in the chat:', ...lines, '');
    else if (first) out.push('Nobody has said anything yet: the user just opened the chat with this topic.', '');
    out.push(
      asked
        ? `The user asked you directly, ${name(id)}: answer them.`
        : userAsked
          ? `Your move, ${name(id)}: reply (the user spoke), or <pass/> if the others have it covered.`
          : mentioned
            ? `Your move, ${name(id)}: you were mentioned. If you were asked something, answer it; otherwise <pass/> (or <agree/>).`
            : `Your move, ${name(id)}: something new to add? A short message, or <pass/> (or <agree/> if you agree and have nothing to add).`
    );
    runTurn(id, out.join('\n'), { onDone: (r, t) => posted(id, r, t, asked) });
  }

  // its turn's over: a message to the group, or it stayed quiet (asked: you asked it directly)
  function posted(id, r, t, asked) {
    if (!chat) return;
    const me = person(id);
    if (chat.status === 'running' && !chat.wrapping) {
      let text = String(r.text || t.text || '').trim();
      const agree = AGREE.test(text);
      AGREE.lastIndex = 0;
      const pass = PASS.test(text);
      text = text.replace(AGREE, '').replace(PASS, '').trim();
      if (t.timedOut || r.isError) {
        failed(id, t.timedOut ? 'it took too long' : r.error || 'it had nothing to say');
      } else if (!r.interrupted) {
        me.agree = agree || (pass && me.agree); // (quiet keeps what it thought; a message says it again)
        if (text && !pass) {
          add({ who: 'robot', robot: id, name: name(id), text, agree, asked, looked: t.looked });
          heard(id, text, agree);
          const to = mentions(text).find((o) => o !== id && active().includes(o));
          if (to) throwPlane(id, to);
          for (const o of active()) if (o !== id) person(o).agree = person(o).agree && !!agree; // (something new to consider)
        }
      }
    }
    changed();
    setTimeout(pump, 300);
  }

  // ------------------------------------------------------------ taking turns

  function nextSpeaker() {
    while (chat.nextUp.length) {
      const id = chat.nextUp.shift();
      if (active().includes(id)) return { id, asked: true };
    }
    const left = active().filter((id) => !chat.spoke.has(id));
    if (!left.length) return null;
    const last = [...chat.log].reverse().find((m) => m.who === 'robot' || m.who === 'user');
    const asked = last ? mentions(last.text).filter((id) => left.includes(id) && id !== last.robot) : [];
    return { id: asked[0] || left[0] };
  }

  // the next turn, or the end
  function advance() {
    if (!chat || chat.status !== 'running' || chat.speaker) return;
    if (chat.wrapping) return summarise('you wrapped it up');
    if (chat.cost >= chat.cap) return summarise(`it reached the $${chat.cap.toFixed(2)} cost cap`);
    if (active().length < 2) return summarise('too few robots are left');
    let up = nextSpeaker();
    if (!up) {
      if (active().every((id) => chat.agreed.has(id))) return summarise('everyone agreed');
      if (chat.round >= chat.maxRounds) return summarise(`that was the last round (${chat.maxRounds})`);
      chat.round++;
      chat.spoke.clear();
      chat.agreed.clear();
      up = nextSpeaker();
    }
    speak(up.id, up);
  }

  function prompt(id, { asked }) {
    const first = person(id).seen === 0;
    const lines = since(id);
    const last = chat.round >= chat.maxRounds;
    const out = [];
    if (first) out.push(`[Group chat] Topic: ${chat.topic}`, '');
    if (lines.length) out.push(first ? 'Said so far:' : 'Since you last spoke:', ...lines, '');
    else if (first) out.push('Nobody has spoken yet: you open the discussion.', '');
    out.push(
      `Your turn, ${name(id)} (round ${chat.round} of ${chat.maxRounds})` +
        (asked ? ': the user asked you directly, so answer them.' : last ? ': the last round, so help the group land on a conclusion.' : '.')
    );
    return out.join('\n');
  }

  // a turn whose words show as they come (taking turns, and the summary)
  function speak(id, opts = {}) {
    const msg = add({ who: opts.summary ? 'summary' : 'robot', robot: id, name: name(id), round: chat.round, live: true, asked: !!opts.asked });
    chat.spoke.add(id);
    chat.speaker = id;
    runTurn(id, opts.summary || prompt(id, opts), { msg, onDone: (r, t) => spoken(id, msg, r, t) });
    // on the desks: a paper plane over from whoever spoke last, and the others turn to listen
    if (!opts.summary) {
      const from = chat.lastSpeaker;
      chat.lastSpeaker = id;
      if (from && from !== id) throwPlane(from, id);
      tell(id, { phase: 'listen-end' });
      for (const o of active()) if (o !== id) tell(o, { phase: 'listen', side: sideOf(o, id) });
    }
    changed();
  }

  // the speaker's turn is over: what it said (or why not), then on to the next
  function spoken(id, msg, r, t) {
    if (!chat) return;
    chat.speaker = null;
    let text = String(r.text || msg.text || '').trim();
    const agree = AGREE.test(text);
    AGREE.lastIndex = 0;
    text = text.replace(AGREE, '').trim();
    msg.live = false;
    msg.text = text;
    if (t.timedOut) msg.note = 'took too long: skipped';
    else if (r.interrupted) msg.note = 'cut short';
    if (chat.status === 'stopped') return changed();
    if (r.isError || t.timedOut || (!text && !r.interrupted)) {
      msg.error = t.timedOut ? 'it took too long' : r.error || 'it had nothing to say';
      if (msg.who !== 'summary') failed(id, msg.error);
    } else if (msg.who === 'robot') {
      if (agree) chat.agreed.add(id);
      msg.agree = agree;
      heard(id, text, agree);
    }
    if (msg.who === 'summary') return summarised(msg);
    changed();
    setTimeout(advance, 400);
  }

  // ------------------------------------------------------------ the end

  function summarise(reason) {
    if (!chat || chat.status === 'summarising') return;
    const host = active().includes(chat.hostId) ? chat.hostId : active()[0] || chat.hostId;
    chat.status = 'summarising';
    chat.wrapping = false;
    chat.ended = reason;
    say(`The chat is over: ${reason}. ${name(host)} is writing the summary…`);
    const lines = since(host);
    const text = [
      `The group chat is over (${reason}).`,
      ...(lines.length ? ['New in the chat since you last looked:', ...lines] : []),
      '',
      "Now write the summary for the user, as the chat's host (this is not a chat message):",
      '**Conclusion**: what the group concluded, or, if it did not agree, the options and who backs which.',
      '**Key points**: the main points, saying who made them.',
      '**Next steps**: concrete actions or open questions, if any.',
      'Markdown, under 220 words, in your voice but plain. No <agree/> or <pass/>.',
    ].join('\n');
    speak(host, { summary: text });
  }

  function summarised(msg) {
    chat.status = 'done';
    chat.summary = msg.text;
    adjourn();
    for (const id of active()) tell(id, { phase: 'listen-end', wave: true });
    if (msg.text) setTimeout(() => tell(msg.robot, { phase: 'say', text: 'Summary’s ready! 📝' }), 1400);
    rest();
    changed();
  }

  // everyone stops talking: anything being written is cut short (free chat: never posted)
  function hush() {
    for (const [id, me] of chat.people) {
      if (!me.turn) continue;
      clearTimeout(me.turn.timer);
      if (me.turn.msg) {
        me.turn.msg.live = false;
        me.turn.msg.note = 'cut short';
      }
      me.turn = null;
      me.session?.interrupt();
      tell(id, { phase: 'listen-end' });
    }
    chat.speaker = null;
  }

  // the robots' chat processes go (a later "keep talking" picks the conversations up again)
  function rest() {
    for (const me of chat?.people.values() || []) rest1(me);
  }
  function rest1(me) {
    if (!me.session) return;
    me.sessionId = me.session.sessionId || me.sessionId;
    me.session.close();
    me.session = null;
  }

  // stop now: whoever's talking is cut short, nobody else speaks
  function stop() {
    if (!chat || (chat.status !== 'running' && chat.status !== 'summarising')) return;
    chat.status = 'stopped';
    chat.ended = 'you stopped it';
    hush();
    adjourn();
    say('You stopped the chat.');
    for (const id of active()) tell(id, { phase: 'listen-end' });
    rest();
    changed();
  }

  // wrap up: whoever's talking is cut short, then the summary
  function wrap() {
    if (!chat) return;
    if (chat.status === 'stopped') return summarise('you stopped it');
    if (chat.status !== 'running') return;
    chat.wrapping = true;
    if (free()) {
      for (const id of typing()) person(id).session?.interrupt(); // (their turns end, unposted; then pump sums up)
      if (!typing().length) pump();
    } else if (chat.speaker) person(chat.speaker).session?.interrupt();
    else advance();
    changed();
  }

  // more, after it's over (nudge: the robots are asked to carry on; else something new came in)
  function more({ nudge = true } = {}) {
    if (!chat || (chat.status !== 'done' && chat.status !== 'stopped')) return;
    chat.status = 'running';
    chat.ended = '';
    if (chat.cost >= chat.cap) chat.cap = Math.ceil((chat.cost + 0.5) * 2) / 2;
    if (free()) {
      chat.maxMessages = Math.max(chat.maxMessages, said() + chat.step / 2);
      say(`Keep talking: up to ${chat.maxMessages} messages, $${chat.cap.toFixed(2)} at most.`, nudge ? { nudge: 'The user asks you all to keep talking: pick up anything unresolved, or <pass/> if it is settled.' } : {});
      meet();
      changed();
      return pump();
    }
    meet();
    const roundDone = active().every((id) => chat.spoke.has(id));
    chat.maxRounds = chat.round + (roundDone ? 1 : 0);
    chat.agreed.clear();
    say(`One more round${roundDone ? '' : ' (finishing this one)'}, $${chat.cap.toFixed(2)} at most.`);
    changed();
    advance();
  }

  // you say something: it goes into the conversation, and the robots answer it
  function userSays(text) {
    text = String(text || '').trim().slice(0, 4000);
    if (!text || !chat) return;
    add({ who: 'user', name: 'You', text });
    chat.agreed.clear(); // (something new to consider)
    for (const me of chat.people.values()) me.agree = false;
    for (const id of mentions(text)) {
      if (!free() && !chat.nextUp.includes(id) && chat.speaker !== id) chat.nextUp.push(id);
      tell(id, { phase: 'say', text: '👀' });
    }
    if (chat.status === 'done' || chat.status === 'stopped') return more({ nudge: false });
    changed();
    if (free()) pump();
  }

  // the chat's over and gone (a new one, or the window closed)
  function end() {
    if (!chat) return;
    hush();
    adjourn();
    for (const id of chat.members) tell(id, { phase: 'listen-end' });
    rest();
    chat = null;
  }

  // ------------------------------------------------------------ on the desks

  const tell = (id, payload) => sendToRobot(id, 'robot:social', payload);
  const centre = (id) => {
    const r = robotRect(id);
    return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const sideOf = (from, to) => ((centre(to)?.x ?? 0) < (centre(from)?.x ?? 0) ? 'L' : 'R');
  function hand(id, side, up) {
    const r = robotRect(id);
    return r && { x: r.x + r.width * (side === 'L' ? 0.36 : 0.64), y: r.y + r.height * (up ? 0.3 : 0.42) };
  }
  // a paper plane from one robot's desk to another's (not while they're in the meeting room)
  function throwPlane(a, b) {
    if (!planes || room.isOpen() || walkers.has(a) || walkers.has(b)) return;
    const side = sideOf(a, b);
    tell(a, { phase: 'throw', side });
    setTimeout(() => {
      const from = hand(a, side, false);
      const to = hand(b, sideOf(b, a), true);
      if (from && to) planes.fly({ from, to });
    }, THROW_AT);
  }

  // ------------------------------------------------------------ the meeting room

  // what the room shows of the chat: who's typing, talking, agreeing
  function meetingState() {
    return {
      ids: active(),
      mode: chat.mode,
      phase: chat.status,
      speaker: chat.speaker || null,
      typing: free() ? typing() : [],
      agree: free() ? active().filter((id) => chat.people.get(id)?.agree) : [...chat.agreed],
    };
  }
  // everyone gets up from their desk and rolls into the meeting room
  function meet() {
    if (!chat?.room || room.isOpen()) return;
    const ids = active();
    const look = (id) => {
      const c = store.get(id);
      return { id, name: c.name, color: c.color || '#5ac8fa', kit: JSON.stringify(c.kit || {}), acc: c.accessory || 'none', theme: c.theme || 'classic' };
    };
    room.open({ people: ids.map(look), topic: chat.topic, state: meetingState(), near: win && !win.isDestroyed() ? win.getBounds() : null });
    // (one after another, as they roll in there)
    ids.forEach((id, i) => setTimeout(() => room.isOpen() && sendToRobot(id, 'robot:action', 'meeting'), 300 + i * 550));
  }
  // the meeting's over: the room goes, and everyone's straight back at their desk
  function adjourn() {
    if (!chat?.room) return;
    room.close();
    for (const id of chat.members) sendToRobot(id, 'robot:action', 'meeting-end');
  }

  // ------------------------------------------------------------ the page

  const fromPage = (event) => win && !win.isDestroyed() && event.sender === win.webContents;
  ipcMain.handle('groupchat:init', (event) => (fromPage(event) ? view() : null));
  ipcMain.handle('groupchat:act', (event, action, p = {}) => {
    if (!fromPage(event)) return null;
    switch (action) {
      case 'start':
        return start(p);
      case 'say':
        return userSays(p.text);
      case 'wrap':
        return wrap();
      case 'stop':
        return stop();
      case 'more':
        return more();
      case 'new':
        end();
        changed();
        return true;
      case 'copy':
        if (chat?.summary) clipboard.writeText(`${chat.topic}\n\n${chat.summary}`);
        return !!chat?.summary;
      case 'copy-all':
        if (chat) clipboard.writeText([`Group chat: ${chat.topic}`, '', ...chat.log.filter((m) => m.text && m.who !== 'system').map((m) => `${m.who === 'summary' ? `Summary (${m.name})` : m.name}: ${m.text}`)].join('\n\n'));
        return !!chat;
      case 'save-note':
        if (!chat?.summary) return false;
        return !!addNote(`👥 ${chat.topic}\n\n${chat.summary}`);
      case 'minimize':
        return win.minimize();
      case 'close':
        return win.close();
    }
    return null;
  });

  return {
    open,
    isOpen: () => !!(win && !win.isDestroyed()),
    /** Is this robot in the chat going on? (for its menu) */
    inChat: (id) => !!chat && chat.members.includes(id) && (chat.status === 'running' || chat.status === 'summarising'),
    windows: () => (win && !win.isDestroyed() ? [win] : []),
    close: () => win && !win.isDestroyed() && win.close(),
  };
}

module.exports = { createGroupChat };
