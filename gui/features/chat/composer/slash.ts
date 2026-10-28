// Handled right here in the app. Anything else starting with "/" goes to
// Claude Code as-is, so its own commands and skills work too.
// (robot.ts calls createSlash with its hub.)
import type { PastChatsApi } from '../past/resume';
import type { ShellsApi } from '@/features/workbench/shell/drawer';
import type { CommentaryApi } from '../reply/commentary';
import type { BrainApi } from '../brain';
import type { RemoteControlApi } from '../remote';
import type { ChatLogApi } from '../log';
import type { MentionsApi } from './mentions';
import type { TabsApi } from '../tabs';
import type { TerminalModeApi } from '@/features/workbench/terminal';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { AskingApi } from '../reply/ask';
import type { ChatTab, PaletteCommand, PaletteItem, RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';

/** What it uses of the robot window (robot.ts's hub). */
export type SlashNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly current: () => ChatTab;
  readonly activeId: string | null;
  readonly addBot: ChatLogApi['addBot'];
  readonly addNote: CommentaryApi['addNote'];
  readonly choose: MentionsApi['choose'];
  readonly closeTab: TabsApi['closeTab'];
  readonly compactTab: BrainApi['compactTab'];
  readonly input: HTMLTextAreaElement;
  readonly mentionsPart: MentionsApi;
  readonly modeOf: BrainApi['modeOf'];
  readonly newTab: TabsApi['newTab'];
  readonly openEffortMenu: BrainApi['openEffortMenu'];
  readonly openHistory: PastChatsApi['openHistory'];
  readonly openModelMenu: BrainApi['openModelMenu'];
  readonly openTerminal: TerminalModeApi['openTerminal'];
  readonly pickEffort: BrainApi['pickEffort'];
  readonly pickModel: BrainApi['pickModel'];
  readonly remoteNote: RemoteControlApi['remoteNote'];
  readonly setBrain: BrainApi['setBrain'];
  readonly showContext: BrainApi['showContext'];
  readonly sleep: LifeCycleApi['sleep'];
  readonly state: RobotState;
  readonly submit: AskingApi['submit'];
  readonly toggleRemote: RemoteControlApi['toggleRemote'];
  readonly toggleShell: ShellsApi['toggleShell'];
  readonly updateMentions: MentionsApi['updateMentions'];
};

