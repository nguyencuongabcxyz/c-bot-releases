// The English choices on Find the English: whether each is in My words, and who put it there.
import type { FindChoice, FindDetail, FindEnglish } from '@/types/pages';

/** Not saved; saved from this window (☆ takes it back); or one you had before (it stays). */
export type SaveState = 'new' | 'mine' | 'had';

/** Where a choice stands, given the ids saved from this window. */
export function saveState(choice: FindChoice, savedHere: ReadonlySet<string>): SaveState {
  if (!choice.saved) return 'new';
  return savedHere.has(choice.saved) ? 'mine' : 'had';
}

/** What its ☆ button says. */
export const SAVE_LABEL: Record<SaveState, string> = { new: 'Save', mine: 'Saved', had: 'In My words' };

/**
 * A choice's details, into the list they belong to (their search's): the saved mark stays as
 * the list has it (you may have saved it meanwhile). False if they're another search's.
 */
export function withDetail(found: FindEnglish | null, d: FindDetail): boolean {
  const had = found?.id === d.id ? found.choices[d.index] : undefined;
  if (!found || !had) return false;
  found.choices[d.index] = { ...d.choice, saved: had.saved };
  return true;
}
