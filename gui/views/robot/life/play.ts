// Things round the desk to click (office3d props.js): the squeaky hammer on the desk
// bonks it (and wakes it if it's asleep, like a click), the charger's plug on the floor
// charges its battery (asleep too, without waking it). A dance party and a high-five it
// gets up to by itself now and then (awakeAntic), and for a milestone.
// (robot.ts calls createPlay with its hub.)
import { pick } from '@/lib/random';
import type { CommentaryApi } from '@/features/chat/reply/commentary';
import type { BonkApi } from './bonk';
import type { DeskActivityApi } from './desk';
import type { FaceApi } from './face';
import type { LifeCycleApi } from './lifecycle';
import type { IdleAnticsApi } from './antics';
import type { AskingApi } from '@/features/chat/reply/ask';
import { Sfx } from '../sound';
import type { ChatTab, RobotState } from '../types';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import type { OfficeData } from '@/office3d/protocol';
import type { Personality } from '@/types/model';

/** What it uses of the robot window (robot.ts's hub). */
export type PlayNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly addNote: CommentaryApi['addNote'];
  readonly animates: CommentaryApi['animates'];
  readonly BONK_COOLDOWN_MS: BonkApi['BONK_COOLDOWN_MS'];
  readonly bonkRobot: BonkApi['bonkRobot'];
  readonly deskState: OfficeData;
  readonly express: FaceApi['express'];
  readonly flash: FaceApi['flash'];
  readonly HURRY: BonkApi['HURRY'];
  readonly persona: () => Personality;
  readonly renderWorking: LifeCycleApi['renderWorking'];
  readonly robot: HTMLElement;
  readonly setActivity: DeskActivityApi['setActivity'];
  readonly setTabStatus: CommentaryApi['setTabStatus'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly smack: BonkApi['smack'];
  readonly state: RobotState;
  readonly stopAntic: IdleAnticsApi['stopAntic'];
  readonly strikePose: DeskActivityApi['strikePose'];
  readonly tabs: Map<string, ChatTab>;
  readonly uid: AskingApi['uid'];
  readonly wake: LifeCycleApi['wake'];
};

