const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';

// finding the `claude` command: see findClaude.js
const { findClaude } = require('./findClaude');

// When C-Bot itself was started from inside a Claude Code session, it inherits
// that session's private markers. Passed on, they make every robot's `claude`
// think it's a helper of that session (e.g. CLAUDE_CODE_CHILD_SESSION turns off
// transcript saving). Drop them; genuine user settings such as
// CLAUDE_CODE_GIT_BASH_PATH or CLAUDE_CODE_USE_BEDROCK are kept.
const HOST_SESSION_VAR = new RegExp(
  '^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_\\w*|CLAUDE_AGENT_SDK_\\w*|MCP_SERVER_CONNECTION_BATCH_SIZE|MCP_CONNECTION_NONBLOCKING' +
    '|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|HOST_SESSION_ID|SESSION_ATTENDED|ENTRYPOINT\\w*|EXECPATH|DESKTOP_APP_VERSION' +
    '|TERMINAL_MCP_TOOLS|REPORT_FINDINGS|EAGER_FLUSH|DISABLE_TERMINAL_TITLE|DISABLE_CRON|STARTUP_FAILURE_RESULTS|SIMPLE' +
    '|OAUTH_SCOPES|ACCOUNT_UUID|ORGANIZATION_UUID|USER_EMAIL|MESSAGING_\\w*|EMIT_\\w*|SDK_\\w*|ENABLE_SDK_\\w*|ENABLE_ASK_USER_QUESTION_TOOL))$',
  'i'
);

function cleanEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !HOST_SESSION_VAR.test(k)));
}

// "anthropic-skills:pptx" -> "pptx (anthropic-skills)"
function skillLabel(skill) {
  if (!skill) return '';
  const i = String(skill).lastIndexOf(':');
  return i > 0 ? `${skill.slice(i + 1)} (${skill.slice(0, i)})` : String(skill);
}

function short(s, n = 48) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function describeTool(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return base(input.file_path || input.notebook_path);
    case 'Bash':
    case 'PowerShell':
      return short(input.description || input.command);
    case 'Grep':
      return short(input.pattern, 32);
    case 'Glob':
      return short(input.pattern, 32);
    case 'WebSearch':
      return short(input.query);
    case 'WebFetch':
      try {
        return new URL(input.url).host;
      } catch {
        return short(input.url);
      }
    case 'Task':
    case 'Agent':
      return short(input.description);
    case 'TodoWrite':
      return 'updating the to-do list';
    case 'ToolSearch':
      return short(String(input.query || '').replace(/^select:/, '').replace(/mcp__cbot__/g, '').split(',').join(', ')); // (the other robots' tools by their short names)
    case 'TaskCreate':
      return short(input.subject);
    case 'TaskUpdate':
      return `#${input.taskId}${input.status ? ` → ${input.status.replace('_', ' ')}` : ''}`;
    case 'Skill':
      return skillLabel(input.skill || input.name);
    case 'mcp__cbot__ask_robot': // (robotLink.js: asking another robot)
      return `${input.robot || ''}: ${short(input.message, 48)}`;
    default:
      return '';
  }
}

const OPEN = '<aside>';
const CLOSE = '</aside>';

// Pulls <aside>…</aside> remarks out of streamed text. Only a tag that starts
// its own line counts, so an answer that merely mentions `<aside>` is left
// alone. Tags can arrive split across chunks, so a possible tag start is held back.
class AsideFilter {
  constructor() {
    this.buf = '';
    this.asides = [];
    this.lineStart = true; // is buf[0] at the start of a line?
  }

  // index of the next <aside> that begins a line (only whitespace before it), or -1
  _findOpen(from = 0) {
    for (let i = this.buf.indexOf(OPEN, from); i >= 0; i = this.buf.indexOf(OPEN, i + 1)) {
      const nl = this.buf.lastIndexOf('\n', i - 1);
      const before = this.buf.slice(nl + 1, i);
      if (/^[ \t]*$/.test(before) && (nl >= 0 || this.lineStart)) return i;
    }
    return -1;
  }

