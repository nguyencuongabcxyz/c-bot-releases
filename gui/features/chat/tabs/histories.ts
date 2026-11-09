// A robot's tabs as main sends them (RobotSent): a tab's conversation only when it changed.
// The page fills in the ones it already has, so the rest of it reads a whole RobotView.
import type { HistoryEntry, RobotSent, RobotView } from '@/types/model';

/** The robot with every tab's conversation: as sent, or (not sent: unchanged) as the page had it. */
export function withHistories(c: RobotSent, had: (tabId: string) => HistoryEntry[] | undefined): RobotView {
  return { ...c, tabs: c.tabs.map((t) => ({ ...t, history: t.history ?? had(t.id) ?? [] })) };
}
