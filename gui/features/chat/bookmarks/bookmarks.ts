// Bookmarked messages: a question or an answer marked to come back to (the flag on its hover
// buttons), and the list of a tab's bookmarks dropped down from the title bar to jump back to
// one. Kept on its history entry in main (app/src/features/chat/bookmarks.rs), by its `at`.
// (robot.ts calls createBookmarks with its hub.)
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { ChatTab } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { $, el, iconButton } from '@/lib/dom';
import { Icon } from '@/icons/icons';
import { type Mark, marksOf, snippet } from './marks';

/** What it uses of the robot window (robot.ts's hub). */
export type BookmarksNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly renderHistory: (tab: ChatTab, from?: number) => void;
  readonly showPop: DeskActivityApi['showPop'];
};

const FLASH_MS = 1600;

export function createBookmarks(r: BookmarksNeeds) {
  const button = $('#btn-marks');
  const pop = $('#marks-pop');
  const list = $('#mk-list');
  const placed = new WeakMap<HTMLElement, { tab: ChatTab; at: number; role: Mark['role'] }>();
  const shown = new Map<string, Map<number, HTMLElement>>(); // tab id -> at -> its message on the page
  const changed = new Map<string, Map<number, Mark | null>>(); // tab id -> marked (or not) since its history came
  let listening: AbortController | null = null;

  function changedOf(tab: ChatTab) {
    const mine = changed.get(tab.id) ?? new Map<number, Mark | null>();
    changed.set(tab.id, mine);
    return mine;
  }
  const marksIn = (tab: ChatTab) => marksOf(tab.data?.history || [], changedOf(tab));
  const isMarked = (tab: ChatTab, at: number) => marksIn(tab).some((m) => m.at === at);

  /** A question or answer on the page, and where it is in the history: it can be bookmarked. */
  function attach(msg: HTMLElement, at: number | null | undefined, tab: ChatTab) {
    if (at == null) return;
    const role = msg.classList.contains('user') ? 'user' : 'assistant';
    placed.set(msg, { tab, at, role });
    const mine = shown.get(tab.id) ?? new Map<number, HTMLElement>();
    // (messages since taken off the page, the chat redrawn or trimmed: not kept alive here)
    for (const [k, m] of mine) if (!m.isConnected) mine.delete(k);
    shown.set(tab.id, mine.set(at, msg));
    let bar = msg.querySelector(':scope > .msg-actions');
    if (!bar) bar = msg.appendChild(el('div', 'msg-actions'));
    bar.querySelector('.mark-btn')?.remove();
    const b = iconButton('mark-btn', 'Bookmark', 'flag');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      void toggle(msg);
    });
    bar.prepend(b);
    paint(msg, isMarked(tab, at));
    if (tab === r.active()) refresh();
  }

  function paint(msg: HTMLElement, on: boolean) {
    msg.classList.toggle('bookmarked', on);
    const b = msg.querySelector<HTMLElement>(':scope > .msg-actions > .mark-btn');
    if (b) b.title = on ? 'Remove bookmark' : 'Bookmark';
  }

  async function toggle(msg: HTMLElement) {
    const p = placed.get(msg);
    if (!p) return;
    const on = !isMarked(p.tab, p.at);
    if (!(await ipc.robotBookmark(p.tab.id, p.at, on))) {
      r.showPop('I can’t bookmark that one any more.', 2000);
      return;
    }
    const h = p.tab.data?.history.find((h) => h.at === p.at);
    const text = h && 'text' in h ? h.text : textOf(msg);
    changedOf(p.tab).set(p.at, on ? { at: p.at, role: p.role, text } : null);
    paint(msg, on);
    r.showPop(on ? 'Bookmarked! 🚩' : 'Bookmark taken off.', 1200);
    refresh();
  }

  // (a live message's words: the page's, without its buttons)
  function textOf(msg: HTMLElement) {
    const copy = msg.cloneNode(true) as HTMLElement; // (cloneNode keeps the type)
    for (const x of copy.querySelectorAll('.msg-actions, .queue-actions, .usage, .stage-tag')) x.remove();
    return copy.textContent ?? '';
  }

  /** The title bar's button shows while the tab on view has bookmarks; the list follows. */
  function refresh() {
    const tab = r.active();
    const marks = tab ? marksIn(tab) : [];
    button.hidden = !marks.length;
    if (!pop.hidden) {
      if (marks.length && tab) render(tab, marks);
      else close();
    }
  }

  function render(tab: ChatTab, marks: Mark[]) {
    list.innerHTML = '';
    list.append(...marks.map((m) => row(tab, m)));
  }

  function row(tab: ChatTab, m: Mark) {
    const item = el('div', 'mk-item');
    const who = el('span', 'mk-who');
    who.innerHTML = Icon(m.role === 'user' ? 'chat' : 'bot', 'sm');
    const text = el('span', 'mk-text', snippet(m.text));
    const drop = iconButton('mk-act', 'Remove bookmark', 'x');
    drop.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!(await ipc.robotBookmark(tab.id, m.at, false))) return;
      changedOf(tab).set(m.at, null);
      const msg = shown.get(tab.id)?.get(m.at);
      if (msg) paint(msg, false);
      refresh();
    });
    item.append(who, text, drop);
    item.addEventListener('click', () => {
      close();
      jump(tab, m.at);
    });
    return item;
  }

  /** Scroll to a bookmarked message (one older than the chat shows: the chat shows from it on). */
  function jump(tab: ChatTab, at: number) {
    let msg = shown.get(tab.id)?.get(at);
    if (!msg?.isConnected) {
      if (tab.busy) return r.showPop('That one’s further back: wait till I’m done, then try again.', 2400);
      r.renderHistory(tab, at);
      msg = shown.get(tab.id)?.get(at);
    }
    if (!msg?.isConnected) return r.showPop('That message isn’t in this chat any more.', 2000);
    msg.scrollIntoView({ block: 'center', behavior: 'smooth' });
    msg.classList.remove('mark-flash');
    void msg.offsetWidth; // (the flash plays again)
    msg.classList.add('mark-flash');
    setTimeout(() => msg?.classList.remove('mark-flash'), FLASH_MS);
  }

  function open() {
    const tab = r.active();
    const marks = tab ? marksIn(tab) : [];
    if (!tab || !marks.length) return;
    render(tab, marks);
    pop.hidden = false;
    button.classList.add('on');
    listening?.abort();
    listening = new AbortController();
    const { signal } = listening;
    // (a click outside it, or Esc: it closes)
    document.addEventListener(
      'pointerdown',
      (e) => pop.contains(e.target as Node) || button.contains(e.target as Node) || close(),
      { signal },
    );
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || pop.hidden) return;
        e.stopPropagation(); // (Esc puts the robot to sleep otherwise)
        close();
      },
      { capture: true, signal },
    );
  }

  function close() {
    if (pop.hidden) return;
    pop.hidden = true;
    button.classList.remove('on');
    listening?.abort();
    listening = null;
  }

  button.addEventListener('click', () => (pop.hidden ? open() : close()));

  return {
    attach,
    /** Another tab shown: its bookmarks, not the last one's. */
    tabShown: () => {
      close();
      refresh();
    },
  };
}
export type BookmarksApi = ReturnType<typeof createBookmarks>;
