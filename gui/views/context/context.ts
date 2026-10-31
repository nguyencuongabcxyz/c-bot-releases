// The Context engine window (?view=context; app/src/context/window.rs): every folder the store
// holds down the side (which folds away to a rail: its button, or Ctrl+B), and the one picked in
// three pages: its Overview (its top with rings and
// numbers, its indexes one by one, every field of its index, its languages, its git), its Files
// (files.ts: every file, and one file's definitions and chunks) and the Store & models (the
// database, the disk, the models, every folder in a table, and deleting it all). Opened from a
// robot's menu or chat, it shows that robot's folder; each folder's status as it changes moves
// its rings and indexes, and a change of phase reads it all again. The bin at the top deletes the
// folder's index.
import * as ipc from '@/ipc';
import { $, el, iconButton } from '@/lib/dom';
import { showView } from '@/lib/page';
import { samePath } from '@/lib/text';
import type { ContextEngineDetails, ContextEngineStatus, ContextRepo, ContextWipe } from '@/types/model';
import { bar, pill } from '@/features/context/charts';
import {
  type Live,
  baseName,
  card,
  diskCard,
  gitCard,
  heroCard,
  indexCard,
  indexesCard,
  languagesCard,
  modelsCard,
  percent,
  phasePill,
  repoMeta,
  size,
  storeCard,
} from '@/features/context/details';
import { contextLabel } from '@/features/context/status';
import { forgetQuestion, wipeQuestion, wipedText } from '@/features/context/wipe';
import { createFilesTab } from './files';
import markup from './context.html?raw';
import '@/theme/theme.css';
import '@/theme/base.css';
import '@/features/context/context.css';
import './context.css';

showView(markup, { title: 'Context engine — C-Bot', bodyClass: 'cx' });

type Tab = 'overview' | 'files' | 'engine';
const TAB_KEY = 'context.tab';
const SIDE_KEY = 'context.side';
const count = (n: number) => n.toLocaleString('en-US');
/** A folder however it's written (the store's name for it, a robot's, a status's). */
const folderKey = (p: string) => samePath(p).replace(/\\+$/, '');

