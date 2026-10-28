// Its face: an expression for a while, a one-shot reaction (hop, spin…), and the face it rests on.
// (robot.ts calls createFace with its hub.)
import type { DeskActivityApi } from './desk';
import type { RobotState } from '../types';
import type { Flash, OfficeData } from '@/office3d/protocol';

/** What it uses of the robot window (robot.ts's hub). */
export type FaceNeeds = {
  readonly body: HTMLElement;
  readonly deskState: OfficeData;
  readonly helpersOut: DeskActivityApi['helpersOut'];
  readonly robot: HTMLElement;
  readonly state: RobotState;
};

export function createFace(r: FaceNeeds) {
  function baseFace() {
    if (!r.state.awake && !r.state.busy && !r.state.mirroring && !r.helpersOut())
      return { eyes: 'closed', mouth: 'flat' };
    if (r.body.classList.contains('talking')) return { eyes: 'open', mouth: 'talk' };
    if (r.state.busy || r.helpersOut()) return { eyes: 'open', mouth: 'o' };
    return { eyes: 'open', mouth: 'smile' };
  }

  function renderFace() {
    const f = r.state.face && r.state.face.until > Date.now() ? r.state.face : baseFace();
    r.deskState.eyes = f.eyes;
    r.deskState.mouth = f.mouth;
  }

  function express(eyes: string, mouth: string, ms = 1500) {
    r.state.face = { eyes, mouth, until: Date.now() + ms };
    renderFace();
    setTimeout(renderFace, ms + 20);
  }

  function flash(cls: Flash, ms = 600) {
    r.robot.classList.remove(cls);
    void r.robot.offsetWidth; // restart the animation
    r.robot.classList.add(cls);
    setTimeout(() => r.robot.classList.remove(cls), ms);
  }
  return { express, flash, renderFace };
}
export type FaceApi = ReturnType<typeof createFace>;
