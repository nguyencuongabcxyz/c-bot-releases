import { expect, test } from 'vitest';
import { stepSummary, tokens, usageText } from './steps';

test('an answer says what it used: all it read, the cached part, what it wrote, the cost', () => {
  const t = { input: 2, output: 1234, cacheRead: 18488, cacheWrite: 7884 };
  expect(usageText(t, 0.0812)).toBe('↑ 26k in (18k cached) · ↓ 1.2k out · $0.08');
  expect(usageText(t, 0.004)).toBe('↑ 26k in (18k cached) · ↓ 1.2k out · <$0.01');
  expect(usageText({ input: 900, output: 5, cacheRead: 0, cacheWrite: 0 })).toBe('↑ 900 in · ↓ 5 out');
});

test('a Read says how many lines', () => {
  expect(stepSummary('Read', 'a\nb\nc')).toEqual(['Read 3 lines']);
  expect(stepSummary('Read', 'a')).toEqual(['Read 1 line']);
  expect(stepSummary('Read', '')).toEqual(['Empty file']);
});

test('a Grep counts matches (not "matchs")', () => {
  expect(stepSummary('Grep', 'x.ts:1\ny.ts:2')).toEqual(['2 matches']);
  expect(stepSummary('Grep', 'x.ts:1')).toEqual(['1 match']);
  expect(stepSummary('Grep', 'Found 4 files\na\nb')).toEqual(['Found 4 files']);
  expect(stepSummary('Grep', 'No matches found')).toEqual(['No matches']);
});

test('a shell shows its first three lines, then how many more', () => {
  expect(stepSummary('Bash', '1\n2\n3\n4\n5')).toEqual(['1', '2', '3', '… +2 lines']);
  expect(stepSummary('Bash', '')).toEqual(['(no output)']);
});

test('nothing while it runs; an error shows its first line', () => {
  expect(stepSummary('Read', undefined)).toEqual([]);
  expect(stepSummary('Read', '<tool_use_error>No such file</tool_use_error>', true)).toEqual(['No such file']);
});

test('tokens in short words', () => {
  expect([870, 1234, 34_000].map(tokens)).toEqual(['870', '1.2k', '34k']);
});
