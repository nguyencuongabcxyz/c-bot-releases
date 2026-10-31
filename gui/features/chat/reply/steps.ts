// What a step gave back, in a line or three under it (Claude Code's "⎿ Read 120 lines"), and
// token counts in short words.

import { plural } from '@/lib/text';
import type { Tokens } from '@/types/model';

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A finished step's result, as up to three short lines ([] while it runs, or when its card says it). */
export function stepSummary(name: string, output: string | undefined, isError?: boolean): string[] {
  if (output === undefined) return [];
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  if (isError) return [cut(lines[0]?.replace(/^<tool_use_error>|<\/tool_use_error>$/g, '') || 'Failed', 140)];
  switch (name) {
    case 'Read':
      return [lines.length ? `Read ${plural(lines.length, 'line')}` : 'Empty file'];
    case 'Grep': {
      const found = /^Found (\d+) (files?|lines?|matches?)/.exec(lines[0] || '');
      if (found) return [`Found ${found[1]} ${found[2]}`];
      return [
        lines.length && !/^No (matches|files) found/.test(lines[0])
          ? plural(lines.length, 'match', 'matches')
          : 'No matches',
      ];
    }
    case 'Glob':
      return [lines.length && !/^No files found/.test(lines[0]) ? `Found ${plural(lines.length, 'file')}` : 'No files'];
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
    case 'Agent':
    case 'Task':
    case 'Thinking':
      return []; // (its diff, the plan card or the helper's card shows it)
    case 'Bash':
    case 'PowerShell':
    case 'BashOutput': {
      if (!lines.length) return ['(no output)'];
      const shown = lines.slice(0, 3).map((l) => cut(l, 160));
      if (lines.length > 3) shown.push(`… +${plural(lines.length - 3, 'line')}`);
      return shown;
    }
    default: {
      if (!lines.length) return ['Done'];
      return [cut(lines[0], 140) + (lines.length > 1 ? ` … +${plural(lines.length - 1, 'line')}` : '')];
    }
  }
}

/** Short words for a token count: 870, 1.2k, 34k. */
export function tokens(n: number) {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/** What an answer used, in a line: "8 calls · 105k context · ↓ 1.9k out · $0.50". */
export function usageText(t: Tokens, costUsd = 0) {
  const cost = costUsd >= 0.01 ? ` · $${costUsd.toFixed(2)}` : costUsd > 0 ? ' · <$0.01' : '';
  if (t.calls == null) {
    // (kept by 2.0.1: what it read summed over its calls, and a cost that may be the whole
    // conversation's, so none)
    const read = t.input + t.cacheRead + t.cacheWrite;
    return `↑ ${tokens(read)} in${t.cacheRead ? ` (${tokens(t.cacheRead)} cached)` : ''} · ↓ ${tokens(t.output)} out`;
  }
  const parts = [
    t.calls ? plural(t.calls, 'call') : '',
    t.context ? `${tokens(t.context)} context` : '',
    `↓ ${tokens(t.output)} out`,
  ];
  return parts.filter(Boolean).join(' · ') + cost;
}
