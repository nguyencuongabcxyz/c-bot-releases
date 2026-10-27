// A file or folder opened in the chat (robot.ts openFileView), shown in the helper panel the
// way an editor would: code highlighted with line numbers, markdown as a page (or its source),
// JSON tidied, CSV as a table, HTML as a page with no scripts, pictures, PDFs, songs and
// videos (through cbot-file), a folder's list to go into; anything else says what it is and
// opens in its own app.
import type { FileView } from '@/types/model';
import { Icon } from '@/ui/icons';
import { highlightFile } from './code';

export type FileViewDeps = {
  md: (text: string) => string;
  /** cbot-file's address (ipc.fileUrl): pictures from img/, PDFs and media from view/ */
  fileUrl: string;
  /** another file or folder, in the viewer */
  open: (path: string) => void;
  openInApp: (path: string) => void;
  reveal: (path: string) => void;
  copy: (text: string, btn: HTMLButtonElement) => void;
};

type Mode = { id: string; label: string; show: (body: HTMLElement) => void };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const button = (cls: string, label: string, title: string, icon = '') => {
  const b = el('button', cls, icon ? '' : label);
  b.type = 'button';
  b.title = title;
  if (icon) {
    b.dataset.icon = icon;
    b.append(el('span', '', label));
  }
  return b;
};

export const fileSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;

const parentOf = (p: string) => {
  const m = /^(.*[\\/])[^\\/]+[\\/]?$/.exec(p);
  const dir = m?.[1];
  if (!dir) return null;
  return /^[a-zA-Z]:\\$/.test(dir) || dir === '\\\\' ? dir : dir.replace(/[\\/]+$/, '');
};

