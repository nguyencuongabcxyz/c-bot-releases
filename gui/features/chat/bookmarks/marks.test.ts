import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '@/types/model';
import { type Mark, marksOf, snippet } from './marks';

const history: HistoryEntry[] = [
  { role: 'user', text: 'Why?', at: 1, bookmarked: true },
  { role: 'assistant', text: 'Because.', at: 2 },
  { role: 'note', text: '🔨 Bonked!', at: 3 },
  { role: 'assistant', text: 'Later.', at: 4, bookmarked: true },
];

describe('marksOf', () => {
  it('lists the bookmarked questions and answers, oldest first', () => {
    expect(marksOf(history, new Map()).map((m) => m.at)).toEqual([1, 4]);
  });

  it('goes by what was marked and unmarked since', () => {
    const fresh: Mark = { at: 9, role: 'user', text: 'Just asked' };
    const changed = new Map<number, Mark | null>([
      [1, null],
      [2, { at: 2, role: 'assistant', text: 'Because.' }],
      [9, fresh],
    ]);
    expect(marksOf(history, changed).map((m) => m.at)).toEqual([2, 4, 9]);
  });
});

describe('snippet', () => {
  it('reads as one line, without the markdown', () => {
    expect(snippet('# Title\n\n**Bold** and `code` and [a link](http://x)')).toBe('Title Bold and code and a link');
    expect(snippet('Look:\n```ts\nconst a = 1;\n```\nDone')).toBe('Look: [code] Done');
  });

  it('is cut short when long', () => {
    const s = snippet('word '.repeat(40), 20);
    expect(s.length).toBeLessThanOrEqual(20);
    expect(s.endsWith('…')).toBe(true);
    expect(snippet('   ')).toBe('…');
  });
});
