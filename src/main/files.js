const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// The files in a robot's folder, for @-mentions in the chat box. In a git
// repository that's what git knows about (tracked + untracked, minus
// .gitignore); otherwise a walk of the folder that skips the usual heavy
// directories. Kept for a little while so typing stays snappy.

const SKIP = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.cache',
  '.parcel-cache', 'target', 'bin', 'obj', '.venv', 'venv', '__pycache__', '.idea', '.vs', '.gradle', '.terraform',
]);
const MAX_FILES = 40000;
const FRESH_MS = 20000;
const index = new Map(); // folder -> { at, entries: [{ rel, dir }] } (or a pending promise)

function gitFiles(folder) {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-co', '--exclude-standard'], { cwd: folder, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 8000 }, (err, out) =>
      resolve(err ? null : out.split('\n').filter(Boolean).slice(0, MAX_FILES)));
  });
}

async function walkFiles(folder) {
  const files = [];
  const queue = [''];
  while (queue.length && files.length < MAX_FILES) {
    const rel = queue.shift();
    let items;
    try {
      items = await fs.promises.readdir(path.join(folder, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      const child = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) {
        if (!SKIP.has(it.name) && child.split('/').length < 14) queue.push(child);
      } else if (it.isFile()) files.push(child);
    }
  }
  return files;
}

async function build(folder) {
  const files = (await gitFiles(folder)) || (await walkFiles(folder));
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...[...dirs].map((rel) => ({ rel, dir: true })), ...files.map((rel) => ({ rel, dir: false }))];
}

async function entriesOf(folder) {
  const hit = index.get(folder);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.entries;
  if (hit?.pending) return hit.pending;
  const pending = build(folder).then((entries) => {
    index.set(folder, { at: Date.now(), entries });
    return entries;
  });
  index.set(folder, { ...hit, pending });
  return pending;
}

// How well `rel` matches `q` (lower is better; -1 = no match): a file name that
// starts with it, a file name that contains it, a path that contains it, then
// letters in order (fuzzy).
function rank(rel, q) {
  const r = rel.toLowerCase();
  const base = r.slice(r.lastIndexOf('/') + 1);
  if (base.startsWith(q)) return 0;
  if (base.includes(q)) return 1;
  if (r.includes(q)) return 2;
  let i = 0;
  for (const ch of base) if (ch === q[i]) i++;
  if (i === q.length) return 3;
  i = 0;
  for (const ch of r) if (ch === q[i]) i++;
  return i === q.length ? 4 : -1;
}

/** Files and folders in `folder` matching `query`, best first: [{ rel, dir }] */
async function searchFiles(folder, query = '', limit = 40) {
  const entries = await entriesOf(folder);
  const q = String(query).toLowerCase().replace(/\\/g, '/');
  if (!q) {
    // nothing typed yet: the top of the folder
    return entries
      .filter((e) => !e.rel.includes('/'))
      .sort((a, b) => b.dir - a.dir || a.rel.localeCompare(b.rel))
      .slice(0, limit);
  }
  const scored = [];
  for (const e of entries) {
    const s = rank(e.rel, q);
    if (s >= 0) scored.push([s, e]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].rel.length - b[1].rel.length);
  return scored.slice(0, limit).map(([, e]) => e);
}

/** The files a message @-mentions (that exist), as absolute paths. "@a/b.ts" and "@\"with space.md\"". */
function mentionedPaths(folder, text) {
  const out = new Set();
  for (const m of String(text).matchAll(/(?:^|\s)@(?:"([^"]+)"|([^\s"]+))/g)) {
    const raw = (m[1] || m[2]).replace(/[.,;:!?)]+$/, '');
    const abs = path.isAbsolute(raw) ? raw : path.join(folder, raw);
    if (fs.existsSync(abs)) out.add(path.normalize(abs));
  }
  return [...out].slice(0, 20);
}

module.exports = { searchFiles, mentionedPaths };
