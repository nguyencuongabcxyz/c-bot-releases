// A long chat kept short on the page: a session of hundreds of answers would otherwise keep
// every one in the page, and every restyle and resize (dragging the chat's edge, opening it)
// would lay them all out again. Its whole history is still kept: older answers come back
// as they always do, from a bookmark or Past chats (life/lifecycle.ts renderHistory).
import type { ToolCall } from '@/views/robot/types';

/** How many of the latest messages, notes and cards stay on the page. */
export const KEEP_ON_PAGE = 100;

/** Take the oldest off the page, past the latest `keep` (a temporary chat's note on top stays). */
export function trimLog(log: HTMLElement, keep = KEEP_ON_PAGE) {
  const items = [...log.children].filter((c) => !c.classList.contains('temp-note'));
  for (const old of items.slice(0, Math.max(0, items.length - keep))) old.remove();
}

/** Forget the steps that are over (their chips on the page keep their own): only a step still
 *  running hears more about itself. */
export function forgetDoneCalls(calls: Map<string, ToolCall> | undefined) {
  for (const [id, call] of calls || []) if (!call.running) calls?.delete(id);
}
