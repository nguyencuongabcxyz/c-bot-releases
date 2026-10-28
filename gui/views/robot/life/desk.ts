// helper agents still at work, in one tab or all of them
// (robot.ts calls createDeskActivity with its hub.)
import { MONITOR, POSES } from '../constants';
import { clamp } from '@/lib/math';
import type { IdleAnticsApi } from './antics';
import type { PlansApi } from '@/features/chat/plan/card';
import type { ChatTab, RobotState } from '../types';
import type { OfficeData } from '@/office3d/protocol';

/** What it uses of the robot window (robot.ts's hub). */
export type DeskActivityNeeds = {
  readonly body: HTMLElement;
  readonly deskState: OfficeData;
  readonly nightcap: IdleAnticsApi['nightcap'];
  readonly pendingQuestion: PlansApi['pendingQuestion'];
  readonly pop: HTMLElement;
  readonly state: RobotState;
  readonly stopAntic: IdleAnticsApi['stopAntic'];
  readonly tabs: Map<string, ChatTab>;
};

export function createDeskActivity(r: DeskActivityNeeds) {
  // helper agents still at work, in one tab or all of them
  function helpersOut(tab?: ChatTab) {
    let n = 0;
    for (const t of tab ? [tab] : r.tabs.values())
      for (const a of t.agents?.values() || []) if (a.status === 'running') n++;
    return n;
  }

  function restingActivity() {
    if (helpersOut() && !r.body.classList.contains('talking')) return 'helpers';
    if (r.state.busy) return 'think';
    if (r.state.mirroring) return 'idle';
    return r.state.awake ? 'idle' : 'off';
  }

  // Switch what the monitor shows (and with it how the robot sits). With `ms`
  // the scene is temporary and falls back to the resting one afterwards.
  let activityTimer = 0; // (back to the resting scene)
  function setActivity(activity: string, ms?: number) {
    clearTimeout(activityTimer);
    if (activity !== 'idle' && activity !== 'off' && activity !== 'edit') r.stopAntic();
    r.state.activity = activity;
    r.deskState.screen = activity;
    renderPose();
    if (ms) activityTimer = setTimeout(() => setActivity(restingActivity()), ms);
  }

  function renderPose() {
    const override = r.state.pose && r.state.pose.until > Date.now() ? r.state.pose.name : null;
    let pose = override || POSES[r.state.activity] || 'idle';
    if (!override && !r.state.awake && !r.state.busy && !helpersOut()) pose = 'sleep'; // a strike (e.g. reaching for food) wakes it briefly
    // nodding off: in the chair with an eye mask, or on the floor under a blanket (a coin toss each time)
    if (pose === 'sleep' && r.deskState.pose !== 'sleep')
      r.deskState.sleepStyle = Math.random() < 0.5 ? 'chair' : 'floor';
    r.deskState.pose = pose;
    r.nightcap();
    look();
  }

  function strikePose(name: string, ms: number) {
    // keep the hand up while a question waits (only reaching for a dropped file may interrupt)
    if (r.pendingQuestion() && name !== 'eager') return;
    r.state.pose = { name, until: Date.now() + ms };
    renderPose();
    setTimeout(renderPose, ms + 20);
  }

  function look() {
    if (r.state.peek) return; // (away on the island: nobody to look at)
    let { dx, dy } = r.state.lastCursor;
    const pose = r.deskState.pose;
    let follow = pose === 'idle' || pose === 'talking' || pose === 'wave' || pose === 'cheer' || pose === 'eager';
    if (r.state.lookOverride && r.state.lookOverride.until > Date.now()) {
      ({ dx, dy } = r.state.lookOverride);
      follow = false;
    } else if (pose === 'reading' || pose === 'typing') ({ dx, dy } = MONITOR);
    else if (pose === 'thinking') ({ dx, dy } = { dx: -80, dy: -200 });
    else if (pose === 'sleep') ({ dx, dy } = { dx: 0, dy: 0 });
    const dist = Math.hypot(dx, dy) || 1;
    const reach = clamp(dist / 120, 0, 1);
    const lx = (dx / dist) * 6 * reach;
    const ly = (dy / dist) * 4 * reach;
    const root = document.documentElement.style;
    root.setProperty('--look-x', `${lx.toFixed(2)}px`);
    root.setProperty('--look-y', `${ly.toFixed(2)}px`);
    root.setProperty('--tilt', `${(follow && r.state.awake ? lx * 0.8 : 0).toFixed(2)}deg`);
  }

  function lookAt(dx: number, dy: number, ms: number) {
    r.state.lookOverride = { dx, dy, until: Date.now() + ms };
    look();
    setTimeout(look, ms + 20);
  }

  let popTimer = 0;
  function showPop(text: string, ms = 2400) {
    if (!r.state.awake) return;
    // prefer the open side of the robot's head (the monitor sits on its right)
    r.pop.classList.toggle('right', r.state.robotX + 60 < 130);
    r.pop.textContent = text;
    r.pop.classList.add('show');
    clearTimeout(popTimer);
    popTimer = setTimeout(() => r.pop.classList.remove('show'), ms);
  }
  return { helpersOut, look, lookAt, renderPose, restingActivity, setActivity, showPop, strikePose };
}
export type DeskActivityApi = ReturnType<typeof createDeskActivity>;
