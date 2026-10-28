import { expect, test } from 'vitest';
import { clock } from './time';

test('clock: hours and minutes as the system writes them', () => {
  const t = new Date(2026, 9, 28, 9, 41, 30).getTime();
  expect(clock(t)).toBe(new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  expect(clock(t)).toMatch(/09.41|9.41/);
});
