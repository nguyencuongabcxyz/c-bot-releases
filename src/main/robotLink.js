const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Robots asking each other. Every robot's Claude Code gets the "other robots" tools
// (robotsMcp.js, an MCP server it starts per conversation; mcpConfigFile(id) is what to pass
// it). A call comes here over a private local pipe: ask_robot finds the robot by name and hands
// it the message (onAsk: it works on it in a tab of its own chat, in its own folder); its
// answer (answer(), from robot.js) goes back as the tool's result. The asking robot's Claude
// decides whether to follow up (the same tab, so it remembers) or that it has enough.
// Several at once work: one robot can ask a few others in parallel, a robot can be asked by
// several (a tab each), and a robot answering one can ask another to find out (a chain), up to
// CHAIN_MAX robots. Guards: no asking yourself, nor anyone up your own chain (they're waiting
// on you: that would never end); at most ASKS_MAX asks in ASKS_WINDOW per robot; an answer
// that doesn't come within ANSWER_TIMEOUT comes back as an error.
// hand_off_task is the same trip for a piece of work: the robot does it in a tab of its own
// and its report goes back. It's also tracked as a task (sent, working, done / failed /
// cancelled) that both robots show on their desks (onTasks, tasksFor), waits up to
// TASK_TIMEOUT, and is cancelled if the robot that handed it off stops waiting (its Claude
// was stopped: the tool server hangs up the line).

const ANSWER_TIMEOUT = 10 * 60_000;
const EXCHANGE_KEEP = 30 * 60_000; // a follow-up within this long goes to the same tab
const ASKS_MAX = 12;
const ASKS_WINDOW = 10 * 60_000;
const CHAIN_MAX = 4; // robots in one chain of asks (A asks B, who asks C, who asks D)
const TASK_TIMEOUT = 45 * 60_000; // (main gives Claude Code's tool calls a little longer)
const TASK_SHOWN = 90_000; // a finished task stays on the desks this long

