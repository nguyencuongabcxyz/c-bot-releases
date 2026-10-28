// Little things it gets up to when nobody's asking it anything: sipping
// coffee, sneezing, snot bubbles in its sleep… The 3D view plays them
// (office3d/antics/); their lengths and the moments cued below are mirrored
// from there, so the sounds and words land on time.
// (robot.ts calls createIdleAntics with its hub.)
import { AUTO_SLEEP_MS } from '../constants';
import { pick, rand } from '@/lib/random';
import type { OtherRobotsApi } from '@/features/robots/reactions';
import type { DeskActivityApi } from './desk';
import type { LifeCycleApi } from './lifecycle';
import type { FaceApi } from './face';
import type { NotesApi } from '@/features/notes/robot';
import type { PlayApi } from './play';
import type { PokingApi } from './poke';
import type { VocabApi } from '@/features/vocab/robot';
import { Sfx } from '../sound';
import { awakePlays } from './awake';
import type { ChatTab, RobotState } from '../types';
import * as ipc from '@/ipc';
import { $ } from '@/lib/dom';
import type { Office3DView } from '@/office3d';
import type { OfficeData } from '@/office3d/protocol';
import type { Personality, Point, Quips } from '@/types/model';

/** What it uses of the robot window (robot.ts's hub). */
export type IdleAnticsNeeds = {
  readonly body: HTMLElement;
  readonly collapse: LifeCycleApi['collapse'];
  readonly deskState: OfficeData;
  readonly drinkMilkTea: OtherRobotsApi['drinkMilkTea'];
  readonly eatNoodles: OtherRobotsApi['eatNoodles'];
  readonly express: FaceApi['express'];
  readonly fill: (line: string) => string;
  readonly flash: FaceApi['flash'];
  readonly helpersOut: DeskActivityApi['helpersOut'];
  readonly input: HTMLTextAreaElement;
  readonly lookAt: DeskActivityApi['lookAt'];
  readonly notesPart: NotesApi;
  readonly office: Office3DView;
  readonly persona: () => Personality;
  readonly PLAY_MS: PlayApi['PLAY_MS'];
  readonly playWith: PlayApi['playWith'];
  readonly poke: PokingApi['poke'];
  readonly held: boolean;
  readonly renderWorking: LifeCycleApi['renderWorking'];
  readonly setActivity: DeskActivityApi['setActivity'];
  readonly shortVi: VocabApi['shortVi'];
  readonly showPop: DeskActivityApi['showPop'];
  readonly sightWord: VocabApi['sightWord'];
  readonly sleep: LifeCycleApi['sleep'];
  readonly state: RobotState;
  readonly strikePose: DeskActivityApi['strikePose'];
  readonly tabs: Map<string, ChatTab>;
  readonly vocabPart: VocabApi;
};

