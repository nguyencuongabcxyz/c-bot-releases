// The little card under a tab just saved (or starred again): its name and emoji to change,
// and Unsave. It's saved already, so the card goes away by itself if you leave it be.
import { $, el } from '@/lib/dom';
import { Icon } from '@/icons/icons';
import type { SavedChat } from '@/types/model';
import { EMOJIS } from './match';

const LINGER_MS = 6000;

export const SaveCard = ({
  onChange,
  onUnsave,
}: {
  /** A new name or emoji for it. */
  onChange: (chat: SavedChat, name: string, emoji: string) => void;
  onUnsave: (chat: SavedChat) => void;
}) => {
  // (its elements: always in the chat's markup, robot/robot.html)
  const card = $('#save-card');
  const panel = $('#panel');
  const name = $<HTMLInputElement>('#sc-name');
  const emojiBtn = $<HTMLButtonElement>('#sc-emoji');
  const emojis = $('#sc-emojis');
  let chat: SavedChat | null = null;
  let emoji = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listening: AbortController | null = null;

  for (const e of EMOJIS) {
    const b = el('button', '', e);
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.addEventListener('click', () => {
      emoji = e;
      showEmoji();
      emojis.hidden = true;
      name.focus();
    });
    emojis.appendChild(b);
  }

  function showEmoji() {
    if (emoji) emojiBtn.textContent = emoji;
    else emojiBtn.innerHTML = Icon('star', 'sm');
  }

  /** Show it under `anchor` (the tab) for this saved chat. */
  function open(c: SavedChat, anchor: Element | null) {
    chat = c;
    emoji = c.emoji;
    name.value = c.name;
    showEmoji();
    emojis.hidden = true;
    card.hidden = false;
    const p = panel.getBoundingClientRect();
    const a = anchor?.getBoundingClientRect();
    const left = a ? a.left - p.left : 10;
    card.style.left = `${Math.max(8, Math.min(left, p.width - card.offsetWidth - 8))}px`;
    card.style.top = `${a ? a.bottom - p.top + 6 : 80}px`;
    linger();
    listening?.abort();
    listening = new AbortController();
    const { signal } = listening;
    // (outside it, or Esc: done, keeping what was typed)
    document.addEventListener('pointerdown', (e) => card.contains(e.target as Node) || close(true), { signal });
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || card.hidden) return;
        e.stopPropagation(); // (Esc puts the robot to sleep otherwise)
        close(true);
      },
      { capture: true, signal },
    );
  }

  // it stays while you're in it, and goes a while after you leave it be
  function linger() {
    clearTimeout(timer);
    if (!card.matches(':hover') && !card.contains(document.activeElement)) {
      timer = setTimeout(() => close(true), LINGER_MS);
    }
  }

  function close(keep: boolean) {
    if (card.hidden) return;
    clearTimeout(timer);
    listening?.abort();
    listening = null;
    card.hidden = true;
    const c = chat;
    chat = null;
    const typed = name.value.trim();
    if (keep && c && typed && (typed !== c.name || emoji !== c.emoji)) onChange(c, typed, emoji);
  }

  card.addEventListener('pointerenter', () => clearTimeout(timer));
  card.addEventListener('pointerleave', linger);
  card.addEventListener('focusin', () => clearTimeout(timer));
  card.addEventListener('focusout', () => setTimeout(linger));
  emojiBtn.addEventListener('click', () => (emojis.hidden = !emojis.hidden));
  name.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    close(true);
  });
  $('#sc-done').addEventListener('click', () => close(true));
  $('#sc-unsave').addEventListener('click', () => {
    const c = chat;
    close(false);
    if (c) onUnsave(c);
  });

  return { open, close: () => close(true), isOpen: () => !card.hidden };
};