// what a file it can't show is, by its extension (and its icon)
const KINDS: [RegExp, string, string][] = [
  [/^(docx?|odt|rtf|pages)$/, 'note', 'A document'],
  [/^(xlsx?|xlsm|ods|numbers)$/, 'gauge', 'A spreadsheet'],
  [/^(pptx?|odp|key)$/, 'cards', 'A presentation'],
  [/^(zip|7z|rar|tar|gz|tgz|bz2|xz|zst|cab|iso)$/, 'box', 'An archive'],
  [/^(exe|msi|dll|com|scr|sys|appx|msix)$/, 'cpu', 'A program'],
  [/^(ttf|otf|woff2?|eot)$/, 'text-box', 'A font'],
  [/^(psd|ai|sketch|fig|xd|blend|fbx|glb|gltf|obj|stl)$/, 'wand', 'A design or 3D file'],
  [/^(db|sqlite3?|mdb|accdb)$/, 'save', 'A database'],
  [/^(mkv|avi|wmv|flv)$/, 'eye', 'A video this player can’t play'],
  [/^(wma|aiff?|mid|midi)$/, 'sound', 'A sound this player can’t play'],
];
/** A file's line icon (ui/icons) by what it is. */
export function fileIcon(f: { kind?: string; ext: string; isDir?: boolean }) {
  if (f.isDir || f.kind === 'dir') return 'folder';
  if (f.kind === 'image' || /^(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/.test(f.ext)) return 'image';
  if (f.kind === 'pdf' || f.ext === 'pdf') return 'book';
  if (f.kind === 'audio' || /^(mp3|wav|ogg|oga|opus|m4a|aac|flac|weba)$/.test(f.ext)) return 'sound';
  if (f.kind === 'video' || /^(mp4|m4v|webm|ogv|mov)$/.test(f.ext)) return 'eye';
  if (/^(md|markdown|txt|log|rst)$/.test(f.ext)) return 'note';
  return KINDS.find(([re]) => re.test(f.ext))?.[1] ?? 'file';
}
const iconEl = (name: string, cls: string) => {
  const s = el('span', cls);
  s.innerHTML = Icon(name);
  return s;
};

/** Code (or any text) with line numbers. */
function codeView(text: string, ext: string) {
  const { html, lang } = highlightFile(text, ext);
  const box = el('div', 'fv-code');
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  const gutter = el('pre', 'fv-gutter', Array.from({ length: Math.max(1, lines) }, (_, i) => i + 1).join('\n'));
  gutter.setAttribute('aria-hidden', 'true');
  const src = el('pre', 'fv-src');
  const code = el('code', 'hljs');
  code.innerHTML = html;
  src.append(code);
  box.append(gutter, src);
  return { box, lang, lines };
}

/** A picture to look into: it starts fitted; the wheel (or a pinch) zooms where the mouse is,
 *  a drag moves it, a double-click goes between fitted and its actual size; the bar and the
 *  keys (+ − 0 1, arrows) do the same. */
function zoomView(src: string, alt: string, onSize: (w: number, h: number) => void) {
  const frame = el('div', 'fv-pic');
  frame.tabIndex = 0;
  const img = el('img', 'fv-img');
  img.src = src;
  img.alt = alt;
  img.draggable = false;
  const bar = el('div', 'fv-zoom');
  const zOut = button('fv-z', '−', 'Zoom out (−)');
  // (the picture itself has no tooltip: it'd sit over what you're looking at)
  const pct = button('fv-z fv-z-pct', '100%', 'Actual size (1)\nWheel: zoom · drag: move · double-click: fit / actual size');
  const zIn = button('fv-z', '+', 'Zoom in (+)');
  const fitB = button('fv-z fv-z-fit', 'Fit', 'Fit it in (0)');
  bar.append(zOut, pct, zIn, fitB);
  frame.append(img, bar);

  const MAX = 32;
  let nw = 0;
  let nh = 0;
  let s = 1;
  let x = 0;
  let y = 0;
  let fitted = true;
  const box = () => frame.getBoundingClientRect();
  const fitScale = () => Math.min(1, (box().width - 24) / nw, (box().height - 24) / nh);
  // (smaller than the frame: centred that way; bigger: no gap past its edges)
  const clamp = () => {
    const r = box();
    const [w, h] = [nw * s, nh * s];
    x = w <= r.width ? (r.width - w) / 2 : Math.min(0, Math.max(r.width - w, x));
    y = h <= r.height ? (r.height - h) / 2 : Math.min(0, Math.max(r.height - h, y));
  };
  const apply = (anim = false) => {
    frame.classList.toggle('anim', anim);
    img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    pct.textContent = `${Math.round(s * 100)}%`;
    fitB.classList.toggle('on', fitted);
    frame.classList.toggle('pixels', s >= 3); // (zoomed right in: crisp pixels, not a blur)
    frame.classList.toggle('movable', nw * s > box().width + 0.5 || nh * s > box().height + 0.5);
  };
  const fit = (anim = false) => {
    s = fitScale();
    fitted = true;
    clamp();
    apply(anim);
  };
  const zoomTo = (to: number, cx = box().width / 2, cy = box().height / 2, anim = false) => {
    if (!nw) return;
    const ns = Math.min(MAX, Math.max(fitScale() / 4, to));
    x = cx - ((cx - x) * ns) / s;
    y = cy - ((cy - y) * ns) / s;
    s = ns;
    fitted = Math.abs(s - fitScale()) < 1e-3;
    clamp();
    apply(anim);
  };
  const at = (e: MouseEvent) => [e.clientX - box().left, e.clientY - box().top] as const;
  const onBar = (e: Event) => !!(e.target as Element).closest('.fv-zoom');

  img.addEventListener(
    'load',
    () => {
      nw = img.naturalWidth || 512;
      nh = img.naturalHeight || 512;
      img.style.width = `${nw}px`;
      img.style.height = `${nh}px`;
      onSize(img.naturalWidth, img.naturalHeight);
      fit();
      frame.classList.add('ready');
    },
    { once: true },
  );
  img.addEventListener('error', () => frame.replaceWith(el('div', 'fv-note', 'The picture didn’t load.')), { once: true });
  frame.addEventListener(
    'wheel',
    (e) => {
      if (!nw || onBar(e)) return;
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      zoomTo(s * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), ...at(e)); // (ctrl: a touchpad pinch)
    },
    { passive: false },
  );
  frame.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || onBar(e) || !frame.classList.contains('movable')) return;
    e.preventDefault();
    frame.focus({ preventScroll: true });
    frame.setPointerCapture(e.pointerId);
    const [sx, sy, x0, y0] = [e.clientX, e.clientY, x, y];
    frame.classList.add('dragging');
    const move = (ev: PointerEvent) => {
      x = x0 + ev.clientX - sx;
      y = y0 + ev.clientY - sy;
      clamp();
      apply();
    };
    const end = () => {
      frame.classList.remove('dragging');
      frame.removeEventListener('pointermove', move);
      for (const k of ['pointerup', 'pointercancel', 'lostpointercapture']) frame.removeEventListener(k, end);
    };
    frame.addEventListener('pointermove', move);
    for (const k of ['pointerup', 'pointercancel', 'lostpointercapture']) frame.addEventListener(k, end);
  });
  frame.addEventListener('dblclick', (e) => {
    if (!nw || onBar(e)) return;
    if (fitted) zoomTo(fitScale() >= 1 ? 2 : 1, ...at(e), true);
    else fit(true);
  });
  zOut.addEventListener('click', () => zoomTo(s / 1.25, undefined, undefined, true));
  zIn.addEventListener('click', () => zoomTo(s * 1.25, undefined, undefined, true));
  pct.addEventListener('click', () => zoomTo(1, undefined, undefined, true));
  fitB.addEventListener('click', () => fit(true));
  frame.addEventListener('keydown', (e) => {
    const pan = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[e.key];
    if (pan) ((x += pan[0]), (y += pan[1]), clamp(), apply(true));
    else if (e.key === '+' || e.key === '=') zoomTo(s * 1.25, undefined, undefined, true);
    else if (e.key === '-' || e.key === '_') zoomTo(s / 1.25, undefined, undefined, true);
    else if (e.key === '0') fit(true);
    else if (e.key === '1') zoomTo(1, undefined, undefined, true);
    else return;
    e.preventDefault();
  });
  // the panel resized: still fitted if it was, else kept in bounds
  const ro = new ResizeObserver(() => {
    if (!frame.isConnected) return ro.disconnect();
    if (!nw) return;
    if (fitted) fit();
    else (clamp(), apply());
  });
  ro.observe(frame);
  return frame;
}

