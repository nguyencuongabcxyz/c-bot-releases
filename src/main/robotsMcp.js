// The "other robots" tools for a robot's Claude Code (an MCP server over stdio, started by
// Claude Code for each conversation, run by C-Bot's own executable as plain Node):
//   list_robots   the other robots on the desktop: names, folders, awake / busy / asleep
//   ask_robot     send one of them a message; resolves to its answer (it works on it in its
//                 own folder, in a tab of its own chat). Call it again to follow up.
//   hand_off_task give one of them a piece of work to do in its project (tracked as a task
//                 on both desks); resolves to its report once it's done, or why it couldn't.
// Each call goes to the C-Bot app over a private local pipe (robotLink.js), which does the
// asking. env: CBOT_PIPE (the pipe), CBOT_TOKEN (its password), CBOT_ROBOT (who's asking).
const net = require('net');

// readOnlyHint: Claude Code runs a tool's calls one after another unless the tool says it's
// read-only, so without it asking two robots in one turn waited for the first answer before
// even sending the second. Asking doesn't change anything here, so they can all go at once.
const AT_ONCE = { readOnlyHint: true };

const TOOLS = [
  {
    name: 'list_robots',
    description:
      'List the other C-Bot robots on this desktop: their names, the project folder each one looks after, and whether it is awake, busy or asleep. Use it to find out who you can ask.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: AT_ONCE,
  },
  {
    name: 'ask_robot',
    description:
      'Send a message to another C-Bot robot (by name) and get its answer. That robot works in its own project folder with its own tools, so ask it about its project: how something works, where something is, a value you need, or to check or do something there. ' +
      'Ask one clear question at a time. To ask several robots, call ask_robot for each of them in the same turn: they all work on it at the same time. ' +
      'Call this again with a follow-up if its answer is not enough or it asks you something back; it remembers the conversation. ' +
      'Stop once you have what you need, then answer the user yourself. Set new_conversation when you start on an unrelated question.',
    inputSchema: {
      type: 'object',
      properties: {
        robot: { type: 'string', description: "The other robot's name, as list_robots shows it." },
        message: { type: 'string', description: 'What you want to ask or tell it. Include the context it needs: it cannot see your conversation.' },
        new_conversation: { type: 'boolean', description: 'Start a fresh conversation with it instead of following up on the last one.' },
      },
      required: ['robot', 'message'],
      additionalProperties: false,
    },
    annotations: AT_ONCE,
  },
  {
    name: 'hand_off_task',
    description:
      'Hand a piece of work to another C-Bot robot (by name) to do in its own project folder: a change to make, a feature or fix to build there, something to set up or check. ' +
      "It works on it in a tab of its own chat (the user sees it as a task on both robots' desks) and this call returns its report when it is done: what it changed and what you need to know. " +
      'Use it instead of ask_robot when the other robot has to do work, not just answer. Give a short title and everything it needs in details (it cannot see your conversation): what to do, any names, shapes or values to use, and what done looks like. ' +
      "To hand work to several robots, call it for each in the same turn: they work at the same time. Work that depends on another task's result goes after that task is done.",
    inputSchema: {
      type: 'object',
      properties: {
        robot: { type: 'string', description: "The other robot's name, as list_robots shows it." },
        title: { type: 'string', description: 'The task in a few words, e.g. "Add a GET /orders endpoint". Shown on both desks.' },
        details: { type: 'string', description: 'What to do, with the context and values it needs, and what done looks like.' },
      },
      required: ['robot', 'title', 'details'],
      additionalProperties: false,
    },
    annotations: AT_ONCE,
  },
];

// one call: over the pipe to the app, and back with { text, isError }.
// open: JSON-RPC id -> its socket, so a call Claude Code gives up on can be hung up on
// (the app then knows nobody is waiting for that answer any more).
const open = new Map();
function call(tool, args, id) {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const sock = net.connect(process.env.CBOT_PIPE, () => {
      sock.write(JSON.stringify({ token: process.env.CBOT_TOKEN, from: process.env.CBOT_ROBOT, tool, args }) + '\n');
    });
    open.set(id, sock);
    sock.on('close', () => open.delete(id));
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        finish(JSON.parse(buf.slice(0, nl)));
      } catch {
        finish({ text: 'C-Bot sent back something unreadable.', isError: true });
      }
      sock.end();
    });
    sock.on('error', (e) => finish({ text: `C-Bot isn't reachable (${e.code || e.message}). Is it still running?`, isError: true }));
    sock.on('close', () => finish({ text: 'C-Bot closed the line before answering.', isError: true }));
  });
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined) {
    // a notification: when Claude Code cancels a call (the user stopped it), hang up on it
    if (method === 'notifications/cancelled') open.get(params.requestId)?.destroy();
    return;
  }
  switch (method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cbot', version: '1.0.0' } } });
    case 'ping':
      return send({ jsonrpc: '2.0', id, result: {} });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    case 'tools/call': {
      const r = await call(params.name, params.arguments || {}, id);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(r.text || '') }], isError: !!r.isError } });
    }
    default:
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `No method ${method}` } });
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  input += d;
  let nl;
  while ((nl = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, nl).trim();
    input = input.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
