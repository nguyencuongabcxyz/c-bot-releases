// A shared chat (app/src/features/share): one of this robot's tabs watched by colleagues on the
// office network. The host's side: the share card, the strip saying who's watching and who's
// asking to come in, and the guests' suggestions as cards to send, edit or decline. A visiting
// robot's side: the strip, a box that suggests instead of asking, and what became of each
// suggestion. (robot.ts calls createSharing with its hub.)
import { $, el } from '@/lib/dom';
import type { ChatTab, RobotState } from '@/views/robot/types';
import type { ChatEvent, ShareView } from '@/types/model';
import type { AskingApi } from '../reply/ask';
import type { CommentaryApi } from '../reply/commentary';
import type { ChatLogApi } from '../log';
import type { TabsApi } from '../tabs';
import { Sfx } from '@/views/robot/sound';
import * as ipc from '@/ipc';
import { mineCard, setMine, suggestionCard, type SuggestionChoice } from './cards';
import { type CardActions, minutesLeft, personRow, sharingCard, startCard } from './card';

type ShareEvent = Extract<ChatEvent, { type: `share-${string}` }>;

/** What it uses of the robot window (robot.ts's hub). */
export type SharingNeeds = {
  readonly active: () => ChatTab | undefined;
  readonly current: () => ChatTab;
  readonly tabs: Map<string, ChatTab>;
  readonly state: RobotState;
  readonly body: HTMLElement;
  readonly input: HTMLTextAreaElement;
  readonly autosize: () => void;
  readonly submit: AskingApi['submit'];
  readonly addNote: CommentaryApi['addNote'];
  readonly scrollDown: ChatLogApi['scrollDown'];
  readonly renderTabs: TabsApi['renderTabs'];
};

