// The cards a shared chat puts in the log: on the host's side, a guest's suggestion to send,
// edit or decline (raw text, never markdown, so nothing in it is hidden or runs); on a
// visiting robot's, your own suggestion and what became of it.
import { el } from '@/lib/dom';
import type { SharePerson, SuggestionState } from '@/types/model';

/** What the host can do with a suggestion. */
export type SuggestionChoice = 'send' | 'edit' | 'decline';

/** A guest's suggestion, for the host. */
export function suggestionCard(
  from: SharePerson,
  text: string,
  hidden: boolean,
  choose: (c: SuggestionChoice) => void,
): HTMLElement {
  const card = el('div', 'msg share-card share-suggest');
  const head = el('div', 'share-head');
  head.append(el('span', 'share-face', initial(from.name)), el('b', '', `${from.name} suggests`));
  head.append(el('span', 'share-where', ` · ${from.pc || from.ip}`));
  card.append(head);
  if (hidden)
    card.append(el('div', 'share-warn', '⚠ It has characters you can’t see, shown here as ⟨U+…⟩. Read it carefully.'));
  card.append(el('div', 'share-text', text)); // (textContent: shown exactly as it came)
  const acts = el('div', 'share-acts');
  const buttons: [SuggestionChoice, string][] = [
    ['decline', 'Decline'],
    ['edit', 'Edit'],
    ['send', 'Send'],
  ];
  for (const [c, label] of buttons) {
    const b = el('button', c === 'send' ? 'share-btn primary' : 'share-btn', label);
    b.type = 'button';
    b.addEventListener('click', () => choose(c));
    acts.append(b);
  }
  card.append(acts);
  return card;
}

/** Your own suggestion, on a visiting robot: its words, then where it's at. */
export function mineCard(text: string, takeBack: () => void): HTMLElement {
  const card = el('div', 'msg share-mine');
  card.append(el('div', 'share-text', text));
  const state = el('div', 'share-state');
  card.append(state);
  setMine(card, 'waiting', '', '');
  state.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.share-take-back')) takeBack();
  });
  return card;
}

/** Where your suggestion is at, in words. */
export function mineLine(state: SuggestionState, host: string, why: string): string {
  switch (state) {
    case 'waiting':
      return `Waiting for ${host}`;
    case 'sent':
      return `${host} sent it`;
    case 'editing':
      return `${host} is editing it`;
    case 'declined':
      return `${host} declined it`;
    case 'refused':
      return `Not sent: ${why || 'it can’t be suggested.'}`;
  }
}

export function setMine(card: HTMLElement, state: SuggestionState, host: string, why: string) {
  const line = card.querySelector('.share-state');
  if (!line) return;
  card.dataset.state = state;
  line.textContent = mineLine(state, host || 'the host', why);
  if (state === 'waiting') {
    const b = el('button', 'share-take-back', 'Take back');
    b.type = 'button';
    line.append(' · ', b);
  }
}

export function initial(name: string): string {
  return (name.trim()[0] || '?').toUpperCase();
}
