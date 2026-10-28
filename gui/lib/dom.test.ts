import { beforeEach, describe, expect, test } from 'vitest';
import { $, el, iconButton } from './dom';

beforeEach(() => {
  document.body.innerHTML = '<div id="box"><p class="line">hi</p></div>';
});

describe('$', () => {
  test('finds an element, in the document or under a root', () => {
    expect($('#box').id).toBe('box');
    expect($('.line', $('#box')).textContent).toBe('hi');
  });
  test('throws when nothing matches', () => {
    expect(() => $('#missing')).toThrow('#missing');
  });
});

describe('el', () => {
  test('tag, class and text', () => {
    const p = el('span', 'tag big', 'hello');
    expect(p.tagName).toBe('SPAN');
    expect(p.className).toBe('tag big');
    expect(p.textContent).toBe('hello');
  });
  test('text is text, never markup', () => {
    expect(el('div', '', '<b>x</b>').children.length).toBe(0);
  });
  test('no class attribute when there is none', () => {
    expect(el('div').hasAttribute('class')).toBe(false);
  });
});

describe('iconButton', () => {
  test('a button with its icon and label', () => {
    const b = iconButton('mini', 'Copy', 'copy', 'Copy');
    expect(b.type).toBe('button');
    expect(b.title).toBe('Copy');
    expect(b.className).toBe('mini');
    expect(b.querySelector('svg')).not.toBeNull();
    expect(b.textContent).toBe('Copy');
  });
});
