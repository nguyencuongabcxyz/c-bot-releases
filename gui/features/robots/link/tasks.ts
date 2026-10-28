// Work one robot handed another (main robotLink.js hand_off_task): a tag on both desks.
// Here, "⏳ From Lead: Add /orders"; on Lead's desk, "⏳ To BE: Add /orders" (✅ when done).
// A click opens the chat (the task's own tab, on the robot doing it). A finished task's
// tag stays a little while (main drops it), and the one who handed it off says so.
// (robot.ts calls createHandedOffTasks with its hub.)
import type { TabsApi } from '@/features/chat/tabs';
import type { IdleAnticsApi } from '@/views/robot/life/antics';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import { Sfx } from '@/views/robot/sound';
import type { ChatTab, RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import type { LinkTask } from '@/types/model';

/** What it uses of the robot window (robot.ts's hub). */
export type HandedOffTasksNeeds = {
  readonly activateTab: TabsApi['activateTab'];
  readonly awayClick: IdleAnticsApi['awayClick'];
  readonly openChat: LifeCycleApi['openChat'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly state: RobotState;
  readonly tabs: Map<string, ChatTab>;
  readonly wake: LifeCycleApi['wake'];
};

export function createHandedOffTasks(r: HandedOffTasksNeeds) {
  // Work one robot handed another (main robotLink.js hand_off_task): a tag on both desks.
  // Here, "⏳ From Lead: Add /orders"; on Lead's desk, "⏳ To BE: Add /orders" (✅ when done).
  // A click opens the chat (the task's own tab, on the robot doing it). A finished task's
  // tag stays a little while (main drops it), and the one who handed it off says so.
  const tasksEl = $('#tasks');
  const TASK_STATE = {
    sent: ['✈️', 'on its way'],
    working: ['⏳', 'working'],
    done: ['✅', 'done'],
    failed: ['⚠️', "couldn't do it"],
    cancelled: ['✖️', 'cancelled'],
  };
  let shownTasks = new Map<string, LinkTask['status']>(); // id -> status, to notice a change
  function renderTasks(list: LinkTask[] = []) {
    tasksEl.replaceChildren();
    const next = new Map<string, LinkTask['status']>();
    for (const t of list.slice(-3)) {
      next.set(t.id, t.status);
      const [icon, word] = TASK_STATE[t.status] || TASK_STATE.sent;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `task-chip ${t.status}${t.mine ? ' mine' : ''}`;
      chip.textContent = `${icon} ${t.mine ? 'From' : 'To'} ${t.other}: ${t.title}`;
      chip.title = `${t.mine ? `A task from ${t.other}` : `Handed to ${t.other}`}: ${t.title} (${word})${t.report && t.status !== 'working' ? `\n\n${t.report}` : ''}`;
      chip.addEventListener('pointerdown', (e) => e.stopPropagation()); // (not a drag or a poke)
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        openTask(t);
      });
      tasksEl.appendChild(chip);
      // the one who handed it off hears how it went
      const was = shownTasks.get(t.id);
      if (!t.mine && was && was !== t.status && r.state.awake && !r.state.away) {
        if (t.status === 'done') {
          Sfx.key.done();
          r.showPop(`✅ ${t.other} finished: ${t.title}`, 2600);
        } else if (t.status === 'failed') r.showPop(`⚠️ ${t.other} couldn't finish: ${t.title}`, 2600);
      }
    }
    shownTasks = next;
    tasksEl.hidden = !list.length;
  }
  function openTask(t: LinkTask) {
    if (r.state.away) return r.awayClick();
    const tab = t.mine ? [...r.tabs.values()].find((x) => x.task === t.id) : null;
    if (!r.state.awake) r.wake({ sayHi: false });
    else r.openChat();
    if (tab) r.activateTab(tab.id);
  }
  ipc.on('robot:tasks', renderTasks);
  ipc.robotTasks().then(renderTasks, () => {});
  return {};
}
export type HandedOffTasksApi = ReturnType<typeof createHandedOffTasks>;
