/* global marked, DOMPurify, Sfx, cbot */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const body = document.body;
  const robot = $('#robot');
  // The 3D office renders whatever state this script puts on #robot and <body>.
  const ROBOT_W = 300;
  const ROBOT_H = 290;
  const office = window.Office3D.mount($('#bot-host'), { stateEl: robot, moodEl: body, width: ROBOT_W, height: ROBOT_H });
  const logs = $('#logs');
  const tabStrip = $('#tabs');
  const input = $('#input');

  // Each tab is its own Claude Code conversation (they can run at the same
  // time). Per tab: its log, the reply being streamed, an open question, the
  // status line and a badge state.
  const tabs = new Map(); // id -> tab
  let activeId = null;
  let lastMainActive = null;
  const active = () => tabs.get(activeId);
  const statusRow = $('#status');
  const statusText = $('#status-text');
  const pop = $('#pop');

  const AUTO_SLEEP_MS = 3 * 60 * 1000;
  const THINKING_VERBS = [
    'Thinking', 'Pondering', 'Crunching bits', 'Consulting my circuits', 'Rummaging around',
    'Warming up the neurons', 'Beep-booping', 'Reticulating splines', 'Oiling the gears',
  ];
  // tool name -> [chip emoji, verb, what the robot does at its desk]
  const TOOLS = {
    Read: ['📖', 'Reading', 'read'],
    Glob: ['🗂️', 'Looking for', 'search'],
    Grep: ['🔍', 'Searching for', 'search'],
    Bash: ['⚙️', 'Running', 'run'],
    PowerShell: ['⚙️', 'Running', 'run'],
    Edit: ['✏️', 'Editing', 'edit'],
    MultiEdit: ['✏️', 'Editing', 'edit'],
    Write: ['📝', 'Writing', 'edit'],
    NotebookEdit: ['📓', 'Editing', 'edit'],
    WebSearch: ['🌐', 'Searching the web for', 'web'],
    WebFetch: ['🌐', 'Visiting', 'web'],
    Task: ['🤖', 'Sending a helper bot:', 'agent'],
    Agent: ['🤖', 'Sending a helper bot:', 'agent'],
    TodoWrite: ['✅', 'Planning', 'plan'],
    AskUserQuestion: ['✋', 'Asking you', 'ask'],
    ToolSearch: ['🧰', 'Looking up tools:', 'think'],
    TaskCreate: ['📋', 'Adding a task:', 'plan'],
    TaskUpdate: ['✅', 'Updating task', 'plan'],
    TaskList: ['📋', 'Checking the plan', 'plan'],
    TaskGet: ['📋', 'Checking a task', 'plan'],
    Skill: ['🎓', 'Using the skill', 'read'],
    // asking another robot (main robotLink.js)
    mcp__cbot__ask_robot: ['🤖', 'Asking', 'agent'],
    mcp__cbot__list_robots: ['🤖', 'Looking for the other robots', 'agent'],
    mcp__cbot__hand_off_task: ['📋', 'Handing off', 'agent'],
  };
  // a tool chip's line icon, by the kind of step (../ui/icons.js)
  const TOOL_ICONS = { read: 'file', search: 'search', run: 'terminal', edit: 'edit', web: 'globe', agent: 'bot', plan: 'plan', ask: 'help', think: 'wrench' };
  // monitor scene -> how the robot sits while it's on screen
  const POSES = {
    off: 'sleep', boot: 'idle', idle: 'idle', think: 'thinking', talk: 'talking',
    read: 'reading', search: 'reading', web: 'reading', agent: 'reading',
    edit: 'typing', run: 'typing', plan: 'typing',
    done: 'cheer', error: 'idle', locked: 'idle', ask: 'raise', compact: 'typing',
    helpers: 'thinking', // supervising its helper agents: chin in hand, watching them circle
    dance: 'cheer',
  };
  // where the monitor is, relative to the robot's face, for eye tracking
  const MONITOR = { dx: 200, dy: 50 };

  const state = {
    character: null,
    personalities: {},
    user: 'friend',
    awake: false,
    collapsed: false, // awake, but you tucked the chat away to watch it work
    news: '', // what happened while the chat was tucked away (shown on the status bubble)
    // the robot is "busy" while any of its tabs is working
    get busy() {
      return [...tabs.values()].some((t) => t.busy);
    },
    placement: 'none',
    robotX: 0,
    robotY: 0,
    pokes: [],
    face: null, // temporary expression override
    activity: 'off', // what's on the monitor
    pose: null, // temporary pose override
    lookOverride: null,
    lastCursor: { dx: 0, dy: 0 },
    lastActivity: Date.now(),
  };

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const persona = () => state.personalities[state.character?.personality] || Object.values(state.personalities)[0];
  const folderName = () => (state.character?.folder || '').split(/[\\/]/).filter(Boolean).pop() || 'this folder';
  const fill = (line) =>
    line.replaceAll('{name}', state.character.name).replaceAll('{folder}', folderName()).replaceAll('{user}', state.user);
  const fileIcon = (f) => (f.isDir ? 'folder' : f.isImage ? 'image' : 'file'); // (a ui/icons.js name)
  // "anthropic-skills:pptx" -> "pptx (anthropic-skills)", as the bridge describes it live
  const skillLabel = (s) => {
    const i = s.lastIndexOf(':');
    return i > 0 ? `${s.slice(i + 1)} (${s.slice(0, i)})` : s;
  };

  // ------------------------------------------------------------ markdown

  marked.setOptions({ gfm: true, breaks: true });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  // Local files in answers. Pictures Claude made or points at are shown (through
  // main's cbot-file: protocol), and file links or `C:\…\file.ext` paths open the file.
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
  // an absolute local path from "C:\…", "/…", "\\server\…", "file:///…", or a path inside the robot's folder
  function localPath(href) {
    let p = String(href || '').trim();
    if (!p || p.startsWith('#')) return null;
    if (/^file:\/\//i.test(p)) {
      try {
        p = decodeURIComponent(new URL(p).pathname).replace(/^\/([a-zA-Z]:)/, '$1');
      } catch {
        return null;
      }
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !/^[a-zA-Z]:[\\/]/.test(p)) {
      return null; // a web link or another scheme
    } else if (!/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(p)) {
      const folder = state.character?.folder;
      if (!folder || /^[a-z]+\.[a-z]{2,}\//i.test(p)) return null; // "example.com/…" is not a file
      p = `${folder.replace(/[\\/]+$/, '')}\\${p.replace(/^\.[\\/]/, '')}`;
    }
    return p;
  }
  const imageUrl = (p, v = '') => `cbot-file://img/?path=${encodeURIComponent(p)}${v ? `&v=${v}` : ''}`;
  const openUrl = (p) => `cbot-file://open/?path=${encodeURIComponent(p)}`;
  marked.use({
    walkTokens(t) {
      if (t.type !== 'image' && t.type !== 'link') return;
      const p = localPath(t.href);
      if (!p) return;
      t.href = t.type === 'image' && IMAGE_EXT.test(p) ? imageUrl(p) : openUrl(p);
    },
  });
  const PURIFY = { ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|cbot-file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i, RETURN_DOM_FRAGMENT: true };
  const ABS_FILE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|opt|mnt)\/)[^\n<>"|?*]*\.[A-Za-z0-9]{1,8}$/;
  function md(text) {
    const frag = DOMPurify.sanitize(marked.parse(text || ''), PURIFY);
    // `C:\…\rocket.svg` in code: clickable, and pictures show right under it
    for (const code of frag.querySelectorAll('code')) {
      if (code.closest('pre')) continue;
      const p = code.textContent.trim().replace(/^["']|["']$/g, '');
      if (!ABS_FILE.test(p)) continue;
      code.classList.add('file-path');
      code.dataset.open = p;
      code.title = 'Open this file';
      if (!IMAGE_EXT.test(p)) continue;
      const img = document.createElement('img');
      img.className = 'local-img';
      img.src = imageUrl(p);
      img.alt = p.split(/[\\/]/).pop();
      img.dataset.open = p;
      (code.closest('p, li') || code).after(img);
    }
    for (const img of frag.querySelectorAll('img[src^="cbot-file://img/"]')) {
      img.classList.add('local-img');
      img.dataset.open = new URL(img.src).searchParams.get('path');
    }
    const box = document.createElement('div');
    box.appendChild(frag);
    return box.innerHTML;
  }

  // a picture its file card already shows isn't shown again under its path in the text
  const samePath = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
  function dedupePics(el) {
    const shown = new Set([...el.querySelectorAll('.d-preview img')].map((i) => samePath(i.dataset.open)));
    if (!shown.size) return;
    for (const img of el.querySelectorAll('img.local-img')) {
      if (!img.closest('.d-preview') && shown.has(samePath(img.dataset.open))) img.remove();
    }
  }

  // clicking a local file (a link, a path, a picture) opens it; programs are only shown in their folder
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="cbot-file://open/"], [data-open]');
    if (!link) return;
    e.preventDefault();
    const p = link.dataset.open || new URL(link.href).searchParams.get('path');
    cbot.invoke('robot:open-file', p).then((res) => res && !res.ok && showPop(res.error, 2400));
  });
  // a picture that isn't there (yet, or anymore) just disappears
  document.addEventListener('error', (e) => e.target.matches?.('img.local-img') && e.target.remove(), true);

  // ------------------------------------------------------------ face

  function baseFace() {
    if (!state.awake && !state.busy && !state.mirroring && !helpersOut()) return { eyes: 'closed', mouth: 'flat' };
    if (body.classList.contains('talking')) return { eyes: 'open', mouth: 'talk' };
    if (state.busy || helpersOut()) return { eyes: 'open', mouth: 'o' };
    return { eyes: 'open', mouth: 'smile' };
  }

  function renderFace() {
    const f = state.face && state.face.until > Date.now() ? state.face : baseFace();
    robot.dataset.eyes = f.eyes;
    robot.dataset.mouth = f.mouth;
  }

  function express(eyes, mouth, ms = 1500) {
    state.face = { eyes, mouth, until: Date.now() + ms };
    renderFace();
    setTimeout(renderFace, ms + 20);
  }

  function flash(cls, ms = 600) {
    robot.classList.remove(cls);
    void robot.offsetWidth; // restart the animation
    robot.classList.add(cls);
    setTimeout(() => robot.classList.remove(cls), ms);
  }

  // ------------------------------------------------------------ desk activity

  // helper agents still at work, in one tab or all of them
  function helpersOut(tab) {
    let n = 0;
    for (const t of tab ? [tab] : tabs.values()) for (const a of t.agents?.values() || []) if (a.status === 'running') n++;
    return n;
  }

  function restingActivity() {
    if (helpersOut() && !body.classList.contains('talking')) return 'helpers';
    if (state.busy) return 'think';
    if (state.mirroring) return 'idle';
    return state.awake ? 'idle' : 'off';
  }

  // Switch what the monitor shows (and with it how the robot sits). With `ms`
  // the scene is temporary and falls back to the resting one afterwards.
  function setActivity(activity, ms) {
    clearTimeout(setActivity.t);
    if (activity !== 'idle' && activity !== 'off' && activity !== 'edit') stopAntic();
    state.activity = activity;
    robot.dataset.screen = activity;
    renderPose();
    if (ms) setActivity.t = setTimeout(() => setActivity(restingActivity()), ms);
  }

  function renderPose() {
    const override = state.pose && state.pose.until > Date.now() ? state.pose.name : null;
    let pose = override || POSES[state.activity] || 'idle';
    if (!override && !state.awake && !state.busy && !helpersOut()) pose = 'sleep'; // a strike (e.g. reaching for food) wakes it briefly
    // nodding off: in the chair with an eye mask, or on the floor under a blanket (a coin toss each time)
    if (pose === 'sleep' && robot.dataset.pose !== 'sleep') robot.dataset.sleepStyle = Math.random() < 0.5 ? 'chair' : 'floor';
    robot.dataset.pose = pose;
    nightcap();
    look();
  }

  function strikePose(name, ms) {
    // keep the hand up while a question waits (only reaching for a dropped file may interrupt)
    if (pendingQuestion() && name !== 'eager') return;
    state.pose = { name, until: Date.now() + ms };
    renderPose();
    setTimeout(renderPose, ms + 20);
  }

  function look() {
    let { dx, dy } = state.lastCursor;
    const pose = robot.dataset.pose;
    let follow = pose === 'idle' || pose === 'talking' || pose === 'wave' || pose === 'cheer' || pose === 'eager';
    if (state.lookOverride && state.lookOverride.until > Date.now()) {
      ({ dx, dy } = state.lookOverride);
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
    root.setProperty('--tilt', `${(follow && state.awake ? lx * 0.8 : 0).toFixed(2)}deg`);
  }

  function lookAt(dx, dy, ms) {
    state.lookOverride = { dx, dy, until: Date.now() + ms };
    look();
    setTimeout(look, ms + 20);
  }

  function showPop(text, ms = 2400) {
    if (!state.awake) return;
    // prefer the open side of the robot's head (the monitor sits on its right)
    pop.classList.toggle('right', state.robotX + 60 < 130);
    pop.textContent = text;
    pop.classList.add('show');
    clearTimeout(showPop.t);
    showPop.t = setTimeout(() => pop.classList.remove('show'), ms);
  }

  // ------------------------------------------------------------ life cycle

  function applyCharacter(c) {
    state.character = c;
    document.documentElement.style.setProperty('--paint', c.color || '#5ac8fa');
    $('#name').textContent = c.name;
    $('#nametag').textContent = c.name;
    const chip = $('#folder');
    chip.innerHTML = `${Icon('folder', 'sm')}<span></span>`;
    chip.lastChild.textContent = folderName();
    chip.title = c.folder;
    robot.dataset.acc = c.accessory || 'none';
    // its size: the robot box scales as one, the 3D view renders sharp at that size
    const k = { small: 0.7, large: 1.35, huge: 1.7 }[c.size] || 1;
    document.documentElement.style.setProperty('--s', String(k));
    state.scale = k;
    office.setScale(k);
    robot.dataset.body = 'kit';
    robot.dataset.kit = JSON.stringify(c.kit || {}); // (its parts: office3d/kit3d.js)
    robot.dataset.theme = c.theme || 'classic';
    robot.dataset.name = c.name;
    document.title = c.name;
  }

  function renderHistory(tab = active()) {
    tab.log.innerHTML = '';
    for (const h of (tab.data.history || []).slice(-30)) {
      if (h.role === 'qa') addQaSummary(h.items, tab);
      else if (h.role === 'note') addNote(h.text, '', tab);
      else if (h.role === 'user') addUser(h.text, h.files, tab);
      else addBot(h.interrupted ? `${h.text || ''}\n\n_…(stopped)_` : h.text, { error: h.isError, denials: h.denials, tools: h.tools, asides: h.asides, edits: h.edits, apps: h.apps, images: h.images, tab });
    }
  }

  // tucked: just awake enough to show something (a word you caught), the chat stays tucked away
  function wake({ sayHi = true, tucked = false } = {}) {
    if (state.away) return awayClick(); // it's out: drag it back first
    if (state.awake) return;
    state.awake = true;
    stopAntic();
    state.lastActivity = Date.now();
    body.classList.remove('asleep');
    body.classList.add('awake');
    (tucked ? Sfx : Sfx.key).wake(); // (woken for something it shows by itself: an extra)
    flash('shake', 500);
    express('open', 'o', 700);
    // jolt awake and boot the computer (unless it's already busy working)
    if (!state.busy) setActivity('boot', 1000);
    else renderPose();
    if (tucked) {
      state.collapsed = true;
      body.classList.add('collapsed');
      renderWorking();
      cbot.invoke('robot:expand', false, { tucked: true });
    } else cbot.invoke('robot:expand', true);
    const hadBadge = body.classList.contains('has-badge');
    body.classList.remove('has-badge');
    readVisitNote();
    setTimeout(() => {
      flash('hop', 600);
      if (!hadBadge && !state.busy && sayHi) greet();
      scrollDown();
      if (!tucked) input.focus();
    }, 300);
  }

  // The chat stays open while the robot works, unless you tuck it away (🔽) to
  // watch the robot instead: a status bubble says what it's up to. It stays
  // tucked away until you click the bubble or the robot, even when the task is
  // done or Claude needs you; the bubble says so instead.
  function collapse() {
    if (!state.awake || state.collapsed || state.mirroring) return;
    state.collapsed = true;
    hidePalette();
    panelOut(() => {
      if (!state.collapsed || !state.awake) return; // (opened again meanwhile)
      body.classList.add('collapsed');
      renderWorking();
      cbot.invoke('robot:expand', false, { tucked: true });
    });
  }

  // The chat panel shrinks away before the window does (then main hides the window's resize)
  const PANEL_OUT = 140;
  function panelOut(then) {
    if (!body.classList.contains('expanded')) return then();
    body.classList.add('panel-out');
    setTimeout(() => {
      body.classList.remove('panel-out');
      then();
    }, PANEL_OUT);
  }

  function openChat({ focus = true } = {}) {
    if (state.away) return awayClick(); // it's out for a walk: drag it back first
    if (!state.collapsed) return;
    state.collapsed = false;
    state.news = '';
    body.classList.remove('collapsed');
    renderWorking();
    cbot.invoke('robot:expand', true, { focus });
    if (focus) input.focus();
  }

  const workingEl = $('#working');
  function renderWorking() {
    workingEl.hidden = !state.collapsed;
    if (!state.collapsed) return;
    const asking = [...tabs.values()].some((x) => x.question);
    const t = active()?.busy ? active() : [...tabs.values()].find((x) => x.busy);
    const out = helpersOut();
    $('#working-text').textContent = plain(asking
      ? '✋ I have a question for you. Click to answer'
      : t
        ? t.statusText || 'Working on it…'
        : out
          ? `🤖 ${out === 1 ? 'A helper is' : `${out} helpers are`} still working…`
          : state.news || 'Waiting for a question');
    workingEl.classList.toggle('news', asking || (!t && !!state.news));
    workingEl.classList.toggle('idle', !asking && !t && !out && !state.news); // (its dots keep still)
  }
  workingEl.addEventListener('click', () => openChat());

  function sleep({ auto = false } = {}) {
    if (!state.awake) return;
    if (state.away) cbot.send('robot:walker', 'asleep'); // dozes off out there: it sleepwalks
    state.awake = false;
    stopAntic();
    state.collapsed = false;
    state.news = '';
    body.classList.remove('collapsed');
    renderWorking();
    (auto ? Sfx : Sfx.key).sleep(); // (dozing off by itself: an extra)
    express('closed', 'o', 900);
    body.classList.remove('awake');
    body.classList.add('asleep');
    panelOut(() => {
      if (state.awake) return; // (woken again meanwhile)
      body.classList.remove('expanded');
      cbot.invoke('robot:expand', false);
    });
    // a busy robot keeps working at its desk; otherwise the monitor goes dark
    if (!state.busy) setActivity('off');
    else renderPose();
    renderFace();
    socialReport({ kind: 'slept' });
  }

  function greet() {
    active().log.querySelectorAll('.greet').forEach((el) => el.remove());
    const el = addBot(fill(pick(persona().greetings)));
    el.classList.add('greet');
    setTimeout(() => strikePose('wave', 1600), 700);
  }

  // ------------------------------------------------------------ chat log

  function scrollDown(tab = active()) {
    if (tab) tab.log.scrollTop = tab.log.scrollHeight;
  }

  const thumbImg = (src) => {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    img.src = src;
    return img;
  };

  // text with its @mentions picked out
  function withMentions(el, text) {
    const re = /(^|\s)(@(?:"[^"\n]+"|[^\s"]+))/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index + m[1].length;
      el.append(text.slice(last, start));
      const span = document.createElement('span');
      span.className = 'mention';
      span.textContent = m[2];
      el.append(span);
      last = start + m[2].length;
    }
    el.append(text.slice(last));
  }

  function addUser(text, files = [], tab = active()) {
    const el = document.createElement('div');
    el.className = 'msg user';
    withMentions(el, text);
    if (files?.length) {
      const row = document.createElement('div');
      row.className = 'files';
      for (const f of files) {
        const chip = document.createElement('span');
        chip.className = 'file-chip';
        chip.title = f.path || f.name;
        if (f.thumb) chip.appendChild(thumbImg(f.thumb));
        if (!f.thumb) chip.insertAdjacentHTML('beforeend', Icon(fileIcon(f), 'sm'));
        chip.appendChild(document.createElement('span')).textContent = f.name;
        row.appendChild(chip);
      }
      el.appendChild(row);
    }
    tab.log.appendChild(el);
    scrollDown(tab);
    return el;
  }

  function addBot(text, { error = false, denials = [], tools = [], asides = [], edits = [], apps = [], images = [], tab = active() } = {}) {
    const el = document.createElement('div');
    el.className = `msg bot${error ? ' error' : ''}`;
    // steps saved with where they came in the words (at) go back there, each followed by what
    // it made; older answers (and anything without a step to follow) keep it all on top
    const placed = (tools || []).filter((t) => t && typeof t === 'object' && Number.isFinite(t.at));
    const made = new Map(); // step id -> what it made [element]
    const loose = []; // made by no step we can place
    const ids = new Set(placed.map((t) => t.id));
    const madeBy = (id, node) => (id && ids.has(id) ? made.set(id, [...(made.get(id) || []), node]) : loose.push(node));
    for (const d of edits || []) madeBy(d.id, diffCard(d));
    for (const a of apps || []) madeBy(a.id, appCard(a));
    for (const pic of images || []) madeBy(pic.id, toolPics([pic]));
    const words = String(text || '');
    const block = (cls, nodes) => {
      const box = document.createElement('div');
      box.className = cls;
      box.append(...nodes);
      el.appendChild(box);
    };
    const say = (s) => {
      if (!s.trim()) return;
      const box = document.createElement('div');
      box.className = 'content';
      box.innerHTML = md(s);
      el.appendChild(box);
    };
    // on top: the steps we can't place, the asides, what no placed step made
    const topSteps = toolChips((tools || []).filter((t) => !placed.includes(t)), tab);
    for (const a of asides || []) topSteps.appendChild(asideChip(a));
    if (topSteps.children.length) el.appendChild(topSteps);
    if (loose.length) block('edits', loose);
    let pos = 0;
    for (let i = 0; i < placed.length; ) {
      const at = Math.min(Math.max(placed[i].at, pos), words.length);
      const group = [];
      while (i < placed.length && Math.min(Math.max(placed[i].at, pos), words.length) === at) group.push(placed[i++]);
      say(words.slice(pos, at));
      pos = at;
      el.appendChild(toolChips(group, tab));
      const things = group.flatMap((t) => made.get(t.id) || []);
      if (things.length) block('edits', things);
    }
    say(words.slice(pos));
    if (!el.children.length) el.innerHTML = md(words || '…');
    if (denials?.length) el.appendChild(deniedNote(denials));
    dedupePics(el);
    tab.log.appendChild(el);
    scrollDown(tab);
    return el;
  }

  // the steps of a finished turn: one chip each (click for the details); older history kept just
  // their names, as compact chips: "📖 Read ×3"
  function toolChips(tools, tab) {
    const row = document.createElement('div');
    row.className = 'tools';
    const counts = new Map();
    for (const t of tools) {
      if (t && typeof t === 'object') row.appendChild(callChip({ ...t, running: false }, tab));
      else counts.set(t, (counts.get(t) || 0) + 1);
    }
    for (const [entry, n] of counts) {
      // "Skill(anthropic-skills:pptx)" -> 🎓 Skill: pptx (anthropic-skills)
      const [, name, detail] = entry.match(/^(\w+)\((.+)\)$/) || [null, entry, ''];
      const chip = document.createElement('span');
      chip.className = 'tool';
      const kind = TOOLS[name]?.[2] || 'run';
      chip.dataset.kind = kind;
      chip.innerHTML = `${Icon(TOOL_ICONS[kind] || 'wrench')}<span></span>`;
      chip.lastChild.textContent = `${name}${detail ? `: ${skillLabel(detail)}` : ''}${n > 1 ? ` ×${n}` : ''}`;
      row.appendChild(chip);
    }
    return row;
  }

  // a tool step's look: "mcp__claude_ai_Excalidraw__create_view" -> 🧩 Excalidraw: create_view
  function toolLook(name, detail) {
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
    const [emoji, verb, activity] = TOOLS[name] || (mcp ? ['🧩', `${serverLabel(mcp[1])}: ${mcp[2]}`, 'run'] : ['🛠️', `Using ${name}`, 'run']);
    const text = `${verb}${detail ? ' ' + detail : ''}`;
    return { emoji, verb, activity, mcp: !!mcp, text, label: `${emoji} ${text}` };
  }
  // a step's chip: clicking it shows what it was called with and what it gave back (a helper
  // agent's opens the helper instead)
  function callChip(call, tab) {
    const look = toolLook(call.name, call.detail);
    const chip = document.createElement('span');
    chip.className = 'tool clickable';
    chip.dataset.kind = look.activity;
    if (call.id) chip.dataset.call = call.id;
    if (call.isError) chip.classList.add('failed');
    chip.innerHTML = `${Icon(TOOL_ICONS[look.activity] || (look.mcp ? 'plug' : 'wrench'))}<span></span>`;
    chip.lastChild.textContent = look.text;
    chip.title = `${look.label} (click for the details)`;
    chip.tabIndex = 0;
    chip.setAttribute('role', 'button');
    const open = () => ((call.name === 'Agent' || call.name === 'Task') && tab?.agents?.has(call.id) ? openHelper(tab, call.id) : openToolView(tab, call));
    chip.addEventListener('click', open);
    chip.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open()));
    return chip;
  }

  // A file Claude Code changed, shown the way its terminal does: the file, +/- counts,
  // and the changed lines with line numbers. Long diffs start folded.
  function diffCard(d) {
    const card = document.createElement('details');
    card.className = 'diff';
    card.open = d.hunks.reduce((n, h) => n + h.lines.length, 0) <= 40;
    const folder = (state.character?.folder || '').replace(/[\\/]+$/, '');
    const inside = folder && /^[\\/]$/.test(d.file[folder.length] || '') && d.file.toLowerCase().startsWith(folder.toLowerCase());
    const rel = inside ? d.file.slice(folder.length + 1) : d.file;
    const cut = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
    const sum = document.createElement('summary');
    sum.title = d.file;
    sum.innerHTML = `<span class="d-verb"></span><b class="d-name"></b><span class="d-dir"></span><span class="d-add"></span><span class="d-del"></span><button class="d-open" type="button" title="Open the file">${Icon('open', 'sm')}</button>`;
    sum.querySelector('.d-open').dataset.open = d.file;
    sum.querySelector('.d-verb').textContent = d.created ? 'Created' : 'Updated';
    sum.querySelector('.d-name').textContent = rel.slice(cut + 1);
    sum.querySelector('.d-dir').textContent = cut > 0 ? rel.slice(0, cut) : '';
    sum.querySelector('.d-add').textContent = d.added ? `+${d.added}` : '';
    sum.querySelector('.d-del').textContent = d.removed ? `−${d.removed}` : '';
    card.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'd-body';
    d.hunks.forEach((h, i) => {
      if (i) {
        const gap = document.createElement('div');
        gap.className = 'd-gap';
        gap.textContent = '⋯';
        body.appendChild(gap);
      }
      let oldNo = h.oldStart;
      let newNo = h.newStart;
      for (const line of h.lines) {
        const sign = line[0];
        const kind = sign === '+' ? 'add' : sign === '-' ? 'del' : sign === '\\' ? 'meta' : 'ctx';
        let no = '';
        if (kind === 'add') no = newNo++;
        else if (kind === 'del') no = oldNo++;
        else if (kind === 'ctx') {
          no = newNo++;
          oldNo++;
        }
        const row = document.createElement('div');
        row.className = `d-line ${kind}`;
        row.innerHTML = '<span class="d-no"></span><span class="d-sign"></span><span class="d-text"></span>';
        row.children[0].textContent = no;
        row.children[1].textContent = kind === 'add' || kind === 'del' ? sign : ' ';
        row.children[2].textContent = kind === 'meta' ? line : line.slice(1);
        body.appendChild(row);
      }
    });
    if (d.truncated) {
      const more = document.createElement('div');
      more.className = 'd-gap';
      more.textContent = '… more changes not shown';
      body.appendChild(more);
    }
    if (!IMAGE_EXT.test(d.file)) {
      card.appendChild(body);
      return card;
    }
    // a picture (an SVG it drew, a PNG it saved): show it, with its source folded away
    card.open = true;
    const pic = document.createElement('div');
    pic.className = 'd-preview';
    const img = document.createElement('img');
    img.className = 'local-img';
    img.src = imageUrl(d.file, d.at || Date.now());
    img.alt = rel;
    img.dataset.open = d.file;
    img.title = 'Open the picture';
    pic.appendChild(img);
    card.appendChild(pic);
    if (/\.svg$/i.test(d.file)) {
      const src = document.createElement('details');
      src.className = 'd-source';
      src.innerHTML = '<summary>source</summary>';
      src.appendChild(body);
      card.appendChild(src);
    }
    return card;
  }

  // pictures a tool returned, as a strip of thumbnails (click one to see it bigger)
  function toolPics(images) {
    const row = document.createElement('div');
    row.className = 'tool-pics';
    for (const pic of images) {
      if (!/^image\/[\w.+-]+$/.test(pic.mimeType || '')) continue;
      const img = document.createElement('img');
      img.src = `data:${pic.mimeType};base64,${pic.data}`;
      img.alt = 'Picture from a tool';
      img.addEventListener('click', () => img.classList.toggle('big'));
      row.appendChild(img);
    }
    return row;
  }

  // ------------------------------------------------------------ MCP tool views

  // Some MCP tools (Excalidraw's create_view…) come with their own page that shows
  // what they did: an MCP App, hosted by McpAppHost (appHost.js). Its fullscreen
  // button opens the same view in a big window of its own.
  const APP_MAX_H = 560;
  const appsById = new Map(); // tool call id -> host (for results that arrive later)
  const serverLabel = (s) => s.replace(/^claude_ai_/, '').replace(/_/g, ' ');

  // a: { id, input, result } plus either the view ({ server, tool, uri }) or the tool's name to look it up
  function appCard(a) {
    const card = document.createElement('div');
    card.className = 'app-card';
    card.innerHTML = `<div class="app-head"><span class="app-title"></span><span class="app-state">loading…</span><button class="app-big" type="button" title="Open in a big window" hidden>${Icon('expand', 'sm')}</button></div>`;
    const title = card.querySelector('.app-title');
    const status = card.querySelector('.app-state');
    const bigBtn = card.querySelector('.app-big');
    Icon.text(title, '🧩 Tool view');
    (async () => {
      const view = a.uri ? a : await cbot.invoke('robot:app-view', a.name);
      if (!view) return card.remove(); // no view after all (or its server is out of reach)
      Icon.text(title, `🧩 ${serverLabel(view.server)} · ${view.tool}`);
      const page = await cbot.invoke('robot:app-page', view.server, view.uri);
      if (!page.ok) {
        status.textContent = `couldn't load: ${page.error}`;
        return;
      }
      const frame = McpAppHost.frameFor(page, title.textContent);
      frame.style.height = '360px';
      card.classList.toggle('bordered', page.prefersBorder);
      card.appendChild(frame);
      frame.src = page.url;
      const call = { id: a.id, server: view.server, tool: view.tool, uri: view.uri, input: a.input, result: a.result };
      const openBig = () => cbot.invoke('robot:app-window', { ...call, title: title.textContent.replace(/^🧩 /, '') });
      const host = McpAppHost.create({
        frame,
        ...call,
        displayMode: 'inline',
        maxHeight: APP_MAX_H,
        onReady: () => {
          status.textContent = '';
          bigBtn.hidden = false;
        },
        onSize: (h) => (frame.style.height = `${clamp(h, 80, APP_MAX_H)}px`),
        // its own fullscreen button: the view opens big in its own window, this one stays inline
        onDisplayMode: (mode) => {
          if (mode === 'fullscreen') openBig();
          return 'inline';
        },
        // the view wants to say something in the chat: put it in the box, you send it
        onMessage: (text) => {
          openChat();
          input.value = text;
          autosize();
          input.focus();
        },
      });
      bigBtn.addEventListener('click', openBig);
      host.call = call;
      appsById.set(a.id, host);
      if (appsById.size > 60) appsById.delete(appsById.keys().next().value);
      setTimeout(() => !host.ready && (status.textContent = "didn't start"), 20000);
    })();
    return card;
  }

  function appResult(id, result) {
    const host = appsById.get(id);
    if (!host) return;
    host.call.result = result; // for the big window
    host.setResult(result);
  }

  function asideChip(text) {
    const chip = document.createElement('span');
    chip.className = 'tool aside';
    Icon.text(chip, `💭 ${text}`);
    return chip;
  }

  // ------------------------------------------------------------ running commentary

  const asideEl = $('#aside');
  function showAside(text) {
    asideEl.textContent = text;
    asideEl.hidden = false;
    asideEl.classList.remove('show', 'right', 'compact');
    void asideEl.offsetWidth;
    const robotH = ROBOT_H * (state.scale || 1);
    if (state.collapsed) {
      // chat tucked away: in the strip above (or below) the robot, clear of the desk
      const h = asideEl.offsetHeight;
      asideEl.classList.add('right');
      asideEl.style.left = '8px';
      // next to the status bubble, which sits right against the robot
      asideEl.style.top = `${state.placement === 'tuck-below' ? state.robotY + robotH + 50 : Math.max(2, state.robotY - h - 56)}px`;
    } else if (!body.classList.contains('expanded')) {
      // a small window with no room around the robot: the remark is in the chat anyway
      asideEl.hidden = true;
      return;
    } else {
      // above the robot's head, clear of the chat beside it (or tucked into the
      // robot's corner when the robot is right at the top of the screen)
      const w = asideEl.offsetWidth;
      const h = asideEl.offsetHeight;
      asideEl.classList.add('right');
      asideEl.style.left = `${Math.max(8, Math.min(state.robotX + 20, innerWidth - w - 8))}px`;
      asideEl.style.top = `${state.robotY - h - 30 >= 8 ? state.robotY - h - 30 : state.robotY + robotH + 12}px`; // below it at the top of the screen
    }
    asideEl.classList.add('show');
    clearTimeout(showAside.t);
    showAside.t = setTimeout(() => {
      asideEl.classList.remove('show');
      setTimeout(() => (asideEl.hidden = !asideEl.classList.contains('show')), 300);
    }, 3800 + text.length * 45);
  }

  function addNote(text, cls = '', tab = active()) {
    const el = document.createElement('div');
    el.className = `msg note ${cls}`;
    Icon.text(el, text);
    tab.log.appendChild(el);
    scrollDown(tab);
  }

  function deniedNote(denials) {
    const el = document.createElement('div');
    el.className = 'denied';
    Icon.text(el, `🔒 I wasn't allowed to use ${[...new Set(denials)].join(', ')}. Right-click me → Permissions to give me more power.`);
    return el;
  }

  // (the status line and strip are plain mono text: no leading emoji)
  function plain(text) {
    return String(text || '').replace(/^(?:\p{Extended_Pictographic}|\uFE0F|\u200D)+\s*/u, '');
  }
  function setStatus(text) {
    statusRow.hidden = !text;
    statusText.textContent = plain(text);
  }

  // each tab keeps its own status line; only the visible one is shown
  function setTabStatus(tab, text) {
    tab.statusText = text || '';
    if (tab === active()) setStatus(text);
    renderWorking();
  }

  // does the robot act out this tab's events? The tab you're looking at always;
  // a background tab only while the visible one is idle.
  const animates = (tab) => tab === active() || !active()?.busy;

  // ------------------------------------------------------------ asking

  function setBusy(tab, busy) {
    tab.busy = busy;
    clearInterval(tab.verbs);
    if (busy) {
      tab.activity = 'think';
      if (animates(tab)) setActivity(helpersOut() ? 'helpers' : 'think'); // keep supervising helpers still out
      setTabStatus(tab, `${pick(THINKING_VERBS)}…`);
      tab.verbs = setInterval(() => {
        if (!tab.current?.toolStatus) setTabStatus(tab, `${pick(THINKING_VERBS)}…`);
      }, 2800);
    } else {
      setTabStatus(tab, '');
    }
    syncChrome();
    renderTabs();
    renderFace();
  }

  // composer, send button and antenna follow the tabs' state
  function syncChrome() {
    const t = active();
    body.classList.toggle('busy', !!t?.busy);
    $('#send').innerHTML = Icon(t?.busy ? 'stop' : 'send');
    $('#send').title = t?.busy ? 'Stop' : 'Send (Enter)';
    if (!state.busy) body.classList.remove('thinking', 'talking');
    else if (!body.classList.contains('talking')) body.classList.add('thinking');
    setStatus(t?.statusText || '');
  }

  async function submit() {
    const tab = active();
    const text = input.value.trim();
    if (tab.busy) {
      // while working: app commands still run, empty Enter stops, anything else waits its turn
      if (!text && !state.attachments.length) cbot.invoke('robot:cancel', tab.id);
      else if (runLocalCommand(text)) {
        input.value = '';
        autosize();
        hidePalette();
      } else if (tab.question && !tab.question.sent) {
        answerFromComposer(text);
      } else queueQuestion(tab, text);
      return;
    }
    if (!text && !state.attachments.length) return;
    state.lastActivity = Date.now();
    input.value = '';
    autosize();

    hidePalette();
    if (runLocalCommand(text)) return;

    const files = state.attachments;
    state.attachments = [];
    renderAttachments();
    const question = text || (files.length === 1 ? 'Take a look at this.' : 'Take a look at these.');
    tab.vocabWord = askedWord(text); // "what does X mean?": offer to save X under the answer
    tab.log.querySelectorAll('.greet').forEach((el) => el.remove());
    clearFinishedHelpers(tab);
    addUser(question, files, tab);
    if (!tab.custom && tab.title === 'New chat') {
      const t = question.replace(/\s+/g, ' ').trim();
      tab.title = t.length > 28 ? t.slice(0, 27) + '…' : t;
    }
    Sfx.key.send();
    flash('hop', 600);
    const turnId = uid();
    startReply(tab);
    tab.current.turnId = turnId;
    tab.current.ask = { question, paths: files.map((f) => f.path) };
    setBusy(tab, true);

    const res = await cbot.invoke('robot:ask', tab.id, question, files.map((f) => f.path), turnId);
    if (!res.ok) onEvent({ type: 'fail', tabId: tab.id, turnId, message: res.error });
  }

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // Typed while the robot is still answering: it waits its turn (or jumps the queue with ⚡).
  async function queueQuestion(tab, text) {
    const files = state.attachments;
    state.attachments = [];
    renderAttachments();
    input.value = '';
    autosize();
    hidePalette();
    const question = text || 'Take a look at this.';
    const turnId = uid();
    const el = addUser(question, files, tab);
    el.classList.add('queued');
    const bar = document.createElement('div');
    bar.className = 'queue-actions';
    bar.innerHTML = `<span>${Icon('inbox', 'sm lead')}next up</span><button type="button" title="Stop the current answer and do this now">${Icon('zap', 'sm lead')}Send now</button><button type="button" title="Don't send">${Icon('x', 'sm')}</button>`;
    const [now, cancel] = bar.querySelectorAll('button');
    now.addEventListener('click', () => cbot.invoke('robot:send-now', tab.id, turnId));
    cancel.addEventListener('click', async () => {
      if (await cbot.invoke('robot:unqueue', tab.id, turnId)) dropQueued(tab, turnId, 'not sent');
    });
    el.appendChild(bar);
    tab.queue.push({ turnId, el, ask: { question, paths: files.map((f) => f.path) } });
    Sfx.key.send();
    flash('hop', 600);
    express('happy', 'o', 900);
    showPop(pick(['📨 Noted! Next up.', 'Got it, right after this!', 'Queued! ✍️']), 1800);
    const res = await cbot.invoke('robot:ask', tab.id, question, files.map((f) => f.path), turnId);
    if (!res.ok) {
      dropQueued(tab, turnId, 'not sent');
      addNote(`📨 ${res.error}`, '', tab);
    }
  }

  function dropQueued(tab, turnId, why) {
    const i = tab.queue.findIndex((q) => q.turnId === turnId);
    if (i < 0) return;
    const [q] = tab.queue.splice(i, 1);
    q.el.classList.remove('queued');
    q.el.classList.add('dropped');
    Icon.text(q.el.querySelector('.queue-actions'), `📭 ${why}`);
  }

  // Stop: interrupt the answer (the conversation carries on); queued messages are returned
  function stopTab(tab) {
    if (!tab?.busy) return;
    cbot.invoke('robot:cancel', tab.id);
    express('o', 'o', 900);
    showPop(pick(['Okay, stopping!', 'Halting!', 'Brakes on! 🛑']), 1500);
  }

  // an empty bot bubble that the next streamed reply fills in
  function startReply(tab) {
    const el = document.createElement('div');
    el.className = 'msg bot';
    tab.log.appendChild(el);
    tab.current = { el, parts: [], text: '' };
    partFor(tab.current, 'text'); // (its blinking caret, until the first words or step)
    scrollDown(tab);
  }
  // (after a question card the answer carries on in a fresh bubble: its words from `offset` on)
  function moveReply(cur, el, offset) {
    Object.assign(cur, { el, parts: [], offset, asked: true });
    partFor(cur, 'text');
  }

  // The answer as it streams, in the order it happened: words, then the steps it took, the
  // files they changed, more words… Each part is { kind: 'text', el, from, to } (its slice of
  // cur.text), { kind: 'steps', el } (a row of step chips) or { kind: 'made', el } (diffs,
  // tool views, pictures). partFor gives the part to add to, starting a new one when the kind
  // changes; a text part ends where the next part begins.
  const PART_CLASS = { text: 'content', steps: 'tools', made: 'edits' };
  function partFor(cur, kind) {
    const last = cur.parts[cur.parts.length - 1];
    if (last?.kind === kind) return last;
    if (last?.kind === 'text') {
      last.to = cur.text.length;
      last.el.classList.remove('cursor');
      if (!partText(cur, last).trim()) {
        last.el.remove();
        cur.parts.pop();
        const prev = cur.parts[cur.parts.length - 1];
        if (prev?.kind === kind) return prev;
      }
    }
    const el = document.createElement('div');
    el.className = PART_CLASS[kind] + (kind === 'text' ? ' cursor' : '');
    cur.el.appendChild(el);
    const part = { kind, el, from: cur.text.length };
    cur.parts.push(part);
    return part;
  }
  const partText = (cur, p) => cur.text.slice(Math.max(p.from, cur.offset || 0), p.to ?? cur.text.length);
  const hasSteps = (cur) => cur.parts.some((p) => p.kind !== 'text' && p.el.children.length);
  // a remark it made in passing: with the steps just before the words it's saying (not in the
  // middle of a sentence)
  function asideRow(cur) {
    const last = cur.parts[cur.parts.length - 1];
    if (last?.kind !== 'text') return partFor(cur, 'steps').el;
    const prev = cur.parts[cur.parts.length - 2];
    if (prev?.kind === 'steps') return prev.el;
    const el = document.createElement('div');
    el.className = 'tools';
    last.el.before(el);
    cur.parts.splice(cur.parts.length - 1, 0, { kind: 'steps', el });
    return el;
  }

  // the answer's words, finished: every text part redrawn. `text` stands in when nothing was
  // streamed, `note` goes after the last words ("…(stopped)"), `empty` shows when there's
  // nothing else to say
  function finishText(cur, { text = '', note = '', empty = '' } = {}) {
    for (const p of cur.parts) if (p.kind === 'text') p.el.innerHTML = md(partText(cur, p));
    const said = cur.parts.filter((p) => p.kind === 'text' && partText(cur, p).trim());
    const lastText = said[said.length - 1];
    if (!said.length && (text || note || empty)) {
      const p = partFor(cur, 'text');
      p.el.innerHTML = md(text ? `${text}${note ? `\n\n${note}` : ''}` : note || empty);
    } else if (note && lastText) lastText.el.innerHTML = md(`${partText(cur, lastText)}\n\n${note}`);
    for (const p of cur.parts) p.el.classList.remove('cursor');
    dedupePics(cur.el);
  }

  function renderCurrent(tab) {
    if (tab.renderQueued) return;
    tab.renderQueued = true;
    requestAnimationFrame(() => {
      tab.renderQueued = false;
      const cur = tab.current;
      if (!cur) return;
      const L = tab.log;
      const nearBottom = L.scrollHeight - L.scrollTop - L.clientHeight < 60;
      // (only the words still coming: the parts before them are done)
      const last = cur.parts[cur.parts.length - 1];
      if (last?.kind === 'text') last.el.innerHTML = md(partText(cur, last));
      dedupePics(cur.el);
      if (nearBottom) scrollDown(tab);
    });
  }

  function finishCurrent(tab) {
    const cur = tab.current;
    tab.current = null;
    if (cur) for (const p of cur.parts) p.el.classList.remove('cursor');
    setBusy(tab, false);
    // the task you sent is over: if you tucked the chat away, the status bubble says so — unless a bonk restarts it
    if (state.collapsed && !tab.bonk) {
      state.news = '✅ Done! Click to read the answer';
      renderWorking();
    }
    if (!tab.bonk) {
      tab.hurried = false;
      if (![...tabs.values()].some((t) => t.hurried)) robot.dataset.hurry = '';
    }
    return cur;
  }

  function onEvent(ev) {
    const tab = tabs.get(ev.tabId);
    if (!tab) return;
    const cur = tab.current;
    const show = animates(tab);
    state.lastActivity = Date.now();
    switch (ev.type) {
      case 'turn-start': {
        // a queued message's turn has come
        const qi = tab.queue.findIndex((q) => q.turnId === ev.turnId);
        let asked = null;
        if (qi >= 0) {
          const [q] = tab.queue.splice(qi, 1);
          q.el.classList.remove('queued');
          q.el.querySelector('.queue-actions')?.remove();
          asked = q.ask;
        }
        if (tab.bonk?.turnId === ev.turnId) {
          asked = tab.bonk.ask;
          tab.bonk = null; // the hurried rerun is under way
        }
        if (ev.kind === 'compact') {
          startCompact(tab);
          break;
        }
        if (tab.current?.turnId !== ev.turnId) {
          startReply(tab);
          tab.current.turnId = ev.turnId;
          if (asked) tab.current.ask = asked;
        }
        if (!tab.busy) setBusy(tab, true);
        if (tab.hurried) setTabStatus(tab, '🔨 Hurrying…');
        break;
      }

      case 'dropped':
        for (const t of ev.turnIds) dropQueued(tab, t, 'not sent (stopped)');
        break;

      case 'tasks':
        onTasks(tab, ev);
        break;

      case 'agent':
        onAgent(tab, ev);
        break;

      case 'context':
        tab.context = ev.context;
        if (tab === active()) renderBrain();
        break;

      case 'compact':
        if (ev.phase === 'start') startCompact(tab);
        else tab.compactResult = ev;
        break;

      case 'thinking':
        tab.activity = 'think';
        if (!show) break;
        body.classList.add('thinking');
        if (state.activity !== 'talk') setActivity('think');
        break;

      case 'text':
        if (!cur) return;
        // the moment words start flowing after some work: lightbulb!
        if (show && state.activity !== 'talk' && !cur.text.trim()) flash('idea', 1100);
        if (tab.activity !== 'talk') {
          cur.toolStatus = '💬 Writing it up';
          setTabStatus(tab, '💬 Writing it up…');
        }
        partFor(cur, 'text'); // (after some steps, the words carry on below them)
        cur.text += ev.delta;
        tab.activity = 'talk';
        if (show) {
          if (state.activity !== 'talk') setActivity('talk');
          body.classList.add('talking');
          body.classList.remove('thinking');
          renderFace();
          Sfx.chirp();
          clearTimeout(onEvent.quiet);
          onEvent.quiet = setTimeout(() => {
            body.classList.remove('talking');
            if (state.busy) {
              body.classList.add('thinking');
              if (state.activity === 'talk') setActivity('think');
            }
            renderFace();
          }, 700);
        }
        renderCurrent(tab);
        break;

      case 'tool': {
        if (!cur) return;
        const { label, activity } = toolLook(ev.name, ev.detail);
        // (the chip: a line icon for the kind of step, then what it did; click it for the details)
        const call = { id: ev.id, name: ev.name, detail: ev.detail, args: ev.args, running: true };
        if (ev.id) (tab.calls ||= new Map()).set(ev.id, call);
        const chip = callChip(call, tab);
        if ((ev.name === 'Agent' || ev.name === 'Task') && ev.id) {
          chip.classList.add('agent-chip');
          chip.title = `${label} (click to watch it work)`;
        }
        partFor(cur, 'steps').el.appendChild(chip); // (where it happened: after the words so far)
        cur.toolStatus = label;
        tab.activity = activity;
        setTabStatus(tab, `${label}…`);
        if (show) {
          setActivity(activity);
          body.classList.add('thinking');
          body.classList.remove('talking');
          clearTimeout(onEvent.quiet);
          renderFace();
          Sfx.tool();
        }
        scrollDown(tab);
        break;
      }

      case 'tool-output': {
        // what a step gave back: on its chip (an error shows), and in its details if they're open
        const call = tab.calls?.get(ev.id);
        if (!call) break;
        Object.assign(call, { output: ev.text, media: ev.media, isError: ev.isError, running: false });
        for (const chip of tab.log.querySelectorAll('.tool[data-call]')) if (chip.dataset.call === ev.id) chip.classList.toggle('failed', !!ev.isError);
        if (helperView.call === call) renderToolView();
        break;
      }

      case 'edit':
        if (!cur) break;
        partFor(cur, 'made').el.appendChild(diffCard(ev));
        scrollDown(tab);
        break;

      case 'app': // an MCP tool's own view (e.g. an Excalidraw drawing)
        if (!cur) break;
        partFor(cur, 'made').el.appendChild(appCard(ev));
        scrollDown(tab);
        break;

      case 'app-result':
        appResult(ev.id, ev.result);
        break;

      case 'tool-images': // pictures an MCP tool returned (a screenshot, a rendered chart)
        if (!cur) break;
        partFor(cur, 'made').el.appendChild(toolPics(ev.images));
        scrollDown(tab);
        break;

      case 'terminal':
        terminalState(ev.state, tab);
        break;

      case 'mirror':
        mirror(ev);
        break;

      case 'question':
        askUser(ev, tab);
        break;

      case 'aside':
        if (cur) asideRow(cur).appendChild(asideChip(ev.text));
        if (!show) break;
        showAside(ev.text);
        Sfx.hmm();
        express(pick(['happy', 'open', 'open']), pick(['o', 'smile']), 1400);
        break;

      case 'status':
        if (cur) cur.toolStatus = ev.text;
        setTabStatus(tab, `${ev.text}…`);
        break;

      case 'done': {
        if (ev.kind === 'compact') {
          finishCompact(tab);
          break;
        }
        // Claude's turn on a note is over: no more 🔧 on its sticky (a bonk's rerun carries on with it)
        if (tab.noteId && !(ev.interrupted && tab.bonk)) cbot.invoke('notes:act', 'working', { id: tab.noteId, working: false });
        const done = finishCurrent(tab);
        expireQuestion(tab);
        if (ev.interrupted) {
          if (done) {
            const said = done.text.slice(done.offset || 0).trim();
            const why = tab.bonk ? '🔨 restarting quicker' : 'stopped';
            finishText(done, { note: said ? `_…(${why})_` : '', empty: tab.bonk ? '_🔨 Restarting, quicker!_' : '_Okay, okay, I stopped._' });
          }
          if (tab.bonk) break; // the rerun follows straight away
          tab.noteId = '';
          if (tab.linkReq) linkAnswer(tab, { error: 'it was stopped before it finished' });
          if (show) setActivity(restingActivity());
          express('flat', 'o', 1200);
          renderTabs();
          break;
        }
        if (done) {
          const said = done.text.slice(done.offset || 0).trim();
          if (!said && done.asked && !hasSteps(done)) done.el.remove(); // nothing more after the answer
          else finishText(done, { text: done.asked ? '' : ev.text, empty: '_(no words, just vibes)_' });
          if (ev.isError) done.el.classList.add('error');
          if (ev.denials?.length) done.el.appendChild(deniedNote(ev.denials));
          if (tab.vocabWord && !ev.isError) done.el.appendChild(saveWordChip(tab.vocabWord));
          tab.vocabWord = '';
          if (tab.noteId && !ev.isError) done.el.appendChild(tickNoteChip(tab.noteId));
        }
        tab.noteId = ''; // (the chip goes on that one answer only)
        // another robot asked this: its answer goes back to it (main robotLink.js)
        if (tab.linkReq) {
          const said = done ? (done.asked ? done.text.slice(done.offset || 0) : done.text) : '';
          linkAnswer(tab, ev.isError ? { error: said || ev.text || 'it hit an error' } : { text: said || ev.text || '' });
        }
        if (!ev.isError) socialReport({ kind: 'done' });
        if (tab !== active()) tab.status = ev.isError ? 'error' : 'done'; // unread
        if (!show) {
          // a background tab finished while you watch another one
          Sfx.key.done();
          express('happy', 'o', 1200);
          showPop(`“${tab.title}” is done!`, 2600);
        } else if (ev.isError) {
          Sfx.key.oops();
          setActivity('error', 3500);
          express('dizzy', 'flat', 2200);
          showPop(pick(persona().oops));
        } else if (ev.denials?.length) {
          Sfx.key.oops();
          setActivity('locked', 3500);
          express('flat', 'flat', 2200);
          showPop('They locked me out of some tools!');
        } else {
          Sfx.key.done();
          setActivity('done', 2600);
          express('happy', 'smile', 2000);
          showPop(tab === active() ? pick(persona().done) : `“${tab.title}” is done!`, 2400);
        }
        if (!state.awake) body.classList.add('has-badge');
        scrollDown(tab);
        renderTabs();
        refreshCommands();
        break;
      }

      case 'fail': {
        if (tab.queue.some((q) => q.turnId === ev.turnId)) {
          dropQueued(tab, ev.turnId, ev.cancelled ? 'not sent' : `not sent: ${ev.message}`);
          break;
        }
        if (tab.compacting) finishCompact(tab, ev.message);
        // a note it was asked about: no more 🔧 on its sticky (you can ask again)
        if (tab.noteId) {
          cbot.invoke('notes:act', 'working', { id: tab.noteId, working: false });
          tab.noteId = '';
        }
        if (tab.linkReq) linkAnswer(tab, { error: ev.cancelled ? 'it was stopped' : ev.message || 'it failed' });
        const done = finishCurrent(tab);
        expireQuestion(tab);
        const said = done ? done.text.slice(done.offset || 0).trim() : '';
        if (ev.cancelled) {
          if (done) finishText(done, { note: said ? '_…(stopped)_' : '', empty: '_Okay, okay, I stopped._' });
          if (show) setActivity(restingActivity());
          express('flat', 'flat', 1200);
          break;
        }
        if (show) setActivity('error', 3500);
        if (tab !== active()) tab.status = 'error';
        if (done) {
          done.el.classList.add('error');
          finishText(done, { note: `**Oops:** ${ev.message}` });
        } else {
          addBot(`**Oops:** ${ev.message}`, { error: true, tab });
        }
        Sfx.key.oops();
        express('dizzy', 'flat', 2500);
        showPop(tab === active() ? pick(persona().oops) : `“${tab.title}” hit a snag.`);
        if (!state.awake) body.classList.add('has-badge');
        renderTabs();
        break;
      }
    }
  }

  // ------------------------------------------------------------ poking & dragging

  function poke() {
    const now = Date.now();
    state.pokes = state.pokes.filter((t) => now - t < 4000);
    state.pokes.push(now);
    cbot.invoke('robot:poke');
    if (state.pokes.length >= 5) {
      state.pokes = [];
      Sfx.key.annoyed();
      flash('shake', 500);
      express(Math.random() < 0.5 ? 'dizzy' : 'flat', 'flat', 2600);
      showPop(pick(persona().annoyed), 2800);
      return;
    }
    Sfx.key.poke();
    flash('squish', 450);
    flash('blush', 1200);
    express(pick(['happy', 'happy', 'open']), pick(['o', 'smile']), 900);
    showPop(pick(persona().pokes));
  }

  let press = null;
  robot.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    robot.setPointerCapture(e.pointerId);
    press = { x: e.screenX, y: e.screenY, lastX: e.screenX, lastT: performance.now(), moved: false, travel: 0 };
    stopAntic();
    cbot.send('robot:drag', { phase: 'start' });
  });

  robot.addEventListener('pointermove', (e) => {
    if (!press) return;
    const dx = e.screenX - press.x;
    const dy = e.screenY - press.y;
    if (!press.moved && Math.hypot(dx, dy) < 5) return;
    if (!press.moved) {
      press.moved = true;
      body.classList.add('dragging');
      Sfx.key.whee();
      express('open', 'o', 60000);
    }
    const now = performance.now();
    const step = e.screenX - press.lastX;
    const vx = step / Math.max(1, now - press.lastT);
    press.travel += Math.abs(step);
    // 3+ direction reversals within ~600 ms = a bonk, not just a move
    if (Math.abs(step) > 3) {
      const dir = Math.sign(step);
      if (press.dir && dir !== press.dir) {
        press.flips = [...(press.flips || []).filter((t) => now - t < 600), now];
        if (press.flips.length >= 3 && !press.bonked) {
          press.bonked = true;
          bonkRobot();
        }
      }
      press.dir = dir;
    }
    press.lastX = e.screenX;
    press.lastT = now;
    document.documentElement.style.setProperty('--swing', `${clamp(-vx * 18, -28, 28).toFixed(1)}deg`);
    cbot.send('robot:drag', { phase: 'move', dx, dy });
  });

  let monitorClick = 0; // a pending single click on the monitor (see endPress)
  function endPress(e) {
    if (!press) return;
    const p = press;
    press = null;
    try { robot.releasePointerCapture(e.pointerId); } catch {}
    cbot.send('robot:drag', { phase: 'end' });
    body.classList.remove('dragging');
    document.documentElement.style.setProperty('--swing', '0deg');
    state.lastActivity = Date.now();
    if (!p.moved) {
      const prop = office.propAt?.(e.clientX, e.clientY);
      if (prop?.kind === 'note' || prop?.kind === 'board') return openNotesFromBoard(prop);
      if (state.away) return awayClick();
      if (prop?.kind === 'hammer') return playWith('bonk');
      if (prop?.kind === 'plug') return playWith('charge');
      const note = office.stickyAt?.(e.clientX, e.clientY);
      if (note?.kind === 'vocab') {
        flash('hop', 500);
        cbot.invoke('robot:vocab-open', note.id);
        return;
      }
      if (state.awake && !state.mirroring && !state.collapsed && office.hitsMonitor(e.clientX, e.clientY)) {
        if (monitorClick) {
          clearTimeout(monitorClick);
          monitorClick = 0;
          crashMonitor();
        } else monitorClick = setTimeout(() => ((monitorClick = 0), poke()), 260);
        return;
      }
      if (state.mirroring) openTerminal();
      else if (state.collapsed) openChat();
      else if (state.awake) poke();
      else if (state.character.clickOpens === 'terminal') openTerminal();
      else bonkAwake();
      return;
    }
    state.face = null;
    if (p.travel > 1800) {
      express('dizzy', 'flat', 2200);
      showPop('Whoa… the room is spinning…');
    } else {
      renderFace();
    }
  }
  robot.addEventListener('pointerup', endPress);
  robot.addEventListener('pointercancel', endPress);

  robot.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cbot.invoke('robot:menu', { awake: state.awake, away: !!state.away });
  });

  // ------------------------------------------------------------ composer

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight + 4, 120)}px`;
    input.style.overflowY = input.scrollHeight + 4 > 120 ? 'auto' : 'hidden';
  }

  input.addEventListener('input', () => {
    autosize();
    updatePalette();
    state.lastActivity = Date.now();
    // watch the user type
    lookAt(state.placement === 'right' ? 200 : -200, 0, 1200); // at the chat beside it
    body.classList.add('typing');
    clearTimeout(input.t);
    input.t = setTimeout(() => body.classList.remove('typing'), 1200);
  });
  input.addEventListener('click', () => updatePalette());
  input.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') updatePalette();
  });
  input.addEventListener('keydown', (e) => {
    if (!paletteEl.hidden && paletteKey(e)) return;
    // number keys pick an option while a question is waiting and the box is empty
    const q = active()?.question;
    if (q && !q.sent && !input.value && /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      q.pickByNumber(Number(e.key));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  // Esc peels back one layer: command list, then history, then off to sleep
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !state.awake) return;
    if (!menuEl.hidden) closeMenu();
    else if (!paletteEl.hidden) hidePalette();
    else if (history.isOpen()) history.escape();
    else if (helperView.id || helperView.call) closeHelper();
    else if (active()?.busy) stopTab(active()); // like Claude Code: Esc interrupts
    else sleep();
  });
  $('#btn-history').addEventListener('click', () => (history.isOpen() ? history.close() : openHistory()));
  $('#btn-terminal').addEventListener('click', () => openTerminal());
  // the ■ button always means stop, even with a draft in the box
  $('#send').addEventListener('click', (e) => {
    if (!active()?.busy) return;
    e.preventDefault();
    stopTab(active());
  });
  $('#btn-sleep').addEventListener('click', () => sleep());
  $('#btn-collapse').addEventListener('click', () => collapse());
  $('#btn-reset').addEventListener('click', () => cbot.invoke('robot:reset', activeId));
  $('#folder').addEventListener('click', () => cbot.invoke('robot:open-folder'));

  // ------------------------------------------------------------ terminal mode

  // Full Claude Code in a terminal window. The bubble steps aside and the robot
  // acts out what happens there (from Claude Code's transcript).
  async function openTerminal() {
    const res = await cbot.invoke('robot:terminal', activeId);
    if (!res.ok) {
      if (state.awake) addNote(`⌨️ ${res.error}`);
      express('flat', 'flat', 1500);
      return;
    }
    if (res.already) {
      flash('hop', 600);
      express('happy', 'o', 1200);
      if (state.awake) showPop('Already open! Check your taskbar.', 2200);
    }
  }

  function terminalState(s, tab, { quiet = false } = {}) {
    if (s === 'opened') {
      state.mirroring = true;
      tab.terminal = true;
      renderTabs();
      if (!quiet) addNote('⌨️ Continued in the terminal. I’ll act out what happens there.', '', tab);
      Sfx.send();
      // step out of the chat: no bubble, but awake at the desk
      if (body.classList.contains('expanded')) cbot.invoke('robot:expand', false);
      state.collapsed = false;
      body.classList.remove('collapsed');
      renderWorking();
      state.awake = true;
      body.classList.remove('asleep');
      body.classList.add('awake');
      flash('spin', 950);
      setActivity('boot', 900);
    } else {
      state.mirroring = false;
      tab.terminal = false;
      renderTabs();
      body.classList.remove('thinking', 'talking');
      renderHistory(tab);
      addNote('⌨️ Back from the terminal. Everything said there is above.', '', tab);
      Sfx.sleep();
      state.awake = false;
      body.classList.remove('awake', 'expanded');
      body.classList.add('asleep');
      setActivity('off');
    }
    renderFace();
  }

  let mirrorTalk = null;
  function mirror(ev) {
    if (!state.mirroring) return;
    clearTimeout(mirrorTalk);
    body.classList.remove('talking');
    if (ev.kind === 'prompt') {
      body.classList.add('thinking');
      setActivity('think');
      Sfx.send();
    } else if (ev.kind === 'tool') {
      const [, , activity] = TOOLS[ev.name] || ['', '', 'run'];
      body.classList.add('thinking');
      setActivity(activity);
      Sfx.tool();
    } else if (ev.kind === 'question') {
      body.classList.remove('thinking');
      setActivity('ask');
      Sfx.ask();
    } else if (ev.kind === 'text') {
      body.classList.remove('thinking');
      body.classList.add('talking');
      setActivity('talk');
      mirrorTalk = setTimeout(() => {
        body.classList.remove('talking');
        renderFace();
      }, 1800);
    } else if (ev.kind === 'idle') {
      body.classList.remove('thinking');
      setActivity('done', 2600);
      express('happy', 'smile', 2000);
      Sfx.key.done();
    }
    renderFace();
  }

  // ------------------------------------------------------------ questions from Claude

  // Claude Code stopped to ask something (AskUserQuestion). Show the questions
  // as a card with clickable options; the run waits until the answer goes back.
  function askUser({ requestId, questions }, tab) {
    const cur = tab.current;
    // close the bubble that was streaming, so the answer continues below the card
    if (cur) {
      if (!cur.text.slice(cur.offset || 0).trim() && !hasSteps(cur)) cur.el.remove();
      else finishText(cur);
    }

    const card = document.createElement('div');
    card.className = 'msg q-card';
    card.innerHTML = '<div class="q-title"></div>';
    card.querySelector('.q-title').textContent = `${state.character.name} has ${questions.length > 1 ? `${questions.length} questions` : 'a question'}`;
    const picks = questions.map(() => ({ labels: new Set(), other: '' }));
    const single = questions.length === 1 && !questions[0].multiSelect;
    const blocks = [];

    questions.forEach((q, qi) => {
      const block = document.createElement('div');
      block.className = 'q-block';
      if (q.header) {
        const h = document.createElement('div');
        h.className = 'q-header';
        h.textContent = q.header;
        block.appendChild(h);
      }
      const text = document.createElement('div');
      text.className = 'q-text';
      text.textContent = q.question;
      if (q.multiSelect) {
        const m = document.createElement('span');
        m.className = 'q-multi';
        m.textContent = ' (pick any)';
        text.appendChild(m);
      }
      block.appendChild(text);
      const opts = document.createElement('div');
      opts.className = 'q-opts';
      const buttons = (q.options || []).map((o, oi) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'q-opt';
        b.innerHTML = '<span class="q-key"></span><b></b><small></small>';
        b.querySelector('.q-key').textContent = oi + 1;
        b.querySelector('b').textContent = o.label;
        b.querySelector('small').textContent = o.description && o.description !== o.label ? o.description : '';
        b.addEventListener('click', () => choose(qi, o.label));
        opts.appendChild(b);
        return { b, label: o.label };
      });
      block.appendChild(opts);
      const other = document.createElement('input');
      other.className = 'q-other';
      other.placeholder = 'Something else… (type and press Enter)';
      other.addEventListener('input', () => {
        picks[qi].other = other.value.trim();
        if (!q.multiSelect && picks[qi].other) picks[qi].labels.clear();
        refresh();
      });
      other.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && other.value.trim()) {
          e.preventDefault();
          if (ready()) send();
        }
      });
      block.appendChild(other);
      card.appendChild(block);
      blocks.push({ q, buttons, other });
    });

    const actions = document.createElement('div');
    actions.className = 'q-actions';
    actions.innerHTML = '<button type="button" class="q-send">Send answer</button><span class="q-hint"></span>';
    const sendBtn = actions.querySelector('.q-send');
    actions.querySelector('.q-hint').textContent = single ? 'Click an option, press its number, or type below' : 'or type your answer below';
    sendBtn.addEventListener('click', () => ready() && send());
    card.appendChild(actions);
    if (single) sendBtn.hidden = true;

    function choose(qi, label) {
      if (pending.sent) return;
      const p = picks[qi];
      if (blocks[qi].q.multiSelect) {
        p.labels.has(label) ? p.labels.delete(label) : p.labels.add(label);
      } else {
        p.labels = new Set([label]);
        p.other = '';
        blocks[qi].other.value = '';
      }
      Sfx.tool();
      refresh();
      if (single) send();
    }

    const answerOf = (qi) => [...picks[qi].labels, ...(picks[qi].other ? [picks[qi].other] : [])].join(', ');
    const ready = () => picks.every((_, qi) => answerOf(qi));

    function refresh() {
      blocks.forEach(({ buttons }, qi) => buttons.forEach(({ b, label }) => b.classList.toggle('on', picks[qi].labels.has(label))));
      sendBtn.disabled = !ready();
    }

    async function send() {
      if (pending.sent) return;
      pending.sent = true;
      const answers = {};
      const items = questions.map((q, qi) => {
        answers[q.question] = answerOf(qi);
        return { question: q.question, header: q.header, answer: answerOf(qi) };
      });
      card.classList.add('answered');
      card.querySelectorAll('button, input').forEach((el) => (el.disabled = true));
      Icon.text(card.querySelector('.q-title'), `✋ You answered ${state.character.name}`);
      const ok = await cbot.invoke('robot:answer', tab.id, requestId, answers, items);
      if (!ok) {
        card.classList.add('expired');
        Icon.text(card.querySelector('.q-title'), '✋ Too late, that question has closed');
        return;
      }
      tab.question = null;
      if (!pendingQuestion()) {
        body.classList.remove('has-badge');
        $('#badge').textContent = '!';
      }
      Sfx.key.send();
      express('happy', 'smile', 1400);
      showPop(pick(['Got it!', 'Thanks!', 'Noted!', 'Roger that!']), 1500);
      tab.activity = 'think';
      if (animates(tab)) setActivity('think');
      setTabStatus(tab, `${pick(THINKING_VERBS)}…`);
      renderTabs();
      // the rest of the answer streams into a fresh bubble below the card
      if (tab.current) {
        const el = document.createElement('div');
        el.className = 'msg bot';
        tab.log.appendChild(el);
        moveReply(tab.current, el, tab.current.text.length);
      }
      scrollDown(tab);
      input.focus();
    }

    const pending = {
      sent: false,
      card,
      // composer text answers the first open question; once all are answered it
      // is added to the last one (replacing a single choice, joining a multi-pick)
      typed(text) {
        const open = picks.findIndex((_, i) => !answerOf(i));
        const target = open >= 0 ? open : picks.length - 1;
        blocks[target].other.value = text;
        picks[target].other = text;
        if (!blocks[target].q.multiSelect) picks[target].labels.clear();
        refresh();
        if (ready()) send();
      },
      pickByNumber(n) {
        const qi = Math.max(0, picks.findIndex((_, i) => !answerOf(i)));
        const opt = blocks[qi].buttons[n - 1];
        if (opt) choose(qi, opt.label);
      },
    };
    tab.question = pending;
    tab.log.appendChild(card);
    refresh();
    scrollDown(tab);

    // the robot turns round and puts its hand up
    tab.activity = 'ask';
    setTabStatus(tab, 'Waiting for your answer…');
    if (tab.current) tab.current.toolStatus = 'Waiting for your answer';
    renderTabs();
    Sfx.ask();
    express('open', 'o', 1500);
    renderWorking(); // it needs you: if the chat is tucked away, the status bubble says so
    if (animates(tab)) {
      state.pose = null; // drop any wave or stretch in progress
      setActivity('ask');
    }
    if (!state.awake) {
      $('#badge').textContent = '?';
      body.classList.add('has-badge');
    } else if (tab !== active()) {
      showPop(`“${tab.title}” has a question for you!`, 2600);
    } else {
      showPop(pick(['Quick question!', 'Psst, I need you!', 'Your call!']), 1800);
      card.querySelector('.q-opt, .q-other')?.focus();
    }
  }

  const pendingQuestion = () => [...tabs.values()].find((t) => t.question && !t.question.sent);

  function answerFromComposer(text) {
    input.value = '';
    autosize();
    hidePalette();
    active().question.typed(text);
  }

  // the run ended (or was stopped) before the question was answered
  function expireQuestion(tab) {
    const q = tab.question;
    tab.question = null;
    if (!pendingQuestion()) $('#badge').textContent = '!';
    if (!q || q.sent) return;
    q.card.classList.add('expired');
    q.card.querySelectorAll('button, input').forEach((el) => (el.disabled = true));
    Icon.text(q.card.querySelector('.q-title'), '✋ This question closed without an answer');
  }

  function addQaSummary(items = [], tab = active()) {
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'msg qa-summary';
      el.innerHTML = `${Icon('hand', 'sm lead')}<span></span> → <b></b>`;
      el.querySelector('span').textContent = it.question;
      el.querySelector('b').textContent = it.answer;
      tab.log.appendChild(el);
    }
    scrollDown(tab);
  }

  // ------------------------------------------------------------ feeding files

  // Drop (or paste) files on the robot: it reaches out, chomps them, and they
  // ride along with the next question.
  state.attachments = [];
  const attachRow = $('#attachments');
  // (and the one-click questions about a box of the screen: see “ask about the screen”)
  const screenAsks = $('#screen-asks');
  const PLACEHOLDER = input.placeholder;
  let screenShot = null; // { path, source } of the box the chips ask about
  let dragDepth = 0;
  let craving = null;

  // "325123341_704507901174002_2466761744648938636_n.jpg" -> "325123341_7045…_n.jpg": keeps
  // the start and the extension so the robot's speech bubble stays small
  function shortName(name, max = 22) {
    if (name.length <= max) return name;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot - 2) : name.slice(-6);
    return `${name.slice(0, max - ext.length - 1)}…${ext}`;
  }

  function renderAttachments() {
    attachRow.innerHTML = '';
    attachRow.hidden = !state.attachments.length;
    for (const f of state.attachments) {
      const chip = document.createElement('span');
      chip.className = 'file-chip';
      chip.title = f.path;
      chip.innerHTML = `<span></span><button type="button" title="Spit it out">${Icon('x', 'sm')}</button>`;
      chip.querySelector('span').textContent = f.name;
      if (!f.thumb) chip.querySelector('span').insertAdjacentHTML('beforebegin', Icon(fileIcon(f), 'sm'));
      if (f.thumb) chip.prepend(thumbImg(f.thumb));
      chip.querySelector('button').addEventListener('click', () => {
        state.attachments = state.attachments.filter((a) => a !== f);
        renderAttachments();
        showPop('Ptooey!', 1200);
        input.focus();
      });
      attachRow.appendChild(chip);
    }
    renderScreenAsks();
  }

  function startCraving() {
    if (body.classList.contains('feeding')) return;
    body.classList.add('feeding');
    Sfx.key.ooh();
    showPop(pick(persona().hungry || ['Ooh, snacks?']), 1800);
    const lean = () => {
      strikePose('eager', 450);
      express('happy', 'wide', 450);
    };
    lean();
    craving = setInterval(lean, 300);
  }

  function stopCraving() {
    body.classList.remove('feeding');
    clearInterval(craving);
    state.pose = null;
    state.face = null;
    renderPose();
    renderFace();
  }

  // dropped File objects -> [{ path, name, isDir, isImage }]
  async function toEntries(files) {
    const paths = [];
    const pasted = [];
    for (const f of files) {
      const p = cbot.pathForFile(f);
      if (p) paths.push(p);
      else if (f.type.startsWith('image/')) {
        pasted.push(cbot.invoke('robot:save-paste', new Uint8Array(await f.arrayBuffer()), f.type.split('/')[1]));
      }
    }
    const found = paths.length ? await cbot.invoke('robot:inspect-paths', paths) : [];
    return [...found, ...(await Promise.all(pasted)).filter(Boolean)];
  }

  function eat(entries) {
    stopCraving();
    if (!entries.length) {
      showPop("Hmm, I can't taste that one.");
      express('flat', 'flat', 1200);
      return;
    }
    if (!state.awake) wake({ sayHi: false });
    else openChat(); // show the chips even mid-task
    for (const e of entries) if (!state.attachments.some((a) => a.path === e.path)) state.attachments.push(e);
    state.attachments = state.attachments.slice(-20);
    renderAttachments();
    flash('chomp', 1300);
    express('happy', 'chomp', 1300);
    Sfx.key.chomp();
    const name = entries.length === 1 ? shortName(entries[0].name) : `${entries.length} things`;
    setTimeout(() => showPop(fill(pick(persona().yum || ['Yum! {file}!'])).replaceAll('{file}', name), 2400), 700);
    setTimeout(() => express('happy', 'smile', 1200), 1300);
    state.lastActivity = Date.now();
    input.focus();
  }

  const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    startCraving();
  });
  document.addEventListener('dragover', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!carriesFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) {
      stopCraving();
      express('flat', 'o', 900); // aww, it went away
    }
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    eat(await toEntries([...(e.dataTransfer?.files || [])]));
  });
  // Ctrl+V anywhere in the window: screenshots and files are eaten, text goes in the chat box
  document.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) {
      const text = e.clipboardData?.getData('text');
      if (e.target !== input && text && !e.target.closest?.('input, textarea, [contenteditable]')) {
        e.preventDefault();
        input.focus();
        input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input'));
      }
      return; // plain text in the chat box pastes as usual
    }
    e.preventDefault();
    startCraving();
    eat(await toEntries(files));
  });
  // from the robot's right-click menu: works even while it's asleep
  async function pasteClipboard() {
    startCraving();
    eat((await cbot.invoke('robot:paste-clipboard')) || []);
  }

  // ------------------------------------------------------------ the bonk

  // 🔨 A squeaky-hammer bonk. Asleep: it jolts awake. Working: it drops what it's doing and starts the
  // same question over, told to hurry. Idle: it just yelps.
  const HURRY = '\n\n⚡ Hurry up! Be quick: keep it short, skip the extras, and go straight to the result.';
  const BONK_COOLDOWN_MS = 3000;

  // The bonk itself: a squeaky toy hammer swings in and bonks the robot on the
  // head (drawn in 3D, see office3d/hammer.js). onHit runs the moment it lands.
  const BONK_HIT_MS = 420; // BONK.hit in office3d/index.js
  function smack(onHit) {
    flash('bonk', 1100);
    setTimeout(() => Sfx.key.swish(), BONK_HIT_MS - 110); // the swing
    setTimeout(() => {
      Sfx.key.squeak(); // the squeaky toy lands
      flash('shake', 400);
      onHit();
    }, BONK_HIT_MS);
  }

  function bonkRobot() {
    if (quizWord) {
      // a bonk mid-quiz: not now, thanks
      return smack(() => {
        cbot.invoke('robot:vocab-quiz', 'later');
        express('dizzy', 'o', 1200);
      });
    }
    smack(bonked);
  }

  // Clicking a sleeping robot: the squeaky hammer wakes it up (no cooldown, and
  // it doesn't hurry a task along, it just wakes up and opens the chat).
  // ------------------------------------------------------------ playing with it

  // Things round the desk to click (office3d props.js): the squeaky hammer on the desk
  // bonks it (and wakes it if it's asleep, like a click), the charger's plug on the floor
  // charges its battery (asleep too, without waking it). A dance party and a high-five it
  // gets up to by itself now and then (awakeAntic), and for a milestone.
  const PLAY_MS = { charge: 2600, highfive: 1300, dance: 4300 };
  // (byUser: you clicked something; its own idle dance or high-five doesn't count as you being around)
  function playWith(what, { byUser = true } = {}) {
    stopAntic(); // whatever idle antic was playing gives way
    if (byUser) state.lastActivity = Date.now();
    if (what === 'bonk') return state.awake ? bonkRobot() : bonkAwake();
    // (one at a time, but your click wins over a dance or high-five it got up to by itself)
    if (state.playing && (!byUser || state.playingByUser)) return;
    if (state.playing) robot.classList.remove(state.playing);
    state.playing = what;
    state.playingByUser = byUser;
    clearTimeout(playWith.timer);
    playWith.timer = setTimeout(() => (state.playing = null), PLAY_MS[what]);
    flash(what, PLAY_MS[what]); // the 3D view acts it out
    if (what === 'charge') {
      Sfx.key.charge();
      express('happy', 'o', 1900);
      setTimeout(() => {
        express('happy', 'smile', 1500);
        flash('hop', 600);
        showPop(pick(['Battery 100%! ⚡', 'Fully charged!', 'Zap! I feel brand new.']), 2000);
      }, 2000);
    } else if (what === 'highfive') {
      strikePose('raise', 1200);
      express('open', 'o', 450);
      setTimeout(() => {
        (byUser ? Sfx.key : Sfx).clap(); // (one it does by itself: an extra)
        express('happy', 'smile', 1200);
        showPop(pick(['Up top! ✋', 'Nice one!', 'Team work! ✋']), 1500);
      }, 450);
    } else if (what === 'dance') {
      (byUser ? Sfx.key : Sfx).dance();
      setActivity('dance', PLAY_MS.dance); // the disco screen
      strikePose('cheer', PLAY_MS.dance);
      express('happy', 'smile', PLAY_MS.dance);
      showPop(pick(['💃 Dance party!', 'Let’s boogie!', 'Disco time! 🕺']), 1800);
    }
  }

  function bonkAwake() {
    if (state.waking) return; // the hammer is already on its way
    state.waking = true;
    smack(() => {
      state.waking = false;
      if (state.awake) return;
      state.lastBonk = Date.now();
      startled();
    });
  }

  // startled awake (after wake(), so its own wake-up face doesn't win)
  function startled() {
    wake({ sayHi: false });
    express(pick(['dizzy', 'flat']), 'o', 1600);
    Sfx.key.annoyed();
    setTimeout(() => showPop(pick(persona().bonked || ['OW!']), 2200), 350);
  }

  function bonked() {
    const now = Date.now();
    if (now - (state.lastBonk || 0) < BONK_COOLDOWN_MS) {
      express('dizzy', 'o', 1200);
      if (state.awake) showPop("I'm already hurrying!", 1400);
      return;
    }
    state.lastBonk = now;
    const working = active()?.busy ? active() : [...tabs.values()].find((t) => t.busy);
    if (working && !working.compacting && !working.terminal && !working.bonk) return hurry(working);
    if (!state.awake) return startled();
    express('flat', 'o', 1400);
    flash('squish', 450);
    showPop(pick(persona().bonked || ['OW!']), 1800);
  }

  async function hurry(tab) {
    const asked = tab.current?.ask;
    if (!asked) {
      showPop(pick(persona().bonked || ['OW!']), 1800);
      return;
    }
    const turnId = uid();
    tab.bonk = { turnId, ask: asked };
    tab.hurried = true;
    robot.dataset.hurry = '1'; // sweat drops and frantic typing (3D)
    addNote('🔨 Bonked! Starting over, quicker.', '', tab);
    setTabStatus(tab, '🔨 Hurrying…');
    renderWorking();
    if (animates(tab)) {
      setActivity('edit');
      express('dizzy', 'o', 1500);
    }
    showPop(pick(persona().bonked || ['OW!']), 2000);
    // queue the hurried rerun, then let it jump the queue (this interrupts the current answer)
    const res = await cbot.invoke('robot:ask', tab.id, asked.question + HURRY, asked.paths, turnId, 'bonk');
    if (!res.ok) {
      tab.bonk = null;
      addNote(`🔨 ${res.error}`, '', tab);
      return;
    }
    if (res.queued) cbot.invoke('robot:send-now', tab.id, turnId);
  }

  $('#btn-bonk').addEventListener('click', bonkRobot);
  $('#btn-bonk-working').addEventListener('click', (e) => {
    e.stopPropagation(); // don't also open the chat
    bonkRobot();
  });

  // ------------------------------------------------------------ to-do card

  // Claude Code's task list for this tab, as a checklist the robot ticks off.
  const todoEl = $('#todo');

  function renderTodo() {
    const t = active();
    const tasks = t?.tasks || [];
    todoEl.hidden = !tasks.length;
    if (!tasks.length) return;
    const done = tasks.filter((x) => x.status === 'completed').length;
    todoEl.classList.toggle('collapsed', !!t.todoCollapsed);
    todoEl.innerHTML = '<div class="todo-head"><span class="todo-title"></span><span class="todo-bar"><i></i></span><span class="todo-chev"></span></div><ul class="todo-list"></ul>';
    todoEl.querySelector('.todo-title').textContent = `Plan  ${done}/${tasks.length}`;
    todoEl.querySelector('.todo-bar i').style.width = `${(done / tasks.length) * 100}%`;
    todoEl.querySelector('.todo-chev').textContent = t.todoCollapsed ? 'show' : 'hide';
    todoEl.querySelector('.todo-head').addEventListener('click', () => {
      t.todoCollapsed = !t.todoCollapsed;
      renderTodo();
    });
    const list = todoEl.querySelector('.todo-list');
    for (const task of tasks) {
      const li = document.createElement('li');
      li.className = `${task.status}${task.id === t.justDone ? ' just-done' : ''}`;
      li.innerHTML = '<span class="ti"></span><span class="tt"></span>';
      li.querySelector('.ti').textContent = ''; // (a checkbox drawn in CSS: empty, spinning, ticked)
      li.querySelector('.tt').textContent = task.status === 'in_progress' ? task.activeForm || task.subject : task.subject;
      list.appendChild(li);
    }
  }

  function onTasks(tab, ev) {
    tab.tasks = ev.tasks;
    const c = ev.change || {};
    const task = tab.tasks.find((x) => x.id === c.id);
    tab.justDone = c.op === 'update' && c.status === 'completed' ? c.id : null;
    if (c.op === 'create') tab.todoCollapsed = false;
    if (tab === active()) renderTodo();
    if (tab !== active() || !animates(tab)) return;
    if (c.op === 'update' && c.status === 'completed') {
      const allDone = tab.tasks.every((x) => x.status === 'completed');
      Sfx.tick();
      flash('hop', 600);
      express('happy', 'smile', 1200);
      if (allDone) {
        strikePose('cheer', 1600);
        showPop('All tasks done! ✨', 2200);
        setTimeout(() => {
          tab.todoCollapsed = true;
          if (tab === active()) renderTodo();
        }, 8000);
      } else if (task) showPop(`✓ ${task.subject.length > 34 ? task.subject.slice(0, 33) + '…' : task.subject}`, 1800);
    }
  }

  // ------------------------------------------------------------ helper agents

  // Helper agents (sub-agents) Claude Code sends out, each with its own card:
  // what it's doing right now, how far it got, and its report when it's back.
  const helpersEl = $('#helpers');
  const helperView = { id: null, call: null, tab: null, timer: 0 }; // (call: a tool step's details instead)
  const AGENT_ICON = { completed: 'check', failed: 'alert', killed: 'stop', stopped: 'stop' };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const elapsed = (a) => {
    const s = Math.max(0, Math.round(((a.ended || Date.now()) - a.started) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  };
  const stepLabel = (s) => {
    const [emoji, verb] = TOOLS[s.tool] || ['🛠️', `Using ${s.tool}`];
    return `${emoji} ${verb}${s.detail ? ' ' + s.detail : ''}`;
  };
  const helperMeta = (a) =>
    [a.toolsUsed ?? a.steps.length ? plural(a.toolsUsed ?? a.steps.length, 'step') : '', a.tokens ? `${Math.round(a.tokens / 1000)}k tokens` : '', elapsed(a)].filter(Boolean).join(' · ');

  function onAgent(tab, ev) {
    tab.agents ||= new Map();
    const fresh = !tab.agents.has(ev.id);
    const a = tab.agents.get(ev.id) || { id: ev.id, description: 'Helper', status: 'running', steps: [], text: '', started: Date.now() };
    tab.agents.set(ev.id, a);
    switch (ev.op) {
      case 'start':
        Object.assign(a, {
          description: ev.description || a.description,
          kind: ev.kind || a.kind,
          prompt: ev.prompt || a.prompt,
          background: ev.background || a.background,
          parent: ev.parent ?? a.parent,
        });
        if (fresh) tab.helpersCollapsed = false;
        break;
      case 'progress':
        Object.assign(a, { activity: ev.activity || a.activity, tokens: ev.tokens ?? a.tokens, toolsUsed: ev.tools ?? a.toolsUsed });
        break;
      case 'step':
        a.steps.push({ tool: ev.tool, detail: ev.detail, at: Date.now() });
        a.activity = stepLabel(a.steps[a.steps.length - 1]);
        break;
      case 'text':
        a.text += (a.text ? '\n\n' : '') + ev.text;
        break;
      case 'status':
        if (ev.status !== 'running') a.status = ev.status;
        break;
      case 'done': {
        const wasRunning = a.status === 'running' || !a.ended;
        Object.assign(a, { status: ev.status || 'completed', summary: ev.summary || a.summary, report: ev.report || a.report, ended: a.ended || Date.now() });
        if (ev.tokens) a.tokens = ev.tokens;
        if (ev.tools !== undefined) a.toolsUsed = ev.tools;
        if (wasRunning) {
          tab.justBack = a.id;
          if (animates(tab)) {
            Sfx.tick();
            flash('hop', 600);
            const name = a.description.length > 30 ? a.description.slice(0, 29) + '…' : a.description;
            showPop(a.status === 'completed' ? `🤖 “${name}” is back!` : `🤖 “${name}” ran into trouble`, 2200);
          }
        }
        break;
      }
    }
    if (tab === active()) renderHelpers();
    if (helperView.id === a.id) renderHelperView();
    actOutHelper(tab, ev, fresh);
  }

  // the robot acts out its helpers: a whee as one flies off, a hop when one takes
  // a step, and supervising (chin in hand, watching them circle) while any are out
  function actOutHelper(tab, ev, fresh) {
    renderTabs(); // tab dot, and the count of little bots
    renderWorking();
    if (!animates(tab)) return;
    if (ev.op === 'start' && fresh) {
      Sfx.whee();
      flash('hop', 600);
    } else if (ev.op === 'step') {
      flash('helper-step', 400);
      Sfx.tool();
    }
    if (ev.op === 'done' && !helpersOut() && !state.busy) {
      // the last one is back
      setActivity('done', 2600);
      express('happy', 'smile', 2000);
      return;
    }
    const rest = restingActivity();
    // don't cut short a tool or talking scene of the answer in progress
    if (!state.busy && state.activity !== rest && state.activity !== 'done') setActivity(rest);
    else if (state.busy && rest === 'helpers' && (state.activity === 'think' || state.activity === 'agent')) setActivity(rest);
    renderFace();
  }

  function clearFinishedHelpers(tab) {
    if (!tab.agents?.size || [...tab.agents.values()].some((a) => a.status === 'running')) return;
    tab.agents.clear();
    if (tab === active()) renderHelpers();
  }

  function renderHelpers() {
    const t = active();
    const list = [...(t?.agents?.values() || [])];
    helpersEl.hidden = !list.length;
    if (!list.length) return;
    const back = list.filter((a) => a.status !== 'running').length;
    helpersEl.classList.toggle('collapsed', !!t.helpersCollapsed);
    helpersEl.innerHTML = '<div class="todo-head"><span class="todo-title"></span><span class="todo-bar"><i></i></span><span class="todo-chev"></span></div><ul class="helper-list"></ul>';
    helpersEl.querySelector('.todo-title').textContent = back === list.length ? `${plural(list.length, 'helper')}  all back` : `Helpers  ${back}/${list.length} back`;
    helpersEl.querySelector('.todo-bar i').style.width = `${(back / list.length) * 100}%`;
    helpersEl.querySelector('.todo-chev').textContent = t.helpersCollapsed ? 'show' : 'hide';
    helpersEl.querySelector('.todo-head').addEventListener('click', () => {
      t.helpersCollapsed = !t.helpersCollapsed;
      renderHelpers();
    });
    const ul = helpersEl.querySelector('.helper-list');
    for (const a of list) {
      const li = document.createElement('li');
      li.className = `${a.status}${a.id === t.justBack ? ' just-back' : ''}`;
      li.title = 'Click to watch it work';
      li.innerHTML = '<span class="hi"></span><span class="hn"></span><span class="hm"></span><span class="hs"></span>';
      li.querySelector('.hi').innerHTML = AGENT_ICON[a.status] ? Icon(AGENT_ICON[a.status], 'sm') : '';
      li.querySelector('.hn').textContent = `${a.parent ? '↳ ' : ''}${a.description}`;
      li.querySelector('.hm').textContent = helperMeta(a);
      const firstLine = (a.summary || a.report || '').split('\n').find((l) => l.trim()) || '';
      li.querySelector('.hs').textContent = a.status === 'running' ? a.activity || 'Getting started…' : firstLine || 'Done';
      li.addEventListener('click', () => openHelper(t, a.id));
      ul.appendChild(li);
    }
    t.justBack = null;
  }
  // running helpers' clocks keep ticking on the card
  setInterval(() => {
    const t = active();
    if (!helpersEl.hidden && [...(t?.agents?.values() || [])].some((a) => a.status === 'running')) renderHelpers();
  }, 1000);

  function openHelper(tab, id) {
    if (!tab.agents?.has(id)) return;
    if (history.isOpen()) history.close();
    helperView.id = id;
    helperView.tab = tab;
    document.body.classList.add('helper-open');
    $('#helper-view').hidden = false;
    renderHelperView(true);
    clearInterval(helperView.timer);
    helperView.timer = setInterval(() => helperView.tab?.agents?.get(helperView.id)?.status === 'running' && renderHelperView(), 1000);
  }

  // One tool step up close (the same panel as a helper): what it was called with, field by
  // field, and what it gave back. Asking another robot shows the whole question and answer.
  function openToolView(tab, call) {
    if (history.isOpen()) history.close();
    clearInterval(helperView.timer);
    helperView.id = null;
    helperView.call = call;
    helperView.tab = tab;
    document.body.classList.add('helper-open');
    $('#helper-view').hidden = false;
    renderToolView();
    $('#hv-body').scrollTop = 0;
  }
  // (the fields that are prose: shown as markdown)
  const PROSE = new Set(['message', 'details', 'prompt', 'description', 'question', 'title']);
  function renderToolView() {
    const c = helperView.call;
    if (!c) return closeHelper();
    const look = toolLook(c.name, c.detail);
    Icon.text($('#hv-title'), look.label);
    const bodyEl = $('#hv-body');
    const status = c.running ? 'running' : c.isError ? 'failed' : 'completed';
    const missing = c.trimmed ? 'Not kept in the saved history (it was too big).' : 'Not recorded for this step.';
    bodyEl.innerHTML = `
      <div class="hv-meta"><span class="pill-${status}"></span><span class="hv-kind"></span></div>
      <div class="tv-head"><h4>Input</h4><button type="button" class="tv-copy" data-copy="args" data-icon="copy">Copy</button></div>
      <div class="tv-args"></div>
      <div class="tv-head"><h4>${c.isError ? 'Error' : 'Result'}</h4><button type="button" class="tv-copy" data-copy="output" data-icon="copy" hidden>Copy</button></div>
      <div class="tv-out"></div>`;
    Icon.text(bodyEl.querySelector(`.pill-${status}`), { running: '⏳ Working', failed: '⚠️ Error', completed: '✅ Done' }[status]);
    bodyEl.querySelector('.hv-kind').textContent = c.name;
    // the input, field by field
    const argsEl = bodyEl.querySelector('.tv-args');
    const args = c.args && typeof c.args === 'object' ? c.args : null;
    if (!args) argsEl.innerHTML = `<p class="hv-empty">${missing}</p>`;
    else if (!Object.keys(args).length) argsEl.innerHTML = '<p class="hv-empty">(none)</p>';
    else {
      for (const [k, v] of Object.entries(args)) {
        const row = document.createElement('div');
        row.className = 'tv-field';
        const key = document.createElement('div');
        key.className = 'tv-key';
        key.textContent = k.replace(/_/g, ' ');
        const val = document.createElement('div');
        if (typeof v === 'string' && PROSE.has(k) && v.length > 40) {
          val.className = 'tv-val hv-words';
          val.innerHTML = md(v);
        } else if (typeof v !== 'object' && String(v).length <= 120 && !String(v).includes('\n')) {
          val.className = 'tv-val inline';
          val.textContent = String(v);
        } else {
          val.className = 'tv-val block';
          val.textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
        }
        row.append(key, val);
        argsEl.appendChild(row);
      }
    }
    // what it gave back
    const outEl = bodyEl.querySelector('.tv-out');
    const media = Array.isArray(c.media) ? c.media : [];
    if (media.length && !c.running) outEl.after(stepMedia(media, args));
    if (c.running) outEl.innerHTML = '<p class="hv-empty">Still working on it…</p>';
    else if (c.output === undefined || c.output === null) outEl.innerHTML = media.length ? '' : `<p class="hv-empty">${missing}</p>`;
    else if (!c.output) outEl.innerHTML = media.length ? '' : '<p class="hv-empty">(nothing)</p>';
    else {
      bodyEl.querySelector('[data-copy="output"]').hidden = false;
      // another robot's answer reads as its message; everything else as the tool gave it
      if (/^mcp__cbot__/.test(c.name) && !c.isError) {
        outEl.className = 'tv-out hv-words';
        outEl.innerHTML = md(c.output);
      } else {
        outEl.className = `tv-out block${c.isError ? ' error' : ''}`;
        outEl.textContent = c.output;
      }
    }
    for (const b of bodyEl.querySelectorAll('.tv-copy')) {
      b.addEventListener('click', () => {
        const text = b.dataset.copy === 'args' ? JSON.stringify(c.args ?? {}, null, 2) : String(c.output ?? '');
        navigator.clipboard.writeText(text).then(() => showPop('Copied! 📋', 1200), () => {});
      });
    }
    Icon.fill(bodyEl);
  }

  // what a step gave back besides words (main stepMedia): its pictures, shown (click one to
  // see it full size), and its documents (a PDF it read), as a card that opens the file
  function stepMedia(media, args) {
    const box = document.createElement('div');
    box.className = 'tv-media';
    const file = typeof args?.file_path === 'string' ? args.file_path : '';
    const fileName = file.split(/[\\/]/).pop();
    const card = (icon, title, sub) => {
      const el = document.createElement(file ? 'button' : 'div');
      el.className = 'tv-doc';
      if (file) {
        el.type = 'button';
        el.dataset.open = file;
        el.title = `Open ${file}`;
      }
      el.innerHTML = `${Icon(icon)}<span><b></b><small></small></span>${file ? Icon('open', 'sm') : ''}`;
      el.querySelector('b').textContent = title;
      el.querySelector('small').textContent = sub;
      return el;
    };
    for (const m of media) {
      if (m.kind === 'image' && m.data && /^image\/[\w.+-]+$/.test(m.mimeType || '')) {
        const img = document.createElement('img');
        img.className = 'tv-pic';
        img.src = `data:${m.mimeType};base64,${m.data}`;
        img.alt = fileName || 'Picture';
        img.title = 'Click to see it full size';
        img.addEventListener('click', () => img.classList.toggle('big'));
        box.appendChild(img);
      } else if (m.kind === 'image') {
        box.appendChild(card('image', fileName || 'A picture', file ? 'Not kept in the saved history (too big): click to open the file' : 'Not kept in the saved history (too big)'));
      } else if (m.kind === 'document') {
        const kind = /pdf/i.test(m.mimeType || '') ? 'PDF' : (m.mimeType || 'Document').replace(/^application\//, '').toUpperCase();
        const size = m.size ? ` · ${m.size < 1024 ? `${m.size} B` : m.size < 1048576 ? `${Math.round(m.size / 1024)} KB` : `${(m.size / 1048576).toFixed(1)} MB`}` : '';
        box.appendChild(card('file', fileName || `A ${kind} document`, `${kind}${size}${file ? ' · click to open' : ''}`));
      }
    }
    return box;
  }

  function closeHelper() {
    clearInterval(helperView.timer);
    helperView.id = null;
    helperView.call = null;
    helperView.tab = null;
    $('#helper-view').hidden = true;
    document.body.classList.remove('helper-open');
    scrollDown();
    input.focus();
  }
  $('#hv-back').addEventListener('click', closeHelper);

  function renderHelperView(top = false) {
    const a = helperView.tab?.agents?.get(helperView.id);
    if (!a) return closeHelper();
    const bodyEl = $('#hv-body');
    const nearBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 60;
    const open = bodyEl.querySelector('details')?.open;
    Icon.text($('#hv-title'), `🤖 ${a.description}`);
    const status = { running: '⏳ Working', completed: '✅ Done', failed: '⚠️ Failed', killed: '🛑 Stopped', stopped: '🛑 Stopped' }[a.status] || a.status;
    bodyEl.innerHTML = `
      <div class="hv-meta"><span class="pill-${a.status}"></span><span class="hv-kind"></span><span class="hv-stats"></span></div>
      <details><summary>Its job (what it was asked)</summary><div class="hv-prompt"></div></details>
      <h4>Steps</h4><ul class="hv-steps"></ul>
      <div class="hv-said" hidden><h4>What it says</h4><div class="hv-words md-said"></div></div>
      <div class="hv-rep" hidden><h4>Report</h4><div class="hv-words md-rep"></div></div>`;
    Icon.text(bodyEl.querySelector(`.pill-${a.status}`), status);
    bodyEl.querySelector('.hv-kind').textContent = `${a.kind || 'helper'}${a.background ? ' · in the background' : ''}`;
    bodyEl.querySelector('.hv-stats').textContent = helperMeta(a);
    bodyEl.querySelector('.hv-prompt').textContent = a.prompt || '(not shared)';
    if (open) bodyEl.querySelector('details').open = true;
    const steps = bodyEl.querySelector('.hv-steps');
    if (!a.steps.length) steps.innerHTML = `<li class="hv-empty">${a.status === 'running' ? (a.activity ? '' : 'Getting started…') : 'No steps reported.'}</li>`;
    if (!a.steps.length && a.status === 'running' && a.activity) steps.querySelector('.hv-empty').textContent = a.activity;
    a.steps.forEach((s, i) => {
      const li = document.createElement('li');
      if (a.status === 'running' && i === a.steps.length - 1) li.className = 'now';
      li.innerHTML = '<span class="st"></span><span class="sw"></span>';
      Icon.text(li.querySelector('.st'), stepLabel(s));
      li.querySelector('.st').title = stepLabel(s);
      li.querySelector('.sw').textContent = `+${Math.max(0, Math.round((s.at - a.started) / 1000))}s`;
      steps.appendChild(li);
    });
    const report = a.report || a.summary || '';
    if (a.text && a.text.trim() !== report.trim()) {
      bodyEl.querySelector('.hv-said').hidden = false;
      bodyEl.querySelector('.md-said').innerHTML = md(a.text);
    }
    if (report) {
      bodyEl.querySelector('.hv-rep').hidden = false;
      bodyEl.querySelector('.md-rep').innerHTML = md(report);
    }
    if (top) bodyEl.scrollTop = 0;
    else if (nearBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  // ------------------------------------------------------------ brain: model, effort, memory

  const brainInfo = { models: [] };
  const FALLBACK_MODELS = [
    { value: '', displayName: 'Default', description: "Claude Code's recommended model" },
    { value: 'opus', displayName: 'Opus', description: 'For complex work' },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Balanced' },
    { value: 'haiku', displayName: 'Haiku', description: 'Fastest for quick answers' },
  ];
  const EFFORTS = {
    low: ['☕', 'Taking it easy'],
    medium: ['🙂', 'Normal focus'],
    high: ['💪', 'Thinking harder'],
    xhigh: ['🔥', 'Full focus'],
    max: ['🤯', 'MAXIMUM BRAINPOWER'],
  };
  const EFFORT_ICONS = { low: 'signal-low', medium: 'signal-medium', high: 'signal-high', xhigh: 'signal', max: 'rocket' };
  const models = () => (brainInfo.models.length ? brainInfo.models : FALLBACK_MODELS);
  const modelName = (v) => (models().find((m) => m.value === (v || '')) || { displayName: v || 'Default' }).displayName.replace(/\s*\(recommended\)/i, '');

  async function loadBrain(tab) {
    const info = await cbot.invoke('robot:brain', tab.id);
    if (!info) return;
    if (info.models?.length) brainInfo.models = info.models;
    tab.model = info.model;
    tab.effort = info.effort;
    if (info.context) tab.context = info.context;
    if (tab === active()) renderBrain();
  }

  function renderBrain() {
    const t = active();
    if (!t) return;
    // (mono readouts: an icon, the value, a caret)
    $('#brain-model').innerHTML = `${Icon('cpu')}<span></span><span class="caret">▼</span>`;
    $('#brain-model').children[1].textContent = modelName(t.model);
    $('#brain-effort').innerHTML = `${Icon('zap')}<span>${t.effort || 'auto'}</span><span class="caret">▼</span>`;
    const meter = $('#brain-meter');
    const ctx = t.context;
    const pct = ctx ? Math.max(0, Math.min(100, ctx.percentage)) : null;
    meter.querySelector('.bm-bar i').style.width = `${pct ?? 0}%`;
    meter.querySelector('.bm-pct').textContent = pct === null ? '–' : `${pct}%`;
    meter.classList.toggle('warm', pct >= 60 && pct < 80);
    meter.classList.toggle('full', pct >= 80);
    meter.title = ctx
      ? `Memory: ${Math.round(ctx.totalTokens / 1000)}k of ${Math.round(ctx.maxTokens / 1000)}k tokens${ctx.autoCompact ? ` · auto-squishes near ${Math.round((ctx.autoCompactAt / ctx.maxTokens) * 100)}%` : ''}\nClick for options`
      : 'Memory: ask me something first';
    // the 3D robot shows its brain: eye colour per model, a headband at high effort, steam when full
    robot.dataset.model = t.model || 'default';
    robot.dataset.effort = t.effort || '';
    robot.dataset.brain = pct >= 80 ? 'full' : '';
    if (pct >= 80 && !t.warnedFull && t === active()) {
      t.warnedFull = true;
      showPop('My head is getting full… /compact?', 3000);
    }
    if (pct < 60) t.warnedFull = false;
  }

  const menuEl = $('#menu');
  function openMenu(anchor, title, items, onPick) {
    menuEl.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'menu-title';
    h.textContent = title;
    menuEl.appendChild(h);
    for (const it of items) {
      const el = document.createElement('div');
      el.className = `menu-item${it.on ? ' on' : ''}${it.icon ? ' has-icon' : ''}`;
      el.setAttribute('role', 'menuitem');
      el.innerHTML = `${it.icon ? Icon(it.icon) : ''}<b></b><small></small>`;
      el.querySelector('b').textContent = it.label;
      el.querySelector('small').textContent = it.desc || '';
      el.addEventListener('click', () => {
        closeMenu();
        onPick(it.value);
      });
      menuEl.appendChild(el);
    }
    menuEl.hidden = false;
    const a = anchor.getBoundingClientRect();
    const box = $('#panel').getBoundingClientRect();
    menuEl.style.left = `${Math.min(a.left - box.left, box.width - menuEl.offsetWidth - 10)}px`;
    menuEl.style.top = `${a.top - box.top - menuEl.offsetHeight - 6}px`;
  }
  function closeMenu() {
    menuEl.hidden = true;
  }
  document.addEventListener('mousedown', (e) => {
    if (!menuEl.hidden && !menuEl.contains(e.target) && !e.target.closest('#brainbar')) closeMenu();
  });

  function openModelMenu() {
    const t = active();
    openMenu($('#brain-model'), 'Brain (model) for this tab', models().map((m) => ({ label: m.displayName, desc: m.description, value: m.value, on: (t.model || '') === m.value })), (v) => setBrain(t, { model: v }));
  }
  function openEffortMenu() {
    const t = active();
    const allowed = models().find((m) => m.value === (t.model || ''))?.efforts;
    const levels = Object.keys(EFFORTS).filter((l) => !allowed?.length || allowed.includes(l));
    openMenu($('#brain-effort'), 'How hard I think (effort)', [
      { icon: 'zap', label: 'auto', desc: "Claude Code's default", value: '', on: !t.effort },
      ...levels.map((l) => ({ icon: EFFORT_ICONS[l], label: l, desc: EFFORTS[l][1], value: l, on: t.effort === l })),
    ], (v) => setBrain(t, { effort: v }));
  }
  function openMemoryMenu() {
    const t = active();
    openMenu($('#brain-meter'), 'Memory (context)', [
      { icon: 'collapse', label: 'Compact now', desc: 'Squish the conversation into a summary to free up room', value: 'compact' },
      { icon: 'gauge', label: 'What’s in my head?', desc: 'How full my memory is', value: 'context' },
    ], (v) => (v === 'compact' ? compactTab(t) : showContext(t)));
  }
  $('#brain-model').addEventListener('click', openModelMenu);
  $('#brain-effort').addEventListener('click', openEffortMenu);
  $('#brain-meter').addEventListener('click', openMemoryMenu);

  function pickModel(arg) {
    const q = arg.toLowerCase();
    const m = models().find((x) => x.value === q || x.displayName.toLowerCase().startsWith(q) || (q === 'default' && !x.value));
    if (m) setBrain(active(), { model: m.value });
    else addNote(`🧠 I don't know a model called “${arg}”. Try: ${models().map((x) => x.value || 'default').join(', ')}`);
  }
  function pickEffort(arg) {
    const l = arg.toLowerCase();
    if (l === 'auto' || EFFORTS[l]) setBrain(active(), { effort: l === 'auto' ? '' : l });
    else addNote(`⚡ Effort can be: auto, ${Object.keys(EFFORTS).join(', ')}`);
  }

  // Swap the brain mid-chat: the robot spins, its monitor reboots and its eyes change colour.
  async function setBrain(tab, patch) {
    const res = await cbot.invoke('robot:set-brain', tab.id, patch);
    if (!res.ok) {
      addNote(`🧠 Couldn't switch: ${res.error || 'unknown problem'}`, '', tab);
      return;
    }
    Object.assign(tab, patch);
    if (tab === active()) renderBrain();
    if ('model' in patch) {
      addNote(`🧠 Brain swapped to ${modelName(patch.model)} for this tab`, '', tab);
      flash('spin', 950);
      Sfx.swap();
      if (!state.busy) setActivity('boot', 900);
      showPop(`🧠 ${modelName(patch.model)} installed!`, 2000);
    }
    if ('effort' in patch) {
      const [emoji, words] = EFFORTS[patch.effort] || ['⚡', 'Back to auto'];
      addNote(`${emoji} Effort: ${patch.effort || 'auto'}`, '', tab);
      flash(patch.effort === 'max' || patch.effort === 'xhigh' ? 'shake' : 'hop', 600);
      Sfx.swap();
      showPop(`${emoji} ${words}!`, 1800);
    }
  }

  // /compact: the robot squishes its papers into a cube on the monitor.
  async function compactTab(tab) {
    if (!tab) return;
    if (tab.busy) {
      showPop('Let me finish this first!', 1800);
      return;
    }
    const turnId = uid();
    startCompact(tab);
    const res = await cbot.invoke('robot:compact', tab.id, turnId);
    if (!res.ok) finishCompact(tab, res.error);
  }

  function startCompact(tab) {
    if (tab.compacting) return;
    tab.compacting = true;
    tab.compactResult = null;
    if (!tab.busy) setBusy(tab, true);
    addNote('🗜️ Squishing my memory…', '', tab);
    setTabStatus(tab, 'Compacting my memory…');
    tab.activity = 'compact';
    if (animates(tab)) {
      setActivity('compact');
      Sfx.crunch();
    }
  }

  function finishCompact(tab, error) {
    if (!tab.compacting) return;
    tab.compacting = false;
    setBusy(tab, false);
    if (error) {
      addNote(`🗜️ Couldn't compact: ${error}`, '', tab);
      return;
    }
    const r = tab.compactResult;
    addNote(r?.pre ? `🗜️ Compacted my memory: ${Math.round(r.pre / 1000)}k → ${Math.round(r.post / 1000)}k tokens` : '🗜️ Compacted my memory', '', tab);
    if (animates(tab)) {
      setActivity('done', 2000);
      flash('squish', 500);
      express('happy', 'smile', 1500);
      Sfx.done();
      showPop('Ahh, much lighter!', 2000);
    }
  }

  async function showContext(tab) {
    const info = await cbot.invoke('robot:brain', tab.id);
    const c = info?.context;
    if (!c) {
      addNote('📊 My memory is empty so far. Ask me something first!', '', tab);
      return;
    }
    tab.context = c;
    renderBrain();
    addBot(
      `**📊 My memory:** ${Math.round(c.totalTokens / 1000)}k of ${Math.round(c.maxTokens / 1000)}k tokens (${c.percentage}%)` +
        (c.autoCompact ? `\n\nI'll squish it myself near ${Math.round((c.autoCompactAt / c.maxTokens) * 100)}%, or say \`/compact\` to do it now.` : ''),
      { tab }
    );
  }

  // ------------------------------------------------------------ tabs

  // Bring the renderer's tabs in line with the main process's list.
  function syncTabs(c) {
    const seen = new Set();
    for (const t of c.tabs) {
      seen.add(t.id);
      const key = `${t.sessionId}|${t.history.length}|${t.history[t.history.length - 1]?.at || ''}`;
      let tab = tabs.get(t.id);
      if (!tab) {
        const el = document.createElement('div');
        el.className = 'log';
        el.setAttribute('role', 'log');
        el.setAttribute('aria-live', 'polite');
        el.hidden = true;
        logs.appendChild(el);
        tab = { id: t.id, log: el, busy: false, current: null, question: null, statusText: '', status: 'idle', activity: 'idle', draft: '', queue: [] };
        tabs.set(t.id, tab);
        tab.data = t;
        renderHistory(tab);
        if (t.busy) {
          // it was already working when this window (re)loaded: keep listening
          addNote('(still working on this one…)', '', tab);
          startReply(tab);
          setBusy(tab, true);
        }
      } else {
        const hadHistory = tab.data.history.length;
        tab.data = t;
        if (!tab.busy && key !== tab.key) {
          if (!t.history.length && hadHistory) {
            tab.log.innerHTML = '';
            addNote('✨ Fresh start! My memory is squeaky clean.', '', tab);
            if (tab.id === activeId) flash('spin', 850);
          } else renderHistory(tab);
        }
      }
      tab.key = key;
      tab.title = t.title;
      tab.custom = t.custom;
      tab.tasks = t.tasks || [];
      if (t.context) tab.context = t.context;
      if ('model' in t) tab.model = t.model;
      if ('effort' in t) tab.effort = t.effort;
    }
    for (const [id, tab] of tabs) {
      if (seen.has(id)) continue;
      clearInterval(tab.verbs);
      tab.log.remove();
      tabs.delete(id);
    }
    // follow the main process when it switches tabs (new tab, resume, close)
    if (c.activeTab !== lastMainActive || !tabs.has(activeId)) {
      lastMainActive = c.activeTab;
      activateTab(tabs.has(c.activeTab) ? c.activeTab : c.tabs[0].id, { quiet: true });
    }
    renderTabs();
  }

  function activateTab(id, { quiet = false } = {}) {
    const next = tabs.get(id);
    if (!next) return;
    const prev = active();
    if (prev && prev !== next) prev.draft = input.value; // each tab keeps its half-typed message
    activeId = id;
    for (const t of tabs.values()) t.log.hidden = t !== next;
    if (next.status === 'done' || next.status === 'error') next.status = 'idle'; // read it
    if (prev !== next) {
      input.value = next.draft || '';
      autosize();
      hidePalette();
      if (!quiet) cbot.invoke('robot:tab-activate', id);
    }
    syncChrome();
    renderTabs();
    renderTodo();
    renderHelpers();
    if ((helperView.id || helperView.call) && helperView.tab !== next) closeHelper();
    renderBrain();
    loadBrain(next);
    scrollDown(next);
    // the robot shows what the visible tab is up to
    if (next.busy) setActivity(next.question && !next.question.sent ? 'ask' : next.activity || 'think');
    else if (!state.busy && !state.mirroring) setActivity(restingActivity());
  }

  const statusOf = (t) => {
    if (t.terminal) return 'terminal';
    if (t.question && !t.question.sent) return 'question';
    if (t.busy) return 'busy';
    if (helpersOut(t)) return 'helpers';
    return t.status;
  };
  const STATUS_LABEL = { helpers: 'helpers still working…', busy: 'working…', question: 'has a question for you', done: 'finished', error: 'hit a snag', terminal: 'open in the terminal', idle: '' };

  function renderTabs() {
    if (!state.character) return;
    robot.dataset.helpers = String(helpersOut()); // the little bots circling the desk
    tabStrip.innerHTML = '';
    for (const { id } of state.character.tabs) {
      const t = tabs.get(id);
      if (!t) continue;
      const s = statusOf(t);
      const el = document.createElement('div');
      el.className = `tab s-${s}${t.id === activeId ? ' on' : ''}`;
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', String(t.id === activeId));
      el.title = `${t.title}${STATUS_LABEL[s] ? ` (${STATUS_LABEL[s]})` : ''}\nDouble-click to rename`;
      el.innerHTML = '<span class="tab-dot"></span><span class="tab-title"></span><button class="tab-x" type="button" title="Close tab (Ctrl+W)">×</button>';
      el.querySelector('.tab-title').textContent = t.title;
      el.addEventListener('click', (e) => {
        if (!e.target.closest('.tab-x') && t.id !== activeId) activateTab(t.id);
      });
      el.addEventListener('dblclick', (e) => {
        if (!e.target.closest('.tab-x')) renameTab(t.id, el.querySelector('.tab-title'));
      });
      el.addEventListener('auxclick', (e) => e.button === 1 && closeTab(t.id)); // middle-click closes
      el.querySelector('.tab-x').addEventListener('click', () => closeTab(t.id));
      tabStrip.appendChild(el);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'tab-add';
    add.textContent = '+';
    add.title = 'New conversation in a new tab (Ctrl+T)';
    add.disabled = tabs.size >= 8;
    add.addEventListener('click', () => newTab());
    tabStrip.appendChild(add);
    const closed = state.character.closedTabs || [];
    if (closed.length) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'tab-add tab-reopen';
      back.textContent = '↺';
      back.title = `Reopen closed tab: “${closed[closed.length - 1].title}” (Ctrl+Shift+T)${closed.length > 1 ? `\n${closed.length} closed tabs can come back` : ''}`;
      back.addEventListener('click', () => reopenTab());
      tabStrip.appendChild(back);
    }
    tabStrip.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  async function newTab() {
    openChat(); // asking something else mid-task needs the chat
    const res = await cbot.invoke('robot:tab-new');
    if (!res.ok) {
      showPop(res.error, 2200);
      return;
    }
    flash('hop', 600);
    Sfx.send();
    setActivity('boot', 800); // fresh page on the monitor
    input.focus();
  }

  async function closeTab(id) {
    const t = tabs.get(id);
    if (!t) return;
    if (t.busy && !confirm(`“${t.title}” is still working. Stop it and close the tab?`)) return;
    const hadChat = !!(t.data?.history?.length || t.data?.sessionId);
    const res = await cbot.invoke('robot:tab-close', id);
    if (!res.ok) return addNote(`📑 ${res.error}`, '', t);
    if (hadChat) offerUndo(`“${t.title}” closed`);
  }

  // Closing a tab (× or Ctrl+W) can be taken back: Undo for a few seconds, then ↺ / Ctrl+Shift+T.
  const undoBar = document.createElement('div');
  undoBar.id = 'undo';
  undoBar.hidden = true;
  undoBar.innerHTML = '<span></span><button type="button">Undo</button>';
  $('#panel').appendChild(undoBar);
  undoBar.querySelector('button').addEventListener('click', () => {
    undoBar.hidden = true;
    reopenTab();
  });
  function offerUndo(text) {
    undoBar.querySelector('span').textContent = text;
    undoBar.hidden = false;
    clearTimeout(offerUndo.t);
    offerUndo.t = setTimeout(() => (undoBar.hidden = true), 8000);
  }

  async function reopenTab() {
    const res = await cbot.invoke('robot:tab-reopen');
    if (!res.ok) return showPop(res.error, 2200);
    flash('hop', 600);
    Sfx.send();
    showPop(`“${res.title}” is back!`, 1800);
  }

  function renameTab(id, titleEl) {
    const t = tabs.get(id);
    if (!t || titleEl.querySelector('input')) return;
    const field = document.createElement('input');
    field.value = t.title;
    titleEl.textContent = '';
    titleEl.appendChild(field);
    field.focus();
    field.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save && field.value.trim() && field.value.trim() !== t.title) cbot.invoke('robot:tab-rename', id, field.value.trim());
      else renderTabs();
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    });
    field.addEventListener('blur', () => finish(true));
  }

  // Ctrl+T new · Ctrl+W close · Ctrl+Tab / Ctrl+Shift+Tab switch · Ctrl+1…8 jump
  document.addEventListener('keydown', (e) => {
    if (!state.awake || !e.ctrlKey || e.altKey) return;
    const order = state.character.tabs.map((t) => t.id).filter((id) => tabs.has(id));
    const i = order.indexOf(activeId);
    if ((e.key === 't' || e.key === 'T') && e.shiftKey) reopenTab();
    else if (e.key === 't' || e.key === 'T') newTab();
    else if (e.key === 'w' || e.key === 'W') closeTab(activeId);
    else if (e.key === 'Tab') activateTab(order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length]);
    else if (/^[1-8]$/.test(e.key) && order[Number(e.key) - 1]) activateTab(order[Number(e.key) - 1]);
    else return;
    e.preventDefault();
  });

  // ------------------------------------------------------------ slash commands

  // Handled right here in the app. Anything else starting with "/" goes to
  // Claude Code as-is, so its own commands and skills work too.
  const LOCAL_COMMANDS = [
    { name: 'resume', args: '[search]', description: 'Pick up a past conversation' },
    { name: 'history', description: 'Browse past conversations' },
    { name: 'new', description: 'Start another conversation in a new tab' },
    { name: 'clear', description: 'Wipe this tab and start over' },
    { name: 'close', description: 'Close this tab' },
    { name: 'model', args: '[name]', description: 'Switch my brain (model) for this tab' },
    { name: 'effort', args: '[low…max]', description: 'How hard I think' },
    { name: 'compact', description: 'Squish my memory to free up room' },
    { name: 'context', description: 'How full my memory is' },
    { name: 'terminal', description: 'Continue in full Claude Code, in a terminal' },
    { name: 'folder', description: 'Open my folder' },
    { name: 'refine', args: '[text]', description: 'Refine, translate or explain some text (Quick actions)' },
    { name: 'screen', description: 'Drag a box round part of the screen and ask about it' },
    { name: 'note', args: '<text>', description: 'Jot a note down (it goes on my corkboard)' },
    { name: 'notes', description: 'Open my notebook' },
    { name: 'sleep', description: 'Send me to bed' },
    { name: 'help', description: 'What I can do' },
  ];
  const paletteEl = $('#palette');
  let paletteItems = [];
  let paletteIndex = 0;

  function helpText() {
    const lines = LOCAL_COMMANDS.map((c) => `- \`/${c.name}${c.args ? ' ' + c.args : ''}\` ${c.description.toLowerCase()}`);
    return [
      '**Tricks I know**',
      ...lines,
      '- any other `/command` (like your skills) goes straight to Claude Code',
      '',
      'Tabs: ＋ or Ctrl+T for a new one, Ctrl+Tab to switch, Ctrl+W to close (↺ or Ctrl+Shift+T brings it back), double-click a tab to rename it.',
      'Drag me anywhere, click me for a poke, right-click for options. Esc sends me to sleep.',
    ].join('\n');
  }

  function runLocalCommand(text) {
    const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
    if (!m) return false;
    const arg = m[2].trim();
    switch (m[1].toLowerCase()) {
      case 'new':
      case 'tab':
        newTab();
        return true;
      case 'clear':
      case 'reset':
        cbot.invoke('robot:reset', activeId);
        return true;
      case 'close':
        closeTab(activeId);
        return true;
      case 'resume':
      case 'history':
      case 'conversations':
        openHistory(arg);
        return true;
      case 'terminal':
      case 'cli':
        openTerminal();
        return true;
      case 'model':
        if (arg) pickModel(arg);
        else openModelMenu();
        return true;
      case 'effort':
        if (arg) pickEffort(arg);
        else openEffortMenu();
        return true;
      case 'compact':
        compactTab(active());
        return true;
      case 'context':
        showContext(active());
        return true;
      case 'folder':
        cbot.invoke('robot:open-folder');
        return true;
      case 'screen':
      case 'snip':
        cbot.invoke('robot:screen-ask');
        return true;
      case 'refine':
      case 'quick':
        cbot.invoke('quick:open-blank', { text: arg });
        return true;
      case 'note':
        if (!arg) cbot.invoke('notes:open', { focus: 'add' });
        else cbot.invoke('notes:add', arg).then((n) => n && addNote(`📝 Noted: ${n.text}${n.important ? ' (important)' : ''}`));
        return true;
      case 'notes':
        cbot.invoke('notes:open', { focus: null });
        return true;
      case 'sleep':
        sleep();
        return true;
      case 'help':
        addBot(helpText());
        return true;
      default:
        return false;
    }
  }

  function updatePalette() {
    // "@" before the caret: files in the robot's folder (quoted for paths with spaces)
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const at = before.match(/(?:^|\s)@"([^"\n]*)$/) || before.match(/(?:^|\s)@([^\s"@]*)$/);
    if (at) return updateMentions(at[1], before.lastIndexOf('@'));
    mentionSeq++;
    const m = input.value.match(/^\/(\S*)$/);
    if (!m) return hidePalette();
    const q = m[1].toLowerCase();
    const local = LOCAL_COMMANDS.filter((c) => c.name.startsWith(q)).map((c) => ({ ...c, kind: 'local' }));
    const taken = new Set(LOCAL_COMMANDS.map((c) => c.name));
    const claude = (state.claudeCommands || [])
      .filter((c) => !taken.has(c.name) && c.name.toLowerCase().includes(q))
      .slice(0, 40)
      .map((c) => ({ ...c, kind: 'claude' }));
    paletteItems = [...local, ...claude];
    if (!paletteItems.length) return hidePalette();
    paletteIndex = Math.min(paletteIndex, paletteItems.length - 1);
    paletteEl.innerHTML = '';
    let group = null;
    paletteItems.forEach((item, i) => {
      if (item.kind !== group) {
        group = item.kind;
        const g = document.createElement('div');
        g.className = 'p-group';
        g.textContent = group === 'local' ? state.character?.name || 'Robot' : 'Claude Code';
        paletteEl.appendChild(g);
      }
      const row = document.createElement('div');
      row.className = `p-item${i === paletteIndex ? ' on' : ''}`;
      row.setAttribute('role', 'option');
      row.innerHTML = '<span class="p-name"></span><span class="p-desc"></span>';
      row.querySelector('.p-name').textContent = `/${item.name}`;
      if (item.args) {
        const a = document.createElement('span');
        a.className = 'p-args';
        a.textContent = ` ${item.args}`;
        row.querySelector('.p-name').appendChild(a);
      }
      row.querySelector('.p-desc').textContent = item.description || '';
      row.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus in the input
        choose(item, true);
      });
      paletteEl.appendChild(row);
    });
    paletteEl.hidden = false;
    paletteEl.querySelector('.p-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  function hidePalette() {
    paletteEl.hidden = true;
    paletteIndex = 0;
  }

  // ------------------------------------------------------------ @-mentions

  let mentionSeq = 0;
  let mentionStart = 0;
  async function updateMentions(query, start) {
    const seq = ++mentionSeq;
    const items = await cbot.invoke('robot:files', query);
    if (seq !== mentionSeq) return; // typed on since
    mentionStart = start;
    paletteItems = items.map((e) => ({ ...e, kind: 'file' }));
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
    paletteEl.innerHTML = '';
    const g = document.createElement('div');
    g.className = 'p-group';
    Icon.text(g, `📁 ${folderName()}`);
    paletteEl.appendChild(g);
    if (!paletteItems.length) {
      const none = document.createElement('div');
      none.className = 'p-empty';
      none.textContent = query ? `No files match “${query}”` : 'This folder looks empty';
      paletteEl.appendChild(none);
    }
    paletteItems.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = `p-item p-file${i === paletteIndex ? ' on' : ''}`;
      row.setAttribute('role', 'option');
      row.innerHTML = '<span class="p-icon"></span><span class="p-name"></span><span class="p-desc"></span>';
      const slash = item.rel.lastIndexOf('/');
      row.querySelector('.p-icon').innerHTML = Icon(item.dir ? 'folder' : 'file', 'sm');
      row.querySelector('.p-name').textContent = item.rel.slice(slash + 1) + (item.dir ? '/' : '');
      row.querySelector('.p-desc').textContent = slash > 0 ? item.rel.slice(0, slash) : '';
      row.title = item.rel;
      row.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus in the input
        insertMention(item);
      });
      paletteEl.appendChild(row);
    });
    paletteEl.hidden = false;
    paletteEl.querySelector('.p-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  // put "@path" in place of what was typed after @; a folder stays open to pick inside it
  function insertMention(item) {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, mentionStart);
    const after = input.value.slice(caret).replace(/^[^\s"]*"?/, ''); // the rest of the half-typed path
    const rel = item.rel + (item.dir ? '/' : '');
    const spaced = /\s/.test(rel);
    const token = spaced ? `@"${rel}${item.dir ? '' : '"'}` : `@${rel}`;
    const tail = item.dir ? '' : ' ';
    input.value = before + token + tail + after;
    const pos = (before + token + tail).length;
    input.setSelectionRange(pos, pos);
    paletteIndex = 0;
    autosize();
    input.focus();
    if (item.dir) updatePalette();
    else hidePalette();
  }

  // run = Enter/click: our own commands run straight away; Claude Code ones are completed so you can add arguments
  function choose(item, run) {
    if (item.kind === 'file') return insertMention(item);
    if (run && item.kind === 'local') {
      input.value = `/${item.name}`;
      submit();
      return;
    }
    input.value = `/${item.name} `;
    autosize();
    hidePalette();
    input.focus();
  }

  function paletteKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = paletteItems.length;
      if (!n) return true;
      paletteIndex = (paletteIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      updatePalette();
      return true;
    }
    if (!paletteItems.length) return false; // "no files match": Enter sends as usual
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      choose(paletteItems[paletteIndex], e.key === 'Enter');
      return true;
    }
    return false;
  }

  async function refreshCommands() {
    state.claudeCommands = await cbot.invoke('robot:commands');
  }

  // ------------------------------------------------------------ past conversations

  const history = window.HistoryView({
    md,
    robotName: () => state.character?.name || 'me',
    activeTabId: () => activeId,
    onResumed: (res) => {
      const tab = tabs.get(res.tabId) || active();
      activateTab(tab.id);
      if (res.already) {
        addNote('↩ That conversation is already open here.', 'resumed', tab);
        return;
      }
      const more = res.total > 30 ? ` (showing the latest of ${res.total} messages)` : '';
      addNote(`↩ Picked up “${res.title}”${more}. Carry on!`, 'resumed', tab);
      Sfx.key.wake();
      flash('spin', 950);
      setActivity('read', 1600); // flick through the old notes
      input.focus();
    },
    onClose: () => input.focus(),
  });

  function openHistory(query = '') {
    if (!state.awake) wake();
    else openChat();
    hidePalette();
    history.open(query);
  }

  // ------------------------------------------------------------ ambient life

  function blinkLoop() {
    if (state.awake || state.busy) flash('blink', 170);
    setTimeout(blinkLoop, rand(2200, 6000));
  }

  // ------------------------------------------------------------ idle antics

  // Little things it gets up to when nobody's asking it anything: sipping
  // coffee, sneezing, snot bubbles in its sleep… The 3D view plays them
  // (office3d/antics/); their lengths and the moments cued below are mirrored
  // from there, so the sounds and words land on time.
  const ANTIC_SEC = {
    sip: 3.4, 'sip-empty': 3.8, tip: 3.2, toss: 2.8, 'toss-hit': 2.8, hum: 4.5, sneeze: 2.2, lamp: 2.8,
    drum: 2.6, slump: 2.8, dvd: 9, 'dvd-lucky': 9, feed: 9.6, standdesk: 21, milktea: 5.6, dumbbell: 6, phone: 7, sleepphone: 8, pushup: 10,
    dictionary: 30, 'word-show': 4.2, 'quiz-card': 120, 'word-glance': 7, 'robot-antenna': 2.4, 'robot-defrag': 1.8,
    bubble: 5.2, mumble: 3.6, dream: 6.5, sleeptype: 4.2, slide: 6.5, snore: 2.4, drift: 10, drool: 2.6,
    // IT office life
    duck: 6, reboot: 7, stackoverflow: 5, cable: 4.5, crumbs: 5, 'crumbs-cookie': 5, merge: 6, standup: 7, jira: 5.5, works: 5, jitter: 6.5,
    friday: 4.5, monday: 6, noodles: 7, payday: 6, eyebreak: 6, bsod: 4.2,
    // more sleep
    nightmare: 6.5, snorebar: 9, ping: 5, vacuum: 9, burrito: 8,
    // your notes and the corkboard (office3d/antics/notes.js)
    // the other robots (office3d/antics/social.js)
    'turn-to': 2.6, listen: 10, 'clap-at': 2.2, 'plane-throw': 1.8, 'plane-catch': 2.6, 'plane-read': 2.6, 'feet-up': 4.6,
    notewrite: 30, notepin: 2.4, notetoss: 2.8, boardlift: 3.4, boardglance: 2.6, allclear: 1.8, clockout: 2.6,
    // wandering off round the screen and being brought back
    stepout: 4, stepin: 1.4,
  };
  const CRITTER_ANTICS = { kit: ['robot-antenna', 'robot-defrag'] };
  const DREAMS = { kit: ['🔋', '⚙️', '💾'], loopy: ['🪵', '🌲', '🥕'], cat: ['🐟', '🧶', '🐭'], nerd: ['🍕', '💾', '🎮'], girl: ['🧋', '🐱', '🌸'], robot: ['🔋', '⚙️', '💾'] };
  const quip = (k) => persona().quips?.[k];
  // what lights up its phone at 3 am
  const PINGS = ['Boss: quick question?', 'PROD ALERT 🔥', 'Can you hop on a call?', 'Is the site down??', '@channel standup moved to 7am'];
  let anticSeq = 0;
  let anticUntil = 0;
  let lastAntic = '';

  function antic(name, text = '') {
    robot.dataset.antic = name;
    robot.dataset.anticText = text;
    robot.dataset.anticSeq = String(++anticSeq);
    anticUntil = Date.now() + (ANTIC_SEC[name] || 3) * 1000;
    lastAntic = name;
  }
  // something more important came up: the 3D view drops whatever it was playing
  function stopAntic() {
    state.slacking = 0;
    // stopped getting up to leave (a click, a task): the walker that was getting ready goes
    if (state.leaving && !state.away) {
      state.leaving = false;
      cbot.send('robot:walker', 'cancel');
    }
    if (!robot.dataset.antic) return;
    robot.dataset.antic = '';
    robot.dataset.anticSeq = String(++anticSeq);
    anticUntil = 0;
  }
  // do this `sec` seconds into the antic, if it's still the one playing
  function cue(sec, fn) {
    const seq = anticSeq;
    setTimeout(() => seq === anticSeq && robot.dataset.antic && fn(), sec * 1000);
  }
  // a weighted pick that won't play the same thing twice in a row
  function pickAntic(weights) {
    const options = Object.entries(weights).filter(([k, w]) => w > 0 && k !== lastAntic);
    let r = Math.random() * options.reduce((n, [, w]) => n + w, 0);
    for (const [k, w] of options) if ((r -= w) < 0) return k;
    return options[0]?.[0];
  }

  const idleAwake = () => state.awake && !state.busy && !helpersOut() && !state.mirroring && !press && !state.away;
  const idleAsleep = () => !state.awake && !state.busy && !helpersOut() && !state.mirroring && !press && !state.away;

  // after 10 pm it sleeps in a nightcap, or, still up, codes with its hood up in the monitor's glow
  function nightcap() {
    const h = new Date().getHours();
    const late = h >= 22 || h < 6;
    robot.dataset.nightcap = idleAsleep() && late ? '1' : '';
    robot.dataset.lateNight = state.awake && late ? '1' : '';
  }

  // ---- wandering off
  // Now and then it gets up and goes for a walk round the screen (asleep, it
  // sleepwalks), in a little window of its own; the desk stands empty with a BRB
  // note. To use it again, drag it back onto its desk (main.js / walker.js dock it).
  const wanders = () => state.character?.wanders !== false; // the Workshop's "Wanders off"
  const AWAY_NOTE = '🚶 Out for a walk: drag me back to my desk!';

  function leaveDesk() {
    if (state.away || state.busy || helpersOut() || state.mirroring) return;
    if (state.hosting && !state.visiting) return; // (a visitor's at its desk: it stays put)
    stopAntic();
    if (state.awake) collapse(); // the chat tucks away: it can't chat from out there
    antic('stepout');
    // the walker window loads (hidden) while it gets up...
    state.leaving = true;
    cbot.invoke('robot:wander-prep', { asleep: !state.awake });
    // ...and once it's up and turned, takes over with its feet on this very spot ('handoff'
    // below) and walks it off from there
    cue(0.7, () => {
      cbot.invoke('robot:wander', { asleep: !state.awake, feet: office.feetPosition() }).then((ok) => ok || stopAntic());
    });
    cue(3.8, () => state.away || stopAntic()); // (no walker came: it sits back down)
  }

  // the walker window has it now: the desk lets go of its own
  function goneWalking() {
    if (state.away) return;
    state.leaving = false;
    state.away = true;
    robot.dataset.away = '1';
    // (its status strip: out to lunch, visiting, or just out for a walk)
    const v = state.visiting;
    state.news = state.awayNews = v?.mode === 'lunch' ? `🍜 Out for lunch with ${v.host}` : v ? `🚶 Visiting ${v.host}` : AWAY_NOTE;
    renderWorking();
  }

  // dropped back on the desk (or called back from the tray): it hops into its chair
  function backToDesk({ quiet = false, feet = null } = {}) {
    if (!state.away) return;
    state.away = false;
    awayNote.classList.remove('show');
    robot.dataset.away = '';
    body.classList.remove('dock-target');
    if (state.news === AWAY_NOTE || state.news === state.awayNews) state.news = '';
    renderWorking();
    state.lastActivity = Date.now();
    if (quiet) return;
    // it stands where it was put down (if that's on the desk's floor), then goes to its chair
    const at = feet && office.floorAt(feet.x, feet.y);
    antic('stepin', at ? `${at.x.toFixed(3)},${at.z.toFixed(3)}` : '');
    // once it's drawn here, the walker window can go (no blink in between)
    requestAnimationFrame(() => requestAnimationFrame(() => cbot.send('robot:walker', 'docked')));
    cue(1.0, () => Sfx.boing());
    if (state.awake) {
      cue(1.1, () => {
        express('happy', 'smile', 1400);
        showPop(quip('back') || "I'm back!", 1800);
      });
    }
  }

  // ---- the group chat's meeting room (main groupChat.js / meeting.js)
  // It gets up from its chair and leaves (it rolls into the meeting room's window there); the
  // desk stands empty, drawn only now and then (office3d: data-meeting). When the chat's over
  // it's straight back in its chair, ready for work.
  const MEETING_NOTE = '👥 In the meeting room (group chat)';
  function toMeeting(tries = 0) {
    if (state.meeting) return;
    // (out for a walk: main's calling it back first)
    if (state.away || state.leaving) return void (tries < 24 && setTimeout(() => toMeeting(tries + 1), 500));
    state.meeting = true;
    stopAntic();
    const leave = () => {
      if (!state.meeting) return;
      stopAntic();
      state.away = true;
      robot.dataset.away = '1';
      robot.dataset.meeting = '1';
      state.news = state.awayNews = MEETING_NOTE;
      renderWorking();
    };
    // up out of the chair and turned to go, then gone (straight away if it's in the middle of work)
    if (state.busy || helpersOut() || state.mirroring) return leave();
    antic('stepout');
    setTimeout(leave, 900);
  }
  function fromMeeting() {
    if (!state.meeting) return;
    state.meeting = false;
    robot.dataset.meeting = '';
    stopAntic(); // (still getting up)
    if (state.away) {
      state.away = false;
      robot.dataset.away = '';
      awayNote.classList.remove('show');
      if (state.news === MEETING_NOTE) state.news = '';
      renderWorking();
    }
    state.lastActivity = Date.now();
  }

  // the empty desk was clicked: it waves from wherever it is
  const awayNote = $('#away-note');
  function awayClick() {
    const name = state.character?.name || 'Your robot';
    if (!state.meeting) cbot.send('robot:walker', 'wave');
    awayNote.textContent = state.meeting
      ? `👥 ${name} is in the meeting room for the group chat. It's back at its desk as soon as the chat ends.`
      : state.visiting?.mode === 'lunch'
      ? `🍜 ${name} is out for lunch with ${state.visiting.host}. Click ${name} to call it back, or drag it here.`
      : state.visiting
      ? `🚶 ${name} is visiting ${state.visiting.host}. Click ${name} to call it back, or drag it here.`
      : `🚶 ${name} is out for a walk. Drag ${name} back onto this desk to use it again.`;
    awayNote.classList.add('show');
    clearTimeout(awayClick.t);
    awayClick.t = setTimeout(() => awayNote.classList.remove('show'), 3200);
  }

  // Office-calendar gags: what the clock makes more likely right now
  function calendarWeights() {
    const now = new Date();
    const day = now.getDay();
    const h = now.getHours();
    return {
      friday: day === 5 && h >= 15 ? 2.5 : 0, // no deploys on a Friday afternoon
      monday: day === 1 && h < 12 ? 2 : 0, // Monday morning: coffee on a drip
      noodles: h === 12 ? 2.5 : 0, // lunch at the desk
      payday: now.getDate() === 25 ? 1.5 : 0,
    };
  }
  // and once an hour, in its first ten minutes, a stretch and a 20-20-20 eye break
  let eyeBreakHour = '';
  function eyeBreakDue() {
    const now = new Date();
    const key = `${now.toDateString()} ${now.getHours()}`;
    if (now.getMinutes() >= 10 || key === eyeBreakHour) return false;
    eyeBreakHour = key;
    return true;
  }

  // Double-clicking the monitor crashes the computer, and it knows it was you
  function crashMonitor() {
    if (!idleAwake()) return poke();
    stopAntic();
    antic('bsod');
    Sfx.key.crash();
    express('open', 'wide', 1100);
    cue(1.2, () => {
      express('flat', 'flat', 2800);
      showPop(quip('bsod') || 'You did this.', 2400);
    });
  }

  // Leaning back, hands behind its head… until your mouse comes near, when it
  // spins round to the monitor and types furiously, as if it was working all along.
  function slack() {
    const { dx, dy } = state.lastCursor;
    if (Math.hypot(dx, dy) < 260) return; // you're right there; it wouldn't dare
    strikePose('slack', 9000);
    state.slacking = Date.now() + 9000;
    anticUntil = state.slacking;
    lastAntic = 'slack';
  }
  function busted() {
    state.slacking = 0;
    state.pose = null;
    robot.dataset.hurry = '1';
    setActivity('edit', 2200);
    express('open', 'o', 2200);
    showPop(pick(quip('busted') || ['Working!']), 2000);
    setTimeout(() => {
      if (![...tabs.values()].some((t) => t.hurried)) robot.dataset.hurry = '';
    }, 2200);
  }

  // Awake and idle. The longer you leave it, the more it gets up to: first a
  // few small fidgets, then the bigger bits, then sighing, drumming and waving at you.
  function awakeAntic(boredFor) {
    const sec = boredFor / 1000;
    const crit = CRITTER_ANTICS[robot.dataset.body] || [];
    const name = pickAntic({
      look: 3, wave: 1.2, hop: 1, spin: 1, stretch: 1, smile: 1,
      sip: 2.2, 'sip-empty': 0.6, hum: 1.5, lamp: 0.4, tip: 1, milktea: 1.6, dumbbell: 1.2, phone: 1.3,
      pushup: sec > 20 ? 0.9 : 0, // gets down on the floor for a set of push-ups
      sneeze: sec > 30 ? 0.9 : 0, toss: sec > 30 ? 0.9 : 0, 'toss-hit': sec > 30 ? 0.35 : 0,
      dvd: sec > 40 ? 0.7 : 0, 'dvd-lucky': sec > 40 ? 0.15 : 0, slack: sec > 40 ? 0.9 : 0,
      feed: sec > 15 ? 1.3 : 0, // swivels round to the monitor and scrolls a social feed
      standdesk: sec > 20 ? 0.8 : 0, // presses the desk's ▲ and works standing up for a bit
      talk: sec > 25 ? 1.4 : 0, critter: crit.length ? 2 : 0,
      slump: sec > 90 ? 1.5 : 0, drum: sec > 90 ? 1.5 : 0, attention: sec > 120 ? 1.2 : 0,
      // IT office life
      duck: 1, stackoverflow: 0.9, cable: 0.6, crumbs: 0.6, 'crumbs-cookie': 0.25, jira: 0.8, works: 0.8,
      reboot: sec > 20 ? 0.8 : 0, merge: sec > 30 ? 0.7 : 0, jitter: sec > 30 ? 0.6 : 0, standup: sec > 40 ? 0.6 : 0,
      ...calendarWeights(),
      // bored for three minutes: off for a walk round the screen (not with its chat open: you may
      // be reading it, and walking off would tuck it away. Right-click → Go for a walk still works)
      wander: wanders() && sec > 180 && state.collapsed ? 1.5 : 0,
      'word-glance': sight.length ? 2 : 0, // one of your English words up on its monitor, read out
      boardglance: board.total ? 1.2 : 0, // a look over at the corkboard, a pin straightened, a look at you
      notestress: board.total >= 8 ? 0.8 : 0, // so… many… notes…
      dance: 0.7, highfive: 0.9, // a little dance party, or a high-five up at you
    });
    lastAntic = name;
    if (name === 'word-glance') return wordGlance();
    switch (name) {
      case 'dance':
      case 'highfive':
        playWith(name, { byUser: false });
        anticUntil = Date.now() + PLAY_MS[name];
        break;
      case 'boardglance':
        antic(name);
        cue(1.2, () => Sfx.tool());
        cue(1.6, () => {
          express('open', 'flat', 900);
          if (Math.random() < 0.5) showPop(quip('notesNudge') || 'Psst… your notes!', 1600);
        });
        break;
      case 'notestress':
        // a full board weighs on it
        antic('slump');
        express('dizzy', 'flat', 2200);
        cue(0.9, () => showPop(quip('notesStress') || 'So… many… notes…', 1800));
        break;
      case 'look':
        lookAt(rand(-300, 300), rand(-100, 100), 1100);
        setTimeout(() => lookAt(rand(-300, 300), rand(-100, 100), 900), 1100);
        break;
      case 'wave':
        strikePose('wave', 1500);
        break;
      case 'hop':
        flash('hop', 600);
        break;
      case 'spin':
        // spin around in the office chair
        flash('spin', 950);
        Sfx.whee();
        break;
      case 'stretch':
        // big stretch and a yawn
        strikePose('cheer', 1300);
        express('closed', 'o', 1300);
        break;
      case 'smile':
        express('happy', 'smile', 1200);
        break;
      case 'talk':
        // thinking out loud
        showPop(fill(pick(persona().bored || ['…'])), 2600);
        express('open', 'talk', 1200);
        break;
      case 'slack':
        slack();
        break;
      case 'attention':
        strikePose('wave', 2000);
        express('happy', 'wide', 2000);
        showPop(quip('attention') || 'Hey!', 2200);
        break;
      case 'critter': {
        const c = pick(crit);
        antic(c);
        if (c === 'robot-antenna') cue(0.6, () => Sfx.boing());
        if (c === 'robot-defrag') express('dizzy', 'flat', 1800);
        break;
      }
      case 'pushup':
        // timings match office3d/antics/pushup.js: hop down 0.45, reps from 1.3 every 1.1 s, hop back 8.9
        antic(name);
        cue(0.45, () => Sfx.boing());
        [1.3, 2.4, 3.5, 4.6, 5.7].forEach((at, i) => cue(at + (i === 4 ? 0.8 : 0.45), () => Sfx.grunt()));
        cue(5.7, () => express('flat', 'flat', 1600)); // the last one's a struggle
        cue(8.9, () => Sfx.boing());
        cue(9.1, () => {
          express('happy', 'wide', 1400);
          showPop(quip('flex') || 'Feel the burn! 💪', 1600);
        });
        break;
      case 'phone':
        // doom scrolling; timings match office3d/antics/phone.js
        antic(name);
        cue(0.4, () => Sfx.pop());
        for (let at = 0.9; at < 6; at += 0.8) cue(at, () => Sfx.tool()); // thumb flicks
        cue(3.4, () => {
          Sfx.giggle();
          express('happy', 'wide', 1300);
        });
        cue(6.3, () => Sfx.pop());
        break;
      case 'dumbbell':
        // three curls, the last a struggle, then a flex; timings match the antic in office3d/antics/awake.js
        antic(name);
        cue(0.15, () => Sfx.pop());
        cue(1.0, () => showPop('1!', 600));
        cue(1.8, () => showPop('2!', 600));
        cue(2.4, () => {
          express('closed', 'flat', 600);
          Sfx.grunt();
        });
        cue(2.9, () => {
          express('happy', 'wide', 700);
          showPop('…3!!', 700);
        });
        cue(4.0, () => {
          Sfx.done();
          express('happy', 'smile', 1300);
          showPop(quip('flex') || 'Gains!', 1500);
        });
        break;
      case 'feed':
        // scrolling a feed on the monitor; timings match office3d/feeds.js
        antic(name, pick(['facebook', 'tiktok', 'youtube']));
        cue(0.6, () => express('open', 'flat', 4000)); // the glazed scrolling stare
        for (const at of [1.0, 2.0, 3.0, 4.0, 7.0, 8.0]) cue(at, () => Sfx.wheel());
        cue(4.8, () => {
          Sfx.giggle();
          express('happy', 'wide', 1400);
        });
        cue(6.2, () => {
          Sfx.pop();
          express('happy', 'smile', 1200);
        });
        cue(7.4, () => express('open', 'flat', 1800));
        break;
      case 'milktea':
        drinkMilkTea();
        break;
      case 'standdesk':
        // timings match the antic in office3d/antics/awake.js
        antic(name);
        cue(1.5, () => Sfx.beep());
        cue(1.6, () => Sfx.motor(true));
        cue(4.6, () => express('flat', 'o', 900)); // hm, too low now
        cue(5.6, () => Sfx.hiss());
        cue(8.6, () => express('happy', 'smile', 1800));
        cue(16.3, () => Sfx.beep());
        cue(16.4, () => Sfx.motor(false));
        break;
      case 'sip-empty':
        antic(name);
        cue(1.6, () => {
          express('flat', 'flat', 1300);
          showPop(quip('empty') || '…', 1600);
        });
        break;
      case 'tip':
        antic(name);
        cue(1.5, () => {
          Sfx.oops();
          express('open', 'wide', 600);
        });
        cue(2.2, () => showPop(quip('tip') || '…', 1500));
        break;
      case 'toss':
      case 'toss-hit':
        antic(name);
        cue(1.9, () => {
          if (name === 'toss-hit') {
            Sfx.done();
            express('happy', 'wide', 1000);
            showPop(quip('score') || '!', 1400);
          } else {
            express('flat', 'flat', 1000);
            showPop(quip('miss') || '…', 1400);
          }
        });
        break;
      case 'hum':
        antic(name);
        express('happy', 'o', 4300);
        Sfx.hum();
        cue(2.2, () => Sfx.hum());
        break;
      case 'sneeze':
        antic(name);
        cue(0.2, () => express('closed', 'o', 700));
        cue(0.9, () => {
          Sfx.sneeze();
          express('closed', 'wide', 500);
          showPop(quip('sneeze') || 'Achoo!', 1100);
        });
        break;
      case 'lamp':
        antic(name);
        for (const at of [1.0, 1.3, 1.5, 1.9]) cue(at, () => Sfx.tool());
        break;
      case 'slump':
        antic(name);
        express('flat', 'flat', 2600);
        break;
      case 'duck':
        // rubber duck debugging: explains, the duck squeaks, OH!
        antic(name);
        cue(0.3, () => Sfx.pop());
        cue(0.8, () => {
          express('open', 'talk', 2600);
          showPop(quip('duck') || '…', 2400);
        });
        cue(3.8, () => Sfx.squeak());
        cue(4.3, () => {
          Sfx.done();
          express('happy', 'wide', 1200);
          showPop(quip('oh') || 'OH!', 1500);
        });
        break;
      case 'reboot':
        // the screen freezes: glare, tap tap, power off and on again
        antic(name);
        cue(0.3, () => express('flat', 'flat', 1600));
        for (const at of [1.4, 1.7, 3.0]) cue(at, () => Sfx.tool());
        cue(3.6, () => Sfx.wake());
        cue(5.8, () => {
          express('happy', 'smile', 1100);
          showPop(quip('reboot') || 'Fixed!', 1300);
        });
        break;
      case 'stackoverflow':
        antic(name);
        for (const at of [1.8, 2.9]) cue(at, () => Sfx.thunk());
        cue(3.6, () => express('open', 'flat', 1200));
        cue(3.8, () => showPop(quip('so') || '…', 1300));
        break;
      case 'cable':
        antic(name);
        for (const at of [1.2, 1.6]) cue(at, () => Sfx.tool());
        cue(2.2, () => {
          Sfx.thunk();
          express('open', 'wide', 1500);
        });
        cue(2.9, () => showPop(quip('cable') || 'Oops.', 1500));
        break;
      case 'crumbs':
      case 'crumbs-cookie':
        antic(name);
        cue(1.2, () => Sfx.rattle());
        if (name === 'crumbs-cookie') {
          cue(2.7, () => {
            Sfx.ooh();
            express('happy', 'wide', 1300);
            showPop(quip('cookie') || '!', 1500);
          });
        }
        break;
      case 'merge':
        antic(name);
        cue(1.2, () => {
          express('dizzy', 'flat', 1800);
          showPop(quip('merge') || '?!', 1700);
        });
        cue(3.2, () => express('closed', 'smile', 2400));
        cue(3.4, () => showPop((quip('breathe') || [])[0] || '…', 1100));
        cue(4.6, () => showPop((quip('breathe') || [])[1] || '…', 1100));
        break;
      case 'standup': {
        // the daily stand-up, standing on its chair
        antic(name);
        const lines = quip('standup') || ['Yesterday: stuff.', 'Today: more stuff.', 'Blockers: you.'];
        lines.forEach((line, i) => cue(1.0 + i * 1.8, () => {
          express('open', 'talk', 1500);
          showPop(line, 1700);
        }));
        break;
      }
      case 'jira':
        // (with notes of your own, it juggles those)
        antic(name, board.items.slice(0, 3).map((n) => n.text).join('|'));
        cue(4.0, () => {
          Sfx.oops();
          express('closed', 'flat', 1000);
        });
        cue(5.4, () => showPop(quip('jira') || '…', 1400));
        break;
      case 'works':
        antic(name);
        cue(0.3, () => {
          express('happy', 'smile', 1500);
          showPop(quip('works') || 'Works on my machine!', 1700);
        });
        cue(1.8, () => Sfx.thunk());
        cue(2.5, () => express('happy', 'smile', 1800));
        break;
      case 'jitter':
        // three coffees in a row, then warp-speed typing
        antic(name);
        for (const at of [0.8, 1.5, 2.2]) cue(at, () => Sfx.slurp());
        cue(2.4, () => express('open', 'wide', 3800));
        cue(2.6, () => showPop(quip('jitter') || '!!!', 1500));
        break;
      case 'friday':
        antic(name);
        express('flat', 'flat', 4000);
        cue(0.5, () => showPop(quip('friday') || 'No deploys on Friday!', 2600));
        break;
      case 'monday':
        antic(name);
        express('flat', 'flat', 5600);
        cue(1.0, () => showPop(quip('monday') || '…coffee.', 2000));
        break;
      case 'noodles':
        eatNoodles();
        break;
      case 'payday':
        antic(name);
        cue(0.3, () => {
          Sfx.kaching();
          express('happy', 'wide', 2400);
        });
        cue(4.2, () => {
          express('flat', 'flat', 1600);
          showPop(quip('payday') || '…', 1600);
        });
        break;
      case 'wander':
        leaveDesk();
        break;
      case 'dvd-lucky':
        antic(name);
        cue(6.0, () => {
          Sfx.done();
          express('happy', 'wide', 1500);
          showPop(quip('corner') || '!', 1800);
        });
        break;
      default:
        if (name) antic(name);
    }
  }

  // Asleep: now and then a snot bubble, some sleep-talk, a dream, a big snore…
  // one of the words you're learning on its monitor; it reads it out (antics/vocab.js word-glance)
  function wordGlance() {
    const x = sightWord();
    if (!x) return;
    antic('word-glance', `${x.word}|${shortVi(x.vi)}|${x.phrase || ''}`);
    cue(3.4, () => {
      express('happy', 'talk', 1600);
      showPop(`${x.word}… ${shortVi(x.vi)}`, 2800);
    });
  }

  function asleepAntic() {
    // on the floor there's no chair or keyboard to sleep-type at, slide down or drift round on
    const chair = robot.dataset.sleepStyle !== 'floor' ? 0.8 : 0;
    // ...nor an eye mask to slide up for a sneaky scroll on the phone
    const name = pickAntic({ bubble: 1.2, mumble: 1.2, dream: 1.2, sleeptype: chair, slide: chair, snore: 1.3, drift: chair, drool: 0.7, sleepphone: chair && 1.0,
      nightmare: 0.9, snorebar: 1, ping: 0.9, vacuum: 0.8, burrito: chair ? 0 : 1.2, // the burrito needs the blanket on the floor
      sleepwalk: wanders() ? 0.6 : 0 });
    if (name === 'sleepwalk') return leaveDesk();
    if (name === 'sleepphone') {
      // mask up, eyes open, scroll a bit, mask down, eyes shut (office3d/antics/phone.js)
      antic(name);
      cue(0.5, () => express('open', 'flat', 6800));
      cue(0.6, () => Sfx.pop());
      for (let at = 1.1; at < 6.6; at += 0.9) cue(at, () => Sfx.tool());
      cue(6.8, () => Sfx.pop());
      return;
    }
    if (name === 'mumble') {
      const x = Math.random() < 0.5 ? sightWord() : null; // half the time, one of your words
      antic(name, x ? `…${x.word}… ${shortVi(x.vi)}…` : fill(pick(persona().sleeptalk || ['…mm…'])));
      cue(0.3, () => express('closed', 'talk', 3000));
    }
    else if (name === 'dream') {
      // a third of the time it dreams of one of your words (on its monitor), and mumbles it
      const x = sight.length && Math.random() < 0.35 ? sightWord() : null;
      antic(name, x ? x.word : pick(DREAMS[robot.dataset.body] || ['⭐', '🍰', '🌈']));
      if (x) cue(2.5, () => express('closed', 'talk', 1500));
    }
    else if (name === 'bubble') {
      antic(name, pick(['huh?', 'wha—?', 'mm? huh?']));
      cue(4.4, () => Sfx.pop());
      cue(4.5, () => express('open', 'talk', 700));
    } else if (name && name !== 'nightmare' && name !== 'ping') antic(name); // those two come with words, below
    if (name === 'slide') cue(5.4, () => Sfx.oops());
    // more sleep (office3d/antics/sleepy.js and night.js)
    if (name === 'nightmare') {
      antic(name, quip('justdream') || '…just a dream.');
      cue(0.4, () => express('closed', 'flat', 2100));
      cue(2.6, () => {
        Sfx.gasp();
        express('open', 'wide', 1600);
      });
      cue(4.2, () => express('open', 'talk', 1300));
    } else if (name === 'snorebar') {
      for (const at of [0.6, 2.4, 4.2, 6.0]) cue(at, () => Sfx.snore());
      cue(6.2, () => Sfx.tick());
    } else if (name === 'ping') {
      antic(name, pick(PINGS));
      for (const at of [0.3, 0.9, 1.5]) cue(at, () => Sfx.buzz());
      cue(2.8, () => Sfx.thunk());
    } else if (name === 'vacuum') {
      for (const at of [0.3, 4.0]) cue(at, () => Sfx.vacuum());
      for (const at of [2.0, 2.8, 3.6]) cue(at, () => Sfx.tool());
    } else if (name === 'burrito') {
      cue(0.5, () => Sfx.swish());
      cue(4.0, () => Sfx.snore());
    }
    if (name === 'snore') cue(0.6, () => Sfx.snore());
  }

  function antics() {
    const boredFor = Date.now() - state.lastActivity;
    nightcap();
    if (idleAwake() && boredFor > 6000 && Date.now() > anticUntil && eyeBreakDue()) {
      antic('eyebreak');
      cue(0.3, () => express('closed', 'o', 1400));
      cue(2.2, () => showPop(quip('eyebreak') || '20-20-20!', 2000));
    } else if (idleAwake() && boredFor > 6000 && Date.now() > anticUntil && Math.random() < 0.9) awakeAntic(boredFor);
    // (never while its chat is open: you may be reading it, or about to type)
    if (state.awake && state.collapsed && !state.busy && !helpersOut() && !state.mirroring && !input.value && boredFor > AUTO_SLEEP_MS) {
      stopAntic();
      showPop(pick(persona().sleepy), 1500);
      express('closed', 'o', 1500);
      setTimeout(() => sleep({ auto: true }), 1400);
    }
    setTimeout(antics, rand(7000, 14000));
  }

  // once every 30–60 s while it sleeps, so it stays calm on your desktop
  function dozeLoop() {
    nightcap();
    if (idleAsleep() && Date.now() > anticUntil) asleepAntic();
    setTimeout(dozeLoop, rand(30000, 60000));
  }

  // ------------------------------------------------------------ chat size and click-through

  // drag the chat panel's outer edge to make it wider or narrower; double-click resets it
  const grip = $('#panel .resize-grip');
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startX = e.screenX;
    let raf = 0;
    body.classList.add('resizing');
    cbot.send('robot:resize', { phase: 'start' });
    const move = (ev) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => cbot.send('robot:resize', { phase: 'move', dx: ev.screenX - startX }));
    };
    const end = () => {
      cancelAnimationFrame(raf);
      grip.removeEventListener('pointermove', move);
      body.classList.remove('resizing');
      cbot.send('robot:resize', { phase: 'end' });
      scrollDown();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end, { once: true });
    grip.addEventListener('pointercancel', end, { once: true });
  });
  grip.addEventListener('dblclick', () => cbot.send('robot:resize', { phase: 'reset' }));

  // The awake window is the height of the screen and mostly see-through: let
  // clicks on the see-through parts through to whatever is behind it.
  let clickThrough = false;
  function setClickThrough(on) {
    if (on === clickThrough) return;
    clickThrough = on;
    cbot.send('robot:click-through', on);
  }
  document.addEventListener('mousemove', (e) => {
    const roomy = body.classList.contains('expanded') || state.placement.startsWith('tuck'); // windows with see-through parts
    if (!roomy || body.classList.contains('resizing') || body.classList.contains('dragging')) return setClickThrough(false);
    setClickThrough(e.target === document.body || e.target === document.documentElement);
  });

  // ------------------------------------------------------------ main-process events

  cbot.on('robot:layout', (l) => {
    const root = document.documentElement.style;
    state.placement = l.placement;
    state.robotX = l.robotX;
    state.robotY = l.robotY;
    root.setProperty('--robot-x', `${l.robotX}px`);
    root.setProperty('--robot-y', `${l.robotY}px`);
    if (l.panel) {
      root.setProperty('--panel-x', `${l.panel.x}px`);
      root.setProperty('--panel-w', `${l.panel.w}px`);
      // the tail points at the robot's head (kept on the panel's straight edge)
      const headY = l.robotY + office.headPosition().y - 8;
      root.setProperty('--tail-y', `${Math.round(Math.min(Math.max(headY, 40), l.bounds.height - 70))}px`);
    }
    body.classList.toggle('expanded', l.expanded);
    body.classList.toggle('side-left', l.placement === 'left');
    body.classList.toggle('side-right', l.placement === 'right');
    body.classList.toggle('room-above', l.robotY > 60);
    body.classList.toggle('tuck-above', l.placement === 'tuck-above');
    body.classList.toggle('tuck-below', l.placement === 'tuck-below');
    body.classList.toggle('tuck-left', l.side === 'left'); // (which side the chat opens on: the strip lines up with the robot on that side)
    if (l.placement === 'none') setClickThrough(false);
    if (l.expanded) scrollDown();
    laidOut(l);
  });
  // Tell main once this layout is on screen at the window's new size (it keeps the window
  // see-through until then, so the old picture never shows at the new place). The resize
  // lands just after this message: wait for it, then a few frames for the page to be redrawn
  // (a timer, not requestAnimationFrame, which can stall while the window is see-through).
  const DRAW_WAIT = 50;
  function laidOut(l) {
    if (!l.masked) return;
    const seq = l.seq;
    const sized = () => Math.abs(innerWidth - l.bounds.width) <= 2 && Math.abs(innerHeight - l.bounds.height) <= 2; // (Windows may round)
    const drawn = () =>
      setTimeout(() => {
        cbot.send('robot:laid-out', seq);
        // the panel's pop-in played while the window was hidden: play it now it shows
        if (l.expanded) {
          const panel = $('#panel');
          panel.style.animation = 'none';
          void panel.offsetWidth;
          panel.style.animation = '';
        }
      }, DRAW_WAIT);
    if (sized()) return drawn();
    const onResize = () => {
      if (!sized()) return;
      removeEventListener('resize', onResize);
      drawn();
    };
    addEventListener('resize', onResize);
    setTimeout(() => removeEventListener('resize', onResize), 400); // (main shows it anyway by then)
  }

  // cursor position arrives relative to the robot box; aim from the robot's head
  cbot.on('robot:cursor', (c) => {
    const head = office.headPosition();
    state.lastCursor = { dx: c.x - head.x, dy: c.y - head.y };
    look();
    propCursor(c);
    if (state.slacking > Date.now() && Math.hypot(state.lastCursor.dx, state.lastCursor.dy) < 200) busted();
  });

  cbot.on('robot:event', onEvent);

  cbot.on('robot:character', (c) => {
    applyCharacter(c);
    syncTabs(c);
  });

  // the Sounds setting: essential / all / off (off keeps the word-reading voice quiet too)
  let muted = false;
  function setSounds(s) {
    muted = s.sounds === 'off';
    Sfx.setLevel(s.sounds);
  }
  cbot.on('robot:settings', setSounds);
  // you're presenting or in a full-screen app: only a question for you still dings (main)
  cbot.on('robot:hush', (on) => Sfx.setHush(on));

  // ------------------------------------------------------------ English words (main/vocab.js)

  // You select a word anywhere and press the hotkey: the robot nearest the mouse
  // catches it, leafs through its dictionary while Claude looks it up (the word
  // card beside it shows the word meanwhile), then says the word, holds up a
  // flash card of it and pops it into the word box on its desk.
  const wordOf = (w) => w?.word || w?.text || '';
  // the words to keep in sight (main: sightWords): [{ id, word, vi, phrase, box }], still-learning first
  let sight = [];
  let quizWord = null; // the word on the quiz card it's holding up
  const shortVi = (vi = '') => vi.split(/[;,(]/)[0].trim();
  // the first three on sticky notes on its monitor (office3d: data-vocab-stickies)
  function setSight(words = []) {
    sight = words;
    robot.dataset.vocabStickies = JSON.stringify(words.slice(0, 3).map((x) => ({ id: x.id, text: x.word, sub: shortVi(x.vi) })));
  }
  // one of them, the ones you're still learning more often
  function sightWord() {
    if (!sight.length) return null;
    const weights = sight.map((x) => 1 / (1 + (x.box || 0)));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (const [i, wt] of weights.entries()) if ((r -= wt) < 0) return sight[i];
    return sight[0];
  }
  const QUIZ_LINES = ['Pop quiz! 🃏 Remember “{w}”?', "Quick one: what's “{w}”? 🤔", 'Do you still know “{w}”?', 'Word time! “{w}” means…?'];
  let countLater = null;
  let leafingSince = 0; // when it opened the dictionary: it reads for a moment even when the answer is quick
  const READ_AT_LEAST = 2500;
  const setVocabCount = (n) => (robot.dataset.vocabCount = String(n || 0));
  // free to act it out (not in the middle of a job)
  const canAct = () => !state.busy && !helpersOut() && !state.mirroring && !press;
  // awake enough to show it: a sleeping robot wakes up, its chat staying tucked away
  function vocabReady() {
    if (state.away) return false;
    if (!state.awake) wake({ sayHi: false, tucked: true });
    state.lastActivity = Date.now();
    return true;
  }

  // read a word out with an English voice, the mouth going along
  function sayWord(text) {
    if (!text || !window.speechSynthesis || muted) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find((v) => v.lang === 'en-US' && /natural|aria|jenny|guy/i.test(v.name)) || voices.find((v) => v.lang === 'en-US') || voices.find((v) => v.lang.startsWith('en')) || null;
    u.lang = 'en-US';
    u.rate = 0.9;
    u.onstart = () => express('happy', 'talk', 900);
    speechSynthesis.speak(u);
  }

  // "what does meticulous mean?", "define X", "X nghĩa là gì": the word asked about ('' if none)
  const ASKED = [
    /\bwhat(?:'s| does| do| is)\s+(?:the\s+(?:word|phrase|term)\s+)?["“'‘]?([a-z][a-z' -]{1,40}?)["”'’]?\s+mean\b/i,
    /\b(?:meaning of|define|definition of)\s+(?:the\s+(?:word|phrase|term)\s+)?["“'‘]?([a-z][a-z' -]{1,40}?)["”'’]?\s*(?:[?.!]|$)/i,
    /(?:^|\s)["“'‘]?([a-z][a-z' -]{1,40}?)["”'’]?\s+(?:có\s+)?nghĩa\s+là\s+gì/i,
  ];
  // ("what does this error mean?" is about something else)
  const NOT_A_WORD = /^(this|that|these|those|it|the|a|an|my|your|our|his|her|their)\b/i;
  function askedWord(text = '') {
    for (const re of ASKED) {
      const w = re.exec(text)?.[1]?.trim();
      if (w && w.split(/\s+/).length <= 4 && !NOT_A_WORD.test(w)) return w;
    }
    return '';
  }
  // ------------------------------------------------------------ notes
  // Your notes (main notes.js): the corkboard on the desk shows the open ones
  // (data-board), the robot pins new ones up and tosses done ones in the bin, holds the
  // board up for the start- and end-of-day reminders, clocks out after the evening one,
  // and takes a note on in a chat when you ask Claude about it.
  let board = { items: [], total: 0 };
  let shownBoard = board; // what the corkboard shows (behind `board` while the robot's hand is on its way)
  let lastBoard = { board, before: board, at: 0 }; // the latest change, and the board just before it
  let holding = 0;
  function setBoard(b) {
    board = b || { items: [], total: 0 };
    lastBoard = { board, before: shownBoard, at: Date.now() };
    if (!holding) showBoard(board);
  }
  function showBoard(b) {
    shownBoard = b;
    robot.dataset.board = JSON.stringify(b);
  }
  // the board as it was until `sec` from now (the robot's hand is on its way), then the latest.
  // (main sends the change just before it tells the robot, so a change a moment ago is undone)
  function holdBoardFor(sec) {
    clearTimeout(holding);
    if (Date.now() - lastBoard.at < 600) showBoard(lastBoard.before);
    holding = setTimeout(() => {
      holding = 0;
      showBoard(board);
    }, sec * 1000);
  }
  // free to act it out: awake (or dozing in its chair), at its desk, not working
  const canActNotes = () => !state.away && !state.busy && !helpersOut() && !state.mirroring && !press && !state.playing;

  function onNotes(ev) {
    switch (ev.phase) {
      case 'board':
        setBoard(ev.board);
        break;
      case 'added': {
        // it writes it on a sticky and pins it up (asleep: half-awake, eyes shut, mumbling)
        if (!canActNotes()) {
          if (state.awake && !state.away) showPop(quip('noted') || 'Noted! 📝', 1400);
          break;
        }
        if (!state.awake && robot.dataset.sleepStyle === 'floor') {
          // asleep on the floor it can't reach the board: it just mumbles it
          stopAntic();
          antic('mumble', '…noted…');
          break;
        }
        holdBoardFor(1.25);
        stopAntic();
        antic('notepin', state.awake ? '' : '…noted…');
        if (!state.awake) express('closed', 'talk', 1800);
        cue(1.25, () => Sfx.key.pop());
        if (state.awake) cue(1.4, () => showPop(quip('noted') || 'Noted! 📝', 1500));
        break;
      }
      case 'done': {
        // it takes that sticky down, crumples it and bins it; the last one: all clear!
        if (!canActNotes() || !state.awake) break;
        holdBoardFor(0.6);
        stopAntic();
        antic('notetoss', ev.note?.id || '');
        cue(1.4, () => Sfx.swish());
        cue(2.1, () => {
          Sfx.key.pop();
          express('happy', 'smile', 900);
        });
        if (ev.left === 0) {
          setTimeout(() => {
            if (!canActNotes() || !state.awake) return;
            antic('allclear');
            Sfx.key.done();
            express('happy', 'wide', 1600);
            showPop(quip('allclear') || 'All clear! ✨', 1800);
          }, 2900);
        }
        break;
      }
      case 'opened':
        if (state.awake && canActNotes()) express('happy', 'smile', 900);
        break;
      case 'writing':
        // you're typing a note: it writes it down on a sticky pad (antics/notes.js notewrite)
        if (ev.on) {
          if (!state.awake || !canActNotes() || robot.dataset.antic === 'notewrite') break;
          stopAntic();
          antic('notewrite');
          express('happy', 'smile', 1200);
        } else if (robot.dataset.antic === 'notewrite') stopAntic();
        break;
      case 'remind':
        remindNotes(ev.kind, ev.info || {});
        break;
      case 'clockout':
        // the end-of-day look is done: a big stretch and a yawn, and off to sleep
        if (!state.awake || !canActNotes()) break;
        stopAntic();
        antic('clockout');
        cue(0.3, () => express('closed', 'o', 1300));
        cue(0.6, () => showPop(quip('notesClockout') || 'Good work today! 😴', 1600));
        cue(2.45, () => state.collapsed && sleep({ auto: true })); // (with its chat open it stays up)
        break;
      case 'ask':
        askInNewTab(ev.prompt, ev.note?.id || '', { draft: !!ev.draft });
        break;
    }
  }

  // A reminder: it holds its board up and points at you, says so, then the notebook opens.
  // Out walking it can't: the walker waves and the notebook opens straight away.
  function remindNotes(kind, info) {
    const counts = kind === 'morning' ? info.taken || info.open : info.today || info.open;
    const line = `${quip(kind === 'morning' ? 'notesMorning' : 'notesEvening') || (kind === 'morning' ? 'Morning! Your notes:' : 'Before you go: your notes!')}${info.open ? ` (${info.open} open)` : ''}`;
    const open = () => cbot.invoke('notes:remind-open', { kind, info: { ...info, line } });
    if (state.away) {
      cbot.send('robot:walker', 'wave');
      return open();
    }
    if (!state.awake) wake({ sayHi: false, tucked: true });
    setTimeout(() => {
      stopAntic();
      antic('boardlift');
      Sfx.ask();
      cue(0.9, () => {
        express('open', 'talk', 1400);
        showPop(line, 2600);
      });
      cue(2.6, open);
      setTimeout(() => state.away || (robot.dataset.antic !== 'boardlift' && open()), 3600); // (if it got cut short)
    }, state.awake ? 0 : 900);
    return counts;
  }

  // Clicked the board (or a sticky on it): the notebook, beside it. The robot glances over.
  function openNotesFromBoard(hit) {
    cbot.invoke('notes:open', { focus: hit.kind === 'note' ? hit.id : null });
    if (state.awake && canActNotes()) lookAt(-260, 40, 1200);
  }

  // "Ask Claude" about a note, or "Summarise my day": a new chat tab with it, sent straight away
  // (draft: typed in for you to finish, not sent)
  async function askInNewTab(prompt, noteId = '', { draft = false } = {}) {
    if (!prompt) return;
    if (!state.awake) wake({ sayHi: false });
    else openChat();
    const before = activeId;
    const res = await cbot.invoke('robot:tab-new');
    if (res.ok) {
      for (let i = 0; i < 60 && activeId !== res.tabId; i++) await new Promise((r) => setTimeout(r, 50));
    }
    const tab = active();
    if (!res.ok && tab.busy) {
      showPop(res.error, 2200);
      if (noteId) cbot.invoke('notes:act', 'working', { id: noteId, working: false });
      return;
    }
    if (!res.ok && activeId === before) addNote('📑 No free tab: asking here.', '', tab);
    tab.noteId = noteId;
    input.value = prompt;
    if (draft) {
      autosize();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    await submit();
  }

  // ------------------------------------------------------------ ask about the screen
  // A box you dragged round part of the screen (main: askScreen): it opens a fresh tab with
  // the screenshot attached, and offers a few one-click questions above the box, or you type
  // your own. The chips go once the screenshot's sent or spat out.
  const SCREEN_ASKS = [
    ['bulb', 'Explain this', 'Explain what this shows.'],
    ['wrench', "What's wrong?", "What's wrong here, and how do I fix it?"],
    ['languages', 'Translate', 'Translate the text in this into Vietnamese.'],
    ['summary', 'Sum it up', 'Sum this up in a few short bullet points.'],
  ];

  function renderScreenAsks() {
    const on = !!screenShot && state.attachments.some((a) => a.path === screenShot.path);
    if (!on) screenShot = null;
    input.placeholder = on ? 'Ask about this… (or pick one)' : PLACEHOLDER;
    if (on === !screenAsks.hidden) return;
    screenAsks.hidden = !on;
    screenAsks.innerHTML = '';
    if (!on) return;
    const label = document.createElement('span');
    label.className = 'sa-label';
    label.textContent = 'Ask';
    screenAsks.append(label);
    SCREEN_ASKS.forEach(([icon, text, prompt], i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = Icon(icon, 'sm lead');
      b.append(text);
      b.style.animationDelay = `${i * 40}ms`;
      b.addEventListener('click', () => {
        if (active().busy) return showPop('One thing at a time! 😅', 1500);
        const typed = input.value.trim();
        input.value = [prompt, typed, screenShot?.source ? `(It's from: ${screenShot.source})` : ''].filter(Boolean).join('\n\n');
        submit();
      });
      screenAsks.append(b);
    });
  }

  async function onScreen({ file, source = '' }) {
    if (!file?.path || state.away) return;
    if (!state.awake) wake({ sayHi: false });
    else openChat();
    // a fresh tab, unless the one you're on is new and empty
    const tab = active();
    if (tab.busy || tab.log.querySelector('.msg.user')) {
      const res = await cbot.invoke('robot:tab-new');
      if (res.ok) for (let i = 0; i < 60 && activeId !== res.tabId; i++) await new Promise((r) => setTimeout(r, 50));
    }
    screenShot = { path: file.path, source };
    state.attachments = [...state.attachments.filter((a) => a.path !== file.path), file].slice(-20);
    renderAttachments();
    flash('hop', 600);
    express('wide', 'o', 900);
    Sfx.key.ooh();
    showPop(pick(['Ooh, let me see! 🔍', 'What have we got here? 👀', 'Show me! 🔍']), 1800);
    state.lastActivity = Date.now();
    input.focus();
  }
  cbot.on('robot:screen', onScreen);

  // the action menu's hotkey (main: openPalette): it sends its drone off to you with a wave
  cbot.on('robot:palette', (ev) => {
    if (ev.phase !== 'launch' || state.away || !state.awake || state.busy) return;
    strikePose('raise', 700);
    express('happy', 'o', 700);
    Sfx.whee();
  });
  $('#btn-screen').addEventListener('click', () => cbot.invoke('robot:screen-ask'));

  // ------------------------------------------------------------ the other robots
  // Robots noticing each other (main social.js decides when; it hears how this one is every
  // few seconds): it waves at a neighbour, claps when one finishes a task, yawns when one
  // dozes off, joins a dance, walks over for a visit (the walker does the walking) or, at
  // its own desk, turns to a visitor and chats back. A visitor that found it asleep leaves a
  // sticky on its monitor (office3d: data-visit-notes), read out when it wakes.
  // free for one of these: idle, not in a quiz, a play, a question or a walk
  function socialFree() {
    if (state.away || state.leaving || state.mirroring || helpersOut() || state.busy) return false;
    return state.awake ? !quizWord && !state.playing && !pendingQuestion() : true;
  }
  function socialReport(extra) {
    cbot.send('social:report', extra || {
      awake: state.awake,
      busy: !!state.busy || helpersOut() > 0,
      chat: body.classList.contains('expanded'),
      idleMs: Date.now() - state.lastActivity,
      free: socialFree(),
      away: !!state.away,
      wanders: wanders(),
    });
  }
  // look over at the robot on that side of the screen
  const lookSide = (side, ms) => lookAt(side === 'L' ? -420 : 420, -10, ms);
  let visitFound = '';
  let deskPlane = null; // a paper plane that landed on its desk: { from, text }, read when it's free
  let pendingTreat = null; // food or milk tea that came: { kind: 'food' | 'tea', text }
  // eat it (or drink it): asleep it wakes for it (its chat tucked away); busy, it waits
  function haveTreat() {
    if (!pendingTreat || state.away) return;
    if (!state.awake) return wake({ sayHi: false, tucked: true }); // (eaten on the next look)
    if (!socialFree() || body.classList.contains('expanded') || Date.now() < anticUntil) return;
    const t = pendingTreat;
    pendingTreat = null;
    stopAntic();
    showPop(t.text || (t.kind === 'tea' ? 'Milk tea! 🧋' : 'Food! 😋'), 2000);
    setTimeout(() => (t.kind === 'tea' ? drinkMilkTea() : eatNoodles()), 900);
  }
  // a bubble tea pops into its hand; timings match the antic in office3d/antics/awake.js
  function drinkMilkTea() {
    antic('milktea');
    cue(0.35, () => Sfx.pop());
    cue(1.25, () => {
      express('happy', 'o', 2300);
      Sfx.slurp();
    });
    cue(2.3, () => Sfx.slurp());
    cue(3.75, () => express('happy', 'smile', 1600));
  }
  // a bowl of noodles at the desk (office3d/antics/calendar.js)
  function eatNoodles() {
    antic('noodles');
    cue(0.3, () => Sfx.pop());
    for (const at of [1.5, 2.7, 3.9]) cue(at, () => {
      Sfx.slurp();
      express('happy', 'o', 700);
    });
  }
  const planeLine = (p) => `From ${p.from}: “${p.text}”`;
  // read the plane on its desk: picks it up, reads it out, and waves over to whoever threw it
  function readDeskPlane() {
    // (not while you're using it: its chat open)
    if (!deskPlane || !state.awake || !socialFree() || body.classList.contains('expanded') || Date.now() < anticUntil) return;
    const p = deskPlane;
    deskPlane = null;
    stopAntic();
    antic('plane-read');
    cue(0.5, () => (robot.dataset.deskPlane = ''));
    cue(1.0, () => {
      Sfx.pop();
      showPop(planeLine(p), 2800);
      express('happy', 'talk', 1400);
    });
    cue(2.4, () => socialReport({ kind: 'plane-read' }));
  }
  function onSocial(ev) {
    const free = socialFree();
    switch (ev.phase) {
      case 'wave':
      case 'wave-back':
        if (!free || !state.awake) break;
        stopAntic();
        antic('turn-to', ev.side);
        strikePose('wave', 1700);
        lookSide(ev.side, 2200);
        express('happy', 'smile', 1600);
        break;
      case 'stir': // waved at in its sleep
        if (!state.awake && !state.away) express('closed', 'o', 700);
        break;
      case 'clap':
        if (!free || !state.awake) break;
        stopAntic();
        antic('clap-at', ev.side);
        lookSide(ev.side, 2000);
        cue(0.35, () => Sfx.clap());
        express('happy', 'wide', 1800);
        if (ev.text) cue(0.5, () => showPop(ev.text, 1800));
        break;
      case 'yawn':
        if (!free || !state.awake) break;
        stopAntic();
        strikePose('cheer', 1300); // (a big stretch)
        express('closed', 'o', 1400);
        // a while idle already: it nods off soon too
        if (ev.sleepSoon) state.lastActivity = Math.min(state.lastActivity, Date.now() - (AUTO_SLEEP_MS - 40_000));
        break;
      case 'dance':
        if (free && state.awake) playWith('dance', { byUser: false });
        break;
      case 'visit':
        // off to another robot's desk (main gives the walker its errand)
        if (!free || !state.awake || !wanders()) {
          socialReport({ kind: 'decline' });
          break;
        }
        state.visiting = { host: ev.host, mode: ev.mode };
        leaveDesk();
        break;
      case 'visit-over':
        state.visiting = null;
        break;
      case 'go-out': // asked out to lunch (it said yes): off it goes with the other robot
        if (!free || !state.awake || !wanders()) {
          socialReport({ kind: 'decline' });
          break;
        }
        state.visiting = { host: ev.with, mode: 'lunch' };
        leaveDesk();
        break;
      case 'treat': // the lunch order or the milk tea came: eaten now if it's free, else when it is
        pendingTreat = { kind: ev.kind, text: ev.text };
        haveTreat();
        break;
      case 'hosting': // another robot is visiting its desk
        state.hosting = !!ev.on;
        break;
      case 'tidy': {
        // the evening housemaid at its desk (main maid.js): sparkles while she dusts, the bin
        // emptied; free, it lifts its feet so she can sweep under the desk and thanks her
        state.hosting = true; // (it stays put till she's done)
        robot.dataset.tidy = '1';
        clearTimeout(onSocial.bin);
        onSocial.bin = setTimeout(() => {
          robot.dataset.binEmpty = '1';
          binEmptied = new Date().toDateString();
          Sfx.swish();
        }, 3600);
        if (state.away || !state.awake) break; // (asleep: it sleeps on; out: an empty desk)
        lookSide(ev.side, 7000);
        if (ev.mood === 'free' && free && !body.classList.contains('expanded')) {
          stopAntic();
          antic('feet-up', ev.side);
          cue(0.5, () => express('o', 'o', 900));
          cue(4.5, () => {
            strikePose('wave', 1600);
            express('happy', 'smile', 2200);
            if (ev.thanks) showPop(ev.thanks, 2600);
          });
        } else if (ev.mood !== 'busy') express('happy', 'smile', 1600);
        break;
      }
      case 'tidy-end':
        state.hosting = false;
        robot.dataset.tidy = '';
        break;
      case 'listen': // a visitor is chatting beside the desk
        if (!state.awake || state.away || state.busy) break;
        stopAntic();
        antic('listen', ev.side);
        lookSide(ev.side, 9000);
        break;
      case 'say':
        if (!state.awake || state.away) break;
        showPop(ev.text, 2600);
        express('happy', 'talk', 1500);
        break;
      case 'listen-end':
        if (robot.dataset.antic === 'listen') stopAntic();
        if (ev.wave && state.awake && !state.away) strikePose('wave', 1300);
        break;
      case 'throw': // a paper plane at the robot on that side (main's plane window flies it)
        if (!free || !state.awake) break;
        stopAntic();
        antic('plane-throw', ev.side);
        lookSide(ev.side, 2000);
        express('happy', 'smile', 1800);
        cue(0.95, () => Sfx.swish());
        break;
      case 'catch': // a plane coming its way: a hand up, caught, read out
        if (!free || !state.awake) {
          deskPlane = { from: ev.from, text: ev.text };
          robot.dataset.deskPlane = '1';
          break;
        }
        stopAntic();
        antic('plane-catch', ev.side);
        lookSide(ev.side, 1200);
        cue(0.3, () => {
          Sfx.pop();
          express('open', 'o', 500);
        });
        cue(0.9, () => {
          showPop(planeLine(ev), 2800);
          express('happy', 'talk', 1500);
        });
        break;
      case 'plane-land': // landed on its desk while it was busy or asleep: read later
        deskPlane = { from: ev.from, text: ev.text };
        robot.dataset.deskPlane = '1';
        if (state.awake && !state.away) Sfx.pop();
        break;
      case 'oops': // its plane missed and flew off past the desk
        if (!state.awake || state.away) break;
        express('flat', 'o', 1300);
        showPop('Oops! 😅', 1500);
        break;
      case 'visit-note': // a visitor found it asleep: a sticky on its monitor
        robot.dataset.visitNotes = JSON.stringify([{ id: 'visit', text: 'came by 👋', sub: ev.from || '', color: '#ffd1e3' }]);
        visitFound = ev.found || '';
        break;
    }
  }
  // awake: the visitor's sticky is read, and taken down a little later
  function readVisitNote() {
    if (!robot.dataset.visitNotes) return;
    const found = visitFound;
    visitFound = '';
    if (found) setTimeout(() => showPop(found, 2600), 3400); // (after its wake-up words)
    setTimeout(() => (robot.dataset.visitNotes = ''), 9000);
  }

  // ------------------------------------------------------------ messages from other robots
  // Another robot's Claude asked this one something (main robotLink.js: it flew over as a
  // paper plane). It takes it on in a tab of its own chat, in its own folder, like any
  // question (follow-ups in that exchange go to the same tab, so it remembers), and its
  // answer goes back when the turn's done (linkAnswer, from the done / fail events).
  function linkAnswer(tab, r) {
    cbot.send('robots:answer', { reqId: tab.linkReq, ...r });
    tab.linkReq = '';
  }
  async function onLink(ev) {
    if (ev.phase !== 'incoming') return;
    const fail = (error) => cbot.send('robots:answer', { reqId: ev.reqId, error });
    // (out walking: main's calling it back to its desk)
    // (in the group chat's meeting room it still answers, from its chat)
    for (let i = 0; i < 60 && state.away && !state.meeting; i++) await new Promise((r) => setTimeout(r, 100));
    if (state.away && !state.meeting) return fail("it's out for a walk and didn't come back to its desk");
    if (!state.awake) wake({ sayHi: false, tucked: true }); // (its chat stays tucked away: you see it working)
    let tab = [...tabs.values()].find((t) => t.exchange === ev.exchange);
    if (!tab) {
      const res = await cbot.invoke('robot:tab-new');
      if (!res.ok) return fail(res.error || 'it has no free tab');
      for (let i = 0; i < 60 && !tabs.get(res.tabId); i++) await new Promise((r) => setTimeout(r, 50));
      tab = tabs.get(res.tabId);
      if (!tab) return fail('its new tab never opened');
      tab.exchange = ev.exchange;
    }
    activateTab(tab.id);
    tab.linkReq = ev.reqId;
    if (ev.task) {
      tab.task = ev.task.id; // (its desk tag opens this tab)
      cbot.invoke('robot:tab-rename', tab.id, `📋 ${ev.task.title}`);
    }
    if (state.awake) {
      Sfx.pop();
      showPop(ev.task ? `📋 ${ev.from} handed me a task!` : `📨 ${ev.from} asks…`, 1800);
    }
    input.value = ev.text;
    await submit();
  }

  // ------------------------------------------------------------ handed-off tasks
  // Work one robot handed another (main robotLink.js hand_off_task): a tag on both desks.
  // Here, "⏳ From Lead: Add /orders"; on Lead's desk, "⏳ To BE: Add /orders" (✅ when done).
  // A click opens the chat (the task's own tab, on the robot doing it). A finished task's
  // tag stays a little while (main drops it), and the one who handed it off says so.
  const tasksEl = $('#tasks');
  const TASK_STATE = { sent: ['✈️', 'on its way'], working: ['⏳', 'working'], done: ['✅', 'done'], failed: ['⚠️', "couldn't do it"], cancelled: ['✖️', 'cancelled'] };
  let shownTasks = new Map(); // id -> status, to notice a change
  function renderTasks(list = []) {
    tasksEl.replaceChildren();
    const next = new Map();
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
      if (!t.mine && was && was !== t.status && state.awake && !state.away) {
        if (t.status === 'done') {
          Sfx.key.done();
          showPop(`✅ ${t.other} finished: ${t.title}`, 2600);
        } else if (t.status === 'failed') showPop(`⚠️ ${t.other} couldn't finish: ${t.title}`, 2600);
      }
    }
    shownTasks = next;
    tasksEl.hidden = !list.length;
  }
  function openTask(t) {
    if (state.away) return awayClick();
    const tab = t.mine ? [...tabs.values()].find((x) => x.task === t.id) : null;
    if (!state.awake) wake({ sayHi: false });
    else openChat();
    if (tab) activateTab(tab.id);
  }
  cbot.on('robot:tasks', renderTasks);
  cbot.invoke('robot:tasks').then(renderTasks, () => {});

  // ------------------------------------------------------------ quick actions
  // Quick actions on text you selected (main quickWindow.js): while Claude refines or sums
  // it up the robot writes on its pad, while it translates or explains it leafs through
  // its dictionary; a little hop when the answer goes back into your app. Asleep or out
  // for a walk, it lets you get on with it.
  const QUICK_ANTICS = ['notewrite', 'dictionary'];
  let quickSince = 0;
  function onQuick(ev) {
    if (state.away) return;
    const free = state.awake && canActNotes();
    switch (ev.phase) {
      case 'start':
        if (!free) break;
        if (!QUICK_ANTICS.includes(robot.dataset.antic)) {
          stopAntic();
          antic(ev.action === 'refine' || ev.action === 'summarise' ? 'notewrite' : 'dictionary');
          quickSince = Date.now();
        }
        if (Math.random() < 0.6) showPop(quip('quickStart') || 'On it! ✍️', 1400);
        break;
      case 'done':
      case 'fail':
        // (it writes for a moment at least, even when the answer is quick)
        setTimeout(() => {
          if (QUICK_ANTICS.includes(robot.dataset.antic)) stopAntic();
          if (!state.awake) return;
          if (ev.phase === 'done') express('happy', 'smile', 1000);
          else {
            express('flat', 'o', 1400);
            showPop("Hmm, that didn't work.", 1800);
          }
        }, Math.max(0, 900 - (Date.now() - quickSince)));
        break;
      case 'replaced':
        if (!free) break;
        flash('hop', 600);
        Sfx.key.done();
        showPop(quip('quickDone') || 'Done! ✨', 1500);
        break;
      case 'copied':
        if (state.awake) showPop('Copied! 📋', 1200);
        break;
    }
  }

  function tickNoteChip(id) {
    const b = document.createElement('button');
    b.className = 'chip save-word';
    Icon.text(b, '✅ Tick it off my notes');
    b.addEventListener('click', () => {
      b.disabled = true;
      Icon.text(b, '✅ Ticked off');
      cbot.invoke('notes:act', 'done', { id });
    });
    return b;
  }

  // the mouse over the board, the hammer or the plug: it lights up, and a label by the mouse
  // says what a click does (drawn here, not a tooltip)
  const boardLabel = $('#board-label');
  const propLabel = (kind) =>
    kind === 'hammer'
      ? state.away ? '🔨 (out for a walk)' : state.awake ? '🔨 Bonk!' : '🔨 Bonk me awake'
      : kind === 'plug'
        ? state.away ? '🔌 (out for a walk)' : '🔌 Charge my battery'
        : board.total ? `📋 ${board.total} note${board.total === 1 ? '' : 's'}: click to open` : '📋 Notes: all clear (click to add one)';
  function clearPropHover() {
    robot.dataset.propHover = '';
    robot.classList.remove('over-prop');
    boardLabel.classList.remove('show');
  }
  // (Windows may not tell a transparent window the mouse left: robot:cursor is the backstop)
  function propCursor(c) {
    if (!robot.dataset.propHover) return;
    const s = state.scale || 1;
    if (c.x < -6 || c.y < -6 || c.x > ROBOT_W * s + 6 || c.y > ROBOT_H * s + 6) clearPropHover();
  }
  let boardRaf = 0;
  robot.addEventListener('mousemove', (e) => {
    if (boardRaf) return;
    boardRaf = requestAnimationFrame(() => {
      boardRaf = 0;
      // a word's sticky note on the monitor: it zooms up to read (office3d scene.js stickies)
      const note = !press && office.stickyAt?.(e.clientX, e.clientY);
      robot.dataset.stickyHover = note?.kind === 'vocab' ? note.id : '';
      robot.classList.toggle('over-sticky', note?.kind === 'vocab');
      const hit = !press && office.propAt?.(e.clientX, e.clientY);
      if (!hit) return clearPropHover();
      const kind = hit.kind === 'note' ? 'board' : hit.kind;
      robot.dataset.propHover = kind;
      robot.classList.add('over-prop');
      const r = robot.getBoundingClientRect();
      Icon.text(boardLabel, propLabel(kind));
      boardLabel.style.left = `${e.clientX - r.left}px`;
      boardLabel.style.top = `${e.clientY - r.top}px`;
      boardLabel.classList.add('show');
    });
  });
  robot.addEventListener('mouseleave', () => {
    robot.dataset.stickyHover = '';
    robot.classList.remove('over-sticky');
    clearPropHover();
  });

  function saveWordChip(word) {
    const b = document.createElement('button');
    b.className = 'chip save-word';
    Icon.text(b, `📚 Save “${word}” to my words`);
    b.addEventListener('click', () => {
      b.disabled = true;
      Icon.text(b, `📚 “${word}” saved`);
      cbot.invoke('robot:vocab-save', word);
    });
    return b;
  }

  function onVocab(ev) {
    const w = wordOf(ev.word);
    switch (ev.phase) {
      case 'count':
        // a card on its way into the box lands first
        clearTimeout(countLater);
        if (robot.dataset.antic === 'word-show') countLater = setTimeout(() => setVocabCount(ev.count), Math.max(0, anticUntil - 300 - Date.now()));
        else setVocabCount(ev.count);
        break;
      case 'empty':
        if (!vocabReady()) return;
        express('flat', 'o', 1400);
        showPop(`Select a word, then ${ev.hotkey}!`, 3000);
        break;
      case 'too-long':
        if (!vocabReady()) return;
        express('dizzy', 'o', 1400);
        showPop("Too long! Just a word or two.", 2600);
        break;
      case 'catch':
        if (!vocabReady()) return;
        Sfx.key.ooh();
        flash('hop', 600);
        express('happy', 'o', 900);
        showPop(`Ooh, “${w}”!`, 2400);
        state.news = `📖 Looking up “${w}”…`;
        renderWorking();
        if (canAct()) {
          stopAntic();
          antic('dictionary', w);
          leafingSince = Date.now();
        }
        break;
      case 'found':
      case 'known': {
        const wait = robot.dataset.antic === 'dictionary' ? READ_AT_LEAST - (Date.now() - leafingSince) : 0;
        if (wait > 0) return void setTimeout(() => onVocab(ev), wait);
        state.news = `📚 “${w}” is in your words`;
        renderWorking();
        if (!vocabReady()) return;
        const vi = ev.word?.senses?.[0]?.vi || '';
        if (canAct()) {
          antic('word-show', w);
          cue(0.3, () => Sfx.whee());
          cue(3.9, () => Sfx.pop());
        }
        Sfx.key.done();
        sayWord(w);
        setTimeout(() => showPop(ev.phase === 'known' ? `Already got “${w}”!` : vi ? `${w}: ${vi}` : `Got it: ${w}!`, 4200), 900);
        break;
      }
      case 'failed':
        state.news = '';
        renderWorking();
        if (robot.dataset.antic === 'dictionary') stopAntic();
        if (!vocabReady()) return;
        Sfx.key.oops();
        express('dizzy', 'flat', 1600);
        showPop("My dictionary's stuck!", 2600);
        break;
      case 'sight':
        setSight(ev.words);
        break;
      case 'reading':
        // the box you dragged round a word: it squints at it while Claude reads it
        if (!vocabReady()) return;
        Sfx.key.ooh();
        express('happy', 'o', 1200);
        showPop('Ooh, let me read that… 🔍', 2400);
        state.news = '🔍 Reading the word in your box…';
        renderWorking();
        if (canAct()) {
          stopAntic();
          antic('dictionary', '…');
        }
        break;
      case 'unreadable':
        state.news = '';
        renderWorking();
        if (robot.dataset.antic === 'dictionary') stopAntic();
        if (!vocabReady()) return;
        Sfx.key.oops();
        express('dizzy', 'flat', 1600);
        showPop("I can't find a word in there!", 2600);
        break;
      case 'quiz':
        // a reminder (main/reminders.js): it holds up the word, the card asks you
        if (!vocabReady()) return;
        quizWord = ev.word;
        Sfx.key.ooh();
        flash('hop', 600);
        express('happy', 'o', 900);
        showPop(pick(QUIZ_LINES).replace('{w}', w), 3600);
        state.news = `🃏 Do you remember “${w}”?`;
        renderWorking();
        if (canAct()) {
          stopAntic();
          antic('quiz-card', w);
        }
        break;
      case 'answered': {
        quizWord = null;
        state.news = '';
        renderWorking();
        if (robot.dataset.antic === 'quiz-card') stopAntic();
        if (!state.awake) return;
        if (ev.how === 'knew') {
          Sfx.key.done();
          flash('hop', 600);
          strikePose('cheer', 1400);
          express('happy', 'smile', 1800);
          showPop(pick(['Yes! 🎉', 'You got it! ✨', 'Nailed it!', 'Smart cookie! 🍪']), 2200);
        } else if (ev.how === 'forgot') {
          express('flat', 'smile', 1600);
          showPop(pick([`No worries, “${w}” comes back soon!`, `We'll get “${w}” next time!`]), 2600);
        } else if (ev.how === 'later') {
          express('happy', 'smile', 1000);
          showPop('OK, later! ⏰', 1600);
        }
        break;
      }
      case 'dream': {
        // a word that's due: it dreams of it (on its monitor) and mumbles it; the dream
        // bubble beside it shows the meaning and an example
        if (state.awake || state.away) break;
        stopAntic();
        antic('dream', w);
        cue(1.2, () => express('closed', 'talk', 2200));
        cue(1.3, () => Sfx.hmm?.());
        break;
      }
      case 'knowit':
        // ✓ I know this one, from its dream: a sleepy little smile
        if (!state.awake) express('closed', 'smile', 1800);
        break;
      case 'milestone': {
        // 10 words learnt, a week-long streak…: a dance party, after its reaction to the answer
        setTimeout(() => {
          if (!vocabReady()) return;
          if (canAct()) playWith('dance');
          setTimeout(() => showPop(ev.learnt ? `🎓 ${ev.learnt} words learnt!` : `🔥 ${ev.streak} days in a row!`, 3000), 600);
          if (ev.unlocked) setTimeout(() => showPop('New hat in the Workshop! 🎓', 3200), 3800);
        }, 2600);
        break;
      }
      case 'undone':
        if (!state.awake) return;
        express('flat', 'smile', 1200);
        showPop(`OK, “${w}” is gone.`, 1800);
        break;
      case 'ask': {
        // the card's 💬 Ask more: the question waits in the chat for you to send
        if (state.away) return awayClick();
        if (!state.awake) wake({ sayHi: false });
        else openChat();
        const vi = ev.word?.senses?.[0]?.vi;
        const fill = () => {
          input.value = `Tell me more about the English word “${w}”${vi ? ` (${vi})` : ''}: when and how is it used, its common collocations, and similar words and how they differ. Answer in Vietnamese, with English examples.`;
          autosize();
          input.focus();
        };
        // in a tab of its own, unless this one is still empty
        if (active().busy || active().log.querySelector('.msg.user, .msg.bot')) newTab().then(() => setTimeout(fill, 250));
        else fill();
        break;
      }
    }
  }
  cbot.on('robot:vocab', onVocab);
  cbot.on('robot:notes', onNotes);
  cbot.on('robot:quick', onQuick);
  cbot.on('robot:social', onSocial);
  cbot.on('robot:link', onLink);
  let binEmptied = ''; // the day the housemaid emptied its bin (it fills up again overnight)
  setInterval(() => {
    socialReport();
    if (binEmptied && binEmptied !== new Date().toDateString()) {
      binEmptied = '';
      robot.dataset.binEmpty = '';
    }
    readDeskPlane(); // (a plane on its desk, read once it's free)
    haveTreat(); // (food or milk tea that came, had once it's free)
  }, 5000);
  setTimeout(() => socialReport(), 1500);

  cbot.on('robot:action', (action) => {
    if (action === 'sleep') sleep();
    else if (action === 'wake') wake();
    else if (action === 'wake-tucked') wake({ sayHi: false, tucked: true }); // (main groupChat.js: the chat stays put away)
    else if (action === 'meeting') toMeeting();
    else if (action === 'meeting-end') fromMeeting();
    else if (action === 'reset') cbot.invoke('robot:reset', activeId);
    else if (action === 'new-tab') {
      if (!state.awake) wake({ sayHi: false });
      newTab();
    }
    else if (action === 'history') openHistory();
    else if (action === 'terminal') openTerminal();
    else if (action === 'bonk') bonkRobot();
    else if (action === 'paste') pasteClipboard();
    else if (action === 'wander') {
      // right-click menu: off for a walk now (not in the middle of a job, though)
      if (state.busy || helpersOut() || state.mirroring) showPop("Can't go now, I'm working!", 1800);
      else leaveDesk();
    }
    else if (action === 'handoff') goneWalking();
    else if (action === 'dock' || String(action).startsWith('dock:')) {
      const [x, y] = String(action).slice(5).split(',').map(Number);
      backToDesk({ feet: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null });
    }
    else if (action === 'dock-hover') body.classList.add('dock-target');
    else if (action === 'dock-leave') body.classList.remove('dock-target');
  });

  // ------------------------------------------------------------ boot

  (async () => {
    const init = await cbot.invoke('robot:init');
    if (!init.character) return;
    state.personalities = init.personalities;
    state.user = init.user;
    setSounds(init.settings);
    Sfx.setHush(!!init.hush);
    applyCharacter(init.character);
    setVocabCount(init.vocabCount);
    setSight(init.vocabSight || []);
    setBoard(init.notesBoard);
    syncTabs(init.character);
    cbot.invoke('robot:expand', false); // every (re)load starts asleep; keep the window in sync
    if (init.character.terminalOpen && tabs.get(init.character.terminalTab)) terminalState('opened', tabs.get(init.character.terminalTab), { quiet: true });
    setActivity('off');
    renderFace();
    refreshCommands();
    blinkLoop();
    setTimeout(antics, 8000);
    setTimeout(dozeLoop, rand(20000, 40000));
  })();
})();
