// The context engine's details, in words and in cards, for the chat's panel (the robot's own
// folder) and the Context engine window (any folder, the store, the models): a folder's top (how
// far it's read and embedded, in rings that move as it goes, and its numbers), its indexes one by
// one, every field of its index, its languages, its git branch; the disk the engine takes, the
// store's PostgreSQL and the models. The words are pure (tested); the charts are charts.ts.
import { el } from '@/lib/dom';
import { Icon } from '@/icons/icons';
import type {
  ContextEngineDetails,
  ContextEngineStatus,
  ContextFolderDetails,
  ContextGit,
  ContextModel,
  ContextRepo,
  ContextStoreDetails,
} from '@/types/model';
import { type Share, type Tone, bar, legend, pill, ring, setRing, setTile, shares, stack, tile } from './charts';
import { type IndexState, indexStates } from './status';

/** A part drawn that follows a folder's status as it changes. */
export type Live = { box: HTMLElement; update: (s: ContextEngineStatus) => void };

/** A folder's status before anything's known of it. */
export const OFF: ContextEngineStatus = {
  phase: 'off',
  files: 0,
  chunks: 0,
  embedded: 0,
  symbols: 0,
  calls: 0,
  graph: false,
  done: 0,
  total: 0,
  capped: false,
  note: null,
  error: null,
};

const count = (n: number) => n.toLocaleString('en-US');

