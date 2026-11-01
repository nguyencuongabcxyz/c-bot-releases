import { describe, expect, it } from 'vitest';
import { cardTitle } from './helper-card';

describe('cardTitle', () => {
  it('counts helpers back', () => {
    expect(cardTitle([{ status: 'running' }, { status: 'completed' }])).toBe('Helpers  1/2 back');
    expect(cardTitle([{ status: 'completed' }, { status: 'failed' }])).toBe('2 helpers  all back');
  });

  it('counts commands apart from helpers', () => {
    expect(cardTitle([{ status: 'running', command: true }])).toBe('1 command running');
    expect(
      cardTitle([
        { status: 'failed', command: true },
        { status: 'completed', command: true },
      ]),
    ).toBe('2 commands done');
    expect(cardTitle([{ status: 'running' }, { status: 'running', command: true }])).toBe(
      'Helpers  0/1 back · 1 command running',
    );
  });
});
