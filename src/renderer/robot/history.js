/* global cbot */
// "Past conversations" view inside the speech bubble: every Claude Code
// conversation in the robot's folder, a read-only preview, and Resume.
window.HistoryView = ({ md, robotName, activeTabId, onResumed, onClose }) => {
  const $ = (sel) => document.querySelector(sel);
  const root = $('#history');
  const list = $('#h-list');
  const search = $('#h-search');
  const preview = $('#h-preview');
  const back = $('#h-back');
  const resumeBtn = $('#h-resume');
  let sessions = [];
  let showing = null; // session being previewed
  let confirmElsewhere = false;

  function ago(ms) {
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
    const shown = q ? sessions.filter((s) => `${s.title} ${s.preview}`.toLowerCase().includes(q)) : sessions;
    list.innerHTML = '';
    if (!shown.length) {
      const empty = document.createElement('p');
      empty.className = 'h-empty';
      empty.textContent = sessions.length ? `Nothing matches “${search.value.trim()}”.` : 'No past conversations in this folder yet. Ask me something!';
      list.appendChild(empty);
      return;
    }
    for (const s of shown) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `h-item${s.current ? ' current' : ''}`;
      item.innerHTML = '<div class="h-row"><span class="h-name"></span><span class="h-when"></span></div><div class="h-sub"></div>';
      item.querySelector('.h-name').textContent = s.title;
      item.querySelector('.h-when').textContent = ago(s.updatedAt);
      const bits = [];
      if (s.current) bits.push('● this tab');
      else if (s.tabId) bits.push('📑 open in another tab');
      else if (s.active) bits.push('🟢 open elsewhere');
      bits.push(s.byRobot ? `🤖 with ${robotName()}` : '💻 Claude Code');
      if (s.messages) bits.push(`${s.messages} messages`);
      // (each bit can start with an emoji: drawn as its line icon)
      const sub = item.querySelector('.h-sub');
      bits.forEach((b, i) => {
        if (i) sub.append(' · ');
        sub.append(Icon.text(document.createElement('span'), b));
      });
      item.title = s.preview ? `Last: ${s.preview}` : s.title;
      item.addEventListener('click', () => openPreview(s));
      list.appendChild(item);
    }
  }

  async function openPreview(s) {
    showing = s;
    confirmElsewhere = false;
    root.classList.add('previewing');
    preview.hidden = false;
    list.hidden = true;
    back.hidden = false;
    $('#h-ptitle').textContent = s.title;
    const msgs = $('#h-msgs');
    msgs.innerHTML = '<p class="h-empty">Opening the transcript…</p>';
    setResumeButton();
    const full = await cbot.invoke('robot:session', s.id);
    if (showing !== s) return;
    msgs.innerHTML = '';
    if (!full || !full.messages.length) {
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
      if (m.role === 'qa') {
        for (const it of m.items) {
          const row = document.createElement('div');
          row.className = 'msg qa-summary';
          row.innerHTML = `${Icon('hand', 'sm lead')}<span></span> → <b></b>`;
          row.querySelector('span').textContent = it.question;
          row.querySelector('b').textContent = it.answer;
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
            const shown = m ? `${m[1]}: ${m[2].includes(':') ? `${m[2].slice(m[2].lastIndexOf(':') + 1)} (${m[2].slice(0, m[2].lastIndexOf(':'))})` : m[2]}` : name;
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

  function countTools(tools) {
    const counts = new Map();
    for (const t of tools) counts.set(t, (counts.get(t) || 0) + 1);
    return counts;
  }

  function setResumeButton() {
    const s = showing;
    resumeBtn.disabled = !s || s.current;
    resumeBtn.classList.toggle('warn', confirmElsewhere);
    Icon.text(resumeBtn, !s
      ? 'Resume'
      : s.current
        ? 'This is our current conversation'
        : s.tabId
          ? '📑 Switch to its tab'
          : confirmElsewhere
          ? 'It’s open in another Claude Code window. Resume anyway?'
          : '↩ Resume this conversation');
  }

  function showList() {
    showing = null;
    root.classList.remove('previewing');
    preview.hidden = true;
    list.hidden = false;
    back.hidden = true;
    search.focus();
  }

  resumeBtn.addEventListener('click', async () => {
    const s = showing;
    if (!s || s.current) return;
    if (s.active && !s.tabId && !confirmElsewhere) {
      confirmElsewhere = true;
      setResumeButton();
      return;
    }
    resumeBtn.disabled = true;
    const res = await cbot.invoke('robot:resume', activeTabId(), s.id);
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
      list.querySelector('.h-item')?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      list.querySelector('.h-item')?.click();
    }
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...list.querySelectorAll('.h-item')];
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? items[i + 1] : items[i - 1];
    if (next) next.focus();
    else if (e.key === 'ArrowUp') search.focus();
  });

  async function open(query = '') {
    document.body.classList.add('history-open');
    root.hidden = false;
    search.value = query;
    showList();
    list.innerHTML = '<p class="h-empty">Looking through old notes…</p>';
    sessions = await cbot.invoke('robot:sessions');
    renderList();
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('history-open');
    onClose?.();
  }

  // Esc steps back: preview -> list -> closed
  function escape() {
    if (showing) showList();
    else close();
  }

  return { open, close, escape, isOpen: () => !root.hidden };
};
