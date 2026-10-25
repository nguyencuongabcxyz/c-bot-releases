/* global cbot, marked, DOMPurify, Icon */
// The robot group chat (main groupChat.js runs it): first the topic and who joins, then the
// robots talking it over live, your messages in between, and the summary at the end.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const act = (action, p) => cbot.invoke('groupchat:act', action, p);

  marked.setOptions({ gfm: true, breaks: true });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  const md = (text) => DOMPurify.sanitize(marked.parse(String(text || '').replace(/<\/?agree\s*\/?>/gi, '')));

  let state = null;
  const texts = new Map(); // message id -> its text so far (a live one grows with each delta)
  const els = new Map(); // message id -> its element
  const pick = { style: 'free', messages: 20, rounds: 3, cap: 1, brain: 'own', meeting: 'on', members: null };

  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 1800);
  }

  // ------------------------------------------------------------ setup

  function renderSetup(s) {
    const onDesk = s.robots.filter((r) => r.onDesk);
    if (!pick.members) pick.members = new Set(onDesk.map((r) => r.id));
    const host = (s.hostId && pick.members.has(s.hostId) ? s.robots.find((r) => r.id === s.hostId) : null) || s.robots.find((r) => pick.members.has(r.id));
    $('host-line').textContent = host ? `· ${host.name} hosts: it opens and sums up` : '';
    $('pick').innerHTML = s.robots.length
      ? s.robots
          .map(
            (r) => `<label class="${r.onDesk ? '' : 'off'}" style="--paint:${esc(r.color || '')}">
              <input type="checkbox" value="${esc(r.id)}" ${pick.members.has(r.id) ? 'checked' : ''} ${r.onDesk ? '' : 'disabled'} />
              <span class="face">${esc(r.emoji)}</span>
              <span class="who"><span class="name">${esc(r.name)}</span> <span class="sub">${esc(r.personality)} · ${esc(r.folder)}</span>
              ${r.onDesk ? '' : '<div class="sub">put away: bring it out from the tray to add it</div>'}</span>
              ${host?.id === r.id ? '<span class="tag">host</span>' : r.asleep ? '<span class="tag">asleep: it wakes up</span>' : ''}
            </label>`
          )
          .join('')
      : '<p class="hint">No robots yet: make some in the Robot Workshop first.</p>';
    $('messages').innerHTML = s.messages.map((n) => `<button type="button" data-v="${n}" class="${n === pick.messages ? 'on' : ''}">${n}</button>`).join('');
    $('rounds').innerHTML = s.rounds.map((n) => `<button type="button" data-v="${n}" class="${n === pick.rounds ? 'on' : ''}">${n}</button>`).join('');
    $('caps').innerHTML = s.caps.map((n) => `<button type="button" data-v="${n}" class="${n === pick.cap ? 'on' : ''}">$${n < 1 ? n.toFixed(2) : n}</button>`).join('');
    for (const b of $('brains').children) b.classList.toggle('on', b.dataset.v === pick.brain);
    for (const b of $('styles').children) b.classList.toggle('on', b.dataset.v === pick.style);
    for (const b of $('meetings').children) b.classList.toggle('on', b.dataset.v === pick.meeting);
    renderPlan();
  }
  // what the style, the length and the cost cap mean, for what's picked
  function renderPlan() {
    const n = pick.members?.size || 0;
    const cap = pick.cap < 1 ? pick.cap.toFixed(2) : pick.cap;
    const turns = pick.style === 'turns';
    $('messages-field').hidden = turns;
    $('rounds-field').hidden = !turns;
    $('plan').textContent =
      n < 2
        ? 'Tick at least two robots.'
        : (turns
            ? `One at a time: in a round each robot speaks once, so up to ${pick.rounds} rounds is at most ${n * pick.rounds} messages, then the host sums it up. It ends sooner if they all agree, `
            : `Like a chat app: everyone sees every message and speaks up when they have something to add (several may type at once), up to ${pick.messages} messages, then the host sums it up. It ends sooner when nobody has more to add, `) +
          `if you wrap it up, or once it has cost $${cap} of Claude usage (the cost cap). ` +
          (pick.brain === 'fast' ? 'Fast chats usually cost a few cents.' : turns ? 'With their own models a chat often costs $0.10 to $0.50.' : 'With their own models a chat often costs $0.20 to $1.')
  }

  $('pick').addEventListener('change', (e) => {
    if (e.target.type !== 'checkbox') return;
    if (e.target.checked) pick.members.add(e.target.value);
    else pick.members.delete(e.target.value);
    renderSetup(state);
  });
  const seg = (id, key, conv) =>
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      pick[key] = conv(b.dataset.v);
      for (const x of $(id).children) x.classList.toggle('on', x === b);
      renderPlan();
    });
  seg('styles', 'style', String);
  seg('messages', 'messages', Number);
  seg('rounds', 'rounds', Number);
  seg('caps', 'cap', Number);
  seg('brains', 'brain', String);
  seg('meetings', 'meeting', String);

  $('setup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('setup-error');
    err.hidden = true;
    const r = await act('start', { topic: $('topic').value, members: state.robots.filter((x) => pick.members.has(x.id)).map((x) => x.id), style: pick.style, meeting: pick.meeting === 'on', messages: pick.messages, rounds: pick.rounds, cap: pick.cap, brain: pick.brain });
    if (r?.error) {
      err.textContent = r.error;
      err.hidden = false;
    }
  });
  $('topic').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('setup').requestSubmit();
  });

  // ------------------------------------------------------------ the chat

  const robotOf = (id) => state.robots.find((r) => r.id === id) || {};
  const nearBottom = () => {
    const log = $('log');
    return log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  };
  const toBottom = () => ($('log').scrollTop = $('log').scrollHeight);

  function msgHtml(m) {
    if (m.who === 'system') return `<div class="body">${esc(m.text)}</div>`;
    if (m.who === 'user') return `<div class="body"><div class="text">${md(m.text)}</div></div>`;
    const r = robotOf(m.robot);
    const looked = (m.looked || []).slice(-4).map((d) => `<div>📖 ${esc(d)}</div>`).join('');
    const text = texts.get(m.id) ?? m.text;
    const sub = m.who === 'summary' ? 'summary' : m.asked ? 'answering you' : state.mode === 'turns' ? `round ${m.round}` : new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<span class="face">${esc(r.emoji || '🤖')}</span>
      <div class="body">
        <div class="head"><span class="name">${esc(m.name)}</span><span class="sub">${esc(sub)}</span>
          ${m.agree ? '<span class="agree">✓ agrees</span>' : ''}${m.note ? `<span class="note">${esc(m.note)}</span>` : ''}</div>
        ${looked ? `<div class="looked">${looked}</div>` : ''}
        ${m.live && !text ? `<div class="thinking">${m.who === 'summary' ? 'writing the summary' : looked ? 'looking into it' : 'thinking'}</div>` : ''}
        <div class="text"></div>
        ${m.error ? `<div class="err">Couldn't answer: ${esc(m.error)}</div>` : ''}
      </div>`;
  }

  function renderMsg(m) {
    let el = els.get(m.id);
    if (!el) {
      el = document.createElement('div');
      els.set(m.id, el);
      $('log').append(el);
    }
    el.className = `msg ${m.who}`;
    if (m.robot) el.style.setProperty('--paint', robotOf(m.robot).color || '');
    el.innerHTML = msgHtml(m);
    const text = texts.get(m.id) ?? m.text;
    if (m.who === 'robot' || m.who === 'summary') el.querySelector('.text').replaceChildren(...(text ? [fragment(md(text))] : []));
    el.dataset.key = key(m);
  }
  const fragment = (html) => document.createRange().createContextualFragment(html);
  const key = (m) => JSON.stringify([m.text, m.live, m.note, m.error, m.agree, (m.looked || []).length]);

  function renderChat(s) {
    $('topic-line').textContent = s.topic;
    $('topic-chip').hidden = true;
    $('faces').innerHTML = s.robots
      .map((r) => {
        const last = [...s.log].reverse().find((m) => m.robot === r.id && m.who === 'robot');
        const agrees = s.mode === 'turns' ? last?.agree && last.round === s.round : r.agree;
        const talking = r.id === s.speaker || s.typing.some((t) => t.id === r.id);
        const cls = [talking ? 'speaking' : '', r.out ? 'out' : '', agrees ? 'agree' : ''].join(' ');
        return `<span class="face ${cls}" data-mention="${esc(r.id)}" style="--paint:${esc(r.color || '')}" title="${esc(r.name)}${r.id === s.hostId ? ' (host)' : ''}${r.out ? ': left' : ': click to @mention'}">${esc(r.emoji)}</span>`;
      })
      .join('');
    const progress = s.mode === 'turns' ? `round ${s.round} of ${s.rounds}` : `${s.said} of ${s.messages} messages`;
    const phase = { running: s.wrapping ? 'wrapping up' : progress, summarising: 'summing up', done: 'done', stopped: 'stopped' }[s.phase];
    $('meter').textContent = `${phase} · $${s.cost.toFixed(2)} spent of $${s.cap.toFixed(2)} cap`;

    const stick = nearBottom();
    const seen = new Set();
    for (const m of s.log) {
      seen.add(m.id);
      if (!m.live) texts.delete(m.id);
      else if (!texts.has(m.id) || (m.text || '').length > texts.get(m.id).length) texts.set(m.id, m.text || '');
      const el = els.get(m.id);
      if (!el || el.dataset.key !== key(m)) renderMsg(m);
    }
    for (const [id, el] of els) if (!seen.has(id)) (el.remove(), els.delete(id));
    renderTyping(s);
    if (stick) toBottom();

    // what you can do now
    const live = s.phase === 'running' || s.phase === 'summarising';
    const summary = [...s.log].reverse().find((m) => m.who === 'summary' && m.text);
    const bar = [];
    if (s.phase === 'running') {
      bar.push(`<button data-act="wrap" class="primary" data-icon="sparkles" ${s.wrapping ? 'disabled' : ''}>Wrap up and summarise</button>`);
      bar.push('<button data-act="stop" data-icon="stop">Stop</button>');
    } else if (s.phase === 'summarising') {
      bar.push('<button data-act="stop" data-icon="stop">Stop</button>');
    } else {
      if (s.phase === 'stopped' && !summary) bar.push('<button data-act="wrap" class="primary" data-icon="sparkles">Summarise</button>');
      if (summary && s.phase === 'done') {
        bar.push('<button data-act="copy" data-icon="copy">Copy summary</button>');
        bar.push('<button data-act="save-note" data-icon="note-plus">Save to notes</button>');
      }
      bar.push('<button data-act="more" data-icon="refresh">Keep talking</button>');
      bar.push('<button data-act="copy-all" data-icon="copy">Copy chat</button>');
      bar.push('<button data-act="new" data-icon="plus">New topic</button>');
    }
    $('bar').innerHTML = bar.join('');
    Icon.fill($('bar'));
    $('say').placeholder = live ? 'Chime in…  (type @ to ask one of them)' : 'Say something to start them up again…';
  }

  // free chat: who's writing something right now
  function renderTyping(s) {
    const who = (s.typing || []).map((t) => ({ ...t, r: robotOf(t.id) }));
    const box = $('typing');
    box.hidden = !who.length || s.phase !== 'running';
    if (box.hidden) return;
    const names = who.map((t) => t.r.name);
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    const looking = who.filter((t) => t.looked).map((t) => `${t.r.name}: 📖 ${t.looked}`);
    box.innerHTML = `<span class="faces">${who.map((t) => `<span class="face" style="--paint:${esc(t.r.color || '')}">${esc(t.r.emoji || '🤖')}</span>`).join('')}</span>
      <span class="who"><span class="thinking">${esc(list)} ${names.length === 1 ? 'is' : 'are'} typing</span>${looking.length ? `<span class="looked">${esc(looking.join(' · '))}</span>` : ''}</span>`;
  }

  $('bar').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const r = await act(b.dataset.act);
    if (b.dataset.act === 'copy' && r) toast('Summary copied');
    if (b.dataset.act === 'copy-all' && r) toast('Chat copied');
    if (b.dataset.act === 'save-note') toast(r ? 'Saved to your notes 📒' : "Couldn't save it");
  });

  // your message
  const say = $('say');
  const grow = () => {
    say.style.height = 'auto';
    say.style.height = `${Math.min(120, say.scrollHeight)}px`;
    say.style.overflowY = say.scrollHeight > 120 ? 'auto' : 'hidden';
  };
  say.addEventListener('input', () => (grow(), mentionMenu()));
  say.addEventListener('keydown', (e) => {
    if (mentionKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = say.value.trim();
    if (!text) return;
    say.value = '';
    grow();
    mentionMenu();
    act('say', { text });
    requestAnimationFrame(toBottom);
  });

  // @ to mention a robot: typing @ (and the start of a name) offers the robots in the chat;
  // ↑↓ pick, Enter or Tab puts "@Name " in, Esc closes it. Clicking a robot's face does it too.
  let picking = null; // { at: where the @ is, list: robots, i: the one picked }
  function mentionMenu() {
    const box = $('mention');
    const before = say.value.slice(0, say.selectionStart);
    const m = /(^|\s)@([\p{L}\p{N}_-]*)$/u.exec(before);
    const list = m && state?.robots ? state.robots.filter((r) => !r.out && r.name.toLowerCase().replace(/\s+/g, '').startsWith(m[2].toLowerCase())) : [];
    if (!list.length) {
      picking = null;
      box.hidden = true;
      return;
    }
    picking = { at: before.length - m[2].length - 1, list, i: Math.min(picking?.i || 0, list.length - 1) };
    box.innerHTML = list
      .map((r, i) => `<button type="button" role="option" data-i="${i}" class="${i === picking.i ? 'on' : ''}" style="--paint:${esc(r.color || '')}"><span class="face">${esc(r.emoji)}</span>${esc(r.name)} <span class="sub">${esc(r.folder)}</span></button>`)
      .join('');
    box.hidden = false;
  }
  function mention(r) {
    const tag = `@${r.name.replace(/\s+/g, '')} `;
    if (picking) {
      const end = say.selectionStart;
      say.value = say.value.slice(0, picking.at) + tag + say.value.slice(end);
      say.selectionStart = say.selectionEnd = picking.at + tag.length;
    } else {
      const v = say.value;
      say.value = v + (v && !/\s$/.test(v) ? ' ' : '') + tag;
      say.selectionStart = say.selectionEnd = say.value.length;
    }
    picking = null;
    $('mention').hidden = true;
    grow();
    say.focus();
  }
  function mentionKey(e) {
    if (!picking || e.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      picking.i = (picking.i + (e.key === 'ArrowDown' ? 1 : -1) + picking.list.length) % picking.list.length;
      [...$('mention').children].forEach((b, i) => b.classList.toggle('on', i === picking.i));
    } else if (e.key === 'Enter' || e.key === 'Tab') mention(picking.list[picking.i]);
    else if (e.key === 'Escape') {
      picking = null;
      $('mention').hidden = true;
    } else return false;
    e.preventDefault();
    return true;
  }
  $('mention').addEventListener('mousedown', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b || !picking) return;
    e.preventDefault(); // (the message box keeps the focus)
    mention(picking.list[Number(b.dataset.i)]);
  });
  say.addEventListener('blur', () => setTimeout(() => document.activeElement !== say && (($('mention').hidden = true), (picking = null)), 100));
  $('faces').addEventListener('click', (e) => {
    const f = e.target.closest('.face[data-mention]');
    const r = f && state?.robots.find((x) => x.id === f.dataset.mention);
    if (r && !r.out) mention(r);
  });

  // ------------------------------------------------------------ from main

  function render(s) {
    const was = state?.phase;
    state = s;
    const setup = s.phase === 'setup';
    $('setup').hidden = !setup;
    $('live').hidden = setup;
    if (setup) {
      if (was && was !== 'setup') {
        // a new topic: a clean slate
        texts.clear();
        els.clear();
        $('log').innerHTML = '';
        pick.members = null;
      }
      renderSetup(s);
      if (was !== 'setup') setTimeout(() => $('topic').focus(), 50);
    } else {
      renderChat(s);
      if (was === 'setup' || !was) setTimeout(() => say.focus(), 50);
    }
  }

  // a speaker's words as they come
  let pending = new Set();
  cbot.on('groupchat:delta', ({ id, delta }) => {
    if (state?.log.find((x) => x.id === id)?.live === false) return; // (already finished: its full text came with the state)
    texts.set(id, (texts.get(id) || '') + delta);
    pending.add(id);
    if (pending.size === 1) requestAnimationFrame(flush);
  });
  function flush() {
    const stick = nearBottom();
    for (const id of pending) {
      // (a message that finished meanwhile was drawn whole with the state: don't draw it again from the words so far)
      const m = state?.log.find((x) => x.id === id);
      if (m?.live && texts.has(id)) renderMsg({ ...m, text: texts.get(id) });
    }
    pending = new Set();
    if (stick) toBottom();
  }

  cbot.on('groupchat:state', render);
  $('btn-close').addEventListener('click', () => act('close'));
  $('btn-min').addEventListener('click', () => act('minimize'));
  cbot.invoke('groupchat:init').then((s) => s && render(s));
})();