  _take(n) {
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    if (out) this.lineStart = out.endsWith('\n');
    return out;
  }

  // returns { text, asides } — the answer text that is safe to show, and finished asides
  push(chunk) {
    this.buf += chunk;
    let text = '';
    const asides = [];
    for (;;) {
      const open = this._findOpen();
      if (open < 0) {
        text += this._take(this.buf.length - partialSuffix(this.buf, OPEN));
        break;
      }
      const close = this.buf.indexOf(CLOSE, open + OPEN.length);
      text += this._take(open).replace(/[ \t]+$/, ''); // drop the remark's indentation
      if (close < 0) break; // wait for the rest of the remark
      const aside = this.buf.slice(OPEN.length, close - open).replace(/\s+/g, ' ').trim();
      if (aside) asides.push(aside);
      this.buf = this.buf.slice(close - open + CLOSE.length).replace(/^[ \t]*\n?/, '');
      this.lineStart = true;
    }
    this.asides.push(...asides);
    return { text, asides };
  }

  // end of stream: a remark that was never closed is shown as plain text rather than lost
  flush() {
    const rest = this.buf.startsWith(OPEN) ? this.buf.slice(OPEN.length) : this.buf;
    this.buf = '';
    return rest;
  }
}

function partialSuffix(s, tag) {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(-n))) return n;
  return 0;
}

const ASIDE_LINE = /(^|\n)[ \t]*<aside>([\s\S]*?)<\/aside>[ \t]*(?=\n|$)\n?/g;
const stripAsides = (s) => String(s || '').replace(ASIDE_LINE, '$1');

// Claude Code's task tools, which print mode leaves out unless asked for.
const TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];

/**
 * A live Claude Code conversation for one tab: one `claude -p` process that
 * stays open and takes question after question over stream-json. Questions
 * sent while it works wait their turn. Emits, for the current turn:
 *   turn-start(turnId) · session(id) · text(delta) · aside(remark) · thinking() · tool({name, detail, id})
 *   agent({op: start|progress|step|text|status|done, id, ...}) for each helper agent (sub-agent)
 *   status(text) · task({op, id, subject, activeForm, status}) · question({requestId, questions})
 *   edit({id, file, created, added, removed, hunks: [{oldStart, newStart, lines}], truncated})
 *   tool-result({id, result: {content, structuredContent, isError}}) for MCP tools (whose tool event carries input)
 *   compact({phase, pre, post}) · commands([{name, description}]) · tools({version, tools})
 *   done({turnId, text, asides, costUsd, isError, interrupted, denials, sessionId}) · fail({turnId, message, sessionMissing})
 * and exit() when the process goes away. Turns Claude Code starts by itself (a
 * background helper agent finished and it carries on) get an "auto-…" turn id.
 */
class ClaudeSession extends EventEmitter {
  // (mcpConfig: an --mcp-config file to add (the other robots' tools), allowedTools: tools it may use
  // without asking, env: extra environment for Claude Code)
  constructor({ claudePath, cwd, sessionId, systemPrompt, permissionMode, model, effort, addDirs = [], tools = null, mcpConfig = '', allowedTools = [], env = {} }) {
    super();
    this.opts = { claudePath, cwd, systemPrompt, permissionMode, model, effort, addDirs: [...addDirs], tools, mcpConfig, allowedTools, env };
    this.sessionId = sessionId || null;
    this.queue = []; // turns waiting: { id, prompt }
    this.turn = null; // the turn being answered
    this.pendingQuestions = new Map(); // requestId -> the AskUserQuestion input
    this.controls = new Map(); // request_id -> { resolve, reject }
    this.taskInputs = new Map(); // tool_use_id -> TaskCreate input, to learn its number
    this.agentTools = new Set(); // tool_use ids of Agent calls (each one is a helper agent)
    this.agentTasks = new Map(); // background task_id -> the Agent tool_use id
    this.agentRunning = new Set(); // Agent tool_use ids still at work
    this.costSoFar = 0; // total_cost_usd is cumulative per process
    this.lastUsed = Date.now();
    this.child = null;
    this.restartBeforeNext = false;
  }

