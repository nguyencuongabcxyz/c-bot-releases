// Small text helpers: escaping for markup, counting words, comparing paths.

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text made safe to put in markup, inside an element or an attribute (null and undefined: ''). */
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** "1 robot", "3 robots"; `many` for a word that doesn't just take an s ("2 matches"). */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A Windows path to compare with another: backslashes, lower case (so C:/a and c:\A are the same file). */
export const samePath = (p: string | null | undefined) =>
  String(p || '')
    .replace(/\//g, '\\')
    .toLowerCase();
