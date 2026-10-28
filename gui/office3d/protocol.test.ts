import { expect, test } from 'vitest';
import { officeData, readJson, writeJson } from './protocol';

test("officeData is the element's own dataset: writes land as data-* attributes", () => {
  const el = document.createElement('div');
  const d = officeData(el);
  d.screen = 'code';
  d.sleepStyle = 'floor';
  d.lateNight = '1';
  expect(el.getAttribute('data-screen')).toBe('code');
  expect(el.getAttribute('data-sleep-style')).toBe('floor');
  el.dataset.pose = 'sleep';
  expect(d.pose).toBe('sleep');
});

test('JSON attributes go there and back', () => {
  const d = officeData(document.createElement('div'));
  writeJson(d, 'board', { items: [{ id: 'a', text: 'Buy milk' }], total: 1 });
  expect(readJson<'board'>(d.board, { items: [] })).toEqual({ items: [{ id: 'a', text: 'Buy milk' }], total: 1 });
  writeJson(d, 'vocabStickies', [{ id: 'w1', text: 'serendipity', sub: 'tình cờ' }]);
  expect(readJson<'vocabStickies'>(d.vocabStickies, [])).toEqual([{ id: 'w1', text: 'serendipity', sub: 'tình cờ' }]);
});

test('readJson falls back on nothing or nonsense', () => {
  expect(readJson<'visitNotes'>(undefined, [])).toEqual([]);
  expect(readJson<'visitNotes'>('', [])).toEqual([]);
  expect(readJson<'board'>('{not json', { total: 0 })).toEqual({ total: 0 });
});