  get alive() {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  get busy() {
    return !!this.turn;
  }

  /** Helper agents still at work (they can outlive the answer that sent them). */
  get helpersRunning() {
    return this.agentRunning.size;
  }

  start() {
    const { claudePath, cwd, systemPrompt, permissionMode, model, effort, addDirs, tools, mcpConfig, allowedTools, env } = this.opts;
    // stdin stays open: questions go in as stream-json messages, and tool
    // permission requests come back to us ("stdio") so questions can be answered
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio',
    ];
    if (permissionMode) args.push('--permission-mode', permissionMode);
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    if (this.sessionId) args.push('--resume', this.sessionId);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    // the default tools plus the task tools (for the to-do card), once we know the defaults
    if (tools?.length) args.push('--tools', [...new Set([...tools, ...TASK_TOOLS])].join(','));
    // folders of files fed to the robot, so Claude Code may read them
    for (const dir of addDirs) args.push('--add-dir', dir);
    // the other robots' tools (robotLink.js), usable without asking
    if (mcpConfig) args.push('--mcp-config', mcpConfig);
    if (allowedTools?.length) args.push('--allowedTools', allowedTools.join(','));

    this.stderr = '';
    this.costSoFar = 0;
    this.restartBeforeNext = false;
    let child;
    try {
      child = spawn(claudePath, args, { cwd, env: { ...cleanEnv(), ...env }, windowsHide: true, shell: isWin && claudePath.toLowerCase().endsWith('.cmd') });
    } catch (err) {
      this._failAll(`Couldn't start Claude Code: ${err.message}`);
      return this;
    }
    this.child = child;
    child.on('error', (err) => this._failAll(`Couldn't start Claude Code: ${err.message}`));
    child.stdin.on('error', () => {});
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this._line(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (this.stderr += d));
    child.on('close', (code) => {
      if (this.child !== child) return; // an old process we replaced
      if (buf.trim()) this._line(buf.trim());
      this.child = null;
      for (const c of this.controls.values()) c.reject(new Error('Claude Code closed'));
      this.controls.clear();
      // helpers die with the process: say so, or their cards would spin forever
      for (const id of this.agentRunning) this.emit('agent', { op: 'done', id, status: 'stopped', summary: 'Stopped: Claude Code closed before this helper finished.' });
      this.agentRunning.clear();
      if (this.turn || this.queue.length) {
        const msg = this.closing ? 'Cancelled.' : this.stderr.trim() || `Claude Code exited with code ${code}`;
        this._failAll(msg, { cancelled: !!this.closing, sessionMissing: /no conversation found/i.test(msg) });
      }
      this.emit('exit');
    });
    // learn the available models, effort levels and command descriptions
    this.control({ subtype: 'initialize' })
      .then((info) => this.emit('initialized', info))
      .catch(() => {});
    return this;
  }

  /** Queue a question; it's sent as soon as the current answer (if any) finishes. */
  ask(prompt, turnId) {
    this.lastUsed = Date.now();
    this.queue.push({ id: turnId, prompt });
    if (!this.turn) this._next();
    return { queued: !!this.turn && this.turn.id !== turnId };
  }

  _next() {
    if (this.turn || !this.queue.length) return;
    if (this.restartBeforeNext && this.alive) this._restart();
    if (!this.alive) this.start();
    if (!this.child) return;
    this.turn = this.queue.shift();
    this.text = '';
    this.asides = new AsideFilter();
    this.streamedMessages = new Set();
    this.lastUsed = Date.now();
    this.emit('turn-start', this.turn.id);
    this._send({ type: 'user', message: { role: 'user', content: this.turn.prompt }, parent_tool_use_id: null, session_id: '' });
  }

