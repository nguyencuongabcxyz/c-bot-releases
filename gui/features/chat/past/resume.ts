// The past conversations in the robot's folder (chat/past/list.ts), opened from the chat's title bar:
// one resumed comes back in a tab of its own.
// (robot.ts calls createPastChats with its hub.)
import type { TabsApi } from '../tabs';
import type { CommentaryApi } from '../reply/commentary';
import type { FaceApi } from '@/views/robot/life/face';
import type { SlashApi } from '../composer/slash';
import type { ChatMarkdownApi } from '../reply/local-files';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import { Sfx } from '@/views/robot/sound';
import type { ChatTab, RobotState } from '@/views/robot/types';
import { HistoryView } from './list';

/** What it uses of the robot window (robot.ts's hub). */
export type PastChatsNeeds = {
  readonly activateTab: TabsApi['activateTab'];
  readonly current: () => ChatTab;
  readonly addNote: CommentaryApi['addNote'];
  readonly flash: FaceApi['flash'];
  readonly hidePalette: SlashApi['hidePalette'];
  readonly input: HTMLTextAreaElement;
  readonly md: ChatMarkdownApi['md'];
  readonly openChat: LifeCycleApi['openChat'];
  readonly setActivity: DeskActivityApi['setActivity'];
  readonly state: RobotState;
  readonly tabs: Map<string, ChatTab>;
  readonly wake: LifeCycleApi['wake'];
};

export function createPastChats(r: PastChatsNeeds) {
  const history = HistoryView({
    md: r.md,
    robotName: () => r.state.character?.name || 'me',
    activeTabId: () => r.current().id,
    onResumed: (res) => {
      const tab = r.tabs.get(res.tabId) || r.current();
      r.activateTab(tab.id);
      if (res.already) {
        r.addNote('↩ That conversation is already open here.', 'resumed', tab);
        return;
      }
      const more = res.total > 30 ? ` (showing the latest of ${res.total} messages)` : '';
      r.addNote(`↩ Picked up “${res.title}”${more}. Carry on!`, 'resumed', tab);
      Sfx.key.wake();
      r.flash('spin', 950);
      r.setActivity('read', 1600); // flick through the old notes
      r.input.focus();
    },
    onClose: () => r.input.focus(),
  });

  function openHistory(query = '') {
    if (!r.state.awake) r.wake();
    else r.openChat();
    r.hidePalette();
    history.open(query);
  }
  return { history, openHistory };
}
export type PastChatsApi = ReturnType<typeof createPastChats>;
