import { describe, expect, it } from 'vitest';
import type { HistoryEntry, RobotSent } from '@/types/model';
import { withHistories } from './histories';

const said = (text: string) => ({ role: 'user', text }) as HistoryEntry;
const robot = (tabs: RobotSent['tabs']) => ({ tabs }) as RobotSent; // (only its tabs matter here)
const tab = (id: string, history?: HistoryEntry[]) =>
  ({ id, title: id, sessionId: null, createdAt: 0, custom: false, busy: false, history }) as RobotSent['tabs'][number];

describe('withHistories', () => {
  it('keeps a conversation that was sent', () => {
    const c = withHistories(robot([tab('a', [said('new')])]), () => [said('old')]);
    expect(c.tabs[0].history).toEqual([said('new')]);
  });

  it('fills in one that was not sent from what the page had', () => {
    const c = withHistories(robot([tab('a')]), (id) => (id === 'a' ? [said('kept')] : undefined));
    expect(c.tabs[0].history).toEqual([said('kept')]);
  });

  it('starts a tab the page never had empty', () => {
    expect(withHistories(robot([tab('b')]), () => undefined).tabs[0].history).toEqual([]);
  });
});