function createRobotLink({ dir, robots, store, statusOf, onAsk, onAnswered, onTasks }) {
  const token = crypto.randomBytes(16).toString('hex');
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\cbot-link-${process.pid}-${token.slice(0, 8)}` : path.join(os.tmpdir(), `cbot-link-${process.pid}.sock`);
  const pending = new Map(); // reqId -> { resolve, timer, from, to, chain: robot ids waiting up the line }
  const exchanges = new Map(); // "from>to" -> { id, at }
  const asked = new Map(); // robot id -> times it asked lately
  const tasks = new Map(); // task id -> { id, reqId, from, to, title, details, status, at, doneAt, report }
  let taskSeq = 0;
  // the robots on both ends of a task hear about every change to it
  function taskChanged(t) {
    onTasks?.([t.from, t.to]);
    if (!['sent', 'working'].includes(t.status)) setTimeout(() => {
      tasks.delete(t.id);
      onTasks?.([t.from, t.to]);
    }, TASK_SHOWN);
  }

  // the tools' script, copied out of the app bundle so Node can run it from anywhere
  const script = path.join(dir, 'robotsMcp.js');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, 'robotsMcp.js')));
  } catch (err) {
    console.warn('[robots] cannot set up the robot tools:', err.message);
  }

  const name = (id) => store.get(id)?.name || 'a robot';
  const visible = (id) => {
    const r = robots.get(id);
    return !!(r && !r.win.isDestroyed() && r.win.isVisible());
  };
  const others = (from) => store.list().filter((c) => c.id !== from && visible(c.id));
  function find(from, wanted) {
    const w = String(wanted || '').trim().toLowerCase();
    const list = store.list().filter((c) => c.id !== from);
    return list.find((c) => c.name.toLowerCase() === w) || list.find((c) => c.name.toLowerCase().startsWith(w)) || list.find((c) => w && c.name.toLowerCase().includes(w));
  }

  async function handle({ token: t, from, tool, args = {} }, sock) {
    if (t !== token || !store.get(from)) return { text: 'Not allowed.', isError: true };
    if (tool === 'list_robots') {
      const list = others(from);
      if (!list.length) return { text: 'There are no other robots on the desktop right now.' };
      return { text: list.map((c) => `- ${c.name}: looks after ${c.folder} (${statusOf(c.id)})`).join('\n') };
    }
    if (tool !== 'ask_robot' && tool !== 'hand_off_task') return { text: `No tool ${tool}.`, isError: true };
    const isTask = tool === 'hand_off_task';
    const target = find(from, args.robot);
    const title = isTask ? String(args.title || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    const message = String((isTask ? args.details : args.message) || '').trim();
    if (!message) return { text: isTask ? 'The task has no details.' : 'The message is empty.', isError: true };
    if (isTask && !title) return { text: 'The task needs a short title.', isError: true };
    if (!target) {
      const names = others(from).map((c) => c.name);
      return { text: `There's no robot called "${args.robot}". ${names.length ? `On the desktop: ${names.join(', ')}.` : 'There are no other robots on the desktop.'}`, isError: true };
    }
    if (!visible(target.id)) return { text: `${target.name} is put away (not on the desktop), so it can't answer. The user can bring it out from the tray.`, isError: true };
    // who's waiting on this robot (it's answering them, maybe for others further up)
    const upstream = new Set();
    for (const p of pending.values()) if (p.to === from) for (const id of p.chain) upstream.add(id);
    if (upstream.has(target.id)) return { text: `${target.name} is waiting on your answer (it asked you this), so you can't ask it: put what you need to know in your reply to it instead.`, isError: true };
    if (upstream.size + 2 > CHAIN_MAX) return { text: `That's ${CHAIN_MAX} robots in one chain already: answer with what you know instead of asking further.`, isError: true };
    const now = Date.now();
    const times = (asked.get(from) || []).filter((x) => now - x < ASKS_WINDOW);
    if (times.length >= ASKS_MAX) return { text: `That's ${ASKS_MAX} messages in a few minutes: stop asking, and answer the user with what you have.`, isError: true };
    times.push(now);
    asked.set(from, times);

    // the same conversation for a follow-up (unless it's a new question); a task gets a tab of its own
    const key = `${from}>${target.id}`;
    let ex = exchanges.get(key);
    if (isTask) ex = { id: crypto.randomUUID(), at: now, first: true };
    else {
      if (!ex || args.new_conversation || now - ex.at > EXCHANGE_KEEP) ex = { id: crypto.randomUUID(), at: now, first: true };
      else ex.first = false;
      ex.at = now;
      exchanges.set(key, ex);
    }

    const reqId = crypto.randomUUID();
    const fromC = store.get(from);
    const text = isTask
      ? [
          `📋 Task from ${fromC.name}: ${title}`,
          '',
          `${fromC.name} is another C-Bot robot (it looks after ${fromC.folder}). It hands you this, on the user's behalf, to do in your own project folder:`,
          '',
          message,
          '',
          `Do the work here, in your folder. When you're done, reply with a short report for ${fromC.name}: what you did and changed (the files), anything it needs to use your work (names, endpoints, shapes, values), and anything left undone or that it should check. If you can't do it, or not all of it, say what's missing and why. Running some commands or editing may need a permission you don't have: then say so in your report.`,
        ].join('\n')
      : [
          `📨 Message from ${fromC.name}, another C-Bot robot (it looks after ${fromC.folder}), on the user's behalf:`,
          '',
          message,
          '',
          `Reply to ${fromC.name} directly: your answer goes back to it, so keep it to the point and include what it needs. To look things up in your folder, read and search the files (Read, Grep, Glob): running commands may need a permission you don't have. If you need something from ${fromC.name}, ask it in your reply.`,
        ].join('\n');
    const task = isTask ? { id: `t${++taskSeq}`, reqId, from, to: target.id, title, details: message, status: 'sent', at: now } : null;
    if (task) {
      tasks.set(task.id, task);
      taskChanged(task);
    }
    const wait = isTask ? TASK_TIMEOUT : ANSWER_TIMEOUT;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(reqId, { error: `No ${isTask ? 'report' : 'answer'} from ${target.name} after ${wait / 60_000} minutes (it may be waiting on the user in its chat).` }), wait);
      pending.set(reqId, { resolve, timer, from, to: target.id, chain: new Set([...upstream, from]), sock, task });
      onAsk({ from, to: target.id, reqId, exchange: ex.id, first: ex.first, text, message, task: task && { id: task.id, title } });
    });
  }

  function settle(reqId, { text, error, cancelled } = {}) {
    const p = pending.get(reqId);
    if (!p) return false;
    pending.delete(reqId);
    clearTimeout(p.timer);
    const said = String(text || '').trim();
    if (p.task) {
      Object.assign(p.task, { status: cancelled ? 'cancelled' : error ? 'failed' : 'done', doneAt: Date.now(), report: error || said });
      taskChanged(p.task);
    }
    if (cancelled) {
      p.resolve({ text: 'Cancelled.', isError: true }); // (nobody's listening any more)
      return true;
    }
    if (error) p.resolve({ text: `${name(p.to)} couldn't ${p.task ? 'do the task' : 'answer'}: ${error}`, isError: true });
    else p.resolve({ text: `${name(p.to)} ${p.task ? 'finished the task. Its report' : 'says'}:\n${said || '(an empty answer)'}` });
    if (!error) onAnswered?.({ from: p.from, to: p.to });
    return true;
  }

  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', async (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        return sock.end(JSON.stringify({ text: 'Bad request.', isError: true }) + '\n');
      }
      const res = await handle(req, sock).catch((e) => ({ text: e.message, isError: true }));
      if (!sock.destroyed) sock.end(JSON.stringify(res) + '\n');
    });
    // the asking robot stopped waiting (its Claude was stopped): its task is cancelled
    sock.on('close', () => {
      for (const [reqId, p] of pending) if (p.sock === sock) settle(reqId, { cancelled: true });
    });
    sock.on('error', () => {});
  });
  server.on('error', (e) => console.warn('[robots] link pipe:', e.message));
  if (process.platform !== 'win32') fs.rmSync(pipe, { force: true });
  server.listen(pipe);

  return {
    /** The --mcp-config file for robot id's Claude Code (written once per robot). */
    mcpConfigFile(id) {
      const file = path.join(dir, `mcp-${id}.json`);
      const cfg = { mcpServers: { cbot: { command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1', CBOT_PIPE: pipe, CBOT_TOKEN: token, CBOT_ROBOT: id } } } };
      try {
        fs.writeFileSync(file, JSON.stringify(cfg));
      } catch {}
      return file;
    },
    /** The asked robot's answer (robot.js robots:answer), or why it couldn't. */
    answer: (reqId, r) => settle(reqId, r),
    /** Is this the robot a request went to? (so only it can answer it) */
    isFor: (reqId, id) => pending.get(reqId)?.to === id,
    /** The asked robot has taken the task on (it's in its chat now). */
    started(reqId) {
      const t = pending.get(reqId)?.task;
      if (!t || t.status !== 'sent') return;
      t.status = 'working';
      taskChanged(t);
    },
    /** The tasks robot id handed off or was handed, as its desk shows them. */
    tasksFor(id) {
      return [...tasks.values()]
        .filter((t) => t.from === id || t.to === id)
        .map((t) => ({ id: t.id, mine: t.to === id, other: name(t.to === id ? t.from : t.to), title: t.title, status: t.status, at: t.at, doneAt: t.doneAt || 0, report: (t.report || '').slice(0, 300) }));
    },
    /** What every robot's Claude should know: the other robots, and the tool to ask them. */
    note(id) {
      const list = others(id);
      if (!list.length) return '';
      return (
        `Other C-Bot robots on this desktop: ${list.map((c) => `${c.name} (looks after ${c.folder})`).join(', ')}. ` +
        'When the user asks you to ask one of them something (or what you need is in their project), use the ask_robot tool: ask one clear question with the context it needs ' +
        '(to ask several robots, call ask_robot for each in the same turn, so they work at the same time), ' +
        'follow up with ask_robot as many times as it takes (it remembers the conversation), and once you have what you need, answer the user yourself, saying what you found out from whom. ' +
        'When the user asks you to get another robot to do work in its project (build, change, fix or set up something there), hand it over with hand_off_task: a short title and full details; you get its report back when it is done, then carry on and tell the user what was done where.'
      );
    },
    close: () => server.close(),
  };
}

module.exports = { createRobotLink, TASK_TIMEOUT, TOOLS: ['mcp__cbot__ask_robot', 'mcp__cbot__list_robots', 'mcp__cbot__hand_off_task'] };
