// The context engine's panel, in the chat's helper view (engine.ts opens it from the header's
// button and its brain-bar menu): this robot's folder only (its top, its indexes one by one, its
// languages, its git). A bar on top opens the Context engine window for everything else (every
// folder, every file, the store, the models), reads the folder again, or switches the engine.
// It's read when it opens and when the index changes phase; its rings and indexes follow each
// status as it comes. Nothing is drawn into a panel that's been closed by then.
import { el, iconButton } from '@/lib/dom';
import * as ipc from '@/ipc';
import type { ContextEngineStatus } from '@/types/model';
import { type Live, gitCard, heroCard, indexesCard, languagesCard } from '@/features/context/details';

/** What it uses of the engine's part: the status now, and switching it or reading again. */
export type ContextPanelNeeds = {
  readonly status: () => ContextEngineStatus;
  readonly act: (what: 'on' | 'off' | 'reindex') => void;
};

export function createContextPanel(n: ContextPanelNeeds) {
  const root = el('div', 'cx cx-panel');
  let live: Live[] = [];

  // the bar
  const bar = el('div', 'cx-toolbar');
  const all = iconButton('cx-open', 'Context engine window', 'expand', 'All details');
  all.addEventListener('click', () => void ipc.robotContextWindow());
  const refresh = iconButton('cx-btn', 'Refresh', 'refresh');
  refresh.addEventListener('click', () => void load());
  const reindex = iconButton('cx-btn', 'Read again', 'rotate');
  reindex.addEventListener('click', () => n.act('reindex'));
  const power = el('button', 'cx-switch');
  power.type = 'button';
  power.title = 'Context engine';
  power.addEventListener('click', () => n.act(n.status().phase === 'off' ? 'on' : 'off'));
  bar.append(all, el('span', 'spacer'), refresh, reindex, power);
  const page = el('div', 'cx-page');
  root.append(bar, page);
  // (closing the helper view only hides it: the panel stays in it till something else is shown)
  const shown = () => root.isConnected && !root.closest('[hidden]');

  function drawBar() {
    const on = n.status().phase !== 'off';
    reindex.hidden = !on;
    power.classList.toggle('on', on);
    power.replaceChildren(el('i'), on ? 'On' : 'Off');
  }

  async function load() {
    if (!page.childElementCount) page.append(el('p', 'cx-muted', 'Reading…'));
    try {
      const d = await ipc.robotContextDetails();
      if (!shown()) return;
      const f = d.folder;
      if (!f) {
        live = [];
        page.replaceChildren(el('p', 'cx-muted', 'The context engine is off for this robot: switch it on above.'));
        return;
      }
      const hero = heroCard(f);
      const indexes = indexesCard();
      live = [hero, indexes];
      page.replaceChildren(hero.box, indexes.box, languagesCard(f), gitCard(f.git));
      for (const l of live) l.update(n.status());
    } catch (e) {
      if (shown()) page.replaceChildren(el('p', 'cx-muted', String(e)));
    }
  }

  /** The panel is shown: read afresh. */
  function show() {
    drawBar();
    void load();
  }

  /** A status: the bar, the rings and the indexes follow it; the rest is read again when the
   * index changes phase. */
  function update(s: ContextEngineStatus, was: ContextEngineStatus['phase']) {
    drawBar();
    if (!shown()) return;
    for (const l of live) l.update(s);
    if (was !== s.phase) void load();
  }

  drawBar();
  return { root, show, update, isShown: shown };
}
export type ContextPanelApi = ReturnType<typeof createContextPanel>;
