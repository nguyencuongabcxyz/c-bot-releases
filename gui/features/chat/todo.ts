// Claude Code's task list for this tab, as a checklist the robot ticks off.
// (robot.ts calls createTodoCard with its hub.)
import type { CommentaryApi } from './reply/commentary';
import type { FaceApi } from '@/views/robot/life/face';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import { Sfx } from '@/views/robot/sound';
import type { ChatTab } from '@/views/robot/types';
import { $ } from '@/lib/dom';
import type { ChatEvent } from '@/types/model';

/** What it uses of the robot window (robot.ts's hub). */
export type TodoCardNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly current: () => ChatTab;
  readonly animates: CommentaryApi['animates'];
  readonly express: FaceApi['express'];
  readonly flash: FaceApi['flash'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly strikePose: DeskActivityApi['strikePose'];
};

export function createTodoCard(r: TodoCardNeeds) {
  // Claude Code's task list for this tab, as a checklist the robot ticks off.
  const todoEl = $('#todo');

  function renderTodo() {
    const t = r.current(); // (it has tasks only with a tab open)
    const tasks = t?.tasks || [];
    todoEl.hidden = !tasks.length;
    if (!tasks.length) return;
    const done = tasks.filter((x) => x.status === 'completed').length;
    todoEl.classList.toggle('collapsed', !!t.todoCollapsed);
    todoEl.innerHTML =
      '<div class="todo-head"><span class="todo-title"></span><span class="todo-bar"><i></i></span><span class="todo-chev"></span></div><ul class="todo-list"></ul>';
    $('.todo-title', todoEl).textContent = `Plan  ${done}/${tasks.length}`;
    $<HTMLElement>('.todo-bar i', todoEl).style.width = `${(done / tasks.length) * 100}%`;
    $('.todo-chev', todoEl).textContent = t.todoCollapsed ? 'show' : 'hide';
    $('.todo-head', todoEl).addEventListener('click', () => {
      t.todoCollapsed = !t.todoCollapsed;
      renderTodo();
    });
    const list = $('.todo-list', todoEl);
    for (const task of tasks) {
      const li = document.createElement('li');
      li.className = `${task.status}${task.id === t.justDone ? ' just-done' : ''}`;
      li.innerHTML = '<span class="ti"></span><span class="tt"></span>';
      $('.ti', li).textContent = ''; // (a checkbox drawn in CSS: empty, spinning, ticked)
      $('.tt', li).textContent = task.status === 'in_progress' ? task.activeForm || task.subject : task.subject;
      list.appendChild(li);
    }
  }

  function onTasks(tab: ChatTab, ev: Extract<ChatEvent, { type: 'tasks' }>) {
    tab.tasks = ev.tasks;
    const c = ev.change || {};
    const task = tab.tasks.find((x) => x.id === c.id);
    tab.justDone = c.op === 'update' && c.status === 'completed' ? c.id : null;
    if (c.op === 'create') tab.todoCollapsed = false;
    if (tab === r.active()) renderTodo();
    if (tab !== r.active() || !r.animates(tab)) return;
    if (c.op === 'update' && c.status === 'completed') {
      const allDone = tab.tasks.every((x) => x.status === 'completed');
      Sfx.tick();
      r.flash('hop', 600);
      r.express('happy', 'smile', 1200);
      if (allDone) {
        r.strikePose('cheer', 1600);
        r.showPop('All tasks done! ✨', 2200);
        setTimeout(() => {
          tab.todoCollapsed = true;
          if (tab === r.active()) renderTodo();
        }, 8000);
      } else if (task)
        r.showPop(`✓ ${task.subject.length > 34 ? `${task.subject.slice(0, 33)}…` : task.subject}`, 1800);
    }
  }
  return { onTasks, renderTodo };
}
export type TodoCardApi = ReturnType<typeof createTodoCard>;