(() => {
  let details: ContextEngineDetails | null = null;
  let selected: string | null = null; // (its root, as the store names it)
  let tab: Tab = 'overview';
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (saved === 'files' || saved === 'engine') tab = saved;
  } catch {}
  const statuses = new Map<string, ContextEngineStatus>(); // (each folder's as it was last heard, by key)
  let live: Live[] = []; // (the Overview's parts that follow the status)
  let loaded = false; // (the folder picked is in memory: a robot reads it now)
  let seq = 0; // (a reading answered after another started is dropped)
  let busy = false; // (deleting: the buttons that delete wait)
  let noticeTimer = 0;
  const pages: Record<Tab, HTMLElement> = {
    overview: $('#page-overview'),
    files: $('#page-files'),
    engine: $('#page-engine'),
  };
  const filesTab = createFilesTab(pages.files);

  const repoOf = (root: string | null) =>
    root ? details?.repos.find((r) => folderKey(r.root) === folderKey(root)) : undefined;

  // ---------------------------------------------------------------- the folders, down the side

  function repoItem(r: ContextRepo): HTMLElement {
    const b = el('button', `repo${r.root === selected ? ' on' : ''}${r.open ? ' loaded' : ''}`);
    b.type = 'button';
    b.title = baseName(r.root);
    const s = statuses.get(folderKey(r.root));
    const top = el('span', 'repo-top');
    // (its first letter: all that shows of it while the side is folded away)
    top.append(el('span', 'repo-av', baseName(r.root).slice(0, 1).toUpperCase()), el('b', '', baseName(r.root)));
    if (s && r.open) {
      const p = phasePill(s);
      top.append(pill(contextLabel(s), p.tone, p.busy));
    }
    const tags = el('span', 'repo-tags');
    if (r.current) tags.append(pill('this robot', 0));
    if (r.open) tags.append(pill('loaded', 2));
    for (const robot of r.robots) tags.append(pill(robot, 1));
    b.append(top, el('small', 'repo-path', r.root), el('span', 'cx-muted', repoMeta(r)), tags);
    b.append(bar(r.chunks ? (r.embedded / r.chunks) * 100 : 0, 1));
    b.addEventListener('click', () => select(r.root));
    return b;
  }

  function drawRepos() {
    const repos = details?.repos ?? [];
    $('#repo-count').textContent = count(repos.length);
    const box = $('#repos');
    if (!repos.length) {
      box.replaceChildren(el('p', 'cx-muted', details?.store ? 'None indexed yet.' : 'The store isn’t running.'));
      return;
    }
    // (the robot's it was opened for first, then the ones loaded, then by name)
    const sorted = [...repos].sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        Number(b.open) - Number(a.open) ||
        baseName(a.root).localeCompare(baseName(b.root)),
    );
    box.replaceChildren(...sorted.map(repoItem));
  }

  function drawHeader() {
    const r = repoOf(selected);
    $('#repo-name').textContent = selected ? baseName(selected) : '';
    $('#repo-path').textContent = selected ?? '';
    $<HTMLButtonElement>('#reindex').disabled = !r?.open;
    $<HTMLButtonElement>('#forget').disabled = !r || busy;
  }

  // ---------------------------------------------------------------- the pages

  function drawTabs() {
    for (const b of document.querySelectorAll<HTMLElement>('#tabs [data-tab]')) {
      const on = b.dataset.tab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const [t, page] of Object.entries(pages)) page.hidden = t !== tab;
  }

  const storeDown = 'The context engine’s store isn’t running: switch the engine on for a robot from its chat first.';
  function nothing(page: HTMLElement, text: string) {
    page.replaceChildren(el('p', 'cx-muted empty', text));
  }

  /** The Overview of the folder picked. */
  async function drawOverview() {
    const page = pages.overview;
    if (!selected) return nothing(page, details?.store ? 'Pick a folder.' : storeDown);
    const mine = ++seq;
    try {
      const r = await ipc.contextRepo(selected);
      if (mine !== seq) return;
      loaded = r.loaded;
      const f = r.folder;
      const hero = heroCard(loaded ? f : null);
      const indexes = indexesCard();
      live = [hero, indexes];
      const parts: HTMLElement[] = [];
      if (!loaded) {
        const note = card('Not loaded', 'alert');
        note.classList.add('wide');
        note.append(
          el(
            'p',
            'cx-muted',
            'No robot with the context engine on reads this folder now: what’s here is what the store kept of it.',
          ),
        );
        parts.push(note);
      }
      hero.box.classList.add('wide');
      parts.push(hero.box, indexes.box, indexCard(f, loaded), languagesCard(f), gitCard(f.git));
      const grid = el('div', 'ov');
      grid.append(...parts);
      page.replaceChildren(grid);
      const s = (loaded && statuses.get(folderKey(selected))) || f.status;
      for (const l of live) l.update(s);
    } catch (e) {
      if (mine === seq) nothing(page, String(e));
    }
  }

  /** The store, the disk, the models, and every folder in a table. */
  function drawEngine() {
    const page = pages.engine;
    if (!details) return;
    const grid = el('div', 'ov');
    const repos = card('Repositories', 'folder', el('span', 'cx-muted', count(details.repos.length)));
    repos.classList.add('wide');
    repos.append(reposTable(details.repos));
    grid.append(storeCard(details.store), diskCard(details), modelsCard(details.models), repos, wipeCard(details));
    page.replaceChildren(grid);
  }

  /** Deleting the engine's data: every index (the downloads stay), or everything. */
  function wipeCard(d: ContextEngineDetails): HTMLElement {
    const box = card('Delete data', 'trash');
    box.classList.add('wide', 'cx-wipe');
    const models = downloads(d);
    const row = (what: ContextWipe, title: string, about: string) => {
      const li = el('li');
      const text = el('div');
      text.append(el('b', '', title), el('p', 'cx-muted', about));
      const b = iconButton('cx-open danger', title, 'trash', title);
      b.disabled = busy;
      b.addEventListener('click', () => wipe(what));
      li.append(text, b);
      return li;
    };
    const list = el('ul');
    list.append(
      row(
        'indexes',
        'Delete every index',
        `Every folder’s index: the database${d.store ? ` (${size(d.store.bytes)})` : ''} and the keyword indexes. The downloads stay.`,
      ),
      row(
        'everything',
        'Delete everything',
        `The indexes and the downloads too: PostgreSQL, the models and ONNX Runtime${models ? ` (${size(models)})` : ''}.`,
      ),
    );
    box.append(
      list,
      el(
        'p',
        'cx-muted',
        'Either switches the context engine off for every robot. One folder’s index: the bin at the top.',
      ),
    );
    return box;
  }

  /** The models' and ONNX Runtime's bytes. */
  const downloads = (d: ContextEngineDetails) => d.models.reduce((n, m) => n + m.bytes, 0);

  function reposTable(repos: ContextRepo[]): HTMLElement {
    const table = el('table', 'cx-table');
    const head = el('tr');
    for (const h of ['Folder', 'Read by', 'Files', 'Chunks', 'By meaning', 'Size', 'Generation'])
      head.append(el('th', '', h));
    table.append(el('thead'), el('tbody'));
    $('thead', table).append(head);
    for (const r of repos) {
      const tr = el('tr', r.root === selected ? 'on' : '');
      const name = el('td');
      name.append(el('b', '', baseName(r.root)), el('small', '', r.root));
      tr.append(
        name,
        el('td', '', r.robots.join(', ') || '—'),
        el('td', 'num', count(r.files)),
        el('td', 'num', count(r.chunks)),
        el('td', 'num', percent(r.embedded, r.chunks)),
        el('td', 'num', size(r.bytes)),
        el('td', 'num', count(r.generation)),
      );
      tr.addEventListener('click', () => {
        select(r.root);
        go('overview');
      });
      $('tbody', table).append(tr);
    }
    return table;
  }

  function drawTab() {
    drawTabs();
    if (tab === 'overview') void drawOverview();
    else if (tab === 'files') {
      if (selected) void filesTab.load(selected);
      else filesTab.clear(details?.store ? 'Pick a folder.' : storeDown);
    } else drawEngine();
  }

  function go(t: Tab) {
    tab = t;
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {}
    drawTab();
  }

  function select(root: string) {
    selected = repoOf(root)?.root ?? root;
    drawRepos();
    drawHeader();
    drawTab();
  }

  // ---------------------------------------------------------------- deleting

  /** A line under the tabs (gone again after a while, unless it's `sticky`). */
  function notice(text: string, sticky = false) {
    const p = $('#notice');
    p.textContent = text;
    p.hidden = false;
    clearTimeout(noticeTimer);
    if (!sticky) noticeTimer = window.setTimeout(() => (p.hidden = true), 12_000);
  }

  /** Delete something (`run` says what went), then read it all again: a folder gone, the next. */
  async function deleting(run: () => Promise<string>) {
    busy = true;
    drawHeader();
    if (tab === 'engine') drawEngine();
    notice('Deleting…', true);
    try {
      notice(await run());
    } catch (e) {
      notice(String(e));
    }
    busy = false;
    const d = await loadDetails();
    if (!repoOf(selected)) selected = d?.repos.find((r) => r.open)?.root ?? d?.repos[0]?.root ?? null;
    drawRepos();
    drawHeader();
    drawTab();
  }

  function forget() {
    const r = repoOf(selected);
    if (!r || busy || !confirm(forgetQuestion(r))) return;
    const what = `Deleted the index of ${baseName(r.root)}`;
    // (what its keyword index took: the database keeps the room for what's read next)
    void deleting(async () => wipedText(what, await ipc.contextForget(r.root), false));
  }

  function wipe(what: ContextWipe) {
    if (!details || busy || !confirm(wipeQuestion(what, downloads(details)))) return;
    const done = what === 'indexes' ? 'Deleted every index' : 'Deleted everything';
    void deleting(async () => wipedText(done, await ipc.contextWipe(what)));
  }

  // ---------------------------------------------------------------- reading

  /** Everything about the engine, read again (and the side drawn again). */
  async function loadDetails(): Promise<ContextEngineDetails | null> {
    try {
      details = await ipc.contextDetails();
    } catch (e) {
      details = null;
      nothing(pages.overview, String(e));
    }
    drawRepos();
    drawHeader();
    return details;
  }

  async function refresh() {
    await loadDetails();
    drawTab();
  }

  /** A folder's status: its rings and indexes move; a change of phase reads it all again. */
  function onStatus({ root, status }: { root: string; status: ContextEngineStatus }) {
    const k = folderKey(root);
    const was = statuses.get(k)?.phase;
    statuses.set(k, status);
    const mine = selected !== null && folderKey(selected) === k;
    if (mine && loaded) for (const l of live) l.update(status);
    if (was === status.phase) return;
    void loadDetails().then(() => {
      if (!mine) return;
      if (tab === 'overview') void drawOverview();
      else if (tab === 'files' && status.phase === 'ready' && selected) void filesTab.load(selected);
      else if (tab === 'engine') drawEngine();
    });
  }

  // the side folds away to a rail of first letters (and back), and stays as you left it
  function fold(off: boolean) {
    document.body.classList.toggle('side-off', off);
    $('#side').setAttribute('aria-expanded', String(!off));
    try {
      localStorage.setItem(SIDE_KEY, off ? 'off' : '');
    } catch {}
  }
  try {
    fold(localStorage.getItem(SIDE_KEY) === 'off');
  } catch {}
  $('#side').addEventListener('click', () => fold(!document.body.classList.contains('side-off')));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      fold(!document.body.classList.contains('side-off'));
    }
  });

  for (const b of document.querySelectorAll<HTMLElement>('#tabs [data-tab]'))
    b.addEventListener('click', () => {
      const t = b.dataset.tab;
      if (t === 'overview' || t === 'files' || t === 'engine') go(t);
    });
  $('#refresh').addEventListener('click', () => void refresh());
  $('#forget').addEventListener('click', forget);
  $('#reindex').addEventListener('click', () => {
    if (selected) void ipc.contextReindex(selected).catch((e) => nothing(pages.overview, String(e)));
  });
  ipc.on('context:status', onStatus);
  ipc.on('context:focus', (root) => select(root));

  void (async () => {
    const init = await ipc.contextInit().catch(() => ({ focus: null }));
    const d = await loadDetails();
    const first = init.focus ?? d?.repos.find((r) => r.open)?.root ?? d?.repos[0]?.root ?? null;
    if (first) select(first);
    else drawTab();
  })();
})();
