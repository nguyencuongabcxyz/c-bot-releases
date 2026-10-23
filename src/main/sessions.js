const fs = require('fs');
const os = require('os');
const path = require('path');

// Claude Code keeps every conversation as a JSONL transcript under
// ~/.claude/projects/<folder with every non-alphanumeric char turned into "-">/<sessionId>.jsonl
// That includes the robot's own sessions and anything run in a terminal in the same folder.

const BIG_FILE = 2 * 1024 * 1024; // only skim the head and tail of transcripts larger than this
const listCache = new Map(); // file -> { key, info }

function projectDir(folder) {
  return path.join(os.homedir(), '.claude', 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'));
}

function readSlice(file, size) {
  if (size <= BIG_FILE) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const half = BIG_FILE / 2;
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    fs.readSync(fd, head, 0, half, 0);
    fs.readSync(fd, tail, 0, half, size - half);
    // drop the partial lines at the cut
    const h = head.toString('utf8');
    const t = tail.toString('utf8');
    return h.slice(0, h.lastIndexOf('\n')) + '\n' + t.slice(t.indexOf('\n') + 1);
  } finally {
    fs.closeSync(fd);
  }
}

// Claude Code also writes messages *as the user* that the user never typed:
// notices about background tasks (origin "task-notification") and messages from
// other Claude sessions (origin "peer"). Only origin "human" is really the user.
// Older transcripts have no origin, so they're also recognised by their tags.
// Returns a short note to show instead, or '' to show nothing.
function automaticNote(entry, raw) {
  const kind = entry.origin?.kind;
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ''); // look past hidden reminders
  // (a message from another session can arrive marked "human": its tags win)
  if (kind === 'human' && !/^\s*(<task-notification>|<cross-session-message)/.test(text)) return null;
  if (kind === 'task-notification' || /^\s*<task-notification>/.test(text)) {
    const summary = text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.replace(/\s+/g, ' ').trim();
    return summary ? `🔔 ${summary}` : '';
  }
  if (kind === 'peer' || /^\s*(Another Claude session sent a message|<cross-session-message)/.test(text)) return '📨 A message from another Claude session';
  if (kind) return ''; // some other automatic kind: not the user's words
  return null;
}

// What the user actually typed, minus the scaffolding Claude Code wraps around it.
function cleanUserText(text) {
  if (!text) return '';
  if (/^\s*<task-notification>/.test(text)) return '';
  const cmd = text.match(/<command-name>\s*([^<]+)<\/command-name>[\s\S]*?(?:<command-args>([\s\S]*?)<\/command-args>)?/);
  if (cmd) return `${cmd[1].trim()}${cmd[2] ? ' ' + cmd[2].trim() : ''}`;
  if (/^\s*<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)/.test(text)) return '';
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, '[pasted text]')
    .trim();
}

function parseTranscript(text) {
  const messages = [];
  let title = null;
  let summary = null;
  let cur = null;
  const questionsAsked = new Map(); // tool_use id -> questions, to pair with the answers
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'custom-title' && o.customTitle) title = o.customTitle;
    else if (o.type === 'summary' && o.summary) summary = o.summary;
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || o.isMeta) continue;
    const content = o.message?.content;

    if (o.type === 'user') {
      if (Array.isArray(content) && content.every((b) => b.type === 'tool_result')) {
        for (const b of content) {
          const asked = questionsAsked.get(b.tool_use_id);
          if (!asked) continue;
          const result = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('');
          const picked = new Map([...result.matchAll(/"([^"]+)"="([^"]*)"/g)].map((m) => [m[1], m[2]]));
          messages.push({ role: 'qa', items: asked.map((q) => ({ question: q.question, header: q.header, answer: picked.get(q.question) || '(no answer)' })) });
          cur = null;
        }
        continue;
      }
      const raw = typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const note = automaticNote(o, raw);
      if (note !== null) {
        if (note) messages.push({ role: 'note', text: note, at: o.timestamp });
        cur = null;
        continue;
      }
      const clean = cleanUserText(raw);
      if (!clean) continue;
      cur = null;
      messages.push({ role: 'user', text: clean, at: o.timestamp });
    } else {
      if (!cur) {
        cur = { role: 'assistant', text: '', tools: [], asides: [], at: o.timestamp };
        messages.push(cur);
      }
      for (const b of content || []) {
        if (b.type === 'text' && b.text?.trim()) {
          // the robot's running commentary lives in <aside> tags on their own lines; keep it apart from the answer
          const text = b.text.replace(/(^|\n)[ \t]*<aside>([\s\S]*?)<\/aside>[ \t]*(?=\n|$)\n?/g, (_, lead, a) => {
            cur.asides.push(a.replace(/\s+/g, ' ').trim());
            return lead;
          }).trim();
          if (text) cur.text += (cur.text ? '\n\n' : '') + text;
        }
        else if (b.type === 'tool_use') {
          cur.tools.push(b.name === 'Skill' && b.input?.skill ? `Skill(${b.input.skill})` : b.name);
          if (b.name === 'AskUserQuestion' && Array.isArray(b.input?.questions)) questionsAsked.set(b.id, b.input.questions);
        }
      }
    }
  }
  const kept = messages.filter((m) => m.role !== 'assistant' || m.text || m.tools.length);
  const firstPrompt = kept.find((m) => m.role === 'user')?.text;
  return { title: title || summary || firstPrompt || null, messages: kept };
}

function oneLine(s, n = 80) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Past conversations for a folder, newest first. */
function listSessions(folder, { robotSessionIds = [], limit = 60 } = {}) {
  const dir = projectDir(folder);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const mine = new Set(robotSessionIds);
  const out = [];
  for (const f of files) {
    const file = path.join(dir, f);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const key = `${st.size}:${st.mtimeMs}`;
    let info = listCache.get(file)?.key === key ? listCache.get(file).info : null;
    if (!info) {
      const { title, messages } = parseTranscript(readSlice(file, st.size));
      const prompts = messages.filter((m) => m.role === 'user');
      info = {
        title: oneLine(title || 'Untitled conversation'),
        preview: oneLine(prompts[prompts.length - 1]?.text || '', 120),
        messages: st.size > BIG_FILE ? null : messages.length,
      };
      listCache.set(file, { key, info });
    }
    if (info.messages === 0) continue; // nothing anyone said
    const id = f.slice(0, -'.jsonl'.length);
    out.push({ id, ...info, updatedAt: st.mtimeMs, size: st.size, byRobot: mine.has(id), active: Date.now() - st.mtimeMs < 90 * 1000 });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** The readable part of one conversation (most recent `limit` messages). */
function readSession(folder, sessionId, { limit = 150 } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const file = path.join(projectDir(folder), `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const { title, messages } = parseTranscript(fs.readFileSync(file, 'utf8'));
  return {
    id: sessionId,
    title: oneLine(title || 'Untitled conversation'),
    total: messages.length,
    // question/answer entries have no text
    messages: messages.slice(-limit).map((m) => (m.text?.length > 20000 ? { ...m, text: m.text.slice(0, 20000) + '\n\n…' } : m)),
  };
}

module.exports = { listSessions, readSession, projectDir, automaticNote };
