import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@/views/robot/types';
import { forgetDoneCalls, trimLog } from './trim';

function log(n: number, top = '') {
  const el = document.createElement('div');
  el.innerHTML = top + Array.from({ length: n }, (_, i) => `<div class="msg">${i}</div>`).join('');
  return el;
}

describe('trimLog', () => {
  it('keeps only the latest messages', () => {
    const l = log(10);
    trimLog(l, 4);
    expect([...l.children].map((c) => c.textContent)).toEqual(['6', '7', '8', '9']);
  });

  it('leaves a short chat as it is', () => {
    const l = log(3);
    trimLog(l, 4);
    expect(l.children).toHaveLength(3);
  });

  it('keeps a temporary chat’s note on top', () => {
    const l = log(6, '<div class="note temp-note">temp</div>');
    trimLog(l, 2);
    expect([...l.children].map((c) => c.textContent)).toEqual(['temp', '4', '5']);
  });
});

describe('forgetDoneCalls', () => {
  it('forgets the steps that are over and keeps the running ones', () => {
    const call = (id: string, running: boolean) =>
      [id, { id, name: 'Read', detail: '', running }] as [string, ToolCall];
    const calls = new Map([call('a', false), call('b', true)]);
    forgetDoneCalls(calls);
    expect([...calls.keys()]).toEqual(['b']);
  });
});