/** "a,b\n1,"2,3"" -> rows of cells (quotes as in RFC 4180); at most `max` rows. */
function parseDelimited(text: string, sep: string, max: number) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < max; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === sep) row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += c;
  }
  if ((cell || row.length) && rows.length < max) row.push(cell), rows.push(row);
  return rows;
}

const TABLE_ROWS = 1000;
function tableView(text: string, sep: string) {
  const rows = parseDelimited(text, sep, TABLE_ROWS + 1);
  const wrap = el('div', 'fv-table-wrap');
  const table = el('table', 'fv-table');
  const [head, ...body] = rows;
  if (head) {
    const tr = el('tr');
    tr.append(el('th', 'fv-rn'), ...head.map((h) => el('th', '', h)));
    table.append(el('thead'));
    table.tHead!.append(tr);
  }
  const tb = el('tbody');
  body.slice(0, TABLE_ROWS - 1).forEach((r, i) => {
    const tr = el('tr');
    tr.append(el('td', 'fv-rn', String(i + 1)), ...r.map((c) => el('td', '', c)));
    tb.append(tr);
  });
  table.append(tb);
  wrap.append(table);
  if (rows.length > TABLE_ROWS) wrap.append(el('div', 'fv-note', `Only the first ${TABLE_ROWS} rows are shown.`));
  return wrap;
}

