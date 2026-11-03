// A tab's bookmarked messages, as its list shows them (chat/bookmarks/bookmarks.ts): what its
// history says, with what was marked or unmarked since (main's copy may not have come back yet).
import type { HistoryEntry } from '@/types/model';

/** A bookmarked question or answer: when it went into the history, and its words. */
export type Mark = { at: number; role: 'user' | 'assistant'; text: string };

/** The bookmarks, oldest first: the history's, but `changed` wins (a Mark: marked since, null: unmarked). */
export function marksOf(history: HistoryEntry[], changed: Map<number, Mark | null>): Mark[] {
  const marks = new Map<number, Mark>();
  for (const h of history) {
    if ((h.role === 'user' || h.role === 'assistant') && h.bookmarked) {
      marks.set(h.at, { at: h.at, role: h.role, text: h.text });
    }
  }
  for (const [at, m] of changed) {
    if (m) marks.set(at, m);
    else marks.delete(at);
  }
  return [...marks.values()].sort((a, b) => a.at - b.at);
}

/** A message's words on one line, the markdown marks left off, cut to `max`. */
export function snippet(text: string, max = 90): string {
  const line = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>|~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line || '…';
}
