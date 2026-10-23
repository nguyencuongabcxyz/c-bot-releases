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
  };
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
  const fileIcon = (f) => (f.isDir ? '📁' : f.isImage ? '🖼️' : '📄');
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
    chip.textContent = `📁 ${folderName()}`;
    chip.title = c.folder;
    robot.dataset.acc = c.accessory || 'none';
    // its size: the robot box scales as one, the 3D view renders sharp at that size
    const k = { small: 0.7, large: 1.35, huge: 1.7 }[c.size] || 1;
    document.documentElement.style.setProperty('--s', String(k));
    state.scale = k;
    office.setScale(k);
    robot.dataset.body = c.body || 'loopy';
    robot.dataset.theme = c.theme || 'classic';
    robot.dataset.glb = c.glb || '';
    robot.dataset.glbTurn = String(c.glbTurn || 0);
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

  function wake({ sayHi = true } = {}) {
    if (state.awake) return;
    state.awake = true;
    stopAntic();
    state.lastActivity = Date.now();
    body.classList.remove('asleep');
    body.classList.add('awake');
    Sfx.wake();
    flash('shake', 500);
    express('open', 'o', 700);
    // jolt awake and boot the computer (unless it's already busy working)
    if (!state.busy) setActivity('boot', 1000);
    else renderPose();
    cbot.invoke('robot:expand', true);
    const hadBadge = body.classList.contains('has-badge');
    body.classList.remove('has-badge');
    setTimeout(() => {
      flash('hop', 600);
      if (!hadBadge && !state.busy && sayHi) greet();
      scrollDown();
      input.focus();
    }, 300);
  }

  // The chat stays open while the robot works, unless you tuck it away (🔽) to
  // watch the robot instead: a status bubble says what it's up to. It stays
  // tucked away until you click the bubble or the robot, even when the task is
  // done or Claude needs you; the bubble says so instead.
  function collapse() {
    if (!state.awake || state.collapsed || state.mirroring) return;
    state.collapsed = true;
    body.classList.add('collapsed');
    hidePalette();
    renderWorking();
    cbot.invoke('robot:expand', false, { tucked: true });
  }

  function openChat({ focus = true } = {}) {
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
    $('#working-text').textContent = asking
      ? '✋ I have a question for you. Click to answer'
      : t
        ? t.statusText || 'Working on it…'
        : out
          ? `🤖 ${out === 1 ? 'A helper is' : `${out} helpers are`} still working…`
          : state.news || 'Waiting for a question';
    workingEl.classList.toggle('news', asking || (!t && !!state.news));
  }
  workingEl.addEventListener('click', () => openChat());

  function sleep() {
    if (!state.awake) return;
    state.awake = false;
    stopAntic();
    state.collapsed = false;
    state.news = '';
    body.classList.remove('collapsed');
    renderWorking();
    Sfx.sleep();
    express('closed', 'o', 900);
    body.classList.remove('awake', 'expanded');
    body.classList.add('asleep');
    cbot.invoke('robot:expand', false);
    // a busy robot keeps working at its desk; otherwise the monitor goes dark
    if (!state.busy) setActivity('off');
    else renderPose();
    renderFace();
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
        chip.appendChild(document.createElement('span')).textContent = f.thumb ? f.name : `${fileIcon(f)} ${f.name}`;
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
    el.innerHTML = md(text || (tools?.length || edits?.length || apps?.length || images?.length ? '' : '…'));
    // the files it changed, the views its tools drew and the pictures they returned
    if (edits?.length || apps?.length || images?.length) {
      const box = document.createElement('div');
      box.className = 'edits';
      for (const d of edits || []) box.appendChild(diffCard(d));
      for (const a of apps || []) box.appendChild(appCard(a));
      if (images?.length) box.appendChild(toolPics(images));
      el.prepend(box);
    }
    if (tools?.length || asides?.length) {
      const row = toolChips(tools || []);
      for (const a of asides || []) row.appendChild(asideChip(a));
      el.prepend(row);
    }
    if (denials?.length) el.appendChild(deniedNote(denials));
    dedupePics(el);
    tab.log.appendChild(el);
    scrollDown(tab);
    return el;
  }

  // compact chips for a finished turn: "📖 Read ×3"
  function toolChips(tools) {
    const row = document.createElement('div');
    row.className = 'tools';
    const counts = new Map();
    for (const t of tools) counts.set(t, (counts.get(t) || 0) + 1);
    for (const [entry, n] of counts) {
      // "Skill(anthropic-skills:pptx)" -> 🎓 Skill: pptx (anthropic-skills)
      const [, name, detail] = entry.match(/^(\w+)\((.+)\)$/) || [null, entry, ''];
      const chip = document.createElement('span');
      chip.className = 'tool';
      chip.textContent = `${(TOOLS[name] || ['🛠️'])[0]} ${name}${detail ? `: ${skillLabel(detail)}` : ''}${n > 1 ? ` ×${n}` : ''}`;
      row.appendChild(chip);
    }
    return row;
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
    sum.innerHTML = '<span class="d-verb"></span><b class="d-name"></b><span class="d-dir"></span><span class="d-add"></span><span class="d-del"></span><button class="d-open" type="button" title="Open the file">↗</button>';
    sum.querySelector('.d-open').dataset.open = d.file;
    sum.querySelector('.d-verb').textContent = d.created ? '📝 Created' : '✏️ Updated';
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
    card.innerHTML = '<div class="app-head"><span class="app-title"></span><span class="app-state">loading…</span><button class="app-big" type="button" title="Open in a big window" hidden>⤢</button></div>';
    const title = card.querySelector('.app-title');
    const status = card.querySelector('.app-state');
    const bigBtn = card.querySelector('.app-big');
    title.textContent = '🧩 Tool view';
    (async () => {
      const view = a.uri ? a : await cbot.invoke('robot:app-view', a.name);
      if (!view) return card.remove(); // no view after all (or its server is out of reach)
      title.textContent = `🧩 ${serverLabel(view.server)} · ${view.tool}`;
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
    chip.textContent = `💭 ${text}`;
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
    el.textContent = text;
    tab.log.appendChild(el);
    scrollDown(tab);
  }

  function deniedNote(denials) {
    const el = document.createElement('div');
    el.className = 'denied';
    el.textContent = `🔒 I wasn't allowed to use ${[...new Set(denials)].join(', ')}. Right-click me → Permissions to give me more power.`;
    return el;
  }

  function setStatus(text) {
    statusRow.hidden = !text;
    statusText.textContent = text || '';
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
    $('#send').textContent = t?.busy ? '■' : '➤';
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
    tab.log.querySelectorAll('.greet').forEach((el) => el.remove());
    clearFinishedHelpers(tab);
    addUser(question, files, tab);
    if (!tab.custom && tab.title === 'New chat') {
      const t = question.replace(/\s+/g, ' ').trim();
      tab.title = t.length > 28 ? t.slice(0, 27) + '…' : t;
    }
    Sfx.send();
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
    bar.innerHTML = '<span>📨 next up</span><button type="button" title="Stop the current answer and do this now">⚡ Send now</button><button type="button" title="Don\'t send">✕</button>';
    const [now, cancel] = bar.querySelectorAll('button');
    now.addEventListener('click', () => cbot.invoke('robot:send-now', tab.id, turnId));
    cancel.addEventListener('click', async () => {
      if (await cbot.invoke('robot:unqueue', tab.id, turnId)) dropQueued(tab, turnId, 'not sent');
    });
    el.appendChild(bar);
    tab.queue.push({ turnId, el, ask: { question, paths: files.map((f) => f.path) } });
    Sfx.send();
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
    q.el.querySelector('.queue-actions').textContent = `📭 ${why}`;
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
    el.innerHTML = '<div class="tools"></div><div class="edits"></div><div class="content cursor"></div>';
    tab.log.appendChild(el);
    tab.current = { el, tools: el.querySelector('.tools'), edits: el.querySelector('.edits'), content: el.querySelector('.content'), text: '' };
    scrollDown(tab);
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
      cur.content.innerHTML = md(cur.text.slice(cur.offset || 0));
      dedupePics(cur.el);
      if (nearBottom) scrollDown(tab);
    });
  }

  function finishCurrent(tab) {
    const cur = tab.current;
    tab.current = null;
    if (cur) cur.content.classList.remove('cursor');
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
        // "mcp__claude_ai_Excalidraw__create_view" -> 🧩 Excalidraw: create_view
        const mcp = /^mcp__(.+?)__(.+)$/.exec(ev.name);
        const [emoji, verb, activity] = TOOLS[ev.name] || (mcp ? ['🧩', `${serverLabel(mcp[1])}: ${mcp[2]}`, 'run'] : ['🛠️', `Using ${ev.name}`, 'run']);
        const label = `${emoji} ${verb}${ev.detail ? ' ' + ev.detail : ''}`;
        const chip = document.createElement('span');
        chip.className = 'tool';
        chip.textContent = label;
        chip.title = label;
        if ((ev.name === 'Agent' || ev.name === 'Task') && ev.id) {
          chip.classList.add('agent-chip');
          chip.title = `${label} (click to watch it work)`;
          chip.addEventListener('click', () => openHelper(tab, ev.id));
        }
        cur.tools.appendChild(chip);
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

      case 'edit':
        if (!cur?.edits) break;
        cur.edits.appendChild(diffCard(ev));
        scrollDown(tab);
        break;

      case 'app': // an MCP tool's own view (e.g. an Excalidraw drawing)
        if (!cur?.edits) break;
        cur.edits.appendChild(appCard(ev));
        scrollDown(tab);
        break;

      case 'app-result':
        appResult(ev.id, ev.result);
        break;

      case 'tool-images': // pictures an MCP tool returned (a screenshot, a rendered chart)
        if (!cur?.edits) break;
        cur.edits.appendChild(toolPics(ev.images));
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
        if (cur) cur.tools.appendChild(asideChip(ev.text));
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
        const done = finishCurrent(tab);
        expireQuestion(tab);
        if (ev.interrupted) {
          if (done) {
            const said = done.asked ? done.text.slice(done.offset).trim() : done.text;
            const why = tab.bonk ? '🔨 restarting quicker' : 'stopped';
            done.content.innerHTML = md(said ? `${said}\n\n_…(${why})_` : tab.bonk ? '_🔨 Restarting, quicker!_' : '_Okay, okay, I stopped._');
          }
          if (tab.bonk) break; // the rerun follows straight away
          if (show) setActivity(restingActivity());
          express('flat', 'o', 1200);
          renderTabs();
          break;
        }
        if (done) {
          const tail = done.asked ? done.text.slice(done.offset).trim() : done.text || ev.text;
          if (!tail && done.asked && !done.tools.children.length && !done.edits?.children.length) done.el.remove(); // nothing more after the answer
          else {
            done.content.innerHTML = md(tail || '_(no words, just vibes)_');
            dedupePics(done.el);
          }
          if (ev.isError) done.el.classList.add('error');
          if (ev.denials?.length) done.el.appendChild(deniedNote(ev.denials));
        }
        if (tab !== active()) tab.status = ev.isError ? 'error' : 'done'; // unread
        if (!show) {
          // a background tab finished while you watch another one
          Sfx.done();
          express('happy', 'o', 1200);
          showPop(`“${tab.title}” is done!`, 2600);
        } else if (ev.isError) {
          Sfx.oops();
          setActivity('error', 3500);
          express('dizzy', 'flat', 2200);
          showPop(pick(persona().oops));
        } else if (ev.denials?.length) {
          Sfx.oops();
          setActivity('locked', 3500);
          express('flat', 'flat', 2200);
          showPop('They locked me out of some tools!');
        } else {
          Sfx.done();
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
        const done = finishCurrent(tab);
        expireQuestion(tab);
        if (done) done.text = done.text.slice(done.offset || 0);
        if (ev.cancelled) {
          if (done) done.content.innerHTML = md(done.text ? done.text + '\n\n_…(stopped)_' : '_Okay, okay, I stopped._');
          if (show) setActivity(restingActivity());
          express('flat', 'flat', 1200);
          break;
        }
        if (show) setActivity('error', 3500);
        if (tab !== active()) tab.status = 'error';
        if (done) {
          done.el.classList.add('error');
          done.content.innerHTML = md(`${done.text ? done.text + '\n\n' : ''}**Oops:** ${ev.message}`);
        } else {
          addBot(`**Oops:** ${ev.message}`, { error: true, tab });
        }
        Sfx.oops();
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
      Sfx.annoyed();
      flash('shake', 500);
      express(Math.random() < 0.5 ? 'dizzy' : 'flat', 'flat', 2600);
      showPop(pick(persona().annoyed), 2800);
      return;
    }
    Sfx.poke();
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
      Sfx.whee();
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
    cbot.invoke('robot:menu', { awake: state.awake });
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
    else if (helperView.id) closeHelper();
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
      Sfx.done();
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
      cur.content.classList.remove('cursor');
      if (!cur.text.slice(cur.offset || 0).trim() && !cur.tools.children.length) cur.el.remove();
    }

    const card = document.createElement('div');
    card.className = 'msg q-card';
    card.innerHTML = '<div class="q-title"></div>';
    card.querySelector('.q-title').textContent = `✋ ${state.character.name} has ${questions.length > 1 ? `${questions.length} questions` : 'a question'}`;
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
      card.querySelector('.q-title').textContent = `✋ You answered ${state.character.name}`;
      const ok = await cbot.invoke('robot:answer', tab.id, requestId, answers, items);
      if (!ok) {
        card.classList.add('expired');
        card.querySelector('.q-title').textContent = '✋ Too late, that question has closed';
        return;
      }
      tab.question = null;
      if (!pendingQuestion()) {
        body.classList.remove('has-badge');
        $('#badge').textContent = '!';
      }
      Sfx.send();
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
        el.innerHTML = '<div class="tools"></div><div class="edits"></div><div class="content cursor"></div>';
        tab.log.appendChild(el);
        Object.assign(tab.current, { el, tools: el.querySelector('.tools'), edits: el.querySelector('.edits'), content: el.querySelector('.content'), offset: tab.current.text.length, asked: true });
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
    q.card.querySelector('.q-title').textContent = '✋ This question closed without an answer';
  }

  function addQaSummary(items = [], tab = active()) {
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'msg qa-summary';
      el.innerHTML = '✋ <span></span> → <b></b>';
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
      chip.innerHTML = '<span></span><button type="button" title="Spit it out">✕</button>';
      chip.querySelector('span').textContent = f.thumb ? f.name : `${fileIcon(f)} ${f.name}`;
      if (f.thumb) chip.prepend(thumbImg(f.thumb));
      chip.querySelector('button').addEventListener('click', () => {
        state.attachments = state.attachments.filter((a) => a !== f);
        renderAttachments();
        showPop('Ptooey!', 1200);
        input.focus();
      });
      attachRow.appendChild(chip);
    }
  }

  function startCraving() {
    if (body.classList.contains('feeding')) return;
    body.classList.add('feeding');
    Sfx.ooh();
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
    Sfx.chomp();
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
    setTimeout(() => Sfx.swish(), BONK_HIT_MS - 110); // the swing
    setTimeout(() => {
      Sfx.squeak(); // the squeaky toy lands
      flash('shake', 400);
      onHit();
    }, BONK_HIT_MS);
  }

  function bonkRobot() {
    smack(bonked);
  }

  // Clicking a sleeping robot: the squeaky hammer wakes it up (no cooldown, and
  // it doesn't hurry a task along, it just wakes up and opens the chat).
  // ------------------------------------------------------------ the hover menu: play with it

  // Hover over the robot and a little menu pops up at its feet: bonk it, charge
  // its battery, tickle it, high-five it, or throw a dance party. Apart from the
  // bonk (which wakes it, like a click), these play on a sleeping robot too,
  // without waking it or opening the chat.
  const playMenu = $('#playmenu');
  let menuOpenTimer = 0;
  let menuCloseTimer = 0;
  // shows after a short hover, and comes back whenever the mouse moves over the robot
  function hoverMenu() {
    clearTimeout(menuCloseTimer);
    menuCloseTimer = 0;
    if (robot.classList.contains('menu-open') || menuOpenTimer) return;
    menuOpenTimer = setTimeout(() => {
      menuOpenTimer = 0;
      if (!press && !body.classList.contains('dragging')) robot.classList.add('menu-open');
    }, 350);
  }
  // hides a moment after the mouse goes (a short grace, so brushing the edge doesn't flicker it)
  function leaveMenu() {
    clearTimeout(menuOpenTimer);
    menuOpenTimer = 0;
    if (menuCloseTimer || !robot.classList.contains('menu-open')) return;
    menuCloseTimer = setTimeout(() => {
      menuCloseTimer = 0;
      robot.classList.remove('menu-open');
    }, 250);
  }
  robot.addEventListener('mouseenter', hoverMenu);
  robot.addEventListener('mousemove', hoverMenu);
  robot.addEventListener('mouseleave', leaveMenu);
  // When the window is just the robot (asleep, or chat tucked away), Windows often
  // doesn't tell a transparent window the mouse left, so mouseleave never comes.
  // These catch the mouse leaving the window; robot:cursor (below) is the backstop.
  document.documentElement.addEventListener('mouseleave', leaveMenu);
  window.addEventListener('blur', leaveMenu);
  // c is the real cursor, relative to the robot box's spot on screen
  function menuCursor(c) {
    if (!robot.classList.contains('menu-open') && !menuOpenTimer) return;
    const s = state.scale || 1;
    const m = 6; // a little slack around the edge
    const outside = c.x < -m || c.y < -m || c.x > ROBOT_W * s + m || c.y > ROBOT_H * s + m;
    if (outside) leaveMenu();
  }
  playMenu.addEventListener('pointerdown', (e) => e.stopPropagation()); // a button press isn't a drag or a poke
  playMenu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-play]');
    if (!b) return;
    e.stopPropagation();
    playWith(b.dataset.play); // the menu stays: play again, or move away to hide it
  });

  const PLAY_MS = { charge: 2600, tickle: 1700, highfive: 1300, dance: 4300 };
  function playWith(what) {
    stopAntic(); // whatever idle antic was playing gives way
    state.lastActivity = Date.now();
    if (what === 'bonk') return state.awake ? bonkRobot() : bonkAwake();
    if (state.playing) return;
    state.playing = what;
    setTimeout(() => (state.playing = null), PLAY_MS[what]);
    flash(what, PLAY_MS[what]); // the 3D view acts it out
    if (what === 'charge') {
      Sfx.charge();
      express('happy', 'o', 1900);
      setTimeout(() => {
        express('happy', 'smile', 1500);
        flash('hop', 600);
        showPop(pick(['Battery 100%! ⚡', 'Fully charged!', 'Zap! I feel brand new.']), 2000);
      }, 2000);
    } else if (what === 'tickle') {
      Sfx.giggle();
      express('happy', 'talk', 1600);
      strikePose('cheer', 1500);
      showPop(pick(['Hehehe! Stop it!', 'Ha-ha-ha! That tickles!', 'Nooo, not there! Hehe']), 1600);
    } else if (what === 'highfive') {
      strikePose('raise', 1200);
      express('open', 'o', 450);
      setTimeout(() => {
        Sfx.clap();
        express('happy', 'smile', 1200);
        showPop(pick(['Up top! ✋', 'Nice one!', 'Team work! ✋']), 1500);
      }, 450);
    } else if (what === 'dance') {
      Sfx.dance();
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
    Sfx.annoyed();
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
    todoEl.querySelector('.todo-title').textContent = `📋 Plan · ${done}/${tasks.length}`;
    todoEl.querySelector('.todo-bar i').style.width = `${(done / tasks.length) * 100}%`;
    todoEl.querySelector('.todo-chev').textContent = t.todoCollapsed ? '▸ show' : '▾ hide';
    todoEl.querySelector('.todo-head').addEventListener('click', () => {
      t.todoCollapsed = !t.todoCollapsed;
      renderTodo();
    });
    const list = todoEl.querySelector('.todo-list');
    for (const task of tasks) {
      const li = document.createElement('li');
      li.className = `${task.status}${task.id === t.justDone ? ' just-done' : ''}`;
      li.innerHTML = '<span class="ti"></span><span class="tt"></span>';
      li.querySelector('.ti').textContent = task.status === 'completed' ? '✅' : task.status === 'in_progress' ? '' : '⬜';
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
  const helperView = { id: null, tab: null, timer: 0 };
  const AGENT_ICON = { completed: '✅', failed: '⚠️', killed: '🛑', stopped: '🛑' };
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
    helpersEl.querySelector('.todo-title').textContent = back === list.length ? `🤖 ${plural(list.length, 'helper')} · all back` : `🤖 Helpers · ${back}/${list.length} back`;
    helpersEl.querySelector('.todo-bar i').style.width = `${(back / list.length) * 100}%`;
    helpersEl.querySelector('.todo-chev').textContent = t.helpersCollapsed ? '▸ show' : '▾ hide';
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
      li.querySelector('.hi').textContent = AGENT_ICON[a.status] || '';
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

  function closeHelper() {
    clearInterval(helperView.timer);
    helperView.id = null;
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
    $('#hv-title').textContent = `🤖 ${a.description}`;
    const status = { running: '⏳ Working', completed: '✅ Done', failed: '⚠️ Failed', killed: '🛑 Stopped', stopped: '🛑 Stopped' }[a.status] || a.status;
    bodyEl.innerHTML = `
      <div class="hv-meta"><span class="pill-${a.status}"></span><span class="hv-kind"></span><span class="hv-stats"></span></div>
      <details><summary>Its job (what it was asked)</summary><div class="hv-prompt"></div></details>
      <h4>Steps</h4><ul class="hv-steps"></ul>
      <div class="hv-said" hidden><h4>What it says</h4><div class="hv-words md-said"></div></div>
      <div class="hv-rep" hidden><h4>Report</h4><div class="hv-words md-rep"></div></div>`;
    bodyEl.querySelector(`.pill-${a.status}`).textContent = status;
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
      li.querySelector('.st').textContent = stepLabel(s);
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
    $('#brain-model').textContent = `🧠 ${modelName(t.model)} ▾`;
    $('#brain-effort').textContent = t.effort ? `${EFFORTS[t.effort]?.[0] || '⚡'} ${t.effort} ▾` : '⚡ auto ▾';
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
      el.className = `menu-item${it.on ? ' on' : ''}`;
      el.setAttribute('role', 'menuitem');
      el.innerHTML = '<b></b><small></small>';
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
      { label: '⚡ auto', desc: "Claude Code's default", value: '', on: !t.effort },
      ...levels.map((l) => ({ label: `${EFFORTS[l][0]} ${l}`, desc: EFFORTS[l][1], value: l, on: t.effort === l })),
    ], (v) => setBrain(t, { effort: v }));
  }
  function openMemoryMenu() {
    const t = active();
    openMenu($('#brain-meter'), 'Memory (context)', [
      { label: '🗜️ Compact now', desc: 'Squish the conversation into a summary to free up room', value: 'compact' },
      { label: '📊 What’s in my head?', desc: 'How full my memory is', value: 'context' },
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
    if (helperView.id && helperView.tab !== next) closeHelper();
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
    g.textContent = `📁 ${folderName()}`;
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
      row.querySelector('.p-icon').textContent = item.dir ? '📁' : '📄';
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
      Sfx.wake();
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
    'cat-tail': 4.5, 'cat-mug': 4.2, 'loopy-pencil': 3.8, 'nerd-glasses': 2, 'nerd-guitar': 4.5, 'girl-hair': 3.2, 'girl-heart': 2.6, 'robot-antenna': 2.4, 'robot-defrag': 1.8,
    bubble: 5.2, mumble: 3.6, dream: 6.5, sleeptype: 4.2, slide: 6.5, snore: 2.4, drift: 10, drool: 2.6,
    // IT office life
    duck: 6, reboot: 7, stackoverflow: 5, cable: 4.5, crumbs: 5, 'crumbs-cookie': 5, merge: 6, standup: 7, jira: 5.5, works: 5, jitter: 6.5,
    friday: 4.5, monday: 6, noodles: 7, payday: 6, eyebreak: 6, bsod: 4.2,
  };
  const CRITTER_ANTICS = { cat: ['cat-tail', 'cat-mug'], loopy: ['loopy-pencil'], nerd: ['nerd-glasses', 'nerd-guitar'], girl: ['girl-hair', 'girl-heart'], robot: ['robot-antenna', 'robot-defrag'] };
  const DREAMS = { loopy: ['🪵', '🌲', '🥕'], cat: ['🐟', '🧶', '🐭'], nerd: ['🍕', '💾', '🎮'], girl: ['🧋', '🐱', '🌸'], robot: ['🔋', '⚙️', '💾'] };
  const quip = (k) => persona().quips?.[k];
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

  const idleAwake = () => state.awake && !state.busy && !helpersOut() && !state.mirroring && !press;
  const idleAsleep = () => !state.awake && !state.busy && !helpersOut() && !state.mirroring && !press;

  // after 10 pm it sleeps in a nightcap, or, still up, codes with its hood up in the monitor's glow
  function nightcap() {
    const h = new Date().getHours();
    const late = h >= 22 || h < 6;
    robot.dataset.nightcap = idleAsleep() && late ? '1' : '';
    robot.dataset.lateNight = state.awake && late ? '1' : '';
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
    Sfx.crash();
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
    });
    lastAntic = name;
    switch (name) {
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
        if (c === 'cat-mug') cue(2.2, () => express('flat', 'flat', 1300));
        if (c === 'robot-antenna') cue(0.6, () => Sfx.boing());
        if (c === 'robot-defrag') express('dizzy', 'flat', 1800);
        if (c === 'girl-heart') cue(0.5, () => express('happy', 'wide', 1800));
        if (c === 'girl-hair') express('happy', 'smile', 2800);
        if (c === 'loopy-pencil') {
          cue(0.7, () => express('happy', 'chomp', 2400));
          cue(1.2, () => Sfx.chomp());
        }
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
        // a bubble tea pops into its hand; timings match the antic in office3d/antics/awake.js
        antic(name);
        cue(0.35, () => Sfx.pop());
        cue(1.25, () => {
          express('happy', 'o', 2300);
          Sfx.slurp();
        });
        cue(2.3, () => Sfx.slurp());
        cue(3.75, () => express('happy', 'smile', 1600));
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
        antic(name);
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
        antic(name);
        cue(0.3, () => Sfx.pop());
        for (const at of [1.5, 2.7, 3.9]) cue(at, () => {
          Sfx.slurp();
          express('happy', 'o', 700);
        });
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
  function asleepAntic() {
    // on the floor there's no chair or keyboard to sleep-type at, slide down or drift round on
    const chair = robot.dataset.sleepStyle !== 'floor' ? 0.8 : 0;
    // ...nor an eye mask to slide up for a sneaky scroll on the phone
    const name = pickAntic({ bubble: 1.2, mumble: 1.2, dream: 1.2, sleeptype: chair, slide: chair, snore: 1.3, drift: chair, drool: 0.7, sleepphone: chair && 1.0 });
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
      antic(name, fill(pick(persona().sleeptalk || ['…mm…'])));
      cue(0.3, () => express('closed', 'talk', 3000));
    }
    else if (name === 'dream') antic(name, pick(DREAMS[robot.dataset.body] || ['⭐', '🍰', '🌈']));
    else if (name === 'bubble') {
      antic(name, pick(['huh?', 'wha—?', 'mm? huh?']));
      cue(4.4, () => Sfx.pop());
      cue(4.5, () => express('open', 'talk', 700));
    } else if (name) antic(name);
    if (name === 'slide') cue(5.4, () => Sfx.oops());
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
    if (state.awake && !state.busy && !helpersOut() && !state.mirroring && !input.value && boredFor > AUTO_SLEEP_MS) {
      stopAntic();
      showPop(pick(persona().sleepy), 1500);
      express('closed', 'o', 1500);
      setTimeout(() => sleep(), 1400);
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
    if (l.placement === 'none') setClickThrough(false);
    if (l.expanded) scrollDown();
  });

  // cursor position arrives relative to the robot box; aim from the robot's head
  cbot.on('robot:cursor', (c) => {
    const head = office.headPosition();
    state.lastCursor = { dx: c.x - head.x, dy: c.y - head.y };
    look();
    menuCursor(c);
    if (state.slacking > Date.now() && Math.hypot(state.lastCursor.dx, state.lastCursor.dy) < 200) busted();
  });

  cbot.on('robot:event', onEvent);

  cbot.on('robot:character', (c) => {
    applyCharacter(c);
    syncTabs(c);
  });

  cbot.on('robot:settings', (s) => Sfx.setMuted(s.muted));

  cbot.on('robot:action', (action) => {
    if (action === 'sleep') sleep();
    else if (action === 'wake') wake();
    else if (action === 'reset') cbot.invoke('robot:reset', activeId);
    else if (action === 'new-tab') {
      if (!state.awake) wake({ sayHi: false });
      newTab();
    }
    else if (action === 'history') openHistory();
    else if (action === 'terminal') openTerminal();
    else if (action === 'bonk') bonkRobot();
    else if (action === 'paste') pasteClipboard();
  });

  // ------------------------------------------------------------ boot

  (async () => {
    const init = await cbot.invoke('robot:init');
    if (!init.character) return;
    state.personalities = init.personalities;
    state.user = init.user;
    Sfx.setMuted(init.settings.muted);
    applyCharacter(init.character);
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
