// The helpers card's title: how many helper agents are back, and the commands left running in
// the background (Claude Code reports both as tasks; a command isn't a helper).
import { plural } from '@/lib/text';

type Item = { status: string; command?: boolean };

/** "Helpers 1/2 back · 1 command running", "2 helpers all back", "1 command done"… */
export function cardTitle(list: Item[]) {
  const helpers = list.filter((a) => !a.command);
  const commands = list.filter((a) => a.command);
  const parts: string[] = [];
  if (helpers.length) {
    const back = helpers.filter((a) => a.status !== 'running').length;
    parts.push(
      back === helpers.length
        ? `${plural(helpers.length, 'helper')}  all back`
        : `Helpers  ${back}/${helpers.length} back`,
    );
  }
  if (commands.length) {
    const running = commands.filter((a) => a.status === 'running').length;
    parts.push(running ? `${plural(running, 'command')} running` : `${plural(commands.length, 'command')} done`);
  }
  return parts.join(' · ');
}
