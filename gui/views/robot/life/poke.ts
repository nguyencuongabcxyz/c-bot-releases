// Poking it and dragging it about: clicks on the robot, and carrying it round the screen.
// (robot.ts calls createPoking with its hub.)
import { pick } from '@/lib/random';
import { clamp } from '@/lib/math';
import { onDrag } from '@/lib/drag';
import type { BonkApi } from './bonk';
import type { DeskActivityApi } from './desk';
import type { IdleAnticsApi } from './antics';
import type { PlayApi } from './play';
import type { FaceApi } from './face';
import type { LifeCycleApi } from './lifecycle';
import type { NotesApi } from '@/features/notes/robot';
import type { TerminalModeApi } from '@/features/workbench/terminal';
import { Sfx } from '../sound';
import type { RobotState } from '../types';
import * as ipc from '@/ipc';
import type { Office3DView } from '@/office3d';
import type { Personality, RobotView } from '@/types/model';

/** What it uses of the robot window (robot.ts's hub). */
export type PokingNeeds = {
  readonly awayClick: IdleAnticsApi['awayClick'];
  readonly body: HTMLElement;
  readonly bonkAwake: PlayApi['bonkAwake'];
  readonly bonkRobot: BonkApi['bonkRobot'];
  readonly character: () => RobotView;
  readonly crashMonitor: IdleAnticsApi['crashMonitor'];
  readonly express: FaceApi['express'];
  readonly flash: FaceApi['flash'];
  readonly office: Office3DView;
  readonly openChat: LifeCycleApi['openChat'];
  readonly openNotesFromBoard: NotesApi['openNotesFromBoard'];
  readonly openTerminal: TerminalModeApi['openTerminal'];
  readonly persona: () => Personality;
  readonly playWith: PlayApi['playWith'];
  readonly renderFace: FaceApi['renderFace'];
  readonly robot: HTMLElement;
  readonly showPop: DeskActivityApi['showPop'];
  readonly state: RobotState;
  readonly stopAntic: IdleAnticsApi['stopAntic'];
};

export function createPoking(r: PokingNeeds) {
  // (when its mouth stops after the words stop coming)

  function poke() {
    const now = Date.now();
    r.state.pokes = r.state.pokes.filter((t) => now - t < 4000);
    r.state.pokes.push(now);
    ipc.robotPoke();
    if (r.state.pokes.length >= 5) {
      r.state.pokes = [];
      Sfx.key.annoyed();
      r.flash('shake', 500);
      r.express(Math.random() < 0.5 ? 'dizzy' : 'flat', 'flat', 2600);
      r.showPop(pick(r.persona().annoyed), 2800);
      return;
    }
    Sfx.key.poke();
    r.flash('squish', 450);
    r.flash('blush', 1200);
    r.express(pick(['happy', 'happy', 'open']), pick(['o', 'smile']), 900);
    r.showPop(pick(r.persona().pokes));
  }

  let held = false; // (while you hold it)
  onDrag(
    r.robot,
    (e) => {
      held = true;
      r.stopAntic();
      ipc.robotDrag({ phase: 'start' });
      let [lastX, lastT] = [e.screenX, performance.now()];
      let travel = 0;
      let dir = 0;
      let flips: number[] = [];
      let bonked = false;
      return {
        begin: () => {
          r.body.classList.add('dragging');
          Sfx.key.whee();
          r.express('open', 'o', 60000);
        },
        move: ({ dx, dy, e: ev }) => {
          const now = performance.now();
          const step = ev.screenX - lastX;
          const vx = step / Math.max(1, now - lastT);
          travel += Math.abs(step);
          // 3+ direction reversals within ~600 ms = a bonk, not just a move
          if (Math.abs(step) > 3) {
            const way = Math.sign(step);
            if (dir && way !== dir) {
              flips = [...flips.filter((t) => now - t < 600), now];
              if (flips.length >= 3 && !bonked) {
                bonked = true;
                r.bonkRobot();
              }
            }
            dir = way;
          }
          [lastX, lastT] = [ev.screenX, now];
          document.documentElement.style.setProperty('--swing', `${clamp(-vx * 18, -28, 28).toFixed(1)}deg`);
          ipc.robotDrag({ phase: 'move', dx, dy });
        },
        end: ({ moved, letGo, e: ev }) => {
          held = false;
          ipc.robotDrag({ phase: 'end' });
          r.body.classList.remove('dragging');
          document.documentElement.style.setProperty('--swing', '0deg');
          r.state.lastActivity = Date.now();
          if (!moved) {
            if (letGo) clicked(ev);
            return;
          }
          r.state.face = null;
          if (travel > 1800) {
            r.express('dizzy', 'flat', 2200);
            r.showPop('Whoa… the room is spinning…');
          } else {
            r.renderFace();
          }
        },
      };
    },
    { threshold: 5 },
  );

  let monitorClick = 0; // a pending single click on the monitor (see clicked)
  /** A press let go without moving: what it was on decides. */
  function clicked(e: PointerEvent) {
    if (e.ctrlKey && !r.state.away) {
      // Ctrl+click: picked for the stage (or not any more)
      r.flash('hop', 450);
      ipc.stagePick();
      return;
    }
    const prop = r.office.propAt?.(e.clientX, e.clientY);
    if (prop?.kind === 'note' || prop?.kind === 'board') return r.openNotesFromBoard(prop);
    if (r.state.away) return r.awayClick();
    if (prop?.kind === 'hammer') return r.playWith('bonk');
    if (prop?.kind === 'plug') return r.playWith('charge');
    const note = r.office.stickyAt?.(e.clientX, e.clientY);
    if (note?.kind === 'vocab') {
      r.flash('hop', 500);
      ipc.robotVocabOpen(note.id);
      return;
    }
    if (r.state.awake && !r.state.mirroring && !r.state.collapsed && r.office.hitsMonitor(e.clientX, e.clientY)) {
      if (monitorClick) {
        clearTimeout(monitorClick);
        monitorClick = 0;
        r.crashMonitor();
      } else
        monitorClick = setTimeout(() => {
          monitorClick = 0;
          poke();
        }, 260);
      return;
    }
    if (r.state.mirroring) r.openTerminal();
    else if (r.state.collapsed) r.openChat();
    else if (r.state.awake) poke();
    else if (r.character().clickOpens === 'terminal') r.openTerminal();
    else r.bonkAwake();
  }

  r.robot.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    ipc.robotMenu({ awake: r.state.awake, away: !!r.state.away });
  });
  return {
    poke,
    /** You're holding it (pressed, maybe carrying it): the antics, notes and words leave it be. */
    get held() {
      return held;
    },
  };
}
export type PokingApi = ReturnType<typeof createPoking>;
