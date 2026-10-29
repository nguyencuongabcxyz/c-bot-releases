// The box you type in: its height, ↑ and ↓ through what you asked, editing or taking back the
// last question, and the buttons on a message (copy, retry, edit).
// (robot.ts calls createComposer with its hub.)
import type { PastChatsApi } from '../past/resume';
import type { SidePanelApi } from '../side/panel';
import type { ShellsApi } from '@/features/workbench/shell/drawer';
import type { BrainApi } from '../brain';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { RemoteControlApi } from '../remote';
import type { HelpersApi } from '../agents';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { AttachmentsApi } from './attachments';
import type { SlashApi } from './slash';
import type { MentionsApi } from './mentions';
import type { AskingApi } from '../reply/ask';
import type { ChatTab, RobotState } from '@/views/robot/types';
import { TRANSFORMS, codeBlock, link, prefixLines, transform, wrap } from './format';
import * as ipc from '@/ipc';
import { $, iconButton } from '@/lib/dom';

/** What it uses of the robot window (robot.ts's hub). */
export type ComposerNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly activeId: string | null;
  readonly backFromView: HelpersApi['backFromView'];
  readonly body: HTMLElement;
  readonly closeMenu: BrainApi['closeMenu'];
  readonly collapse: LifeCycleApi['collapse'];
  readonly cycleMode: BrainApi['cycleMode'];
  readonly eat: AttachmentsApi['eat'];
  readonly helperView: HelpersApi['helperView'];
  readonly hidePalette: SlashApi['hidePalette'];
  readonly history: PastChatsApi['history'];
  readonly input: HTMLTextAreaElement;
  readonly islandOn: boolean;
  readonly lookAt: DeskActivityApi['lookAt'];
  readonly menuEl: BrainApi['menuEl'];
  readonly openHistory: PastChatsApi['openHistory'];
  readonly openMenu: BrainApi['openMenu'];
  readonly paletteEl: SlashApi['paletteEl'];
  readonly paletteKey: MentionsApi['paletteKey'];
  readonly pasteClipboard: AttachmentsApi['pasteClipboard'];
  readonly peek: LifeCycleApi['peek'];
  readonly renderAttachments: AttachmentsApi['renderAttachments'];
  readonly renderHistory: LifeCycleApi['renderHistory'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly sides: SidePanelApi['sides'];
  readonly sleep: LifeCycleApi['sleep'];
  readonly state: RobotState;
  readonly stopTab: AskingApi['stopTab'];
  readonly submit: AskingApi['submit'];
  readonly toggleRemote: RemoteControlApi['toggleRemote'];
  readonly toggleShell: ShellsApi['toggleShell'];
  readonly updatePalette: SlashApi['updatePalette'];
};

