// Shells in the robot's folder, in a drawer between the chat and the box you type in
// (main: app/src/tools/shell.rs): a tab each, a shell of its own in each, PowerShell or Git Bash
// (+ opens your usual kind; ▾ picks one, and that's your usual from then on). They belong to the chat
// tab they were opened in: switch conversations and the drawer shows that one's shells (and
// is out or put away as you left it there). Putting the drawer away keeps them running; they
// end when you close their tabs or their conversation, when the robot goes to sleep, or with
// the robot's window. Keys typed in one are its own: they never reach the chat's shortcuts
// (Esc to sleep, Ctrl+W…), except the drawer's: Ctrl+` puts it away, Ctrl+Shift+` opens
// another shell, Ctrl+PgUp / Ctrl+PgDn go from one to the next.
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './shell.css';
import type { Events } from '@/types/ipc';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import { onDrag } from '@/lib/drag';

type ShellEvent = Events['robot:shell'];

/** A tab: its terminal, and the shell main runs for it (sid 0: none, starting or ended). */
type Tab = {
  chat: string; // (the conversation it belongs to: its chat tab's id)
  kind: ShellKind;
  n: number; // (its number in the tab's name)
  sid: number;
  name: string;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  tabEl: HTMLElement;
  starting: boolean;
  ended: boolean; // it exited by itself: the next key starts a new one
  outbox: string;
  sending: boolean;
  heardAt: number; // (when it last printed something)
};

/** The kinds of shell (workbench/shell.rs kind()): 'bash' is Git Bash. */
export type ShellKind = 'powershell' | 'bash';
/** What a terminal_* call from its Claude gets back. */
export type ShellAnswer = { text: string; isError?: boolean };
const asKind = (k: unknown): ShellKind => (k === 'bash' ? 'bash' : 'powershell');

const HEIGHT_KEY = 'cbot.shellHeight';
const KIND_KEY = 'cbot.shellKind';
const MIN_H = 110;
const DEFAULT_H = 240;
const MOST = 8; // (as many as main keeps going for one robot: workbench/shell.rs MOST)

