// "Past conversations" view inside the speech bubble: every Claude Code
// conversation in the robot's folder, a read-only preview, Resume, and the bin.
import { $ } from '@/lib/dom';
import type { SessionRow } from '@/types/model';
import { Icon } from '@/icons/icons';
import { planSummary } from '../plan/modes';
import * as ipc from '@/ipc';

/** A conversation picked up again (robot:resume). */
export type Resumed = Extract<Awaited<ReturnType<typeof ipc.robotResume>>, { ok: true }>;

export const HistoryView = ({
  md,
  robotName,
  activeTabId,
  onResumed,
  onClose,
}: {
  md: (text: string) => string;
  robotName: () => string;
  activeTabId: () => string;
  onResumed: (res: Resumed) => void;
  onClose?: () => void;
}) => {
  // (the view's elements: always in its markup, robot/robot.html)
  const root = $('#history');
  const list = $('#h-list');
  const search = $<HTMLInputElement>('#h-search');
  const preview = $('#h-preview');
  const back = $('#h-back');
  const resumeBtn = $<HTMLButtonElement>('#h-resume');
  const clearBtn = $<HTMLButtonElement>('#h-clear');
  const deleteBtn = $('#h-delete');
  const pickedBar = $('#h-picked');
  let sessions: SessionRow[] = [];
  let shown: SessionRow[] = []; // (the list as it's drawn: all, or what the search matches)
  let showing: SessionRow | null = null; // session being previewed
  let confirmElsewhere = false;
  const picked = new Set<string>(); // ticked to delete
  let lastPick = -1; // (where a Shift+click ticks from)

  function ago(ms: number) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 2 * 86400) return 'yesterday';
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
    return new Date(ms).toLocaleDateString();
  }

  function renderList() {
    const q = search.value.trim().toLowerCase();
    shown = q ? sessions.filter((s) => `${s.title} ${s.preview}`.toLowerCase().includes(q)) : sessions;
    lastPick = -1;
    clearBtn.disabled = !sessions.some((s) => s.byRobot && !s.tabId);
    list.innerHTML = '';
    renderPicked();
    if (!shown.length) {
      const empty = document.createElement('p');
      empty.className = 'h-empty';
      empty.textContent = sessions.length
        ? `Nothing matches “${search.value.trim()}”.`
        : 'No past conversations in this folder yet. Ask me something!';
      list.appendChild(empty);
      return;
    }
    list.append(...shown.map(row));
  }

  // a row: its tick (none for one open in a tab: it stays), and the conversation to preview
  function row(s: SessionRow, i: number) {
    const entry = document.createElement('div');
    entry.className = 'h-entry';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'h-pick';
    box.value = s.id;
    box.checked = picked.has(s.id);
    box.disabled = !!s.tabId;
    box.setAttribute('aria-label', `Select “${s.title}”`);
    box.addEventListener('click', (e) => pick(i, box.checked, e.shiftKey));
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `h-item${s.current ? ' current' : ''}`;
    item.innerHTML =
      '<div class="h-row"><span class="h-name"></span><span class="h-when"></span></div><div class="h-sub"></div>';
    $('.h-name', item).textContent = s.title;
    $('.h-when', item).textContent = ago(s.updatedAt);
    const bits = [];
    if (s.current) bits.push('● this tab');
    else if (s.tabId) bits.push('📑 open in another tab');
    else if (s.active) bits.push('🟢 open elsewhere');
    bits.push(s.byRobot ? `🤖 with ${robotName()}` : '💻 Claude Code');
    if (s.messages) bits.push(`${s.messages} messages`);
    // (each bit can start with an emoji: drawn as its line icon)
    const sub = $('.h-sub', item);
    bits.forEach((b, j) => {
      if (j) sub.append(' · ');
      sub.append(Icon.text(document.createElement('span'), b));
    });
    item.title = s.preview ? `Last: ${s.preview}` : s.title;
    item.addEventListener('click', () => openPreview(s));
    entry.append(box, item);
    return entry;
  }

  // ---- ticking several to delete at once (Shift+click: the ones in between too)
  function pick(i: number, on: boolean, range: boolean) {
    const from = range && lastPick >= 0 ? Math.min(lastPick, i) : i;
    const to = range && lastPick >= 0 ? Math.max(lastPick, i) : i;
    for (const s of shown.slice(from, to + 1).filter((s) => !s.tabId)) {
      if (on) picked.add(s.id);
      else picked.delete(s.id);
    }
    lastPick = i;
    for (const box of list.querySelectorAll<HTMLInputElement>('.h-pick')) box.checked = picked.has(box.value);
    renderPicked();
  }

  function renderPicked() {
    pickedBar.hidden = !picked.size || !!showing;
    root.classList.toggle('picking', picked.size > 0);
    $('#h-picked-n').textContent = `${picked.size} selected`;
  }

  function unpick() {
    picked.clear();
    renderList();
  }

  $('#h-pick-all').addEventListener('click', () => {
    for (const s of shown) if (!s.tabId) picked.add(s.id);
    renderList();
  });
  $('#h-pick-none').addEventListener('click', unpick);
  $('#h-pick-del').addEventListener('click', async () => {
    const n = picked.size;
    if (!n || !confirm(`Delete ${n} conversation${n === 1 ? '' : 's'}? They can’t be brought back.`)) return;
    await ipc.robotForgetSessions([...picked]);
    picked.clear();
    await reload();
  });

  async function openPreview(s: SessionRow) {
    showing = s;
    confirmElsewhere = false;
    root.classList.add('previewing');
    preview.hidden = false;
    list.hidden = true;
    back.hidden = false;
    clearBtn.hidden = true;
    deleteBtn.hidden = !!s.tabId; // (open in a tab: it stays)
    renderPicked();
    $('#h-ptitle').textContent = s.title;
    const msgs = $('#h-msgs');
    msgs.innerHTML = '<p class="h-empty">Opening the transcript…</p>';
    setResumeButton();
    const full = await ipc.robotSession(s.id);
    if (showing !== s) return;
    msgs.innerHTML = '';
    if (!full?.messages.length) {
      msgs.innerHTML = '<p class="h-empty">This conversation has nothing readable in it.</p>';
      return;
    }
    if (full.total > full.messages.length) {
      const note = document.createElement('p');
      note.className = 'h-empty';
      note.textContent = `Showing the last ${full.messages.length} of ${full.total} messages.`;
      msgs.appendChild(note);
    }
    for (const m of full.messages) {
      const el = document.createElement('div');
      if (m.role === 'plan') {
        msgs.appendChild(planSummary(md, m));
        continue;
      }
      if (m.role === 'qa') {
        for (const it of m.items) {
          const row = document.createElement('div');
          row.className = 'msg qa-summary';
          row.innerHTML = `${Icon('hand', 'sm lead')}<span></span> → <b></b>`;
          $('span', row).textContent = it.question;
          $('b', row).textContent = it.answer;
          msgs.appendChild(row);
        }
        continue;
      }
      if (m.role === 'user') {
        el.className = 'msg user';
        el.textContent = m.text;
      } else if (m.role === 'note') {
        el.className = 'msg note';
        el.textContent = m.text;
      } else {
        el.className = 'msg bot';
        if (m.tools?.length || m.asides?.length) {
          const tools = document.createElement('div');
          tools.className = 'tools';
          for (const [name, n] of countTools(m.tools || [])) {
            const chip = document.createElement('span');
            chip.className = 'tool';
            // "Skill(anthropic-skills:pptx)" -> Skill: pptx (anthropic-skills)
            const m = name.match(/^(\w+)\((.+)\)$/);
            const shown = m
              ? `${m[1]}: ${m[2].includes(':') ? `${m[2].slice(m[2].lastIndexOf(':') + 1)} (${m[2].slice(0, m[2].lastIndexOf(':'))})` : m[2]}`
              : name;
            chip.textContent = n > 1 ? `${shown} ×${n}` : shown;
            tools.appendChild(chip);
          }
          for (const a of m.asides || []) {
            const chip = document.createElement('span');
            chip.className = 'tool aside';
            Icon.text(chip, `💭 ${a}`);
            tools.appendChild(chip);
          }
          el.appendChild(tools);
        }
        const body = document.createElement('div');
        body.innerHTML = md(m.text || '_(worked without saying anything)_');
        el.appendChild(body);
      }
      msgs.appendChild(el);
    }
    msgs.scrollTop = msgs.scrollHeight;
  }

  function countTools(tools: string[]) {
    const counts = new Map<string, number>();
    for (const t of tools) counts.set(t, (counts.get(t) || 0) + 1);
    return counts;
  }

  function setResumeButton() {
    const s = showing;
    resumeBtn.disabled = !s || s.current;
    resumeBtn.classList.toggle('warn', confirmElsewhere);
    Icon.text(
      resumeBtn,
      !s
        ? 'Resume'
        : s.current
          ? 'This is our current conversation'
          : s.tabId
            ? '📑 Switch to its tab'
            : confirmElsewhere
              ? 'It’s open in another Claude Code window. Resume anyway?'
              : '↩ Resume this conversation',
    );
  }

  function showList() {
    showing = null;
    root.classList.remove('previewing');
    preview.hidden = true;
    list.hidden = false;
    back.hidden = true;
    clearBtn.hidden = false;
    deleteBtn.hidden = true;
    renderPicked();
    search.focus();
  }

  async function reload() {
    sessions = await ipc.robotSessions();
    renderList();
  }

  // the bin: in the list, every conversation it had; in a preview, that one
  // (ones open in a tab stay: main keeps them)
  clearBtn.addEventListener('click', async () => {
    if (!confirm(`Delete all your past conversations with ${robotName()}? They can’t be brought back.`)) return;
    await ipc.robotForgetSessions();
    picked.clear();
    await reload();
  });
  deleteBtn.addEventListener('click', async () => {
    const s = showing;
    if (!s || !confirm(`Delete “${s.title}”? It can’t be brought back.`)) return;
    await ipc.robotForgetSessions([s.id]);
    picked.delete(s.id);
    showList();
    await reload();
  });

  resumeBtn.addEventListener('click', async () => {
    const s = showing;
    if (!s || s.current) return;
    if (s.active && !s.tabId && !confirmElsewhere) {
      confirmElsewhere = true;
      setResumeButton();
      return;
    }
    resumeBtn.disabled = true;
    const res = await ipc.robotResume(activeTabId(), s.id);
    if (!res.ok) {
      resumeBtn.disabled = false;
      resumeBtn.textContent = res.error;
      return;
    }
    close();
    onResumed(res);
  });
  back.addEventListener('click', showList);
  $('#h-close').addEventListener('click', () => close());
  search.addEventListener('input', renderList);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      list.querySelector<HTMLElement>('.h-item')?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      list.querySelector<HTMLElement>('.h-item')?.click();
    }
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...list.querySelectorAll<HTMLElement>('.h-item')];
    const i = (items as (Element | null)[]).indexOf(document.activeElement); // (-1: none of them has the focus)
    const next = e.key === 'ArrowDown' ? items[i + 1] : items[i - 1];
    if (next) next.focus();
    else if (e.key === 'ArrowUp') search.focus();
  });

  async function open(query = '') {
    document.body.classList.add('history-open');
    root.hidden = false;
    search.value = query;
    picked.clear();
    showList();
    list.innerHTML = '<p class="h-empty">Looking through old notes…</p>';
    await reload();
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('history-open');
    onClose?.();
  }

  // Esc steps back: preview -> list -> ticks off -> closed
  function stepBack() {
    if (showing) showList();
    else if (picked.size) unpick();
    else close();
  }

  return { open, close, stepBack, isOpen: () => !root.hidden };
};