/** A size in bytes, as people read it: "512 B", "3.4 MB". */
export function size(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** How long ago a time was: "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** A part of a whole, as a percentage ("–" of nothing). */
export const percent = (part: number, whole: number) => (whole ? `${Math.floor((part / whole) * 100)}%` : '–');

/** A folder's own name: the last part of its path. */
export const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p;

/** What the folder's state says on its pill. */
export function phasePill(s: ContextEngineStatus): { text: string; tone: Tone; busy: boolean } {
  switch (s.phase) {
    case 'off':
      return { text: 'Off', tone: 5, busy: false };
    case 'installing':
      return { text: 'Setting up', tone: 0, busy: true };
    case 'indexing':
      return { text: 'Reading', tone: 0, busy: true };
    case 'ready':
      return { text: 'Ready', tone: 2, busy: false };
    case 'failed':
      return { text: 'Failed', tone: 4, busy: false };
  }
}

/** A ring's share (null: nothing to show yet), the line under it, and whether it's moving. */
type Progress = { pct: number | null; sub: string; busy: boolean };

/** How far reading the folder has got. */
export function readProgress(s: ContextEngineStatus): Progress {
  switch (s.phase) {
    case 'installing':
      return { pct: null, sub: s.note ?? 'setting up…', busy: true };
    case 'indexing':
      return s.total
        ? { pct: (s.done / s.total) * 100, sub: `${count(s.done)} / ${count(s.total)} files`, busy: true }
        : { pct: null, sub: 'looking for files…', busy: true };
    case 'ready':
      return { pct: 100, sub: `${count(s.files)} files${s.capped ? ' (not all)' : ''}`, busy: false };
    default:
      return { pct: null, sub: s.phase === 'failed' ? (s.error ?? 'failed') : 'off', busy: false };
  }
}

/** How far search by meaning has got (its chunks with their vectors). */
export function meaningProgress(s: ContextEngineStatus): Progress {
  if (!s.chunks) return { pct: null, sub: s.note ?? 'no chunks yet', busy: false };
  const busy = s.phase === 'ready' && s.embedded < s.chunks;
  return {
    pct: (s.embedded / s.chunks) * 100,
    sub: s.note ?? `${count(s.embedded)} / ${count(s.chunks)} chunks`,
    busy,
  };
}

export const ROLE: Record<ContextModel['role'], string> = {
  sentence: 'Search model',
  reranker: 'Reranker',
  runtime: 'ONNX Runtime',
};

/** What the engine takes on disk, by part. */
export function diskShares(d: ContextEngineDetails): Share[] {
  return shares(
    [
      { name: 'Database', value: d.store?.bytes ?? 0 },
      ...d.models.map((m) => ({ name: ROLE[m.role], value: m.bytes })),
      { name: 'Keyword index', value: d.folder?.keywordBytes ?? 0 },
    ],
    6,
  );
}

/** A repository's line under its name. */
export function repoMeta(r: ContextRepo): string {
  return [`${count(r.files)} files`, `${count(r.chunks)} chunks`, size(r.bytes)].join(' · ');
}

const yes = (b: boolean) => (b ? 'yes' : 'no');

/** Every field of the folder's index, as rows; `loaded`: a robot reads it now (else only what
 * the store knows of it). */
export function indexRows(f: ContextFolderDetails, loaded = true, now = Date.now()): [string, string][] {
  const s = f.status;
  const all: [string, string][] = [
    ['Folder', f.root],
    ['State', loaded ? phasePill(s).text : 'Not loaded: no robot with the engine on reads it now'],
    ['Files', `${count(s.files)}${s.capped ? ' (not all: the folder has more)' : ''}`],
    ['Code files', count(f.languages.reduce((n, l) => n + l.files, 0))],
    ['Docs', count(f.docs)],
    ['Definitions', count(s.symbols)],
    ['Calls', f.graphBuilt ? count(s.calls) : 'not built yet'],
    ['Chunks', count(s.chunks)],
    ['By meaning', `${count(s.embedded)} of ${count(s.chunks)} (${percent(s.embedded, s.chunks)})`],
    ['Vectors in memory', count(f.vectorsInMemory)],
    ['Keyword index', size(f.keywordBytes)],
    ['Watched', f.watched ? 'yes, for changes as you save' : 'no: looked at again before it’s asked'],
    ['Read', f.readAt ? `${new Date(f.readAt).toLocaleString()} (${ago(f.readAt, now)})` : 'not yet'],
    ['Code graph', yes(f.graphBuilt)],
  ];
  const memory = new Set(['Calls', 'Vectors in memory', 'Watched', 'Read', 'Code graph']);
  const rows = loaded ? all : all.filter(([k]) => !memory.has(k));
  if (s.phase === 'indexing') rows.push(['Reading', `${count(s.done)} of ${count(s.total)}`]);
  if (s.note) rows.push(['Now', s.note]);
  if (s.error) rows.push(['Error', s.error]);
  return rows;
}

/** An index's state, as its dot's tone (accent while it's made, muted while it waits). */
export const INDEX_TONE: Record<IndexState, Tone> = { off: 5, wait: 5, work: 0, ready: 2, failed: 4 };

// ---------------------------------------------------------------- drawing

/** A card: its title with its icon (and something on the right of it). */
export function card(title: string, icon: string, extra?: HTMLElement): HTMLElement {
  const box = el('section', 'cx-card');
  const head = el('h3');
  head.innerHTML = Icon(icon, 'sm');
  head.append(el('span', '', title));
  if (extra) head.append(extra);
  box.append(head);
  return box;
}

/** Names and what each is, two columns. */
export function rows(pairs: [string, string][]): HTMLElement {
  const dl = el('dl', 'cx-rows');
  for (const [k, v] of pairs) dl.append(el('dt', '', k), el('dd', '', v));
  return dl;
}

/** A folder's top: its state, its rings and its numbers (`f`, what's known of it besides). */
export function heroCard(f: ContextFolderDetails | null): Live {
  const box = el('section', 'cx-hero');
  const top = el('div', 'cx-hero-top');
  const state = el('span', 'cx-state');
  const meta = el('span', 'cx-muted');
  top.append(state, meta);
  const rings = el('div', 'cx-rings');
  const read = ring('Indexed', 0);
  const meaning = ring('By meaning', 1);
  rings.append(read, meaning);
  const tiles = el('div', 'cx-tiles');
  const [files, defs, calls, chunks] = [
    tile('file', 'Files'),
    tile('search', 'Definitions'),
    tile('map', 'Calls'),
    tile('box', 'Chunks'),
  ];
  tiles.append(files, defs, calls, chunks);
  box.append(top, rings, tiles);
  const update = (s: ContextEngineStatus) => {
    const p = phasePill(s);
    state.replaceChildren(pill(p.text, p.tone, p.busy));
    const watch = f ? (f.watched ? 'watching for changes' : 'not watched') : '';
    const when = f?.readAt ? ` · read ${ago(f.readAt)}` : '';
    meta.textContent = `${watch}${when}`;
    const r = readProgress(s);
    setRing(read, r.pct, r.sub, r.busy);
    const m = meaningProgress(s);
    setRing(meaning, m.pct, m.sub, m.busy);
    setTile(files, count(s.files));
    setTile(defs, count(s.symbols));
    setTile(calls, s.graph || s.calls ? count(s.calls) : '…');
    setTile(chunks, count(s.chunks));
  };
  return { box, update };
}

/** The folder's indexes one by one: a dot for how each is, a line about it, a bar while it's made. */
export function indexesCard(): Live {
  const box = card('Indexes', 'zap');
  const list = el('ul', 'cx-indexes');
  box.append(list);
  const update = (s: ContextEngineStatus) => {
    list.replaceChildren(
      ...indexStates(s).map((i) => {
        const li = el('li', `t${INDEX_TONE[i.state]} ${i.state}`);
        li.append(el('i', 'cx-dot'), el('b', '', i.name), el('span', 'cx-muted', i.detail));
        // (no telling how far: a piece of bar sliding along)
        if (i.state === 'work') li.append(bar(i.pct ?? 40, 0));
        if (i.state === 'work' && i.pct === null) li.classList.add('vague');
        return li;
      }),
    );
  };
  return { box, update };
}

/** Every field of the folder's index. */
export function indexCard(f: ContextFolderDetails, loaded = true): HTMLElement {
  const box = card('Index', 'search');
  box.append(rows(indexRows(f, loaded)));
  return box;
}

export function languagesCard(f: ContextFolderDetails): HTMLElement {
  const parts = shares(
    [...f.languages.map((l) => ({ name: l.name, value: l.files })), { name: 'Docs', value: f.docs }],
    8,
  );
  const box = card('Languages', 'file');
  if (!parts.length) box.append(el('p', 'cx-muted', 'No files read yet.'));
  else
    box.append(
      stack(parts),
      legend(parts, (s) => `${count(s.value)} · ${Math.round(s.pct)}%`),
    );
  return box;
}

export function gitCard(g: ContextGit | null): HTMLElement {
  const branch = g ? pill(g.branch, 1) : undefined;
  const box = card('Git', 'history', branch);
  if (!g) {
    box.append(el('p', 'cx-muted', 'Not a git repository (or no commit yet).'));
    return box;
  }
  const commit = el('div', 'cx-commit');
  commit.append(el('code', '', g.head), el('span', '', g.subject));
  box.append(commit, el('p', 'cx-muted', `${g.author} · ${g.when}`));
  box.append(g.changed ? pill(`${count(g.changed)} files not committed`, 3) : pill('Nothing to commit', 2));
  return box;
}

export function diskCard(d: ContextEngineDetails): HTMLElement {
  const parts = diskShares(d);
  const total = parts.reduce((n, s) => n + s.value, 0);
  const box = card('Disk', 'box', el('span', 'cx-muted', size(total)));
  if (parts.length)
    box.append(
      stack(parts),
      legend(parts, (s) => size(s.value)),
    );
  box.append(el('p', 'cx-path', d.dir));
  return box;
}

export function storeCard(s: ContextStoreDetails | null): HTMLElement {
  const box = card('Store', 'box', s ? pill(`PostgreSQL ${s.version}`, 0) : pill('not running', 5));
  if (!s) {
    box.append(el('p', 'cx-muted', 'Its database starts when a robot with the engine on needs it.'));
    return box;
  }
  box.append(
    rows([
      ['Address', `127.0.0.1:${s.port}`],
      ['Started by', s.startedHere ? 'this C-Bot (stops when it quits)' : 'an earlier C-Bot (joined)'],
      ['Size', size(s.bytes)],
      ...s.vectors.map((v): [string, string] => ['Vectors', `${count(v.count)} · ${v.model}`]),
    ]),
    el('p', 'cx-path', s.dataDir),
  );
  return box;
}

export function modelsCard(models: ContextModel[]): HTMLElement {
  const box = card('Models', 'cpu');
  const list = el('ul', 'cx-models');
  for (const m of models) {
    const li = el('li');
    const state = !m.downloaded ? pill('not downloaded', 5) : m.loaded ? pill('loaded', 2) : pill('downloaded', 0);
    const name = el('div');
    name.append(el('b', '', ROLE[m.role]), el('div', 'cx-muted', m.name));
    li.append(name, el('span', 'cx-muted', m.bytes ? size(m.bytes) : ''), state);
    list.append(li);
  }
  box.append(list);
  return box;
}
