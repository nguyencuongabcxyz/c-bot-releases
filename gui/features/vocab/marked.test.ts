import { describe, expect, test } from 'vitest';
import { marked } from './marked';

describe('marked', () => {
  test('the word and its endings', () => {
    expect(marked("She's meticulous.", 'meticulous')).toBe('She&#39;s <mark>meticulous</mark>.');
    expect(marked('Done meticulously.', 'meticulous')).toBe('Done <mark>meticulously</mark>.');
    expect(marked('Still deciding.', 'decide')).toBe('Still <mark>deciding</mark>.');
  });
  test('a phrase, across any spaces', () => {
    expect(marked('Leave things  to the last minute.', 'leave things to the last minute')).toBe(
      '<mark>Leave things  to the last minute</mark>.',
    );
    expect(marked('Never give   up.', 'give up')).toBe('Never <mark>give   up</mark>.');
  });
  test("a verb's other forms", () => {
    const vf = { base: 'go', third: 'goes', past: 'went', participle: 'gone', ing: 'going', irregular: true };
    expect(marked('She went home.', 'go', vf)).toBe('She <mark>went</mark> home.');
    expect(marked('He has gone.', 'go', vf)).toBe('He has <mark>gone</mark>.');
  });
  test('the sentence is escaped, and nothing marked with no word', () => {
    expect(marked('<b>x</b>', '')).toBe('&lt;b&gt;x&lt;/b&gt;');
    expect(marked('a (b) c', '(b)')).toBe('a (b) c');
  });
});