  // Swap the process for a fresh one on the same conversation (new folders, new system prompt).
  _restart() {
    const old = this.child;
    this.child = null;
    old.stdin.end();
    setTimeout(() => old.exitCode === null && old.kill(), 3000);
    this.start();
  }

  /** Stop the current answer. The conversation stays open; waiting questions are returned unsent. */
  interrupt() {
    const dropped = this.queue.splice(0).map((t) => t.id);
    if (this.turn && this.alive) {
      this.turn.interrupted = true;
      this.control({ subtype: 'interrupt' }).catch(() => {});
    }
    return dropped;
  }

  /** Cancel one waiting question. */
  unqueue(turnId) {
    const i = this.queue.findIndex((t) => t.id === turnId);
    if (i >= 0) this.queue.splice(i, 1);
    return i >= 0;
  }

  /** Answer this waiting question right away: stop the current answer and jump the queue. */
  sendNow(turnId) {
    const i = this.queue.findIndex((t) => t.id === turnId);
    if (i < 0) return false;
    const [t] = this.queue.splice(i, 1);
    this.queue.unshift(t);
    if (this.turn && this.alive) {
      this.turn.interrupted = true;
      this.control({ subtype: 'interrupt' }).catch(() => {});
    }
    return true;
  }

  setModel(model) {
    this.opts.model = model;
    return this.alive ? this.control({ subtype: 'set_model', model: model || 'default' }) : Promise.resolve();
  }

  setEffort(effort) {
    this.opts.effort = effort;
    return this.alive ? this.control({ subtype: 'apply_flag_settings', settings: { effortLevel: effort || null } }) : Promise.resolve();
  }

  setPermissionMode(mode) {
    this.opts.permissionMode = mode;
    return this.alive ? this.control({ subtype: 'set_permission_mode', mode }) : Promise.resolve();
  }

  // Changes that only a new process can pick up are applied before the next question.
  setSystemPrompt(systemPrompt) {
    if (systemPrompt === this.opts.systemPrompt) return;
    this.opts.systemPrompt = systemPrompt;
    this.restartBeforeNext = this.alive;
  }

  allowDirs(dirs) {
    const fresh = dirs.filter((d) => !this.opts.addDirs.includes(d));
    if (!fresh.length) return;
    this.opts.addDirs.push(...fresh);
    this.restartBeforeNext = this.alive;
  }

  contextUsage() {
    return this.alive ? this.control({ subtype: 'get_context_usage' }) : Promise.resolve(null);
  }