export function createPlay(r: PlayNeeds) {
  // (life/bonk.ts)

  // Clicking a sleeping robot: the squeaky hammer wakes it up (no cooldown, and
  // it doesn't hurry a task along, it just wakes up and opens the chat).

  // Things round the desk to click (office3d props.js): the squeaky hammer on the desk
  // bonks it (and wakes it if it's asleep, like a click), the charger's plug on the floor
  // charges its battery (asleep too, without waking it). A dance party and a high-five it
  // gets up to by itself now and then (awakeAntic), and for a milestone.
  const PLAY_MS = { charge: 2600, highfive: 1300, dance: 4300 };
  // (byUser: you clicked something; its own idle dance or high-five doesn't count as you being around)
  let playTimer = 0; // (when what it plays is over)
  function playWith(what: 'bonk' | keyof typeof PLAY_MS, { byUser = true } = {}) {
    r.stopAntic(); // whatever idle antic was playing gives way
    if (byUser) r.state.lastActivity = Date.now();
    if (what === 'bonk') return r.state.awake ? r.bonkRobot() : bonkAwake();
    // (one at a time, but your click wins over a dance or high-five it got up to by itself)
    if (r.state.playing && (!byUser || r.state.playingByUser)) return;
    if (r.state.playing) r.robot.classList.remove(r.state.playing);
    r.state.playing = what;
    r.state.playingByUser = byUser;
    clearTimeout(playTimer);
    playTimer = setTimeout(() => (r.state.playing = null), PLAY_MS[what]);
    r.flash(what, PLAY_MS[what]); // the 3D view acts it out
    if (what === 'charge') {
      Sfx.key.charge();
      r.express('happy', 'o', 1900);
      setTimeout(() => {
        r.express('happy', 'smile', 1500);
        r.flash('hop', 600);
        r.showPop(pick(['Battery 100%! ⚡', 'Fully charged!', 'Zap! I feel brand new.']), 2000);
      }, 2000);
    } else if (what === 'highfive') {
      r.strikePose('raise', 1200);
      r.express('open', 'o', 450);
      setTimeout(() => {
        (byUser ? Sfx.key : Sfx).clap(); // (one it does by itself: an extra)
        r.express('happy', 'smile', 1200);
        r.showPop(pick(['Up top! ✋', 'Nice one!', 'Team work! ✋']), 1500);
      }, 450);
    } else if (what === 'dance') {
      (byUser ? Sfx.key : Sfx).dance();
      r.setActivity('dance', PLAY_MS.dance); // the disco screen
      r.strikePose('cheer', PLAY_MS.dance);
      r.express('happy', 'smile', PLAY_MS.dance);
      r.showPop(pick(['💃 Dance party!', 'Let’s boogie!', 'Disco time! 🕺']), 1800);
    }
  }

  function bonkAwake() {
    if (r.state.waking) return; // the hammer is already on its way
    r.state.waking = true;
    r.smack(() => {
      r.state.waking = false;
      if (r.state.awake) return;
      r.state.lastBonk = Date.now();
      startled();
    });
  }

  // startled awake (after wake(), so its own wake-up face doesn't win)
  function startled() {
    r.wake({ sayHi: false });
    r.express(pick(['dizzy', 'flat']), 'o', 1600);
    Sfx.key.annoyed();
    setTimeout(() => r.showPop(pick(r.persona().bonked || ['OW!']), 2200), 350);
  }

  function bonked() {
    const now = Date.now();
    if (now - (r.state.lastBonk || 0) < r.BONK_COOLDOWN_MS) {
      r.express('dizzy', 'o', 1200);
      if (r.state.awake) r.showPop("I'm already hurrying!", 1400);
      return;
    }
    r.state.lastBonk = now;
    const working = r.active()?.busy ? r.active() : [...r.tabs.values()].find((t) => t.busy);
    if (working && !working.compacting && !working.terminal && !working.bonk) return hurry(working);
    if (!r.state.awake) return startled();
    r.express('flat', 'o', 1400);
    r.flash('squish', 450);
    r.showPop(pick(r.persona().bonked || ['OW!']), 1800);
  }

  async function hurry(tab: ChatTab) {
    const asked = tab.current?.ask;
    if (!asked) {
      r.showPop(pick(r.persona().bonked || ['OW!']), 1800);
      return;
    }
    const turnId = r.uid();
    tab.bonk = { turnId, ask: asked };
    tab.hurried = true;
    r.deskState.hurry = '1'; // sweat drops and frantic typing (3D)
    r.addNote('🔨 Bonked! Starting over, quicker.', '', tab);
    r.setTabStatus(tab, '🔨 Hurrying…');
    r.renderWorking();
    if (r.animates(tab)) {
      r.setActivity('edit');
      r.express('dizzy', 'o', 1500);
    }
    r.showPop(pick(r.persona().bonked || ['OW!']), 2000);
    // queue the hurried rerun, then let it jump the queue (this interrupts the current answer)
    const res = await ipc.robotAsk(
      tab.id,
      asked.question + r.HURRY,
      asked.paths,
      turnId,
      'bonk',
      undefined,
      asked.briefs,
    );
    if (!res.ok) {
      tab.bonk = null;
      r.addNote(`🔨 ${res.error}`, '', tab);
      return;
    }
    if (res.queued) ipc.robotSendNow(tab.id, turnId);
  }

  $('#btn-bonk').addEventListener('click', r.bonkRobot);
  $('#btn-bonk-working').addEventListener('click', (e) => {
    e.stopPropagation(); // don't also open the chat
    r.bonkRobot();
  });
  return { PLAY_MS, bonkAwake, bonked, playWith };
}
export type PlayApi = ReturnType<typeof createPlay>;