/** The ways a file can be looked at; the first is where it opens. */
function modesFor(f: FileView, deps: FileViewDeps): Mode[] {
  const source = (text: string): Mode => ({ id: 'source', label: 'Source', show: (b) => b.append(codeView(text, f.ext).box) });
  const media = `${deps.fileUrl}view/?path=${encodeURIComponent(f.path)}&v=${f.modified ?? ''}`;
  switch (f.kind) {
    case 'dir':
      return [{ id: 'list', label: 'Files', show: (b) => b.append(listView(f, deps)) }];
    case 'image': {
      const pic: Mode = {
        id: 'picture',
        label: 'Picture',
        show: (b) => b.append(zoomView(`${deps.fileUrl}img/?path=${encodeURIComponent(f.path)}&v=${f.modified ?? ''}`, f.name, (w, h) => meta(b, `${w} × ${h}`))),
      };
      return f.text != null ? [pic, source(f.text)] : [pic];
    }
    case 'pdf':
      return [
        {
          id: 'pdf',
          label: 'PDF',
          show: (b) => {
            const frame = el('iframe', 'fv-frame fv-pdf');
            frame.src = media;
            frame.title = f.name;
            b.append(frame);
          },
        },
      ];
    case 'audio':
    case 'video':
      return [
        {
          id: f.kind,
          label: f.kind === 'audio' ? 'Sound' : 'Video',
          show: (b) => {
            const player = el(f.kind === 'audio' ? 'audio' : 'video', `fv-${f.kind}`);
            player.controls = true;
            player.preload = 'metadata';
            player.src = media;
            player.addEventListener('error', () => player.replaceWith(binaryView(f, deps, 'This player can’t play it.')), { once: true });
            const stage = el('div', `fv-player fv-player-${f.kind}`);
            if (f.kind === 'audio') stage.append(iconEl('sound', 'fv-big-icon'));
            stage.append(player);
            b.append(stage);
          },
        },
      ];
    case 'binary':
      return [{ id: 'info', label: 'Info', show: (b) => b.append(binaryView(f, deps)) }];
    case 'text':
      break;
  }
  const text = f.text;
  if (/^(md|markdown|mdx|mkd)$/.test(f.ext)) {
    return [
      {
        id: 'preview',
        label: 'Preview',
        show: (b) => {
          const page = el('div', 'fv-page msg bot');
          page.innerHTML = deps.md(text);
          b.append(page);
        },
      },
      source(text),
    ];
  }
  if (/^(json|jsonc|json5|geojson|webmanifest|ipynb)$/.test(f.ext) && !f.truncated) {
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      if (pretty !== text.trim()) return [{ id: 'pretty', label: 'Tidy', show: (b) => b.append(codeView(pretty, 'json').box) }, source(text)];
    } catch {
      /* not quite JSON: as it is */
    }
  }
  if (f.ext === 'csv' || f.ext === 'tsv') {
    return [{ id: 'table', label: 'Table', show: (b) => b.append(tableView(text, f.ext === 'tsv' ? '\t' : ',')) }, source(text)];
  }
  if (/^(html?|xhtml)$/.test(f.ext)) {
    return [
      {
        id: 'page',
        label: 'Page',
        show: (b) => {
          // (sandboxed and under the chat's CSP: it looks like itself, but nothing in it runs)
          const frame = el('iframe', 'fv-frame fv-html');
          frame.setAttribute('sandbox', '');
          frame.srcdoc = text;
          frame.title = f.name;
          b.append(frame);
        },
      },
      source(text),
    ];
  }
  return [source(text)];
}

function listView(f: Extract<FileView, { kind: 'dir' }>, deps: FileViewDeps) {
  const list = el('div', 'fv-list');
  list.setAttribute('role', 'list');
  if (!f.entries.length) list.append(el('div', 'fv-note', 'Nothing in here.'));
  f.entries.forEach((e, i) => {
    const ext = e.isDir ? '' : (/\.([^.\\/]+)$/.exec(e.name)?.[1] ?? '').toLowerCase();
    const row = button('fv-entry', '', e.isDir ? 'Open this folder' : 'Open this file');
    row.setAttribute('role', 'listitem');
    row.style.setProperty('--i', String(Math.min(i, 20)));
    row.append(iconEl(fileIcon({ ext, isDir: e.isDir }), 'fv-e-icon'), el('span', 'fv-e-name', e.name), el('span', 'fv-e-size', e.isDir ? '' : fileSize(e.size)));
    if (e.isDir) row.classList.add('dir');
    const sep = f.path.endsWith('\\') || f.path.endsWith('/') ? '' : '\\';
    row.addEventListener('click', (ev) => {
      const child = `${f.path}${sep}${e.name}`;
      if (ev.ctrlKey || ev.metaKey) deps.openInApp(child);
      else deps.open(child);
    });
    list.append(row);
  });
  if (f.truncated) list.append(el('div', 'fv-note', `Only the first ${f.entries.length} are listed.`));
  return list;
}

