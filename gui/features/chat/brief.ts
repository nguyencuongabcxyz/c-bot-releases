// Briefs from its other tabs: mention one with @# and that tab writes a brief for this one
// (app features/chat/brief.rs: a branch of it, so it isn't disturbed) while you type; it goes
// with the message, which waits for it. Shown as chips: in the composer, and under a message.
// (robot.ts calls createBriefs with its hub.)
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { FaceApi } from '@/views/robot/life/face';
import type { AttachmentsApi } from './composer/attachments';
import type { ChatMarkdownApi } from './reply/local-files';
import type { ChatTab, ComposerBrief, PaletteTab, RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { el, iconButton } from '@/lib/dom';
import type { Brief } from '@/types/model';
import { Icon } from '@/icons/icons';

/** What it uses of the robot window (robot.ts's hub). */
export type BriefsNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly express: FaceApi['express'];
  readonly input: HTMLTextAreaElement;
  readonly md: ChatMarkdownApi['md'];
  readonly renderAttachments: AttachmentsApi['renderAttachments'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly state: RobotState;
};

const BRIEFS_MAX = 3;

export function createBriefs(r: BriefsNeeds) {
  // ask that tab for a brief for the one you're writing in
  function addBrief(from: PaletteTab) {
    if (r.state.briefs.some((b) => b.tabId === from.id)) return;
    if (r.state.briefs.length >= BRIEFS_MAX) return r.showPop('Three briefs is plenty!', 1800);
    const to = r.active();
    if (!to) return;
    const b: ComposerBrief = { tabId: from.id, title: from.title, text: null, wait: Promise.resolve() };
    b.wait = ipc
      .robotTabBrief(from.id, to.id, r.input.value)
      .then(
        (text) => {
          b.text = text;
        },
        (err) => {
          r.state.briefs = r.state.briefs.filter((x) => x !== b);
          r.express('flat', 'flat', 1500);
          r.showPop(`📎 ${err}`, 2800);
        },
      )
      .finally(r.renderAttachments);
    r.state.briefs.push(b);
    r.renderAttachments();
  }

  // the briefs written for the next message, which go with it (not one from the tab it goes to)
  function takeBriefs(tab: ChatTab): Brief[] {
    const ready = r.state.briefs.flatMap((b) =>
      b.text !== null && b.tabId !== tab.id ? [{ title: b.title, text: b.text }] : [],
    );
    r.state.briefs = [];
    return ready;
  }

  // Briefs as chips (in the composer, with ✕; under a message, as sent): click one to read it.
  function briefChips<B extends { title: string; text: string | null }>(
    row: HTMLElement,
    list: B[],
    remove?: (b: B) => void,
  ) {
    if (!list.length) return;
    const body = el('div', 'brief-body');
    body.hidden = true;
    const chips = list.map((b) => {
      const chip = el('span', `file-chip brief-chip${b.text === null ? ' pending' : ''}`);
      chip.title = 'Brief from another tab';
      chip.innerHTML = Icon('tabs', 'sm');
      chip.append(el('span', '', b.text === null ? `${b.title}…` : b.title));
      chip.addEventListener('click', () => {
        if (b.text === null) return;
        const open = !chip.classList.contains('on');
        for (const c of chips) c.classList.remove('on');
        chip.classList.toggle('on', open);
        body.hidden = !open;
        body.innerHTML = open ? r.md(b.text) : '';
      });
      if (remove) {
        const x = iconButton('', 'Remove', 'x');
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          remove(b);
        });
        chip.appendChild(x);
      }
      row.appendChild(chip);
      return chip;
    });
    row.appendChild(body);
  }

  // till the briefs being written are (false: a message is already waiting for them)
  let waiting = false;
  async function waitForBriefs() {
    if (waiting) return false;
    waiting = true;
    r.showPop('📎 Waiting for the brief…', 2000);
    await Promise.all(r.state.briefs.map((b) => b.wait));
    waiting = false;
    return true;
  }

  return { addBrief, briefChips, takeBriefs, waitForBriefs };
}
export type BriefsApi = ReturnType<typeof createBriefs>;
