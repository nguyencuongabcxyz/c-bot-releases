import { describe, expect, it } from 'vitest';
import { initial, mineCard, mineLine, setMine, suggestionCard } from './cards';
import { minutesLeft } from './card';

describe('shared chat cards', () => {
  it('says where a suggestion is at', () => {
    expect(mineLine('waiting', 'Cuong', '')).toBe('Waiting for Cuong');
    expect(mineLine('declined', 'Cuong', '')).toBe('Cuong declined it');
    expect(mineLine('refused', 'Cuong', 'It’s empty.')).toBe('Not sent: It’s empty.');
  });

  it('shows a suggestion as plain text, never as markup', () => {
    const card = suggestionCard(
      { name: 'Minh', pc: 'PC-MINH', ip: '10.0.0.2' },
      '<img src=x onerror=alert(1)>',
      false,
      () => {},
    );
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('.share-text')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(card.querySelector('.share-warn')).toBeNull();
  });

  it('warns about characters you can’t see', () => {
    const card = suggestionCard({ name: 'Minh', pc: '', ip: '10.0.0.2' }, 'a⟨U+200B⟩b', true, () => {});
    expect(card.querySelector('.share-warn')).not.toBeNull();
    expect(card.querySelector('.share-where')?.textContent).toContain('10.0.0.2');
  });

  it('offers to take back only while waiting', () => {
    const card = mineCard('hi', () => {});
    setMine(card, 'waiting', 'Cuong', '');
    expect(card.querySelector('.share-take-back')).not.toBeNull();
    setMine(card, 'editing', 'Cuong', '');
    expect(card.querySelector('.share-take-back')).toBeNull();
    expect(card.dataset.state).toBe('editing');
  });

  it('names people by their first letter and counts minutes left', () => {
    expect(initial(' minh')).toBe('M');
    expect(initial('')).toBe('?');
    expect(minutesLeft(Date.now() + 52 * 60000 - 1000)).toBe('52 min left');
    expect(minutesLeft(Date.now() - 1)).toBe('0 min left');
  });
});
