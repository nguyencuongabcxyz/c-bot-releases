import { describe, expect, test } from 'vitest';
import { esc, plural, samePath } from './text';

describe('esc', () => {
  test('escapes what markup would read', () => {
    expect(esc(`<a href="x">Tom & Jerry's</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
  });
  test('null and undefined are empty, other values are their string', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(0)).toBe('0');
    expect(esc('')).toBe('');
  });
});

describe('plural', () => {
  test('one and many', () => {
    expect(plural(1, 'robot')).toBe('1 robot');
    expect(plural(0, 'robot')).toBe('0 robots');
    expect(plural(3, 'robot')).toBe('3 robots');
  });
  test('a word with its own plural', () => {
    expect(plural(1, 'match', 'matches')).toBe('1 match');
    expect(plural(2, 'match', 'matches')).toBe('2 matches');
  });
});

describe('samePath', () => {
  test('slashes and case do not matter', () => {
    expect(samePath('C:/Users/Me/a.PNG')).toBe(samePath('c:\\users\\me\\a.png'));
  });
  test('nothing is empty', () => {
    expect(samePath(undefined)).toBe('');
  });
});
