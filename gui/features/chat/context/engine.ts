// The context engine (app/src/context): the code in my folder indexed for my Claude Code, which
// then starts each conversation with a map of it and gets tools to look things up (code_map,
// code_outline, find_symbol, search_code) and to follow who calls what (find_references,
// call_chain, file_dependencies, type_hierarchy, change_impact). It's off till you switch it on for
// this robot. Two buttons show how the index is: in the brain bar, what it knows, a bar of how
// far it's got while it works and a dot for each of its indexes (syntax trees, keywords,
// vectors, code graph; its menu turns it on or off, reads the folder again, or opens the panel
// or the Context engine window); in the header, a dot (working, ready, failed) on the button
// that opens its panel (panel.ts: this robot's folder). (robot.ts calls createContextEngine with
// its hub.)
import type { BrainApi } from '../brain';
import type { HelpersApi } from '../agents';
import type { CommentaryApi } from '../reply/commentary';
import type { FaceApi } from '@/views/robot/life/face';
import * as ipc from '@/ipc';
import { $, el } from '@/lib/dom';
import { Icon } from '@/icons/icons';
import type { ContextEngineStatus } from '@/types/model';
import { OFF } from '@/features/context/details';
import { contextLabel, contextProgress, contextSummary, indexStates } from '@/features/context/status';
import { createContextPanel } from './panel';

/** What it uses of the robot window (robot.ts's hub). */
export type ContextEngineNeeds = {
  readonly addNote: CommentaryApi['addNote'];
  readonly closeHelper: HelpersApi['closeHelper'];
  readonly express: FaceApi['express'];
  readonly openMenu: BrainApi['openMenu'];
  readonly openPanel: HelpersApi['openPanel'];
};

export function createContextEngine(r: ContextEngineNeeds) {
  const btn = $('#brain-context');
  const headBtn = $('#btn-context');
  let status: ContextEngineStatus = OFF;
  let turnedOn = false; // (switched on from here: say so once it's read the folder)

  btn.innerHTML = `${Icon('map')}<span class="bc-label"></span><span class="bc-bar"><i></i></span><span class="bc-idx"></span><span class="caret">▼</span>`;
  const label = $('.bc-label', btn);
  const fill = $('.bc-bar i', btn);
  const dots = $('.bc-idx', btn);

  // the brain bar's button and the header's dot: what it's doing (data-stage) and how far it's
  // got; and a dot for each index
  function render() {
    label.textContent = contextLabel(status);
    const p = contextProgress(status);
    for (const b of [btn, headBtn]) {
      b.dataset.phase = status.phase;
      if (p) b.dataset.stage = p.stage;
      else delete b.dataset.stage;
    }
    btn.classList.toggle('vague', p?.pct === null);
    fill.style.width = p?.pct == null ? '' : `${Math.max(2, Math.min(100, p.pct))}%`;
    dots.replaceChildren(...indexStates(status).map((i) => el('i', i.state)));
  }

  const panel = createContextPanel({
    status: () => status,
    act: (what) => void act(what),
  });

  function onStatus(s: ContextEngineStatus) {
    const was = status.phase;
    status = s;
    render();
    panel.update(s, was);
    if (s.phase === 'ready' && was !== 'ready' && turnedOn) {
      turnedOn = false;
      r.addNote(`🧭 ${contextSummary(s)}. New questions get a map of the code and the tools to look things up.`);
      r.express('happy', 'smile', 1500);
    } else if (s.phase === 'failed' && was !== 'failed') {
      r.addNote(`🧭 ${contextSummary(s)}`);
    }
  }

  async function act(what: 'on' | 'off' | 'reindex') {
    try {
      turnedOn = what !== 'off';
      onStatus(what === 'reindex' ? await ipc.robotContextReindex() : await ipc.robotContextSet(what === 'on'));
      if (what === 'off') r.addNote('🧭 Context engine off. New questions go without it.');
    } catch (e) {
      turnedOn = false;
      r.addNote(`🧭 ${String(e)}`);
      r.express('flat', 'flat', 1500);
    }
  }

  function openDetails() {
    r.openPanel('map', 'Context engine', (body) => {
      body.append(panel.root);
      panel.show();
    });
  }

  function openContextMenu() {
    const on = status.phase !== 'off';
    const details = { icon: 'eye', label: 'This folder', desc: 'Its index and its indexes, here', value: 'details' };
    const all = {
      icon: 'expand',
      label: 'All details…',
      desc: 'Every folder, file, definition and chunk, in a window of its own',
      value: 'window',
    };
    r.openMenu(
      btn,
      contextSummary(status),
      on
        ? [
            details,
            all,
            { icon: 'refresh', label: 'Read again', desc: 'Index every file afresh', value: 'reindex' },
            { icon: 'x', label: 'Turn off', desc: 'New questions go without it', value: 'off' },
          ]
        : [
            {
              icon: 'map',
              label: 'Turn on',
              desc: 'Index this folder’s code: a map of it, and tools to find definitions, uses and code',
              value: 'on',
            },
            all,
          ],
      pick,
    );
  }
  function pick(v: string) {
    if (v === 'details') openDetails();
    else if (v === 'window') void ipc.robotContextWindow();
    else void act(v === 'on' ? 'on' : v === 'off' ? 'off' : 'reindex');
  }

  btn.addEventListener('click', openContextMenu);
  headBtn.addEventListener('click', () => (panel.isShown() ? r.closeHelper() : openDetails()));
  ipc.on('robot:context', onStatus);
  render();
  ipc.robotContext().then(onStatus, () => {});
  return {};
}
export type ContextEngineApi = ReturnType<typeof createContextEngine>;
