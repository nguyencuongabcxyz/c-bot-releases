// Saved chats as the picker lists them: which ones a search finds, and the line under each.
import type { SavedRow } from '@/types/model';
import { ago } from '@/lib/time';

/** The emoji offered for a saved chat (any other can be typed in its name's place). */
export const EMOJIS = ['⭐', '🛒', '🚀', '🐛', '🧪', '📐', '📝', '💡', '🔧', '📦', '🎨', '🔥'];

/** The saved chats a search finds: every word of it in the name, the emoji or its first title. */
export function findSaved(rows: SavedRow[], query: string): SavedRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((s) => {
    const text = `${s.emoji} ${s.name} ${s.title ?? ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** What's under a saved chat's name: when it was last talked in, how long it is, where it is. */
export function savedLine(s: SavedRow, now = Date.now()): string {
  if (s.gone) return 'its conversation is gone';
  const bits = [];
  if (s.updatedAt) bits.push(ago(s.updatedAt, now));
  if (s.messages) bits.push(`${s.messages} messages`);
  if (s.current) bits.push('this tab');
  else if (s.tabId) bits.push('open in a tab');
  return bits.join(' · ');
}
