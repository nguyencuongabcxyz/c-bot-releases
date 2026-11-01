// Weighing in on what waits for the host, and pointing at the chat. On a visiting robot: a
// plan or a question the host's robot is waiting on, to recommend what to do (the host still
// decides), and what became of it. On the host's: a guest's recommendation, and a comment on a
// piece of the chat with the button that puts it in your next message. All raw text, but the
// plan (markdown, through the visitor's renderer: no pictures, no file links).
import { el } from '@/lib/dom';
import type { SharePerson, ShareDecision } from '@/types/model';
import { initial } from './cards';

function head(icon: string, text: string): HTMLElement {
  const h = el('div', 'share-head');
  h.append(el('span', 'share-face share-icon', icon), el('b', '', text));
  return h;
}

function button(label: string, cls: string, go: () => void): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', go);
  return b;
}

/** A plan or a question waiting for the host, for a guest to weigh in on. */
export function decisionCard(
  d: ShareDecision,
  host: string,
  md: (text: string) => string,
  recommend: (choice: string, why: string) => Promise<boolean>,
): HTMLElement {
  const card = el('div', 'msg share-card share-decision');
  card.dataset.request = d.requestId;
  const why = el('input', 'share-why');
  why.placeholder = 'Why? (optional)';
  why.maxLength = 500;
  const acts = el('div', 'share-acts');
  const go = async (choice: string) => {
    if (!choice || card.classList.contains('settled')) return;
    if (!(await recommend(choice, why.value.trim()))) return;
    card.classList.add('recommended');
    for (const b of card.querySelectorAll('button')) b.disabled = true;
    why.disabled = true;
    footer(card, `You recommended: ${choice}`);
  };
  if (d.kind === 'plan') {
    card.append(head('📋', `${host}’s robot has a plan, waiting for ${host}`));
    const plan = el('div', 'share-plan');
    plan.innerHTML = md(d.plan); // (sanitized markdown, no pictures or file links)
    card.append(plan, why);
    acts.append(
      button('👎 Reject', 'share-btn', () => go('Reject')),
      button('👍 Approve', 'share-btn primary', () => go('Approve')),
    );
  } else {
    card.append(head('❓', `${host}’s robot is asking ${host}`));
    const picked = d.questions.map(() => new Set<string>());
    d.questions.forEach((q, i) => {
      card.append(el('div', 'share-question', q.question));
      const opts = el('div', 'share-options');
      for (const o of q.options) {
        const b = button(o.label, 'share-opt-pick', () => {
          if (!q.multiSelect) {
            picked[i].clear();
            for (const x of opts.children) x.classList.remove('on');
          }
          if (picked[i].has(o.label)) picked[i].delete(o.label);
          else picked[i].add(o.label);
          b.classList.toggle('on', picked[i].has(o.label));
        });
        if (o.description) b.title = o.description;
        opts.append(b);
      }
      card.append(opts);
    });
    card.append(why);
    const choice = () =>
      d.questions
        .map((q, i) =>
          picked[i].size
            ? `${d.questions.length > 1 ? `${q.header || q.question}: ` : ''}${[...picked[i]].join(', ')}`
            : '',
        )
        .filter(Boolean)
        .join('; ');
    acts.append(button('Recommend', 'share-btn primary', () => go(choice())));
  }
  card.append(acts);
  return card;
}

function footer(card: HTMLElement, text: string) {
  let f = card.querySelector<HTMLElement>('.share-outcome');
  if (!f) {
    f = el('div', 'share-outcome');
    card.append(f);
  }
  f.textContent = text;
}

/** What the host did about it. */
export function settleDecision(card: HTMLElement, host: string, outcome: string) {
  card.classList.add('settled');
  for (const b of card.querySelectorAll('button')) b.disabled = true;
  for (const i of card.querySelectorAll('input')) i.disabled = true;
  footer(card, `${host} ${outcome}`);
}

/** Someone else's recommendation, under the card it's about. */
export function noteRecommendation(card: HTMLElement, from: SharePerson, choice: string, why: string) {
  const line = el('div', 'share-rec-line', `🗳️ ${from.name}: ${choice}${why ? ` (${why})` : ''}`);
  card.querySelector('.share-acts')?.before(line);
}

/** For the host: a guest recommends what to do about what's waiting. */
export function recommendCard(from: SharePerson, choice: string, why: string): HTMLElement {
  const card = el('div', 'msg share-card share-rec');
  const h = el('div', 'share-head');
  h.append(el('span', 'share-face', initial(from.name)), el('b', '', `${from.name} recommends: ${choice}`));
  h.append(el('span', 'share-where', ` · ${from.pc || from.ip}`));
  card.append(h);
  if (why) card.append(el('div', 'share-text', why));
  return card;
}

/** For the host: a guest's comment on a piece of the chat, to put in your next message. */
export function commentCard(
  from: SharePerson,
  quote: string,
  text: string,
  found: boolean,
  use: () => void,
): HTMLElement {
  const card = el('div', 'msg share-card share-comment');
  const h = el('div', 'share-head');
  h.append(el('span', 'share-face', initial(from.name)), el('b', '', `${from.name} commented`));
  h.append(el('span', 'share-where', ` · ${from.pc || from.ip}`));
  card.append(h, el('blockquote', 'share-quote', quote));
  // (what a guest quotes is theirs to say: the host looks for it in the chat first)
  if (!found) card.append(el('div', 'share-warn', '⚠ This quote isn’t in the chat as it stands. Read it with care.'));
  card.append(el('div', 'share-text', text));
  const acts = el('div', 'share-acts');
  acts.append(
    button('Dismiss', 'share-btn', () => card.remove()),
    button('Add to my message', 'share-btn primary', () => {
      use();
      card.remove();
    }),
  );
  card.append(acts);
  return card;
}
