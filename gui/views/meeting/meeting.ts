// The group chat's meeting room (main meeting.js): everyone in the chat round one table
// (office3d/meeting.js draws it), and a speech bubble over whoever just said something.
// From main: meeting:state (who's typing, talking, agreeing; the phase) and meeting:say
// (a line of what someone just posted).
import { Meeting3D } from '@/office3d/meeting';
import type { MeetingState } from '@/types/pages';
import { showView } from '@/ui/view';
import markup from './meeting.html?raw';
import './meeting.css';
import * as ipc from '@/ipc';

showView(markup, { title: 'Meeting room' });

(() => {
  const host = document.getElementById('room')!;
  const bubbles = new Map<string, { el: HTMLDivElement; timer?: number; kind?: string }>(); // robot id -> { el, until, kind }
  let view: ReturnType<typeof Meeting3D.mount> | null = null;
  let state: Omit<MeetingState, 'ids'> & { ids?: string[] } = { speaker: null, typing: [], agree: [], phase: 'running', mode: 'free' };
  const talking = new Map<string, number>(); // robot id -> talking until (ms): it just posted something

  // the bubbles follow the heads, only while there are any
  function place() {
    for (const [id, b] of bubbles) {
      const at = view?.headAt(id);
      if (!at) {
        b.el.classList.remove('show');
        continue;
      }
      b.el.style.left = `${Math.round(at.x)}px`;
      b.el.style.top = `${Math.round(at.y)}px`;
    }
  }
  function bubble(id: string, text: string, { kind = '', ms = 0 } = {}) {
    let b = bubbles.get(id);
    if (!b) {
      const el = document.createElement('div');
      el.className = 'say';
      document.body.append(el);
      b = { el };
      bubbles.set(id, b);
    }
    clearTimeout(b.timer);
    b.kind = kind;
    b.el.textContent = text;
    b.el.className = `say ${kind}`;
    requestAnimationFrame(() => b.el.classList.add('show'));
    if (ms) b.timer = setTimeout(() => hide(id), ms);
  }
  function hide(id: string) {
    const b = bubbles.get(id);
    if (!b) return;
    b.el.classList.remove('show');
    b.kind = '';
  }

  // what each one's doing now, from the chat's state
  function apply() {
    if (!view) return;
    const typing = new Set(state.typing);
    const agree = new Set(state.agree);
    const now = Date.now();
    let focus = null;
    for (const id of state.ids || []) {
      let mode = 'idle';
      if (state.phase === 'summarising' && id === state.speaker) mode = 'summary';
      else if ((talking.get(id) || 0) > now) mode = 'talking';
      else if (id === state.speaker) mode = 'talking'; // (taking turns: its words are coming in)
      else if (typing.has(id)) mode = 'typing';
      else if (agree.has(id)) mode = 'agree';
      view.act(id, mode);
      if (mode === 'talking' || mode === 'summary') focus = id;
      // (a speech bubble wins over the dots)
      const b = bubbles.get(id);
      if (mode === 'summary' && b?.kind !== 'note') bubble(id, '📝 writing the summary…', { kind: 'note' });
      else if (mode === 'typing' && !b?.kind) bubble(id, '•••', { kind: 'dots' });
      else if (mode !== 'typing' && b?.kind === 'dots') hide(id);
      else if (mode !== 'summary' && b?.kind === 'note') hide(id);
    }
    view.focus(focus);
  }

  ipc.on('meeting:state', (s) => {
    state = { ...state, ...s };
    apply();
  });
  ipc.on('meeting:say', ({ id, text, agree }) => {
    talking.set(id, Date.now() + 2600);
    bubble(id, text, { ms: 5200 });
    if (agree) setTimeout(() => bubble(id, '✓ agreed', { kind: 'ok', ms: 2200 }), 5300);
    apply();
    setTimeout(apply, 2700); // (and back to listening)
  });

  ipc.meetingInit().then((init) => {
    if (!init) return;
    view = Meeting3D.mount(host, { width: innerWidth, height: innerHeight, onFrame: () => bubbles.size && place() });
    view.topic(init.topic);
    view.seat(init.people);
    state = { ...state, ...init.state, ids: init.people.map((p) => p.id) };
    apply();
  });
  addEventListener('resize', () => view?.resize(innerWidth, innerHeight));
})();
