// Another robot's Claude asked this one something (main robotLink.js: it flew over as a
// paper plane). It takes it on in a tab of its own chat, in its own folder, like any
// question (follow-ups in that exchange go to the same tab, so it remembers), and its
// answer goes back when the turn's done (linkAnswer, from the done / fail events).
// (robot.ts calls createRobotMessages with its hub.)
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { TabsApi } from '@/features/chat/tabs';
import type { AskingApi } from '@/features/chat/reply/ask';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import { Sfx } from '@/views/robot/sound';
import type { ChatTab, RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import type { LinkEvent } from '@/types/model';

/** What it uses of the robot window (robot.ts's hub). */
export type RobotMessagesNeeds = {
  readonly activateTab: TabsApi['activateTab'];
  readonly input: HTMLTextAreaElement;
  readonly showPop: DeskActivityApi['showPop'];
  readonly state: RobotState;
  readonly submit: AskingApi['submit'];
  readonly tabs: Map<string, ChatTab>;
  readonly wake: LifeCycleApi['wake'];
};

export function createRobotMessages(rw: RobotMessagesNeeds) {
  // Another robot's Claude asked this one something (main robotLink.js: it flew over as a
  // paper plane). It takes it on in a tab of its own chat, in its own folder, like any
  // question (follow-ups in that exchange go to the same tab, so it remembers), and its
  // answer goes back when the turn's done (linkAnswer, from the done / fail events).
  function linkAnswer(tab: ChatTab, r: { text: string } | { error: string }) {
    if (!tab.linkReq) return; // (only for a tab another robot asked)
    ipc.robotsAnswer({ reqId: tab.linkReq, ...r });
    tab.linkReq = '';
  }
  async function onLink(ev: LinkEvent) {
    if (ev.phase !== 'incoming') return;
    const fail = (error: string) => ipc.robotsAnswer({ reqId: ev.reqId, error });
    // (out walking: main's calling it back to its desk)
    // (in the group chat's meeting room it still answers, from its chat)
    for (let i = 0; i < 60 && rw.state.away && !rw.state.meeting; i++) await new Promise((r) => setTimeout(r, 100));
    if (rw.state.away && !rw.state.meeting) return fail("it's out for a walk and didn't come back to its desk");
    if (!rw.state.awake) rw.wake({ sayHi: false, tucked: true }); // (its chat stays tucked away: you see it working)
    let tab = [...rw.tabs.values()].find((t) => t.exchange === ev.exchange);
    if (!tab) {
      const res = await ipc.robotTabNew();
      if (!res.ok) return fail(res.error || 'it has no free tab');
      for (let i = 0; i < 60 && !rw.tabs.get(res.tabId); i++) await new Promise((r) => setTimeout(r, 50));
      tab = rw.tabs.get(res.tabId);
      if (!tab) return fail('its new tab never opened');
      tab.exchange = ev.exchange;
    }
    rw.activateTab(tab.id);
    tab.linkReq = ev.reqId;
    if (ev.task) {
      tab.task = ev.task.id; // (its desk tag opens this tab)
      ipc.robotTabRename(tab.id, `📋 ${ev.task.title}`);
    }
    if (rw.state.awake) {
      Sfx.pop();
      rw.showPop(ev.task ? `📋 ${ev.from} handed me a task!` : `📨 ${ev.from} asks…`, 1800);
    }
    rw.input.value = ev.text;
    await rw.submit();
  }
  return { linkAnswer, onLink };
}
export type RobotMessagesApi = ReturnType<typeof createRobotMessages>;