export function createComposer(r: ComposerNeeds) {
  let typingTimer = 0; // (it stops looking busy once you pause)
  function autosize() {
    // (its box is border-box: one line is exactly the buttons' 32 px, so they sit level with it)
    r.input.style.height = 'auto';
    r.input.style.height = `${Math.min(r.input.scrollHeight, 120)}px`;
    r.input.style.overflowY = r.input.scrollHeight > 120 ? 'auto' : 'hidden';
  }

  // ↑ / ↓ in the composer: what you asked before in this tab, as in a terminal (and Claude Code).
  // Only from the first line going up (or the last going down), so a long message still moves.
  let recallAt = -1; // which one is shown (-1: none, your own draft)
  let recallDraft = '';
  const sentOf = (t: ChatTab) =>
    (t.sent ??= (t.data?.history || []).filter((h) => h.role === 'user').map((h) => h.text));
  function recall(dir: -1 | 1) {
    const t = r.active();
    if (!t || r.input.selectionStart !== r.input.selectionEnd) return false;
    const list = sentOf(t);
    const caret = r.input.selectionStart;
    if (dir < 0 && (!list.length || r.input.value.slice(0, caret).includes('\n'))) return false;
    if (dir > 0 && (recallAt < 0 || r.input.value.slice(caret).includes('\n'))) return false;
    if (recallAt < 0) {
      recallDraft = r.input.value;
      recallAt = list.length;
    }
    const next = recallAt + dir;
    if (next < 0) return true; // (the oldest: stay)
    recallAt = next >= list.length ? -1 : next;
    r.input.value = recallAt < 0 ? recallDraft : list[recallAt];
    autosize();
    r.input.setSelectionRange(r.input.value.length, r.input.value.length);
    return true;
  }

  // Edit your last question (✏️ on it): the conversation goes back to before it, and what you
  // send instead takes its place (Claude Code's rewind). Retry (on the last answer) is the same
  // question again.
  let editing: { tab: ChatTab; draft: string } | null = null;
  const editBanner = $('#edit-banner');
  function startEdit(tab: ChatTab, text: string) {
    if (tab.busy || tab.queue.length) return r.showPop('Wait till I’m done (or stop me) first.', 1800);
    if (!editing) editing = { tab, draft: r.input.value };
    editing.tab = tab;
    r.input.value = text;
    autosize();
    editBanner.hidden = false;
    $('span', editBanner).textContent = '✏️ Editing your last question: Enter sends it in its place, Esc cancels';
    r.input.focus();
    r.input.setSelectionRange(r.input.value.length, r.input.value.length);
  }
  function cancelEdit() {
    if (!editing) return false;
    r.input.value = editing.draft;
    editing = null;
    editBanner.hidden = true;
    autosize();
    return true;
  }
  $('#edit-cancel').addEventListener('click', () => cancelEdit());
  // take the last question (and its answer) back; then it's asked again, as it is or edited
  async function takeBack(tab: ChatTab) {
    tab.rewinding = true;
    // (off the page first: main's redraw of the shortened history, whenever it comes, shows the same)
    const asked = tab.log.querySelectorAll('.msg.user');
    const last = asked[asked.length - 1];
    if (last) {
      while (last.nextSibling) last.nextSibling.remove();
      last.remove();
    }
    const res = await ipc.robotRewind(tab.id);
    if (!res.ok) {
      tab.rewinding = false;
      r.renderHistory(tab); // (as it was)
      r.showPop(res.error, 2600);
      return false;
    }
    const sent = sentOf(tab);
    if (sent.length) sent.pop();
    return true;
  }
  async function retry(tab: ChatTab) {
    if (tab.busy || tab.queue.length) return;
    const question = sentOf(tab)[sentOf(tab).length - 1];
    if (!question || !(await takeBack(tab))) return;
    // (asked again as it was: the draft and files waiting in the composer stay for later)
    const [draft, files] = [r.input.value, r.state.attachments];
    r.state.attachments = [];
    r.input.value = question;
    void r.submit({ again: true });
    r.input.value = draft;
    r.state.attachments = files;
    r.renderAttachments();
    autosize();
  }

  // the hover buttons on a message: ✏️ on your last question; Copy and Retry on an answer
  const rawText = new WeakMap<HTMLElement, string>(); // an answer's words, as written (markdown)
  function msgActions(el: HTMLElement, kind: 'user' | 'bot', tab: ChatTab) {
    el.querySelector(':scope > .msg-actions')?.remove();
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    const button = (icon: string, title: string, act: () => void) => {
      const b = iconButton('', title, icon);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        act();
      });
      bar.appendChild(b);
    };
    if (kind === 'user') {
      button('edit', 'Edit this question (the conversation goes back to before it)', () => {
        const users = tab.log.querySelectorAll('.msg.user:not(.queued):not(.dropped)');
        if (users[users.length - 1] !== el) return r.showPop('Only the last question can be edited.', 1800);
        startEdit(tab, sentOf(tab)[sentOf(tab).length - 1] ?? el.textContent ?? '');
      });
    } else {
      button('copy', 'Copy this answer', () => {
        // biome-ignore lint/performance/useDomNodeTextContent: innerText keeps the line breaks between paragraphs
        navigator.clipboard.writeText(rawText.get(el) ?? el.innerText).then(
          () => r.showPop('Copied! 📋', 1200),
          () => {},
        );
      });
      button('refresh', 'Ask again (this answer is replaced)', () => {
        const answers = tab.log.querySelectorAll('.msg.bot:not(.greet)');
        if (answers[answers.length - 1] !== el) return r.showPop('Only the last answer can be asked again.', 1800);
        retry(tab);
      });
      button('chat-ask', 'Side question', () => r.sides.start(el));
    }
    el.appendChild(bar);
  }

  // The composer's tools. ＋: files or pictures (the open dialog), what's on the clipboard, or a
  // box round part of the screen; they go along as chips, as a dropped file does.
  $('#btn-attach').addEventListener('click', () =>
    r.openMenu(
      $('#btn-attach'),
      'Add to your message',
      [
        { icon: 'file', label: 'Files…', desc: 'anything on this computer', value: 'files' },
        { icon: 'image', label: 'Pictures…', desc: 'screenshots, photos, diagrams', value: 'pictures' },
        { icon: 'copy', label: 'From the clipboard', desc: 'a copied picture or files', value: 'clipboard' },
        { icon: 'scan', label: 'Part of the screen…', desc: 'drag a box round it', value: 'screen' },
      ],
      async (v) => {
        if (v === 'screen') return void ipc.robotScreenAsk();
        if (v === 'clipboard') return void r.pasteClipboard();
        const picked = await ipc.robotPickFiles(v === 'pictures');
        if (picked.length) r.eat(picked);
        else r.input.focus();
      },
    ),
  );

  // Aa: the formatting bar (markdown round what's selected, and changes to the text itself);
  // whether it shows is remembered. Ctrl+B / I / E / K and Ctrl+Shift+E work either way.
  const fmtBar = $('#fmt-bar');
  const fmtBtn = $('#btn-format');
  function showFmt(on: boolean) {
    fmtBar.hidden = !on;
    fmtBtn.classList.toggle('on', on);
    try {
      localStorage.setItem('cbot.fmtBar', on ? '1' : '');
    } catch {}
  }
  try {
    showFmt(localStorage.getItem('cbot.fmtBar') === '1');
  } catch {
    showFmt(false);
  }
  fmtBtn.addEventListener('click', () => {
    showFmt(fmtBar.hidden !== false);
    r.input.focus();
  });
  function format(kind: string) {
    switch (kind) {
      case 'bold':
        return wrap(r.input, '**');
      case 'italic':
        return wrap(r.input, '_');
      case 'strike':
        return wrap(r.input, '~~');
      case 'code':
        return wrap(r.input, '`', '`', 'code');
      case 'block':
        return codeBlock(r.input);
      case 'bullet':
      case 'number':
      case 'quote':
        return prefixLines(r.input, kind);
      case 'link':
        return link(r.input);
      case 'transform':
        return r.openMenu(
          $<HTMLElement>('[data-fmt="transform"]', fmtBar),
          'Change the text (what’s selected, or all of it)',
          TRANSFORMS.map((t) => ({ label: t.label, desc: t.desc, value: t.id })),
          (id) => {
            if (!transform(r.input, id)) r.showPop('Nothing to change there.', 1400);
          },
        );
    }
  }
  fmtBar.addEventListener('mousedown', (e) => e.preventDefault()); // (the selection stays in the box)
  fmtBar.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-fmt]');
    const kind = b?.dataset.fmt;
    if (kind) format(kind);
  });

  r.input.addEventListener('input', () => {
    recallAt = -1; // (typing: ↑ starts from the newest again)
    autosize();
    r.updatePalette();
    r.state.lastActivity = Date.now();
    // watch the user type
    r.lookAt(r.state.placement === 'right' ? 200 : -200, 0, 1200); // at the chat beside it
    r.body.classList.add('typing');
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => r.body.classList.remove('typing'), 1200);
  });
  r.input.addEventListener('click', () => r.updatePalette());
  r.input.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') r.updatePalette();
  });
  r.input.addEventListener('keydown', (e) => {
    if (!r.paletteEl.hidden && r.paletteKey(e)) return;
    // number keys pick an option while a question is waiting and the box is empty
    const q = r.active()?.question;
    if (q && !q.sent && !r.input.value && /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      q.pickByNumber(Number(e.key));
      return;
    }
    // Shift+Tab: the next permission mode (plan mode among them), as in Claude Code
    if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      r.cycleMode();
      return;
    }
    // formatting keys, as in an editor
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      const kind =
        k === 'b'
          ? 'bold'
          : k === 'i'
            ? 'italic'
            : k === 'k'
              ? 'link'
              : k === 'e'
                ? e.shiftKey
                  ? 'block'
                  : 'code'
                : '';
      if (kind) {
        e.preventDefault();
        format(kind);
        return;
      }
    }
    if (
      (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.isComposing &&
      recall(e.key === 'ArrowUp' ? -1 : 1)
    ) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      r.submit();
    }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    r.submit();
  });
  // Esc peels back one layer: command list, then history, then off to sleep
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !r.state.awake) return;
    if (!r.menuEl.hidden) r.closeMenu();
    else if (!r.paletteEl.hidden) r.hidePalette();
    else if (cancelEdit()) return;
    else if (r.history.isOpen()) r.history.stepBack();
    else if (r.helperView.id || r.helperView.call || r.helperView.file) r.backFromView();
    else if (r.active()?.busy)
      r.stopTab(r.active()); // like Claude Code: Esc interrupts
    else r.sleep();
  });
  $('#btn-history').addEventListener('click', () => (r.history.isOpen() ? r.history.close() : r.openHistory()));
  $('#btn-remote').addEventListener('click', () => r.toggleRemote());
  $('#btn-shell').addEventListener('click', () => r.toggleShell());
  // the ■ button always means stop, even with a draft in the box
  $('#send').addEventListener('click', (e) => {
    if (!r.active()?.busy) return;
    e.preventDefault();
    r.stopTab(r.active());
  });
  // off to the robot island (with the island turned off: just to sleep; Esc still sleeps)
  $('#btn-island').addEventListener('click', () => (r.islandOn ? r.peek() : r.sleep()));
  $('#btn-collapse').addEventListener('click', () => r.collapse());
  $('#btn-reset').addEventListener('click', () => ipc.robotReset(r.activeId ?? undefined));
  $('#folder').addEventListener('click', () => ipc.robotOpenFolder());
  return {
    autosize,
    cancelEdit,
    editBanner,
    msgActions,
    rawText,
    sentOf,
    takeBack,
    get editing() {
      return editing;
    },
    set editing(v) {
      editing = v;
    },
    get recallAt() {
      return recallAt;
    },
    set recallAt(v) {
      recallAt = v;
    },
  };
}
export type ComposerApi = ReturnType<typeof createComposer>;
