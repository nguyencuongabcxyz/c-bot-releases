// What the conversation made, as Claude Code desktop lists its outputs: the files it made or
// changed (its diff cards) and the pictures its answers show, the latest first. Read off the
// conversation's log, so it's right live, from history, after a rewind and per tab.
//
// Over the chat box, an "Outputs 4" button (renderOutputsStrip) that opens them all in the
// helper panel (renderOutputsPanel): by folder, pictures as thumbnails, a GitHub-style bar
// for what changed, and a way to its app or its folder. A file opened from there goes
// through robot.ts's [data-open] (Ctrl+click: its app).
import { Icon } from '@/ui/icons';
import { fileIcon } from './fileview';

export type Output = { path: string; kind: 'new' | 'edited' | 'picture'; added: number; removed: number };

const same = (p: string) => p.replace(/\//g, '\\').toLowerCase();
const PICTURE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;

/** What the log's answers made, each file once (where it last came), the latest first. */
export function collectOutputs(log: HTMLElement): Output[] {
  const byPath = new Map<string, Output>();
  const add = (o: Output) => {
    const key = same(o.path);
    const had = byPath.get(key);
    byPath.delete(key); // (to the end: the latest)
    if (!had) return byPath.set(key, o);
    byPath.set(key, {
      path: o.path,
      kind: had.kind === 'new' || o.kind === 'new' ? 'new' : o.kind === 'picture' ? had.kind : 'edited',
      added: had.added + o.added,
      removed: had.removed + o.removed,
    });
  };
  for (const el of log.querySelectorAll<HTMLElement>('details.diff[data-file], .msg.bot img.local-img[data-open]')) {
    if (el.tagName === 'IMG') add({ path: el.dataset.open!, kind: 'picture', added: 0, removed: 0 });
    else add({ path: el.dataset.file!, kind: el.dataset.created ? 'new' : 'edited', added: +el.dataset.added! || 0, removed: +el.dataset.removed! || 0 });
  }
  return [...byPath.values()].reverse();
}

const nameOf = (p: string) => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);
const extOf = (p: string) => (/\.([^.\\/]+)$/.exec(p)?.[1] ?? '').toLowerCase();
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
/** "2 new · 1 changed · 1 picture" */
export function outputsSummary(outputs: Output[]) {
  const n = (k: Output['kind']) => outputs.filter((x) => x.kind === k).length;
  const pics = n('picture');
  return [n('new') && `${n('new')} new`, n('edited') && `${n('edited')} changed`, pics && `${pics} picture${pics === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
}
// (a picture's own little picture, else the file's icon; a broken one falls back to the icon)
function mark(o: Output, thumb: (p: string) => string, cls: string) {
  if (PICTURE.test(o.path)) {
    const img = el('img', `${cls} thumb`);
    img.src = thumb(o.path);
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.replaceWith(mark({ ...o, path: '' }, thumb, cls)), { once: true });
    return img;
  }
  const s = el('span', cls);
  s.innerHTML = Icon(fileIcon({ ext: extOf(o.path) }), 'sm');
  return s;
}

/** Over the chat box, just "Outputs 4": all of them are a click away (the panel). */
export function renderOutputsStrip(box: HTMLElement, outputs: Output[], o: { openPanel: () => void }) {
  box.hidden = !outputs.length;
  if (!outputs.length) return box.replaceChildren();
  const all = el('button', 'out-open');
  all.type = 'button';
  all.title = `What this conversation made and changed: ${outputsSummary(outputs)}`;
  all.innerHTML = `${Icon('box', 'sm')}<span>Outputs</span><b></b>`;
  all.querySelector('b')!.textContent = String(outputs.length);
  all.addEventListener('click', o.openPanel);
  box.replaceChildren(all);
}

/** "+12 −3" and five little squares, green for what came in, red for what went (as GitHub). */
function diffBar(o: Output) {
  const wrap = el('span', 'op-stat');
  if (o.kind === 'new') wrap.append(el('span', 'op-new', 'new'));
  if (o.kind !== 'edited') return wrap;
  if (o.added) wrap.append(el('span', 'add', `+${o.added}`));
  if (o.removed) wrap.append(el('span', 'del', `−${o.removed}`));
  const total = o.added + o.removed;
  if (total) {
    const bar = el('span', 'op-bar');
    const green = Math.round((5 * o.added) / total);
    for (let i = 0; i < 5; i++) bar.append(el('i', i < green ? 'add' : 'del'));
    wrap.append(bar);
  }
  return wrap;
}

/** All of them, in the helper panel: by folder (the robot's own first), pictures as thumbnails. */
export function renderOutputsPanel(
  box: HTMLElement,
  outputs: Output[],
  o: { folder: string; thumb: (p: string) => string; openInApp: (p: string) => void; reveal: (p: string) => void },
) {
  box.replaceChildren();
  const root = el('div', 'op');
  const sum = el('div', 'op-sum');
  for (const [kind, label] of [['new', 'new'], ['edited', 'changed'], ['picture', 'pictures']] as const) {
    const n = outputs.filter((x) => x.kind === kind).length;
    if (!n) continue;
    const pill = el('span', `op-pill ${kind}`);
    pill.append(el('b', '', String(n)), ` ${n === 1 && kind === 'picture' ? 'picture' : label}`);
    sum.append(pill);
  }
  root.append(sum);
  if (!outputs.length) root.append(el('div', 'fv-note', 'Nothing made or changed in this conversation yet.'));
  // by folder: the robot's folder as "./", inside it relative, elsewhere the whole path
  const folder = o.folder.replace(/[\\/]+$/, '');
  const groups = new Map<string, Output[]>();
  for (const out of outputs) {
    const cut = Math.max(out.path.lastIndexOf('\\'), out.path.lastIndexOf('/'));
    const dir = out.path.slice(0, cut);
    const inside = folder && (same(dir) === same(folder) || same(dir).startsWith(`${same(folder)}\\`));
    const key = inside ? `./${dir.slice(folder.length + 1).replace(/\\/g, '/')}` : dir;
    groups.set(key, [...(groups.get(key) || []), out]);
  }
  const keys = [...groups.keys()].sort((a, b) => Number(!a.startsWith('./')) - Number(!b.startsWith('./')) || a.localeCompare(b));
  keys.forEach((key, gi) => {
    const group = el('section', 'op-group');
    group.style.setProperty('--i', String(Math.min(gi, 8)));
    const head = el('div', 'op-dir');
    head.innerHTML = Icon('folder', 'sm');
    // (the robot's folder by its name: "chat-work", "chat-work/shots"; no "./", which the
    // right-to-left ellipsis would turn round)
    head.append(el('span', '', key.startsWith('./') ? `${nameOf(folder)}${key.slice(1).replace(/\/$/, '')}` : key));
    head.title = key.startsWith('./') ? `${folder}${key.slice(1).replace(/\//g, '\\')}` : key;
    group.append(head);
    const pics = groups.get(key)!.filter((x) => PICTURE.test(x.path));
    const files = groups.get(key)!.filter((x) => !PICTURE.test(x.path));
    for (const out of files) {
      const row = el('div', `op-row ${out.kind}`);
      const main = el('button', 'op-main');
      main.type = 'button';
      main.dataset.open = out.path;
      main.title = `${out.path}\nClick to look at it here (Ctrl+click: open it)`;
      main.append(mark(out, o.thumb, 'op-icon'), el('span', 'op-name', nameOf(out.path)), diffBar(out));
      row.append(main, actions(out.path, o));
      group.append(row);
    }
    if (pics.length) {
      const grid = el('div', 'op-pics');
      for (const out of pics) {
        const tile = el('div', 'op-pic');
        const main = el('button', 'op-pic-main');
        main.type = 'button';
        main.dataset.open = out.path;
        main.title = `${out.path}\nClick to look at it here (Ctrl+click: open it)`;
        main.append(mark(out, o.thumb, 'op-thumb'), el('span', 'op-pic-name', nameOf(out.path)));
        tile.append(main, actions(out.path, o));
        grid.append(tile);
      }
      group.append(grid);
    }
    root.append(group);
  });
  box.append(root);
}

function actions(path: string, o: { openInApp: (p: string) => void; reveal: (p: string) => void }) {
  const bar = el('span', 'op-acts');
  for (const [icon, title, run] of [['open', 'Open in its app', o.openInApp], ['folder', 'Show in its folder', o.reveal]] as const) {
    const b = el('button', 'op-act');
    b.type = 'button';
    b.title = title;
    b.innerHTML = Icon(icon, 'sm');
    b.addEventListener('click', (e) => (e.stopPropagation(), run(path)));
    bar.append(b);
  }
  return bar;
}
