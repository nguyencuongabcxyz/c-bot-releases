// The English choices on Find the English: whether each is in My words, and who put it there.
import type { FindChoice } from '@/types/pages';

/** Not saved; saved from this window (☆ takes it back); or one you had before (it stays). */
export type SaveState = 'new' | 'mine' | 'had';

/** Where a choice stands, given the ids saved from this window. */
export function saveState(choice: FindChoice, savedHere: ReadonlySet<string>): SaveState {
  if (!choice.saved) return 'new';
  return savedHere.has(choice.saved) ? 'mine' : 'had';
}

/** What its ☆ button says. */
export const SAVE_LABEL: Record<SaveState, string> = { new: 'Save', mine: 'Saved', had: 'In My words' };
