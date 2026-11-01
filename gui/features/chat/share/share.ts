// A shared chat (app/src/features/share): one of this robot's tabs watched by colleagues on the
// office network. The host's side: the share card, the strip saying who's watching and who's
// asking to come in, and the guests' suggestions as cards to send, edit or decline. A visiting
// robot's side: the strip, a box that suggests instead of asking, and what became of each
// suggestion. (robot.ts calls createSharing with its hub.)
import { $, el } from '@/lib/dom';
import type { ChatTab, RobotState } from '@/views/robot/types';
import type { ChatEvent, SharePerson, ShareView } from '@/types/model';
import type { AskingApi } from '../reply/ask';
import type { CommentaryApi } from '../reply/commentary';
import type { ChatLogApi } from '../log';
import type { TabsApi } from '../tabs/tabs';
import type { PlansApi } from '../plan/card';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { FaceApi } from '@/views/robot/life/face';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import { Icon } from '@/icons/icons';
import { Sfx } from '@/views/robot/sound';
import * as ipc from '@/ipc';
import { mineCard, setMine, suggestionCard, type SuggestionChoice } from './cards';
import { type CardActions, minutesLeft, personRow, sharingCard, startCard } from './card';
import { createTalk } from './talk';
import { commentCard, decisionCard, noteRecommendation, recommendCard, settleDecision } from './decisions';
import { createCommentPick } from './comment';
import type { ChatMarkdownApi } from '../reply/local-files';

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
  readonly express: FaceApi['express'];
  readonly flash: FaceApi['flash'];
  readonly setActivity: DeskActivityApi['setActivity'];
  readonly restingActivity: DeskActivityApi['restingActivity'];
  readonly strikePose: DeskActivityApi['strikePose'];
  readonly pendingQuestion: PlansApi['pendingQuestion'];
  readonly wake: LifeCycleApi['wake'];
  readonly md: ChatMarkdownApi['md'];
};

