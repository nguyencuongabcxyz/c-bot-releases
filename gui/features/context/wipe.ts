// Deleting what the context optimizer keeps (app/src/context/wipe.rs), in words: what the Context
// optimizer window asks before it does, and what it says once it's done. Pure (tested); the window
// (views/context/context.ts) asks and says.
import type { ContextRepo, ContextWipe, ContextWiped } from '@/types/model';
import { baseName, size } from './details';

/** Names in a sentence: "A", "A and B", "A, B and C". */
export function names(list: string[]): string {
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** What the window asks before deleting one folder's index. */
export function forgetQuestion(r: ContextRepo): string {
  const off = r.robots.length ? ` The context optimizer will be switched off for ${names(r.robots)}.` : '';
  return `Delete the index of ${baseName(r.root)}?${off} Its files stay as they are: switching the optimizer on again reads them afresh.`;
}

/** What it asks before deleting every index, or everything (`downloads`: their bytes). */
export function wipeQuestion(what: ContextWipe, downloads: number): string {
  const off = ' The context optimizer will be switched off for every robot.';
  if (what === 'indexes')
    return `Delete every folder’s index?${off} The downloads stay: switching the optimizer on again only reads the folders afresh.`;
  const again = downloads ? ` (${size(downloads)})` : '';
  return `Delete everything the context optimizer keeps: every index, PostgreSQL, the models and ONNX Runtime?${off} Switching it on again downloads them again${again}.`;
}

/** What it says once it's done (`what`: what was deleted, `freed`: say how much). */
export function wipedText(what: string, w: ContextWiped, freed = true): string {
  const parts = [freed && w.freed ? `${what}: ${size(w.freed)} freed.` : `${what}.`];
  if (w.robots.length) parts.push(`The context optimizer is off for ${names(w.robots)}.`);
  if (w.later) parts.push('Some of it was in use: it goes the next time C-Bot starts.');
  return parts.join(' ');
}
