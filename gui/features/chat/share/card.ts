// The share card under the header's link button: before sharing, what colleagues will see and
// the button to start; while sharing, invite links (one per person), who's in, who's asking,
// and Stop. (share.ts opens it.)
import { el } from '@/lib/dom';
import type { SharePerson, ShareView } from '@/types/model';
import { initial } from './cards';

/** What the card can ask for. */
export type CardActions = {
  start: (fromNow: boolean, toolOutput: boolean, internet: boolean) => void;
  invite: () => Promise<string | null>;
  admit: (conn: number, yes: boolean) => void;
  stop: () => void;
  close: () => void;
};

/** The card before sharing: what they'll see, then Start. */
export function startCard(tabTitle: string, a: CardActions): HTMLElement {
  const card = el('div', 'share-pop');
  card.append(el('h3', '', 'Share this tab'));
  card.append(
    el('p', 'share-sub', `Colleagues with C-Bot can watch “${tabTitle}” and suggest prompts. Only you can send them.`),
  );
  card.append(el('div', 'share-label', 'Network'));
  const net = el('div', 'share-net');
  const lan = option('🏢', 'Office network', 'Same network as you');
  const web = option('🌍', 'Internet', 'From anywhere');
  let internet = false;
  const pick = (on: boolean) => {
    internet = on;
    lan.classList.toggle('on', !on);
    web.classList.toggle('on', on);
    lan.setAttribute('aria-pressed', String(!on));
    web.setAttribute('aria-pressed', String(on));
  };
  lan.addEventListener('click', () => pick(false));
  web.addEventListener('click', () => pick(true));
  pick(false);
  net.append(lan, web);
  card.append(
    net,
    el('p', 'share-sub', 'Either way it’s encrypted end to end: only you and the people you let in can read it.'),
  );
  card.append(el('div', 'share-label', 'What they see'));
  const [all, allBox] = radio('share-from', 'The whole chat', true);
  const [now] = radio('share-from', 'Only from now on', false);
  const [tools, toolsBox] = checkbox('What tools read and ran (file contents, command output)');
  card.append(all, now, tools);
  card.append(
    el(
      'p',
      'share-warn',
      '⚠ They’ll see your messages and the answers, which can hold code, file paths and anything pasted in.',
    ),
  );
  const rules = el('ul', 'share-rules');
  for (const r of [
    '💬 Their prompts wait for your Send',
    '📋 They see Claude’s plans and questions too, and can recommend (you decide)',
    '🚫 They can’t run anything on your PC',
    '⏱ It stops after an hour',
  ])
    rules.append(el('li', '', r));
  card.append(rules);
  card.append(
    buttons([
      ['Cancel', a.close, false],
      ['Start sharing', () => a.start(!allBox.checked, toolsBox.checked, internet), true],
    ]),
  );
  return card;
}

/** The card while sharing: invites, who's in, who's asking, Stop. */
export function sharingCard(v: ShareView, tabTitle: string, a: CardActions): HTMLElement {
  const card = el('div', 'share-pop');
  card.append(el('h3', '', `Sharing “${tabTitle}”`));
  const where = v.internet ? 'over the internet' : `on ${v.host.ip} (${v.host.pc})`;
  card.append(el('p', 'share-sub', `${minutesLeft(v.endsAt)} · ${where}`));
  card.append(el('div', 'share-label', 'Invite someone'));
  const row = el('div', 'share-invite');
  const copy = el('button', 'share-btn primary', 'Copy invite link');
  copy.type = 'button';
  const said = el('span', 'share-said', 'A new link each time: for one person, once, for 10 minutes.');
  copy.addEventListener('click', async () => {
    const link = await a.invite();
    if (!link) return;
    await navigator.clipboard.writeText(link);
    said.textContent = `Copied! Send it to one person. They need C-Bot${v.internet ? '' : ', on this network'}.`;
  });
  row.append(copy, said);
  card.append(row);
  if (v.asking.length) {
    card.append(el('div', 'share-label', 'Asking to join'));
    for (const q of v.asking)
      card.append(
        personRow(q.person, [
          ['Deny', () => a.admit(q.conn, false), false],
          ['Let in', () => a.admit(q.conn, true), true],
        ]),
      );
  }
  card.append(el('div', 'share-label', v.people.length ? 'Watching' : 'Nobody’s watching yet'));
  for (const p of v.people) card.append(personRow(p, []));
  card.append(
    buttons(
      [
        ['Close', a.close, false],
        ['Stop sharing', a.stop, false],
      ],
      'danger',
    ),
  );
  return card;
}

/** Someone, with where they are (so a made-up name can't hide who it is). */
export function personRow(p: SharePerson, acts: [string, () => void, boolean][]): HTMLElement {
  const row = el('div', 'share-person');
  row.append(el('span', 'share-face', initial(p.name)), el('b', '', p.name));
  row.append(el('span', 'share-where', [p.pc, p.ip].filter(Boolean).join(' · ')));
  if (acts.length) row.append(buttons(acts));
  return row;
}

export function minutesLeft(endsAt: number): string {
  const m = Math.max(0, Math.ceil((endsAt - Date.now()) / 60000));
  return m === 1 ? '1 min left' : `${m} min left`;
}

function option(icon: string, name: string, detail: string): HTMLButtonElement {
  const o = el('button', 'share-opt');
  o.type = 'button';
  const words = el('span', 'share-opt-words');
  words.append(el('b', '', name), el('small', '', detail));
  o.append(el('span', 'share-opt-icon', icon), words);
  return o;
}

function radio(name: string, label: string, on: boolean): [HTMLElement, HTMLInputElement] {
  const l = el('label', 'share-check');
  const i = el('input');
  i.type = 'radio';
  i.name = name;
  i.checked = on;
  l.append(i, label);
  return [l, i];
}

function checkbox(label: string): [HTMLElement, HTMLInputElement] {
  const l = el('label', 'share-check');
  const i = el('input');
  i.type = 'checkbox';
  l.append(i, label);
  return [l, i];
}

function buttons(list: [string, () => void, boolean][], last = ''): HTMLElement {
  const row = el('div', 'share-acts');
  list.forEach(([label, go, primary], i) => {
    const b = el(
      'button',
      `share-btn${primary ? ' primary' : ''}${last && i === list.length - 1 ? ` ${last}` : ''}`,
      label,
    );
    b.type = 'button';
    b.addEventListener('click', go);
    row.append(b);
  });
  return row;
}
