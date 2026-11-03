import { describe, expect, it } from 'vitest';
import { dragOrder, runs } from './groups';

describe('tab groups in the strip', () => {
  it('puts a group where its first tab is, with all of its tabs', () => {
    expect(
      runs([{ id: 'a' }, { id: 'b', group: 'g' }, { id: 'c' }, { id: 'd', group: 'g' }, { id: 'e', group: null }]),
    ).toEqual([
      { kind: 'tab', id: 'a' },
      { kind: 'group', group: 'g', ids: ['b', 'd'] },
      { kind: 'tab', id: 'c' },
      { kind: 'tab', id: 'e' },
    ]);
  });

  it('shows a group of one as a tab of its own', () => {
    expect(runs([{ id: 'a', group: 'g' }, { id: 'b' }])).toEqual([
      { kind: 'tab', id: 'a' },
      { kind: 'tab', id: 'b' },
    ]);
  });

  it('moves a tab past a folded group as past all of its tabs', () => {
    // strip: a | [b c] (folded) | d — a dragged to the end
    expect(dragOrder([['a'], ['b', 'c'], ['d']], 0, 2)).toEqual(['b', 'c', 'd', 'a']);
    // d dragged to the front
    expect(dragOrder([['a'], ['b', 'c'], ['d']], 2, 0)).toEqual(['d', 'a', 'b', 'c']);
    // d dragged before the group
    expect(dragOrder([['a'], ['b', 'c'], ['d']], 2, 1)).toEqual(['a', 'd', 'b', 'c']);
  });
});
