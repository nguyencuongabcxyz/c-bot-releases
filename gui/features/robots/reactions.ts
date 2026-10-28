// Robots noticing each other (main social.js decides when; it hears how this one is every
// few seconds): it waves at a neighbour, claps when one finishes a task, yawns when one
// dozes off, joins a dance, walks over for a visit (the walker does the walking) or, at
// its own desk, turns to a visitor and chats back. A visitor that found it asleep leaves a
// sticky on its monitor (office3d: data-visit-notes), read out when it wakes.
// free for one of these: idle, not in a quiz, a play, a question or a walk
// (robot.ts calls createOtherRobots with its hub.)
import { AUTO_SLEEP_MS } from '@/views/robot/constants';
import type { IdleAnticsApi } from '@/views/robot/life/antics';
import type { FaceApi } from '@/views/robot/life/face';
import type { DeskActivityApi } from '@/views/robot/life/desk';
import type { PlansApi } from '@/features/chat/plan/card';
import type { PlayApi } from '@/views/robot/life/play';
import type { LifeCycleApi } from '@/views/robot/life/lifecycle';
import { Sfx } from '@/views/robot/sound';
import type { RobotState } from '@/views/robot/types';
import * as ipc from '@/ipc';
import { writeJson, type OfficeData } from '@/office3d/protocol';
import type { SocialReport } from '@/types/ipc';
import type { Side, SocialEvent, VocabWord } from '@/types/model';

/** What it uses of the robot window (robot.ts's hub). */
export type OtherRobotsNeeds = {
  readonly antic: IdleAnticsApi['antic'];
  readonly anticUntil: number;
  binEmptied: string;
  readonly body: HTMLElement;
  readonly cue: IdleAnticsApi['cue'];
  readonly deskState: OfficeData;
  readonly express: FaceApi['express'];
  readonly helpersOut: DeskActivityApi['helpersOut'];
  readonly leaveDesk: IdleAnticsApi['leaveDesk'];
  readonly lookAt: DeskActivityApi['lookAt'];
  readonly pendingQuestion: PlansApi['pendingQuestion'];
  readonly playWith: PlayApi['playWith'];
  readonly quizWord: VocabWord | null;
  readonly showPop: DeskActivityApi['showPop'];
  readonly state: RobotState;
  readonly stopAntic: IdleAnticsApi['stopAntic'];
  readonly strikePose: DeskActivityApi['strikePose'];
  readonly wake: LifeCycleApi['wake'];
  readonly wanders: IdleAnticsApi['wanders'];
};