export function createSlash(r: SlashNeeds) {
  // Handled right here in the app. Anything else starting with "/" goes to
  // Claude Code as-is, so its own commands and skills work too.
  const LOCAL_COMMANDS = [
    { name: 'resume', args: '[search]', description: 'Pick up a past conversation' },
    { name: 'history', description: 'Browse past conversations' },
    { name: 'new', description: 'Start another conversation in a new tab' },
    { name: 'temp', description: 'A temporary chat: nothing kept, gone when you close it' },
    { name: 'clear', description: 'Wipe this tab and start over' },
    { name: 'close', description: 'Close this tab' },
    { name: 'model', args: '[name]', description: 'Switch my brain (model) for this tab' },
    { name: 'effort', args: '[low…max]', description: 'How hard I think' },
    {
      name: 'plan',
      args: '[task]',
      description: 'Plan mode: I plan first and change nothing until you approve (Shift+Tab)',
    },
    { name: 'compact', description: 'Squish my memory to free up room' },
    { name: 'context', description: 'How full my memory is' },
    { name: 'terminal', description: 'Continue in full Claude Code, in a terminal' },
    {
      name: 'remote-control',
      args: '[on|off]',
      description: 'Carry on from claude.ai or the Claude app (Remote Control)',
    },
    { name: 'folder', description: 'Open my folder' },
    { name: 'shell', description: 'A shell in my folder, right here (Ctrl+`; another: Ctrl+Shift+`)' },
    { name: 'refine', args: '[text]', description: 'Refine, translate or explain some text (Quick actions)' },
    { name: 'screen', description: 'Drag a box round part of the screen and ask about it' },
    { name: 'note', args: '<text>', description: 'Jot a note down (it goes on my corkboard)' },
    { name: 'notes', description: 'Open my notebook' },
    { name: 'sleep', description: 'Send me to bed' },
    { name: 'help', description: 'What I can do' },
  ];
  const paletteEl = $('#palette');
  let paletteItems: PaletteItem[] = [];
  let paletteIndex = 0;

  function helpText() {
    const lines = LOCAL_COMMANDS.map(
      (c) => `- \`/${c.name}${c.args ? ` ${c.args}` : ''}\` ${c.description.toLowerCase()}`,
    );
    return [
      '**Tricks I know**',
      ...lines,
      '- any other `/command` (like your skills) goes straight to Claude Code',
      '',
      'Tabs: ＋ or Ctrl+T for a new one, Ctrl+Tab to switch, Ctrl+W to close (↺ or Ctrl+Shift+T brings it back), double-click a tab to rename it.',
      'Drag me anywhere, click me for a poke, right-click for options. Esc sends me to sleep.',
    ].join('\n');
  }

  function runLocalCommand(text: string) {
    const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
    if (!m) return false;
    const arg = m[2].trim();
    switch (m[1].toLowerCase()) {
      case 'new':
      case 'tab':
        r.newTab();
        return true;
      case 'temp':
      case 'temporary':
        r.newTab({ temporary: true });
        return true;
      case 'clear':
      case 'reset':
        ipc.robotReset(r.activeId ?? undefined);
        return true;
      case 'close':
        if (r.activeId !== null) r.closeTab(r.activeId); // (none: nothing to close)
        return true;
      case 'resume':
      case 'history':
      case 'conversations':
        r.openHistory(arg);
        return true;
      case 'terminal':
      case 'cli':
        r.openTerminal();
        return true;
      case 'remote-control':
      case 'remote':
      case 'rc': {
        const tab = r.current();
        const on = /^(on|start|yes)$/i.test(arg) ? true : /^(off|stop|no)$/i.test(arg) ? false : !tab.data?.remote;
        if (on === !!tab.data?.remote) {
          if (on) r.remoteNote(tab, tab.data.remoteUrl);
          else r.addNote('📱 Remote Control is already off.', '', tab);
        } else r.toggleRemote(tab, on);
        return true;
      }
      case 'model':
        if (arg) r.pickModel(arg);
        else r.openModelMenu();
        return true;
      case 'effort':
        if (arg) r.pickEffort(arg);
        else r.openEffortMenu();
        return true;
      case 'plan': {
        // on (or, with nothing after it, off again: back to editing); with a task, it's planned straight away
        const tab = r.current();
        const off = !arg && r.modeOf(tab) === 'plan';
        r.setBrain(tab, { permissionMode: off ? 'acceptEdits' : 'plan' }).then(() => {
          if (!arg || r.modeOf(tab) !== 'plan' || tab !== r.active()) return;
          r.input.value = arg;
          r.submit();
        });
        return true;
      }
      case 'compact':
        r.compactTab(r.active());
        return true;
      case 'context':
        r.showContext(r.current());
        return true;
      case 'folder':
        ipc.robotOpenFolder();
        return true;
      case 'shell':
        r.toggleShell({ show: true });
        return true;
      case 'screen':
      case 'snip':
        ipc.robotScreenAsk();
        return true;
      case 'refine':
      case 'quick':
        ipc.quickOpenBlank({ text: arg });
        return true;
      case 'note':
        if (!arg) ipc.notesOpen({ focus: 'add' });
        else ipc.notesAdd(arg).then((n) => n && r.addNote(`📝 Noted: ${n.text}${n.important ? ' (important)' : ''}`));
        return true;
      case 'notes':
        ipc.notesOpen({ focus: null });
        return true;
      case 'sleep':
        r.sleep();
        return true;
      case 'help':
        r.addBot(helpText());
        return true;
      default:
        return false;
    }
  }

  function updatePalette() {
    // "@" before the caret: files in the robot's folder (quoted for paths with spaces)
    const caret = r.input.selectionStart ?? r.input.value.length;
    const before = r.input.value.slice(0, caret);
    const at = before.match(/(?:^|\s)@"([^"\n]*)$/) || before.match(/(?:^|\s)@([^\s"@]*)$/);
    if (at) return r.updateMentions(at[1], before.lastIndexOf('@'));
    r.mentionsPart.mentionSeq++;
    const m = r.input.value.match(/^\/(\S*)$/);
    if (!m) return hidePalette();
    const q = m[1].toLowerCase();
    const local = LOCAL_COMMANDS.filter((c) => c.name.startsWith(q)).map((c): PaletteCommand => ({
      ...c,
      kind: 'local',
    }));
    const taken = new Set(LOCAL_COMMANDS.map((c) => c.name));
    const claude = (r.state.claudeCommands || [])
      .filter((c) => !taken.has(c.name) && c.name.toLowerCase().includes(q))
      .slice(0, 40)
      .map((c): PaletteCommand => ({ ...c, kind: 'claude' }));
    const commands = [...local, ...claude];
    paletteItems = commands;
    if (!paletteItems.length) return hidePalette();
    paletteIndex = Math.min(paletteIndex, paletteItems.length - 1);
    paletteEl.innerHTML = '';
    let group: string | null = null;
    commands.forEach((item, i) => {
      if (item.kind !== group) {
        group = item.kind;
        const g = document.createElement('div');
        g.className = 'p-group';
        g.textContent = group === 'local' ? r.state.character?.name || 'Robot' : 'Claude Code';
        paletteEl.appendChild(g);
      }
      const row = document.createElement('div');
      row.className = `p-item${i === paletteIndex ? ' on' : ''}`;
      row.setAttribute('role', 'option');
      row.innerHTML = '<span class="p-name"></span><span class="p-desc"></span>';
      $('.p-name', row).textContent = `/${item.name}`;
      if (item.args) {
        const a = document.createElement('span');
        a.className = 'p-args';
        a.textContent = ` ${item.args}`;
        $('.p-name', row).appendChild(a);
      }
      $('.p-desc', row).textContent = item.description || '';
      row.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus in the input
        r.choose(item, true);
      });
      paletteEl.appendChild(row);
    });
    paletteEl.hidden = false;
    paletteEl.querySelector('.p-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  function hidePalette() {
    paletteEl.hidden = true;
    paletteIndex = 0;
  }
  return {
    hidePalette,
    paletteEl,
    runLocalCommand,
    updatePalette,
    get paletteIndex() {
      return paletteIndex;
    },
    set paletteIndex(v) {
      paletteIndex = v;
    },
    get paletteItems() {
      return paletteItems;
    },
    set paletteItems(v) {
      paletteItems = v;
    },
  };
}
export type SlashApi = ReturnType<typeof createSlash>;