export function createSharing(r: SharingNeeds) {
  let view: ShareView | null = null;
  const strip = $('#share-strip');
  const btn = $<HTMLButtonElement>('#btn-share');
  const mine = new Map<string, HTMLElement>(); // (a visitor's own suggestions, by id)
  let pop: HTMLElement | null = null;
  let ticker: number | undefined;

  const sharedTab = () => (view ? r.tabs.get(view.tabId) : undefined);
  const hosting = () => view?.role === 'host';

  /** A robot window's start: part of a shared chat already (a reload), or visiting. */
  function init(v: ShareView | null) {
    if (v?.role === 'guest') visit(v);
    if (v) setView(v);
  }

  function setView(v: ShareView | null) {
    const was = sharedTab();
    view = v;
    if (was?.data) was.data.shared = false;
    const t = sharedTab();
    if (t?.data) t.data.shared = !!v;
    btn.classList.toggle('on', hosting());
    clearInterval(ticker);
    if (hosting()) ticker = window.setInterval(renderStrip, 30000);
    renderStrip();
    r.renderTabs();
    if (pop) openCard(); // (what it shows changed)
  }

  // ---------------------------------------------------------------- the strip

  function renderStrip() {
    strip.replaceChildren();
    strip.hidden = !view;
    if (!view) return;
    strip.classList.toggle('guest', view.role === 'guest');
    const line = el('div', 'share-line');
    if (view.role === 'guest') {
      line.append(el('span', '', `👀 Watching ${view.host.name}’s tab`));
      line.append(el('span', 'share-where', ` · ${view.host.pc} · ${view.host.ip}`));
      line.append(leaveButton());
    } else {
      const names = view.people.map((p) => p.name).join(', ');
      line.append(el('span', '', names ? `🔗 Shared with ${names}` : '🔗 Sharing: nobody’s in yet'));
      line.append(el('span', 'share-where', ` · ${minutesLeft(view.endsAt)}`));
      const manage = el('button', 'share-stop', 'Invite…');
      manage.type = 'button';
      manage.addEventListener('click', () => openCard());
      const stop = el('button', 'share-stop danger', 'Stop sharing');
      stop.type = 'button';
      stop.addEventListener('click', () => ipc.shareStop());
      line.append(manage, stop);
    }
    strip.append(line);
    for (const q of view.asking)
      strip.append(
        personRow(q.person, [
          ['Deny', () => ipc.shareAdmit(q.conn, false), false],
          ['Let in', () => ipc.shareAdmit(q.conn, true), true],
        ]),
      );
  }

  function leaveButton() {
    const b = el('button', 'share-stop', 'Leave');
    b.type = 'button';
    b.addEventListener('click', () => ipc.shareLeave());
    return b;
  }

  // ---------------------------------------------------------------- the card (the host's)

  const actions: CardActions = {
    start: async (fromNow, toolOutput) => {
      const tab = r.current();
      try {
        setView(await ipc.shareStart(tab.id, fromNow, toolOutput));
      } catch (e) {
        closeCard();
        r.addNote(`🔗 ${String(e)}`, '', tab);
      }
    },
    invite: () => ipc.shareInvite().catch(() => null),
    admit: (conn, yes) => ipc.shareAdmit(conn, yes),
    stop: () => ipc.shareStop(),
    close: () => closeCard(),
  };

  function openCard() {
    pop?.remove();
    const tab = view ? (sharedTab() ?? r.current()) : r.current();
    pop = view ? sharingCard(view, tab.title, actions) : startCard(tab.title, actions);
    $('#panel').append(pop);
  }

  function closeCard() {
    pop?.remove();
    pop = null;
  }

  function toggleCard() {
    if (pop) closeCard();
    else openCard();
  }

  // ---------------------------------------------------------------- what happens

  function onShare(ev: ShareEvent, tab: ChatTab) {
    if (ev.type === 'share-state') return onState(ev.state);
    if (ev.type === 'share-suggest') return onSuggest(ev, tab);
    if (ev.type === 'share-taken-back') return takenBack(ev.id, tab);
    if (ev.type === 'share-suggestion') return onSuggestion(ev);
    return ended(ev.reason, tab);
  }

  function onState(v: ShareView) {
    const asking = (view?.asking.length ?? 0) < v.asking.length;
    setView(v);
    if (asking) Sfx.ask(); // (someone's at the door)
  }

  const cards = new Map<string, HTMLElement>(); // (the host's suggestion cards, by id)

  function onSuggest(ev: Extract<ShareEvent, { type: 'share-suggest' }>, tab: ChatTab) {
    const card = suggestionCard(ev.from, ev.text, ev.hidden, (c) => choose(ev.id, ev.text, ev.from.name, c, tab));
    cards.set(ev.id, card);
    tab.log.append(card);
    r.scrollDown(tab);
    Sfx.ask();
  }

  async function choose(id: string, text: string, from: string, c: SuggestionChoice, tab: ChatTab) {
    cards.get(id)?.remove();
    cards.delete(id);
    if (c === 'decline') return ipc.shareAnswer(id, 'declined');
    const draft = r.input.value;
    r.input.value = text;
    if (c === 'edit') {
      r.autosize();
      r.input.focus();
      return ipc.shareAnswer(id, 'editing');
    }
    if (r.active() !== tab) return; // (the card is only seen in its tab)
    const sent = r.submit({ tag: `🔗 From ${from}` });
    r.input.value = draft; // (what you were typing stays)
    r.autosize();
    await sent;
    ipc.shareAnswer(id, 'sent');
  }

  function takenBack(id: string, tab: ChatTab) {
    const card = cards.get(id);
    if (!card) return;
    cards.delete(id);
    card.replaceWith(el('div', 'msg note', 'They took that suggestion back.'));
    r.scrollDown(tab);
  }

  function ended(reason: string, tab: ChatTab) {
    for (const c of cards.values()) c.remove();
    cards.clear();
    const visiting = view?.role === 'guest';
    closeCard();
    setView(null);
    r.addNote(`🔗 ${reason}`, '', tab);
    if (visiting) {
      r.input.disabled = true;
      r.input.placeholder = 'The shared chat has ended.';
    }
  }

  // ---------------------------------------------------------------- visiting

  function visit(v: ShareView) {
    r.state.visitor = true;
    r.body.classList.add('visiting');
    r.input.placeholder = `Suggest a prompt to ${v.host.name}…`;
    $('#send').title = 'Suggest';
    // (nothing in a visitor's chat opens a file here: the paths are on someone else's PC)
    $('#logs').addEventListener(
      'click',
      (e) => {
        if ((e.target as Element).closest('[data-open], .file-chip, .file-path')) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true,
    );
  }

  /** The composer's Enter on a visiting robot: a suggestion, not a question. Whether it was. */
  function suggestInstead(): boolean {
    if (!r.state.visitor) return false;
    const text = r.input.value.trim();
    if (!text || r.input.disabled) return true;
    const tab = r.current();
    r.input.value = '';
    r.autosize();
    ipc.shareSuggest(text).then(
      (id) => {
        const card = mineCard(text, () => ipc.shareTakeBack(id).then(() => card.remove()));
        setMine(card, 'waiting', view?.host.name ?? '', '');
        mine.set(id, card);
        tab.log.append(card);
        r.scrollDown(tab);
        Sfx.key.send();
      },
      (e) => r.addNote(`🔗 Not sent: ${String(e)}`, '', tab),
    );
    return true;
  }

  function onSuggestion(ev: Extract<ShareEvent, { type: 'share-suggestion' }>) {
    const card = mine.get(ev.id);
    if (!card) return;
    if (ev.state === 'sent') {
      card.remove(); // (it's in the chat now, as the host's message)
      mine.delete(ev.id);
      return;
    }
    setMine(card, ev.state, view?.host.name ?? '', ev.why ?? '');
  }

  btn.addEventListener('click', toggleCard);
  return { init, onShare, suggestInstead };
}
export type SharingApi = ReturnType<typeof createSharing>;
