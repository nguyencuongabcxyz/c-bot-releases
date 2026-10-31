// The Context engine window's Files: every file of a folder's index in a table (filtered by words
// in its path and by kind, sorted by any column; only the rows in view are drawn, so thousands
// scroll smoothly), and the file picked beside it (file.ts), a divider between them to drag. The
// file can have the whole page; Esc gives it back, then closes it. The arrows walk the list.
import * as ipc from '@/ipc';
import { el } from '@/lib/dom';
import { Icon } from '@/icons/icons';
import type { ContextFile } from '@/types/model';
import { bar, pill } from '@/features/context/charts';
import { percent, size } from '@/features/context/details';
import {
  type FilesOrder,
  type FilesSort,
  fileKinds,
  filesLine,
  pickFiles,
  splitPath,
  vectors,
} from '@/features/context/files';
import { createFilePane } from './file';
import { splitter } from './split';
import { createTable } from './table';

const count = (n: number) => n.toLocaleString('en-US');
const ROW = 32;

function fileCell(f: ContextFile, key: FilesSort): string | Node {
  switch (key) {
    case 'path': {
      const { dir, name } = splitPath(f.path);
      const box = el('span', 'ft-name');
      box.innerHTML = Icon(f.code ? 'file' : 'note', 'sm');
      box.append(el('b', '', name), el('small', '', dir));
      return box;
    }
    case 'kind':
      return pill(f.kind, f.code ? 0 : 1);
    case 'defs':
      return count(f.defs);
    case 'chunks':
      return count(f.chunks);
    case 'vectors': {
      const box = el('span', 'ft-vec');
      box.append(bar(vectors(f) * 100, 1), el('span', '', percent(f.embedded, f.chunks)));
      return box;
    }
    case 'bytes':
      return size(f.bytes);
  }
}

/** The Files tab, in `box`. */
export function createFilesTab(box: HTMLElement) {
  let root: string | null = null;
  let all: ContextFile[] = [];
  let shown: ContextFile[] = [];
  let query = '';
  let kind = '';
  let order: FilesOrder = { by: 'path', desc: false };
  let picked: string | null = null;
  let seq = 0; // (a reading answered after another started is dropped)

  // the bar: words, kind, what they add up to
  const top = el('div', 'ft-bar');
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Filter by path…';
  const kinds = el('select');
  kinds.title = 'Kind';
  const line = el('span', 'cx-muted ft-line');
  top.append(search, kinds, line);

  const files = createTable<FilesSort>({
    columns: [
      { key: 'path', label: 'File', width: 'minmax(110px, 2.6fr)', sorts: true },
      { key: 'kind', label: 'Kind', width: 'minmax(80px, 1fr)', sorts: true, spare: true },
      { key: 'defs', label: 'Definitions', width: '86px', num: true, sorts: true },
      { key: 'chunks', label: 'Chunks', width: '64px', num: true, sorts: true, spare: true },
      { key: 'vectors', label: 'By meaning', width: '104px', sorts: true, spare: true },
      { key: 'bytes', label: 'Size', width: '70px', num: true, sorts: true, spare: true },
    ],
    rowHeight: ROW,
    cell: (i, key) => fileCell(shown[i], key),
    current: () => shown.findIndex((f) => f.path === picked),
    onPick: (i) => openFile(shown[i].path),
    onSort: (by) => {
      order = { by, desc: order.by === by ? !order.desc : by !== 'path' && by !== 'kind' };
      fill();
    },
  });

  const split = el('div', 'ft-split');
  const pane = createFilePane({
    root: () => root,
    close: closeFile,
    focus: (on) => split.classList.toggle('focus', on),
  });
  pane.root.hidden = true;
  const divider = splitter(split, 'context.split.files', 0.3);
  split.append(files.root, divider, pane.root);
  box.replaceChildren(top, split);

  // ---------------------------------------------------------------- the list

  function fill() {
    shown = pickFiles(all, query, kind, order);
    line.textContent = filesLine(shown);
    files.setOrder(order.by, order.desc);
    files.setCount(shown.length, all.length ? 'No file matches.' : 'Nothing indexed yet.');
  }

  function fillKinds() {
    kinds.replaceChildren(new Option('All kinds', ''));
    for (const k of fileKinds(all))
      kinds.append(new Option(`${k.name} (${count(k.files)})`, k.name, false, k.name === kind));
  }

  search.addEventListener('input', () => {
    query = search.value;
    fill();
  });
  kinds.addEventListener('change', () => {
    kind = kinds.value;
    fill();
  });

  // ---------------------------------------------------------------- the file picked

  function openFile(path: string) {
    picked = path;
    files.redraw();
    split.classList.add('picked');
    files.compact(true);
    pane.root.hidden = false;
    void pane.open(
      path,
      all.find((f) => f.path === path),
    );
  }

  function closeFile() {
    picked = null;
    pane.clear();
    pane.root.hidden = true;
    split.classList.remove('picked');
    files.compact(false);
    files.redraw();
  }

  // Esc: the file gives the page back, then closes
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || box.hidden || !picked) return;
    if (e.target instanceof HTMLInputElement && e.target.value) return; // (it clears the words first)
    if (pane.focused()) pane.setFocus(false);
    else closeFile();
  });

  // ---------------------------------------------------------------- reading

  /** Read the files of `folder` (another folder: from the top, nothing picked). */
  async function load(folder: string) {
    const fresh = folder !== root;
    root = folder;
    if (fresh) {
      all = [];
      kind = '';
      closeFile();
      files.top();
      line.textContent = 'Reading…';
      fill();
    }
    const mine = ++seq;
    try {
      const d = await ipc.contextFiles(folder);
      if (mine !== seq) return;
      all = d.files;
      fillKinds();
      fill();
      if (picked) openFile(picked);
    } catch (e) {
      if (mine === seq) line.textContent = String(e);
    }
  }

  /** No folder to show (its index deleted): an empty list, and why. */
  function clear(why: string) {
    root = null;
    seq++;
    all = [];
    kind = '';
    closeFile();
    fillKinds();
    fill();
    line.textContent = why;
  }

  return { clear, load, root: () => root };
}
export type FilesTab = ReturnType<typeof createFilesTab>;
