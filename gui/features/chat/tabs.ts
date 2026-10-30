// Bring the renderer's tabs in line with the main process's list.
// (robot.ts calls createTabs with its hub.)
import type { ShellsApi } from '@/features/workbench/shell/drawer';
import type { SidePanelApi } from './side/panel';
import type { CommentaryApi } from './reply/commentary';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { BrainApi } from './brain';
import type { RemoteControlApi } from './remote';
import type { TodoCardApi } from './todo';
import type { ComposerApi } from './composer/composer';
import type { HelpersApi } from './agents';
import type { FaceApi } from '@/views/robot/life/face';
import type { SlashApi } from './composer/slash';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { ChatLogApi } from './log';
import type { AskingApi } from './reply/ask';
import { Sfx } from '@/views/robot/sound';
import type { ChatTab, RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import type { OfficeData } from '@/office3d/protocol';
import type { RobotView } from '@/types/model';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type TabsNeeds = {
  readonly active: () => ChatTab | undefined;
  activeId: string | null;
  readonly character: () => RobotView;
  readonly addNote: CommentaryApi['addNote'];
  readonly autosize: ComposerApi['autosize'];
  readonly backToPlace: ChatLogApi['backToPlace'];
  readonly cancelEdit: ComposerApi['cancelEdit'];
  readonly closeHelper: HelpersApi['closeHelper'];
  readonly deskState: OfficeData;
  readonly flash: FaceApi['flash'];
  readonly helpersOut: DeskActivityApi['helpersOut'];
  readonly helperView: HelpersApi['helperView'];
  readonly hidePalette: SlashApi['hidePalette'];
  readonly input: HTMLTextAreaElement;
  readonly keepPlace: ChatLogApi['keepPlace'];
  lastMainActive: string | null;
  readonly loadBrain: BrainApi['loadBrain'];
  readonly logs: HTMLElement;
  readonly openChat: LifeCycleApi['openChat'];
  readonly renderBrain: BrainApi['renderBrain'];
  readonly renderHelpers: HelpersApi['renderHelpers'];
  readonly renderHistory: LifeCycleApi['renderHistory'];
  readonly renderRemote: RemoteControlApi['renderRemote'];
  readonly renderTodo: TodoCardApi['renderTodo'];
  readonly restingActivity: DeskActivityApi['restingActivity'];
  readonly setActivity: DeskActivityApi['setActivity'];
  readonly setBusy: AskingApi['setBusy'];
  readonly shell: ShellsApi['shell'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly sides: SidePanelApi['sides'];
  readonly startReply: AskingApi['startReply'];
  readonly state: RobotState;
  readonly syncChrome: AskingApi['syncChrome'];
  readonly tabs: Map<string, ChatTab>;
  readonly tabStrip: HTMLElement;
  readonly watchScroll: ChatLogApi['watchScroll'];
};

export function createTabs(r: TabsNeeds) {
  // (chat/brain.ts)

  // Bring the renderer's tabs in line with the main process's list.
  function syncTabs(c: RobotView) {
    const seen = new Set<string>();
    for (const t of c.tabs) {
      seen.add(t.id);
      const key = `${t.sessionId}|${t.history.length}|${t.history[t.history.length - 1]?.at || ''}`;
      let tab = r.tabs.get(t.id);
      if (!tab) {
        const el = document.createElement('div');
        el.className = 'log';
        el.setAttribute('role', 'log');
        el.setAttribute('aria-live', 'polite');
        el.hidden = true;
        r.logs.appendChild(el);
        // (its title from the start: a busy tab draws the tab strip before the rest is set, below)
        tab = {
          id: t.id,
          title: t.title,
          custom: t.custom,
          log: el,
          busy: false,
          current: null,
          question: null,
          statusText: '',
          status: 'idle',
          activity: 'idle',
          draft: '',
          queue: [],
        } as Partial<ChatTab> as ChatTab; // (its data and tasks follow)
        r.tabs.set(t.id, tab);
        r.watchScroll(tab);
        tab.data = t;
        r.renderHistory(tab);
        if (t.busy) {
          // it was already working when this window (re)loaded: keep listening
          r.addNote('(still working on this one…)', '', tab);
          r.startReply(tab);
          r.setBusy(tab, true);
        }
      } else {
        const hadHistory = tab.data.history.length;
        tab.data = t;
        if (!tab.busy && key !== tab.key) {
          if (!t.history.length && hadHistory && !tab.rewinding) {
            tab.log.innerHTML = '';
            r.addNote('✨ Fresh start! My memory is squeaky clean.', '', tab);
            if (tab.id === r.activeId) r.flash('spin', 850);
          } else r.renderHistory(tab);
        }
      }
      tab.key = key;
      tab.title = t.title;
      tab.custom = t.custom;
      tab.tasks = t.tasks || [];
      if (t.context) tab.context = t.context;
      if ('model' in t) tab.model = t.model;
      if ('effort' in t) tab.effort = t.effort;
    }
    for (const [id, tab] of r.tabs) {
      if (seen.has(id)) continue;
      clearInterval(tab.verbs);
      tab.log.remove();
      r.tabs.delete(id);
      r.shell.forget(id); // (main ended its shells with it)
    }
    // follow the main process when it switches tabs (new tab, resume, close)
    if (c.activeTab !== r.lastMainActive || r.activeId === null || !r.tabs.has(r.activeId)) {
      r.lastMainActive = c.activeTab;
      activateTab(r.tabs.has(c.activeTab) ? c.activeTab : c.tabs[0].id, { quiet: true });
    }
    renderTabs();
  }

  function activateTab(id: string, { quiet = false } = {}) {
    const next = r.tabs.get(id);
    if (!next) return;
    const prev = r.active();
    if (prev !== next) r.cancelEdit(); // (an edit belongs to its tab)
    if (prev && prev !== next) prev.draft = r.input.value; // each tab keeps its half-typed message
    r.activeId = id;
    r.sides.tabShown(id); // (the side panel holds another tab's thread: it shuts)
    if (prev && prev !== next) r.keepPlace(prev);
    for (const t of r.tabs.values()) t.log.hidden = t !== next;
    r.shell.switchTo(id); // (its own shells)
    if (next.status === 'done' || next.status === 'error') next.status = 'idle'; // read it
    if (prev !== next) {
      r.input.value = next.draft || '';
      r.autosize();
      r.hidePalette();
      if (!quiet) ipc.robotTabActivate(id);
    }
    r.syncChrome();
    renderTabs();
    r.renderTodo();
    r.renderHelpers();
    if ((r.helperView.id || r.helperView.call || r.helperView.file) && r.helperView.tab !== next) r.closeHelper();
    r.renderBrain();
    r.loadBrain(next);
    r.backToPlace(next);
    // the robot shows what the visible tab is up to
    if (next.busy) r.setActivity(next.question && !next.question.sent ? 'ask' : next.activity || 'think');
    else if (!r.state.busy && !r.state.mirroring) r.setActivity(r.restingActivity());
  }

  const statusOf = (t: ChatTab) => {
    if (t.terminal) return 'terminal';
    if (t.question && !t.question.sent) return 'question';
    if (t.busy) return 'busy';
    if (r.helpersOut(t)) return 'helpers';
    return t.status;
  };
  const STATUS_LABEL = {
    helpers: 'helpers still working…',
    busy: 'working…',
    question: 'has a question for you',
    done: 'finished',
    error: 'hit a snag',
    terminal: 'open in the terminal',
    idle: '',
  };

  function renderTabs() {
    if (!r.state.character) return;
    r.deskState.helpers = String(r.helpersOut()); // the little bots circling the desk
    r.tabStrip.innerHTML = '';
    for (const { id } of r.state.character.tabs) {
      const t = r.tabs.get(id);
      if (!t) continue;
      const s = statusOf(t);
      const el = document.createElement('div');
      const temp = !!t.data?.temporary;
      el.className = `tab s-${s}${t.id === r.activeId ? ' on' : ''}${temp ? ' temporary' : ''}${t.data?.remote ? ' remote' : ''}`;
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', String(t.id === r.activeId));
      el.title = `${temp ? 'Temporary chat (nothing is kept): ' : ''}${t.title}${STATUS_LABEL[s] ? ` (${STATUS_LABEL[s]})` : ''}\nDouble-click to rename`;
      el.innerHTML = `${temp ? Icon('eye', 'sm tab-temp') : ''}<span class="tab-dot"></span><span class="tab-title"></span><button class="tab-x" type="button" title="Close tab (Ctrl+W)">×</button>`;
      $('.tab-title', el).textContent = t.title;
      el.addEventListener('click', (e) => {
        if (!(e.target as Element).closest('.tab-x') && t.id !== r.activeId) activateTab(t.id);
      });
      el.addEventListener('dblclick', (e) => {
        if (!(e.target as Element).closest('.tab-x')) renameTab(t.id, $<HTMLElement>('.tab-title', el));
      });
      el.addEventListener('auxclick', (e) => e.button === 1 && closeTab(t.id)); // middle-click closes
      $('.tab-x', el).addEventListener('click', () => closeTab(t.id));
      r.tabStrip.appendChild(el);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'tab-add';
    add.textContent = '+';
    add.title = 'New conversation in a new tab (Ctrl+T)';
    add.disabled = r.tabs.size >= 8;
    add.addEventListener('click', () => newTab());
    r.tabStrip.appendChild(add);
    const temp = document.createElement('button');
    temp.type = 'button';
    temp.className = 'tab-add tab-add-temp';
    temp.innerHTML = Icon('eye', 'sm');
    temp.title = 'New temporary chat: nothing is kept, and it’s gone (transcript too) when you close it (/temp)';
    temp.disabled = r.tabs.size >= 8;
    temp.addEventListener('click', () => newTab({ temporary: true }));
    r.tabStrip.appendChild(temp);
    const closed = r.state.character.closedTabs || [];
    if (closed.length) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'tab-add tab-reopen';
      back.textContent = '↺';
      back.title = `Reopen closed tab: “${closed[closed.length - 1].title}” (Ctrl+Shift+T)${closed.length > 1 ? `\n${closed.length} closed tabs can come back` : ''}`;
      back.addEventListener('click', () => reopenTab());
      r.tabStrip.appendChild(back);
    }
    r.tabStrip.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    r.renderRemote();
  }

  async function newTab({ temporary = false } = {}) {
    r.openChat(); // asking something else mid-task needs the chat
    const res = await ipc.robotTabNew(temporary);
    if (!res.ok) {
      r.showPop(res.error, 2200);
      return;
    }
    r.flash('hop', 600);
    Sfx.send();
    r.setActivity('boot', 800); // fresh page on the monitor
    r.input.focus();
  }

  async function closeTab(id: string) {
    const t = r.tabs.get(id);
    if (!t) return;
    const hadChat = !!(t.data?.history?.length || t.data?.sessionId);
    const temp = !!t.data?.temporary;
    if (t.busy && !confirm(`“${t.title}” is still working. Stop it and close the tab?`)) return;
    if (
      temp &&
      hadChat &&
      !t.busy &&
      !confirm('This temporary chat will be gone for good (it can’t be reopened). Close it?')
    )
      return;
    const res = await ipc.robotTabClose(id);
    if (!res.ok) return r.addNote(`📑 ${res.error}`, '', t);
    if (hadChat && !temp) offerUndo(`“${t.title}” closed`);
  }

  // Closing a tab (× or Ctrl+W) can be taken back: Undo for a few seconds, then ↺ / Ctrl+Shift+T.
  const undoBar = document.createElement('div');
  undoBar.id = 'undo';
  undoBar.hidden = true;
  undoBar.innerHTML = '<span></span><button type="button">Undo</button>';
  $('#panel').appendChild(undoBar);
  $('button', undoBar).addEventListener('click', () => {
    undoBar.hidden = true;
    reopenTab();
  });
  let undoTimer = 0;
  function offerUndo(text: string) {
    $('span', undoBar).textContent = text;
    undoBar.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => (undoBar.hidden = true), 8000);
  }

  async function reopenTab() {
    const res = await ipc.robotTabReopen();
    if (!res.ok) return r.showPop(res.error, 2200);
    r.flash('hop', 600);
    Sfx.send();
    r.showPop(`“${res.title}” is back!`, 1800);
  }

  function renameTab(id: string, titleEl: HTMLElement) {
    const t = r.tabs.get(id);
    if (!t || titleEl.querySelector('input')) return;
    const field = document.createElement('input');
    field.value = t.title;
    titleEl.textContent = '';
    titleEl.appendChild(field);
    field.focus();
    field.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      if (save && field.value.trim() && field.value.trim() !== t.title) ipc.robotTabRename(id, field.value.trim());
      else renderTabs();
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    });
    field.addEventListener('blur', () => finish(true));
  }

  // Ctrl+T new · Ctrl+W close · Ctrl+Tab / Ctrl+Shift+Tab switch · Ctrl+1…8 jump
  document.addEventListener('keydown', (e) => {
    if (!r.state.awake || !e.ctrlKey || e.altKey) return;
    const order = r
      .character()
      .tabs.map((t) => t.id)
      .filter((id) => r.tabs.has(id));
    const id = r.activeId;
    const i = id === null ? -1 : order.indexOf(id);
    if ((e.key === 't' || e.key === 'T') && e.shiftKey) reopenTab();
    else if (e.key === 't' || e.key === 'T') newTab();
    else if (e.key === 'w' || e.key === 'W') {
      if (id !== null) closeTab(id); // (none: nothing to close)
    } else if (e.key === 'Tab') activateTab(order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length]);
    else if (/^[1-8]$/.test(e.key) && order[Number(e.key) - 1]) activateTab(order[Number(e.key) - 1]);
    else return;
    e.preventDefault();
  });
  return { activateTab, closeTab, newTab, renderTabs, syncTabs };
}
export type TabsApi = ReturnType<typeof createTabs>;
