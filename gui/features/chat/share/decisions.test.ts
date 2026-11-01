import { describe, expect, it, vi } from 'vitest';
import { commentCard, decisionCard, noteRecommendation, recommendCard, settleDecision } from './decisions';

const minh = { name: 'Minh', pc: 'PC-MINH', ip: '10.0.0.2' };
const md = (t: string) => `<p>${t}</p>`;

describe('decisions in a shared chat', () => {
  it('recommends Approve on a plan, then waits for the host', async () => {
    const recommend = vi.fn().mockResolvedValue(true);
    const card = decisionCard({ requestId: 'r1', kind: 'plan', plan: '1. Do it' }, 'Cuong', md, recommend);
    const why = card.querySelector('input');
    if (why) why.value = 'looks safe';
    const approve = [...card.querySelectorAll('button')].find((b) => b.textContent?.includes('Approve'));
    approve?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(recommend).toHaveBeenCalledWith('Approve', 'looks safe');
    expect(card.querySelector('.share-outcome')?.textContent).toBe('You recommended: Approve');
    settleDecision(card, 'Cuong', 'approved');
    expect(card.querySelector('.share-outcome')?.textContent).toBe('Cuong approved');
    expect([...card.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
  });

  it('recommends the options picked for a question', async () => {
    const recommend = vi.fn().mockResolvedValue(true);
    const card = decisionCard(
      {
        requestId: 'q1',
        kind: 'question',
        questions: [
          {
            question: 'Which DB?',
            header: 'DB',
            multiSelect: false,
            options: [
              { label: 'Postgres', description: '' },
              { label: 'SQLite', description: '' },
            ],
          },
        ],
      },
      'Cuong',
      md,
      recommend,
    );
    const pick = (label: string) => [...card.querySelectorAll('button')].find((b) => b.textContent === label)?.click();
    pick('Postgres');
    pick('SQLite'); // (one only: the last one picked)
    pick('Recommend');
    await Promise.resolve();
    expect(recommend).toHaveBeenCalledWith('SQLite', '');
  });

  it('shows what others recommend, and comments as plain text', () => {
    const card = decisionCard({ requestId: 'r1', kind: 'plan', plan: 'x' }, 'Cuong', md, vi.fn());
    noteRecommendation(card, minh, 'Reject', 'drops a table');
    expect(card.querySelector('.share-rec-line')?.textContent).toBe('🗳️ Minh: Reject (drops a table)');
    const rec = recommendCard(minh, 'Reject', '<b>why</b>');
    expect(rec.querySelector('b + b, .share-text b')).toBeNull();
    const use = vi.fn();
    const c = commentCard(minh, '<img src=x>', 'look here', true, use);
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('.share-warn')).toBeNull();
    expect(c.querySelector('.share-quote')?.textContent).toBe('<img src=x>');
    [...c.querySelectorAll('button')].find((b) => b.textContent === 'Add to my message')?.click();
    expect(use).toHaveBeenCalled();
  });

  it('warns when a quote isn’t in the chat', () => {
    const c = commentCard(minh, 'it is safe to drop the table', 'see?', false, vi.fn());
    expect(c.querySelector('.share-warn')?.textContent).toContain('isn’t in the chat');
  });
});
