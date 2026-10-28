// A drawer between the chat and the box you type in (workbench/shell/shells.ts); it keeps running while
// put away, and ends when the robot goes to sleep.
// Each conversation has shells of its own: switching tabs switches them too.
// (robot.ts's "a shell in my folder": it calls createShells with its hub.)
import type { FaceApi } from '@/views/robot/life/face';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { RobotState } from '@/views/robot/types';
import { ShellDrawer } from './shells';
import * as ipc from '@/ipc';

/** What it uses of the robot window (robot.ts's hub). */
export type ShellsNeeds = {
  readonly activeId: string | null;
  readonly body: HTMLElement;
  readonly express: FaceApi['express'];
  readonly folderName: () => string;
  readonly input: HTMLTextAreaElement;
  readonly openChat: LifeCycleApi['openChat'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly state: RobotState;
  readonly wake: LifeCycleApi['wake'];
};

export function createShells(r: ShellsNeeds) {
  // A drawer between the chat and the box you type in (workbench/shell/shells.ts); it keeps running while
  // put away, and ends when the robot goes to sleep.
  // Each conversation has shells of its own: switching tabs switches them too.
  const shell = ShellDrawer({
    chatTab: () => r.activeId,
    folderName: () => r.folderName(),
    onShown: () => r.body.classList.add('shell-open'),
    onHidden: ({ quiet }) => {
      r.body.classList.remove('shell-open');
      if (!quiet && r.state.awake && !r.state.collapsed) r.input.focus();
    },
    onError: (message) => {
      r.express('flat', 'flat', 1500);
      r.showPop(message, 2600);
    },
  });

  // (show: from a menu or /shell, out it comes; the button and Ctrl+` put it away again;
  // another: a new tab, another shell)
  function toggleShell({ show = false, another = false } = {}) {
    if (r.state.mirroring) return r.showPop('Busy in the terminal!', 1800);
    if (!r.state.awake) r.wake({ sayHi: false });
    if (r.state.collapsed) r.openChat({ focus: false });
    if (another) shell.add();
    else if (show) shell.show();
    else shell.toggle();
  }
  // Ctrl+` the drawer, Ctrl+Shift+` another shell in it
  // its Claude, in the shells of a conversation (terminal_* tools: app/src/tools/shell.rs): the drawer
  // comes out for it if that conversation is showing
  ipc.on('robot:shell-ask', async (a) => {
    const answer = await shell.ask(a, { showing: r.state.awake && !r.state.collapsed && !r.state.mirroring });
    ipc.robotShellReply(a.req, answer);
  });
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Backquote' || !e.ctrlKey || e.altKey) return;
    e.preventDefault();
    toggleShell({ another: e.shiftKey });
  });
  return { shell, toggleShell };
}
export type ShellsApi = ReturnType<typeof createShells>;
