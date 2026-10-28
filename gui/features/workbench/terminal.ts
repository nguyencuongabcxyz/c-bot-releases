// Full Claude Code in a terminal window. The bubble steps aside and the robot
// acts out what happens there (from Claude Code's transcript).
// (robot.ts calls createTerminalMode with its hub.)
import type { CommentaryApi } from '@/features/chat/reply/commentary';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { FaceApi } from '@/views/robot/life/face';
import type { ChatTab, RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';

/** What it uses of the robot window (robot.ts's hub). */
export type TerminalModeNeeds = {
  readonly current: () => ChatTab;
  readonly addNote: CommentaryApi['addNote'];
  readonly express: FaceApi['express'];
  readonly flash: FaceApi['flash'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly state: RobotState;
};

export function createTerminalMode(r: TerminalModeNeeds) {
  // Full Claude Code in a terminal window. The bubble steps aside and the robot
  // acts out what happens there (from Claude Code's transcript).
  async function openTerminal() {
    const res = await ipc.robotTerminal(r.current().id);
    if (!res.ok) {
      if (r.state.awake) r.addNote(`⌨️ ${res.error}`);
      r.express('flat', 'flat', 1500);
      return;
    }
    if (res.already) {
      r.flash('hop', 600);
      r.express('happy', 'o', 1200);
      if (r.state.awake) r.showPop('Already open! Check your taskbar.', 2200);
    }
  }
  return { openTerminal };
}
export type TerminalModeApi = ReturnType<typeof createTerminalMode>;