  control(request, timeout = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Error('Claude Code is not running'));
      const id = `cbot-${crypto.randomUUID()}`;
      const timer = setTimeout(() => {
        this.controls.delete(id);
        reject(new Error(`${request.subtype} timed out`));
      }, timeout);
      this.controls.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this._send({ type: 'control_request', request_id: id, request });
    });
  }

  /** End the process. Anything still running or waiting fails as cancelled. */
  close() {
    this.closing = true;
    if (!this.child) return;
    this.child.stdin.end();
    const child = this.child;
    setTimeout(() => {
      if (child.exitCode !== null) return;
      if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
    }, this.turn ? 0 : 3000);
  }

  _send(obj) {
    if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  _reply(requestId, response) {
    this._send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  // Claude Code asks before using a tool its permission mode doesn't cover.
  // Questions for the user are passed on; everything else is refused, as in plain print mode.
  _controlRequest(msg) {
    const req = msg.request || {};
    if (req.subtype !== 'can_use_tool') {
      this._send({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `Unsupported request: ${req.subtype}` } });
      return;
    }
    if (req.tool_name === 'AskUserQuestion' && Array.isArray(req.input?.questions)) {
      this.pendingQuestions.set(msg.request_id, req.input);
      this.emit('question', { requestId: msg.request_id, questions: req.input.questions });
      return;
    }
    this._reply(msg.request_id, {
      behavior: 'deny',
      message: `${req.tool_name} needs permission this robot doesn't have (mode: ${this.opts.permissionMode || 'default'}).`,
    });
  }

  /** answers: { [question text]: "Label" | "Label, Other label" | free text } */
  answer(requestId, answers) {
    const input = this.pendingQuestions.get(requestId);
    if (!input || !this.alive) return false;
    this.pendingQuestions.delete(requestId);
    this._reply(requestId, { behavior: 'allow', updatedInput: { ...input, answers } });
    return true;
  }

  _appendText(t) {
    if (!t || !this.turn) return;
    const { text, asides } = this.asides.push(t);
    for (const a of asides) this.emit('aside', a);
    this._emitText(text);
  }

  _emitText(t) {
    if (!t) return;
    if (!this.text) t = t.replace(/^\s+/, ''); // an aside at the very start leaves blank lines
    if (!t) return;
    this.text += t;
    this.emit('text', t);
  }

  _separate() {
    if (this.text && !this.text.endsWith('\n\n')) this._appendText(this.text.endsWith('\n') ? '\n' : '\n\n');
  }

  // The to-do card follows Claude Code's task tools (and the older TodoWrite).
  _taskTool(block) {
    const input = block.input || {};
    if (block.name === 'TaskCreate') this.taskInputs.set(block.id, input);
    else if (block.name === 'TaskUpdate' && input.taskId) {
      this.emit('task', { op: 'update', id: String(input.taskId), status: input.status, subject: input.subject, activeForm: input.activeForm });
    } else if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
      this.emit('task', { op: 'replace', tasks: input.todos.map((t, i) => ({ id: String(i + 1), subject: t.content, activeForm: t.activeForm, status: t.status })) });
    }
  }

  _toolResult(block) {
    const input = this.taskInputs.get(block.tool_use_id);
    if (!input) return;
    this.taskInputs.delete(block.tool_use_id);
    const text = typeof block.content === 'string' ? block.content : (block.content || []).map((x) => x.text || '').join('');
    const id = text.match(/#(\d+)/)?.[1];
    if (id) this.emit('task', { op: 'create', id, subject: input.subject, activeForm: input.activeForm, status: 'pending' });
  }

  _line(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'control_response') {
      const r = msg.response || {};
      const c = this.controls.get(r.request_id);
      if (c) {
        this.controls.delete(r.request_id);
        if (r.subtype === 'success') c.resolve(r.response || {});
        else c.reject(new Error(r.error || 'control request failed'));
      }
      return;
    }
    // A helper agent's own steps and words: shown in its card, not voiced by the robot.
    if (msg.parent_tool_use_id) {
      this._agentChatter(msg);
      return;
    }

    if (msg.session_id && msg.session_id !== this.sessionId) {
      this.sessionId = msg.session_id;
      this.emit('session', msg.session_id);
    }

    const type = msg.type || ('total_cost_usd' in msg ? 'result' : '');
    // Claude Code carries on by itself when a background helper finishes: a turn nobody asked for
    if (!this.turn && (type === 'assistant' || type === 'stream_event')) this._autoTurn();
    switch (type) {
      case 'control_request':
        this._controlRequest(msg);
        break;
      case 'stream_event': {
        const ev = msg.event || {};
        if (ev.type === 'content_block_start') {
          const block = ev.content_block || {};
          if (block.type === 'text') this._separate();
          if (block.type === 'thinking') this.emit('thinking');
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          if (msg.api_message_id) this.streamedMessages.add(msg.api_message_id);
          this._appendText(ev.delta.text);
        }
        break;
      }
      case 'assistant': {
        const m = msg.message || {};
        for (const block of m.content || []) {
          if (block.type === 'tool_use') {
            this._taskTool(block);
            this._agentStart(block);
            // MCP tools also pass their input on: some come with a view that draws from it
            const mcp = block.name.startsWith('mcp__');
            if (mcp) (this.mcpToolIds ||= new Set()).add(block.id);
            this.emit('tool', { name: block.name, detail: describeTool(block.name, block.input), id: block.id, ...(mcp ? { input: block.input || {} } : {}) });
          } else if (block.type === 'text' && !this.streamedMessages?.has(m.id)) {
            // Fallback when partial messages aren't streamed.
            this._separate();
            this._appendText(block.text);
          }
        }
        break;
      }
      case 'user':
        for (const block of Array.isArray(msg.message?.content) ? msg.message.content : []) {
          if (block.type !== 'tool_result') continue;
          this._toolResult(block);
          // a file it changed: show the diff, like Claude Code's terminal
          const diff = block.is_error ? null : editDiff(msg.tool_use_result);
          if (diff) this.emit('edit', { id: block.tool_use_id, ...diff });
          // an MCP tool's result, as the MCP server gave it (for its view)
          if (this.mcpToolIds?.delete(block.tool_use_id)) {
            const content = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : block.content || [];
            const structuredContent = msg.tool_use_result?.structuredContent;
            this.emit('tool-result', { id: block.tool_use_id, result: { content, ...(structuredContent ? { structuredContent } : {}), isError: !!block.is_error } });
          }
          // a helper that ran in the foreground is done when its tool call returns
          if (this.agentTools.has(block.tool_use_id) && !msg.tool_use_result?.isAsync) {
            this.agentRunning.delete(block.tool_use_id);
            this.emit('agent', { op: 'done', id: block.tool_use_id, status: block.is_error ? 'failed' : 'completed', summary: resultText(block.content) });
          }
        }
        break;
      case 'system':
        if (msg.subtype?.startsWith('task_')) this._agentTask(msg);
        if (msg.subtype === 'task_summary' && msg.detail) this.emit('status', msg.detail);
        else if (msg.subtype === 'init') {
          // the slash commands Claude Code offers in this folder (skills, custom commands)
          if (Array.isArray(msg.slash_commands)) this.emit('commands', msg.slash_commands.map((name) => ({ name })));
          if (Array.isArray(msg.tools)) this.emit('tools', { version: msg.claude_code_version, tools: msg.tools, chosen: !!this.opts.tools });
        } else if (msg.subtype === 'commands_changed' && Array.isArray(msg.commands)) {
          this.emit('commands', msg.commands.map((c) => ({ name: c.name, description: c.description || '' })));
        } else if (msg.subtype === 'status' && msg.status === 'compacting') {
          this.emit('compact', { phase: 'start' });
        } else if (msg.subtype === 'compact_boundary') {
          const meta = msg.compact_metadata || {};
          this.emit('compact', { phase: 'done', pre: meta.pre_tokens, post: meta.post_tokens });
        }
        break;
      case 'result': {
        if (!this.turn) break;
        this._emitText(this.asides.flush());
        const turn = this.turn;
        this.turn = null;
        const total = msg.total_cost_usd || 0;
        const cost = Math.max(0, total - this.costSoFar);
        this.costSoFar = total;
        const interrupted = !!turn.interrupted || /^abort/.test(msg.terminal_reason || '');
        const text = this.text.trim() || stripAsides(typeof msg.result === 'string' ? msg.result : '').trim();
        this.lastUsed = Date.now();
        this.emit('done', {
          turnId: turn.id,
          text,
          asides: this.asides.asides,
          isError: !!msg.is_error && !interrupted,
          interrupted,
          costUsd: cost,
          denials: (msg.permission_denials || []).map((d) => d.tool_name),
          sessionId: msg.session_id || this.sessionId,
        });
        this._next();
        break;
      }
    }
  }

  // ---------------------------------------------------------------- helper agents

  _agentStart(block, parent = null) {
    if (block.name !== 'Agent' && block.name !== 'Task') return;
    const input = block.input || {};
    this.agentTools.add(block.id);
    this.agentRunning.add(block.id);
    this.emit('agent', {
      op: 'start',
      id: block.id,
      parent,
      description: input.description || 'Helper',
      kind: input.subagent_type || '',
      prompt: input.prompt || '',
      background: !!input.run_in_background,
    });
  }

  _agentChatter(msg) {
    const id = msg.parent_tool_use_id;
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use') {
          this._agentStart(block, id); // a helper sending its own helper
          this.emit('agent', { op: 'step', id, tool: block.name, detail: describeTool(block.name, block.input) });
        } else if (block.type === 'text' && block.text.trim()) {
          this.emit('agent', { op: 'text', id, text: block.text });
        }
      }
    }
  }

  // Claude Code's task events for helpers: started, progress, finished
  _agentTask(msg) {
    const id = msg.tool_use_id || this.agentTasks.get(msg.task_id);
    if (!id) return;
    if (msg.task_id) this.agentTasks.set(msg.task_id, id);
    const usage = msg.usage ? { tokens: msg.usage.total_tokens, tools: msg.usage.tool_uses, ms: msg.usage.duration_ms } : {};
    this.lastUsed = Date.now(); // a helper at work keeps the conversation alive
    if (msg.subtype === 'task_started') {
      this.agentTools.add(id);
      this.agentRunning.add(id);
      this.emit('agent', { op: 'start', id, description: msg.description, kind: msg.subagent_type || '', prompt: msg.prompt || '', background: !!msg.is_backgrounded });
    } else if (msg.subtype === 'task_progress') {
      this.emit('agent', { op: 'progress', id, activity: msg.description || '', ...usage });
    } else if (msg.subtype === 'task_updated' && msg.patch?.status) {
      this.emit('agent', { op: 'status', id, status: msg.patch.status });
    } else if (msg.subtype === 'task_notification') {
      this.agentRunning.delete(id);
      this.emit('agent', { op: 'done', id, status: msg.status || 'completed', summary: msg.summary || '', outputFile: msg.output_file || '', ...usage });
    }
  }

  _autoTurn() {
    this.autoTurns = (this.autoTurns || 0) + 1;
    this.turn = { id: `auto-${Date.now()}-${this.autoTurns}`, prompt: null, auto: true };
    this.text = '';
    this.asides = new AsideFilter();
    this.streamedMessages = new Set();
    this.lastUsed = Date.now();
    this.emit('turn-start', this.turn.id);
  }

  _failAll(message, extra = {}) {
    const turns = [...(this.turn ? [this.turn] : []), ...this.queue.splice(0)];
    this.turn = null;
    for (const t of turns) this.emit('fail', { turnId: t.id, message, ...extra });
  }
}

