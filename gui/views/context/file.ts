// One file of a folder's index, opened up in the Context engine window's Files (files.ts): its
// name and numbers on top, with buttons to give it the whole page, open it, show it in its
// folder or close it; then its definitions as the code tools read them, or its chunks as search
// finds them (a table each, filtered by words), beside its text (source.ts), a divider between
// them to drag. A definition or chunk picked is marked in the text and scrolled to; a line of
// the text clicked picks the definition (or chunk) it's in.
import * as ipc from '@/ipc';
import { el, iconButton } from '@/lib/dom';
import { Icon } from '@/icons/icons';
import type { ContextChunk, ContextDef, ContextFile, ContextFileIndex } from '@/types/model';
import { pill } from '@/features/context/charts';
import { percent, size } from '@/features/context/details';
import { chunkOf, defAt, lines, matching, splitPath } from '@/features/context/files';
import { createSource } from './source';
import { splitter } from './split';
import { createTable } from './table';

const count = (n: number) => n.toLocaleString('en-US');
const ROW = 30;

type DefKey = 'kind' | 'name' | 'lines';
type ChunkKey = 'idx' | 'lines' | 'symbol' | 'vector';

/** What the pane uses of the Files: the folder it's in, closing it, and giving it the page. */
export type FilePaneNeeds = {
  readonly root: () => string | null;
  readonly close: () => void;
  readonly focus: (on: boolean) => void;
};

/** What a definition is, in a word short enough for its column. */
const KIND_SHORT: Record<ContextDef['kind'], string> = {
  module: 'mod',
  class: 'class',
  struct: 'struct',
  interface: 'iface',
  trait: 'trait',
  enum: 'enum',
  type: 'type',
  impl: 'impl',
  function: 'fn',
  method: 'method',
  constructor: 'ctor',
  property: 'prop',
  const: 'const',
  macro: 'macro',
};

function defCell(d: ContextDef, key: DefKey): string | Node {
  switch (key) {
    case 'kind':
      return el('span', `cx-kind k-${d.kind}`, KIND_SHORT[d.kind]);
    case 'name': {
      const box = el('span', 'fd-def');
      box.style.paddingLeft = `${Math.min(d.depth, 6) * 12}px`;
      box.append(el('b', '', d.name));
      if (d.container) box.append(el('small', '', d.container));
      return box;
    }
    case 'lines':
      return lines(d.line, d.end);
  }
}

function chunkCell(c: ContextChunk, key: ChunkKey): string | Node {
  switch (key) {
    case 'idx':
      return `#${c.idx}`;
    case 'lines':
      return lines(c.from, c.to);
    case 'symbol': {
      const box = el('span', 'fd-def');
      box.append(el('b', '', c.symbol || '(no definition)'));
      if (!c.code) box.append(el('small', '', 'doc'));
      return box;
    }
    case 'vector':
      // (a dot: green once it has its vector)
      return el('i', `fd-vec${c.embedded ? ' on' : ''}`);
  }
}

