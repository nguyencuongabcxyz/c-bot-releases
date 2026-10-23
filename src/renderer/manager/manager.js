/* global cbot */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const COLORS = ['#5ac8fa', '#ff9f43', '#7bed9f', '#ff6b81', '#a29bfe', '#feca57', '#c8d6e5', '#ffffff'];
  const ACCESSORIES = {
    none: 'None',
    hardhat: '👷 Hard hat',
    glasses: '🤓 Glasses',
    bowtie: '🎀 Bow tie',
    tophat: '🎩 Top hat',
    crown: '👑 Crown',
    headphones: '🎧 Headphones',
    flower: '🌸 Flower',
    pirate: '🏴‍☠️ Pirate hat',
  };
  const SIZES = { small: '🐭 Small', normal: '🙂 Normal', large: '🦒 Large', huge: '🐘 Huge' };
  // desk themes (office3d/themes.js); picking one also picks its paint job
  const THEMES = { classic: { label: '🎨 Classic' }, sioux: { label: '⛺ Sioux Connect', paint: '#F47920' } };
  const BODIES = { loopy: '🦫 Loopy', cat: '🐱 Cat', nerd: '🤓 Nerd', girl: '👧 Girl', robot: '🤖 Robot', custom: '📦 My model' };
  const PERMISSION_HINTS = {
    default: 'Can read and search files. Anything that changes things gets politely refused.',
    acceptEdits: 'Can read and edit files in its folder. Shell commands are still refused.',
    bypassPermissions: '⚠️ Can run any command and change anything without asking. Only for folders you trust it with.',
    plan: 'Investigates and proposes plans, but makes no changes.',
  };
  const CLICK_OPENS = { chat: '💬 Chat bubble', terminal: '⌨️ Terminal (full Claude Code)' };
  const CLICK_HINTS = {
    chat: 'The cartoon chat. You can still jump to the terminal with ⌨️ or /terminal.',
    terminal: 'Real Claude Code in a terminal window, with every command and prompt. The robot acts out what happens there.',
  };
  const WANDERS = { yes: '🚶 Now and then', no: '🪑 Stays at its desk' };
  const WANDER_HINTS = {
    yes: 'Left alone for a while it goes for a walk round the screen (asleep, it sleepwalks). Drag it back onto its desk to use it again.',
    no: 'It never leaves its desk.',
  };
  const NAMES = ['Sparky', 'Bolt', 'Widget', 'Pixel', 'Gizmo', 'Rusty', 'Beep', 'Nugget', 'Sprocket', 'Byte', 'Cogsworth', 'Zippy'];

  let state = { characters: [], personalities: {}, permissionModes: {}, settings: {} };
  let selected = null; // character id, or null for "new"
  let draft = null;

  window.Office3D.mount($('#preview'), { stateEl: $('#preview'), moodEl: $('#stage'), width: 300, height: 290 });

  // Show off the desk routine: what the robot does while Claude Code works.
  const DEMO = [
    { screen: 'idle', pose: 'idle', mouth: 'smile', eyes: 'open', label: 'Waiting for a question' },
    { screen: 'think', pose: 'thinking', mouth: 'o', eyes: 'open', label: '🤔 Thinking', cls: 'thinking' },
    { screen: 'read', pose: 'reading', mouth: 'o', eyes: 'open', label: '📖 Reading a file' },
    { screen: 'search', pose: 'reading', mouth: 'o', eyes: 'open', label: '🔍 Searching the code' },
    { screen: 'edit', pose: 'typing', mouth: 'o', eyes: 'open', label: '✏️ Editing a file' },
    { screen: 'run', pose: 'typing', mouth: 'o', eyes: 'open', label: '⚙️ Running a command' },
    { screen: 'web', pose: 'reading', mouth: 'o', eyes: 'open', label: '🌐 Browsing the web' },
    { screen: 'agent', pose: 'reading', mouth: 'o', eyes: 'open', label: '🤖 Sending a helper bot' },
    { screen: 'plan', pose: 'typing', mouth: 'o', eyes: 'open', label: '✅ Making a plan' },
    { screen: 'talk', pose: 'talking', mouth: 'talk', eyes: 'open', label: '💬 Answering you', cls: 'talking' },
    { screen: 'done', pose: 'cheer', mouth: 'smile', eyes: 'happy', label: '🎉 Done!' },
    { screen: 'error', pose: 'idle', mouth: 'flat', eyes: 'dizzy', label: '😵 Something broke' },
    { screen: 'locked', pose: 'idle', mouth: 'flat', eyes: 'flat', label: '🔒 Not allowed to do that' },
  ];
  let demoStep = 0;
  function demo() {
    const d = DEMO[demoStep++ % DEMO.length];
    const p = $('#preview');
    Object.assign(p.dataset, { screen: d.screen, pose: d.pose, mouth: d.mouth, eyes: d.eyes });
    $('#stage').classList.toggle('thinking', d.cls === 'thinking');
    $('#stage').classList.toggle('talking', d.cls === 'talking');
    $('#stage-activity').textContent = d.label;
  }
  demo();
  setInterval(demo, 2600);

  function blankDraft() {
    const used = new Set(state.characters.map((c) => c.name));
    return {
      name: NAMES.find((n) => !used.has(n)) || 'Robo',
      folder: '',
      personality: 'cheerful',
      color: COLORS[state.characters.length % COLORS.length],
      accessory: 'none',
      body: 'loopy',
      theme: 'classic',
      size: 'normal',
      glb: '',
      glbName: '',
      glbTurn: 0,
      permissionMode: 'default',
      model: '',
      clickOpens: 'chat',
      wanders: true,
    };
  }

  // ---------------------------------------------------------------- render

  function renderList() {
    const ul = $('#robot-list');
    ul.innerHTML = '';
    if (!state.characters.length) {
      ul.innerHTML = '<li class="empty-list">No robots yet. Build your first one! →</li>';
      return;
    }
    for (const c of state.characters) {
      const li = document.createElement('li');
      li.className = c.id === selected ? 'selected' : '';
      const emoji = state.personalities[c.personality]?.emoji || '🤖';
      const folder = c.folder.split(/[\\/]/).filter(Boolean).pop() || '';
      li.innerHTML = `
        <span class="dot" style="background:${c.color}">${emoji}</span>
        <span class="meta"><b></b><small></small></span>
        <button class="eye-toggle ${c.visible ? '' : 'off'}" title="${c.visible ? 'Put away' : 'Put on desktop'}">${c.visible ? '👁️' : '🙈'}</button>`;
      li.querySelector('b').textContent = c.name + (c.busy ? ' · working…' : '');
      li.querySelector('small').textContent = folder;
      li.addEventListener('click', () => select(c.id));
      li.querySelector('.eye-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        cbot.invoke('mgr:visible', c.id, !c.visible);
      });
      ul.appendChild(li);
    }
  }

  function renderChips(container, options, value, onPick) {
    container.innerHTML = '';
    for (const [key, label] of Object.entries(options)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(key === value));
      b.textContent = label;
      b.addEventListener('click', () => onPick(key));
      container.appendChild(b);
    }
  }

  function renderEditor() {
    const isNew = !selected;
    const c = state.characters.find((x) => x.id === selected);
    $('#editor-title').textContent = isNew ? 'New robot' : `Tuning up ${c.name}`;
    $('#f-name').value = draft.name;

    const folderEl = $('#f-folder');
    folderEl.textContent = draft.folder || 'No folder yet';
    folderEl.title = draft.folder;
    folderEl.classList.toggle('empty', !draft.folder);

    renderChips(
      $('#f-personality'),
      Object.fromEntries(Object.entries(state.personalities).map(([k, p]) => [k, `${p.emoji} ${p.label}`])),
      draft.personality,
      (k) => update({ personality: k })
    );
    renderChips($('#f-size'), SIZES, draft.size || 'normal', (k) => update({ size: k }));
    renderChips(
      $('#f-theme'),
      Object.fromEntries(Object.entries(THEMES).map(([k, t]) => [k, t.label])),
      draft.theme || 'classic',
      (k) => update({ theme: k, ...(THEMES[k].paint ? { color: THEMES[k].paint } : {}) })
    );
    renderChips($('#f-body'), BODIES, draft.body || 'loopy', (k) => (k === 'custom' && !draft.glb ? pickModel() : update({ body: k })));
    $('#glb-row').hidden = draft.body !== 'custom';
    $('#glb-name').textContent = draft.glbName || draft.glb;
    $('#glb-name').title = draft.glbName || '';
    if (draft.body !== 'custom') $('#glb-status').hidden = true;
    renderChips($('#f-accessory'), ACCESSORIES, draft.accessory || 'none', (k) => update({ accessory: k }));
    renderChips($('#f-click'), CLICK_OPENS, draft.clickOpens || 'chat', (k) => update({ clickOpens: k }));
    $('#click-hint').textContent = CLICK_HINTS[draft.clickOpens || 'chat'];
    const wander = draft.wanders === false ? 'no' : 'yes';
    renderChips($('#f-wander'), WANDERS, wander, (k) => update({ wanders: k === 'yes' }));
    $('#wander-hint').textContent = WANDER_HINTS[wander];

    const sw = $('#f-color');
    sw.innerHTML = '';
    for (const col of COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.background = col;
      b.title = col;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(col.toLowerCase() === draft.color.toLowerCase()));
      b.addEventListener('click', () => update({ color: col }));
      sw.appendChild(b);
    }
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.value = draft.color;
    custom.title = 'Custom paint';
    custom.addEventListener('input', () => update({ color: custom.value }, { keepColorInput: true }));
    sw.appendChild(custom);

    const perm = $('#f-permission');
    perm.innerHTML = '';
    for (const [k, label] of Object.entries(state.permissionModes)) perm.add(new Option(label, k, false, k === draft.permissionMode));
    $('#f-model').value = draft.model || '';
    const hint = $('#perm-hint');
    hint.textContent = PERMISSION_HINTS[draft.permissionMode] || '';
    hint.classList.toggle('warn', draft.permissionMode === 'bypassPermissions');

    $('#save').textContent = isNew ? 'Build it!' : 'Save changes';
    $('#toggle-visible').hidden = isNew;
    $('#forget').hidden = isNew;
    $('#delete').hidden = isNew;
    if (!isNew) $('#toggle-visible').textContent = c.visible ? 'Put away' : 'Put on desktop';

    $('#stats').textContent = isNew
      ? ''
      : `Asked ${c.stats?.questions || 0} question${c.stats?.questions === 1 ? '' : 's'} · poked ${c.stats?.pokes || 0} time${c.stats?.pokes === 1 ? '' : 's'}` +
        (c.stats?.costUsd ? ` · $${c.stats.costUsd.toFixed(2)} of thinking` : '');
    renderPreview();
  }

  function renderPreview() {
    const stage = $('#stage');
    stage.style.setProperty('--paint', draft.color);
    $('#preview').dataset.acc = draft.accessory || 'none';
    $('#preview').dataset.body = draft.body || 'loopy';
    $('#preview').dataset.theme = draft.theme || 'classic';
    $('#preview').dataset.glb = draft.glb || '';
    $('#preview').dataset.glbTurn = String(draft.glbTurn || 0);
    $('#preview').dataset.name = draft.name;
    const p = state.personalities[draft.personality];
    $('#stage-speech').textContent = draft.name ? `${p?.emoji || ''} Hi, I'm ${draft.name}!` : 'Give me a name!';
  }

  function renderSettings() {
    const el = $('#claude-status');
    el.innerHTML = state.claudePath
      ? '<span class="ok">✔ Claude Code found</span><code></code>'
      : '<span class="bad">✖ Claude Code not found</span><small>Install it, or point me to it:</small>';
    if (state.claudePath) el.querySelector('code').textContent = state.claudePath;
    const locate = document.createElement('button');
    locate.type = 'button';
    locate.textContent = 'Locate claude…';
    locate.addEventListener('click', async () => {
      const p = await cbot.invoke('mgr:pick-claude');
      if (p) await cbot.invoke('mgr:settings', { claudePath: p });
    });
    el.appendChild(locate);
    $('#mute').checked = !!state.settings.muted;
  }

  // ---------------------------------------------------------------- actions

  function update(patch, { keepColorInput = false } = {}) {
    Object.assign(draft, patch);
    $('#form-error').textContent = '';
    if (keepColorInput) {
      renderPreview();
      document.querySelectorAll('#f-color button').forEach((b) => b.setAttribute('aria-checked', 'false'));
    } else {
      renderEditor();
    }
    wiggle();
  }

  // ---------------------------------------------------------------- your own model

  async function pickModel() {
    const res = await cbot.invoke('mgr:pick-model');
    if (!res) return;
    if (res.error) {
      showModelStatus(res.error, true);
      return;
    }
    update({ body: 'custom', glb: res.glb, glbName: res.glbName, glbTurn: 0 });
  }
  $('#glb-change').addEventListener('click', pickModel);
  $('#glb-turn').addEventListener('click', () => update({ glbTurn: ((draft.glbTurn || 0) + 1) % 4 }));

  function showModelStatus(text, warn = false) {
    const el = $('#glb-status');
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle('warn', warn);
  }
  // the 3D preview says how loading the model went
  $('#preview').addEventListener('character-status', ({ detail: d }) => {
    if (draft?.body !== 'custom') return;
    if (d.loading) return showModelStatus('Loading your model…');
    if (!d.ok) return showModelStatus(`Couldn't load this model: ${d.error}`, true);
    const face = d.face.length
      ? ` Its face shapes (${d.face.join(', ')}) blink and talk.`
      : ' It has no face shapes, so its face stays still.';
    showModelStatus(
      d.rigged
        ? `✓ Skeleton found: it sits in the chair and acts out every pose.${face}`
        : `No skeleton found, so it stands on the seat and moves as a whole. Auto-rig it (Meshy, Tripo and Mixamo can) to get moving arms.${face}`,
    );
  });

  function wiggle(cls = 'squish') {
    const r = $('#preview');
    r.classList.remove(cls);
    void r.offsetWidth;
    r.classList.add(cls);
  }

  function select(id) {
    selected = id;
    const c = state.characters.find((x) => x.id === id);
    draft = c
      ? { name: c.name, folder: c.folder, personality: c.personality, color: c.color, accessory: c.accessory || 'none', body: c.body || 'loopy', theme: c.theme || 'classic', size: c.size || 'normal', glb: c.glb || '', glbName: c.glbName || '', glbTurn: c.glbTurn || 0, permissionMode: c.permissionMode, model: c.model || '', clickOpens: c.clickOpens || 'chat', wanders: c.wanders !== false }
      : blankDraft();
    $('#form-error').textContent = '';
    renderList();
    renderEditor();
    wiggle('hop');
  }

  async function refresh() {
    state = await cbot.invoke('mgr:state');
    if (selected && !state.characters.some((c) => c.id === selected)) selected = null;
    if (!draft) draft = blankDraft();
    renderList();
    renderSettings();
    // keep in-progress edits; only refresh the bits that come from the robot
    if (selected) {
      const c = state.characters.find((x) => x.id === selected);
      $('#toggle-visible').textContent = c.visible ? 'Put away' : 'Put on desktop';
      $('#editor-title').textContent = `Tuning up ${c.name}`;
    }
  }

  $('#f-name').addEventListener('input', (e) => {
    draft.name = e.target.value;
    renderPreview();
  });
  $('#f-permission').addEventListener('change', (e) => update({ permissionMode: e.target.value }));
  $('#f-model').addEventListener('change', (e) => update({ model: e.target.value }));
  $('#pick-folder').addEventListener('click', async () => {
    const folder = await cbot.invoke('mgr:pick-folder', draft.folder);
    if (folder) update({ folder });
  });
  $('#preview').addEventListener('click', () => wiggle(Math.random() < 0.5 ? 'squish' : 'spin'));
  $('#new-robot').addEventListener('click', () => select(null));
  $('#mute').addEventListener('change', (e) => cbot.invoke('mgr:settings', { muted: e.target.checked }));

  $('#editor').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!draft.name.trim()) return ($('#form-error').textContent = 'Every robot deserves a name.');
    if (!draft.folder) return ($('#form-error').textContent = 'Pick a home folder so the robot knows where to work.');
    if (selected) {
      await cbot.invoke('mgr:update', selected, draft);
      $('#stage-speech').textContent = 'Ooh, I feel brand new!';
    } else {
      const c = await cbot.invoke('mgr:create', draft);
      selected = c.id;
      await refresh();
      renderEditor();
      $('#stage-speech').textContent = `${draft.name} is on your desktop! Click me there to wake me up.`;
    }
    wiggle('hop');
  });

  $('#toggle-visible').addEventListener('click', () => {
    const c = state.characters.find((x) => x.id === selected);
    if (c) cbot.invoke('mgr:visible', c.id, !c.visible);
  });
  $('#forget').addEventListener('click', async () => {
    if (!confirm(`Wipe ${draft.name}'s memory of your conversation?`)) return;
    await cbot.invoke('mgr:reset', selected);
    $('#stage-speech').textContent = 'Wait… who am I? Where am I?';
    wiggle('spin');
  });
  $('#delete').addEventListener('click', async () => {
    if (!confirm(`Scrap ${draft.name} for parts? This can't be undone (your folder is not touched).`)) return;
    await cbot.invoke('mgr:delete', selected);
    selected = null;
    draft = blankDraft();
    await refresh();
    renderEditor();
  });

  cbot.on('mgr:changed', refresh);
  cbot.on('mgr:focus', (id) => select(id === 'new' ? null : id));

  (async () => {
    await refresh();
    const focus = new URLSearchParams(location.search).get('focus');
    if (focus && focus !== 'new' && state.characters.some((c) => c.id === focus)) select(focus);
    else if (!focus && state.characters.length) select(state.characters[0].id);
    else select(null);
  })();
})();
