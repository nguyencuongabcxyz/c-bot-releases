const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { projectDir } = require('./sessions');
const { cleanEnv } = require('./claude');

// Full Claude Code, in a real terminal window: the robot's folder, its model and
// permission mode, resuming its current conversation.

// Characters that would break out of cmd.exe quoting.
const cmdSafe = (s) => String(s).replace(/["%^&|<>]/g, '');

/**
 * Returns the launcher process (on Windows it lives as long as the terminal
 * window, so its exit tells us the terminal was closed), or null.
 */
function launchTerminal({ claudePath, folder, sessionId, model, permissionMode, title }) {
  const args = [];
  if (sessionId) args.push('--resume', sessionId);
  if (model) args.push('--model', model);
  if (permissionMode && permissionMode !== 'default') args.push('--permission-mode', permissionMode);
  const safeArgs = args.filter((a) => /^[\w.:-]+$/.test(a)); // ids, aliases and modes only

  if (process.platform === 'win32') {
    // `start /WAIT` opens a fresh console window and only returns when it closes
    const line = `/d /s /c "start "${cmdSafe(title)}" /WAIT /D "${cmdSafe(folder)}" "${cmdSafe(claudePath)}" ${safeArgs.join(' ')}"`;
    return spawn(process.env.ComSpec || 'cmd.exe', [line], { windowsVerbatimArguments: true, windowsHide: true, env: cleanEnv() });
  }
  const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const command = `cd ${shellQuote(folder)} && ${shellQuote(claudePath)} ${safeArgs.join(' ')}`;
  if (process.platform === 'darwin') {
    const script = `tell application "Terminal" to do script ${JSON.stringify(command)}\ntell application "Terminal" to activate`;
    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore', env: cleanEnv() }).unref();
    return null;
  }
  spawn('x-terminal-emulator', ['-e', 'bash', '-lc', command], { detached: true, stdio: 'ignore', env: cleanEnv() }).unref();
  return null;
}

/**
 * Follows the transcript Claude Code writes while it runs in the terminal and
 * reports what it's doing, so the robot can act it out. Emits:
 *   session(id) · prompt() · tool({name, input}) · question() · text() · idle()
 */
class TranscriptMirror extends EventEmitter {
  constructor({ folder, sessionId, since = Date.now() }) {
    super();
    this.dir = projectDir(folder);
    this.sessionId = sessionId;
    this.since = since;
    this.offset = null;
    this.partial = '';
    this.lastLine = 0;
    this.saidIdle = true;
  }

  start() {
    this.timer = setInterval(() => this._poll(), 700);
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }

  _file(id) {
    return path.join(this.dir, `${id}.jsonl`);
  }

  // The terminal either keeps appending to our session or starts a new one
  // (a fresh robot, or /clear in the terminal): follow whichever appeared since launch.
  _pickSession() {
    let newest = null;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const st = fs.statSync(path.join(this.dir, f));
        if (st.birthtimeMs >= this.since - 2000 && (!newest || st.mtimeMs > newest.mtime)) newest = { id: f.slice(0, -6), mtime: st.mtimeMs };
      }
    } catch {
      return;
    }
    if (newest && newest.id !== this.sessionId) {
      this.sessionId = newest.id;
      this.offset = 0;
      this.partial = '';
      this.emit('session', newest.id);
    }
  }

  _poll() {
    this._pickSession();
    if (!this.sessionId) return;
    let size;
    try {
      size = fs.statSync(this._file(this.sessionId)).size;
    } catch {
      return;
    }
    if (this.offset === null) this.offset = size; // an existing conversation: only what happens from now on
    if (size > this.offset) {
      const fd = fs.openSync(this._file(this.sessionId), 'r');
      const buf = Buffer.alloc(Math.min(size - this.offset, 4 * 1024 * 1024));
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      fs.closeSync(fd);
      this.offset += buf.length;
      const text = this.partial + buf.toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop();
      for (const line of lines) this._line(line);
    }
    // a few quiet seconds after Claude spoke = its turn is over
    if (!this.saidIdle && Date.now() - this.lastLine > 3500) {
      this.saidIdle = true;
      this.emit('idle');
    }
  }

  _line(line) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o.isSidechain || (o.type !== 'user' && o.type !== 'assistant')) return;
    const content = o.message?.content;
    this.lastLine = Date.now();
    this.saidIdle = false;
    if (o.type === 'user') {
      if (typeof content === 'string' || (Array.isArray(content) && content.some((b) => b.type === 'text'))) this.emit('prompt');
      return;
    }
    for (const b of content || []) {
      if (b.type === 'tool_use') {
        if (b.name === 'AskUserQuestion') this.emit('question');
        else this.emit('tool', { name: b.name, input: b.input || {} });
      } else if (b.type === 'text' && b.text?.trim()) this.emit('text');
    }
  }
}

module.exports = { launchTerminal, TranscriptMirror };