export const ShellDrawer = ({
  chatTab,
  folderName,
  onShown,
  onHidden,
  onError,
}: {
  chatTab: () => string | null; // (the conversation showing)
  folderName: () => string;
  onShown?: () => void;
  onHidden?: (opts: { quiet: boolean }) => void; // (not quiet: focus goes back to the chat box)
  onError?: (message: string) => void;
}) => {
  const root = $('#shell');
  const host = $('#sh-term');
  const tabsEl = $('#sh-tabs');
  const panel = $('#panel');

  let tabs: Tab[] = []; // (every conversation's)
  const currentOf = new Map<string, Tab>(); // conversation -> the shell it shows
  const outIn = new Set<string>(); // the conversations with the drawer out
  let chat = chatTab() || ''; // (the conversation the drawer is showing)
  // (a shell's first words can come before we know its sid: kept while one is starting)
  const early = new Map<number, ShellEvent[]>();
  let starting = 0;
  let ending: Promise<void> = Promise.resolve(); // (all of them going: a new one waits for that)

  const mine = () => tabs.filter((t) => t.chat === chat);
  const current = () => currentOf.get(chat) || mine()[0] || null;

  // ---- the kinds of shell there are here, and your usual one
  let kinds: { kind: ShellKind; label: string }[] = [{ kind: 'powershell', label: 'PowerShell' }];
  const has = (k: ShellKind) => kinds.some((x) => x.kind === k);
  const usual = (): ShellKind => {
    const k = asKind(localStorage.getItem(KIND_KEY));
    return has(k) ? k : 'powershell';
  };
  const menu = $('#sh-menu');
  const kindBtn = $('#sh-kind');
  ipc
    .robotShellKinds()
    .then((list) => {
      kinds = list.map((x) => ({ kind: asKind(x.kind), label: x.label }));
      kindBtn.hidden = kinds.length < 2;
    })
    .catch(() => {});
  function renderMenu() {
    menu.innerHTML = '';
    for (const { kind, label } of kinds) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.innerHTML = '<span></span>';
      $('span', b).textContent = label;
      if (kind === usual()) b.insertAdjacentHTML('beforeend', '<span class="sh-usual">usual</span>');
      b.addEventListener('click', () => {
        menu.hidden = true;
        localStorage.setItem(KIND_KEY, kind);
        add(kind);
      });
      menu.appendChild(b);
    }
  }
  kindBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) renderMenu();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !(e.target as Element).closest('#sh-menu, #sh-kind')) menu.hidden = true;
  });

  function cssVar(name: string, fallback: string) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }
  function theme(): ITheme {
    const bg = cssVar('--code-bg', '#0a1020');
    return {
      background: bg,
      foreground: cssVar('--code-fg', '#e2e8f0'),
      cursor: cssVar('--accent', '#22d3ee'),
      cursorAccent: bg,
      selectionBackground: 'rgba(255, 255, 255, 0.25)',
    };
  }
  // (another theme, or the robot repainted: their colours follow)
  new MutationObserver(() => {
    for (const t of tabs) t.term.options.theme = theme();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-mode', 'style'] });

  // ---- what you type goes over in order, a batch at a time
  async function send(tab: Tab, data: string) {
    tab.outbox += data;
    if (tab.sending) return;
    tab.sending = true;
    while (tab.outbox && tab.sid) {
      const batch = tab.outbox;
      tab.outbox = '';
      await ipc.robotShellWrite(tab.sid, batch).catch(() => {});
    }
    tab.outbox = '';
    tab.sending = false;
  }

  // ---- the drawer's own keys, wherever you are in it
  function drawerKey(e: KeyboardEvent): boolean {
    if (!e.ctrlKey || e.altKey) return false;
    if (e.code === 'Backquote') {
      if (e.shiftKey) add();
      else hide();
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      const list = mine();
      const cur = current();
      const i = cur ? list.indexOf(cur) : 0;
      const next = list[(i + (e.key === 'PageDown' ? 1 : list.length - 1)) % list.length];
      if (next) activate(next);
    } else return false;
    e.preventDefault();
    return true;
  }

  // (for: the conversation it belongs to, the one showing unless its Claude opens it for another)
  function makeTab(forChat = chat, kind: ShellKind = usual()): Tab {
    const used = new Set(tabs.filter((t) => t.chat === forChat).map((t) => t.n));
    let n = 1;
    while (used.has(n)) n++;
    const el = document.createElement('div');
    el.className = 'sh-pane';
    host.appendChild(el);
    const term = new Terminal({
      fontFamily: cssVar('--font-mono', 'Cascadia Mono, Consolas, monospace'),
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme: theme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => ipc.robotOpenLink(uri)));
    term.open(el);
    const tabEl = document.createElement('div');
    tabEl.className = 'sh-tab';
    tabEl.setAttribute('role', 'tab');
    tabEl.innerHTML =
      '<span class="sh-label"></span><button type="button" class="sh-x" title="Close this shell (ends what\'s running in it)">×</button>';
    tabsEl.appendChild(tabEl);
    const tab: Tab = {
      chat: forChat,
      kind,
      n,
      sid: 0,
      name: kind === 'bash' ? 'bash' : 'shell',
      term,
      fit,
      el,
      tabEl,
      starting: false,
      ended: false,
      outbox: '',
      sending: false,
      heardAt: 0,
    };

    tabEl.addEventListener('click', (e) => {
      if ((e.target as Element).closest('.sh-x')) closeTab(tab);
      else activate(tab);
    });
    tabEl.addEventListener('auxclick', (e) => e.button === 1 && closeTab(tab)); // (middle click)
    term.onData((data) => {
      if (tab.ended) return void restart(tab);
      send(tab, data);
    });
    term.onResize(({ cols, rows }) => tab.sid && ipc.robotShellResize(tab.sid, cols, rows));
    // Ctrl+C copies when something's selected (else it stops what's running), Ctrl+V pastes
    // (the browser's own paste, which xterm takes)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (drawerKey(e)) return false;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === 'c' && (e.shiftKey || term.hasSelection())) {
        e.preventDefault();
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return false;
      }
      if (e.ctrlKey && k === 'v') return false;
      return true;
    });
    tabs.push(tab);
    return tab;
  }

  function dispose(tab: Tab) {
    tab.term.dispose();
    tab.el.remove();
    tab.tabEl.remove();
  }

  // the conversation's tabs and its shell showing, the others' out of sight
  function render() {
    const list = mine();
    const cur = current();
    for (const t of tabs) {
      const here = t.chat === chat;
      t.tabEl.hidden = !here;
      t.el.hidden = t !== cur;
      t.tabEl.classList.toggle('on', t === cur);
      t.tabEl.setAttribute('aria-selected', String(t === cur));
      if (!here) continue;
      $('.sh-label', t.tabEl).textContent = list.length > 1 || t.n > 1 ? `${t.name} ${t.n}` : t.name;
      t.tabEl.title = `${t.name} in ${folderName()}`;
      t.tabEl.classList.toggle('ended', t.ended);
    }
  }

  // keys and pastes in the drawer stay in the drawer (its own keys work on its buttons too;
  // in a terminal they were seen to already)
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) menu.hidden = true;
    else if (!(e.target as Element).closest('.xterm')) drawerKey(e);
    e.stopPropagation();
  });
  root.addEventListener('paste', (e) => e.stopPropagation());

  function refit(tab = current()) {
    if (!tab || root.hidden || !tab.el.clientWidth) return;
    try {
      tab.fit.fit();
    } catch {
      /* (not laid out yet) */
    }
  }
  let fitQueued = false;
  new ResizeObserver(() => {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      refit();
    });
  }).observe(host);

  // ---- its height: drag the top edge
  function setHeight(h: number) {
    const room = panel.clientHeight; // (0 while the chat isn't showing: no limit yet)
    const max = room ? Math.max(MIN_H, room - 230) : Infinity; // (the chat keeps some room)
    const px = Math.round(Math.min(max, Math.max(MIN_H, h)));
    root.style.height = `${px}px`;
    return px;
  }
  const savedHeight = () => Number(localStorage.getItem(HEIGHT_KEY)) || DEFAULT_H;
  onDrag($('#sh-grip'), (e) => {
    e.preventDefault();
    const h0 = root.offsetHeight;
    document.body.classList.add('sh-resizing');
    return {
      move: ({ dy }) => setHeight(h0 - dy),
      end: () => {
        document.body.classList.remove('sh-resizing');
        localStorage.setItem(HEIGHT_KEY, String(root.offsetHeight));
      },
    };
  });
  $('#sh-grip').addEventListener('dblclick', () => localStorage.setItem(HEIGHT_KEY, String(setHeight(DEFAULT_H))));

  // ---- what main says about them (a shell of another conversation's still gets its words)
  function onEvent(ev: ShellEvent) {
    const tab = tabs.find((t) => t.sid === ev.sid);
    if (!tab) {
      if (starting) early.set(ev.sid, [...(early.get(ev.sid) || []), ev].slice(-500));
      return;
    }
    if (ev.kind === 'data') {
      tab.heardAt = Date.now();
      tab.term.write(ev.data);
    } else {
      tab.sid = 0;
      tab.ended = true;
      render();
      tab.term.write(
        `\r\n\x1b[2m[${tab.name} ended${ev.code ? ` with code ${ev.code}` : ''}. Press any key for a new one.]\x1b[0m\r\n`,
      );
    }
  }
  ipc.on('robot:shell', onEvent);

  async function start(tab: Tab) {
    if (tab.sid || tab.starting) return;
    tab.starting = true;
    tab.ended = false;
    render();
    starting++;
    await ending;
    refit(tab);
    const res = await ipc
      .robotShellOpen(tab.term.cols, tab.term.rows, tab.chat, tab.kind)
      .catch((err) => ({ ok: false as const, error: String(err) }));
    starting--;
    tab.starting = false;
    const waiting = res.ok ? early.get(res.sid) || [] : [];
    if (res.ok) early.delete(res.sid);
    if (!starting) early.clear();
    if (!tabs.includes(tab)) {
      if (res.ok) ipc.robotShellClose(res.sid).catch(() => {}); // (its tab closed while it started)
      return;
    }
    if (!res.ok) {
      tab.ended = true;
      render();
      tab.term.write(`\x1b[31m${res.error}\x1b[0m\r\n`);
      onError?.(res.error);
      return;
    }
    tab.sid = res.sid;
    tab.name = res.shell;
    render();
    for (const ev of waiting) onEvent(ev);
    ipc.robotShellResize(tab.sid, tab.term.cols, tab.term.rows); // (in case it was resized meanwhile)
  }

  function restart(tab: Tab) {
    if (tab.starting) return;
    if (tab.sid) ipc.robotShellClose(tab.sid).catch(() => {});
    tab.sid = 0;
    tab.term.reset();
    start(tab);
  }

  // ---- the tabs
  function activate(tab: Tab, { focus = true } = {}) {
    currentOf.set(tab.chat, tab);
    render();
    requestAnimationFrame(() => {
      refit(tab);
      if (focus && tab.chat === chat && !root.hidden) tab.term.focus();
    });
  }

  function open(kind = usual()) {
    const tab = makeTab(chat, kind);
    activate(tab);
    requestAnimationFrame(() => start(tab));
  }

  /** Another shell for this conversation, in a tab of its own (your usual kind, unless picked). */
  function add(kind = usual()) {
    if (tabs.length >= MOST) return onError?.(`That's ${MOST} shells already: close one first.`);
    if (root.hidden) show({ fresh: true, kind });
    else open(kind);
  }

  function closeTab(tab: Tab) {
    if (tab.sid) ipc.robotShellClose(tab.sid).catch(() => {});
    const i = mine().indexOf(tab);
    tabs = tabs.filter((t) => t !== tab);
    if (currentOf.get(tab.chat) === tab) currentOf.delete(tab.chat);
    dispose(tab);
    const left = mine();
    if (!left.length) hide();
    else if (!currentOf.has(chat)) activate(left[Math.min(i, left.length - 1)]);
    else render();
  }

  // ---- showing and hiding
  function isOpen() {
    return !root.hidden;
  }

  /** The drawer out, showing this conversation's shell (tab, else the one it last showed). */
  function reveal(tab: Tab | null, { focus = true } = {}) {
    const wasHidden = root.hidden;
    root.hidden = false;
    outIn.add(chat);
    setHeight(savedHeight()); // (as tall as you left it, as far as the chat has room now)
    const t = tab || current();
    if (t) activate(t, { focus });
    if (wasHidden) onShown?.();
  }

  // (fresh: with another shell, even if there are some already)
  function show({ fresh = false, kind = usual() } = {}) {
    chat = chatTab() || chat;
    if (!mine().length || (fresh && tabs.length < MOST)) {
      reveal(null);
      open(kind);
    } else reveal(null);
  }

  function hide({ quiet = false } = {}) {
    if (!quiet) outIn.delete(chat);
    if (root.hidden) return;
    root.hidden = true;
    onHidden?.({ quiet });
  }

  function toggle() {
    if (isOpen() && current()?.term.textarea === document.activeElement) hide();
    else show();
  }

  /** Another conversation showing: its shells, the drawer out or put away as it was left there. */
  function switchTo(id: string) {
    if (id === chat) return;
    chat = id;
    render();
    if (outIn.has(id) && mine().length) reveal(null);
    else hide({ quiet: true });
  }

  /** A conversation closed: its shells are gone (main ended them with it). */
  function forget(id: string) {
    for (const t of tabs.filter((t) => t.chat === id)) dispose(t);
    tabs = tabs.filter((t) => t.chat !== id);
    currentOf.delete(id);
    outIn.delete(id);
    if (id === chat) hide({ quiet: true });
  }

  /** Every shell ends (and all they started); the drawer goes too. */
  function end() {
    if (tabs.length) ending = ipc.robotShellClose().catch(() => {});
    for (const t of tabs) dispose(t);
    tabs = [];
    currentOf.clear();
    outIn.clear();
    hide({ quiet: true });
  }

  /** Some shell is running (dozing off would end it). */
  function running() {
    return tabs.some((t) => t.sid || t.starting);
  }

  // ---- its Claude, in the shells of one of its conversations (terminal_* tools: workbench/shell.rs)

  type Ask = Events['robot:shell-ask'];
  // (each kind's prompt with nothing typed after it: PowerShell's "PS C:\x> " (or cmd's), bash's
  // "$ " under its "user@host MINGW64 /c/x (branch)" line)
  const PROMPTS: Record<ShellKind, RegExp> = {
    powershell: /^PS .*>\s?$|^[A-Za-z]:\\[^>]*>\s?$/,
    bash: /(^|\s)[$#]\s?$/,
  };
  const BASH_TITLE = /^\S+@\S+ (MINGW|MSYS|UCRT|CLANG)\w*\s/;
  const atPrompt = (t: Tab, line: string) => PROMPTS[t.kind].test(line);
  const MAX_TEXT = 40_000;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const nameOf = (t: Tab) => `${t.name} ${t.n}`;
  const stateOf = (t: Tab) => (t.sid ? 'running' : t.starting ? 'starting' : 'ended');
  // (one line, nothing that isn't text: no Enter, Esc or Ctrl+ keys)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const clean = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();

  /** Its lines, from line `from` of its scrollback on (a line wrapped on screen is one). */
  function screenLines(t: Tab, from = 0): string[] {
    const b = t.term.buffer.active;
    const out: string[] = [];
    for (let i = Math.max(0, from); i < b.length; i++) {
      const line = b.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && out.length && i > from) out[out.length - 1] += text;
      else out.push(text);
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  }
  function cursorLine(t: Tab) {
    const b = t.term.buffer.active;
    return { row: b.baseY + b.cursorY, text: b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? '' };
  }
  const capped = (text: string) => (text.length > MAX_TEXT ? `…(cut)\n${text.slice(-MAX_TEXT)}` : text);

  /** The shell asked for in that conversation (a number on its tab), else the one it shows. */
  function pick(forChat: string, n: unknown): Tab | null | string {
    const list = tabs.filter((t) => t.chat === forChat);
    if (n == null) return currentOf.get(forChat) || list[0] || null;
    return (
      list.find((t) => t.n === Number(n)) ||
      `There's no shell ${n} in this conversation (it has ${list.length ? list.map(nameOf).join(', ') : 'none'}).`
    );
  }

  /** A running shell of the conversation to type in: the one asked for, the one it shows, or
   *  a new one. The drawer comes out for it when that conversation is the one showing. */
  async function shellFor(a: Ask, showing: boolean): Promise<Tab | string> {
    const kind = a.args.shell_type ? asKind(a.args.shell_type) : null;
    if (kind && !has(kind)) return "Git Bash isn't installed here (it comes with Git for Windows): use PowerShell.";
    let t: Tab | null = null;
    if (!a.args.new_shell) {
      const p = pick(a.tab, a.args.shell);
      if (typeof p === 'string') return p;
      t = p;
      if (t && kind && t.kind !== kind) {
        // (a shell of the kind asked for: the one asked for by number must be one)
        if (a.args.shell != null)
          return `${nameOf(t)} is ${t.kind === 'bash' ? 'Git Bash' : 'PowerShell'}, not ${kind === 'bash' ? 'Git Bash' : 'PowerShell'}.`;
        t = tabs.find((x) => x.chat === a.tab && x.kind === kind) || null;
      }
    }
    if (!t) {
      if (tabs.length >= MOST) return `That's ${MOST} shells already: close one first (or use one of them).`;
      t = makeTab(a.tab, kind || 'powershell');
      currentOf.set(a.tab, t);
    }
    if (a.tab === chat && showing) reveal(t, { focus: false });
    else render();
    if (!t.sid) {
      if (t.ended) t.term.reset();
      await start(t);
      if (!t.sid) return `${nameOf(t)} couldn't start.`;
      // (a new shell: its prompt first, so what's typed lands on it)
      const until = Date.now() + 8000;
      while (Date.now() < until && !(atPrompt(t, cursorLine(t).text) && Date.now() - t.heardAt > 150)) await pause(100);
    }
    t.tabEl.classList.remove('bot');
    void t.tabEl.offsetWidth; // (the flash starts over)
    t.tabEl.classList.add('bot');
    return t;
  }

  function read(a: Ask): ShellAnswer {
    const p = pick(a.tab, a.args.shell);
    if (typeof p === 'string') return { text: p, isError: true };
    if (!p)
      return {
        text: "There are no shells in this conversation's terminal yet (terminal_run or terminal_type opens one).",
      };
    const n = Math.min(1000, Math.max(1, Math.round(Number(a.args.lines) || 80)));
    const lines = screenLines(p).slice(-n);
    const others = tabs.filter((t) => t.chat === a.tab && t !== p).map((t) => `${nameOf(t)} (${stateOf(t)})`);
    return {
      text: capped(
        `${nameOf(p)} (${stateOf(p)}), its last ${lines.length} lines:\n${lines.join('\n')}` +
          (others.length ? `\n\nOther shells in this conversation: ${others.join(', ')}.` : ''),
      ),
    };
  }

  async function type(a: Ask, showing: boolean): Promise<ShellAnswer> {
    const command = clean(String(a.args.command ?? '').replace(/\r?\n/g, '; '));
    if (!command) return { text: 'There was no command to type.', isError: true };
    const t = await shellFor(a, showing);
    if (typeof t === 'string') return { text: t, isError: true };
    send(t, command);
    return {
      text: `Typed into ${nameOf(t)}: ${command}\nIt's waiting at the prompt: the user presses Enter to run it (or changes it first).`,
    };
  }

  async function run(a: Ask, showing: boolean): Promise<ShellAnswer> {
    const lines = String(a.args.command ?? '')
      .split(/\r?\n/)
      .map(clean)
      .filter(Boolean);
    if (!lines.length) return { text: 'There was no command to run.', isError: true };
    const t = await shellFor(a, showing);
    if (typeof t === 'string') return { text: t, isError: true };
    const from = cursorLine(t).row;
    const sentAt = Date.now();
    send(t, `${lines.join('\r')}\r`);
    const until = sentAt + Math.max(1, a.wait || 15) * 1000;
    let how: 'finished' | 'running' | 'ended' | 'closed' = 'running';
    while (Date.now() < until) {
      await pause(200);
      if (!tabs.includes(t)) {
        how = 'closed';
        break;
      }
      if (!t.sid) {
        how = 'ended';
        break;
      }
      const cur = cursorLine(t);
      // done: back at an empty prompt, on a line past the one it was typed on, gone quiet
      if (cur.row > from && atPrompt(t, cur.text) && Date.now() - t.heardAt > 300) {
        how = 'finished';
        break;
      }
    }
    if (how === 'closed') return { text: `${nameOf(t)} was closed while the command ran.`, isError: true };
    const out = screenLines(t, from);
    // (the prompt it came back to, and bash's line over it)
    if (how === 'finished' && out.length && atPrompt(t, out[out.length - 1])) {
      out.pop();
      if (t.kind === 'bash' && out.length && BASH_TITLE.test(out[out.length - 1])) out.pop();
      while (out.length && !out[out.length - 1].trim()) out.pop();
    }
    const shown = out.slice(-300);
    const head = {
      finished: `Ran in ${nameOf(t)}; it finished.`,
      ended: `Ran in ${nameOf(t)}; the shell itself ended.`,
      running: `Ran in ${nameOf(t)}; still running after ${Math.round((Date.now() - sentAt) / 1000)}s (it keeps going there: check on it with terminal_read, shell ${t.n}).`,
    }[how];
    return { text: capped(`${head}\n${out.length > shown.length ? '…\n' : ''}${shown.join('\n')}`) };
  }

  /** A terminal_* call from its Claude, done in that conversation's shells. */
  async function ask(a: Ask, { showing }: { showing: boolean }): Promise<ShellAnswer> {
    try {
      if (a.tool === 'terminal_read') return read(a);
      if (a.tool === 'terminal_type') return await type(a, showing);
      if (a.tool === 'terminal_run') return await run(a, showing);
      return { text: `No tool ${a.tool}.`, isError: true };
    } catch (err) {
      return { text: `The terminal hit a snag: ${err}`, isError: true };
    }
  }

  $('#sh-new').addEventListener('click', () => add());
  $('#sh-hide').addEventListener('click', () => hide());
  $('#sh-restart').addEventListener('click', () => {
    const cur = current();
    if (!cur) return;
    restart(cur);
    cur.term.focus();
  });

  return { show, hide, toggle, add, end, isOpen, switchTo, forget, running, ask };
};