function resultText(content) {
  return typeof content === 'string' ? content : (content || []).map((x) => x.text || '').join('');
}

// A file change Claude Code made (Edit, MultiEdit, Write), from its tool result:
// hunks of unified-diff lines (" " kept, "-" removed, "+" added), as its terminal shows them.
const DIFF_MAX_LINES = 400;
function editDiff(r) {
  if (!r || typeof r !== 'object' || typeof r.filePath !== 'string') return null;
  let hunks = Array.isArray(r.structuredPatch) ? r.structuredPatch : [];
  const created = r.type === 'create';
  if (!hunks.length && created && typeof r.content === 'string') {
    const lines = r.content.replace(/\r?\n$/, '').split(/\r?\n/);
    hunks = [{ oldStart: 0, newStart: 1, lines: lines.map((l) => `+${l}`) }];
  }
  if (!hunks.length) return null;
  let budget = DIFF_MAX_LINES;
  let added = 0;
  let removed = 0;
  let truncated = false;
  const out = [];
  for (const h of hunks) {
    const lines = (h.lines || []).map(String);
    for (const l of lines) {
      if (l[0] === '+') added++;
      else if (l[0] === '-') removed++;
    }
    if (budget <= 0) {
      truncated = true;
      continue;
    }
    const kept = lines.slice(0, budget).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l));
    if (kept.length < lines.length) truncated = true;
    budget -= kept.length;
    out.push({ oldStart: h.oldStart || 0, newStart: h.newStart || 0, lines: kept });
  }
  return { file: r.filePath, created, added, removed, hunks: out, truncated };
}

module.exports = { ClaudeSession, TASK_TOOLS, findClaude, AsideFilter, stripAsides, describeTool, skillLabel, cleanEnv, editDiff };