export function createFilePane(n: FilePaneNeeds) {
  let file: ContextFileIndex | null = null;
  let sub: 'defs' | 'chunks' = 'defs';
  let query = '';
  let rows = { defs: [] as number[], chunks: [] as number[] }; // (the ones the words keep)
  let pickedDef = -1;
  let pickedChunk = -1;
  let focused = false;
  let seq = 0; // (a reading answered after another started is dropped)

  // on top: its name, its numbers, its buttons
  const root = el('section', 'fd');
  const head = el('div', 'fd-head');
  const name = el('span', 'ft-name');
  const stats = el('span', 'fd-stats');
  const focus = iconButton('cx-btn', 'Whole page', 'expand');
  const open = iconButton('cx-btn', 'Open file', 'open');
  const reveal = iconButton('cx-btn', 'Show in folder', 'folder');
  const close = iconButton('cx-btn', 'Close', 'x');
  head.append(name, stats, focus, open, reveal, close);

  // its definitions or chunks, beside its text
  const body = el('div', 'fd-body');
  const side = el('div', 'fd-side');
  const tabs = el('div', 'fd-tabs');
  const [defsTab, chunksTab] = [el('button', 'fd-tab'), el('button', 'fd-tab')];
  for (const t of [defsTab, chunksTab]) t.type = 'button';
  tabs.append(defsTab, chunksTab);
  const filter = el('input', 'fd-filter');
  filter.type = 'search';
  const defs = createTable<DefKey>({
    columns: [
      { key: 'kind', label: 'Kind', width: '50px' },
      { key: 'name', label: 'Name', width: 'minmax(0, 1fr)' },
      { key: 'lines', label: 'Lines', width: '52px', num: true },
    ],
    rowHeight: ROW,
    cell: (i, key) => {
      const d = file?.defs[rows.defs[i]];
      return d ? defCell(d, key) : '';
    },
    current: () => rows.defs.indexOf(pickedDef),
    onPick: (i) => pickDef(rows.defs[i]),
  });
  const chunks = createTable<ChunkKey>({
    columns: [
      { key: 'idx', label: '#', width: '36px' },
      { key: 'symbol', label: 'About', width: 'minmax(0, 1fr)' },
      { key: 'lines', label: 'Lines', width: '62px', num: true },
      { key: 'vector', label: 'Vec', width: '30px' },
    ],
    rowHeight: ROW,
    cell: (i, key) => {
      const c = file?.chunks[rows.chunks[i]];
      return c ? chunkCell(c, key) : '';
    },
    current: () => rows.chunks.indexOf(pickedChunk),
    onPick: (i) => pickChunk(rows.chunks[i]),
  });
  side.append(tabs, filter, defs.root, chunks.root);
  const source = createSource(onLine);
  body.append(side, splitter(body, 'context.split.file', 0.34), source.root);
  root.append(head, body);

  // ---------------------------------------------------------------- picking

  function pickDef(i: number) {
    const d = file?.defs[i];
    if (!file || !d) return;
    pickedDef = i;
    const c = chunkOf(file.chunks, d.line);
    pickedChunk = c ? file.chunks.indexOf(c) : -1;
    source.pick({ from: d.line, to: d.end, chunk: pickedChunk });
    redraw();
  }

  function pickChunk(i: number) {
    const c = file?.chunks[i];
    if (!c) return;
    pickedChunk = i;
    pickedDef = -1;
    source.pick({ from: c.from, to: c.to, chunk: i });
    redraw();
  }

  /** A line of the text clicked: the definition it's in (or the chunk, on the Chunks). */
  function onLine(line: number) {
    if (!file) return;
    if (sub === 'defs') {
      const i = defAt(file.defs, line);
      if (i >= 0) {
        pickDef(i);
        return inView(defs, rows.defs.indexOf(i));
      }
    }
    const c = chunkOf(file.chunks, line);
    if (!c) return;
    const i = file.chunks.indexOf(c);
    pickChunk(i);
    if (sub === 'chunks') inView(chunks, rows.chunks.indexOf(i));
  }
  /** A row of a table scrolled into view (if the words keep it). */
  function inView(t: { reveal: (i: number) => void }, row: number) {
    if (row >= 0) t.reveal(row);
  }

  // ---------------------------------------------------------------- drawing

  function redraw() {
    defs.redraw();
    chunks.redraw();
  }

  function fill() {
    if (!file) return;
    rows = {
      defs: matching(file.defs, query, (d) => `${d.name} ${d.container ?? ''} ${d.kind}`),
      chunks: matching(file.chunks, query, (c) => `#${c.idx} ${c.symbol}`),
    };
    defsTab.textContent = `Definitions (${count(file.defs.length)})`;
    chunksTab.textContent = `Chunks (${count(file.chunks.length)})`;
    defsTab.classList.toggle('on', sub === 'defs');
    chunksTab.classList.toggle('on', sub === 'chunks');
    defs.root.hidden = sub !== 'defs';
    chunks.root.hidden = sub !== 'chunks';
    filter.placeholder = sub === 'defs' ? 'Filter definitions…' : 'Filter chunks…';
    const none = query ? 'Nothing matches.' : undefined;
    defs.setCount(rows.defs.length, none ?? 'None: the tools read it as a document.');
    chunks.setCount(rows.chunks.length, none ?? 'No chunks.');
  }

  function drawHead(f: ContextFile | undefined, path: string) {
    const { dir, name: base } = splitPath(path);
    name.innerHTML = Icon(f?.code === false ? 'note' : 'file', 'sm');
    name.append(el('b', '', base), el('small', '', dir));
    stats.replaceChildren();
    if (!f) return;
    stats.append(
      pill(f.kind, f.code ? 0 : 1),
      el('span', '', size(f.bytes)),
      el('span', '', `${count(f.defs)} defs`),
      el('span', '', `${count(f.chunks)} chunks`),
      el('span', '', `${percent(f.embedded, f.chunks)} by meaning`),
    );
  }

  function setFocus(on: boolean) {
    focused = on;
    focus.innerHTML = Icon(on ? 'collapse' : 'expand', 'sm');
    focus.title = on ? 'Back to the list' : 'Whole page';
    n.focus(on);
  }

  // ---------------------------------------------------------------- reading

  /** Open `path` (`f`: its row in the list): its definitions and chunks, and its text. */
  async function openFile(path: string, f?: ContextFile) {
    const folder = n.root();
    if (!folder) return;
    const same = file?.path === path;
    drawHead(f, path);
    if (!same) {
      file = null;
      pickedDef = -1;
      pickedChunk = -1;
      defs.top();
      chunks.top();
      defs.setCount(0, 'Reading…');
      chunks.setCount(0, 'Reading…');
      source.say('Reading…');
    }
    const mine = ++seq;
    const [index, text] = await Promise.all([
      ipc.contextFile(folder, path).catch((e) => new Error(String(e))),
      ipc.contextSource(folder, path).catch((e) => new Error(String(e))),
    ]);
    if (mine !== seq) return;
    if (index instanceof Error) {
      file = null;
      defs.setCount(0, index.message);
      chunks.setCount(0, index.message);
      source.say(index.message);
      return;
    }
    file = index;
    fill();
    if (text instanceof Error) source.say(text.message);
    else source.show(text, path.split('.').pop()?.toLowerCase() ?? '', file.chunks);
    if (pickedDef >= 0) pickDef(pickedDef);
    else if (pickedChunk >= 0) pickChunk(pickedChunk);
  }

  for (const [t, which] of [
    [defsTab, 'defs'],
    [chunksTab, 'chunks'],
  ] as const)
    t.addEventListener('click', () => {
      sub = which;
      fill();
    });
  filter.addEventListener('input', () => {
    query = filter.value;
    fill();
  });
  focus.addEventListener('click', () => setFocus(!focused));
  open.addEventListener('click', () => {
    if (file) void ipc.contextOpen(file.full, false);
  });
  reveal.addEventListener('click', () => {
    if (file) void ipc.contextOpen(file.full, true);
  });
  close.addEventListener('click', () => n.close());

  return {
    root,
    open: openFile,
    /** Closed: back to nothing, and off the whole page. */
    clear() {
      seq++;
      file = null;
      if (focused) setFocus(false);
    },
    focused: () => focused,
    setFocus,
  };
}
export type FilePane = ReturnType<typeof createFilePane>;
