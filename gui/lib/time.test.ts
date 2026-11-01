import { expect, test } from 'vitest';
import { ago, clock } from './time';

test('clock: hours and minutes as the system writes them', () => {
  const t = new Date(2026, 9, 28, 9, 41, 30).getTime();
  expect(clock(t)).toBe(new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  expect(clock(t)).toMatch(/09.41|9.41/);
});

test('ago: minutes, hours, days, then the date', () => {
  const now = new Date(2026, 10, 1, 12, 0).getTime();
  const min = 60_000;
  expect(ago(now - 20_000, now)).toBe('just now');
  expect(ago(now - 5 * min, now)).toBe('5 min ago');
  expect(ago(now - 3 * 60 * min, now)).toBe('3 h ago');
  expect(ago(now - 30 * 60 * min, now)).toBe('yesterday');
  expect(ago(now - 4 * 24 * 60 * min, now)).toBe('4 days ago');
  const old = now - 30 * 24 * 60 * min;
  expect(ago(old, now)).toBe(new Date(old).toLocaleDateString());
});
