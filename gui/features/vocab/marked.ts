// A word highlighted where it's used in a sentence (the word card, Find the English).
import { esc } from '@/lib/text';
import type { VerbForms } from '@/types/model';

/**
 * The sentence as safe markup, the word in <mark>: its endings too (meticulously, deciding),
 * and a verb's other forms (went, gone; gave up).
 */
export function marked(sentence: string, w: string, verbForms?: VerbForms | null): string {
  const safe = esc(sentence);
  const pattern = (s: string) =>
    String(s || '')
      .trim()
      .split(/\s+/)
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
  const stem = pattern(w);
  if (!stem) return safe;
  // a long single word matches without its last letter too (decide -> deciding)
  const root = stem.length > 5 && !stem.includes('\\s') ? stem.slice(0, -1) : stem;
  const forms = verbForms
    ? [verbForms.past, verbForms.participle, verbForms.third, verbForms.ing]
        .flatMap((f) => String(f || '').split('/'))
        .map(pattern)
        .filter(Boolean)
    : [];
  const alts = [...new Set(forms)].sort((a, b) => b.length - a.length);
  return safe.replace(new RegExp(`\\b(${[...alts, `${root}\\w*`].join('|')})`, 'gi'), '<mark>$1</mark>');
}
