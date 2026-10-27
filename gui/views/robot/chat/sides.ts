// Side questions (like Claude Code's /btw): ask about an answer beside the conversation, so the
// conversation stays on track. An answer's threads hang under it (folded to a badge, or open in
// the chat), or one of them opens in a panel beside the chat (Move to side). A thread knows the
// whole conversation up to when it was first asked; the conversation never hears about it,
// unless you take an answer back with "Use in main" (app/src/sidechat.rs).
import { Icon } from '@/ui/icons';
import type { Layout, SideMessage, SideThread } from '@/types/model';
import * as ipc from '@/ipc';

/** What it needs of a tab (robot.ts ChatTab). */
type SideTab = { id: string; log: HTMLElement; data: { sides?: SideThread[] } };

/** A thread's answer as it streams in. */
type Live = { busy: boolean; text: string; step: string };

/** An answer's side questions, as shown: under it, or (one at a time) in the side panel. */
type Group = {
  tab: SideTab;
  at: number;
  answer: HTMLElement | null; // (its answer on the page)
  el: HTMLElement; // under the answer: the badge, and the box while it's open there
  badge: HTMLButtonElement;
  box: HTMLElement; // the threads' chips, the thread shown, the box you type in
  head: HTMLElement;
  body: HTMLElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  open: boolean; // (unfolded under its answer)
  threadId: string | null; // the thread shown (null: a new one, not asked yet)
  quote: string; // (a new one's: what you picked out of the answer)
  pending: string; // (a new one's first question, on its way)
  confirm: string; // (the thread whose ✕ was clicked once: a second click deletes it)
};

const SIDE_W = 380; // the side panel's room (CSS px)
const GAP = 10; // (between it and the chat)
const MAIN_MIN = 300; // the chat narrower than this: no room for the side panel
const QUOTE_MAX = 2000;

