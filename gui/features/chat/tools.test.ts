import { describe, expect, it } from 'vitest';
import type { ToolGroupInfo } from '@/types/model';
import { firstSentence, toolsText } from './tools';

const groups: ToolGroupInfo[] = [
  {
    group: 'terminal',
    on: true,
    tools: [
      { name: 'mcp__cbot__terminal_read', description: 'Read what a terminal shows. Then more.', asks: false },
      { name: 'mcp__cbot__terminal_run', description: 'Run a command in it.', asks: true },
    ],
  },
  {
    group: 'code',
    on: false,
    tools: [{ name: 'mcp__cbot__code_map', description: 'The files and definitions that matter most.', asks: false }],
  },
];

describe('the tools, as /tools lists them', () => {
  it('says what a tool does in its first sentence', () => {
    expect(firstSentence('List the robots: names, folders. Use it to find who to ask.')).toBe(
      'List the robots: names, folders.',
    );
    expect(firstSentence('No full stop\n  here')).toBe('No full stop here');
    expect(firstSentence(`${'a'.repeat(200)}.`)).toHaveLength(160);
    expect(firstSentence('Version 1.2 is out. Next.')).toBe('Version 1.2 is out.');
  });

  it('lists every group and tool, short names, the ones that ask marked', () => {
    const text = toolsText(groups);
    expect(text).toContain('(2 in this chat;');
    expect(text).toContain(
      '**⌨️ Terminal**\n- `terminal_read` Read what a terminal shows.\n- `terminal_run` 🔐 Run a command in it.',
    );
  });

  it('says the context engine’s are off while it is, and still lists them', () => {
    const text = toolsText(groups);
    expect(text).toContain('**🧭 Context engine** (off: switch the context engine on');
    expect(text).toContain('- `code_map` The files and definitions that matter most.');
    expect(toolsText([{ ...groups[1], on: true }])).toContain('(1 in this chat;');
  });
});
