const { spawnSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Finding the `claude` command without asking the user.
//
// An app started from the Start menu, a desktop shortcut or Finder often has a
// stale or bare PATH (Windows hands out the PATH from when you signed in, so a
// Claude Code installed since is invisible; macOS apps get no shell PATH at all).
// So look in every usual install spot first, then a fresh PATH, and last the copy
// of Claude Code that the Claude desktop app keeps for itself, which is all many
// people have. The answer is cached; it's checked again only if the file goes.

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const isFile = (p) => {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const dirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
};
// "2.1.308" > "2.1.304" > "2.0.99"; names that aren't versions sort last
function byVersion(a, b) {
  const va = path.basename(a).split('.').map(Number);
  const vb = path.basename(b).split('.').map(Number);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const x = Number.isFinite(va[i]) ? va[i] : -1;
    const y = Number.isFinite(vb[i]) ? vb[i] : -1;
    if (x !== y) return y - x;
  }
  return 0;
}

const NAMES = isWin ? ['claude.exe', 'claude.cmd'] : ['claude'];
const inDir = (dir) => NAMES.map((n) => path.join(dir, n));

// Where installers put it. [path, how it got there] — the label is shown in the Workshop.
function installSpots() {
  const home = os.homedir();
  const env = process.env;
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const spots = [
    [path.join(home, '.local', 'bin'), 'Claude Code installer'],
    [path.join(home, '.claude', 'local'), 'Claude Code (local install)'],
    [path.join(home, '.claude', 'local', 'node_modules', '.bin'), 'Claude Code (local install)'],
  ];
  if (env.npm_config_prefix) spots.push([isWin ? env.npm_config_prefix : path.join(env.npm_config_prefix, 'bin'), 'npm']);
  if (isWin) {
    spots.push(
      [path.join(roaming, 'npm'), 'npm'],
      [env.NVM_SYMLINK, 'npm (nvm)'],
      ['C:\\nvm4w\\nodejs', 'npm (nvm)'],
      [path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs'), 'npm'],
      [path.join(local, 'Volta', 'bin'), 'Volta'],
      [path.join(local, 'pnpm'), 'pnpm'],
      [path.join(local, 'Yarn', 'bin'), 'Yarn'],
      [path.join(home, 'scoop', 'shims'), 'Scoop'],
      [path.join(local, 'Microsoft', 'WinGet', 'Links'), 'WinGet'],
      [path.join(home, '.bun', 'bin'), 'Bun'],
    );
  } else {
    spots.push(
      ['/opt/homebrew/bin', 'Homebrew'],
      ['/usr/local/bin', ''],
      ['/usr/bin', ''],
      [path.join(home, '.npm-global', 'bin'), 'npm'],
      [path.join(home, '.volta', 'bin'), 'Volta'],
      [path.join(home, '.bun', 'bin'), 'Bun'],
      [path.join(home, '.local', 'share', 'pnpm'), 'pnpm'],
      [path.join(home, 'Library', 'pnpm'), 'pnpm'],
      // nvm: the newest Node first
      ...dirs(path.join(home, '.nvm', 'versions', 'node')).sort(byVersion).map((d) => [path.join(d, 'bin'), 'npm (nvm)']),
    );
  }
  return spots.filter(([dir]) => dir);
}

// The PATH as it is now, not as it was when this app was started: on Windows
// read it fresh from the registry (user + machine), on a Mac ask a login shell.
function freshPath() {
  const parts = [process.env.PATH || process.env.Path || ''];
  if (isWin) {
    // (reg.exe by its full path: with a bare PATH, plain `reg` isn't found either)
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
      const r = spawnSync(reg, ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      const m = /\bPath\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(r.stdout || '');
      if (m) parts.push(m[1].replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all));
    }
  } else {
    const shell = process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash');
    const r = spawnSync(shell, ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 4000 });
    if (r.stdout) parts.push(r.stdout.trim().split('\n').pop());
  }
  return [...new Set(parts.join(path.delimiter).split(path.delimiter).map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean))];
}

// The Claude desktop app downloads its own Claude Code, one folder per version:
//   …\Claude-Data\claude_<id>\claude-code\<version>\<build>\claude.exe  (Microsoft Store app)
//   …\Claude\claude-code\<version>\claude.exe                           (older layout)
// The newest version wins.
function desktopAppCopies() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const roots = isWin
    ? [
        ...dirs(path.join(local, 'Claude-Data')).map((d) => path.join(d, 'claude-code')),
        path.join(roaming, 'Claude', 'claude-code'),
        path.join(local, 'Claude', 'claude-code'),
        ...dirs(path.join(local, 'Packages')).filter((d) => /^Claude_/i.test(path.basename(d))).map((d) => path.join(d, 'LocalCache', 'Roaming', 'Claude', 'claude-code')),
      ]
    : [path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code')];
  const found = [];
  for (const root of roots) {
    for (const ver of dirs(root)) {
      const hits = [...inDir(ver), ...dirs(ver).flatMap(inDir)].filter(isFile);
      if (hits.length) found.push({ ver: path.basename(ver), file: hits[0] });
    }
  }
  return found.sort((a, b) => byVersion(a.ver, b.ver)).map((f) => f.file);
}

let cached = null; // { path, source }

// Every place it looked, in order; the first real file is the answer.
function search() {
  for (const [dir, source] of installSpots()) for (const f of inDir(dir)) if (isFile(f)) return { path: f, source };
  for (const dir of freshPath()) for (const f of inDir(dir)) if (isFile(f)) return { path: f, source: 'PATH' };
  const copy = desktopAppCopies()[0];
  if (copy) return { path: copy, source: 'Claude desktop app' };
  return null;
}

// -> { path, source } or null. `override` is the path the user picked (it wins
// while it exists); `fresh` skips the cache (the Workshop's "Search again").
function locateClaude(override, { fresh = false } = {}) {
  if (isFile(override)) return { path: override, source: 'picked by you' };
  if (!fresh && cached && isFile(cached.path)) return cached;
  cached = search();
  return cached;
}

// the path only (what spawning needs), or null
function findClaude(override) {
  return locateClaude(override)?.path || null;
}

// Is this really Claude Code? Runs `<file> --version` -> { ok, version } or { ok: false, error }.
function checkClaude(file) {
  return new Promise((resolve) => {
    if (!isFile(file)) return resolve({ ok: false, error: "That file doesn't exist." });
    const shell = isWin && /\.(cmd|bat)$/i.test(file);
    execFile(file, ['--version'], { timeout: 15000, windowsHide: true, shell }, (err, stdout) => {
      const out = String(stdout || '').trim();
      if (!err && /claude/i.test(out)) return resolve({ ok: true, version: out.split(/\r?\n/)[0] });
      resolve({ ok: false, error: err?.killed ? 'It took too long to answer.' : "That doesn't look like Claude Code (it didn't answer `--version` like Claude Code does)." });
    });
  });
}

module.exports = { findClaude, locateClaude, checkClaude };