function binaryView(f: FileView, deps: FileViewDeps, why = '') {
  const what = KINDS.find(([re]) => re.test(f.ext))?.[2] ?? (f.ext ? `A .${f.ext} file` : 'A file');
  const card = el('div', 'fv-card');
  card.append(iconEl(fileIcon(f), 'fv-big-icon'), el('div', 'fv-card-what', what), el('div', 'fv-card-why', why || 'It isn’t text I can show here.'));
  const open = button('fv-card-open', 'Open in its app', 'Open it in the app Windows uses for it', 'open');
  open.addEventListener('click', () => deps.openInApp(f.path));
  card.append(open);
  return card;
}

// (the bar's details; a picture adds its size once it's loaded)
function meta(body: HTMLElement, more: string) {
  const m = body.closest('.fv')?.querySelector('.fv-meta');
  if (m && !m.querySelector('.fv-dim')) m.prepend(el('span', 'fv-dim', more));
}

/** Show `f` in `box` (the helper panel's body). */
export function renderFileView(box: HTMLElement, f: FileView, deps: FileViewDeps) {
  box.replaceChildren();
  const root = el('div', `fv kind-${f.kind}`);
  const bar = el('div', 'fv-bar');
  const where = el('div', 'fv-where');
  const parent = parentOf(f.path);
  if (parent) {
    const up = button('fv-up', parent, 'Open the folder it’s in');
    up.addEventListener('click', () => deps.open(parent));
    where.append(up);
  } else where.append(el('span', '', f.path));
  const info = el('div', 'fv-meta');
  const actions = el('div', 'fv-actions');
  bar.append(where, info, actions);

  const body = el('div', 'fv-body');
  root.append(bar, body);
  box.append(root);

  const modes = modesFor(f, deps);
  const seg = el('div', 'fv-modes');
  seg.setAttribute('role', 'tablist');
  const show = (m: Mode) => {
    for (const b of seg.children) b.classList.toggle('on', (b as HTMLElement).dataset.mode === m.id);
    body.replaceChildren();
    body.dataset.mode = m.id;
    m.show(body);
    body.classList.remove('swap');
    void body.offsetWidth; // (replay the fade)
    body.classList.add('swap');
  };
  if (modes.length > 1) {
    for (const m of modes) {
      const b = button('fv-mode', m.label, `Show it as: ${m.label}`);
      b.dataset.mode = m.id;
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => show(m));
      seg.append(b);
    }
    actions.append(seg);
  }

  const bits: string[] = [];
  if (f.kind === 'dir') bits.push(`${f.entries.length}${f.truncated ? '+' : ''} items`);
  else bits.push(fileSize(f.size));
  if ('text' in f && f.text != null && f.kind === 'text') {
    const n = f.text.split('\n').length - (f.text.endsWith('\n') ? 1 : 0);
    bits.push(`${n.toLocaleString()} line${n === 1 ? '' : 's'}`);
    const lang = highlightFile('', f.ext).lang; // (only its name: the text is highlighted when shown)
    if (lang) bits.push(lang);
  }
  if (f.modified) bits.push(new Date(f.modified).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
  info.append(...bits.map((b) => el('span', '', b)));

  if ('text' in f && f.text != null) {
    const copy = button('fv-act', 'Copy', 'Copy the text', 'copy');
    copy.addEventListener('click', () => deps.copy(f.text!, copy));
    actions.append(copy);
  }
  if (f.kind !== 'dir') {
    const open = button('fv-act', 'Open', 'Open in its app (Ctrl+click a file in the chat does this too)', 'open');
    open.addEventListener('click', () => deps.openInApp(f.path));
    actions.append(open);
  }
  const reveal = button('fv-act', 'Folder', f.kind === 'dir' ? 'Open it in Explorer' : 'Show it in its folder', 'folder');
  reveal.addEventListener('click', () => (f.kind === 'dir' ? deps.openInApp(f.path) : deps.reveal(f.path)));
  actions.append(reveal);

  if ('truncated' in f && f.truncated && f.kind !== 'dir') root.append(el('div', 'fv-note fv-cut', `It’s ${fileSize(f.size)}: only the start is shown. Open it in its app for the rest.`));
  show(modes[0]);
}
