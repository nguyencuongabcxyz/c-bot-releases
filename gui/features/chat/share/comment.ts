// On a visiting robot: select a piece of the chat and a 📍 Comment button comes up by it, to say
// something about exactly that to the people in the chat (where the host's robots offer "Ask
// about this", which a visitor can't: it has no Claude Code). (share.ts makes one.)
import { Icon } from '@/icons/icons';
import { el } from '@/lib/dom';

const QUOTE_MAX = 300;

/** The button by a selection in the chat; `pick` gets what was selected. */
export function createCommentPick(logs: HTMLElement, pick: (quote: string) => void) {
  const b = Icon.text(el('button', 'share-pick'), '📍 Comment');
  b.type = 'button';
  b.hidden = true;
  document.body.append(b);
  let quote = '';
  const hide = () => {
    b.hidden = true;
    quote = '';
  };
  b.addEventListener('mousedown', (e) => e.preventDefault()); // (the selection stays)
  b.addEventListener('click', () => {
    const q = quote;
    hide();
    getSelection()?.removeAllRanges();
    if (q) pick(q);
  });
  document.addEventListener('mouseup', (e) => {
    if (e.target === b) return;
    setTimeout(() => {
      const sel = getSelection();
      const text = sel && !sel.isCollapsed ? sel.toString().replace(/\s+/g, ' ').trim() : '';
      if (!sel || text.length < 2) return hide();
      const range = sel.getRangeAt(0);
      const at = range.commonAncestorContainer;
      const msg = (at instanceof Element ? at : at.parentElement)?.closest('.msg');
      if (!msg || !logs.contains(msg)) return hide();
      quote = text.slice(0, QUOTE_MAX);
      const r = range.getBoundingClientRect();
      b.hidden = false;
      const [w, h] = [b.offsetWidth, b.offsetHeight];
      b.style.left = `${Math.round(Math.max(4, Math.min(innerWidth - w - 4, r.left + r.width / 2 - w / 2)))}px`;
      b.style.top = `${Math.round(r.top - h - 8 < 4 ? r.bottom + 8 : r.top - h - 8)}px`;
    });
  });
  document.addEventListener('mousedown', (e) => {
    if (e.target !== b) hide();
  });
}
