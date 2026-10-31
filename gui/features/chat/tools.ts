// The tools C-Bot gives a robot's Claude Code (app/src/mcp/tools), as the chat lists them for
// /tools: by group, each with what it does in a sentence, the ones that ask first marked, and
// the context engine's said to be off while it is. Pure (tested); slash.ts posts it.
import type { ToolGroupInfo } from '@/types/model';

const GROUPS: Record<ToolGroupInfo['group'], string> = {
  robots: '🤖 Other robots',
  words: '📚 English words',
  notes: '📒 Notes',
  routines: '⏰ Routines',
  terminal: '⌨️ Terminal',
  screen: '🖥️ Screen',
  tabs: '🗂️ My other tabs',
  code: '🧭 Context engine',
};
const PREFIX = 'mcp__cbot__';
const LONGEST = 160;

/** What a tool does, in its first sentence (cut short if that's long). */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const one = /^(.+?[.!?])(?:\s|$)/.exec(flat)?.[1] ?? flat;
  return one.length > LONGEST ? `${one.slice(0, LONGEST - 1).trimEnd()}…` : one;
}

/** The message /tools posts: every group, every tool. */
export function toolsText(groups: ToolGroupInfo[]): string {
  const on = groups.filter((g) => g.on).reduce((n, g) => n + g.tools.length, 0);
  const lines = [
    `**The tools C-Bot gives me** (${on} in this chat; Claude Code calls them \`${PREFIX}<name>\`). I use them on my own, except the ones marked 🔐, which ask as my permissions say.`,
  ];
  for (const g of groups) {
    lines.push(
      '',
      `**${GROUPS[g.group]}**${g.on ? '' : ' (off: switch the context engine on from 🗺 in the bar under the chat)'}`,
    );
    for (const t of g.tools) {
      const name = t.name.startsWith(PREFIX) ? t.name.slice(PREFIX.length) : t.name;
      lines.push(`- \`${name}\`${t.asks ? ' 🔐' : ''} ${firstSentence(t.description)}`);
    }
  }
  return lines.join('\n');
}
