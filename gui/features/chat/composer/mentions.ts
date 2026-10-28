// @ in the box you type in: a file in the robot's folder, or another of its tabs (@#, for a
// brief from it), picked from a list as you type.
// (robot.ts calls createMentions with its hub.)
import type { ComposerApi } from './composer';
import type { SlashApi } from './slash';
import type { AskingApi } from '../reply/ask';
import type { BriefsApi } from '../brief';
import type { ChatTab, PaletteFile, PaletteItem, PaletteTab, RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { el } from '@/lib/dom';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type MentionsNeeds = {
  readonly activeId: string | null;
  readonly addBrief: BriefsApi['addBrief'];
  readonly autosize: ComposerApi['autosize'];
  readonly folderName: () => string;
  readonly hidePalette: SlashApi['hidePalette'];
  readonly input: HTMLTextAreaElement;
  readonly paletteEl: SlashApi['paletteEl'];
  paletteIndex: number;
  paletteItems: PaletteItem[];
  readonly state: RobotState;
  readonly submit: AskingApi['submit'];
  readonly tabs: Map<string, ChatTab>;
  readonly updatePalette: SlashApi['updatePalette'];
};

export function createMentions(r: MentionsNeeds) {
  let mentionSeq = 0;
  let mentionStart = 0;
  async function updateMentions(query: string, start: number) {
    const seq = ++mentionSeq;
    const tabsOnly = query.startsWith('#'); // (@#: just the other tabs)
    const items = tabsOnly ? [] : await ipc.robotFiles(query);
    if (seq !== mentionSeq) return; // typed on since
    mentionStart = start;
    const others = otherTabs(query.replace(/^#/, ''));
    const files = items.map((e): PaletteFile => ({ ...e, kind: 'file' }));
    r.paletteItems = [...others, ...files];
    if (tabsOnly && !others.length) return r.hidePalette();
    r.paletteIndex = Math.min(r.paletteIndex, Math.max(0, r.paletteItems.length - 1));
    r.paletteEl.innerHTML = '';
    if (others.length) {
      group('💬 Other tabs');
      others.forEach((item, i) => {
        row(i, 'tabs', `#${item.title}`, '', item.title, () => insertTabMention(item));
      });
    }
    if (!tabsOnly) {
      group(`📁 ${r.folderName()}`);
      if (!files.length)
        r.paletteEl.append(el('div', 'p-empty', query ? `No files match “${query}”` : 'This folder looks empty'));
      files.forEach((item, i) => {
        const slash = item.rel.lastIndexOf('/');
        const name = item.rel.slice(slash + 1) + (item.dir ? '/' : '');
        const where = slash > 0 ? item.rel.slice(0, slash) : '';
        row(others.length + i, item.dir ? 'folder' : 'file', name, where, item.rel, () => insertMention(item));
      });
    }
    r.paletteEl.hidden = false;
    r.paletteEl.querySelector('.p-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  // (a heading in the list, and a line to pick)
  function group(label: string) {
    const g = el('div', 'p-group');
    Icon.text(g, label);
    r.paletteEl.appendChild(g);
  }
  function row(i: number, icon: string, name: string, desc: string, title: string, pick: () => void) {
    const item = el('div', `p-item p-file${i === r.paletteIndex ? ' on' : ''}`);
    item.setAttribute('role', 'option');
    const mark = el('span', 'p-icon');
    mark.innerHTML = Icon(icon, 'sm');
    item.append(mark, el('span', 'p-name', name), el('span', 'p-desc', desc));
    item.title = title;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus in the input
      pick();
    });
    r.paletteEl.appendChild(item);
  }

  // The robot's other conversations to mention (@#): ones that have said something, and keep it
  function otherTabs(query: string): PaletteTab[] {
    const q = query.toLowerCase();
    return [...r.tabs.values()]
      .filter(
        (t) => t.id !== r.activeId && !t.data?.temporary && (t.data?.sessionId || t.log.querySelector('.msg.bot')),
      )
      .filter((t) => t.title.toLowerCase().includes(q))
      .slice(0, 8)
      .map((t): PaletteTab => ({ kind: 'tab', id: t.id, title: t.title }));
  }

  // put "@#title" in place of what was typed after @, and ask that tab for a brief
  function insertTabMention(item: PaletteTab) {
    const caret = r.input.selectionStart ?? r.input.value.length;
    const before = r.input.value.slice(0, mentionStart);
    const after = r.input.value.slice(caret).replace(/^[^\s"]*"?/, ''); // the rest of the half-typed name
    const name = item.title.replace(/"/g, '');
    const token = /\s/.test(name) ? `@#"${name}"` : `@#${name}`;
    r.input.value = `${before}${token} ${after}`;
    const pos = before.length + token.length + 1;
    r.input.setSelectionRange(pos, pos);
    r.paletteIndex = 0;
    r.autosize();
    r.input.focus();
    r.hidePalette();
    r.addBrief(item);
  }

  // put "@path" in place of what was typed after @; a folder stays open to pick inside it
  function insertMention(item: PaletteFile) {
    const caret = r.input.selectionStart ?? r.input.value.length;
    const before = r.input.value.slice(0, mentionStart);
    const after = r.input.value.slice(caret).replace(/^[^\s"]*"?/, ''); // the rest of the half-typed path
    const rel = item.rel + (item.dir ? '/' : '');
    const spaced = /\s/.test(rel);
    const token = spaced ? `@"${rel}${item.dir ? '' : '"'}` : `@${rel}`;
    const tail = item.dir ? '' : ' ';
    r.input.value = before + token + tail + after;
    const pos = (before + token + tail).length;
    r.input.setSelectionRange(pos, pos);
    r.paletteIndex = 0;
    r.autosize();
    r.input.focus();
    if (item.dir) r.updatePalette();
    else r.hidePalette();
  }

  // run = Enter/click: our own commands run straight away; Claude Code ones are completed so you can add arguments
  function choose(item: PaletteItem, run: boolean) {
    if (item.kind === 'file') return insertMention(item);
    if (item.kind === 'tab') return insertTabMention(item);
    if (run && item.kind === 'local') {
      r.input.value = `/${item.name}`;
      r.submit();
      return;
    }
    r.input.value = `/${item.name} `;
    r.autosize();
    r.hidePalette();
    r.input.focus();
  }

  function paletteKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = r.paletteItems.length;
      if (!n) return true;
      r.paletteIndex = (r.paletteIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      r.updatePalette();
      return true;
    }
    if (!r.paletteItems.length) return false; // "no files match": Enter sends as usual
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      choose(r.paletteItems[r.paletteIndex], e.key === 'Enter');
      return true;
    }
    return false;
  }

  async function refreshCommands() {
    r.state.claudeCommands = await ipc.robotCommands();
  }
  return {
    choose,
    paletteKey,
    refreshCommands,
    updateMentions,
    get mentionSeq() {
      return mentionSeq;
    },
    set mentionSeq(v) {
      mentionSeq = v;
    },
  };
}
export type MentionsApi = ReturnType<typeof createMentions>;
