// Like Claude Code's /remote-control: the tab's conversation carries on from claude.ai/code
// or the Claude app too. What's typed there shows up here, and the robot acts out the answer.
// (robot.ts calls createRemoteControl with its hub.)
import { TOOLS } from '@/views/robot/constants';
import type { CommentaryApi } from './reply/commentary';
import type { FaceApi } from '@/views/robot/life/face';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { TabsApi } from './tabs';
import type { ChatLogApi } from './log';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import { Sfx } from '@/views/robot/sound';
import type { ChatTab, RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import type { ChatEvent } from '@/types/model';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type RemoteControlNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly current: () => ChatTab;
  readonly activeId: string | null;
  readonly addNote: CommentaryApi['addNote'];
  readonly body: HTMLElement;
  readonly express: FaceApi['express'];
  readonly flash: FaceApi['flash'];
  readonly renderFace: FaceApi['renderFace'];
  readonly renderHistory: LifeCycleApi['renderHistory'];
  readonly renderTabs: TabsApi['renderTabs'];
  readonly renderWorking: LifeCycleApi['renderWorking'];
  readonly scrollDown: ChatLogApi['scrollDown'];
  readonly setActivity: DeskActivityApi['setActivity'];
  readonly state: RobotState;
  readonly unpeek: LifeCycleApi['unpeek'];
};

export function createRemoteControl(r: RemoteControlNeeds) {
  // Like Claude Code's /remote-control: the tab's conversation carries on from claude.ai/code
  // or the Claude app too. What's typed there shows up here, and the robot acts out the answer.
  async function toggleRemote(tab = r.current(), on = !tab.data?.remote) {
    tab.remoteAsked = on;
    const res = await ipc.robotRemote(tab.id, on);
    if (!res.ok) {
      tab.remoteAsked = false;
      r.addNote(`📱 ${res.error}`, '', tab);
      r.express('flat', 'flat', 1500);
      return;
    }
    if (on) {
      tab.remoteState = 'connecting';
      renderRemote();
      r.flash('hop', 600);
    }
  }

  function renderRemote() {
    const tab = r.active();
    const btn = $('#btn-remote');
    const on = !!tab?.data?.remote;
    btn.classList.toggle('on', on);
    btn.dataset.state = on ? tab?.remoteState || '' : '';
  }

  // (its page on claude.ai, and where to find it in the app)
  function remoteNote(tab: ChatTab, url?: string | null) {
    const el = document.createElement('div');
    el.className = 'msg note';
    Icon.text(
      el,
      `📱 Remote Control is on! Carry on from the Claude app (Code → “${r.state.character?.name || 'me'} · C-Bot”)${url ? ' or at ' : '.'}`,
    );
    if (url) {
      const a = document.createElement('a');
      a.href = url;
      a.textContent = 'claude.ai/code';
      el.append(a, '.');
    }
    tab.log.appendChild(el);
    r.scrollDown(tab);
  }

  function onRemote(ev: Extract<ChatEvent, { type: 'remote' }>, tab: ChatTab) {
    const asked = tab.remoteAsked; // (true: turned on from here, false: off from here, unset: by itself)
    tab.remoteAsked = undefined;
    tab.data.remote = ev.on;
    tab.data.remoteUrl = ev.url ?? null;
    if (!ev.on) tab.remoteState = '';
    else if (!tab.remoteState) tab.remoteState = 'ready';
    if (ev.error) {
      r.addNote(`📱 Remote Control couldn't come on: ${ev.error}`, '', tab);
      r.express('flat', 'flat', 1500);
    } else if (ev.on && asked) {
      remoteNote(tab, ev.url);
      r.express('happy', 'smile', 1500);
      Sfx.send();
    } else if (!ev.on && asked === false && tab.id === r.activeId) {
      r.addNote('📱 Remote Control is off.', '', tab);
    }
    r.renderTabs();
  }

  function terminalState(s: 'opened' | 'closed', tab: ChatTab, { quiet = false } = {}) {
    if (s === 'opened') {
      r.unpeek();
      r.state.mirroring = true;
      tab.terminal = true;
      r.renderTabs();
      if (!quiet) r.addNote('⌨️ Continued in the terminal. I’ll act out what happens there.', '', tab);
      Sfx.send();
      // step out of the chat: no bubble, but awake at the desk
      if (r.body.classList.contains('expanded')) ipc.robotExpand(false);
      r.state.collapsed = false;
      r.body.classList.remove('collapsed');
      r.renderWorking();
      r.state.awake = true;
      r.body.classList.remove('asleep');
      r.body.classList.add('awake');
      r.flash('spin', 950);
      r.setActivity('boot', 900);
    } else {
      r.state.mirroring = false;
      tab.terminal = false;
      r.renderTabs();
      r.body.classList.remove('thinking', 'talking');
      r.renderHistory(tab);
      r.addNote('⌨️ Back from the terminal. Everything said there is above.', '', tab);
      Sfx.sleep();
      r.state.awake = false;
      r.body.classList.remove('awake', 'expanded');
      r.body.classList.add('asleep');
      r.setActivity('off');
    }
    r.renderFace();
  }

  let mirrorTalk: number | undefined;
  function mirror(ev: Extract<ChatEvent, { type: 'mirror' }>) {
    if (!r.state.mirroring) return;
    clearTimeout(mirrorTalk);
    r.body.classList.remove('talking');
    if (ev.kind === 'prompt') {
      r.body.classList.add('thinking');
      r.setActivity('think');
      Sfx.send();
    } else if (ev.kind === 'tool') {
      const [, , activity] = TOOLS[ev.name] || ['', '', 'run'];
      r.body.classList.add('thinking');
      r.setActivity(activity);
      Sfx.tool();
    } else if (ev.kind === 'question') {
      r.body.classList.remove('thinking');
      r.setActivity('ask');
      Sfx.ask();
    } else if (ev.kind === 'text') {
      r.body.classList.remove('thinking');
      r.body.classList.add('talking');
      r.setActivity('talk');
      mirrorTalk = setTimeout(() => {
        r.body.classList.remove('talking');
        r.renderFace();
      }, 1800);
    } else if (ev.kind === 'idle') {
      r.body.classList.remove('thinking');
      r.setActivity('done', 2600);
      r.express('happy', 'smile', 2000);
      Sfx.key.done();
    }
    r.renderFace();
  }
  return { mirror, onRemote, remoteNote, renderRemote, terminalState, toggleRemote };
}
export type RemoteControlApi = ReturnType<typeof createRemoteControl>;