export function createIdleAntics(rw: IdleAnticsNeeds) {
  // Little things it gets up to when nobody's asking it anything: sipping
  // coffee, sneezing, snot bubbles in its sleep… The 3D view plays them
  // (office3d/antics/); their lengths and the moments cued below are mirrored
  // from there, so the sounds and words land on time.
  const ANTIC_SEC: Record<string, number> = {
    sip: 3.4,
    'sip-empty': 3.8,
    tip: 3.2,
    toss: 2.8,
    'toss-hit': 2.8,
    hum: 4.5,
    sneeze: 2.2,
    lamp: 2.8,
    drum: 2.6,
    slump: 2.8,
    dvd: 9,
    'dvd-lucky': 9,
    feed: 9.6,
    standdesk: 21,
    milktea: 5.6,
    dumbbell: 6,
    phone: 7,
    sleepphone: 8,
    pushup: 10,
    dictionary: 30,
    'word-show': 4.2,
    'quiz-card': 120,
    'word-glance': 7,
    'robot-antenna': 2.4,
    'robot-defrag': 1.8,
    bubble: 5.2,
    mumble: 3.6,
    dream: 6.5,
    sleeptype: 4.2,
    slide: 6.5,
    snore: 2.4,
    drift: 10,
    drool: 2.6,
    // IT office life
    duck: 6,
    reboot: 7,
    stackoverflow: 5,
    cable: 4.5,
    crumbs: 5,
    'crumbs-cookie': 5,
    merge: 6,
    standup: 7,
    jira: 5.5,
    works: 5,
    jitter: 6.5,
    friday: 4.5,
    monday: 6,
    noodles: 7,
    payday: 6,
    eyebreak: 6,
    bsod: 4.2,
    // more sleep
    nightmare: 6.5,
    snorebar: 9,
    ping: 5,
    vacuum: 9,
    burrito: 8,
    // your notes and the corkboard (office3d/antics/notes.js)
    // the other robots (office3d/antics/social.js)
    'turn-to': 2.6,
    listen: 10,
    'clap-at': 2.2,
    'plane-throw': 1.8,
    'plane-catch': 2.6,
    'plane-read': 2.6,
    'feet-up': 4.6,
    notewrite: 30,
    notepin: 2.4,
    notetoss: 2.8,
    boardlift: 3.4,
    boardglance: 2.6,
    allclear: 1.8,
    clockout: 2.6,
    // wandering off round the screen and being brought back
    stepout: 4,
    stepin: 1.4,
  };
  const CRITTER_ANTICS: Record<string, string[]> = { kit: ['robot-antenna', 'robot-defrag'] };
  const DREAMS: Record<string, string[]> = {
    kit: ['🔋', '⚙️', '💾'],
    loopy: ['🪵', '🌲', '🥕'],
    cat: ['🐟', '🧶', '🐭'],
    nerd: ['🍕', '💾', '🎮'],
    girl: ['🧋', '🐱', '🌸'],
    robot: ['🔋', '⚙️', '💾'],
  };
  const quip = <K extends keyof Quips>(k: K) => rw.persona().quips?.[k];
  // what lights up its phone at 3 am
  const PINGS = [
    'Boss: quick question?',
    'PROD ALERT 🔥',
    'Can you hop on a call?',
    'Is the site down??',
    '@channel standup moved to 7am',
  ];
  let anticSeq = 0;
  let anticUntil = 0;
  let lastAntic: string | undefined = '';

  function antic(name: string, text = '') {
    rw.deskState.antic = name;
    rw.deskState.anticText = text;
    rw.deskState.anticSeq = String(++anticSeq);
    anticUntil = Date.now() + (ANTIC_SEC[name] || 3) * 1000;
    lastAntic = name;
  }
  // something more important came up: the 3D view drops whatever it was playing
  function stopAntic() {
    rw.state.slacking = 0;
    // stopped getting up to leave (a click, a task): the walker that was getting ready goes
    if (rw.state.leaving && !rw.state.away) {
      rw.state.leaving = false;
      ipc.robotWalker('cancel');
    }
    if (!rw.deskState.antic) return;
    rw.deskState.antic = '';
    rw.deskState.anticSeq = String(++anticSeq);
    anticUntil = 0;
  }
  // do this `sec` seconds into the antic, if it's still the one playing
  function cue(sec: number, fn: () => void) {
    const seq = anticSeq;
    setTimeout(() => seq === anticSeq && rw.deskState.antic && fn(), sec * 1000);
  }
  // a weighted pick that won't play the same thing twice in a row
  function pickAntic(weights: Record<string, number>) {
    const options = Object.entries(weights).filter(([k, w]) => w > 0 && k !== lastAntic);
    let r = Math.random() * options.reduce((n, [, w]) => n + w, 0);
    for (const [k, w] of options) {
      r -= w;
      if (r < 0) return k;
    }
    return options[0]?.[0];
  }

  const idleAwake = () =>
    rw.state.awake &&
    !rw.state.busy &&
    !rw.helpersOut() &&
    !rw.state.mirroring &&
    !rw.held &&
    !rw.state.away &&
    !rw.state.peek;
  const idleAsleep = () =>
    !rw.state.awake &&
    !rw.state.busy &&
    !rw.helpersOut() &&
    !rw.state.mirroring &&
    !rw.held &&
    !rw.state.away &&
    !rw.state.peek;

  // after 10 pm it sleeps in a nightcap, or, still up, codes with its hood up in the monitor's glow
  function nightcap() {
    const h = new Date().getHours();
    const late = h >= 22 || h < 6;
    rw.deskState.nightcap = idleAsleep() && late ? '1' : '';
    rw.deskState.lateNight = rw.state.awake && late ? '1' : '';
  }

  // ---- wandering off
  // Now and then it gets up and goes for a walk round the screen (asleep, it
  // sleepwalks), in a little window of its own; the desk stands empty with a BRB
  // note. To use it again, drag it back onto its desk (main.js / walker.js dock it).
  const wanders = () => rw.state.character?.wanders !== false; // the Workshop's "Wanders off"
  const AWAY_NOTE = '🚶 Out for a walk: drag me back to my desk!';

  function leaveDesk() {
    if (rw.state.away || rw.state.busy || rw.helpersOut() || rw.state.mirroring || rw.state.peek) return;
    if (rw.state.hosting && !rw.state.visiting) return; // (a visitor's at its desk: it stays put)
    stopAntic();
    if (rw.state.awake) rw.collapse(); // the chat tucks away: it can't chat from out there
    antic('stepout');
    // the walker window loads (hidden) while it gets up...
    rw.state.leaving = true;
    ipc.robotWanderPrep({ asleep: !rw.state.awake });
    // ...and once it's up and turned, takes over with its feet on this very spot ('handoff'
    // below) and walks it off from there
    cue(0.7, () => {
      ipc.robotWander({ asleep: !rw.state.awake, feet: rw.office.feetPosition() }).then((ok) => ok || stopAntic());
    });
    cue(3.8, () => rw.state.away || stopAntic()); // (no walker came: it sits back down)
  }

  // the walker window has it now: the desk lets go of its own
  function goneWalking() {
    if (rw.state.away) return;
    rw.state.leaving = false;
    rw.state.away = true;
    rw.deskState.away = '1';
    // (its status strip: out to lunch, visiting, or just out for a walk)
    const v = rw.state.visiting;
    rw.state.news = rw.state.awayNews =
      v?.mode === 'lunch' ? `🍜 Out for lunch with ${v.host}` : v ? `🚶 Visiting ${v.host}` : AWAY_NOTE;
    rw.renderWorking();
  }

  // dropped back on the desk (or called back from the tray): it hops into its chair
  function backToDesk({ quiet = false, feet = null }: { quiet?: boolean; feet?: Point | null } = {}) {
    if (!rw.state.away) return;
    rw.state.away = false;
    awayNote.classList.remove('show');
    rw.deskState.away = '';
    rw.body.classList.remove('dock-target');
    if (rw.state.news === AWAY_NOTE || rw.state.news === rw.state.awayNews) rw.state.news = '';
    rw.renderWorking();
    rw.state.lastActivity = Date.now();
    if (quiet) return;
    // it stands where it was put down (if that's on the desk's floor), then goes to its chair
    const at = feet && rw.office.floorAt(feet.x, feet.y);
    antic('stepin', at ? `${at.x.toFixed(3)},${at.z.toFixed(3)}` : '');
    // once it's drawn here, the walker window can go (no blink in between)
    requestAnimationFrame(() => requestAnimationFrame(() => ipc.robotWalker('docked')));
    cue(1.0, () => Sfx.boing());
    if (rw.state.awake) {
      cue(1.1, () => {
        rw.express('happy', 'smile', 1400);
        rw.showPop(quip('back') || "I'm back!", 1800);
      });
    }
  }

  // ---- the group chat's meeting room (main groupChat.js / meeting.js)
  // It gets up from its chair and leaves (it rolls into the meeting room's window there); the
  // desk stands empty, drawn only now and then (office3d: data-meeting). When the chat's over
  // it's straight back in its chair, ready for work.
  const MEETING_NOTE = '👥 In the meeting room (group chat)';
  function toMeeting(tries = 0) {
    if (rw.state.meeting) return;
    // (out for a walk: main's calling it back first)
    if (rw.state.away || rw.state.leaving) return void (tries < 24 && setTimeout(() => toMeeting(tries + 1), 500));
    rw.state.meeting = true;
    stopAntic();
    const leave = () => {
      if (!rw.state.meeting) return;
      stopAntic();
      rw.state.away = true;
      rw.deskState.away = '1';
      rw.deskState.meeting = '1';
      rw.state.news = rw.state.awayNews = MEETING_NOTE;
      rw.renderWorking();
    };
    // up out of the chair and turned to go, then gone (straight away if it's in the middle of work)
    if (rw.state.busy || rw.helpersOut() || rw.state.mirroring) return leave();
    antic('stepout');
    setTimeout(leave, 900);
  }
  function fromMeeting() {
    if (!rw.state.meeting) return;
    rw.state.meeting = false;
    rw.deskState.meeting = '';
    stopAntic(); // (still getting up)
    if (rw.state.away) {
      rw.state.away = false;
      rw.deskState.away = '';
      awayNote.classList.remove('show');
      if (rw.state.news === MEETING_NOTE) rw.state.news = '';
      rw.renderWorking();
    }
    rw.state.lastActivity = Date.now();
  }

  // the empty desk was clicked: it waves from wherever it is
  const awayNote = $('#away-note');
  let awayNoteTimer = 0;
  function awayClick() {
    const name = rw.state.character?.name || 'Your robot';
    if (!rw.state.meeting) ipc.robotWalker('wave');
    awayNote.textContent = rw.state.meeting
      ? `👥 ${name} is in the meeting room for the group chat. It's back at its desk as soon as the chat ends.`
      : rw.state.visiting?.mode === 'lunch'
        ? `🍜 ${name} is out for lunch with ${rw.state.visiting.host}. Click ${name} to call it back, or drag it here.`
        : rw.state.visiting
          ? `🚶 ${name} is visiting ${rw.state.visiting.host}. Click ${name} to call it back, or drag it here.`
          : `🚶 ${name} is out for a walk. Drag ${name} back onto this desk to use it again.`;
    awayNote.classList.add('show');
    clearTimeout(awayNoteTimer);
    awayNoteTimer = setTimeout(() => awayNote.classList.remove('show'), 3200);
  }

  // Office-calendar gags: what the clock makes more likely right now
  function calendarWeights() {
    const now = new Date();
    const day = now.getDay();
    const h = now.getHours();
    return {
      friday: day === 5 && h >= 15 ? 2.5 : 0, // no deploys on a Friday afternoon
      monday: day === 1 && h < 12 ? 2 : 0, // Monday morning: coffee on a drip
      noodles: h === 12 ? 2.5 : 0, // lunch at the desk
      payday: now.getDate() === 25 ? 1.5 : 0,
    };
  }
  // and once an hour, in its first ten minutes, a stretch and a 20-20-20 eye break
  let eyeBreakHour = '';
  function eyeBreakDue() {
    const now = new Date();
    const key = `${now.toDateString()} ${now.getHours()}`;
    if (now.getMinutes() >= 10 || key === eyeBreakHour) return false;
    eyeBreakHour = key;
    return true;
  }

  // Double-clicking the monitor crashes the computer, and it knows it was you
  function crashMonitor() {
    if (!idleAwake()) return rw.poke();
    stopAntic();
    antic('bsod');
    Sfx.key.crash();
    rw.express('open', 'wide', 1100);
    cue(1.2, () => {
      rw.express('flat', 'flat', 2800);
      rw.showPop(quip('bsod') || 'You did this.', 2400);
    });
  }

  // Leaning back, hands behind its head… until your mouse comes near, when it
  // spins round to the monitor and types furiously, as if it was working all along.
  function slack() {
    const { dx, dy } = rw.state.lastCursor;
    if (Math.hypot(dx, dy) < 260) return; // you're right there; it wouldn't dare
    rw.strikePose('slack', 9000);
    rw.state.slacking = Date.now() + 9000;
    anticUntil = rw.state.slacking;
    lastAntic = 'slack';
  }
  function busted() {
    rw.state.slacking = 0;
    rw.state.pose = null;
    rw.deskState.hurry = '1';
    rw.setActivity('edit', 2200);
    rw.express('open', 'o', 2200);
    rw.showPop(pick(quip('busted') || ['Working!']), 2000);
    setTimeout(() => {
      if (![...rw.tabs.values()].some((t) => t.hurried)) rw.deskState.hurry = '';
    }, 2200);
  }

  // what each awake antic brings with it: sounds, faces, words (life/awake.ts)
  const plays = awakePlays({
    rw,
    antic,
    cue,
    quip,
    slack,
    leaveDesk,
    critters: () => CRITTER_ANTICS[rw.deskState.body ?? ''] || [], // (its body: set with the robot)
    holdUntil: (t) => (anticUntil = t),
  });

  // Awake and idle. The longer you leave it, the more it gets up to: first a
  // few small fidgets, then the bigger bits, then sighing, drumming and waving at you.
  function awakeAntic(boredFor: number) {
    const sec = boredFor / 1000;
    const crit = CRITTER_ANTICS[rw.deskState.body ?? ''] || []; // (its body: set with the robot)
    const name = pickAntic({
      look: 3,
      wave: 1.2,
      hop: 1,
      spin: 1,
      stretch: 1,
      smile: 1,
      sip: 2.2,
      'sip-empty': 0.6,
      hum: 1.5,
      lamp: 0.4,
      tip: 1,
      milktea: 1.6,
      dumbbell: 1.2,
      phone: 1.3,
      pushup: sec > 20 ? 0.9 : 0, // gets down on the floor for a set of push-ups
      sneeze: sec > 30 ? 0.9 : 0,
      toss: sec > 30 ? 0.9 : 0,
      'toss-hit': sec > 30 ? 0.35 : 0,
      dvd: sec > 40 ? 0.7 : 0,
      'dvd-lucky': sec > 40 ? 0.15 : 0,
      slack: sec > 40 ? 0.9 : 0,
      feed: sec > 15 ? 1.3 : 0, // swivels round to the monitor and scrolls a social feed
      standdesk: sec > 20 ? 0.8 : 0, // presses the desk's ▲ and works standing up for a bit
      talk: sec > 25 ? 1.4 : 0,
      critter: crit.length ? 2 : 0,
      slump: sec > 90 ? 1.5 : 0,
      drum: sec > 90 ? 1.5 : 0,
      attention: sec > 120 ? 1.2 : 0,
      // IT office life
      duck: 1,
      stackoverflow: 0.9,
      cable: 0.6,
      crumbs: 0.6,
      'crumbs-cookie': 0.25,
      jira: 0.8,
      works: 0.8,
      reboot: sec > 20 ? 0.8 : 0,
      merge: sec > 30 ? 0.7 : 0,
      jitter: sec > 30 ? 0.6 : 0,
      standup: sec > 40 ? 0.6 : 0,
      ...calendarWeights(),
      // bored for three minutes: off for a walk round the screen (not with its chat open: you may
      // be reading it, and walking off would tuck it away. Right-click → Go for a walk still works)
      wander: wanders() && sec > 180 && rw.state.collapsed ? 1.5 : 0,
      'word-glance': rw.vocabPart.sight.length ? 2 : 0, // one of your English words up on its monitor, read out
      boardglance: rw.notesPart.board.total ? 1.2 : 0, // a look over at the corkboard, a pin straightened, a look at you
      notestress: rw.notesPart.board.total >= 8 ? 0.8 : 0, // so… many… notes…
      dance: 0.7,
      highfive: 0.9, // a little dance party, or a high-five up at you
    });
    lastAntic = name;
    if (name === 'word-glance') return wordGlance();
    const play = plays[name];
    if (play) play(name);
    else if (name) antic(name);
  }

  // Asleep: now and then a snot bubble, some sleep-talk, a dream, a big snore…
  // one of the words you're learning on its monitor; it reads it out (antics/vocab.js word-glance)
  function wordGlance() {
    const x = rw.sightWord();
    if (!x) return;
    antic('word-glance', `${x.word}|${rw.shortVi(x.vi)}|${x.phrase || ''}`);
    cue(3.4, () => {
      rw.express('happy', 'talk', 1600);
      rw.showPop(`${x.word}… ${rw.shortVi(x.vi)}`, 2800);
    });
  }

  function asleepAntic() {
    // on the floor there's no chair or keyboard to sleep-type at, slide down or drift round on
    const chair = rw.deskState.sleepStyle !== 'floor' ? 0.8 : 0;
    // ...nor an eye mask to slide up for a sneaky scroll on the phone
    const name = pickAntic({
      bubble: 1.2,
      mumble: 1.2,
      dream: 1.2,
      sleeptype: chair,
      slide: chair,
      snore: 1.3,
      drift: chair,
      drool: 0.7,
      sleepphone: chair && 1.0,
      nightmare: 0.9,
      snorebar: 1,
      ping: 0.9,
      vacuum: 0.8,
      burrito: chair ? 0 : 1.2, // the burrito needs the blanket on the floor
      sleepwalk: wanders() ? 0.6 : 0,
    });
    if (name === 'sleepwalk') return leaveDesk();
    if (name === 'sleepphone') {
      // mask up, eyes open, scroll a bit, mask down, eyes shut (office3d/antics/phone.js)
      antic(name);
      cue(0.5, () => rw.express('open', 'flat', 6800));
      cue(0.6, () => Sfx.pop());
      for (let at = 1.1; at < 6.6; at += 0.9) cue(at, () => Sfx.tool());
      cue(6.8, () => Sfx.pop());
      return;
    }
    if (name === 'mumble') {
      const x = Math.random() < 0.5 ? rw.sightWord() : null; // half the time, one of your words
      antic(name, x ? `…${x.word}… ${rw.shortVi(x.vi)}…` : rw.fill(pick(rw.persona().sleeptalk || ['…mm…'])));
      cue(0.3, () => rw.express('closed', 'talk', 3000));
    } else if (name === 'dream') {
      // a third of the time it dreams of one of your words (on its monitor), and mumbles it
      const x = rw.vocabPart.sight.length && Math.random() < 0.35 ? rw.sightWord() : null;
      antic(name, x ? x.word : pick(DREAMS[rw.deskState.body ?? ''] || ['⭐', '🍰', '🌈']));
      if (x) cue(2.5, () => rw.express('closed', 'talk', 1500));
    } else if (name === 'bubble') {
      antic(name, pick(['huh?', 'wha—?', 'mm? huh?']));
      cue(4.4, () => Sfx.pop());
      cue(4.5, () => rw.express('open', 'talk', 700));
    } else if (name && name !== 'nightmare' && name !== 'ping') antic(name); // those two come with words, below
    if (name === 'slide') cue(5.4, () => Sfx.oops());
    // more sleep (office3d/antics/sleepy.js and night.js)
    if (name === 'nightmare') {
      antic(name, quip('justdream') || '…just a dream.');
      cue(0.4, () => rw.express('closed', 'flat', 2100));
      cue(2.6, () => {
        Sfx.gasp();
        rw.express('open', 'wide', 1600);
      });
      cue(4.2, () => rw.express('open', 'talk', 1300));
    } else if (name === 'snorebar') {
      for (const at of [0.6, 2.4, 4.2, 6.0]) cue(at, () => Sfx.snore());
      cue(6.2, () => Sfx.tick());
    } else if (name === 'ping') {
      antic(name, pick(PINGS));
      for (const at of [0.3, 0.9, 1.5]) cue(at, () => Sfx.buzz());
      cue(2.8, () => Sfx.thunk());
    } else if (name === 'vacuum') {
      for (const at of [0.3, 4.0]) cue(at, () => Sfx.vacuum());
      for (const at of [2.0, 2.8, 3.6]) cue(at, () => Sfx.tool());
    } else if (name === 'burrito') {
      cue(0.5, () => Sfx.swish());
      cue(4.0, () => Sfx.snore());
    }
    if (name === 'snore') cue(0.6, () => Sfx.snore());
  }

  function antics() {
    const boredFor = Date.now() - rw.state.lastActivity;
    nightcap();
    if (idleAwake() && boredFor > 6000 && Date.now() > anticUntil && eyeBreakDue()) {
      antic('eyebreak');
      cue(0.3, () => rw.express('closed', 'o', 1400));
      cue(2.2, () => rw.showPop(quip('eyebreak') || '20-20-20!', 2000));
    } else if (idleAwake() && boredFor > 6000 && Date.now() > anticUntil && Math.random() < 0.9) awakeAntic(boredFor);
    // (never while its chat is open: you may be reading it, or about to type)
    if (
      rw.state.awake &&
      rw.state.collapsed &&
      !rw.state.busy &&
      !rw.helpersOut() &&
      !rw.state.mirroring &&
      !rw.input.value &&
      boredFor > AUTO_SLEEP_MS
    ) {
      stopAntic();
      rw.showPop(pick(rw.persona().sleepy), 1500);
      rw.express('closed', 'o', 1500);
      setTimeout(() => rw.sleep({ auto: true }), 1400);
    }
    setTimeout(antics, rand(7000, 14000));
  }

  // once every 30–60 s while it sleeps, so it stays calm on your desktop
  function dozeLoop() {
    nightcap();
    if (idleAsleep() && Date.now() > anticUntil) asleepAntic();
    setTimeout(dozeLoop, rand(30000, 60000));
  }
  return {
    antic,
    antics,
    awayClick,
    backToDesk,
    busted,
    crashMonitor,
    cue,
    dozeLoop,
    fromMeeting,
    goneWalking,
    leaveDesk,
    nightcap,
    quip,
    stopAntic,
    toMeeting,
    wanders,
    get anticUntil() {
      return anticUntil;
    },
    set anticUntil(v) {
      anticUntil = v;
    },
  };
}
export type IdleAnticsApi = ReturnType<typeof createIdleAntics>;