export function createOtherRobots(r: OtherRobotsNeeds) {
  // Robots noticing each other (main social.js decides when; it hears how this one is every
  // few seconds): it waves at a neighbour, claps when one finishes a task, yawns when one
  // dozes off, joins a dance, walks over for a visit (the walker does the walking) or, at
  // its own desk, turns to a visitor and chats back. A visitor that found it asleep leaves a
  // sticky on its monitor (office3d: data-visit-notes), read out when it wakes.
  // free for one of these: idle, not in a quiz, a play, a question or a walk
  function socialFree() {
    if (r.state.away || r.state.leaving || r.state.mirroring || r.state.peek || r.helpersOut() || r.state.busy)
      return false;
    return r.state.awake ? !r.quizWord && !r.state.playing && !r.pendingQuestion() : true;
  }
  function socialReport(extra?: SocialReport) {
    ipc.socialReport(
      extra || {
        awake: r.state.awake,
        busy: !!r.state.busy || r.helpersOut() > 0,
        chat: r.body.classList.contains('expanded'),
        idleMs: Date.now() - r.state.lastActivity,
        free: socialFree(),
        away: !!r.state.away,
        wanders: r.wanders(),
      },
    );
  }
  // look over at the robot on that side of the screen
  const lookSide = (side: Side, ms: number) => r.lookAt(side === 'L' ? -420 : 420, -10, ms);
  let visitFound = '';
  let deskPlane: { from: string; text: string } | null = null; // a paper plane that landed on its desk: { from, text }, read when it's free
  let pendingTreat: { kind: 'food' | 'tea'; text: string } | null = null; // food or milk tea that came: { kind: 'food' | 'tea', text }
  // eat it (or drink it): asleep it wakes for it (its chat tucked away); busy, it waits
  function haveTreat() {
    if (!pendingTreat || r.state.away || r.state.peek) return; // (hidden at the edge: it saves it for later)
    if (!r.state.awake) return r.wake({ sayHi: false, tucked: true }); // (eaten on the next look)
    if (!socialFree() || r.body.classList.contains('expanded') || Date.now() < r.anticUntil) return;
    const t = pendingTreat;
    pendingTreat = null;
    r.stopAntic();
    r.showPop(t.text || (t.kind === 'tea' ? 'Milk tea! 🧋' : 'Food! 😋'), 2000);
    setTimeout(() => (t.kind === 'tea' ? drinkMilkTea() : eatNoodles()), 900);
  }
  // a bubble tea pops into its hand; timings match the antic in office3d/antics/awake.js
  function drinkMilkTea() {
    r.antic('milktea');
    r.cue(0.35, () => Sfx.pop());
    r.cue(1.25, () => {
      r.express('happy', 'o', 2300);
      Sfx.slurp();
    });
    r.cue(2.3, () => Sfx.slurp());
    r.cue(3.75, () => r.express('happy', 'smile', 1600));
  }
  // a bowl of noodles at the desk (office3d/antics/calendar.js)
  function eatNoodles() {
    r.antic('noodles');
    r.cue(0.3, () => Sfx.pop());
    for (const at of [1.5, 2.7, 3.9])
      r.cue(at, () => {
        Sfx.slurp();
        r.express('happy', 'o', 700);
      });
  }
  const planeLine = (p: { from: string; text: string }) => `From ${p.from}: “${p.text}”`;
  // read the plane on its desk: picks it up, reads it out, and waves over to whoever threw it
  function readDeskPlane() {
    // (not while you're using it: its chat open)
    if (
      !deskPlane ||
      !r.state.awake ||
      !socialFree() ||
      r.body.classList.contains('expanded') ||
      Date.now() < r.anticUntil
    )
      return;
    const p = deskPlane;
    deskPlane = null;
    r.stopAntic();
    r.antic('plane-read');
    r.cue(0.5, () => (r.deskState.deskPlane = ''));
    r.cue(1.0, () => {
      Sfx.pop();
      r.showPop(planeLine(p), 2800);
      r.express('happy', 'talk', 1400);
    });
    r.cue(2.4, () => socialReport({ kind: 'plane-read' }));
  }
  function onSocial(ev: SocialEvent) {
    const free = socialFree();
    switch (ev.phase) {
      case 'wave':
      case 'wave-back':
        if (!free || !r.state.awake) break;
        r.stopAntic();
        r.antic('turn-to', ev.side);
        r.strikePose('wave', 1700);
        lookSide(ev.side, 2200);
        r.express('happy', 'smile', 1600);
        break;
      case 'stir': // waved at in its sleep
        if (!r.state.awake && !r.state.away) r.express('closed', 'o', 700);
        break;
      case 'clap':
        if (!free || !r.state.awake) break;
        r.stopAntic();
        r.antic('clap-at', ev.side);
        lookSide(ev.side, 2000);
        r.cue(0.35, () => Sfx.clap());
        r.express('happy', 'wide', 1800);
        if (ev.text) r.cue(0.5, () => r.showPop(ev.text, 1800));
        break;
      case 'yawn':
        if (!free || !r.state.awake) break;
        r.stopAntic();
        r.strikePose('cheer', 1300); // (a big stretch)
        r.express('closed', 'o', 1400);
        // a while idle already: it nods off soon too
        if (ev.sleepSoon) r.state.lastActivity = Math.min(r.state.lastActivity, Date.now() - (AUTO_SLEEP_MS - 40_000));
        break;
      case 'dance':
        if (free && r.state.awake) r.playWith('dance', { byUser: false });
        break;
      case 'visit':
        // off to another robot's desk (main gives the walker its errand)
        if (!free || !r.state.awake || !r.wanders()) {
          socialReport({ kind: 'decline' });
          break;
        }
        r.state.visiting = { host: ev.host, mode: ev.mode };
        r.leaveDesk();
        break;
      case 'visit-over':
        r.state.visiting = null;
        break;
      case 'go-out': // asked out to lunch (it said yes): off it goes with the other robot
        if (!free || !r.state.awake || !r.wanders()) {
          socialReport({ kind: 'decline' });
          break;
        }
        r.state.visiting = { host: ev.with, mode: 'lunch' };
        r.leaveDesk();
        break;
      case 'treat': // the lunch order or the milk tea came: eaten now if it's free, else when it is
        pendingTreat = { kind: ev.kind, text: ev.text };
        haveTreat();
        break;
      case 'hosting': // another robot is visiting its desk
        r.state.hosting = !!ev.on;
        break;
      case 'tidy': {
        // the evening housemaid at its desk (main maid.js): sparkles while she dusts, the bin
        // emptied; free, it lifts its feet so she can sweep under the desk and thanks her
        r.state.hosting = true; // (it stays put till she's done)
        r.deskState.tidy = '1';
        clearTimeout(onSocial.bin);
        onSocial.bin = setTimeout(() => {
          r.deskState.binEmpty = '1';
          r.binEmptied = new Date().toDateString();
          Sfx.swish();
        }, 3600);
        if (r.state.away || !r.state.awake) break; // (asleep: it sleeps on; out: an empty desk)
        lookSide(ev.side, 7000);
        if (ev.mood === 'free' && free && !r.body.classList.contains('expanded')) {
          r.stopAntic();
          r.antic('feet-up', ev.side);
          r.cue(0.5, () => r.express('o', 'o', 900));
          r.cue(4.5, () => {
            r.strikePose('wave', 1600);
            r.express('happy', 'smile', 2200);
            if (ev.thanks) r.showPop(ev.thanks, 2600);
          });
        } else if (ev.mood !== 'busy') r.express('happy', 'smile', 1600);
        break;
      }
      case 'tidy-end':
        r.state.hosting = false;
        r.deskState.tidy = '';
        break;
      case 'listen': // a visitor is chatting beside the desk
        if (!r.state.awake || r.state.away || r.state.busy) break;
        r.stopAntic();
        r.antic('listen', ev.side);
        lookSide(ev.side, 9000);
        break;
      case 'say':
        if (!r.state.awake || r.state.away) break;
        r.showPop(ev.text, 2600);
        r.express('happy', 'talk', 1500);
        break;
      case 'listen-end':
        if (r.deskState.antic === 'listen') r.stopAntic();
        if (ev.wave && r.state.awake && !r.state.away) r.strikePose('wave', 1300);
        break;
      case 'throw': // a paper plane at the robot on that side (main's plane window flies it)
        if (!free || !r.state.awake) break;
        r.stopAntic();
        r.antic('plane-throw', ev.side);
        lookSide(ev.side, 2000);
        r.express('happy', 'smile', 1800);
        r.cue(0.95, () => Sfx.swish());
        break;
      case 'catch': // a plane coming its way: a hand up, caught, read out
        if (!free || !r.state.awake) {
          deskPlane = { from: ev.from, text: ev.text };
          r.deskState.deskPlane = '1';
          break;
        }
        r.stopAntic();
        r.antic('plane-catch', ev.side);
        lookSide(ev.side, 1200);
        r.cue(0.3, () => {
          Sfx.pop();
          r.express('open', 'o', 500);
        });
        r.cue(0.9, () => {
          r.showPop(planeLine(ev), 2800);
          r.express('happy', 'talk', 1500);
        });
        break;
      case 'plane-land': // landed on its desk while it was busy or asleep: read later
        deskPlane = { from: ev.from, text: ev.text };
        r.deskState.deskPlane = '1';
        if (r.state.awake && !r.state.away) Sfx.pop();
        break;
      case 'oops': // its plane missed and flew off past the desk
        if (!r.state.awake || r.state.away) break;
        r.express('flat', 'o', 1300);
        r.showPop('Oops! 😅', 1500);
        break;
      case 'visit-note': // a visitor found it asleep: a sticky on its monitor
        writeJson(r.deskState, 'visitNotes', [
          { id: 'visit', text: 'came by 👋', sub: ev.from || '', color: '#ffd1e3' },
        ]);
        visitFound = ev.found || '';
        break;
    }
  }
  onSocial.bin = 0; // (when the housemaid empties its bin)
  // awake: the visitor's sticky is read, and taken down a little later
  function readVisitNote() {
    if (!r.deskState.visitNotes) return;
    const found = visitFound;
    visitFound = '';
    if (found) setTimeout(() => r.showPop(found, 2600), 3400); // (after its wake-up words)
    setTimeout(() => (r.deskState.visitNotes = ''), 9000);
  }
  return { drinkMilkTea, eatNoodles, haveTreat, onSocial, readDeskPlane, readVisitNote, socialReport };
}
export type OtherRobotsApi = ReturnType<typeof createOtherRobots>;
