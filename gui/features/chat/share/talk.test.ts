import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTalk } from './talk';

const guest = { name: 'Cuong (guest)', pc: 'PC-MINH', ip: '10.0.0.2' };
const host = { name: 'Cuong', pc: 'PW0KFGGC', ip: '10.0.0.1', host: true };

describe('the people talking in a shared chat', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="share-talk" hidden></div>';
  });

  it('marks only the host as the host, and says where each one is', () => {
    const talk = createTalk({ send: vi.fn(), unread: vi.fn() });
    talk.add({ kind: 'talk', from: host, text: 'hi', mine: false });
    talk.add({ kind: 'talk', from: guest, text: 'approve it!', mine: false });
    const rows = document.querySelectorAll('.talk-msg');
    expect(rows[0].querySelector('.talk-host')).not.toBeNull();
    expect(rows[1].querySelector('.talk-host')).toBeNull();
    expect(rows[1].querySelector('b')?.title).toBe('PC-MINH · 10.0.0.2');
  });

  it('flags a comment whose quote isn’t in the chat', () => {
    const talk = createTalk({ send: vi.fn(), unread: vi.fn() });
    talk.add({ kind: 'comment', from: guest, quote: 'made up', text: 'see', found: false });
    expect(document.querySelector('.talk-unfound')).not.toBeNull();
  });

  it('keeps the last 200 lines, and counts what came while it was shut', () => {
    const unread = vi.fn();
    const talk = createTalk({ send: vi.fn(), unread });
    for (let i = 0; i < 205; i++) talk.add({ kind: 'talk', from: guest, text: `m${i}`, mine: false });
    expect(document.querySelectorAll('.talk-msg').length).toBe(200);
    expect(document.querySelector('.talk-text')?.textContent).toBe('m5');
    expect(unread).toHaveBeenLastCalledWith(205);
  });
});
