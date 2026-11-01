// The people in a shared chat talking among themselves (never to Claude): a panel under the
// strip with what's been said, commented and recommended, and a line to say something. A
// comment on a piece of the chat goes from here too, its quote shown above the line. (share.ts
// makes one.)
import { Icon } from '@/icons/icons';
import { $, el } from '@/lib/dom';
import type { SharePerson } from '@/types/model';
import { initial } from './cards';

/** One thing said in the panel. */
export type TalkLine =
  | { kind: 'talk'; from: SharePerson; text: string; mine: boolean }
  | { kind: 'comment'; from: SharePerson; quote: string; text: string; found: boolean }
  | { kind: 'recommend'; from: SharePerson; choice: string; why: string };

type TalkNeeds = {
  /** Say it (with the quote it's about, for a comment). False: it didn't go. */
  send: (text: string, quote: string) => Promise<boolean>;
  /** Something new while the panel's shut. */
  unread: (n: number) => void;
};

/** How many lines the panel keeps (the oldest go). */
const KEEP = 200;

export function createTalk(r: TalkNeeds) {
  const panel = $('#share-talk');
  const list = el('div', 'talk-list');
  const about = el('div', 'talk-quote');
  about.hidden = true;
  const input = el('textarea', 'talk-input');
  input.rows = 1;
  input.placeholder = 'Talk to everyone here (not to Claude)…';
  panel.replaceChildren(list, about, input);
  let quote = '';
  let unread = 0;

  /** What a line says, in words. */
  function words(l: TalkLine): HTMLElement {
    const row = el('div', `talk-msg talk-${l.kind}${l.kind === 'talk' && l.mine ? ' mine' : ''}`);
    row.append(el('span', 'share-face', initial(l.from.name)));
    const body = el('div', 'talk-body');
    const name = el('b', '', l.from.name);
    name.title = [l.from.pc, l.from.ip].filter(Boolean).join(' · '); // (where they really are)
    body.append(name);
    // (the host's own words: only the host can mark them so)
    if (l.from.host) body.append(Icon.text(el('span', 'talk-host'), '👑 host'));
    if (l.kind === 'comment') {
      body.append(el('span', 'talk-about', ` on “${l.quote}”`));
      if (!l.found) body.append(el('span', 'talk-unfound', ' (not found in the chat)'));
    }
    if (l.kind === 'recommend')
      body.append(el('span', 'talk-about', ` recommends ${l.choice}${l.why ? `: ${l.why}` : ''}`));
    else body.append(el('div', 'talk-text', l.text));
    row.append(body);
    return row;
  }

  function add(l: TalkLine) {
    list.append(words(l));
    while (list.children.length > KEEP) list.firstElementChild?.remove();
    list.scrollTop = list.scrollHeight;
    if (panel.hidden) r.unread(++unread);
  }

  function open(withQuote = '') {
    panel.hidden = false;
    unread = 0;
    r.unread(0);
    setQuote(withQuote);
    list.scrollTop = list.scrollHeight;
    input.focus();
  }

  function setQuote(q: string) {
    quote = q;
    about.hidden = !q;
    Icon.text(about, q ? `📍 Commenting on “${q}”` : '');
    input.placeholder = q ? 'Your comment… (Esc: just talk)' : 'Talk to everyone here (not to Claude)…';
  }

  function toggle() {
    if (panel.hidden) open();
    else panel.hidden = true;
  }

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape' && quote) {
      e.preventDefault();
      setQuote('');
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (await r.send(text, quote)) setQuote('');
    else input.value = text;
  });

  /** The share is over: nothing said is kept. */
  function reset() {
    panel.hidden = true;
    list.replaceChildren();
    setQuote('');
    unread = 0;
    r.unread(0);
  }

  return { add, open, toggle, reset };
}
export type TalkApi = ReturnType<typeof createTalk>;
