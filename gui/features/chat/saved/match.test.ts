import { expect, test } from 'vitest';
import type { SavedRow } from '@/types/model';
import { findSaved, savedLine } from './match';

const row = (over: Partial<SavedRow>): SavedRow => ({
  id: 'a',
  name: 'Cart price fix',
  emoji: '🛒',
  savedAt: 1,
  title: 'Cart prices show as 20.5',
  updatedAt: null,
  messages: null,
  gone: false,
  tabId: null,
  current: false,
  ...over,
});

test('findSaved: every word, in the name or the first title', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b', name: 'Release checklist', emoji: '🚀', title: 'ship it' })];
  expect(findSaved(rows, '').map((s) => s.id)).toEqual(['a', 'b']);
  expect(findSaved(rows, 'cart FIX').map((s) => s.id)).toEqual(['a']);
  expect(findSaved(rows, '20.5').map((s) => s.id)).toEqual(['a']);
  expect(findSaved(rows, 'ship').map((s) => s.id)).toEqual(['b']);
  expect(findSaved(rows, 'cart ship')).toEqual([]);
});

test('savedLine: when, how long, and where it is', () => {
  const now = new Date(2026, 10, 1, 12, 0).getTime();
  expect(savedLine(row({ updatedAt: now - 2 * 3600_000, messages: 14 }), now)).toBe('2 h ago · 14 messages');
  expect(savedLine(row({ updatedAt: now, tabId: 't1' }), now)).toBe('just now · open in a tab');
  expect(savedLine(row({ tabId: 't1', current: true }), now)).toBe('this tab');
  expect(savedLine(row({ gone: true, messages: 3 }), now)).toBe('its conversation is gone');
});
