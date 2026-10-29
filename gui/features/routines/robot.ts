// A routine's run (main features/routines/runs.rs): a prompt this robot runs on a schedule.
// It runs in the routine's own tab (a new one if that's been closed, told what it found last
// time), like any question; the answer goes back when the turn's done (routineAnswer, from
// the done / fail events), and main shows it. With the chat open you stay in the tab you
// were in. (robot.ts calls createRoutines with its hub.)
import type { TabsApi } from '@/features/chat/tabs';
import type { AskingApi } from '@/features/chat/reply/ask';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { FaceApi } from '@/views/robot/life/face';
import type { IdleAnticsApi } from '@/views/robot/life/antics';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import { Sfx } from '@/views/robot/sound';
import type { ChatTab, RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import type { RoutineEvent } from '@/types/model';

type Ev<P extends RoutineEvent['phase']> = Extract<RoutineEvent, { phase: P }>;

/** What it uses of the robot window (robot.ts's hub). */
export type RoutinesNeeds = {
  readonly activateTab: TabsApi['activateTab'];
  readonly active: () => ChatTab | undefined;
  readonly awayClick: IdleAnticsApi['awayClick'];
  readonly express: FaceApi['express'];
  readonly input: HTMLTextAreaElement;
  readonly openChat: LifeCycleApi['openChat'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly state: RobotState;
  readonly submit: AskingApi['submit'];
  readonly tabs: Map<string, ChatTab>;
  readonly wake: LifeCycleApi['wake'];
};

export function createRoutines(rw: RoutinesNeeds) {
  const tabOf = (routineId: string) => [...rw.tabs.values()].find((t) => t.routine === routineId);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** The run's answer (or why there's none) goes back to main. */
  function routineAnswer(tab: ChatTab, r: { text: string } | { error: string }) {
    if (!tab.routineRun) return; // (only for a routine's tab, on a run)
    ipc.routinesDone({ runId: tab.routineRun, ...r });
    tab.routineRun = '';
  }

  async function run(ev: Ev<'run'>) {
    const fail = (error: string) => ipc.routinesDone({ runId: ev.runId, error });
    // (out walking: main's calling it back to its desk)
    for (let i = 0; i < 60 && rw.state.away && !rw.state.meeting; i++) await wait(100);
    if (rw.state.away && !rw.state.meeting) return fail("It's out for a walk and didn't come back to its desk.");
    const using = rw.state.awake && !rw.state.collapsed ? rw.active() : undefined; // (the tab you're in)
    if (!rw.state.awake) rw.wake({ sayHi: false, tucked: true }); // (its chat stays tucked away: you see it working)
    let tab = tabOf(ev.routineId);
    let text = ev.text;
    if (!tab) {
      const res = await ipc.robotTabNew();
      if (!res.ok) return fail(res.error || 'It has no free tab.');
      for (let i = 0; i < 60 && !rw.tabs.get(res.tabId); i++) await wait(50);
      tab = rw.tabs.get(res.tabId);
      if (!tab) return fail('Its new tab never opened.');
      tab.routine = ev.routineId;
      if (ev.last) text = `${text}\n\n${ev.last}`;
    }
    if (tab.busy) return fail('Its tab for this routine is still busy with something else.');
    rw.activateTab(tab.id, { quiet: !!using });
    tab.routineRun = ev.runId;
    ipc.robotTabRename(tab.id, ev.title);
    rw.input.value = text;
    await rw.submit();
    if (using && using !== tab && rw.tabs.has(using.id)) rw.activateTab(using.id, { quiet: true });
  }

  /** Taking too long: main stopped waiting, so the turn stops too. */
  function stop(ev: Ev<'stop'>) {
    const tab = [...rw.tabs.values()].find((t) => t.routineRun === ev.runId);
    if (!tab) return;
    tab.routineRun = '';
    ipc.robotCancel(tab.id);
  }

  /** Its result is in (main opens the Routines window on it, or not): the robot says so. */
  function result(ev: Ev<'result'>) {
    if (!rw.state.awake || rw.state.away) return;
    if (ev.ok) {
      Sfx.key.done();
      rw.express('happy', 'smile', 2000);
    } else rw.express('flat', 'o', 1600);
    rw.showPop(`${ev.ok ? '' : '⚠️ '}${ev.title}: ${ev.line}`, ev.show === 'pop' ? 7000 : 3200);
  }

  /** Ask about it: the chat, on the routine's tab. */
  function open(ev: Ev<'open'>) {
    if (rw.state.away) return rw.awayClick();
    if (!rw.state.awake) rw.wake({ sayHi: false });
    else rw.openChat();
    const tab = tabOf(ev.routineId);
    if (tab) rw.activateTab(tab.id);
  }

  function onRoutine(ev: RoutineEvent) {
    switch (ev.phase) {
      case 'run':
        return void run(ev);
      case 'stop':
        return stop(ev);
      case 'result':
        return result(ev);
      case 'open':
        return open(ev);
    }
  }
  ipc.on('robot:routine', onRoutine);

  return { routineAnswer };
}
export type RoutinesApi = ReturnType<typeof createRoutines>;
