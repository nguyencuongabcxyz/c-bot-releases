// Docked at the screen's edge (app/src/robots/docking): the chat flush against the left or right
// edge, the whole height of it, looking as on the stage (robots/stage/tile.ts: the robot hidden,
// its face in the title bar, the gaps to drag). Here: the Dock button, the title bar dragged off
// the edge to come back to the desk, and the glow while the robot is pushed against an edge
// (let go there and it docks).
// (robot.ts calls createDock with its hub.)
import type { StageApi } from '@/features/robots/stage/tile';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import { onDrag } from '@/lib/drag';
import { pulledOff } from './pull';

/** What it uses of the robot window (robot.ts's hub). */
export type DockNeeds = {
  readonly body: HTMLElement;
  readonly stagePart: StageApi;
};

export function createDock(r: DockNeeds) {
  $('#btn-dock').addEventListener('click', () => ipc.robotDock('dock'));

  // docked, the title bar is its handle: pulled off the edge, it's back at its desk
  const header = $('#panel > header');
  onDrag(
    header,
    (e) => {
      const edge = r.stagePart.dockedOn;
      if (!edge || (e.target as HTMLElement).closest('button')) return;
      let gone = false;
      return {
        begin: () => r.body.classList.add('undocking'),
        move: ({ dx }) => {
          if (gone || !pulledOff(edge, dx)) return;
          gone = true;
          ipc.robotDock('undock');
        },
        end: () => r.body.classList.remove('undocking'),
      };
    },
    { threshold: 6 },
  );

  // dragged round with its chat open, pushed against an edge: it glows (main says which)
  ipc.on('robot:dock', ({ hint }) => {
    r.body.classList.toggle('dock-hint-left', hint === 'left');
    r.body.classList.toggle('dock-hint-right', hint === 'right');
  });
  // let go (laid out afresh, docked or not): no more glow
  ipc.on('robot:layout', () => r.body.classList.remove('dock-hint-left', 'dock-hint-right'));
  return {};
}
export type DockApi = ReturnType<typeof createDock>;
