// Saved chats: a conversation starred to come back to (the ☆ on a tab, Ctrl+S, /save), and the
// list to open one again (🔖 in the title bar, Ctrl+O, /saved; Alt+1…9 the first nine).
// Saving is a bookmark: opening one resumes its conversation (app/src/features/chat/saved.rs).
// (robot.ts calls createSavedChats with its hub.)
import type { TabsApi } from '../tabs/tabs';
import type { PastChatsApi } from '../past/resume';
import type { CommentaryApi } from '../reply/commentary';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { ChatTab, RobotState } from '@/views/robot/types';
import type { SavedChat, SavedRow } from '@/types/model';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import { SaveCard } from './card';
import { SavedPicker } from './picker';

/** What it uses of the robot window (robot.ts's hub). */
export type SavedChatsNeeds = {
  readonly activateTab: TabsApi['activateTab'];
  readonly addNote: CommentaryApi['addNote'];
  readonly current: () => ChatTab;
  readonly openHistory: PastChatsApi['openHistory'];
  readonly resumed: PastChatsApi['resumed'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly state: RobotState;
  readonly tabs: Map<string, ChatTab>;
  readonly tabStrip: HTMLElement;
};

export function createSavedChats(r: SavedChatsNeeds) {
  const card = SaveCard({
    onChange: (c, name, emoji) => save({ sessionId: c.id, name, emoji }),
    onUnsave: (c) => ipc.robotUnsave(c.id),
  });
  const picker = SavedPicker({ onOpen: openSaved, onAll: () => r.openHistory() });

  /** The saved chat a tab holds, if it's saved. */
  function savedFor(tab: ChatTab): SavedChat | undefined {
    const sid = tab.data?.sessionId;
    return sid ? r.state.character?.saved?.find((s) => s.id === sid) : undefined;
  }

  // (main sends the robot again once it's saved: the tabs' stars follow from that)
  async function save(chat: Parameters<typeof ipc.robotSave>[0]): Promise<SavedRow[] | null> {
    try {
      return await ipc.robotSave(chat);
    } catch (e) {
      r.showPop(String(e), 2600);
      return null;
    }
  }

  /** The ☆ on a tab (Ctrl+S): save its chat, or (saved already) its card, to rename or unsave it. */
  async function starTab(tab: ChatTab = r.current(), name = '') {
    const was = savedFor(tab);
    if (was && !name) {
      card.open(was, tabElement(tab));
      return;
    }
    const rows = await save({ tabId: tab.id, name, emoji: was?.emoji });
    const saved = rows?.find((s) => s.tabId === tab.id);
    if (!saved) return;
    if (name) r.addNote(`⭐ Saved as “${saved.name}”.`, '', tab);
    else card.open(saved, tabElement(tab));
  }

  // (drawn by tabs.ts: the one that's this tab's)
  function tabElement(tab: ChatTab) {
    return r.tabStrip.querySelector(`.tab[data-id="${CSS.escape(tab.id)}"]`);
  }

  async function openSaved(s: SavedRow) {
    if (s.gone) {
      r.showPop('That conversation is gone: Claude Code cleared its transcript.', 2800);
      return;
    }
    if (s.tabId && r.tabs.has(s.tabId)) {
      r.activateTab(s.tabId);
      return;
    }
    const res = await ipc.robotResume(r.current().id, s.id);
    if (!res.ok) {
      r.showPop(res.error, 2600);
      return;
    }
    if (!res.already) await ipc.robotTabRename(res.tabId, s.name); // (its tab goes by the name you gave it)
    r.resumed(res);
  }

  // Ctrl+S saves this chat · Ctrl+O the saved ones · Alt+1…9 opens one of them
  document.addEventListener('keydown', (e) => {
    if (!r.state.awake || e.metaKey || (e.target as Element).closest?.('#shell')) return; // (a terminal's own keys)
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.altKey && !e.shiftKey && k === 's') starTab();
    else if (e.ctrlKey && !e.altKey && !e.shiftKey && k === 'o') togglePicker();
    else if (e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) picker.nth(Number(e.code.slice(5)));
    else return;
    e.preventDefault();
  });

  function togglePicker(query = '') {
    if (picker.isOpen()) picker.close();
    else {
      card.close();
      picker.open(query);
    }
  }
  $('#btn-saved').addEventListener('click', () => togglePicker());

  return {
    /** Whether this tab's chat is saved (its star is lit). */
    isSaved: (tab: ChatTab) => !!savedFor(tab),
    starTab,
    openSaved: (query = '') => {
      if (!picker.isOpen()) togglePicker(query);
    },
  };
}
export type SavedChatsApi = ReturnType<typeof createSavedChats>;
