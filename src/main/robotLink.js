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

const ANSWER_TIMEOUT = 10 * 60_000;
const EXCHANGE_KEEP = 30 * 60_000; // a follow-up within this long goes to the same tab
const ASKS_MAX = 12;
const ASKS_WINDOW = 10 * 60_000;
const CHAIN_MAX = 4; // robots in one chain of asks (A asks B, who asks C, who asks D)

function createRobotLink({ dir, robots, store, statusOf, onAsk, onAnswered }) {
  const token = crypto.randomBytes(16).toString('hex');
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\cbot-link-${process.pid}-${token.slice(0, 8)}` : path.join(os.tmpdir(), `cbot-link-${process.pid}.sock`);
  const pending = new Map(); // reqId -> { resolve, timer, from, to, chain: robot ids waiting up the line }
  const exchanges = new Map(); // "from>to" -> { id, at }
  const asked = new Map(); // robot id -> times it asked lately

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

  async function handle({ token: t, from, tool, args = {} }) {
    if (t !== token || !store.get(from)) return { text: 'Not allowed.', isError: true };
    if (tool === 'list_robots') {
      const list = others(from);
      if (!list.length) return { text: 'There are no other robots on the desktop right now.' };
      return { text: list.map((c) => `- ${c.name}: looks after ${c.folder} (${statusOf(c.id)})`).join('\n') };
    }
    if (tool !== 'ask_robot') return { text: `No tool ${tool}.`, isError: true };
    const target = find(from, args.robot);
    const message = String(args.message || '').trim();
    if (!message) return { text: 'The message is empty.', isError: true };
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

    // the same conversation for a follow-up (unless it's a new question)
    const key = `${from}>${target.id}`;
    let ex = exchanges.get(key);
    if (!ex || args.new_conversation || now - ex.at > EXCHANGE_KEEP) ex = { id: crypto.randomUUID(), at: now, first: true };
    else ex.first = false;
    ex.at = now;
    exchanges.set(key, ex);

    const reqId = crypto.randomUUID();
    const fromC = store.get(from);
    const text = [
      `📨 Message from ${fromC.name}, another C-Bot robot (it looks after ${fromC.folder}), on the user's behalf:`,
      '',
      message,
      '',
      `Reply to ${fromC.name} directly: your answer goes back to it, so keep it to the point and include what it needs. To look things up in your folder, read and search the files (Read, Grep, Glob): running commands may need a permission you don't have. If you need something from ${fromC.name}, ask it in your reply.`,
    ].join('\n');
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(reqId, { error: `No answer from ${target.name} after ${ANSWER_TIMEOUT / 60_000} minutes (it may be waiting on the user in its chat).` }), ANSWER_TIMEOUT);
      pending.set(reqId, { resolve, timer, from, to: target.id, chain: new Set([...upstream, from]) });
      onAsk({ from, to: target.id, reqId, exchange: ex.id, first: ex.first, text, message });
    });
  }

  function settle(reqId, { text, error } = {}) {
    const p = pending.get(reqId);
    if (!p) return false;
    pending.delete(reqId);
    clearTimeout(p.timer);
    if (error) p.resolve({ text: `${name(p.to)} couldn't answer: ${error}`, isError: true });
    else p.resolve({ text: `${name(p.to)} says:\n${String(text || '').trim() || '(an empty answer)'}` });
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
      const res = await handle(req).catch((e) => ({ text: e.message, isError: true }));
      if (!sock.destroyed) sock.end(JSON.stringify(res) + '\n');
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
    /** What every robot's Claude should know: the other robots, and the tool to ask them. */
    note(id) {
      const list = others(id);
      if (!list.length) return '';
      return (
        `Other C-Bot robots on this desktop: ${list.map((c) => `${c.name} (looks after ${c.folder})`).join(', ')}. ` +
        'When the user asks you to ask one of them something (or what you need is in their project), use the ask_robot tool: ask one clear question with the context it needs, ' +
        'follow up with ask_robot as many times as it takes (it remembers the conversation), and once you have what you need, answer the user yourself, saying what you found out from whom.'
      );
    },
    close: () => server.close(),
  };
}

module.exports = { createRobotLink, TOOLS: ['mcp__cbot__ask_robot', 'mcp__cbot__list_robots'] };