export function createSharing(r: SharingNeeds) {
  let view: ShareView | null = null;
  const strip = $('#share-strip');
  const btn = $<HTMLButtonElement>('#btn-share');
  const mine = new Map<string, HTMLElement>(); // (a visitor's own suggestions, by id)
  let pop: HTMLElement | null = null;
  let ticker: number | undefined;

  let unread = 0; // (said in the people's panel while it's shut)
  const talk = createTalk({
    send: async (text, quote) => {
      try {
        if (quote) await ipc.shareComment(quote, text);
        else await ipc.shareTalk(text);
        return true;
      } catch (e) {
        const tab = sharedTab();
        if (tab) r.addNote(`🔗 ${String(e)}`, '', tab);
        return false;
      }
    },
    unread: (n) => {
      unread = n;
      renderStrip();
    },
  });
  const decisions = new Map<string, HTMLElement>(); // (a visitor's decision cards, by request)

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
    const talking = el('button', 'share-stop share-talk-btn', unread ? `💬 Talk (${unread})` : '💬 Talk');
    talking.type = 'button';
    talking.classList.toggle('unread', unread > 0);
    talking.addEventListener('click', () => talk.toggle());
    if (view.role === 'guest') {
      line.append(el('span', '', `👀 Watching ${view.host.name}’s tab`));
      line.append(el('span', 'share-where', ` · ${view.host.pc} · ${view.host.ip}`));
      line.append(talking, leaveButton());
    } else {
      const names = view.people.map((p) => p.name).join(', ');
      line.append(el('span', '', names ? `🔗 Shared with ${names}` : '🔗 Sharing: nobody’s in yet'));
      line.append(el('span', 'share-where', ` · ${view.internet ? 'internet · ' : ''}${minutesLeft(view.endsAt)}`));
      const manage = el('button', 'share-stop', 'Invite…');
      manage.type = 'button';
      manage.addEventListener('click', () => openCard());
      const stop = el('button', 'share-stop danger', 'Stop sharing');
      stop.type = 'button';
      stop.addEventListener('click', () => ipc.shareStop());
      line.append(talking, manage, stop);
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
    start: async (fromNow, toolOutput, internet) => {
      const tab = r.current();
      try {
        setView(await ipc.shareStart(tab.id, fromNow, toolOutput, internet));
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
    if (ev.type === 'share-arrived') return arrived();
    if (ev.type === 'share-ended') return ended(ev.reason, tab);
    return onPeople(ev, tab);
  }

  // ---------------------------------------------------------------- the people in it

  /** What the people in the chat said, and (on a visitor) what waits for the host. */
  function onPeople(ev: ShareEvent, tab: ChatTab) {
    if (ev.type === 'share-talk') {
      talk.add({ kind: 'talk', from: ev.from, text: ev.text, mine: ev.mine });
      if (!ev.mine) Sfx.pop();
    } else if (ev.type === 'share-comment') {
      talk.add({ kind: 'comment', from: ev.from, quote: ev.quote, text: ev.text, found: ev.found });
      if (hosting())
        toLog(
          tab,
          commentCard(ev.from, ev.quote, ev.text, ev.found, () => useComment(ev.from.name, ev.quote, ev.text)),
        );
    } else if (ev.type === 'share-recommend') {
      talk.add({ kind: 'recommend', from: ev.from, choice: ev.choice, why: ev.why });
      if (hosting()) recommended(tab, ev.requestId, ev.from, ev.choice, ev.why);
      else {
        const card = decisions.get(ev.requestId);
        if (card && !card.classList.contains('recommended')) noteRecommendation(card, ev.from, ev.choice, ev.why);
      }
    } else if (ev.type === 'share-decision') {
      const d = ev.decision;
      const card = decisionCard(d, view?.host.name ?? 'The host', r.md, async (choice, why) => {
        try {
          await ipc.shareRecommend(d.requestId, choice, why);
          return true;
        } catch (e) {
          r.addNote(`🔗 ${String(e)}`, '', tab);
          return false;
        }
      });
      decisions.get(d.requestId)?.remove();
      decisions.set(d.requestId, card);
      toLog(tab, card);
      Sfx.ask();
    } else if (ev.type === 'share-decided') {
      const card = decisions.get(ev.requestId);
      if (card) settleDecision(card, view?.host.name ?? 'The host', ev.outcome);
      decisions.delete(ev.requestId);
    }
  }

  function toLog(tab: ChatTab, card: HTMLElement) {
    tab.log.append(card);
    r.scrollDown(tab);
    Sfx.ask();
  }

  const recs = new Map<string, HTMLElement>(); // (the host's recommendation cards: one per guest per decision)

  /** A guest's recommendation: a card, the same guest's last one on that decision replaced. */
  function recommended(tab: ChatTab, requestId: string, from: SharePerson, choice: string, why: string) {
    const key = `${requestId}|${from.name}|${from.pc}|${from.ip}`;
    const card = recommendCard(from, choice, why);
    const was = recs.get(key);
    recs.set(key, card);
    if (was?.isConnected) was.replaceWith(card);
    else toLog(tab, card);
  }

  /** A guest's comment, into what you're typing: quoted, so you (and Claude) can tell it isn't
   * your own words. You send it, if you like. */
  function useComment(from: string, quote: string, text: string) {
    const quoted = (s: string) =>
      s
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    const said = `${quoted(`${from} (a guest in this chat) commented on “${quote}”:`)}\n${quoted(text)}\n\n`;
    r.input.value = r.input.value.trim() ? `${r.input.value.trim()}\n\n${said}` : said;
    r.autosize();
    r.input.focus();
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
    handUp();
  }

  // While a guest's suggestion waits for you, your robot keeps its hand up (as for a question
  // from Claude), with a ? on it while the chat is put away; down again once none is left.
  function handUp() {
    Sfx.ask();
    r.express('open', 'o', 1500);
    r.state.pose = null; // (drop any wave or stretch in progress)
    r.setActivity('ask');
    if (!r.state.awake) {
      $('#badge').textContent = '?';
      r.body.classList.add('has-badge');
    }
  }

  function handDown() {
    if (cards.size) return;
    if (!r.pendingQuestion()) {
      r.body.classList.remove('has-badge');
      $('#badge').textContent = '!';
    }
    r.setActivity(r.restingActivity());
  }

  async function choose(id: string, text: string, from: string, c: SuggestionChoice, tab: ChatTab) {
    cards.get(id)?.remove();
    cards.delete(id);
    handDown();
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
    handDown();
  }

  function ended(reason: string, tab: ChatTab) {
    for (const c of cards.values()) c.remove();
    cards.clear();
    handDown();
    talk.reset();
    decisions.clear();
    recs.clear();
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
    // (a link badge on the robot: it's a colleague's, visiting, not one of yours)
    const badge = $('#visit-badge');
    badge.innerHTML = Icon('link', 'sm');
    badge.title = 'Visiting';
    badge.hidden = false;
    r.input.placeholder = `Suggest a prompt to ${v.host.name}…`;
    $('#send').title = 'Suggest';
    createCommentPick($('#logs'), (quote) => talk.open(quote));
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

  /** It has walked in to its desk: awake (its chat still put away), a hop and a wave hello. */
  function arrived() {
    r.wake({ sayHi: false, tucked: true });
    Sfx.pop();
    r.express('happy', 'smile', 1800);
    setTimeout(() => {
      r.flash('hop', 500);
      r.strikePose('wave', 1200);
    }, 400);
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
