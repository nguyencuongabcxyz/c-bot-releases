import type { FileInfo } from '@/types/model';
import type { IslandRobot, StageState } from '@/types/ipc';
import { showView } from '@/ui/view';
import { headSvg } from '@/ui/head';
import markup from './stage.html?raw';
import '@/ui/theme.css';
import './stage.css';
import * as ipc from '@/ipc';

showView(markup, { title: 'C-Bot stage' });

(() => {
  // The stage's bar (main robots/stage/mod.rs; docs/mockups/stage-*.svg). While robots are being picked
  // (Ctrl+click), a pill saying who, to take the stage; on stage, the bar along the bottom of
  // the screen: one message to every robot on it (each asks it in its own chat; click a
  // robot's chip to leave it out), and the stage's buttons. Main sizes and places the window.
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
  const body = document.body;
  const input = $<HTMLTextAreaElement>('#b-input');
  let now: StageState | null = null;
  let files: FileInfo[] = [];

  const byId = (id: string) => now?.robots.find((r) => r.id === id);
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

  function face(r: IslandRobot | undefined, n?: number) {
    const f = document.createElement('span');
    f.className = 'face';
    f.innerHTML = headSvg();
    f.style.color = r?.color || '#5ac8fa';
    f.classList.toggle('asking', !!r?.asking);
    f.classList.toggle('busy', !!r?.busy && !r?.asking);
    if (n != null) f.insertAdjacentHTML('beforeend', `<i class="n">${n}</i>`);
    return f;
  }

  function render(s: StageState) {
    now = s;
    body.className = `mode-${s.mode}`;
    if (s.mode === 'pick') {
      $('#p-faces').replaceChildren(...s.picked.map((id, i) => face(byId(id), i + 1)));
      const names = s.picked.map((id) => byId(id)?.name || 'Robo');
      const text = $('#p-text');
      text.replaceChildren();
      text.appendChild(document.createElement('b')).textContent = plural(names.length, 'robot');
      text.append(` picked · Ctrl+click ${names.length > 1 ? 'more' : 'another'}`);
      text.title = names.join(', ');
      const over = s.picked.length > s.room;
      ($('#p-go') as HTMLButtonElement).title = over ? `Only ${s.room} fit on this screen: the first ${s.room} go on` : 'Tile their chats over this screen';
      return;
    }
    $('#b-count').textContent = plural(s.cast.length, 'robot');
    ($('#b-add') as HTMLButtonElement).disabled = s.cast.length >= s.room;
    const chips = s.cast.map((id) => {
      const r = byId(id);
      const off = s.off.includes(id);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip${off ? ' off' : ''}`;
      b.style.setProperty('--c', r?.color || '#5ac8fa');
      b.title = off ? `${r?.name} is left out: click to send to it too` : `Click to leave ${r?.name} out`;
      b.append(face(r), r?.name || 'Robo');
      b.addEventListener('click', () => ipc.stageAct('chip', id));
      return b;
    });
    $('#b-chips').replaceChildren(...chips);
    syncSend();
  }

  function syncSend() {
    const to = now ? now.cast.filter((id) => !now!.off.includes(id)).length : 0;
    const send = $<HTMLButtonElement>('#b-send');
    send.disabled = !to || (!input.value.trim() && !files.length);
    input.placeholder = to ? `Ask ${to === now?.cast.length ? 'everyone on stage' : plural(to, 'robot')}… (Enter sends)` : 'Pick someone to send to: click a robot below';
  }

  function renderFiles() {
    const box = $('#b-files');
    box.hidden = !files.length;
    box.replaceChildren();
    if (!files.length) return syncSend();
    const label = box.appendChild(document.createElement('span'));
    label.textContent = files.length === 1 ? `📎 ${files[0].name}` : `📎 ${files.length} files`;
    label.title = files.map((f) => f.path).join('\n');
    const x = box.appendChild(document.createElement('button'));
    x.type = 'button';
    x.title = "Don't send them";
    x.textContent = '×';
    x.addEventListener('click', () => {
      files = [];
      renderFiles();
    });
    syncSend();
  }

  async function send() {
    const text = input.value.trim();
    if (!text && !files.length) return;
    const res = await ipc.stageSend(text || (files.length === 1 ? 'Take a look at this.' : 'Take a look at these.'), files.map((f) => f.path));
    if (!res.ok) {
      input.placeholder = res.error;
      return;
    }
    input.value = '';
    files = [];
    renderFiles();
  }

  $('#p-go').addEventListener('click', () => ipc.stageAct('start'));
  $('#p-clear').addEventListener('click', () => ipc.stageAct('clear'));
  $('#b-exit').addEventListener('click', () => ipc.stageAct('exit'));
  $('#b-even').addEventListener('click', () => ipc.stageAct('even'));
  $('#b-add').addEventListener('click', () => ipc.stageAddMenu());
  $('#b-attach').addEventListener('click', async () => {
    const picked = await ipc.stagePickFiles();
    files = [...files, ...picked.filter((p) => !files.some((f) => f.path === p.path))].slice(0, 20);
    renderFiles();
    input.focus();
  });
  $('#b-send').addEventListener('click', send);
  $('#b-send-form').addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  input.addEventListener('input', syncSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  ipc.on('stage:state', render);
  ipc.stageInit().then(render);
})();
