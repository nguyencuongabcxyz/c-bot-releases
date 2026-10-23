const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

// Local files in the chat. Pictures Claude made or points at (PNG, SVG, …) are
// shown through cbot-file://img/?path=<absolute path>, and file links open the
// file in its usual app. Only pictures are served, and as pictures: an SVG gets
// a CSP that keeps any script in it from running.

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};
const MAX_BYTES = 30 * 1024 * 1024;
const notFound = () => new Response('Not found', { status: 404 });

// Pictures are served only from these folders (set by main: the user's home,
// temp, the robots' folders, dropped files). Not, say, C:\Windows.
let allowedRoots = () => [];
const setAllowedRoots = (fn) => (allowedRoots = fn);
const inside = (p, root) => {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

async function serveImage(request) {
  const p = new URL(request.url).searchParams.get('path') || '';
  const type = IMAGE_TYPES[path.extname(p).toLowerCase()];
  if (!type || !path.isAbsolute(p) || !allowedRoots().some((r) => r && inside(p, r))) return notFound();
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile() || st.size > MAX_BYTES) return notFound();
    return new Response(await fs.promises.readFile(p), {
      headers: {
        'Content-Type': type,
        'Cache-Control': 'max-age=10', // answers re-render while they stream; previews of edited files add ?v=
        ...(type === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:" } : {}),
      },
    });
  } catch {
    return notFound();
  }
}

// Files that would run something when "opened" are shown in Explorer instead.
const RUNNABLE = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|lnk|url|reg|hta|cpl|jar|sh|appref-ms|application)$/i;

async function openFile(p, { reveal = false } = {}) {
  if (!path.isAbsolute(p) || !fs.existsSync(p)) return { ok: false, error: "That file isn't there anymore." };
  if (reveal || RUNNABLE.test(p)) {
    shell.showItemInFolder(p);
    return { ok: true, revealed: true };
  }
  const err = await shell.openPath(p);
  return err ? { ok: false, error: err } : { ok: true };
}

module.exports = { serveImage, openFile, setAllowedRoots, IMAGE_TYPES };