export const SideQuestions = ({ md, tabOf, staged, useInMain, showPop }: {
  md: (text: string) => string;
  tabOf: (id: string) => SideTab | undefined;
  staged: () => boolean;
  useInMain: (text: string) => void;
  showPop: (text: string, ms?: number) => void;
}) => {
  const $ = <E extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<E>(sel)!;
  const body = document.body;
  const sidePanel = $('#side-panel');
  const sideBody = $('#sp-body');
  const answers = new WeakMap<HTMLElement, { tab: SideTab; at: number }>();
  const groups = new Map<string, Group>(); // "tabId|at" -> its group
  const live = new Map<string, Live>(); // thread id -> its answer in progress
  let side: Group | null = null; // the group in the side panel
  let lastLayout: Layout | null = null;
  ipc.robotSideWidth(0); // (a page loaded again: no panel open yet)

  const threadsOf = (tab: SideTab, at: number) => (tab.data.sides || []).filter((t) => t.at === at);
  const threadOf = (g: Group) => (g.threadId ? (g.tab.data.sides || []).find((t) => t.id === g.threadId) : undefined);
  const liveOf = (id: string) => live.get(id) ?? (live.set(id, { busy: false, text: '', step: '' }), live.get(id)!);
  const busy = (g: Group) => !!g.pending || (!!g.threadId && !!live.get(g.threadId)?.busy);
  const short = (s: string, n = 26) => {
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
  };
  const button = (cls: string, title: string, icon: string, label = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.title = title;
    b.innerHTML = Icon(icon, 'sm');
    if (label) b.append(label);
    return b;
  };

  // ---------------------------------------------------------------- a group

  function groupFor(tab: SideTab, at: number) {
    const key = `${tab.id}|${at}`;
    let g = groups.get(key);
    if (g) return g;
    const el = document.createElement('div');
    el.className = 'sq';
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'sq-badge';
    el.appendChild(badge);
    const box = document.createElement('div');
    box.className = 'sq-box';
    const head = document.createElement('div');
    head.className = 'sq-head';
    const bodyEl = document.createElement('div');
    bodyEl.className = 'sq-body';
    const form = document.createElement('form');
    form.className = 'sq-composer';
    const input = document.createElement('textarea');
    input.rows = 1;
    input.placeholder = 'Ask a side question…';
    input.spellcheck = true;
    const send = button('sq-send', 'Send', 'send');
    send.type = 'submit';
    form.append(input, send);
    box.append(head, bodyEl, form);
    g = { tab, at, answer: null, el, badge, box, head, body: bodyEl, input, send, open: false, threadId: null, quote: '', pending: '', confirm: '' };
    const group = g;
    badge.addEventListener('click', () => {
      if (side === group) return closeSide(); // (on the side: back under its answer, folded)
      setOpen(group, !group.open);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (busy(group)) return stop(group);
      void ask(group);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!busy(group)) void ask(group);
      } else if (e.key === 'Escape' && side !== group) {
        e.preventDefault();
        setOpen(group, false);
      }
      e.stopPropagation(); // (the chat's own keys stay out of it)
    });
    input.addEventListener('input', () => autosize(input));
    groups.set(key, g);
    return g;
  }

  function autosize(input: HTMLTextAreaElement) {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    input.style.overflowY = input.scrollHeight > 120 ? 'auto' : 'hidden';
  }

  function setOpen(g: Group, open: boolean) {
    g.open = open;
    if (!open && !threadsOf(g.tab, g.at).length) g.threadId = null; // (a new one never asked: gone)
    place(g);
    if (open) {
      g.el.scrollIntoView({ block: 'nearest' });
      g.input.focus();
    }
  }

  /** Where its parts go: the badge under its answer (while it has threads), the box under it
   *  too while it's open, or in the side panel. */
  function place(g: Group) {
    const threads = threadsOf(g.tab, g.at);
    const shown = threads.length > 0 || g.open || side === g;
    if (shown && g.answer?.isConnected) {
      if (g.answer.nextElementSibling !== g.el) g.answer.after(g.el);
    } else g.el.remove();
    if (side === g) {
      if (g.box.parentElement !== sideBody) sideBody.replaceChildren(g.box);
    } else if (g.open) {
      if (g.box.parentElement !== g.el) g.el.appendChild(g.box);
    } else g.box.remove();
    g.el.classList.toggle('open', g.open && side !== g);
    g.el.classList.toggle('aside', side === g);
    render(g);
  }

  function render(g: Group) {
    const threads = threadsOf(g.tab, g.at);
    if (g.threadId && !threads.some((t) => t.id === g.threadId)) g.threadId = threads[threads.length - 1]?.id ?? null; // (deleted, or taken back with its answer)
    if (!g.threadId && !g.open && side !== g && threads.length) g.threadId = threads[threads.length - 1].id;
    // the badge: how many; where they are
    const n = threads.length;
    g.badge.hidden = !n;
    g.badge.innerHTML = `${Icon('chat', 'sm')}<span>${n} side question${n === 1 ? '' : 's'}</span>`;
    if (side === g) g.badge.insertAdjacentHTML('beforeend', '<span class="sq-where">on the side</span>');
    else g.badge.insertAdjacentHTML('beforeend', `<span class="sq-caret">${g.open ? '▴' : '▾'}</span>`);
    g.badge.classList.toggle('on', g.open || side === g);
    renderHead(g, threads);
    renderThread(g);
    const b = busy(g);
    g.send.innerHTML = Icon(b ? 'stop' : 'send', 'sm');
    g.send.title = b ? 'Stop' : 'Send';
    g.send.classList.toggle('stop', b);
    g.input.placeholder = b ? 'Answering…' : g.threadId ? 'Ask more…' : 'Ask a side question…';
    highlight();
  }

  // the threads' chips (+ a new one), and Fold / Move to side
  function renderHead(g: Group, threads: SideThread[]) {
    const chips = document.createElement('div');
    chips.className = 'sq-chips';
    threads.forEach((t, i) => {
      const chip = document.createElement('span');
      chip.className = `sq-chip${t.id === g.threadId ? ' on' : ''}`;
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'sq-chip-label';
      label.textContent = short(t.quote || t.history.find((m) => m.role === 'user')?.text || `Side question ${i + 1}`);
      label.addEventListener('click', () => {
        g.threadId = t.id;
        g.confirm = '';
        render(g);
        g.input.focus();
      });
      chip.appendChild(label);
      if (t.id === g.threadId) {
        const del = g.confirm === t.id ? button('sq-chip-del sure', 'Delete', 'trash', 'Delete') : button('sq-chip-del', 'Delete', 'x');
        del.addEventListener('click', () => {
          if (g.confirm !== t.id) {
            g.confirm = t.id;
            render(g);
            setTimeout(() => {
              if (g.confirm !== t.id) return;
              g.confirm = '';
              render(g);
            }, 3000);
            return;
          }
          void remove(g, t.id);
        });
        chip.appendChild(del);
      }
      chips.appendChild(chip);
    });
    const add = button(`sq-chip sq-new${g.threadId ? '' : ' on'}`, 'New side question', 'plus');
    add.addEventListener('click', () => {
      g.threadId = null;
      g.quote = '';
      render(g);
      g.input.focus();
    });
    chips.appendChild(add);
    const tools = document.createElement('div');
    tools.className = 'sq-tools';
    if (side !== g) {
      const fold = button('sq-fold', 'Fold', 'down');
      fold.addEventListener('click', () => setOpen(g, false));
      const move = button('sq-move', 'Move to side', 'right', 'Move to side');
      move.addEventListener('click', () => moveToSide(g));
      tools.append(fold, move);
    }
    g.head.replaceChildren(chips, tools);
  }

  // the thread shown: what it's about, its questions and answers, the one coming in
  function renderThread(g: Group) {
    const t = threadOf(g);
    const nodes: Node[] = [];
    const quote = t ? t.quote : g.quote;
    if (quote) {
      const q = document.createElement('div');
      q.className = 'sq-quote';
      q.innerHTML = '<span class="sq-quote-label">From the answer</span>';
      q.appendChild(document.createElement('div')).textContent = quote;
      nodes.push(q);
    }
    const said: SideMessage[] = t ? t.history : [];
    for (const m of said) nodes.push(message(m));
    if (g.pending) nodes.push(message({ role: 'user', text: g.pending, at: Date.now() }));
    const l = t ? live.get(t.id) : undefined;
    if (g.pending || l?.busy) {
      const el = document.createElement('div');
      el.className = 'sq-msg bot';
      if (l?.text) {
        el.innerHTML = md(l.text);
        el.lastElementChild?.classList.add('cursor');
      } else {
        el.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
        el.appendChild(document.createElement('span')).textContent = l?.step ? ` ${l.step}…` : ' Thinking…';
      }
      nodes.push(el);
    }
    if (!nodes.length) {
      const hint = document.createElement('div');
      hint.className = 'sq-hint';
      hint.textContent = 'Ask about anything in this answer. The main chat won’t see it.';
      nodes.push(hint);
    }
    const nearBottom = g.body.scrollHeight - g.body.scrollTop - g.body.clientHeight < 40;
    g.body.replaceChildren(...nodes);
    if (nearBottom || side !== g) g.body.scrollTop = g.body.scrollHeight;
  }

  function message(m: SideMessage) {
    const el = document.createElement('div');
    el.className = `sq-msg ${m.role === 'user' ? 'user' : 'bot'}${m.isError ? ' error' : ''}`;
    if (m.role === 'user') {
      el.textContent = m.text;
      return el;
    }
    el.innerHTML = m.text ? md(m.text) : '';
    if (m.interrupted) el.insertAdjacentHTML('beforeend', `<p class="sq-stopped">${m.text ? '…(stopped)' : 'Stopped.'}</p>`);
    if (m.text && !m.isError) {
      const use = button('sq-use', 'Use in main', 'undo', 'Use in main');
      use.addEventListener('click', () => useInMain(m.text));
      el.appendChild(use);
    }
    return el;
  }

  // ---------------------------------------------------------------- asking

  async function ask(g: Group) {
    const text = g.input.value.trim();
    if (!text) return;
    g.input.value = '';
    autosize(g.input);
    const t = threadOf(g);
    if (t) {
      t.history.push({ role: 'user', text, at: Date.now() });
      Object.assign(liveOf(t.id), { busy: true, text: '', step: '' });
    } else g.pending = text;
    render(g);
    const res = await ipc.robotSideAsk(g.tab.id, t?.id ?? null, t ? null : g.at, t ? '' : g.quote, text);
    if (!res.ok) {
      if (t) {
        t.history.pop();
        liveOf(t.id).busy = false;
      }
      g.pending = '';
      g.input.value = text;
      render(g);
      return showPop(res.error, 2600);
    }
    if (!t) {
      // (its thread, as main keeps it: here too, till main says so itself)
      const thread: SideThread = { id: res.threadId, at: g.at, quote: g.quote, sessionId: null, history: [{ role: 'user', text, at: Date.now() }], createdAt: Date.now() };
      const sides = g.tab.data.sides || [];
      if (!sides.some((x) => x.id === thread.id)) g.tab.data.sides = [...sides, thread];
      g.threadId = thread.id;
      g.pending = '';
      g.quote = '';
      liveOf(thread.id).busy = true;
    }
    place(g);
  }

  function stop(g: Group) {
    if (g.threadId) void ipc.robotSideCancel(g.tab.id, g.threadId);
  }

  async function remove(g: Group, id: string) {
    g.confirm = '';
    if (!(await ipc.robotSideRemove(g.tab.id, id))) return showPop('I couldn’t delete that one.', 1800);
    g.tab.data.sides = (g.tab.data.sides || []).filter((t) => t.id !== id);
    live.delete(id);
    const left = threadsOf(g.tab, g.at);
    if (g.threadId === id) g.threadId = left[left.length - 1]?.id ?? null; // (the latest one left)
    if (!left.length) {
      if (side === g) closeSide();
      else setOpen(g, false);
      return;
    }
    place(g);
  }

  /** What happens in a thread (robot:event, type 'side'). */
  let raf = 0;
  const dirty = new Set<Group>();
  function onEvent(ev: { tabId: string; op: string; threadId: string; delta?: string; name?: string; detail?: string; text?: string; isError?: boolean; interrupted?: boolean; message?: string; cancelled?: boolean }) {
    const tab = tabOf(ev.tabId);
    if (!tab) return;
    const l = liveOf(ev.threadId);
    const t = (tab.data.sides || []).find((x) => x.id === ev.threadId);
    switch (ev.op) {
      case 'start':
        Object.assign(l, { busy: true, text: '', step: '' });
        break;
      case 'text':
        l.text += ev.delta || '';
        l.step = '';
        break;
      case 'step':
        l.step = [ev.name === 'Read' ? 'Reading' : ev.name === 'WebSearch' ? 'Searching the web for' : ev.name === 'WebFetch' ? 'Visiting' : 'Looking for', ev.detail].filter(Boolean).join(' ');
        break;
      case 'done':
      case 'fail': {
        Object.assign(l, { busy: false, text: '', step: '' });
        const entry: SideMessage =
          ev.op === 'done'
            ? { role: 'assistant', text: ev.text || '', at: Date.now(), isError: !!ev.isError, interrupted: !!ev.interrupted }
            : { role: 'assistant', text: ev.cancelled ? '' : ev.message || 'It hit a snag.', at: Date.now(), isError: !ev.cancelled, interrupted: !!ev.cancelled };
        const last = t?.history[t.history.length - 1];
        if (t && last?.role !== 'assistant') t.history.push(entry); // (unless main's copy already has it)
        break;
      }
    }
    for (const g of groups.values()) if (g.tab === tab && (g.threadId === ev.threadId || (t && g.at === t.at))) dirty.add(g);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      for (const g of dirty) render(g);
      dirty.clear();
    });
  }

  // ---------------------------------------------------------------- the answers they hang from

  /** An answer on the page, and where it is in the history: its side questions go under it. */
  function attach(answer: HTMLElement, at: number | null | undefined, tab: SideTab) {
    if (at == null) return;
    answers.set(answer, { tab, at });
    const key = `${tab.id}|${at}`;
    if (!groups.has(key) && !threadsOf(tab, at).length) return;
    const g = groupFor(tab, at);
    g.answer = answer;
    place(g);
  }

  /** Ask about an answer (what you picked out of it, if anything): a new thread, under it or on the side. */
  function start(answer: HTMLElement, quote = '') {
    const a = answers.get(answer);
    if (!a) return showPop('I can’t take side questions about this one.', 1800);
    const g = groupFor(a.tab, a.at);
    g.answer = answer;
    g.threadId = null;
    g.quote = quote.trim().slice(0, QUOTE_MAX);
    g.confirm = '';
    if (side) {
      // (the side panel's open: it goes there)
      side = g;
      for (const other of groups.values()) if (other !== g && other.box.parentElement === sideBody) place(other);
      place(g);
      g.input.focus();
      return;
    }
    setOpen(g, true);
  }

  // The part of the answer a thread is about, marked in it (while that thread is open).
  const marks = 'Highlight' in window && CSS.highlights ? CSS.highlights : null;
  function highlight() {
    if (!marks) return;
    const ranges: Range[] = [];
    for (const g of groups.values()) {
      if (!(g.open || side === g) || !g.answer?.isConnected) continue;
      const quote = threadOf(g)?.quote ?? g.quote;
      const r = quote && find(g.answer, quote);
      if (r) ranges.push(r);
    }
    marks.set('side-quote', new Highlight(...ranges));
  }
  // (its first line, as the answer shows it)
  function find(root: HTMLElement, quote: string) {
    const want = quote.split('\n').map((s) => s.trim()).find(Boolean)?.slice(0, 120);
    if (!want) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('.msg-actions, .tools, .sq') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    const nodes: Text[] = [];
    let all = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push(n as Text);
      all += n.textContent;
    }
    const i = all.indexOf(want);
    if (i < 0) return null;
    const range = document.createRange();
    let pos = 0;
    for (const n of nodes) {
      const len = n.textContent!.length;
      if (pos + len > i && range.startContainer === document) range.setStart(n, i - pos);
      if (pos + len >= i + want.length) {
        range.setEnd(n, i + want.length - pos);
        return range;
      }
      pos += len;
    }
    return null;
  }

  // ---------------------------------------------------------------- the side panel

  function moveToSide(g: Group) {
    if (staged()) return showPop('No room for a side panel on the stage.', 2200);
    const was = side;
    side = g;
    g.open = false;
    if (was && was !== g) place(was);
    body.classList.add('side-open');
    ipc.robotSideWidth(SIDE_W);
    place(g);
    if (lastLayout) layout(lastLayout);
    g.input.focus();
  }

  /** Shut the side panel: its thread goes back under its answer (open, or folded). */
  function closeSide({ open = false } = {}) {
    const g = side;
    side = null;
    body.classList.remove('side-open', 'side-ready');
    ipc.robotSideWidth(0);
    if (!g) return;
    g.open = open;
    place(g);
    if (open) g.input.focus();
  }

  /** The window laid out (robot:layout): with the side panel open, the panel's room is the chat's
   *  and the side panel's, the side panel on the far side from the robot. */
  function layout(l: Layout) {
    lastLayout = l;
    const w = side && l.panel && !staged() ? l.sideW || 0 : 0;
    body.classList.toggle('side-ready', !!w);
    if (side && staged()) return closeSide({ open: true });
    if (!w || !l.panel) return;
    const mainW = l.panel.w - w;
    if (mainW < MAIN_MIN) {
      showPop('No room beside the chat here, so it stays under the answer.', 2600);
      return closeSide({ open: true });
    }
    const root = document.documentElement.style;
    const left = l.placement === 'left' || l.side === 'left';
    const [mainX, sideX] = left ? [l.panel.x + w, l.panel.x] : [l.panel.x, l.panel.x + mainW + GAP];
    root.setProperty('--panel-x', `${mainX}px`);
    root.setProperty('--panel-w', `${mainW}px`);
    root.setProperty('--side-x', `${sideX}px`);
    root.setProperty('--side-w', `${w - GAP}px`);
  }

  $('#sp-inline').addEventListener('click', () => closeSide({ open: true }));
  $('#sp-close').addEventListener('click', () => closeSide());
  sidePanel.addEventListener('keydown', (e) => e.stopPropagation());

  /** Another tab shown: the side panel holds this one's thread, so it shuts. */
  function tabShown(id: string) {
    if (side && side.tab.id !== id) closeSide();
  }

  // ---------------------------------------------------------------- Ask about what you picked out

  const pick = document.createElement('button');
  pick.type = 'button';
  pick.id = 'sq-pick';
  pick.hidden = true;
  pick.innerHTML = `${Icon('chat-ask', 'sm')}<span>Ask about this</span>`;
  document.body.appendChild(pick);
  let picked: { answer: HTMLElement; text: string } | null = null;
  const hidePick = () => {
    pick.hidden = true;
    picked = null;
  };
  pick.addEventListener('mousedown', (e) => e.preventDefault()); // (the selection stays)
  pick.addEventListener('click', () => {
    if (!picked) return;
    const { answer, text } = picked;
    hidePick();
    getSelection()?.removeAllRanges();
    start(answer, text);
  });
  document.addEventListener('mouseup', (e) => {
    if (e.target === pick || pick.contains(e.target as Node)) return;
    setTimeout(() => {
      const sel = getSelection();
      const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
      if (!sel || text.length < 2) return hidePick();
      const range = sel.getRangeAt(0);
      const host = range.commonAncestorContainer;
      const answer = (host instanceof Element ? host : host.parentElement)?.closest<HTMLElement>('.msg.bot');
      if (!answer || !answers.has(answer) || answer.closest('.sq')) return hidePick();
      const r = range.getBoundingClientRect();
      picked = { answer, text: text.slice(0, QUOTE_MAX) };
      pick.hidden = false;
      const pw = pick.offsetWidth;
      const ph = pick.offsetHeight;
      pick.style.left = `${Math.round(Math.max(4, Math.min(innerWidth - pw - 4, r.left + r.width / 2 - pw / 2)))}px`;
      pick.style.top = `${Math.round(r.top - ph - 8 < 4 ? r.bottom + 8 : r.top - ph - 8)}px`;
    });
  });
  document.addEventListener('mousedown', (e) => {
    if (e.target !== pick && !pick.contains(e.target as Node)) hidePick();
  });
  document.addEventListener('scroll', hidePick, true);
  document.addEventListener('keydown', hidePick, true);

  return { attach, start, onEvent, layout, tabShown, isOpen: () => !!side };
};
